/**
 * IMAP inbox poller: watches one mailbox and saves each new message as an
 * article for one account. This is the single-user alternative to the
 * inbound-email webhook — no mail provider, no MX record, no per-account
 * aliases. Forward a newsletter to the mailbox and it shows up in the reader.
 *
 * Because the mailbox maps to exactly one account, forwarded mail works: there
 * is no recipient to match (the webhook, by contrast, routes on the recipient's
 * alias and would drop a forward as an unknown recipient).
 *
 * Three distinct identities, easily confused:
 *   READLATER_IMAP_HOST/USER/PASS  the mailbox to sign into (mail plumbing)
 *   READLATER_IMAP_SAVE_TO_EARMARK_USER  whose reading list the mail lands in
 *
 * Configure with:
 *   READLATER_IMAP_HOST      e.g. mail.doc-ent.com     (required to enable)
 *   READLATER_IMAP_USER      e.g. read@doc-ent.com     (required)
 *   READLATER_IMAP_PASS      mailbox password          (required, keep in a secret)
 *   READLATER_IMAP_SAVE_TO_EARMARK_USER
 *                            Earmark username (as typed on the login page)
 *                            whose library forwarded mail is saved to (required)
 *   READLATER_IMAP_PORT      default 993
 *   READLATER_IMAP_MAILBOX   default INBOX
 *   READLATER_IMAP_INTERVAL  seconds between polls, default 120
 *   READLATER_IMAP_ALLOW_FROM  comma-separated sender allowlist; empty = accept
 *                              anything that lands in the mailbox
 *
 * The allowlist matches the From: header, which is trivially forgeable. It
 * keeps stray mail and casual spam out of the reader; it is not a security
 * boundary. The real protection is that the mailbox address is private.
 */
'use strict';

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const cfg = {
  host: process.env.READLATER_IMAP_HOST || '',
  port: parseInt(process.env.READLATER_IMAP_PORT || '993', 10),
  user: process.env.READLATER_IMAP_USER || '',
  pass: process.env.READLATER_IMAP_PASS || '',
  earmarkUser: process.env.READLATER_IMAP_SAVE_TO_EARMARK_USER || '',
  mailbox: process.env.READLATER_IMAP_MAILBOX || 'INBOX',
  intervalMs: Math.max(15, parseInt(process.env.READLATER_IMAP_INTERVAL || '120', 10)) * 1000,
  allowFrom: (process.env.READLATER_IMAP_ALLOW_FROM || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
};

const enabled = () => Boolean(cfg.host && cfg.user && cfg.pass && cfg.earmarkUser);

/**
 * True when the message's From: address is allowed. Checks every address on
 * the header, since a forward can carry more than one. An empty allowlist
 * accepts everything.
 */
function senderAllowed(parsed, allowFrom = cfg.allowFrom) {
  if (!allowFrom.length) return true;
  const addrs = ((parsed.from && parsed.from.value) || [])
    .map((v) => String(v.address || '').toLowerCase())
    .filter(Boolean);
  return addrs.some((a) => allowFrom.includes(a));
}

/**
 * Strip the forwarding chrome Gmail adds. Everything reaching this mailbox is
 * a forward, so "Fwd: The Real Title" would otherwise become the article title
 * and your own name would become every article's byline.
 */
const stripFwd = (subject) =>
  String(subject || '').replace(/^\s*(?:(?:fwd?|fw|re)\s*:\s*)+/i, '').trim();

/** A stable id for a message that has no Message-ID header (rare, but legal). */
function fallbackId(parsed, crypto) {
  const from = (parsed.from && parsed.from.text) || '';
  const date = parsed.date ? parsed.date.toISOString() : '';
  return crypto.createHash('sha256')
    .update(`${from}|${parsed.subject || ''}|${date}`)
    .digest('hex').slice(0, 24);
}

/**
 * Drain unseen messages once. Each saved message is flagged \Seen so the next
 * pass skips it; the article's `email:<messageId>` URL is a second, durable
 * guard in case flagging fails (see saveEmailArticle).
 */
async function pollOnce({ saveEmailArticle, findUserByName, crypto, log, Client = ImapFlow }) {
  const user = findUserByName(cfg.earmarkUser);
  if (!user) {
    log(`imap: no Earmark user named '${cfg.earmarkUser}' — not saving anything`);
    return;
  }

  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock(cfg.mailbox);
    try {
      const unseen = await client.search({ seen: false });
      if (!unseen || !unseen.length) return;
      log(`imap: ${unseen.length} new message(s)`);

      for (const uid of unseen) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;

        let parsed;
        try {
          parsed = await simpleParser(msg.source);
        } catch (e) {
          // A message we cannot parse would otherwise be retried forever.
          log(`imap: unparseable message uid=${uid} (${e.message}) — marking read, skipping`);
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          continue;
        }

        if (!senderAllowed(parsed)) {
          const who = (parsed.from && parsed.from.text) || 'unknown sender';
          log(`imap: ignoring message from ${who} (not on allowlist) — marking read`);
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          continue;
        }

        const { article, created } = saveEmailArticle({
          userId: user.id,
          messageId: parsed.messageId || fallbackId(parsed, crypto),
          subject: stripFwd(parsed.subject),
          // The sender is always you (you forwarded it), so a byline of your
          // own name is noise. Keep it only when someone else mailed it in.
          from: senderAllowed(parsed, cfg.allowFrom)&& cfg.allowFrom.length
            ? null
            : (parsed.from && (parsed.from.value?.[0]?.name || parsed.from.text)) || null,
          date: parsed.date ? parsed.date.toISOString() : null,
          html: parsed.html || '',
          text: parsed.text || '',
        });

        // Only mark read once the article is safely committed, so a crash
        // mid-save leaves the message unseen and it retries next pass.
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        log(created
          ? `imap: saved "${article.title}" (${article.id})`
          : `imap: already saved "${article.title}" — marked read`);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Start polling. Self-scheduling rather than setInterval, so a slow or hung
 * poll can never overlap the next one. Errors (mail server down, bad password)
 * are logged and retried on the following tick.
 */
function start(deps) {
  if (!enabled()) return false;
  const log = deps.log || console.log;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await pollOnce({ ...deps, log });
    } catch (e) {
      log(`imap: poll failed (${e.message})`);
    }
    if (!stopped) setTimeout(tick, cfg.intervalMs).unref();
  };

  log(`imap: polling ${cfg.user} at ${cfg.host} every ${cfg.intervalMs / 1000}s → Earmark user '${cfg.earmarkUser}'`);
  log(cfg.allowFrom.length
    ? `imap: only saving mail from ${cfg.allowFrom.join(', ')}`
    : 'imap: no sender allowlist — anything delivered to this mailbox is saved');
  tick();
  return () => { stopped = true; };
}

module.exports = { start, enabled, pollOnce, senderAllowed, stripFwd, cfg };

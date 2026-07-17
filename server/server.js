#!/usr/bin/env node
/**
 * ReadLater sync server — Node.js (>=18) + SQLite (better-sqlite3, FTS5).
 *
 * Stores articles + highlights pushed by the Firefox extension and serves
 * them to the Android app and to a built-in web reader. Data lives in
 * <data dir>/readlater.db (override the directory with READLATER_DATA_DIR).
 * A legacy JSON store (db.json) is imported automatically on first start.
 *
 * Accounts: users sign up at /signup (disable with READLATER_ALLOW_SIGNUP=0).
 * Every account has its own API token (shown on /settings) for the Firefox
 * extension and Android app, its own private email-in alias, and its own
 * articles/highlights.
 *
 * Auth: /api requests send  Authorization: Bearer <token>  (or, from the
 * web UI, the session cookie). Legacy single-token deployments: the token
 * from READLATER_TOKEN / <data dir>/token.txt is adopted as the API token
 * of the FIRST account created, along with any pre-account articles.
 *
 * Run:  node server.js            (listens on 0.0.0.0:8090, override PORT)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const web = require('./web');
const { open, hostOf } = require('./db');
const llm = require('./llm');
const { extractReadable } = require('./extract');
const pdf = require('./pdf');
const tts = require('./tts');
const inbound = require('./inbound');
const skip = require('./skip');
const { emailToCleanHtml } = require('./email');
const { reparse, textOf } = require('./reparse');

// Cap raw source we keep for reparse/"view original" so a single huge message
// can't blow the data volume. Big enough for any real newsletter or page.
const SOURCE_CAP = 3 * 1024 * 1024;

/** Fetch a page's HTML (shared by save-by-URL, reparse and "view original"). */
async function fetchPageHtml(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EarmarkBot/1.0)', Accept: 'text/html' },
    redirect: 'follow', signal: AbortSignal.timeout(25000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.text()).slice(0, SOURCE_CAP);
}

const PORT = parseInt(process.env.PORT || '8090', 10);
const DATA_DIR = process.env.READLATER_DATA_DIR || path.join(__dirname, 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'token.txt');
const APK_FILE = path.join(DATA_DIR, 'app.apk');
const APK_META_FILE = path.join(DATA_DIR, 'app-apk.json');
const EXT_XPI_FILE = path.join(DATA_DIR, 'earmark.xpi'); // signed Firefox extension
const EXT_META_FILE = path.join(DATA_DIR, 'earmark-xpi.json');
const MAX_BODY = 10 * 1024 * 1024; // 10 MB per request
const ALLOW_SIGNUP = process.env.READLATER_ALLOW_SIGNUP !== '0';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
// Email-to-save (optional): an inbound-email provider (e.g. Postmark) POSTs
// parsed messages to /api/inbound-email?secret=<READLATER_INBOUND_SECRET>.
// READLATER_INBOUND_DOMAIN (e.g. in.example.com) is what Settings displays
// after each account's private alias.
const INBOUND_SECRET = process.env.READLATER_INBOUND_SECRET || '';
const INBOUND_DOMAIN = process.env.READLATER_INBOUND_DOMAIN || '';

fs.mkdirSync(DATA_DIR, { recursive: true });

// Legacy single-token installs: this token is adopted by the first account.
let LEGACY_TOKEN = process.env.READLATER_TOKEN || '';
if (!LEGACY_TOKEN && fs.existsSync(TOKEN_FILE)) {
  LEGACY_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
}

// ---------------------------------------------------------------- storage
const store = open(DATA_DIR);

// ---------------------------------------------------------------- server TTS
// Kokoro-synthesized article audio, pre-computed on save and cached on the
// volume. A tiny single-flight queue keeps synthesis serialized (one API call
// stream at a time) so a burst of saves doesn't hammer the provider.
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });
const audioFile = (id, ext) => path.join(AUDIO_DIR, `${id}.${ext}`);
const audioMetaFile = (id) => path.join(AUDIO_DIR, `${id}.json`);
const readAudioMeta = (id) => {
  try { return JSON.parse(fs.readFileSync(audioMetaFile(id), 'utf8')); } catch { return null; }
};
// the audio file that actually backs an article's metadata ('' if missing)
const audioDataFile = (id) => {
  const meta = readAudioMeta(id);
  if (!meta) return '';
  const f = audioFile(id, meta.format || 'wav');
  return fs.existsSync(f) ? f : '';
};

const ttsQueued = new Set();
const ttsPending = [];
const ttsFailedAt = new Map(); // articleId -> ms of last failure (backoff)
const TTS_FAIL_COOLDOWN = 5 * 60 * 1000;
let ttsRunning = false;

function enqueueTts(articleId, userId, force = false) {
  if (!tts.enabled()) return false;
  if (ttsQueued.has(articleId)) return true;
  if (!force && fs.existsSync(audioMetaFile(articleId))) return false;
  // Don't re-attempt a recently-failed synth on every status poll (e.g. while
  // the provider is out of balance) — a manual POST (force) clears this.
  if (!force) {
    const failedAt = ttsFailedAt.get(articleId);
    if (failedAt && Date.now() - failedAt < TTS_FAIL_COOLDOWN) return false;
  }
  ttsQueued.add(articleId);
  ttsPending.push({ articleId, userId });
  pumpTts();
  return true;
}

async function pumpTts() {
  if (ttsRunning) return;
  ttsRunning = true;
  while (ttsPending.length) {
    const { articleId, userId } = ttsPending.shift();
    try {
      const a = store.getArticle(articleId, userId);
      if (a) {
        const r = await tts.synthesizeArticle(a);
        // remove any prior file of the other format so only one is kept
        for (const ext of ['wav', 'opus']) {
          if (ext !== r.format) { try { fs.unlinkSync(audioFile(articleId, ext)); } catch {} }
        }
        fs.writeFileSync(audioFile(articleId, r.format), r.audio);
        fs.writeFileSync(audioMetaFile(articleId), JSON.stringify({
          format: r.format, mime: r.mime, voice: r.voice, durationMs: r.durationMs,
          sampleRate: r.sampleRate, paragraphOffsetsMs: r.paragraphOffsetsMs,
          size: r.audio.length, createdAt: Date.now(),
        }));
        console.log(`TTS synthesized ${articleId}: ${r.audio.length} bytes ${r.format}, ${r.paragraphOffsetsMs.length} paragraphs`);
        ttsFailedAt.delete(articleId);
      }
    } catch (e) {
      console.error(`TTS failed for ${articleId}: ${e.message}`);
      ttsFailedAt.set(articleId, Date.now());
    } finally {
      ttsQueued.delete(articleId);
    }
  }
  ttsRunning = false;
}

/** Pull an original publish date (ms) from the page's metadata, if present. */
function pagePublishedAt(pageHtml) {
  const m = pageHtml.match(/<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|datePublished|publishdate|date|dc\.date(?:\.issued)?)["'][^>]+content=["']([^"']+)["']/i)
    || pageHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name|itemprop)=["'](?:article:published_time|datePublished)["']/i)
    || pageHtml.match(/<time[^>]+datetime=["']([^"']+)["']/i);
  if (!m) return null;
  const t = Date.parse(m[1].trim());
  return Number.isFinite(t) && t > 0 && t < Date.now() + 86400000 ? t : null;
}

/** Pull an og:image / twitter:image from page HTML, resolved to an absolute URL. */
function ogImage(pageHtml, baseUrl) {
  const m = pageHtml.match(/<meta[^>]+(?:property|name)=["'](?:og:image(?::url)?|twitter:image)["'][^>]+content=["']([^"']+)["']/i)
    || pageHtml.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image(?::url)?|twitter:image)["']/i);
  if (!m) return null;
  try { return new URL(m[1].trim(), baseUrl).href.slice(0, 2000); } catch { return null; }
}

/**
 * Drop the user's boilerplate phrases from article content on its way to the
 * database. Every write of html/textContent goes through this, so a rule
 * applies no matter which path produced the article — extension, save-by-URL,
 * LLM rescue, PDF import or email.
 *
 * Save-time only: paragraph indices anchor highlights and reading positions,
 * so filtering an article that already has them would re-anchor them silently.
 */
function withSkipRules(userId, fields, url) {
  // Built-in per-publisher rules run first (they truncate), then the user's
  // phrase rules run over what's left.
  let input = fields;
  if (url) {
    const { truncated, ...cut } = skip.applyDomainRules(url, input);
    if (truncated) {
      console.log(`domain rule: truncated ${url} at its end-of-article mark`);
      input = cut;
    }
  }
  const rules = store.listSkipRules(userId);
  if (!rules.length) return input;
  const { removed, ...clean } = skip.applySkipRules(rules, input);
  if (!removed.length) return input;

  const perRule = new Map();
  for (const r of removed) perRule.set(r.ruleId, (perRule.get(r.ruleId) || 0) + 1);
  for (const [id, n] of perRule) store.bumpSkipRuleHits(id, n);
  console.log(`skip rules removed ${removed.length} block(s): ` +
    removed.map((r) => JSON.stringify(r.text.slice(0, 60))).join(', '));
  return clean;
}

// Background page fetch + extraction for save-by-URL, so the client isn't kept
// waiting on a slow page. Updates the placeholder article in place.
async function fillSavedUrl(articleId, userId, artUrl) {
  const setContent = (fields) => {
    const cur = store.getArticle(articleId, userId);
    if (cur) {
      store.updateArticleContent(articleId, withSkipRules(userId,
        { byline: null, siteName: hostOf(artUrl), updatedAt: Date.now(), ...fields }, artUrl));
    }
    return cur;
  };
  let pageHtml = '';
  try {
    const resp = await fetch(artUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EarmarkBot/1.0)', Accept: 'text/html' },
      redirect: 'follow', signal: AbortSignal.timeout(25000),
    });
    if (!resp.ok) { setContent({ title: hostOf(artUrl) || artUrl, excerpt: `Fetch failed (${resp.status})`, html: `<p>Couldn't fetch this page (HTTP ${resp.status}). Original: ${escapeText(artUrl)}</p>`, textContent: '' }); return; }
    pageHtml = (await resp.text()).slice(0, 3 * 1024 * 1024);
  } catch (e) {
    setContent({ title: hostOf(artUrl) || artUrl, excerpt: 'Could not fetch the page', html: `<p>Couldn't fetch this page. Original: ${escapeText(artUrl)}</p>`, textContent: '' });
    return;
  }

  const titleMatch = pageHtml.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || pageHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const metaTitle = titleMatch ? sanitizeString(titleMatch[1].replace(/\s+/g, ' ').trim(), 500) : (hostOf(artUrl) || artUrl);
  const imageUrl = ogImage(pageHtml, artUrl);
  const publishedAt = pagePublishedAt(pageHtml);

  // Readability first (strips nav/ads/newsletter cruft); fall back to a crude
  // full-text dump only when it can't find a real article.
  const readable = extractReadable(pageHtml, artUrl);
  let title, fields;
  if (readable && readable.textContent.length >= 250) {
    title = readable.title || metaTitle;
    fields = {
      title, byline: readable.byline, siteName: readable.siteName || hostOf(artUrl),
      imageUrl, publishedAt, excerpt: readable.excerpt,
      html: readable.html, textContent: readable.textContent,
    };
  } else {
    title = metaTitle;
    const bodyText = pageHtml
      .replace(/<(script|style|head|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    fields = {
      title, imageUrl, publishedAt, excerpt: sanitizeString(bodyText, 300),
      html: `<p>${escapeText(bodyText.slice(0, 200000))}</p>`, textContent: bodyText.slice(0, 200000),
    };
  }
  if (!setContent(fields)) return;
  enqueueTts(articleId, userId);

  // LLM rescue only when extraction was weak (Readability failed or thin) — no
  // point paying for it when Readability already produced a clean article.
  const weak = !readable || readable.textContent.length < 600;
  if (weak && llm.enabled()) {
    llm.extractArticle({ url: artUrl, title, pageHtml })
      .then((better) => {
        if (!better || !better.textContent || better.textContent.length < 400) return;
        const cur = store.getArticle(articleId, userId);
        if (!cur || better.textContent.length <= (cur.textContent || '').length) return;
        store.updateArticleContent(articleId, withSkipRules(userId, {
          title: cur.title, byline: cur.byline, siteName: cur.siteName,
          excerpt: better.textContent.slice(0, 300),
          html: better.html, textContent: better.textContent, updatedAt: Date.now(),
        }, artUrl));
        enqueueTts(articleId, userId, true);
        console.log(`save-url LLM-upgraded ${articleId} (${(cur.textContent || '').length} → ${better.textContent.length})`);
      })
      .catch((e) => console.error(`save-url LLM upgrade failed for ${articleId}: ${e.message}`));
  }
}

store.pruneSessions(Date.now());
process.on('SIGINT', () => { store.close(); process.exit(0); });
process.on('SIGTERM', () => { store.close(); process.exit(0); });

const newId = () => crypto.randomBytes(8).toString('hex');

const newEmailAlias = (username) =>
  `${String(username).toLowerCase()}-${crypto.randomBytes(3).toString('hex')}`;

// ---------------------------------------------------------------- accounts
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(stored, password) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

function findUserByToken(token) {
  if (!token) return null;
  const presented = sha256(token);
  let found = null;
  for (const u of store.allUsers()) {
    if (crypto.timingSafeEqual(presented, sha256(u.token))) found = u;
  }
  return found;
}

const findUserByName = (username) => store.userByName(username);

/** Returns {user} or {error}. The first account adopts the legacy token and any pre-account data. */
function createUser(username, password) {
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(String(username || ''))) {
    return { error: 'username must be 3-32 characters: letters, digits, - or _' };
  }
  if (typeof password !== 'string' || password.length < 8) {
    return { error: 'password must be at least 8 characters' };
  }
  if (store.userByName(username)) return { error: 'that username is taken' };
  const first = store.userCount() === 0;
  const user = {
    id: newId(),
    username: String(username),
    passwordHash: hashPassword(password),
    token: (first && LEGACY_TOKEN) || crypto.randomBytes(24).toString('hex'),
    emailAlias: newEmailAlias(username),
    createdAt: Date.now(),
  };
  store.insertUser(user);
  if (first) store.adoptOrphans(user.id);
  return { user };
}

// ---------------------------------------------------------------- sessions
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(userId) {
  const sid = crypto.randomBytes(32).toString('base64url');
  store.putSession(sid, userId, Date.now() + SESSION_TTL);
  return sid;
}

function sessionCookie(sid, req, { clear = false } = {}) {
  const attrs = [
    `rl_sid=${clear ? '' : sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${clear ? 0 : Math.floor(SESSION_TTL / 1000)}`,
  ];
  if (isHttps(req)) attrs.push('Secure');
  return attrs.join('; ');
}

function getSessionUser(req) {
  const sid = parseCookies(req).rl_sid;
  if (!sid) return null;
  const s = store.getSession(sid);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { store.deleteSession(sid); return null; }
  return store.userById(s.userId);
}

function destroySession(req) {
  const sid = parseCookies(req).rl_sid;
  if (sid) store.deleteSession(sid);
}

// ---------------------------------------------------------------- helpers
function pubArticleMeta(a) {
  const { html, textContent, userId, domain, ...meta } = a;
  return meta;
}
function pubArticle(a) {
  const { userId, domain, ...pub } = a;
  return pub;
}
function pubHighlight(h) {
  const { userId, ...pub } = h;
  return pub;
}

const searchArticles = (user, opts) => store.searchArticles(user.id, opts);
const countArticles = (user, opts) => store.countArticles(user.id, opts);

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return readBodyBuffer(req, MAX_BODY).then((b) => b.toString('utf8'));
}

function readBodyBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parses a JSON or application/x-www-form-urlencoded body into a plain object. */
function parseBody(raw, contentType) {
  if ((contentType || '').includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return JSON.parse(raw || '{}');
}

function sanitizeString(v, max = 2000) {
  if (typeof v !== 'string') return null;
  return v.slice(0, max);
}

const escapeText = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Best-effort cleanup of email HTML (extension-saved articles are cleaned in
 * the browser; email bodies arrive raw). Defense in depth only — clients
 * render stored HTML under a strict CSP (web) or via a text parser (Android).
 */
function sanitizeEmailHtml(html) {
  return String(html)
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(iframe|object|embed|form|link|meta|base)\b[^>]*>/gi, '')
    .replace(/<\/(iframe|object|embed|form)\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi, '$1="#"');
}

/**
 * Turn a parsed email into an article row. Shared by the inbound-email webhook
 * and the IMAP poller so both store identical rows and dedupe identically:
 * `email:<messageId>` is the article URL, so redelivery (webhook retries, or a
 * message the poller sees twice) is a no-op rather than a duplicate.
 */
function saveEmailArticle({ userId, messageId, subject, from, date, html, text }) {
  const url = `email:${messageId}`;
  const existing = store.articleByUrl(userId, url);
  if (existing) return { article: existing, created: false };

  const body = typeof text === 'string' ? text : '';
  // Restructure newsletter soup into real paragraphs (and drop duplicate
  // subheaders/captions). Falls back to the raw-sanitized body if that yields
  // nothing, and to the plain-text part if there's no HTML at all — so we never
  // store an empty article.
  let articleHtml;
  if (typeof html === 'string' && html.trim()) {
    articleHtml = emailToCleanHtml(html) || sanitizeEmailHtml(html);
  } else {
    articleHtml = `<pre>${escapeText(body)}</pre>`;
  }
  const article = withSkipRules(userId, {
    id: newId(),
    userId,
    url,
    savedAt: Date.parse(date) || Date.now(),
    archived: false, favorite: false, readParagraph: 0,
    title: sanitizeString(subject) || '(no subject)',
    byline: sanitizeString(from),
    siteName: 'Email',
    excerpt: sanitizeString(body.replace(/\s+/g, ' ').trim(), 300),
    html: articleHtml,
    textContent: body ? body.slice(0, 200000) : null,
    // Keep the raw email HTML: it can't be re-fetched, so it's the only way to
    // reparse a mis-parsed newsletter or show its original.
    sourceHtml: typeof html === 'string' && html.trim() ? html.slice(0, SOURCE_CAP) : null,
    updatedAt: Date.now(),
  });
  store.insertArticle(article);
  enqueueTts(article.id, userId); // emailed newsletters get audio like any other save
  return { article, created: true };
}

/** res.write() that waits for 'drain', so a slow client throttles us instead
 *  of filling the socket buffer with the whole export. */
function write(res, chunk) {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onDrain = () => { res.off('close', onClose); resolve(); };
    const onClose = () => { res.off('drain', onDrain); reject(new Error('client disconnected')); };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

/**
 * Stream one account's full backup as JSON. Hand-assembled rather than
 * JSON.stringify'd whole: articles carry inline HTML, and a real account is
 * bigger than the heap (a 20k-article account OOMs the process if buffered).
 *
 * `counts` is written in the header, before the rows, so a restore can verify
 * it received everything the server intended to send.
 */
const exportHead = (user) => ({
  format: 'earmark-export/1',
  exportedAt: Date.now(),
  username: user.username,
  counts: {
    articles: store.articleCount(user.id),
    highlights: store.highlightCount(user.id),
  },
  views: store.listViews(user.id).map(({ userId: _u, ...v }) => v),
});

async function streamExport(res, user) {
  const head = exportHead(user);
  // Open the object with the scalar fields, then splice in the big arrays.
  await write(res, JSON.stringify(head).slice(0, -1));

  for (const [key, rows] of [
    ['articles', store.iterExport.articles(user.id)],
    ['highlights', store.iterExport.highlights(user.id)],
  ]) {
    await write(res, `,${JSON.stringify(key)}:[`);
    let first = true;
    for (const row of rows) {
      await write(res, (first ? '' : ',') + JSON.stringify(row));
      first = false;
    }
    await write(res, ']');
  }
  await write(res, '}');
  res.end();
}

/**
 * Line-delimited export: a header line, one line per record, then an "end"
 * trailer carrying the row counts actually written.
 *
 * This is the format to back up with. A whole account serialized as one JSON
 * document cannot be read back — V8 refuses to build a string over ~536M
 * characters, and a real account exceeds that — whereas NDJSON streams in both
 * directions. The trailer is what makes truncation detectable: every line of a
 * half-downloaded file still parses, so without it a cut-off backup looks fine.
 */
async function streamExportNdjson(res, user) {
  const line = (o) => JSON.stringify(o) + '\n'; // stringify escapes newlines, so 1 record == 1 line
  await write(res, line(exportHead(user)));

  let articles = 0;
  for (const a of store.iterExport.articles(user.id)) {
    await write(res, line({ type: 'article', data: a }));
    articles++;
  }
  let highlights = 0;
  for (const h of store.iterExport.highlights(user.id)) {
    await write(res, line({ type: 'highlight', data: h }));
    highlights++;
  }
  await write(res, line({ type: 'end', articles, highlights }));
  res.end();
}

// ---------------------------------------------------------------- routing
const ctx = {
  store, newId, sanitizeString, readBody, parseBody,
  createUser, verifyPassword, findUserByName, newEmailAlias,
  createSession, sessionCookie, getSessionUser, destroySession,
  searchArticles, countArticles, hostOf,
  ALLOW_SIGNUP, INBOUND_DOMAIN, APK_FILE, EXT_XPI_FILE, EXT_META_FILE,
  INBOUND_MAILBOX: inbound.enabled() ? inbound.cfg.user : '',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','articles','abc']

  try {
    if (parts[0] !== 'api') return await web.handle(ctx, req, res, url);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    return res.end('internal error');
  }

  // CORS — the Firefox extension posts from arbitrary page origins.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ---- inbound email webhook (Postmark-style JSON) — shared-secret auth,
  // routed to an account by the recipient alias. Always 200 for delivered
  // mail we choose to drop, so the provider doesn't retry or bounce.
  if (req.method === 'POST' && parts[1] === 'inbound-email' && parts.length === 2) {
    if (!INBOUND_SECRET) return json(res, 404, { error: 'inbound email not configured' });
    const given = url.searchParams.get('secret') || '';
    if (!given || !crypto.timingSafeEqual(sha256(given), sha256(INBOUND_SECRET))) {
      return json(res, 403, { error: 'bad secret' });
    }
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const candidates = [];
      for (const field of ['ToFull', 'CcFull', 'BccFull']) {
        for (const t of Array.isArray(b[field]) ? b[field] : []) {
          if (t && t.Email) candidates.push(String(t.Email));
        }
      }
      if (b.OriginalRecipient) candidates.push(String(b.OriginalRecipient));
      let target = null;
      for (const c of candidates) {
        target = store.userByAlias(c.toLowerCase().split('@')[0]);
        if (target) break;
      }
      if (!target) return json(res, 200, { ok: true, dropped: 'unknown recipient' });

      // idempotent per message: providers may retry delivery
      const messageId = sanitizeString(b.MessageID) ||
        crypto.createHash('sha256').update(`${b.From}|${b.Subject}|${b.Date}`).digest('hex').slice(0, 24);
      const { article } = saveEmailArticle({
        userId: target.id,
        messageId,
        subject: b.Subject,
        from: (b.FromFull && (b.FromFull.Name || b.FromFull.Email)) || b.From || null,
        date: b.Date,
        html: b.HtmlBody,
        text: b.TextBody,
      });
      return json(res, 200, { ok: true, id: article.id });
    } catch (e) {
      if (e instanceof SyntaxError) return json(res, 400, { error: 'invalid JSON body' });
      console.error(e);
      return json(res, 500, { error: 'internal error' });
    }
  }

  // ---- login: exchange username/password for the account's API token, so
  // devices can sign in without the user hand-copying the token.
  if (req.method === 'POST' && parts[1] === 'login' && parts.length === 2) {
    try {
      const b = parseBody(await readBody(req), req.headers['content-type']);
      const u = findUserByName(String(b.username || '').trim());
      if (!u || !verifyPassword(u.passwordHash, String(b.password || ''))) {
        await new Promise((r) => setTimeout(r, 300));
        return json(res, 401, { error: 'wrong username or password' });
      }
      return json(res, 200, {
        token: u.token,
        username: u.username,
        emailAddress: INBOUND_DOMAIN ? `${u.emailAlias}@${INBOUND_DOMAIN}` : null,
      });
    } catch (e) {
      if (e instanceof SyntaxError) return json(res, 400, { error: 'invalid JSON body' });
      throw e;
    }
  }

  // auth: bearer token (devices) or session cookie (web UI)
  const auth = req.headers.authorization || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const user = presented ? findUserByToken(presented) : getSessionUser(req);
  if (!user) return json(res, 401, { error: 'unauthorized' });

  try {
    // ---- health
    if (req.method === 'GET' && parts[1] === 'health') {
      return json(res, 200, {
        ok: true,
        articles: store.articleCount(user.id),
        highlights: store.highlightCount(user.id),
      });
    }

    // ---- full-account export (articles incl. HTML + all highlights)
    // Streamed row by row: a full account is far larger than this machine's
    // heap, so it is never assembled in memory. No Content-Length (chunked).
    if (req.method === 'GET' && parts[1] === 'export.json' && parts.length === 2) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="earmark-export.json"',
        'Cache-Control': 'no-store',
      });
      try {
        await streamExport(res, user);
      } catch (e2) {
        // Headers are long gone, so this cannot become a 5xx. Abort instead:
        // the truncated JSON won't parse, so a consumer fails loudly rather
        // than trusting a half-file.
        console.error('export failed midstream:', e2.message);
        res.destroy();
      }
      return;
    }

    // ---- same data, line-delimited: the format to back up with (see above)
    if (req.method === 'GET' && parts[1] === 'export.ndjson' && parts.length === 2) {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': 'attachment; filename="earmark-export.ndjson"',
        'Cache-Control': 'no-store',
      });
      try {
        await streamExportNdjson(res, user);
      } catch (e) {
        // Abort rather than end cleanly: every line of a truncated NDJSON file
        // still parses, so the missing "end" trailer is the only thing that
        // tells a backup script the file is incomplete.
        console.error('export failed midstream:', e.message);
        res.destroy();
      }
      return;
    }

    // ---- Android APK hosting: POST uploads a build (streamed to the data
    // dir, so it survives deploys); the web UI serves it at GET /app.apk.
    // Additional named APKs (e.g. a TTS engine) live at /apk/<name>.
    if (req.method === 'POST' && (
      (parts[1] === 'app.apk' && parts.length === 2) ||
      (parts[1] === 'apk' && parts.length === 3)
    )) {
      const target = parts[1] === 'app.apk'
        ? APK_FILE
        : (/^[a-z0-9-]{1,64}$/.test(parts[2]) ? path.join(DATA_DIR, `apk-${parts[2]}.apk`) : null);
      if (!target) return json(res, 400, { error: 'bad apk name (use a-z, 0-9, -)' });
      const tmp = target + '.tmp';
      const out = fs.createWriteStream(tmp);
      let size = 0;
      await new Promise((resolve, reject) => {
        req.on('data', (c) => {
          size += c.length;
          if (size > 200 * 1024 * 1024) { reject(new Error('apk too large')); req.destroy(); }
        });
        req.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        req.pipe(out);
      });
      fs.renameSync(tmp, target);
      // main app uploads carry version metadata so clients can offer updates
      if (target === APK_FILE) {
        const meta = {
          versionName: sanitizeString(url.searchParams.get('versionName'), 32) || null,
          versionCode: parseInt(url.searchParams.get('versionCode') || '0', 10) || 0,
          size,
          uploadedAt: Date.now(),
        };
        fs.writeFileSync(APK_META_FILE, JSON.stringify(meta));
      }
      return json(res, 201, { ok: true, size });
    }

    // ---- latest app version (for the in-app update check)
    if (req.method === 'GET' && parts[1] === 'app-version' && parts.length === 2) {
      if (!fs.existsSync(APK_META_FILE)) return json(res, 404, { error: 'no app uploaded' });
      return json(res, 200, JSON.parse(fs.readFileSync(APK_META_FILE, 'utf8')));
    }

    // ---- Firefox extension hosting: POST uploads a Mozilla-signed .xpi; the
    // server then serves it at GET /extension.xpi and advertises it in the
    // update manifest at GET /extension/updates.json so Firefox auto-updates.
    if (req.method === 'POST' && parts[1] === 'extension.xpi' && parts.length === 2) {
      const tmp = EXT_XPI_FILE + '.tmp';
      const out = fs.createWriteStream(tmp);
      let size = 0;
      const hash = crypto.createHash('sha256');
      await new Promise((resolve, reject) => {
        req.on('data', (c) => {
          size += c.length; hash.update(c);
          if (size > 50 * 1024 * 1024) { reject(new Error('xpi too large')); req.destroy(); }
        });
        req.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        req.pipe(out);
      });
      fs.renameSync(tmp, EXT_XPI_FILE);
      const meta = {
        version: sanitizeString(url.searchParams.get('version'), 32) || null,
        sha256: hash.digest('hex'),
        size,
        uploadedAt: Date.now(),
      };
      fs.writeFileSync(EXT_META_FILE, JSON.stringify(meta));
      return json(res, 201, { ok: true, size, version: meta.version });
    }

    // ---- current account
    if (req.method === 'GET' && parts[1] === 'me' && parts.length === 2) {
      return json(res, 200, {
        username: user.username,
        token: user.token,
        emailAddress: INBOUND_DOMAIN ? `${user.emailAlias}@${INBOUND_DOMAIN}` : null,
        createdAt: user.createdAt,
      });
    }

    // ---- articles collection
    if (parts[1] === 'articles' && parts.length === 2) {
      if (req.method === 'GET') {
        const num = (k) => parseInt(url.searchParams.get(k) || '0', 10) || 0;
        const list = searchArticles(user, {
          includeArchived: url.searchParams.get('includeArchived') === '1',
          since: num('since'),
          q: url.searchParams.get('q') || '',
          domain: url.searchParams.get('domain') || '',
          highlighted: url.searchParams.get('highlighted') === '1',
          minWords: num('minWords'),
          maxWords: num('maxWords'),
          minHighlights: num('minHighlights'),
        });
        return json(res, 200, { articles: list.map(pubArticleMeta) });
      }
      if (req.method === 'POST') {
        const b = parseBody(await readBody(req), req.headers['content-type']);
        const artUrl = sanitizeString(b.url);
        const html = typeof b.html === 'string' ? b.html : '';
        if (!artUrl || !html) return json(res, 400, { error: 'url and html are required' });
        const now = Date.now();
        const image = sanitizeString(b.image, 2000);
        const pub = typeof b.publishedAt === 'number' ? b.publishedAt
          : (b.publishedAt ? Date.parse(String(b.publishedAt)) : NaN);
        const fields = withSkipRules(user.id, {
          title: sanitizeString(b.title) || artUrl,
          byline: sanitizeString(b.byline),
          siteName: sanitizeString(b.siteName),
          excerpt: sanitizeString(b.excerpt),
          html,
          textContent: typeof b.textContent === 'string' ? b.textContent : null,
          imageUrl: image && /^https?:\/\//i.test(image) ? image : null,
          publishedAt: Number.isFinite(pub) && pub > 0 && pub < now + 86400000 ? pub : null,
          updatedAt: now,
        }, artUrl);
        // Keep the extension's captured page (only sent for weak parses) as the
        // raw source, so those — the ones most likely to be mis-parsed — can be
        // reparsed and shown in the original. A normal, clean save sends none and
        // we store nothing (reparse re-fetches the URL instead).
        if (typeof b.fallbackHtml === 'string' && b.fallbackHtml.trim()) {
          fields.sourceHtml = b.fallbackHtml.slice(0, SOURCE_CAP);
        }
        let a = store.articleByUrl(user.id, artUrl);
        if (a) {
          store.updateArticleContent(a.id, fields);
        } else {
          a = {
            id: newId(), userId: user.id, url: artUrl,
            savedAt: b.savedAt || now,
            archived: b.archived === true, // importers can create straight into the archive
            favorite: false, readParagraph: 0,
            ...fields,
          };
          store.insertArticle(a);
        }

        // Pre-compute the server voice for freshly-saved articles (skips
        // archived imports and no-ops when TTS isn't configured).
        if (!(b.archived === true)) enqueueTts(a.id, user.id);

        // LLM rescue: the extension flags saves it thinks it parsed badly by
        // attaching the stripped page HTML. Respond fast with what we have,
        // upgrade the stored article in the background (bumping updatedAt so
        // clients re-sync it).
        if (typeof b.fallbackHtml === 'string' && b.fallbackHtml.length > 0 && llm.enabled()) {
          const articleId = a.id;
          llm.extractArticle({ url: artUrl, title: fields.title, pageHtml: b.fallbackHtml })
            .then((better) => {
              if (!better) return;
              const current = store.getArticle(articleId, user.id);
              if (!current) return; // deleted in the meantime
              // Only upgrade if the LLM actually found more than we had.
              const currentLen = (current.textContent || '').length;
              if (better.textContent.length <= currentLen * 1.5 && currentLen > 800) return;
              store.updateArticleContent(articleId, withSkipRules(user.id, {
                title: current.title,
                byline: current.byline,
                siteName: current.siteName,
                excerpt: current.excerpt || better.textContent.slice(0, 300),
                html: better.html,
                textContent: better.textContent,
                updatedAt: Date.now(),
              }, artUrl));
              console.log(`LLM rescue upgraded article ${articleId} (${currentLen} → ${better.textContent.length} chars)`);
            })
            .catch((e) => console.error(`LLM rescue failed for ${articleId}: ${e.message}`));
        }

        return json(res, 201, pubArticle(store.getArticle(a.id, user.id)));
      }
    }

    // ---- bulk archive: archive all inbox articles older than N days
    if (req.method === 'POST' && parts[1] === 'articles' && parts[2] === 'bulk-archive' && parts.length === 3) {
      const b = parseBody(await readBody(req), req.headers['content-type']);
      const days = Number.isFinite(b.olderThanDays) ? Math.max(0, b.olderThanDays) : 365;
      const now = Date.now();
      const before = now - days * 24 * 60 * 60 * 1000;
      const archived = store.bulkArchiveBefore(user.id, before, now);
      return json(res, 200, { archived, olderThanDays: days });
    }

    // ---- save by URL: create a placeholder immediately and respond fast, then
    // fetch + extract the page in the BACKGROUND so the client never waits on a
    // slow page (which was causing Android share to time out). Used by share.
    if (req.method === 'POST' && parts[1] === 'save-url' && parts.length === 2) {
      const b = parseBody(await readBody(req), req.headers['content-type']);
      let artUrl = sanitizeString(b.url, 4000);
      const found = artUrl && artUrl.match(/https?:\/\/[^\s]+/i); // "Title https://…" → URL
      if (found) artUrl = found[0];
      if (!artUrl || !/^https?:\/\//i.test(artUrl)) return json(res, 400, { error: 'a http(s) url is required' });

      const existing = store.articleByUrl(user.id, artUrl);
      if (existing) return json(res, 200, { ...pubArticleMeta(existing), alreadySaved: true });

      const now = Date.now();
      const a = {
        id: newId(), userId: user.id, url: artUrl, savedAt: now,
        archived: false, favorite: false, readParagraph: 0,
        title: hostOf(artUrl) || artUrl, byline: null, siteName: hostOf(artUrl),
        excerpt: 'Fetching…', html: '<p>Fetching the article…</p>', textContent: 'Fetching…',
        updatedAt: now,
      };
      store.insertArticle(a);
      fillSavedUrl(a.id, user.id, artUrl); // background fetch + extract
      return json(res, 201, pubArticleMeta(store.getArticle(a.id, user.id)));
    }

    // ---- single article
    if (parts[1] === 'articles' && parts.length === 3) {
      const a = store.getArticle(parts[2], user.id);
      if (!a) return json(res, 404, { error: 'article not found' });
      if (req.method === 'GET') return json(res, 200, pubArticle(a));
      if (req.method === 'PATCH') {
        const b = parseBody(await readBody(req), req.headers['content-type']);
        store.patchArticle(a.id, {
          archived: typeof b.archived === 'boolean' ? b.archived : undefined,
          favorite: typeof b.favorite === 'boolean' ? b.favorite : undefined,
          readParagraph: b.readParagraph,
          ttsParagraph: b.ttsParagraph,
          updatedAt: Date.now(),
        });
        return json(res, 200, pubArticleMeta(store.getArticle(a.id, user.id)));
      }
      if (req.method === 'DELETE') {
        store.deleteArticle(a.id);
        return json(res, 200, { ok: true });
      }
    }

    // ---- server-synthesized audio for an article
    const audioMatch = parts.length === 4 && parts[1] === 'articles' &&
      (parts[3] === 'audio' || parts[3] === 'audio.wav' || parts[3] === 'audio.opus');
    if (audioMatch) {
      const a = store.getArticle(parts[2], user.id);
      if (!a) return json(res, 404, { error: 'article not found' });
      const dataFile = audioDataFile(a.id); // '' if not generated

      // GET .../audio → status + timing metadata (kicks off synthesis if absent)
      if (req.method === 'GET' && parts[3] === 'audio') {
        if (dataFile) {
          const meta = readAudioMeta(a.id);
          return json(res, 200, { ready: true, ...meta });
        }
        const queued = enqueueTts(a.id, user.id);
        return json(res, 200, { ready: false, enabled: tts.enabled(), queued });
      }

      // GET .../audio.<wav|opus> → stream the audio (Range for seeking)
      if (req.method === 'GET') {
        const ext = parts[3].slice('audio.'.length);
        const file = audioFile(a.id, ext);
        if (!fs.existsSync(file)) return json(res, 404, { error: 'audio not ready' });
        const mime = ext === 'opus' ? 'audio/ogg' : 'audio/wav';
        const size = fs.statSync(file).size;
        const range = req.headers.range;
        if (range) {
          const m = /bytes=(\d+)-(\d*)/.exec(range);
          const start = m ? parseInt(m[1], 10) : 0;
          const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
          res.writeHead(206, {
            'Content-Type': mime,
            'Content-Range': `bytes ${start}-${end}/${size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
          });
          return fs.createReadStream(file, { start, end }).pipe(res);
        }
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
        return fs.createReadStream(file).pipe(res);
      }

      // POST .../audio → force (re)generation
      if (req.method === 'POST' && parts[3] === 'audio') {
        if (!tts.enabled()) return json(res, 503, { error: 'server TTS not configured' });
        enqueueTts(a.id, user.id, true);
        return json(res, 202, { queued: true });
      }
    }

    // ---- reparse a mis-parsed article. The user says what's wrong (hint), we
    // re-extract from the raw source (or a fresh fetch) and overwrite the parse.
    // Synchronous so the client gets the result — heuristic is fast, the LLM
    // path can take a few seconds, so clients allow a longer timeout here.
    if (req.method === 'POST' && parts.length === 4 && parts[1] === 'articles' && parts[3] === 'reparse') {
      const a = store.getArticle(parts[2], user.id);
      if (!a) return json(res, 404, { error: 'article not found' });
      const b = parseBody(await readBody(req), req.headers['content-type']);
      const hint = ['too-short', 'too-long', 'other'].includes(b.hint) ? b.hint : 'other';
      const result = await reparse({
        url: a.url,
        title: a.title,
        hint,
        sourceHtml: store.getArticleSource(a.id, user.id),
        // Measure the parse the user is actually looking at. textContent can be a
        // different measure entirely — for emails it's the message's plain-text
        // part, not the rendered body — which would make "too short" unfixable.
        currentTextLen: textOf(a.html).length,
        fetchUrl: fetchPageHtml,
      });
      if (!result.ok) return json(res, 200, { ok: false, reason: result.reason });
      const art = result.article;
      store.updateArticleContent(a.id, withSkipRules(user.id, {
        title: art.title || a.title,
        byline: art.byline != null ? art.byline : a.byline,
        siteName: art.siteName || a.siteName,
        excerpt: art.excerpt || (art.textContent || '').slice(0, 300),
        html: art.html,
        textContent: art.textContent,
        updatedAt: Date.now(),
      }, a.url));
      // The parse changed, so paragraph indices moved — reset read/listen
      // positions rather than leave them pointing into the wrong paragraph.
      store.patchArticle(a.id, { readParagraph: 0, ttsParagraph: 0, updatedAt: Date.now() });
      enqueueTts(a.id, user.id, true);
      return json(res, 200, { ok: true, method: result.method, article: pubArticle(store.getArticle(a.id, user.id)) });
    }

    // ---- raw source for "view original": the captured source if we kept one,
    // else a fresh fetch for a normal web URL.
    if (req.method === 'GET' && parts.length === 4 && parts[1] === 'articles' && parts[3] === 'source') {
      const a = store.getArticle(parts[2], user.id);
      if (!a) return json(res, 404, { error: 'article not found' });
      let source = store.getArticleSource(a.id, user.id);
      let kind = source ? (a.url.startsWith('email:') ? 'email' : 'captured') : 'none';
      if (!source && /^https?:\/\//i.test(a.url)) {
        try { source = await fetchPageHtml(a.url); kind = 'web'; } catch { source = ''; }
      }
      return json(res, 200, { url: a.url, kind, hasSource: !!source, source: source || null });
    }

    // ---- highlights nested under an article
    if (parts[1] === 'articles' && parts.length === 4 && parts[3] === 'highlights') {
      const a = store.getArticle(parts[2], user.id);
      if (!a) return json(res, 404, { error: 'article not found' });
      if (req.method === 'GET') {
        return json(res, 200, { highlights: store.highlightsForArticle(a.id).map(pubHighlight) });
      }
      if (req.method === 'POST') {
        const b = parseBody(await readBody(req), req.headers['content-type']);
        const text = sanitizeString(b.text, 20000);
        if (!text) return json(res, 400, { error: 'text is required' });
        if (b.clientId) {
          const dup = store.highlightByClientId(user.id, sanitizeString(b.clientId));
          if (dup) return json(res, 200, pubHighlight(dup));
        }
        const h = {
          id: newId(),
          userId: user.id,
          clientId: sanitizeString(b.clientId) || null,
          articleId: a.id,
          text,
          note: sanitizeString(b.note, 20000),
          paragraphIndex: Number.isInteger(b.paragraphIndex) ? b.paragraphIndex : null,
          createdAt: b.createdAt || Date.now(),
        };
        store.insertHighlight(h);
        return json(res, 201, pubHighlight(h));
      }
    }

    // ---- PDF import: raw application/pdf body, parsed into an article
    if (req.method === 'POST' && parts[1] === 'import' && parts[2] === 'pdf' && parts.length === 3) {
      const buf = await readBodyBuffer(req, 50 * 1024 * 1024);
      if (buf.length < 5 || buf.subarray(0, 5).toString() !== '%PDF-') {
        return json(res, 400, { error: 'not a PDF file' });
      }
      const filename = sanitizeString(url.searchParams.get('filename'), 200) || 'document.pdf';
      let parsed;
      try {
        parsed = await pdf.pdfToArticle(buf, filename);
      } catch (e) {
        return json(res, 400, { error: `could not parse PDF: ${e.message}` });
      }
      if (!parsed.textContent.trim()) {
        return json(res, 400, { error: 'no extractable text (scanned/image-only PDF?)' });
      }
      // dedupe on content hash so re-importing the same file updates in place
      const artUrl = 'pdf:' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);
      const now = Date.now();
      let a = store.articleByUrl(user.id, artUrl);
      const fields = withSkipRules(user.id, {
        title: sanitizeString(parsed.title) || filename,
        byline: null,
        siteName: 'PDF',
        excerpt: sanitizeString(parsed.textContent.replace(/\s+/g, ' ').trim(), 300),
        html: parsed.html,
        textContent: parsed.textContent.slice(0, 500000),
        updatedAt: now,
      });
      if (a) {
        store.updateArticleContent(a.id, fields);
      } else {
        a = {
          id: newId(), userId: user.id, url: artUrl,
          savedAt: now, archived: false, favorite: false, readParagraph: 0,
          ...fields,
        };
        store.insertArticle(a);
      }
      return json(res, 201, pubArticle(store.getArticle(a.id, user.id)));
    }

    // ---- saved views (named filter sets shown as tabs in the clients)
    // ---- skip rules: boilerplate phrases dropped from future saves
    if (parts[1] === 'skip-rules') {
      if (req.method === 'GET' && parts.length === 2) {
        return json(res, 200, { rules: store.listSkipRules(user.id) });
      }
      if (req.method === 'POST' && parts.length === 2) {
        const b = parseBody(await readBody(req), req.headers['content-type']);
        const phrase = String(b.phrase || '').replace(/\s+/g, ' ').trim();
        const err = skip.phraseError(phrase);
        if (err) return json(res, 400, { error: `phrase ${err}` });
        const rule = { id: newId(), userId: user.id, phrase, createdAt: Date.now() };
        try {
          store.insertSkipRule(rule);
        } catch (e) {
          if (/UNIQUE/i.test(e.message)) return json(res, 409, { error: 'you already have that rule' });
          throw e;
        }
        // Rules are not retroactive; report how many saved articles contain the
        // phrase so an over-broad one is obvious before it eats future saves.
        return json(res, 201, {
          id: rule.id, phrase, hits: 0, createdAt: rule.createdAt,
          existingMatches: store.countArticlesContaining(user.id, phrase),
        });
      }
      if (req.method === 'DELETE' && parts.length === 3) {
        const { changes } = store.deleteSkipRule(parts[2], user.id);
        if (!changes) return json(res, 404, { error: 'rule not found' });
        return json(res, 200, { ok: true });
      }
    }

    if (parts[1] === 'views') {
      if (req.method === 'GET' && parts.length === 2) {
        return json(res, 200, { views: store.listViews(user.id).map(({ userId, ...v }) => v) });
      }
      if (req.method === 'POST' && parts.length === 2) {
        const b = parseBody(await readBody(req), req.headers['content-type']);
        const name = sanitizeString(b.name, 64);
        if (!name || !name.trim()) return json(res, 400, { error: 'name is required' });
        const f = b.filters && typeof b.filters === 'object' ? b.filters : {};
        const filters = {
          q: sanitizeString(f.q, 200) || '',
          domain: sanitizeString(f.domain, 200) || '',
          highlighted: f.highlighted === true,
          minWords: Number.isInteger(f.minWords) && f.minWords > 0 ? f.minWords : 0,
          maxWords: Number.isInteger(f.maxWords) && f.maxWords > 0 ? f.maxWords : 0,
          minHighlights: Number.isInteger(f.minHighlights) && f.minHighlights > 0 ? f.minHighlights : 0,
          includeArchived: f.includeArchived === true,
        };
        const v = { id: newId(), userId: user.id, name: name.trim(), filters, createdAt: Date.now() };
        store.insertView(v);
        return json(res, 201, { id: v.id, name: v.name, filters: v.filters, createdAt: v.createdAt });
      }
      if (req.method === 'DELETE' && parts.length === 3) {
        const { changes } = store.deleteView(parts[2], user.id);
        if (!changes) return json(res, 404, { error: 'view not found' });
        return json(res, 200, { ok: true });
      }
    }

    // ---- highlights collection / export / delete
    if (parts[1] === 'highlights') {
      if (req.method === 'GET' && parts.length === 2) {
        return json(res, 200, { highlights: store.highlightsForUser(user.id).map(pubHighlight) });
      }
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'export.md') {
        const byArticle = new Map();
        for (const h of store.highlightsForUser(user.id)) {
          if (!byArticle.has(h.articleId)) byArticle.set(h.articleId, []);
          byArticle.get(h.articleId).push(h);
        }
        let md = '# Highlights\n';
        for (const hs of byArticle.values()) {
          md += `\n## ${hs[0].articleTitle || 'Unknown article'}\n`;
          if (hs[0].articleUrl) md += `${hs[0].articleUrl}\n`;
          for (const h of hs.sort((x, y) => x.createdAt - y.createdAt)) {
            md += `\n> ${h.text.replace(/\n/g, '\n> ')}\n`;
            if (h.note) md += `\n${h.note}\n`;
          }
        }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        return res.end(md);
      }
      if (req.method === 'DELETE' && parts.length === 3) {
        const { changes } = store.deleteHighlight(parts[2], user.id);
        if (!changes) return json(res, 404, { error: 'highlight not found' });
        return json(res, 200, { ok: true });
      }
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof SyntaxError) return json(res, 400, { error: 'invalid JSON body' });
    console.error(e);
    return json(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ReadLater server listening on http://0.0.0.0:${PORT}`);
  const users = store.userCount();
  if (users === 0) {
    console.log(`No accounts yet — open http://localhost:${PORT}/signup in a browser to create one.`);
    if (LEGACY_TOKEN) console.log('The first account will adopt the existing API token and any existing articles.');
  } else {
    console.log(`${users} account(s). Each account's API token is on its /settings page.`);
  }
  if (INBOUND_SECRET) {
    console.log(`Email-to-save enabled${INBOUND_DOMAIN ? ` for @${INBOUND_DOMAIN}` : ''} — webhook at /api/inbound-email`);
  }
  if (!inbound.start({ saveEmailArticle, findUserByName, crypto })) {
    console.log('IMAP inbox polling disabled (set READLATER_IMAP_HOST, _USER, _PASS ' +
      'and _SAVE_TO_EARMARK_USER to enable)');
  }
});

'use strict';

/**
 * Spotting a save that didn't really work.
 *
 * Most saves are fine. The ones that aren't are nearly always a page the server
 * fetched itself — a link shared from the phone, where there is no browser and
 * no logged-in session, so the publisher answers with a 403, a consent wall, a
 * "turn on JavaScript" page or a subscriber teaser. What lands is an article
 * whose title is the bare domain and whose body is one line of apology. Those
 * should not sit in the main list looking like something to read.
 *
 * The rules below look only at cheap fields (title, excerpt, the text itself) —
 * never at the raw page — and are deliberately shy: a genuinely short post is
 * common and must stay in the list, so a thin article is only flagged when it is
 * REALLY thin. Everything here is reversible: the flag is recomputed from
 * scratch every time an article's content changes, so a re-save or a reparse
 * that lands a real article clears it with no special case.
 */

/** Below this, an article is too short to be one. A short blog post or a link
 *  round-up runs 100-300 words; a consent wall runs 10-40. */
const THIN_WORDS = 60;

/** A page whose title is just its domain is an extraction that gave up. Allowed
 *  a longer body than a thin one, because that shape (host title + a screenful
 *  of navigation text) is what a failed parse of a real page looks like. */
const UNPARSED_WORDS = 200;

/** How much of the start of the text the wall phrases are looked for in. A real
 *  article may well discuss captchas or paywalls; a wall says so up front. */
const LEAD_CHARS = 700;

/** Sources whose articles are short on purpose and must never be flagged:
 *  a highlight-only stub holds quotes, an episode holds "Transcribing…" until
 *  the transcript lands, a Kindle import holds the book's highlights. */
const EXEMPT_SOURCES = new Set(['highlight-stub', 'audio', 'kindle']);

/** The server's own fetch-failure placeholders (see fillSavedUrl). */
const FETCH_FAILED = /^(Fetch failed \(\d+\)|Could not fetch the page)/i;
const FETCH_FAILED_BODY = /Couldn't fetch this page/i;

/** Bot walls, consent gates and JS-required interstitials. */
const BLOCKED = [
  [/\b(enable|turn on) (javascript|js)( and cookies)?\b/i, 'the page wants JavaScript'],
  [/\b(are you a (human|robot)|verify (you are|you're) (a )?human|human verification)\b/i, 'a human check'],
  [/\b(access denied|403 forbidden|forbidden: you don't have permission)\b/i, 'access denied'],
  [/\bjust a moment\b/i, 'a bot check'],
  [/\b(unusual traffic|automated requests|requests from your (computer|network))\b/i, 'a bot check'],
  [/\b(captcha|cloudflare (ray id|to restrict access))\b/i, 'a bot check'],
  [/\byour browser (is out of date|isn't supported|does not support)\b/i, 'a browser check'],
];

/** Subscriber teasers — only a problem when almost nothing came with them. */
const PAYWALL = [
  /\b(subscribe (now )?to (continue|read|keep reading)|to continue reading,? (subscribe|sign in))\b/i,
  /\b(this (article|content|story) is (only )?(for|available to) subscribers)\b/i,
  /\b(already a (subscriber|member)\?|create your free account to (read|continue))\b/i,
  /\b(sign in to read|log in to continue reading)\b/i,
];

/** Words in a blob of article text. Matches how wordCount is counted in db.js. */
const wordsIn = (text) => (String(text || '').trim().match(/\S+/g) || []).length;

const hostOf = (url) => {
  try { return new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
};

/** Is this URL a link to a page (rather than a site's front door)? A homepage
 *  saved on purpose is thin by nature and is not a failed parse. */
const hasPath = (url) => {
  try {
    const u = new URL(String(url));
    return /^https?:$/.test(u.protocol) && u.pathname.replace(/\/+$/, '').length > 1;
  } catch { return false; }
};

/**
 * Why this article looks badly saved, or null when it looks fine.
 *
 * @param {object} a  { url, source, title, excerpt, textContent, html }
 * @returns {{reason: string, detail: string}|null}
 *   reason: a stable key ('fetch-failed' | 'blocked' | 'paywall' | 'empty' |
 *   'thin' | 'unparsed'); detail: one line to show in the list.
 */
function detectProblem(a = {}) {
  const source = a.source || '';
  if (EXEMPT_SOURCES.has(source)) return null;

  const title = String(a.title || '').trim();
  const excerpt = String(a.excerpt || '').trim();
  const text = String(a.textContent || '').trim();
  const html = String(a.html || '').trim();

  // Nothing has arrived yet: a save-by-URL placeholder, waiting on the
  // background fetch. Not a problem — the fetch will say.
  if (!text && !html && !excerpt) return null;

  if (FETCH_FAILED.test(excerpt) || FETCH_FAILED_BODY.test(html)) {
    const status = excerpt.match(/\((\d{3})\)/);
    return { reason: 'fetch-failed', detail: status ? `The site answered ${status[1]}` : "The page couldn't be fetched" };
  }

  const lead = text.slice(0, LEAD_CHARS);
  const words = wordsIn(text);

  for (const [re, what] of BLOCKED) {
    if (re.test(lead) || re.test(title)) return { reason: 'blocked', detail: `Saved ${what}, not the article` };
  }

  // A teaser is a paywall; a full article that happens to mention subscribing
  // is not, so this one needs the article to be short as well.
  if (words < UNPARSED_WORDS && PAYWALL.some((re) => re.test(lead))) {
    return { reason: 'paywall', detail: 'Saved a subscriber teaser, not the article' };
  }

  if (!words) return { reason: 'empty', detail: 'No article text was saved' };

  // Below here the article is real text, just possibly too little of it. Only
  // pages have a right shape to compare against; an email or an import doesn't.
  if (!hasPath(a.url)) return null;

  if (words < THIN_WORDS) return { reason: 'thin', detail: `Only ${words} word${words === 1 ? '' : 's'} were saved` };

  const host = hostOf(a.url);
  const bareTitle = title.toLowerCase().replace(/^www\./, '');
  if (host && (bareTitle === host || bareTitle === String(a.url).toLowerCase()) && words < UNPARSED_WORDS) {
    return { reason: 'unparsed', detail: 'No title and little text — the page never parsed' };
  }

  return null;
}

module.exports = { detectProblem, THIN_WORDS, UNPARSED_WORDS };

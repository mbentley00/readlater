'use strict';

/**
 * Re-extract a mis-parsed article on demand. The user flags an article as badly
 * parsed and says what's wrong (too short / too long / other); this tries to fix
 * exactly that.
 *
 * The cardinal rule: a reparse must move in the direction the user asked for, or
 * it must change NOTHING. An earlier version accepted any extraction the LLM
 * returned, so complaining "too short" could hand back an even shorter article —
 * strictly worse than doing nothing. Every candidate now has to satisfy() the
 * hint before it can overwrite the stored parse; if none do, we report
 * no-improvement and leave the article alone.
 *
 * Policy: cheap candidates first (email restructuring for emails, Readability
 * for pages), and only when none of them satisfies the hint do we pay for the
 * LLM — which gets the hint woven into its prompt.
 *
 * The raw source is either what we captured at save time (emails, extension
 * weak-parse captures) or, for a normal web URL where we stored nothing, a fresh
 * fetch — so we don't have to keep a copy of every page.
 */

const { extractReadable } = require('./extract');
const { emailToCleanHtml } = require('./email');
const llm = require('./llm');

const MIN_ARTICLE_CHARS = 250;

/** Wrap a bare email/fragment so Readability (via linkedom) builds a real body. */
function ensureDoc(html) {
  return /<html[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`;
}

/** Visible text of an HTML string — the measure we compare parses by. */
const textOf = (html) => String(html || '')
  .replace(/<(script|style|head|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function pack(a) {
  const textContent = String(a.textContent || '');
  return {
    title: a.title || null,
    byline: a.byline || null,
    siteName: a.siteName || null,
    excerpt: (a.excerpt || textContent.slice(0, 300)).trim().slice(0, 500),
    html: a.html || '',
    textContent,
  };
}

const lenOf = (c) => c.article.textContent.length;

/**
 * @param {object}   p
 * @param {string}   p.url             article url (email:/pdf: URLs aren't fetchable)
 * @param {string}   p.title           current title, passed to the LLM as a hint
 * @param {string}   p.hint            'too-short' | 'too-long' | 'other'
 * @param {string}   p.sourceHtml      captured raw source, or '' to fetch
 * @param {number}   p.currentTextLen  visible-text length of the CURRENT parse —
 *                                     what the user is looking at and complaining
 *                                     about, so callers should measure it from the
 *                                     stored html (see textOf), not from a stored
 *                                     plain-text field that may not match it.
 * @param {function} p.fetchUrl        async (url) => html, used when no sourceHtml
 * @returns {Promise<{ok:boolean, method?:string, reason?:string, article?:object, fetched?:string}>}
 */
async function reparse({ url, title, hint, sourceHtml, currentTextLen, fetchUrl }) {
  let raw = String(sourceHtml || '');
  let fetched = null;
  if (!raw.trim() && /^https?:\/\//i.test(url || '') && typeof fetchUrl === 'function') {
    try { fetched = await fetchUrl(url); raw = String(fetched || ''); }
    catch { /* handled by the no-source return below */ }
  }
  if (!raw.trim()) return { ok: false, reason: 'no-source' };

  const cur = Math.max(0, Number(currentTextLen) || 0);
  const isEmail = /^email:/i.test(url || '');

  /** Would this candidate actually address the complaint? */
  const satisfies = (len) => {
    if (len < MIN_ARTICLE_CHARS) return false;
    if (hint === 'too-short') return len > cur * 1.05; // must be meaningfully longer
    if (hint === 'too-long') return cur === 0 || len < cur * 0.9; // ...or shorter
    return true; // 'other': any real article is a fair attempt
  };

  // --- cheap candidates -----------------------------------------------------
  const candidates = [];
  if (isEmail) {
    // Readability is built for web pages and mangles newsletters; our own email
    // restructuring is the better heuristic for them.
    const html = emailToCleanHtml(raw);
    if (html) candidates.push({ method: 'email-structure', article: pack({ html, textContent: textOf(html) }) });
  }
  const readable = extractReadable(ensureDoc(raw), url);
  if (readable) candidates.push({ method: 'readability', article: pack(readable) });

  // Among candidates that satisfy the hint, take the longest: for 'too-short'
  // that's the most text recovered; for 'too-long' it's the most conservative
  // trim that still counts as a fix (so we cut junk, not prose).
  const best = (list) => {
    const ok = list.filter((c) => satisfies(lenOf(c)));
    return ok.length ? ok.reduce((a, b) => (lenOf(b) > lenOf(a) ? b : a)) : null;
  };

  let chosen = best(candidates);

  // --- escalate to the LLM only if nothing cheap worked ----------------------
  if (!chosen && llm.enabled()) {
    let better = null;
    try { better = await llm.extractArticle({ url, title, pageHtml: raw, hint }); }
    catch { better = null; }
    if (better) {
      const c = { method: 'llm', article: pack(better) };
      if (satisfies(lenOf(c))) chosen = c;
    }
  }

  // Nothing moved the article in the direction asked for. Leave it untouched —
  // overwriting with a parse that's wrong in the same way (or worse) is strictly
  // worse than doing nothing.
  if (!chosen) return { ok: false, reason: 'no-improvement', fetched };
  return { ok: true, method: chosen.method, article: chosen.article, fetched };
}

module.exports = { reparse, textOf, MIN_ARTICLE_CHARS };

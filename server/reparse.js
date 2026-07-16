'use strict';

/**
 * Re-extract a mis-parsed article on demand. The user flags an article as badly
 * parsed and says what's wrong (too short / too long / other); this tries to fix
 * exactly that.
 *
 * Policy (chosen by the user): heuristic first, then LLM. Run Mozilla Readability
 * on the raw source and accept it only if it plausibly corrects the complaint —
 * longer for 'too-short', shorter for 'too-long', substantial for 'other'.
 * Otherwise escalate to the LLM extractor with the hint woven into its prompt.
 * If the LLM is unavailable/unhelpful, fall back to whatever Readability produced
 * as long as it's a real article.
 *
 * The raw source is either what we captured at save time (emails, extension
 * weak-parse captures) or, for a normal web URL where we stored nothing, a fresh
 * fetch — so we don't have to keep a copy of every page.
 */

const { extractReadable } = require('./extract');
const llm = require('./llm');

const MIN_ARTICLE_CHARS = 250;

/** Wrap a bare email/fragment so Readability (via linkedom) builds a real body. */
function ensureDoc(html) {
  return /<html[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`;
}

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

/**
 * @param {object}   p
 * @param {string}   p.url             article url (may be email:/pdf: — then not fetchable)
 * @param {string}   p.title           current title, passed to the LLM as a hint
 * @param {string}   p.hint            'too-short' | 'too-long' | 'other'
 * @param {string}   p.sourceHtml      captured raw source, or '' to fetch
 * @param {number}   p.currentTextLen  length of the current parse, to judge "fixed"
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

  const readable = extractReadable(ensureDoc(raw), url);
  const rlen = readable ? String(readable.textContent || '').length : 0;
  const cur = Math.max(0, Number(currentTextLen) || 0);

  const heuristicFixes = readable && rlen >= MIN_ARTICLE_CHARS && (
    hint === 'too-short' ? rlen > cur * 1.2 :
    hint === 'too-long' ? (cur === 0 || rlen < cur * 0.9) :
    /* other */ true
  );
  if (heuristicFixes) return { ok: true, method: 'readability', article: pack(readable), fetched };

  if (llm.enabled()) {
    let better = null;
    try { better = await llm.extractArticle({ url, title, pageHtml: raw, hint }); }
    catch { better = null; }
    if (better && String(better.textContent || '').length >= 150) {
      return { ok: true, method: 'llm', article: pack(better), fetched };
    }
  }

  // Heuristic didn't clearly fix the complaint and the LLM couldn't help — take
  // Readability if it at least produced a real article, otherwise give up.
  if (readable && rlen >= MIN_ARTICLE_CHARS) {
    return { ok: true, method: 'readability-weak', article: pack(readable), fetched };
  }
  return { ok: false, reason: llm.enabled() ? 'extract-failed' : 'no-improvement', fetched };
}

module.exports = { reparse, MIN_ARTICLE_CHARS };

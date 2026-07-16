'use strict';

/**
 * Turn raw newsletter HTML into a clean, paragraph-structured article.
 *
 * Newsletters are laid out with tables, <div>/<td>/<font>/<center> wrappers and
 * <br> breaks rather than semantic <p> tags. The old email path stored that soup
 * verbatim, so the readers — which segment on block tags — collapsed a whole
 * newsletter into ONE enormous paragraph. That broke reading (a wall of text)
 * and text-to-speech (one block far over Android's per-utterance limit, so
 * playback stalled after a paragraph or two).
 *
 * This walks the email DOM and re-emits it as an ordered sequence of real block
 * elements (<p>, <h2>, <blockquote>, <ul><li>, <img>, <pre>), splitting on block
 * boundaries and <br>. The output is escaped text plus http(s) images only, so
 * it is also inert (no scripts, handlers, or javascript: URLs survive).
 *
 * It also drops later exact-duplicate paragraphs of >= MIN_DEDUP_WORDS words,
 * which newsletters produce constantly: a title echoed in a header block, a
 * subheader repeated, a photo caption printed twice.
 */

const { parseHTML } = require('linkedom');

/** Below this many words, a repeated line (e.g. "Read more", a nav label) is
 *  probably meant to appear more than once, so duplicates are kept. */
const MIN_DEDUP_WORDS = 8;

// Subtrees dropped entirely (non-content or unsafe).
const DROP = new Set([
  'script', 'style', 'head', 'title', 'noscript', 'svg', 'template', 'iframe',
  'object', 'embed', 'form', 'link', 'meta', 'base', 'button', 'input',
  'select', 'textarea', 'map', 'area',
]);

// Block-level containers: crossing one ends the current paragraph. Inline tags
// (a, span, strong, em, b, i, font, u, small, sub, sup, …) are NOT here, so their
// text keeps accreting into the current paragraph.
const BLOCK = new Set([
  'address', 'article', 'aside', 'center', 'dd', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'header', 'hgroup', 'hr', 'main', 'nav',
  'ol', 'p', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
]);

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const wordCount = (s) => (s.match(/\S+/g) || []).length;

const escapeText = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

/**
 * Parse [rawHtml] into an ordered list of block descriptors:
 *   { type: 'p'|'h'|'quote'|'li'|'pre', text }  or  { type: 'img', src, alt }
 * Returns [] when nothing speakable/renderable comes out (caller falls back).
 */
function emailToBlocks(rawHtml) {
  const html = String(rawHtml || '');
  if (!html.trim()) return [];

  // linkedom only builds a <body> when the markup has an <html> wrapper; a bare
  // fragment (common in webhook payloads) otherwise parses to an empty body.
  let src = html;
  if (!/<html[\s>]/i.test(src)) {
    src = /<body[\s>]/i.test(src) ? `<html>${src}</html>` : `<html><body>${src}</body></html>`;
  }
  let document;
  try {
    ({ document } = parseHTML(src));
  } catch {
    return [];
  }
  const root = document.body || document.documentElement;
  if (!root) return [];

  const blocks = [];
  let buf = '';

  const flush = (type = 'p') => {
    const text = collapse(buf);
    buf = '';
    if (text) blocks.push({ type, text });
  };

  const walk = (node) => {
    for (const child of node.childNodes || []) {
      // 3 = text node, 1 = element; ignore comments/others.
      if (child.nodeType === 3) { buf += child.textContent || ''; continue; }
      if (child.nodeType !== 1) continue;

      const tag = (child.tagName || '').toLowerCase();
      if (DROP.has(tag)) continue;

      if (tag === 'br') { flush('p'); continue; }

      if (tag === 'img') {
        const src = (child.getAttribute('src') || '').trim();
        if (/^https?:\/\//i.test(src)) {
          flush('p');
          blocks.push({ type: 'img', src, alt: collapse(child.getAttribute('alt')) });
        }
        continue;
      }

      // Leaf-ish blocks: take the whole subtree's text as one block and don't
      // recurse, so a multi-line heading/quote/list-item stays intact.
      if (/^h[1-6]$/.test(tag)) { flush('p'); pushLeaf('h', child); continue; }
      if (tag === 'blockquote') { flush('p'); pushLeaf('quote', child); continue; }
      if (tag === 'li') { flush('p'); pushLeaf('li', child); continue; }
      if (tag === 'pre') { flush('p'); pushLeaf('pre', child); continue; }

      if (BLOCK.has(tag)) { flush('p'); walk(child); flush('p'); continue; }

      // Inline element: descend, keep accumulating into the current paragraph.
      walk(child);
    }
  };

  const pushLeaf = (type, el) => {
    const text = collapse(el.textContent);
    if (text) blocks.push({ type, text });
  };

  walk(root);
  flush('p');
  return blocks;
}

/**
 * Drop later exact-duplicate paragraphs (case/space-insensitive) of at least
 * [minWords] words. Keeps the first occurrence and every short line. Images are
 * never deduped.
 */
function dedupeBlocks(blocks, minWords = MIN_DEDUP_WORDS) {
  const seen = new Set();
  const out = [];
  for (const b of blocks) {
    if (b.type !== 'img' && wordCount(b.text) >= minWords) {
      const key = b.text.toLowerCase();
      if (seen.has(key)) continue; // a duplicate of an earlier long paragraph
      seen.add(key);
    }
    out.push(b);
  }
  return out;
}

/** Serialize blocks back to a compact, inert article HTML string. */
function blocksToHtml(blocks) {
  const out = [];
  let inList = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (const b of blocks) {
    if (b.type === 'li') {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${escapeText(b.text)}</li>`);
      continue;
    }
    closeList();
    switch (b.type) {
      case 'h': out.push(`<h2>${escapeText(b.text)}</h2>`); break;
      case 'quote': out.push(`<blockquote>${escapeText(b.text)}</blockquote>`); break;
      case 'pre': out.push(`<pre>${escapeText(b.text)}</pre>`); break;
      case 'img': out.push(`<img src="${escapeAttr(b.src)}" alt="${escapeAttr(b.alt || '')}">`); break;
      default: out.push(`<p>${escapeText(b.text)}</p>`);
    }
  }
  closeList();
  return out.join('\n');
}

/**
 * Full pipeline: raw email HTML → clean, de-duplicated, paragraph-structured
 * article HTML. Returns '' when the input yields no usable blocks, so the caller
 * can fall back to the raw-sanitized body rather than storing nothing.
 */
function emailToCleanHtml(rawHtml) {
  const blocks = dedupeBlocks(emailToBlocks(rawHtml));
  return blocks.length ? blocksToHtml(blocks) : '';
}

module.exports = {
  emailToCleanHtml, emailToBlocks, dedupeBlocks, blocksToHtml, MIN_DEDUP_WORDS,
};

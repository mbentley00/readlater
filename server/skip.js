/**
 * Skip rules: user-defined boilerplate phrases ("Sign up for the latest from
 * our newsletter", "Some content from the original document could not be
 * imported") that get dropped from an article as it is saved.
 *
 * Applied at save time only. Highlights, reading position and TTS position are
 * all stored as indices into the block sequence parsed from article.html, so
 * removing a block from an already-saved article would silently re-anchor every
 * highlight after it. Filtering before the first save means the indices are
 * only ever computed against already-clean HTML.
 */
'use strict';

const { parseHTML } = require('linkedom');

/** Block elements a reader treats as paragraphs (mirrors tts.js paragraphsOf). */
const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, blockquote, li, figcaption, aside';

/**
 * Longest block a rule will delete. A phrase like "sign up for our newsletter"
 * usually sits in its own short block; when it appears mid-essay, deleting the
 * whole paragraph would destroy real prose to remove one sentence. Leaving the
 * boilerplate is the lesser harm, so long blocks are never removed.
 */
const MAX_BLOCK_CHARS = 600;

/** Minimum phrase length. Short phrases ("the") would gut every article. */
const MIN_PHRASE_CHARS = 8;

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Validate a phrase before it is ever stored. Returns null when acceptable. */
function phraseError(phrase) {
  const p = norm(phrase);
  if (p.length < MIN_PHRASE_CHARS) return `too short — use at least ${MIN_PHRASE_CHARS} characters`;
  if (p.length > 300) return 'too long — 300 characters max';
  return null;
}

/**
 * Strip blocks matching any rule from an article's html/textContent/excerpt.
 *
 * Returns the fields unchanged (same object identity for html) when nothing
 * matched, so an article whose rules never fire is not needlessly re-serialized
 * through the HTML parser.
 *
 * @param rules [{id, phrase}]
 * @param fields {html, textContent, excerpt}
 * @returns {{html, textContent, excerpt, removed: [{ruleId, text}]}}
 */
function applySkipRules(rules, fields) {
  const html = fields.html || '';
  const active = (rules || [])
    .map((r) => ({ id: r.id, needle: norm(r.phrase).toLowerCase() }))
    .filter((r) => r.needle.length >= MIN_PHRASE_CHARS);
  if (!active.length || !html) return { ...fields, removed: [] };

  // Parse into a detached container, not the document: linkedom leaves a bare
  // fragment outside <body>, so document.body.innerHTML would come back empty
  // and silently blank the article. A container round-trips it exactly.
  let root;
  try {
    const { document } = parseHTML('<!doctype html><html><body></body></html>');
    root = document.createElement('div');
    document.body.appendChild(root); // attached, so el.isConnected is meaningful
    root.innerHTML = html;
  } catch {
    return { ...fields, removed: [] }; // unparseable: never lose the article over a rule
  }

  const removed = [];
  for (const el of [...root.querySelectorAll(BLOCK_SELECTOR)]) {
    if (!el.isConnected) continue;             // already removed with an ancestor
    const text = norm(el.textContent);
    if (!text || text.length > MAX_BLOCK_CHARS) continue;
    const hay = text.toLowerCase();
    const rule = active.find((r) => hay.includes(r.needle));
    if (!rule) continue;
    removed.push({ ruleId: rule.id, text });
    el.remove();
  }
  if (!removed.length) return { ...fields, removed: [] };

  // A list whose items were all boilerplate leaves an empty <ul>/<ol>.
  for (const list of [...root.querySelectorAll('ul, ol')]) {
    if (!norm(list.textContent)) list.remove();
  }

  // Drop the same text from textContent, which is whitespace-collapsed (so the
  // block's normalized text appears verbatim) and drives search and TTS.
  let textContent = fields.textContent;
  if (typeof textContent === 'string' && textContent) {
    for (const r of removed) textContent = textContent.split(r.text).join(' ');
    textContent = norm(textContent);
  }

  let excerpt = fields.excerpt;
  if (typeof excerpt === 'string' && active.some((r) => excerpt.toLowerCase().includes(r.needle))) {
    excerpt = norm(textContent || '').slice(0, 300) || excerpt;
  }

  return { ...fields, html: root.innerHTML, textContent, excerpt, removed };
}

module.exports = { applySkipRules, phraseError, MAX_BLOCK_CHARS, MIN_PHRASE_CHARS, BLOCK_SELECTOR };

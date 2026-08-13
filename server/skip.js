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

// ---------------------------------------------------------------- domain rules
//
// Unlike skip rules — user phrases, matched anywhere — these are built-in and
// structural: they know how one publisher marks the end of its articles.

/** The Economist closes every article with a black square. */
const ECONOMIST_END_MARK = '■';

const hostOf = (url) => {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
};

const isEconomist = (url) => {
  const h = hostOf(url);
  return h === 'economist.com' || h.endsWith('.economist.com');
};

const isNewYorker = (url) => {
  const h = hostOf(url);
  return h === 'newyorker.com' || h.endsWith('.newyorker.com');
};

/**
 * A cartoon's artist credit. Capital C is deliberate: the credit is always
 * typeset "Cartoon by <artist>", so matching case-sensitively means the phrase
 * as it appears in prose ("a cartoon by Roz Chast ran in 1998") is not a match
 * at all, rather than something the guards below have to talk back down.
 */
const CARTOON_CREDIT = /Cartoons? by \S/;

/** Longest "Cartoon by <artist>" tail. Long enough for any byline, short enough to exclude prose. */
const CARTOON_CREDIT_MAX = 120;

/** Longest cartoon caption. The longest in a 194-cartoon sample ran 133 characters. */
const CARTOON_CAPTION_MAX = 300;

/**
 * A caption is a complete quotation — the whole line sits inside quote marks.
 * This is what separates a cartoon's caption from body copy that merely opens
 * with a quote: real prose closes the quote and keeps going ("'Perfect' was my
 * wedding song," a young woman said), so it fails the closing-quote test.
 */
const isCartoonCaption = (text) =>
  text.length > 0 && text.length <= CARTOON_CAPTION_MAX &&
  /^[“"]/.test(text) && /[”"]$/.test(text);

/** Split a block's text at its cartoon credit. Returns null when there is none. */
function splitAtCredit(text) {
  const m = CARTOON_CREDIT.exec(text);
  if (!m) return null;
  return { before: norm(text.slice(0, m.index)), credit: norm(text.slice(m.index)) };
}

/**
 * Strip The New Yorker's mid-article cartoon inserts.
 *
 * A cartoon lands in the middle of a piece as a drawing, usually a caption line,
 * then a "Cartoon by <artist>" credit. Read as prose — or worse, spoken by TTS —
 * the caption and credit arrive mid-argument as though they were the article.
 *
 * Nearly always the whole insert is a single <figure> (the caption and credit
 * being its figcaptions or nested paragraphs), so removing that figure takes the
 * drawing, caption and credit together and structurally cannot touch body copy:
 * article prose is never inside a cartoon figure. A flattened extraction
 * occasionally leaves the credit as a bare sibling paragraph instead, which is
 * handled second and far more warily — there the block before the credit is as
 * likely to be the last paragraph of real article content as it is a caption.
 *
 * Returns fields unchanged, and cartoons: 0, for any other publisher or an
 * article with no credit in it.
 */
function applyNewYorkerCartoons(url, fields) {
  const html = fields.html || '';
  if (!html || !isNewYorker(url) || !CARTOON_CREDIT.test(html)) {
    return { ...fields, cartoons: 0 };
  }

  let root;
  try {
    const { document } = parseHTML('<!doctype html><html><body></body></html>');
    root = document.createElement('div');
    document.body.appendChild(root);
    root.innerHTML = html;
  } catch {
    return { ...fields, cartoons: 0 }; // never lose the article over a rule
  }

  let cartoons = 0;

  // 1. The whole insert as one figure — the overwhelmingly common shape.
  for (const fig of [...root.querySelectorAll('figure')]) {
    if (!fig.isConnected) continue; // nested figure already removed with its parent
    const split = splitAtCredit(norm(fig.textContent));
    if (!split) continue;
    // Everything in the figure must be accounted for as caption + credit. A
    // figure carrying real prose is not a cartoon insert, whatever it credits.
    if (split.credit.length > CARTOON_CREDIT_MAX) continue;
    if (split.before && !isCartoonCaption(split.before)) continue;
    fig.remove();
    cartoons++;
  }

  // A gallery lists one cartoon per <li>; emptying the figures leaves the shell.
  if (cartoons) {
    for (const li of [...root.querySelectorAll('li')]) {
      if (!norm(li.textContent) && !li.querySelector('img, picture, iframe')) li.remove();
    }
    for (const list of [...root.querySelectorAll('ul, ol')]) {
      if (!list.children.length) list.remove();
    }
  }

  // 2. The credit flattened into a bare paragraph, outside any figure.
  const blocks = [...root.querySelectorAll(BLOCK_SELECTOR)];
  const order = [...root.querySelectorAll('*')];
  const posOf = new Map(order.map((el, i) => [el, i]));
  /** Does a drawing sit between these two blocks? Then `a` is not `b`'s caption. */
  const imageBetween = (a, b) => order
    .slice(posOf.get(a) + 1, posOf.get(b))
    .some((el) => !a.contains(el) && /^(img|picture|figure|svg)$/i.test(el.tagName));

  for (let i = 0; i < blocks.length; i++) {
    const el = blocks[i];
    if (!el.isConnected || el.closest('figure')) continue;
    const split = splitAtCredit(norm(el.textContent));
    if (!split) continue;
    if (split.credit.length > CARTOON_CREDIT_MAX) continue;
    // Text ahead of the credit in the same block is the caption run together
    // with it. Anything else is prose that merely mentions a cartoon — leave it.
    if (split.before && !isCartoonCaption(split.before)) continue;

    // The caption, when it is its own block, is the block just before — but only
    // when nothing was drawn in between. The cartoon's caption sits below its
    // drawing, so an intervening image proves the earlier block belongs to the
    // article, not the cartoon. That single check is what keeps the last
    // paragraph before a cartoon from being swallowed with it.
    const prev = i > 0 ? blocks[i - 1] : null;
    if (prev && prev.isConnected && !prev.contains(el) && !prev.closest('figure') &&
        isCartoonCaption(norm(prev.textContent)) && !imageBetween(prev, el)) {
      prev.remove();
    }
    el.remove();
    cartoons++;
  }

  if (!cartoons) return { ...fields, cartoons: 0 };

  const textContent = norm(root.textContent) || fields.textContent;
  return {
    ...fields,
    html: root.innerHTML,
    textContent: typeof fields.textContent === 'string' ? textContent : fields.textContent,
    cartoons,
  };
}

/**
 * Truncate an Economist article at its end-of-article mark.
 *
 * Their body copy ends with a black square (■); everything after it is trailing
 * apparatus — "explore more", subscription pitches, related-article rails — that
 * reads as part of the piece and, worse, gets spoken aloud after the article has
 * actually finished.
 *
 * The marker's own block is KEPT (the square sits at the end of the last real
 * sentence, so dropping the block would eat that sentence); everything after it
 * in document order goes. A block-level marker that is only the square itself is
 * dropped too, since it carries no prose.
 *
 * Returns fields unchanged when the article isn't the Economist's or has no
 * marker — a missing square must never truncate an article to nothing.
 */
function applyEconomistEndMark(url, fields) {
  const html = fields.html || '';
  if (!html || !isEconomist(url) || !html.includes(ECONOMIST_END_MARK)) {
    return { ...fields, truncated: false };
  }

  let root;
  try {
    const { document } = parseHTML('<!doctype html><html><body></body></html>');
    root = document.createElement('div');
    document.body.appendChild(root);
    root.innerHTML = html;
  } catch {
    return { ...fields, truncated: false }; // never lose the article over a rule
  }

  // querySelectorAll is document order, and an ancestor always precedes its
  // descendants — so everything after the marker block is safe to remove.
  const blocks = [...root.querySelectorAll(BLOCK_SELECTOR)];
  const markIdx = blocks.findIndex((el) => (el.textContent || '').includes(ECONOMIST_END_MARK));
  if (markIdx === -1) return { ...fields, truncated: false }; // square wasn't in a block

  const mark = blocks[markIdx];
  for (const el of blocks.slice(markIdx + 1)) {
    if (el.isConnected) el.remove();
  }
  // Anything after the marker's block that isn't itself a block (stray divs,
  // rails, trailing text) — walk up to the marker's top-level ancestor and drop
  // every later sibling at each level.
  for (let node = mark; node && node !== root; node = node.parentNode) {
    while (node.nextSibling) node.parentNode.removeChild(node.nextSibling);
  }
  // A block holding only the square is apparatus, not prose.
  if (norm(mark.textContent) === ECONOMIST_END_MARK) mark.remove();

  const textContent = norm(root.textContent) || fields.textContent;
  return {
    ...fields,
    html: root.innerHTML,
    textContent: typeof fields.textContent === 'string' ? textContent : fields.textContent,
    truncated: true,
  };
}

/**
 * Run every built-in publisher rule over an article. Each rule recognizes its
 * own domain and returns the fields untouched otherwise, so they simply chain.
 *
 * @returns fields plus {truncated: bool, cartoons: int} describing what fired.
 */
function applyDomainRules(url, fields) {
  return applyNewYorkerCartoons(url, applyEconomistEndMark(url, fields));
}

module.exports = {
  applySkipRules, phraseError, applyDomainRules,
  applyEconomistEndMark, applyNewYorkerCartoons, isEconomist, isNewYorker,
  MAX_BLOCK_CHARS, MIN_PHRASE_CHARS, BLOCK_SELECTOR, ECONOMIST_END_MARK,
  CARTOON_CREDIT, CARTOON_CAPTION_MAX, CARTOON_CREDIT_MAX,
};

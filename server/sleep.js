'use strict';
/**
 * Sleep mode's outside sources: a random long article from a site that isn't
 * in the library yet. The phone asks for a candidate (GET /api/sleep/candidate),
 * shuffles until one appeals, and only the one it plays is saved
 * (POST /api/sleep/save) — straight into the archive, so a night's listening
 * never clutters the inbox.
 *
 *   historylink — HistoryLink.org essays (/File/<n>). Most are short timeline
 *                 entries, so random ids are probed until a long one turns up;
 *                 long ones found along the way are remembered for later.
 *   cambridge   — Cambridge Core open-access history journal articles, from
 *                 a random page of the open-access listing. Nearly all long.
 */
const { extractReadable } = require('./extract');

const HISTORYLINK = 'https://historylink.org';
const CAMBRIDGE_LISTING = 'https://www.cambridge.org/core/publications/open-access/listing'
  + '?aggs%5BproductTypes%5D%5Bfilters%5D=JOURNAL_ARTICLE'
  + '&aggs%5BproductSubject%5D%5Bfilters%5D=66BE42A30172E280FDE64F8EE2F485B0'
  + '&searchWithinIds=7275BA1E84CA769210167A6A66523B47';

const SOURCES = {
  historylink: { label: 'HistoryLink', minWords: 2500 },
  cambridge: { label: 'Cambridge', minWords: 3000 },
};

const DAY = 24 * 60 * 60 * 1000;
const countWords = (s) => { const t = String(s || '').trim(); return t ? t.split(/\s+/).length : 0; };
const htmlText = (html) => String(html || '')
  .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

/** Extracted articles waiting for a save, by url (a candidate is usually
 *  saved within minutes of being offered, or never). */
const extracted = new Map();
const EXTRACTED_KEEP = 30;
function remember(art) {
  extracted.delete(art.url);
  extracted.set(art.url, art);
  while (extracted.size > EXTRACTED_KEEP) extracted.delete(extracted.keys().next().value);
}

// ---------------------------------------------------------------- HistoryLink

let hlMaxId = 0;
let hlMaxIdAt = 0;
/** Long essays seen while probing — later picks start here. */
const hlLong = new Set();

async function historyLinkMaxId(fetchPage) {
  if (hlMaxId && Date.now() - hlMaxIdAt < DAY) return hlMaxId;
  const r = await fetchPage(HISTORYLINK + '/');
  const ids = r.ok ? [...r.html.matchAll(/\/File\/(\d+)/g)].map((m) => +m[1]) : [];
  hlMaxId = ids.length ? Math.max(...ids) : (hlMaxId || 23600);
  hlMaxIdAt = Date.now();
  return hlMaxId;
}

/** HistoryLink's page with the header (title, byline, essay number), the
 *  sources, licence and sponsor list cut away — the essay itself. */
function historyLinkArticle(url, pageHtml) {
  const r = extractReadable(pageHtml, url);
  if (!r) return null;
  let html = r.html;
  const author = (html.match(/<li>\s*By\b[\s:]*(?:<a[^>]*>)?\s*([^<]+)/i) || [])[1];
  html = html.replace(/<header id="article-header">[\s\S]*?<\/header>/i, '');
  const tail = html.search(/<hr>\s*<h6>/i);
  if (tail > 0) html = html.slice(0, tail);
  // Things like "HistoryLink.org's Timeline Library" or a 404 page.
  if (/^(Page Not Found|Error)/i.test(r.title || '')) return null;
  const text = htmlText(html);
  return {
    url,
    title: r.title,
    byline: author ? author.trim() : r.byline,
    siteName: 'HistoryLink.org',
    excerpt: text.slice(0, 300),
    html,
    textContent: text,
    wordCount: countWords(text),
  };
}

async function historyLinkCandidate(fetchPage, exclude) {
  const known = [...hlLong].filter((u) => !exclude.has(u));
  // Mostly reuse what's known, but keep exploring so the pool keeps growing.
  if (known.length >= 5 && Math.random() < 0.7) {
    const url = pick(known);
    const art = extracted.get(url) || await fetchHistoryLink(fetchPage, url);
    if (art) return art;
  }
  const maxId = await historyLinkMaxId(fetchPage);
  // Probe a few at a time: roughly one essay in four is long enough.
  for (let round = 0; round < 5; round++) {
    const urls = [];
    while (urls.length < 4) {
      const u = `${HISTORYLINK}/File/${randInt(1000, maxId)}`;
      if (!exclude.has(u) && !urls.includes(u)) urls.push(u);
    }
    const arts = (await Promise.all(urls.map((u) => fetchHistoryLink(fetchPage, u).catch(() => null))))
      .filter(Boolean);
    const long = arts.filter((a) => a.wordCount >= SOURCES.historylink.minWords);
    if (long.length) return long[0];
  }
  return known.length ? fetchHistoryLink(fetchPage, pick(known)) : null;
}

async function fetchHistoryLink(fetchPage, url) {
  const r = await fetchPage(url);
  if (!r.ok) return null;
  const art = historyLinkArticle(url, r.html);
  if (!art) return null;
  if (art.wordCount >= SOURCES.historylink.minWords) {
    hlLong.add(url);
    remember(art);
  }
  return art;
}

// ---------------------------------------------------------------- Cambridge

let camPages = 0;
let camPagesAt = 0;

async function cambridgeListing(fetchPage, page) {
  const r = await fetchPage(page > 1 ? `${CAMBRIDGE_LISTING}&pageNum=${page}` : CAMBRIDGE_LISTING);
  if (!r.ok) throw new Error(`Cambridge listing: HTTP ${r.status}`);
  if (page === 1 || !camPages) {
    const pages = [...r.html.matchAll(/pageNum=(\d+)/g)].map((m) => +m[1]);
    if (pages.length) { camPages = Math.max(...pages); camPagesAt = Date.now(); }
  }
  return [...new Set([...r.html.matchAll(/href="(\/core\/journals\/[^"\/]+\/article\/[^"]+)"/g)]
    .map((m) => 'https://www.cambridge.org' + m[1].replace(/&amp;/g, '&')))];
}

function cambridgeArticle(url, pageHtml) {
  const r = extractReadable(pageHtml, url);
  if (!r) return null;
  const text = r.textContent;
  const journal = (pageHtml.match(/<meta[^>]+name="citation_journal_title"[^>]+content="([^"]+)"/i) || [])[1];
  const authors = [...pageHtml.matchAll(/<meta[^>]+name="citation_author"[^>]+content="([^"]+)"/gi)].map((m) => m[1]);
  return {
    url,
    // Readability takes the <title>, which trails "| Journal | Cambridge Core".
    title: (r.title || '').split(' | ')[0].trim() || r.title,
    byline: authors.length ? authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : '')
      : (r.byline || '').split(/\*|Affiliation:/)[0].trim() || null,
    siteName: journal ? `${journal} (Cambridge)` : 'Cambridge Core',
    excerpt: text.slice(0, 300),
    html: r.html,
    textContent: text,
    wordCount: countWords(text),
  };
}

async function cambridgeCandidate(fetchPage, exclude) {
  if (!camPages || Date.now() - camPagesAt > DAY) await cambridgeListing(fetchPage, 1);
  for (let attempt = 0; attempt < 4; attempt++) {
    const links = (await cambridgeListing(fetchPage, randInt(1, Math.max(1, camPages))))
      .filter((u) => !exclude.has(u));
    if (!links.length) continue;
    const url = pick(links);
    const cached = extracted.get(url);
    if (cached) return cached;
    const r = await fetchPage(url);
    if (!r.ok) continue;
    const art = cambridgeArticle(url, r.html);
    if (art && art.wordCount >= SOURCES.cambridge.minWords) { remember(art); return art; }
  }
  return null;
}

// ---------------------------------------------------------------- API

/** A random long article from [source], extracted and held for a save.
 *  [exclude] holds urls already offered (or already in the library). */
async function candidate(source, fetchPage, exclude = new Set()) {
  if (source === 'historylink') return historyLinkCandidate(fetchPage, exclude);
  if (source === 'cambridge') return cambridgeCandidate(fetchPage, exclude);
  throw new Error(`unknown source ${source}`);
}

/** The full article for a url offered as a candidate — re-fetched when it
 *  has dropped out of the cache. */
async function article(url, fetchPage) {
  const cached = extracted.get(url);
  if (cached) return cached;
  const r = await fetchPage(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const art = url.startsWith(HISTORYLINK) ? historyLinkArticle(url, r.html)
    : url.startsWith('https://www.cambridge.org/') ? cambridgeArticle(url, r.html)
    : null;
  if (!art) throw new Error('could not extract the article');
  return art;
}

const sourceOf = (url) => url.startsWith(HISTORYLINK) ? 'historylink'
  : url.startsWith('https://www.cambridge.org/') ? 'cambridge' : null;

module.exports = { SOURCES, candidate, article, sourceOf, historyLinkArticle, cambridgeArticle };

// Server-side article extraction using Mozilla Readability (the same algorithm
// the Firefox extension runs client-side), so save-by-URL produces clean text
// instead of dumping the whole page (nav, ads, newsletter cruft and all).
const { Readability } = require('@mozilla/readability');
const { parseHTML } = require('linkedom');

/** Rewrite relative src/href in a snippet of HTML to absolute URLs. */
function absolutizeUrls(html, base) {
  if (!base) return html;
  return String(html).replace(/(\b(?:src|href)=)(["'])(.*?)\2/gi, (m, attr, q, val) => {
    if (!val || /^(https?:|data:|mailto:|tel:|#)/i.test(val)) return m;
    try { return `${attr}${q}${new URL(val, base).href}${q}`; } catch { return m; }
  });
}

/**
 * Condé Nast sites (The New Yorker, Wired, Vanity Fair, …) split an article body
 * into several sibling "chunks", each its own `div.body__inner-container`, with
 * ad / newsletter / embed units wedged between them. Readability scores whole
 * containers and keeps only the top-scoring one, so every chunk after the first
 * is silently dropped — which is why some New Yorker pieces come out a paragraph
 * or two short, missing the final paragraph and its ♦ end-of-article mark.
 *
 * Hoist the later chunks' children into the first chunk so Readability sees one
 * continuous body. A no-op on any page without at least two such containers, so
 * it can't affect non-Condé-Nast articles.
 */
function mergeChunkedBody(document) {
  const chunks = [...document.querySelectorAll('div.body__inner-container')];
  if (chunks.length < 2) return;
  const first = chunks[0];
  for (const chunk of chunks.slice(1)) {
    while (chunk.firstChild) first.appendChild(chunk.firstChild);
    chunk.remove();
  }
}

/**
 * Strip "Read more by <author>" trailers: a list of the author's OTHER pieces,
 * each in a container whose class contains "author".
 *
 * Readability picks a byline from the first element whose class or rel looks
 * like `byline|author|dateline`, so on Literary Review it was matching
 * `article.article-author-excerpt` — a teaser for a different article — and
 * using that headline as the byline. Every review there came out bylined with
 * the name of another review. Removing the block also keeps those headlines
 * out of the article text, where they read as stray sentences.
 *
 * A no-op on pages without such a trailer.
 */
function stripAuthorTrailers(document) {
  for (const el of document.querySelectorAll('article.article-author-excerpt')) el.remove();
  for (const el of document.querySelectorAll('header, h1, h2, h3, span')) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (/^read more by\b/i.test(t) && t.length < 120) el.remove();
  }
}

/**
 * Undo "<author> - <headline>" titles.
 *
 * Some publishers put the author in front of the headline in og:title and ship
 * no author metadata at all, so the whole thing lands in the title and
 * Readability is left guessing a byline from page furniture. Literary Review
 * does exactly this: og:title "Stephen Smith - The Narcissist Test", no author
 * meta, which is how a review came out titled for its reviewer.
 *
 * Only splits when the document title independently names the same person
 * ("... - review by Stephen Smith"). Without that corroboration this would
 * maul every ordinary headline containing a dash.
 */
function splitBylineFromTitle(document, out) {
  const docTitle = ((document.querySelector('title') || {}).textContent || '')
    .replace(/\s+/g, ' ').trim();
  const by = docTitle.match(/[-\u2013\u2014]\s*review(?:ed)? by\s+(.+)$/i);
  if (!by) return out;
  const name = by[1].trim();
  if (!name || name.length > 80) return out;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lead = new RegExp(`^${esc}\\s*[-\u2013\u2014:]\\s*`, 'i');
  const title = String(out.title || '');
  if (!lead.test(title)) return out;
  return { ...out, title: title.replace(lead, '').trim(), byline: name };
}

/**
 * Extract the main article from raw page HTML. Returns null when Readability
 * can't find a substantial article (caller falls back to a cruder path / LLM).
 */
function extractReadable(pageHtml, url) {
  try {
    const { document } = parseHTML(pageHtml);
    mergeChunkedBody(document);
    stripAuthorTrailers(document);
    const article = new Readability(document, { charThreshold: 200 }).parse();
    if (!article) return null;
    const textContent = String(article.textContent || '').replace(/\s+/g, ' ').trim();
    if (textContent.length < 250) return null; // too thin to trust
    return splitBylineFromTitle(document, {
      title: article.title ? article.title.trim().slice(0, 500) : null,
      byline: article.byline ? article.byline.replace(/\s+/g, ' ').trim().slice(0, 200) : null,
      siteName: article.siteName ? article.siteName.trim().slice(0, 200) : null,
      excerpt: (article.excerpt || textContent.slice(0, 300)).trim().slice(0, 500),
      html: absolutizeUrls(article.content || '', url),
      textContent: textContent.slice(0, 400000),
    });
  } catch (e) {
    return null;
  }
}

module.exports = {
  extractReadable, absolutizeUrls, mergeChunkedBody, stripAuthorTrailers, splitBylineFromTitle,
};

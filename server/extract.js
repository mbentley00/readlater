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
 * Extract the main article from raw page HTML. Returns null when Readability
 * can't find a substantial article (caller falls back to a cruder path / LLM).
 */
function extractReadable(pageHtml, url) {
  try {
    const { document } = parseHTML(pageHtml);
    const article = new Readability(document, { charThreshold: 200 }).parse();
    if (!article) return null;
    const textContent = String(article.textContent || '').replace(/\s+/g, ' ').trim();
    if (textContent.length < 250) return null; // too thin to trust
    return {
      title: article.title ? article.title.trim().slice(0, 500) : null,
      byline: article.byline ? article.byline.replace(/\s+/g, ' ').trim().slice(0, 200) : null,
      siteName: article.siteName ? article.siteName.trim().slice(0, 200) : null,
      excerpt: (article.excerpt || textContent.slice(0, 300)).trim().slice(0, 500),
      html: absolutizeUrls(article.content || '', url),
      textContent: textContent.slice(0, 400000),
    };
  } catch (e) {
    return null;
  }
}

module.exports = { extractReadable, absolutizeUrls };

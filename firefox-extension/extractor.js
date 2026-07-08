/**
 * ReadLater article extractor — runs as a content script in the live page.
 *
 * Crucially, this reads the DOM *as currently rendered in your session*:
 * if you can see the article (logged in, past a metered paywall, after
 * client-side rendering), this captures it. It never re-fetches the URL.
 *
 * Extraction strategy:
 *   1. Mozilla Readability (vendored, injected before this script) on a
 *      clone of the document — the same engine as Firefox Reader View.
 *   2. If Readability fails or returns something thin, fall back to the
 *      original container-scoring heuristic.
 *   3. If the best result still looks wrong (tiny compared to the page),
 *      attach a stripped copy of the whole page as `fallbackHtml` so the
 *      server can re-extract it with an LLM.
 *
 * The file's completion value (the object at the end) is returned to the
 * background script by browser.tabs.executeScript().
 */
(() => {
  'use strict';

  const NOISE_SELECTORS = [
    'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed',
    'form', 'button', 'input', 'select', 'textarea', 'svg', 'canvas',
    'nav', 'aside', 'footer', 'header',
    '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
    '[role="dialog"]', '[aria-hidden="true"]', '[hidden]',
  ].join(',');

  const NOISE_PATTERN = new RegExp(
    [
      'comment', 'share', 'social', 'related', 'recommend', 'newsletter',
      'subscribe', 'promo', 'advert', '\\bad\\b', 'ad-', 'sponsor', 'popup',
      'cookie', 'consent', 'paywall', 'sidebar', 'breadcrumb', 'byline-share',
      'skip-link', 'sr-only', 'visually-hidden',
    ].join('|'),
    'i'
  );

  const KEEP_ATTRS = new Set(['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'start']);

  function meta(name) {
    const el =
      document.querySelector(`meta[property="${name}"]`) ||
      document.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute('content') : null;
  }

  function textLen(el) {
    let n = 0;
    for (const p of el.querySelectorAll('p')) n += p.textContent.trim().length;
    return n;
  }

  function linkDensity(el) {
    const total = el.textContent.trim().length || 1;
    let linked = 0;
    for (const a of el.querySelectorAll('a')) linked += a.textContent.trim().length;
    return linked / total;
  }

  /** Resolve lazy-loaded image URLs in a cloned tree using the live DOM's state. */
  function fixImagesInClone(cloneRoot, liveRoot) {
    const liveImgs = liveRoot.querySelectorAll('img');
    const cloneImgs = cloneRoot.querySelectorAll('img');
    for (let i = 0; i < cloneImgs.length && i < liveImgs.length; i++) {
      const live = liveImgs[i];
      const src =
        live.currentSrc ||
        live.src ||
        live.getAttribute('data-src') ||
        live.getAttribute('data-lazy-src') ||
        '';
      if (src) {
        try { cloneImgs[i].setAttribute('src', new URL(src, location.href).href); } catch (e) {}
      }
      cloneImgs[i].removeAttribute('srcset');
    }
  }

  // ---------------------------------------------------------------- primary:
  // Mozilla Readability on a document clone (Readability mutates its input).
  function readabilityExtract() {
    if (typeof Readability !== 'function') return null;
    try {
      const docClone = document.cloneNode(true);
      fixImagesInClone(docClone, document);
      const result = new Readability(docClone).parse();
      if (!result || !result.content) return null;
      const text = (result.textContent || '').trim();
      if (text.length < 500) return null; // too thin — let the heuristic try
      return {
        html: result.content,
        textContent: text.replace(/\s+/g, ' '),
        title: result.title || null,
        byline: result.byline || null,
        siteName: result.siteName || null,
        excerpt: result.excerpt || null,
      };
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------- fallback:
  // original container-scoring heuristic.
  function findContentRoot() {
    const semantic = [
      ...document.querySelectorAll(
        'article, [itemprop="articleBody"], [role="main"], main, ' +
        '.post-content, .article-content, .article-body, .entry-content, .story-body, #content'
      ),
    ];
    let best = null;
    let bestScore = 0;
    for (const el of semantic) {
      const score = textLen(el) * (1 - Math.min(linkDensity(el), 0.9));
      if (score > bestScore) { best = el; bestScore = score; }
    }
    if (best && bestScore >= 250) return best;

    for (const el of document.querySelectorAll('div, section, td')) {
      const score = textLen(el) * (1 - Math.min(linkDensity(el), 0.9));
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return best || document.body;
  }

  function isNoise(el) {
    const idClass = `${el.id} ${el.className && el.className.baseVal !== undefined ? '' : el.className}`;
    return NOISE_PATTERN.test(idClass) && textLen(el) < 200;
  }

  function cleanup(root) {
    for (const el of root.querySelectorAll(NOISE_SELECTORS)) el.remove();
    for (const el of [...root.querySelectorAll('div, section, ul, ol, span, p, a')]) {
      if (root.contains(el) && isNoise(el)) el.remove();
    }
    for (const el of root.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        if (!KEEP_ATTRS.has(attr.name)) el.removeAttribute(attr.name);
      }
    }
    for (const el of [...root.querySelectorAll('div, span, section, p')]) {
      if (!el.textContent.trim() && !el.querySelector('img')) el.remove();
    }
    return root;
  }

  function absolutizeInto(clone, original) {
    const origLinks = original.querySelectorAll('a[href]');
    const cloneLinks = clone.querySelectorAll('a[href]');
    for (let i = 0; i < cloneLinks.length && i < origLinks.length; i++) {
      cloneLinks[i].setAttribute('href', origLinks[i].href);
    }
    fixImagesInClone(clone, original);
  }

  function heuristicExtract() {
    const contentRoot = findContentRoot();
    const clone = contentRoot.cloneNode(true);
    absolutizeInto(clone, contentRoot);
    cleanup(clone);
    return {
      html: clone.innerHTML,
      textContent: clone.textContent.replace(/\s+/g, ' ').trim(),
      title: null, byline: null, siteName: null, excerpt: null,
    };
  }

  // ---------------------------------------------------------------- rescue:
  // stripped copy of the whole page for the server's LLM re-parse.
  function pageForLlm() {
    const html = document.body ? document.body.innerHTML : '';
    return html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(iframe|object|embed|link|meta)\b[^>]*>/gi, '')
      .replace(/\s{2,}/g, ' ')
      .slice(0, 400000);
  }

  // ---------------------------------------------------------------- run
  const best = readabilityExtract() || heuristicExtract();
  const textContent = best.textContent;

  // "Doesn't look like we parsed correctly": tiny result, or a small
  // fraction of what's visibly on the page.
  const pageTextLen = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().length;
  const suspect =
    textContent.length < 800 ||
    (pageTextLen > 3000 && textContent.length < pageTextLen * 0.25);

  const title =
    best.title ||
    meta('og:title') ||
    (document.querySelector('h1') && document.querySelector('h1').textContent.trim()) ||
    document.title;

  const byline =
    best.byline ||
    meta('author') ||
    meta('article:author') ||
    (document.querySelector('[rel="author"], .byline, .author-name') || {}).textContent ||
    null;

  // Returned by the IIFE → becomes the script's completion value,
  // which browser.tabs.executeScript hands back to background.js.
  let image = meta('og:image') || meta('og:image:url') || meta('twitter:image') || null;
  if (image) { try { image = new URL(image, location.href).href.slice(0, 2000); } catch (e) { image = null; } }

  // Original publish date from metadata / a <time datetime>.
  let published = meta('article:published_time') || meta('datePublished') ||
    (document.querySelector('meta[itemprop="datePublished"]') || {}).content ||
    (document.querySelector('time[datetime]') || {}).getAttribute?.('datetime') || null;
  if (published) { const t = Date.parse(published); published = (t > 0 && t < Date.now() + 86400000) ? t : null; }

  return {
    url: (meta('og:url') || location.href).split('#')[0],
    title: (title || location.href).trim().slice(0, 500),
    byline: byline ? byline.trim().replace(/\s+/g, ' ').slice(0, 200) : null,
    siteName: (best.siteName || meta('og:site_name') || location.hostname).trim().slice(0, 200),
    excerpt: (best.excerpt || meta('og:description') || meta('description') || textContent.slice(0, 300)).trim().slice(0, 500),
    image,
    publishedAt: published,
    html: best.html,
    textContent: textContent.slice(0, 200000),
    savedAt: Date.now(),
    fallbackHtml: suspect ? pageForLlm() : undefined,
  };
})();

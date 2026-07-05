/**
 * ReadLater article extractor — runs as a content script in the live page.
 *
 * Crucially, this reads the DOM *as currently rendered in your session*:
 * if you can see the article (logged in, past a metered paywall, after
 * client-side rendering), this captures it. It never re-fetches the URL.
 *
 * The file's completion value (the object below) is returned to the
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

  /** Pick the element most likely to contain the article body. */
  function findContentRoot() {
    // 1. Semantic candidates, best first.
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

    // 2. Heuristic scan: any container whose <p> children carry the most text.
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
    // Class/id based noise (only when it doesn't hold substantial article text).
    for (const el of [...root.querySelectorAll('div, section, ul, ol, span, p, a')]) {
      // root is a detached clone, so isConnected is useless here — use contains
      // to skip elements already dropped with a removed ancestor.
      if (root.contains(el) && isNoise(el)) el.remove();
    }
    // Strip attributes down to a whitelist; drop inline handlers/styles/trackers.
    for (const el of root.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        if (!KEEP_ATTRS.has(attr.name)) el.removeAttribute(attr.name);
      }
    }
    // Drop empty wrappers left behind.
    for (const el of [...root.querySelectorAll('div, span, section, p')]) {
      if (!el.textContent.trim() && !el.querySelector('img')) el.remove();
    }
    return root;
  }

  /** Resolve relative + lazy-loaded URLs on the ORIGINAL elements before cloning. */
  function absolutizeInto(clone, original) {
    const origLinks = original.querySelectorAll('a[href]');
    const cloneLinks = clone.querySelectorAll('a[href]');
    for (let i = 0; i < cloneLinks.length && i < origLinks.length; i++) {
      cloneLinks[i].setAttribute('href', origLinks[i].href); // .href is absolute
    }
    const origImgs = original.querySelectorAll('img');
    const cloneImgs = clone.querySelectorAll('img');
    for (let i = 0; i < cloneImgs.length && i < origImgs.length; i++) {
      const o = origImgs[i];
      const src =
        o.currentSrc ||
        o.src ||
        o.getAttribute('data-src') ||
        o.getAttribute('data-lazy-src') ||
        '';
      if (src) cloneImgs[i].setAttribute('src', new URL(src, location.href).href);
      cloneImgs[i].removeAttribute('srcset');
    }
  }

  const contentRoot = findContentRoot();
  const clone = contentRoot.cloneNode(true);
  absolutizeInto(clone, contentRoot);
  cleanup(clone);

  const textContent = clone.textContent.replace(/\s+/g, ' ').trim();

  const title =
    meta('og:title') ||
    (document.querySelector('h1') && document.querySelector('h1').textContent.trim()) ||
    document.title;

  const byline =
    meta('author') ||
    meta('article:author') ||
    (document.querySelector('[rel="author"], .byline, .author-name') || {}).textContent ||
    null;

  // Returned by the IIFE → becomes the script's completion value,
  // which browser.tabs.executeScript hands back to background.js.
  return {
    url: (meta('og:url') || location.href).split('#')[0],
    title: (title || location.href).trim().slice(0, 500),
    byline: byline ? byline.trim().replace(/\s+/g, ' ').slice(0, 200) : null,
    siteName: (meta('og:site_name') || location.hostname).trim().slice(0, 200),
    excerpt: (meta('og:description') || meta('description') || textContent.slice(0, 300)).trim().slice(0, 500),
    html: clone.innerHTML,
    textContent: textContent.slice(0, 200000),
    savedAt: Date.now(),
  };
})();

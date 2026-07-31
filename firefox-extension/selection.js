/**
 * ReadLater selection reader — runs as a content script in the live page.
 *
 * Backs "save highlight": grabs whatever the user has selected, plus just
 * enough page identity to hang the quote off. Deliberately does NOT extract
 * the article — saving a highlight is not a request to save the page.
 *
 * We read the selection from the DOM rather than taking the context menu's
 * `info.selectionText`, because that is truncated (and whitespace-collapsed)
 * for long selections — the exact case where the full quote matters most.
 *
 * The file's completion value is returned to the background script by
 * browser.tabs.executeScript().
 */
(() => {
  'use strict';

  function meta(name) {
    const el =
      document.querySelector(`meta[property="${name}"]`) ||
      document.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute('content') : null;
  }

  const sel = window.getSelection();
  const raw = sel ? sel.toString() : '';

  return {
    // Normalised exactly as extractor.js does it, so a highlight and a later
    // full save of the same page land on one article instead of two.
    url: (meta('og:url') || location.href).split('#')[0],
    title: (meta('og:title') || document.title || location.href).trim().slice(0, 500),
    siteName: (meta('og:site_name') || location.hostname).trim().slice(0, 200),
    // Collapse runs of spaces and blank lines but keep the line structure:
    // the server splits on newlines to rebuild the quote as paragraphs.
    text: raw
      .replace(/\r/g, '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 20000),
  };
})();

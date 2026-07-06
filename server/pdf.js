/**
 * PDF import: extract text from an uploaded PDF (Mozilla pdf.js) and shape it
 * into article paragraphs. Text-based PDFs only — scanned/image PDFs produce
 * no text and are rejected by the caller.
 */
'use strict';

const escapeText = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Returns {title, html, textContent, pages}. Throws on unparseable input.
 * Paragraphs are reconstructed per page by grouping text lines and splitting
 * where the vertical gap exceeds ~1.6 line heights.
 */
async function pdfToArticle(buf, filename) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const paras = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();

    // 1. merge runs into lines (same rounded baseline y)
    const lines = [];
    let line = null;
    for (const item of content.items) {
      const str = (item.str || '').trim();
      if (!str) continue;
      const y = Math.round(item.transform[5]);
      if (line && Math.abs(y - line.y) <= 2) {
        line.text += ' ' + str;
      } else {
        line = { y, text: str, height: item.height || 12 };
        lines.push(line);
      }
    }

    // 2. split lines into paragraphs on large vertical gaps
    let para = '';
    let prevY = null;
    let prevH = 12;
    for (const l of lines) {
      const gap = prevY === null ? 0 : prevY - l.y;
      if (prevY !== null && gap > Math.max(prevH, 8) * 1.6) {
        if (para.trim()) paras.push(para.trim());
        para = '';
      }
      // de-hyphenate words broken across lines
      para = para.endsWith('-') ? para.slice(0, -1) + l.text : `${para} ${l.text}`.trim();
      prevY = l.y;
      prevH = l.height || prevH;
    }
    if (para.trim()) paras.push(para.trim());
  }

  const meta = await doc.getMetadata().catch(() => null);
  const metaTitle = meta && meta.info && typeof meta.info.Title === 'string' ? meta.info.Title.trim() : '';
  const title = metaTitle || String(filename).replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() || 'PDF document';

  return {
    title,
    html: paras.map((p) => `<p>${escapeText(p)}</p>`).join('\n'),
    textContent: paras.join(' '),
    pages: doc.numPages,
  };
}

module.exports = { pdfToArticle };

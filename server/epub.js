/**
 * EPUB import: pull the readable text out of an uploaded .epub and shape it
 * into one article, the same way pdf.js does for PDFs.
 *
 * An EPUB is a ZIP holding XHTML documents plus a manifest. We read it with
 * zlib rather than a ZIP library: the format's directory structure is a few
 * dozen lines to walk, and this server ships its dependency list by hand in the
 * Dockerfile, so not adding one is worth the code.
 *
 * Text only. Images, fonts and CSS inside the archive are dropped — there is
 * nowhere to serve them from (articles store HTML, not assets), and a reader
 * page full of broken <img> is worse than none.
 */
'use strict';

const zlib = require('zlib');
const { parseHTML } = require('linkedom');

// ------------------------------------------------------------------ ZIP

const EOCD_SIG = 0x06054b50; // end of central directory
const CD_SIG = 0x02014b50;   // central directory file header
const LOCAL_SIG = 0x04034b50; // local file header

/**
 * Index a ZIP archive: name → {offset, method, compressedSize}. Reads the
 * central directory (authoritative), not the local headers, whose sizes may be
 * zero when a data descriptor was used.
 */
function readZipIndex(buf) {
  // The EOCD sits at the very end, after a comment of up to 64KB. Scan back for
  // its signature rather than assuming no comment.
  let eocd = -1;
  const from = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-directory record)');

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64 parks 0xffffffff here and puts the real values in a separate record.
  // Books that large are not a case worth carrying code for; say so plainly.
  if (cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== CD_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.size) throw new Error('ZIP archive is empty');
  return entries;
}

// A chapter of prose is tens of KB. This is far above any real one, and low
// enough that a deflate bomb (a few KB claiming to expand to gigabytes) fails
// as a 400 instead of taking the process out — the server has 512MB and no
// worker threads to lose.
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

// Ceiling on the extracted text of a whole book, ~5x the longest novels.
const MAX_TEXT_CHARS = 16 * 1024 * 1024;

/** Decompress one indexed entry. Supports stored (0) and deflate (8). */
function readZipEntry(buf, entry) {
  const { localOffset, method, compressedSize } = entry;
  if (localOffset + 30 > buf.length) throw new Error('corrupt ZIP entry offset');
  if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error('corrupt ZIP entry header');
  // The local header repeats the name/extra with its OWN lengths — the extra
  // field routinely differs from the central directory's, so the data offset
  // must be computed from these, not from the central copy.
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + compressedSize);
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
  throw new Error(`unsupported ZIP compression method ${method}`);
}

// ----------------------------------------------------------------- EPUB

/** Resolve an href from the OPF against the OPF's own directory, ZIP-style. */
function resolveHref(base, href) {
  const clean = decodeURIComponent(String(href).split('#')[0].trim());
  if (!clean) return '';
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
  const parts = (dir + clean).split('/');
  const out = [];
  for (const seg of parts) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

const tagText = (xml, tag) => {
  const m = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i').exec(xml);
  return m ? m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '';
};

/**
 * Reading order: the spine's idrefs mapped through the manifest. This is the
 * order the book is meant to be read in, which is not the order entries happen
 * to sit in the archive.
 */
function spineDocuments(opfXml, opfPath) {
  const manifest = new Map();
  for (const m of opfXml.matchAll(/<(?:\w+:)?item\b([^>]*)>/gi)) {
    const attrs = m[1];
    const id = /\bid\s*=\s*["']([^"']*)["']/i.exec(attrs);
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(attrs);
    const type = /\bmedia-type\s*=\s*["']([^"']*)["']/i.exec(attrs);
    if (id && href) manifest.set(id[1], { href: href[1], type: type ? type[1] : '' });
  }

  const docs = [];
  const spine = /<(?:\w+:)?spine\b[^>]*>([\s\S]*?)<\/(?:\w+:)?spine>/i.exec(opfXml);
  for (const m of (spine ? spine[1] : '').matchAll(/<(?:\w+:)?itemref\b([^>]*)>/gi)) {
    const idref = /\bidref\s*=\s*["']([^"']*)["']/i.exec(m[1]);
    const item = idref && manifest.get(idref[1]);
    // Skip the cover image and any non-XHTML resource that slipped into the spine.
    if (item && !/image|css|font/i.test(item.type)) docs.push(resolveHref(opfPath, item.href));
  }
  // A malformed spine shouldn't mean an empty book: fall back to every XHTML
  // document in the manifest, in manifest order.
  if (!docs.length) {
    for (const item of manifest.values()) {
      if (/xhtml|html/i.test(item.type)) docs.push(resolveHref(opfPath, item.href));
    }
  }
  return docs;
}

const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, dd, dt, figcaption';

/**
 * One XHTML document → article HTML. Headings stay headings (they are the
 * chapter titles, and the reader shows them), everything else becomes a
 * paragraph. Nested blocks are skipped so a <blockquote><p> isn't emitted twice.
 */
function documentToParagraphs(xhtml) {
  const { document } = parseHTML(xhtml);
  for (const el of document.querySelectorAll('script, style, svg, nav, head')) el.remove();
  const body = document.querySelector('body') || document;

  const out = [];
  for (const el of body.querySelectorAll(BLOCKS)) {
    if (el.parentElement && el.parentElement.closest(BLOCKS)) continue; // inner block
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const tag = el.tagName.toLowerCase();
    // h1 is the article's own title; demote so a book's chapter titles don't
    // each render as a second page title.
    const heading = /^h[1-6]$/.test(tag) ? (tag === 'h1' ? 'h2' : tag) : '';
    out.push({ tag: heading || 'p', text });
  }
  if (out.length) return out;

  // Nothing matched, but the chapter may still hold text: some books (converted
  // ones especially) set every paragraph as a <div>. Take the innermost divs
  // that carry text, and failing that the body as one block, rather than
  // dropping the chapter.
  for (const el of body.querySelectorAll('div')) {
    if (el.querySelector('div')) continue; // outer wrapper
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) out.push({ tag: 'p', text });
  }
  if (out.length) return out;

  const all = (body.textContent || '').replace(/\s+/g, ' ').trim();
  return all ? [{ tag: 'p', text: all }] : [];
}

const escapeText = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Returns {title, byline, html, textContent, chapters}. Throws on anything that
 * isn't a readable EPUB.
 */
async function epubToArticle(buf, filename) {
  const zip = readZipIndex(buf);
  const text = (name) => {
    const entry = zip.get(name);
    if (!entry) throw new Error(`missing ${name}`);
    return readZipEntry(buf, entry).toString('utf8');
  };

  const container = text('META-INF/container.xml');
  const rootfile = /<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i.exec(container);
  if (!rootfile) throw new Error('no rootfile in META-INF/container.xml');
  const opfPath = decodeURIComponent(rootfile[1]);
  const opf = text(opfPath);

  const paras = [];
  let chapters = 0;
  let chars = 0;
  for (const href of spineDocuments(opf, opfPath)) {
    const entry = zip.get(href);
    if (!entry) continue; // manifest can point at files that aren't there
    let blocks;
    try {
      blocks = documentToParagraphs(readZipEntry(buf, entry).toString('utf8'));
    } catch (e) {
      // One unreadable chapter shouldn't lose the rest of the book — but a
      // chapter that blew the size limit is not a damaged file, it's a refusal,
      // and swallowing it would report the book as simply having no text.
      if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength|too large/i.test(e.message || ''))) {
        throw new Error('a chapter in this file expands far beyond any real book (corrupt or malicious archive)');
      }
      continue;
    }
    if (blocks.length) chapters++;
    paras.push(...blocks);
    // Stop rather than truncate silently: half a book filed as if it were the
    // whole one is a worse outcome than a refusal that says why. War and Peace
    // is ~3.2M characters, so this only trips on something pathological.
    chars += blocks.reduce((n, b) => n + b.text.length, 0);
    if (chars > MAX_TEXT_CHARS) {
      throw new Error(`book is larger than this importer handles (over ${Math.round(MAX_TEXT_CHARS / 1e6)}M characters)`);
    }
  }

  const metaTitle = tagText(opf, 'title');
  const author = tagText(opf, 'creator');
  const title = metaTitle
    || String(filename).replace(/\.epub$/i, '').replace(/[_-]+/g, ' ').trim()
    || 'EPUB book';

  return {
    title,
    byline: author || null,
    html: paras.map((p) => `<${p.tag}>${escapeText(p.text)}</${p.tag}>`).join('\n'),
    textContent: paras.map((p) => p.text).join(' '),
    chapters,
  };
}

module.exports = { epubToArticle };

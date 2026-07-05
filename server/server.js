#!/usr/bin/env node
/**
 * ReadLater sync server — zero-dependency Node.js (>=18).
 *
 * Stores articles + highlights pushed by the Firefox extension and serves
 * them to the Android app. Data lives in a single JSON file next to this
 * script (override with READLATER_DATA_DIR).
 *
 * Auth: every /api request must send  Authorization: Bearer <token>.
 * The token is read from READLATER_TOKEN, or auto-generated on first run
 * and stored in <data dir>/token.txt.
 *
 * Run:  node server.js            (listens on 0.0.0.0:8090, override PORT)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8090', 10);
const DATA_DIR = process.env.READLATER_DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TOKEN_FILE = path.join(DATA_DIR, 'token.txt');
const MAX_BODY = 10 * 1024 * 1024; // 10 MB per request

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- token
let TOKEN = process.env.READLATER_TOKEN || '';
if (!TOKEN) {
  if (fs.existsSync(TOKEN_FILE)) {
    TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } else {
    TOKEN = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(TOKEN_FILE, TOKEN + '\n', { mode: 0o600 });
  }
}

// ---------------------------------------------------------------- storage
let db = { articles: [], highlights: [] };
if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.articles = db.articles || [];
    db.highlights = db.highlights || [];
  } catch (e) {
    console.error(`Could not parse ${DB_FILE}: ${e.message} — starting empty (old file backed up)`);
    fs.copyFileSync(DB_FILE, DB_FILE + '.corrupt.' + Date.now());
  }
}

let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  }, 250);
}
process.on('SIGINT', () => { flushSync(); process.exit(0); });
process.on('SIGTERM', () => { flushSync(); process.exit(0); });
function flushSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

const newId = () => crypto.randomBytes(8).toString('hex');

// ---------------------------------------------------------------- helpers
function articleMeta(a) {
  const { html, textContent, ...meta } = a;
  return meta;
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sanitizeString(v, max = 2000) {
  if (typeof v !== 'string') return null;
  return v.slice(0, max);
}

// ---------------------------------------------------------------- routing
const server = http.createServer(async (req, res) => {
  // CORS — the Firefox extension posts from arbitrary page origins.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','articles','abc']

  if (parts[0] !== 'api') return json(res, 404, { error: 'not found' });

  // auth
  const auth = req.headers.authorization || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const ok = presented.length === TOKEN.length &&
    crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(TOKEN));
  if (!ok) return json(res, 401, { error: 'unauthorized' });

  try {
    // ---- health
    if (req.method === 'GET' && parts[1] === 'health') {
      return json(res, 200, { ok: true, articles: db.articles.length, highlights: db.highlights.length });
    }

    // ---- articles collection
    if (parts[1] === 'articles' && parts.length === 2) {
      if (req.method === 'GET') {
        const includeArchived = url.searchParams.get('includeArchived') === '1';
        const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
        let list = db.articles;
        if (!includeArchived) list = list.filter((a) => !a.archived);
        if (since) list = list.filter((a) => a.updatedAt > since);
        list = [...list].sort((a, b) => b.savedAt - a.savedAt);
        return json(res, 200, { articles: list.map(articleMeta) });
      }
      if (req.method === 'POST') {
        const b = JSON.parse(await readBody(req) || '{}');
        const artUrl = sanitizeString(b.url);
        const html = typeof b.html === 'string' ? b.html : '';
        if (!artUrl || !html) return json(res, 400, { error: 'url and html are required' });
        const now = Date.now();
        let a = db.articles.find((x) => x.url === artUrl);
        if (!a) {
          a = { id: newId(), url: artUrl, savedAt: b.savedAt || now, archived: false, favorite: false, readParagraph: 0 };
          db.articles.push(a);
        }
        a.title = sanitizeString(b.title) || artUrl;
        a.byline = sanitizeString(b.byline);
        a.siteName = sanitizeString(b.siteName);
        a.excerpt = sanitizeString(b.excerpt);
        a.html = html;
        a.textContent = typeof b.textContent === 'string' ? b.textContent : null;
        a.updatedAt = now;
        persist();
        return json(res, 201, a);
      }
    }

    // ---- single article
    if (parts[1] === 'articles' && parts.length === 3) {
      const a = db.articles.find((x) => x.id === parts[2]);
      if (!a) return json(res, 404, { error: 'article not found' });
      if (req.method === 'GET') return json(res, 200, a);
      if (req.method === 'PATCH') {
        const b = JSON.parse(await readBody(req) || '{}');
        if (typeof b.archived === 'boolean') a.archived = b.archived;
        if (typeof b.favorite === 'boolean') a.favorite = b.favorite;
        if (Number.isInteger(b.readParagraph) && b.readParagraph >= 0) a.readParagraph = b.readParagraph;
        a.updatedAt = Date.now();
        persist();
        return json(res, 200, articleMeta(a));
      }
      if (req.method === 'DELETE') {
        db.articles = db.articles.filter((x) => x.id !== a.id);
        db.highlights = db.highlights.filter((h) => h.articleId !== a.id);
        persist();
        return json(res, 200, { ok: true });
      }
    }

    // ---- highlights nested under an article
    if (parts[1] === 'articles' && parts.length === 4 && parts[3] === 'highlights') {
      const a = db.articles.find((x) => x.id === parts[2]);
      if (!a) return json(res, 404, { error: 'article not found' });
      if (req.method === 'GET') {
        return json(res, 200, { highlights: db.highlights.filter((h) => h.articleId === a.id) });
      }
      if (req.method === 'POST') {
        const b = JSON.parse(await readBody(req) || '{}');
        const text = sanitizeString(b.text, 20000);
        if (!text) return json(res, 400, { error: 'text is required' });
        if (b.clientId) {
          const dup = db.highlights.find((h) => h.clientId === b.clientId);
          if (dup) return json(res, 200, dup);
        }
        const h = {
          id: newId(),
          clientId: sanitizeString(b.clientId) || null,
          articleId: a.id,
          text,
          note: sanitizeString(b.note, 20000),
          paragraphIndex: Number.isInteger(b.paragraphIndex) ? b.paragraphIndex : null,
          createdAt: b.createdAt || Date.now(),
        };
        db.highlights.push(h);
        persist();
        return json(res, 201, h);
      }
    }

    // ---- highlights collection / export / delete
    if (parts[1] === 'highlights') {
      if (req.method === 'GET' && parts.length === 2) {
        const withArticle = db.highlights.map((h) => {
          const a = db.articles.find((x) => x.id === h.articleId);
          return { ...h, articleTitle: a ? a.title : null, articleUrl: a ? a.url : null };
        });
        return json(res, 200, { highlights: withArticle });
      }
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'export.md') {
        const byArticle = new Map();
        for (const h of db.highlights) {
          if (!byArticle.has(h.articleId)) byArticle.set(h.articleId, []);
          byArticle.get(h.articleId).push(h);
        }
        let md = '# Highlights\n';
        for (const [articleId, hs] of byArticle) {
          const a = db.articles.find((x) => x.id === articleId);
          md += `\n## ${a ? a.title : 'Unknown article'}\n`;
          if (a) md += `${a.url}\n`;
          for (const h of hs.sort((x, y) => x.createdAt - y.createdAt)) {
            md += `\n> ${h.text.replace(/\n/g, '\n> ')}\n`;
            if (h.note) md += `\n${h.note}\n`;
          }
        }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        return res.end(md);
      }
      if (req.method === 'DELETE' && parts.length === 3) {
        const before = db.highlights.length;
        db.highlights = db.highlights.filter((h) => h.id !== parts[2]);
        if (db.highlights.length === before) return json(res, 404, { error: 'highlight not found' });
        persist();
        return json(res, 200, { ok: true });
      }
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    if (e instanceof SyntaxError) return json(res, 400, { error: 'invalid JSON body' });
    console.error(e);
    return json(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`ReadLater server listening on http://0.0.0.0:${PORT}`);
  console.log(`API token: ${TOKEN}`);
  console.log('Configure this URL + token in the Firefox extension and the Android app.');
});

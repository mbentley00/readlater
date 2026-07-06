#!/usr/bin/env node
/**
 * ReadLater sync server — Node.js (>=18) + SQLite (better-sqlite3, FTS5).
 *
 * Stores articles + highlights pushed by the Firefox extension and serves
 * them to the Android app and to a built-in web reader. Data lives in
 * <data dir>/readlater.db (override the directory with READLATER_DATA_DIR).
 * A legacy JSON store (db.json) is imported automatically on first start.
 *
 * Accounts: users sign up at /signup (disable with READLATER_ALLOW_SIGNUP=0).
 * Every account has its own API token (shown on /settings) for the Firefox
 * extension and Android app, its own private email-in alias, and its own
 * articles/highlights.
 *
 * Auth: /api requests send  Authorization: Bearer <token>  (or, from the
 * web UI, the session cookie). Legacy single-token deployments: the token
 * from READLATER_TOKEN / <data dir>/token.txt is adopted as the API token
 * of the FIRST account created, along with any pre-account articles.
 *
 * Run:  node server.js            (listens on 0.0.0.0:8090, override PORT)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const web = require('./web');
const { open, hostOf } = require('./db');
const llm = require('./llm');
const pdf = require('./pdf');

const PORT = parseInt(process.env.PORT || '8090', 10);
const DATA_DIR = process.env.READLATER_DATA_DIR || path.join(__dirname, 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'token.txt');
const APK_FILE = path.join(DATA_DIR, 'app.apk');
const MAX_BODY = 10 * 1024 * 1024; // 10 MB per request
const ALLOW_SIGNUP = process.env.READLATER_ALLOW_SIGNUP !== '0';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
// Email-to-save (optional): an inbound-email provider (e.g. Postmark) POSTs
// parsed messages to /api/inbound-email?secret=<READLATER_INBOUND_SECRET>.
// READLATER_INBOUND_DOMAIN (e.g. in.example.com) is what Settings displays
// after each account's private alias.
const INBOUND_SECRET = process.env.READLATER_INBOUND_SECRET || '';
const INBOUND_DOMAIN = process.env.READLATER_INBOUND_DOMAIN || '';

fs.mkdirSync(DATA_DIR, { recursive: true });

// Legacy single-token installs: this token is adopted by the first account.
let LEGACY_TOKEN = process.env.READLATER_TOKEN || '';
if (!LEGACY_TOKEN && fs.existsSync(TOKEN_FILE)) {
  LEGACY_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
}

// ---------------------------------------------------------------- storage
const store = open(DATA_DIR);
store.pruneSessions(Date.now());
process.on('SIGINT', () => { store.close(); process.exit(0); });
process.on('SIGTERM', () => { store.close(); process.exit(0); });

const newId = () => crypto.randomBytes(8).toString('hex');

const newEmailAlias = (username) =>
  `${String(username).toLowerCase()}-${crypto.randomBytes(3).toString('hex')}`;

// ---------------------------------------------------------------- accounts
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(stored, password) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

function findUserByToken(token) {
  if (!token) return null;
  const presented = sha256(token);
  let found = null;
  for (const u of store.allUsers()) {
    if (crypto.timingSafeEqual(presented, sha256(u.token))) found = u;
  }
  return found;
}

const findUserByName = (username) => store.userByName(username);

/** Returns {user} or {error}. The first account adopts the legacy token and any pre-account data. */
function createUser(username, password) {
  if (!/^[a-zA-Z0-9_-]{3,32}$/.test(String(username || ''))) {
    return { error: 'username must be 3-32 characters: letters, digits, - or _' };
  }
  if (typeof password !== 'string' || password.length < 8) {
    return { error: 'password must be at least 8 characters' };
  }
  if (store.userByName(username)) return { error: 'that username is taken' };
  const first = store.userCount() === 0;
  const user = {
    id: newId(),
    username: String(username),
    passwordHash: hashPassword(password),
    token: (first && LEGACY_TOKEN) || crypto.randomBytes(24).toString('hex'),
    emailAlias: newEmailAlias(username),
    createdAt: Date.now(),
  };
  store.insertUser(user);
  if (first) store.adoptOrphans(user.id);
  return { user };
}

// ---------------------------------------------------------------- sessions
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(userId) {
  const sid = crypto.randomBytes(32).toString('base64url');
  store.putSession(sid, userId, Date.now() + SESSION_TTL);
  return sid;
}

function sessionCookie(sid, req, { clear = false } = {}) {
  const attrs = [
    `rl_sid=${clear ? '' : sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${clear ? 0 : Math.floor(SESSION_TTL / 1000)}`,
  ];
  if (isHttps(req)) attrs.push('Secure');
  return attrs.join('; ');
}

function getSessionUser(req) {
  const sid = parseCookies(req).rl_sid;
  if (!sid) return null;
  const s = store.getSession(sid);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { store.deleteSession(sid); return null; }
  return store.userById(s.userId);
}

function destroySession(req) {
  const sid = parseCookies(req).rl_sid;
  if (sid) store.deleteSession(sid);
}

// ---------------------------------------------------------------- helpers
function pubArticleMeta(a) {
  const { html, textContent, userId, domain, ...meta } = a;
  return meta;
}
function pubArticle(a) {
  const { userId, domain, ...pub } = a;
  return pub;
}
function pubHighlight(h) {
  const { userId, ...pub } = h;
  return pub;
}

const searchArticles = (user, opts) => store.searchArticles(user.id, opts);

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return readBodyBuffer(req, MAX_BODY).then((b) => b.toString('utf8'));
}

function readBodyBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parses a JSON or application/x-www-form-urlencoded body into a plain object. */
function parseBody(raw, contentType) {
  if ((contentType || '').includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return JSON.parse(raw || '{}');
}

function sanitizeString(v, max = 2000) {
  if (typeof v !== 'string') return null;
  return v.slice(0, max);
}

const escapeText = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Best-effort cleanup of email HTML (extension-saved articles are cleaned in
 * the browser; email bodies arrive raw). Defense in depth only — clients
 * render stored HTML under a strict CSP (web) or via a text parser (Android).
 */
function sanitizeEmailHtml(html) {
  return String(html)
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(iframe|object|embed|form|link|meta|base)\b[^>]*>/gi, '')
    .replace(/<\/(iframe|object|embed|form)\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi, '$1="#"');
}

// ---------------------------------------------------------------- routing
const ctx = {
  store, newId, sanitizeString, readBody, parseBody,
  createUser, verifyPassword, findUserByName, newEmailAlias,
  createSession, sessionCookie, getSessionUser, destroySession,
  searchArticles, hostOf,
  ALLOW_SIGNUP, INBOUND_DOMAIN, APK_FILE,
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','articles','abc']

  try {
    if (parts[0] !== 'api') return await web.handle(ctx, req, res, url);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    return res.end('internal error');
  }

  // CORS — the Firefox extension posts from arbitrary page origins.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ---- inbound email webhook (Postmark-style JSON) — shared-secret auth,
  // routed to an account by the recipient alias. Always 200 for delivered
  // mail we choose to drop, so the provider doesn't retry or bounce.
  if (req.method === 'POST' && parts[1] === 'inbound-email' && parts.length === 2) {
    if (!INBOUND_SECRET) return json(res, 404, { error: 'inbound email not configured' });
    const given = url.searchParams.get('secret') || '';
    if (!given || !crypto.timingSafeEqual(sha256(given), sha256(INBOUND_SECRET))) {
      return json(res, 403, { error: 'bad secret' });
    }
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const candidates = [];
      for (const field of ['ToFull', 'CcFull', 'BccFull']) {
        for (const t of Array.isArray(b[field]) ? b[field] : []) {
          if (t && t.Email) candidates.push(String(t.Email));
        }
      }
      if (b.OriginalRecipient) candidates.push(String(b.OriginalRecipient));
      let target = null;
      for (const c of candidates) {
        target = store.userByAlias(c.toLowerCase().split('@')[0]);
        if (target) break;
      }
      if (!target) return json(res, 200, { ok: true, dropped: 'unknown recipient' });

      // idempotent per message: providers may retry delivery
      const msgId = sanitizeString(b.MessageID) ||
        crypto.createHash('sha256').update(`${b.From}|${b.Subject}|${b.Date}`).digest('hex').slice(0, 24);
      const artUrl = `email:${msgId}`;
      let a = store.articleByUrl(target.id, artUrl);
      if (!a) {
        const text = typeof b.TextBody === 'string' ? b.TextBody : '';
        const html = typeof b.HtmlBody === 'string' && b.HtmlBody.trim()
          ? sanitizeEmailHtml(b.HtmlBody)
          : `<pre>${escapeText(text)}</pre>`;
        const from = (b.FromFull && (b.FromFull.Name || b.FromFull.Email)) || b.From || null;
        a = {
          id: newId(),
          userId: target.id,
          url: artUrl,
          savedAt: Date.parse(b.Date) || Date.now(),
          archived: false, favorite: false, readParagraph: 0,
          title: sanitizeString(b.Subject) || '(no subject)',
          byline: sanitizeString(from),
          siteName: 'Email',
          excerpt: sanitizeString(text.replace(/\s+/g, ' ').trim(), 300),
          html,
          textContent: text ? text.slice(0, 200000) : null,
          updatedAt: Date.now(),
        };
        store.insertArticle(a);
      }
      return json(res, 200, { ok: true, id: a.id });
    } catch (e) {
      if (e instanceof SyntaxError) return json(res, 400, { error: 'invalid JSON body' });
      console.error(e);
      return json(res, 500, { error: 'internal error' });
    }
  }

  // ---- login: exchange username/password for the account's API token, so
  // devices can sign in without the user hand-copying the token.
  if (req.method === 'POST' && parts[1] === 'login' && parts.length === 2) {
    try {
      const b = parseBody(await readBody(req), req.headers['content-type']);
      const u = findUserByName(String(b.username || '').trim());
      if (!u || !verifyPassword(u.passwordHash, String(b.password || ''))) {
        await new Promise((r) => setTimeout(r, 300));
        return json(res, 401, { error: 'wrong username or password' });
      }
      return json(res, 200, {
        token: u.token,
        username: u.username,
        emailAddress: INBOUND_DOMAIN ? `${u.emailAlias}@${INBOUND_DOMAIN}` : null,
      });
    } catch (e) {
      if (e instanceof SyntaxError) return json(res, 400, { error: 'invalid JSON body' });
      throw e;
    }
  }

  // auth: bearer token (devices) or session cookie (web UI)
  const auth = req.headers.authorization || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const user = presented ? findUserByToken(presented) : getSessionUser(req);
  if (!user) return json(res, 401, { error: 'unauthorized' });

  try {
    // ---- health
    if (req.method === 'GET' && parts[1] === 'health') {
      return json(res, 200, {
        ok: true,
        articles: store.articleCount(user.id),
        highlights: store.highlightCount(user.id),
      });
    }

    // ---- full-account export (articles incl. HTML + all highlights)
    if (req.method === 'GET' && parts[1] === 'export.json' && parts.length === 2) {
      const body = JSON.stringify({
        exportedAt: Date.now(),
        username: user.username,
        ...store.exportUser(user.id),
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Content-Disposition': 'attachment; filename="readlater-export.json"',
      });
      return res.end(body);
    }

    // ---- Android APK hosting: POST uploads a build (streamed to the data
    // dir, so it survives deploys); the web UI serves it at GET /app.apk.
    if (req.method === 'POST' && parts[1] === 'app.apk' && parts.length === 2) {
      const tmp = APK_FILE + '.tmp';
      const out = fs.createWriteStream(tmp);
      let size = 0;
      await new Promise((resolve, reject) => {
        req.on('data', (c) => {
          size += c.length;
          if (size > 200 * 1024 * 1024) { reject(new Error('apk too large')); req.destroy(); }
        });
        req.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        req.pipe(out);
      });
      fs.renameSync(tmp, APK_FILE);
      return json(res, 201, { ok: true, size });
    }

    // ---- current account
    if (req.method === 'GET' && parts[1] === 'me' && parts.length === 2) {
      return json(res, 200, {
        username: user.username,
        token: user.token,
        emailAddress: INBOUND_DOMAIN ? `${user.emailAlias}@${INBOUND_DOMAIN}` : null,
        createdAt: user.createdAt,
      });
    }

    // ---- articles collection
    if (parts[1] === 'articles' && parts.length === 2) {
      if (req.method === 'GET') {
        const num = (k) => parseInt(url.searchParams.get(k) || '0', 10) || 0;
        const list = searchArticles(user, {
          includeArchived: url.searchParams.get('includeArchived') === '1',
          since: num('since'),
          q: url.searchParams.get('q') || '',
          domain: url.searchParams.get('domain') || '',
          highlighted: url.searchParams.get('highlighted') === '1',
          minWords: num('minWords'),
          maxWords: num('maxWords'),
          minHighlights: num('minHighlights'),
        });
        return json(res, 200, { articles: list.map(pubArticleMeta) });
      }
      if (req.method === 'POST') {
        const b = parseBody(await readBody(req), req.headers['content-type']);
        const artUrl = sanitizeString(b.url);
        const html = typeof b.html === 'string' ? b.html : '';
        if (!artUrl || !html) return json(res, 400, { error: 'url and html are required' });
        const now = Date.now();
        const fields = {
          title: sanitizeString(b.title) || artUrl,
          byline: sanitizeString(b.byline),
          siteName: sanitizeString(b.siteName),
          excerpt: sanitizeString(b.excerpt),
          html,
          textContent: typeof b.textContent === 'string' ? b.textContent : null,
          updatedAt: now,
        };
        let a = store.articleByUrl(user.id, artUrl);
        if (a) {
          store.updateArticleContent(a.id, fields);
        } else {
          a = {
            id: newId(), userId: user.id, url: artUrl,
            savedAt: b.savedAt || now, archived: false, favorite: false, readParagraph: 0,
            ...fields,
          };
          store.insertArticle(a);
        }

        // LLM rescue: the extension flags saves it thinks it parsed badly by
        // attaching the stripped page HTML. Respond fast with what we have,
        // upgrade the stored article in the background (bumping updatedAt so
        // clients re-sync it).
        if (typeof b.fallbackHtml === 'string' && b.fallbackHtml.length > 0 && llm.enabled()) {
          const articleId = a.id;
          llm.extractArticle({ url: artUrl, title: fields.title, pageHtml: b.fallbackHtml })
            .then((better) => {
              if (!better) return;
              const current = store.getArticle(articleId, user.id);
              if (!current) return; // deleted in the meantime
              // Only upgrade if the LLM actually found more than we had.
              const currentLen = (current.textContent || '').length;
              if (better.textContent.length <= currentLen * 1.5 && currentLen > 800) return;
              store.updateArticleContent(articleId, {
                title: current.title,
                byline: current.byline,
                siteName: current.siteName,
                excerpt: current.excerpt || better.textContent.slice(0, 300),
                html: better.html,
                textContent: better.textContent,
                updatedAt: Date.now(),
              });
              console.log(`LLM rescue upgraded article ${articleId} (${currentLen} → ${better.textContent.length} chars)`);
            })
            .catch((e) => console.error(`LLM rescue failed for ${articleId}: ${e.message}`));
        }

        return json(res, 201, pubArticle(store.getArticle(a.id, user.id)));
      }
    }

    // ---- single article
    if (parts[1] === 'articles' && parts.length === 3) {
      const a = store.getArticle(parts[2], user.id);
      if (!a) return json(res, 404, { error: 'article not found' });
      if (req.method === 'GET') return json(res, 200, pubArticle(a));
      if (req.method === 'PATCH') {
        const b = parseBody(await readBody(req), req.headers['content-type']);
        store.patchArticle(a.id, {
          archived: typeof b.archived === 'boolean' ? b.archived : undefined,
          favorite: typeof b.favorite === 'boolean' ? b.favorite : undefined,
          readParagraph: b.readParagraph,
          updatedAt: Date.now(),
        });
        return json(res, 200, pubArticleMeta(store.getArticle(a.id, user.id)));
      }
      if (req.method === 'DELETE') {
        store.deleteArticle(a.id);
        return json(res, 200, { ok: true });
      }
    }

    // ---- highlights nested under an article
    if (parts[1] === 'articles' && parts.length === 4 && parts[3] === 'highlights') {
      const a = store.getArticle(parts[2], user.id);
      if (!a) return json(res, 404, { error: 'article not found' });
      if (req.method === 'GET') {
        return json(res, 200, { highlights: store.highlightsForArticle(a.id).map(pubHighlight) });
      }
      if (req.method === 'POST') {
        const b = parseBody(await readBody(req), req.headers['content-type']);
        const text = sanitizeString(b.text, 20000);
        if (!text) return json(res, 400, { error: 'text is required' });
        if (b.clientId) {
          const dup = store.highlightByClientId(user.id, sanitizeString(b.clientId));
          if (dup) return json(res, 200, pubHighlight(dup));
        }
        const h = {
          id: newId(),
          userId: user.id,
          clientId: sanitizeString(b.clientId) || null,
          articleId: a.id,
          text,
          note: sanitizeString(b.note, 20000),
          paragraphIndex: Number.isInteger(b.paragraphIndex) ? b.paragraphIndex : null,
          createdAt: b.createdAt || Date.now(),
        };
        store.insertHighlight(h);
        return json(res, 201, pubHighlight(h));
      }
    }

    // ---- PDF import: raw application/pdf body, parsed into an article
    if (req.method === 'POST' && parts[1] === 'import' && parts[2] === 'pdf' && parts.length === 3) {
      const buf = await readBodyBuffer(req, 50 * 1024 * 1024);
      if (buf.length < 5 || buf.subarray(0, 5).toString() !== '%PDF-') {
        return json(res, 400, { error: 'not a PDF file' });
      }
      const filename = sanitizeString(url.searchParams.get('filename'), 200) || 'document.pdf';
      let parsed;
      try {
        parsed = await pdf.pdfToArticle(buf, filename);
      } catch (e) {
        return json(res, 400, { error: `could not parse PDF: ${e.message}` });
      }
      if (!parsed.textContent.trim()) {
        return json(res, 400, { error: 'no extractable text (scanned/image-only PDF?)' });
      }
      // dedupe on content hash so re-importing the same file updates in place
      const artUrl = 'pdf:' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24);
      const now = Date.now();
      let a = store.articleByUrl(user.id, artUrl);
      const fields = {
        title: sanitizeString(parsed.title) || filename,
        byline: null,
        siteName: 'PDF',
        excerpt: sanitizeString(parsed.textContent.replace(/\s+/g, ' ').trim(), 300),
        html: parsed.html,
        textContent: parsed.textContent.slice(0, 500000),
        updatedAt: now,
      };
      if (a) {
        store.updateArticleContent(a.id, fields);
      } else {
        a = {
          id: newId(), userId: user.id, url: artUrl,
          savedAt: now, archived: false, favorite: false, readParagraph: 0,
          ...fields,
        };
        store.insertArticle(a);
      }
      return json(res, 201, pubArticle(store.getArticle(a.id, user.id)));
    }

    // ---- saved views (named filter sets shown as tabs in the clients)
    if (parts[1] === 'views') {
      if (req.method === 'GET' && parts.length === 2) {
        return json(res, 200, { views: store.listViews(user.id).map(({ userId, ...v }) => v) });
      }
      if (req.method === 'POST' && parts.length === 2) {
        const b = parseBody(await readBody(req), req.headers['content-type']);
        const name = sanitizeString(b.name, 64);
        if (!name || !name.trim()) return json(res, 400, { error: 'name is required' });
        const f = b.filters && typeof b.filters === 'object' ? b.filters : {};
        const filters = {
          q: sanitizeString(f.q, 200) || '',
          domain: sanitizeString(f.domain, 200) || '',
          highlighted: f.highlighted === true,
          minWords: Number.isInteger(f.minWords) && f.minWords > 0 ? f.minWords : 0,
          maxWords: Number.isInteger(f.maxWords) && f.maxWords > 0 ? f.maxWords : 0,
          minHighlights: Number.isInteger(f.minHighlights) && f.minHighlights > 0 ? f.minHighlights : 0,
          includeArchived: f.includeArchived === true,
        };
        const v = { id: newId(), userId: user.id, name: name.trim(), filters, createdAt: Date.now() };
        store.insertView(v);
        return json(res, 201, { id: v.id, name: v.name, filters: v.filters, createdAt: v.createdAt });
      }
      if (req.method === 'DELETE' && parts.length === 3) {
        const { changes } = store.deleteView(parts[2], user.id);
        if (!changes) return json(res, 404, { error: 'view not found' });
        return json(res, 200, { ok: true });
      }
    }

    // ---- highlights collection / export / delete
    if (parts[1] === 'highlights') {
      if (req.method === 'GET' && parts.length === 2) {
        return json(res, 200, { highlights: store.highlightsForUser(user.id).map(pubHighlight) });
      }
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'export.md') {
        const byArticle = new Map();
        for (const h of store.highlightsForUser(user.id)) {
          if (!byArticle.has(h.articleId)) byArticle.set(h.articleId, []);
          byArticle.get(h.articleId).push(h);
        }
        let md = '# Highlights\n';
        for (const hs of byArticle.values()) {
          md += `\n## ${hs[0].articleTitle || 'Unknown article'}\n`;
          if (hs[0].articleUrl) md += `${hs[0].articleUrl}\n`;
          for (const h of hs.sort((x, y) => x.createdAt - y.createdAt)) {
            md += `\n> ${h.text.replace(/\n/g, '\n> ')}\n`;
            if (h.note) md += `\n${h.note}\n`;
          }
        }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        return res.end(md);
      }
      if (req.method === 'DELETE' && parts.length === 3) {
        const { changes } = store.deleteHighlight(parts[2], user.id);
        if (!changes) return json(res, 404, { error: 'highlight not found' });
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
  const users = store.userCount();
  if (users === 0) {
    console.log(`No accounts yet — open http://localhost:${PORT}/signup in a browser to create one.`);
    if (LEGACY_TOKEN) console.log('The first account will adopt the existing API token and any existing articles.');
  } else {
    console.log(`${users} account(s). Each account's API token is on its /settings page.`);
  }
  if (INBOUND_SECRET) {
    console.log(`Email-to-save enabled${INBOUND_DOMAIN ? ` for @${INBOUND_DOMAIN}` : ''} — webhook at /api/inbound-email`);
  }
});

/**
 * ReadLater storage layer — SQLite (better-sqlite3) with FTS5 full-text search.
 *
 * The database is a single file <data dir>/readlater.db. On first start, a
 * legacy JSON store (<data dir>/db.json) is imported automatically and the
 * old file renamed *.migrated-<ts>.
 *
 * Booleans are stored as 0/1 and converted back at the row boundary, so
 * callers see the same shapes the old in-memory store produced.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/** Hostname of an article URL, lowercased, without www. Emailed articles get 'email'. */
function hostOf(u) {
  if (String(u).startsWith('email:')) return 'email';
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  passwordHash TEXT NOT NULL,
  token TEXT NOT NULL,
  emailAlias TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  expiresAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT '',
  savedAt INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  readParagraph INTEGER NOT NULL DEFAULT 0,
  ttsParagraph INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  byline TEXT,
  siteName TEXT,
  excerpt TEXT,
  html TEXT,
  textContent TEXT,
  wordCount INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS articles_user_url ON articles(userId, url);
CREATE INDEX IF NOT EXISTS articles_user_saved ON articles(userId, savedAt DESC);
CREATE INDEX IF NOT EXISTS articles_user_domain ON articles(userId, domain);

CREATE TABLE IF NOT EXISTS highlights (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  clientId TEXT,
  articleId TEXT NOT NULL,
  text TEXT NOT NULL,
  note TEXT,
  paragraphIndex INTEGER,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hl_article ON highlights(articleId);
CREATE INDEX IF NOT EXISTS hl_user_client ON highlights(userId, clientId);

CREATE TABLE IF NOT EXISTS views (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  name TEXT NOT NULL,
  filters TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS views_user ON views(userId);

CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
  title, byline, siteName, excerpt, textContent,
  content='articles', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid, title, byline, siteName, excerpt, textContent)
  VALUES (new.rowid, new.title, new.byline, new.siteName, new.excerpt, new.textContent);
END;
CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, byline, siteName, excerpt, textContent)
  VALUES ('delete', old.rowid, old.title, old.byline, old.siteName, old.excerpt, old.textContent);
END;
CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, byline, siteName, excerpt, textContent)
  VALUES ('delete', old.rowid, old.title, old.byline, old.siteName, old.excerpt, old.textContent);
  INSERT INTO articles_fts(rowid, title, byline, siteName, excerpt, textContent)
  VALUES (new.rowid, new.title, new.byline, new.siteName, new.excerpt, new.textContent);
END;
`;

const rowUser = (r) => r || null;
const rowArticle = (r) => r && { ...r, archived: !!r.archived, favorite: !!r.favorite };

const stripTags = (html) => String(html || '').replace(/<[^>]+>/g, ' ');
const countWords = (s) => {
  const t = String(s || '').trim();
  return t ? t.split(/\s+/).length : 0;
};
const articleWordCount = (a) => countWords(a.textContent || stripTags(a.html));

/** Turn a user query into an FTS5 MATCH expression: each term quoted, prefix-matched, ANDed. */
function ftsQuery(q) {
  const terms = String(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

function open(dataDir) {
  const file = path.join(dataDir, 'readlater.db');
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(SCHEMA);

  // databases created before wordCount existed: add the column and backfill
  const articleCols = sqlite.prepare('PRAGMA table_info(articles)').all().map((c) => c.name);
  if (!articleCols.includes('wordCount')) {
    sqlite.exec("ALTER TABLE articles ADD COLUMN wordCount INTEGER NOT NULL DEFAULT 0");
    const rows = sqlite.prepare('SELECT id, textContent, html FROM articles').all();
    const upd = sqlite.prepare('UPDATE articles SET wordCount = ? WHERE id = ?');
    sqlite.transaction(() => {
      for (const r of rows) upd.run(articleWordCount(r), r.id);
    })();
  }
  // separate listening position (TTS) from the manual scroll position
  if (!articleCols.includes('ttsParagraph')) {
    sqlite.exec("ALTER TABLE articles ADD COLUMN ttsParagraph INTEGER NOT NULL DEFAULT 0");
  }

  migrateLegacyJson(sqlite, dataDir);

  const S = {}; // prepared statements
  const prep = (k, sql) => (S[k] ||= sqlite.prepare(sql));

  const db = {
    sqlite,
    close: () => sqlite.close(),

    // ---------------- users
    userCount: () => prep('uc', 'SELECT COUNT(*) c FROM users').get().c,
    allUsers: () => prep('ua', 'SELECT * FROM users').all(),
    userById: (id) => rowUser(prep('ubi', 'SELECT * FROM users WHERE id = ?').get(id)),
    userByName: (name) => rowUser(prep('ubn', 'SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(name))),
    userByAlias: (alias) => rowUser(prep('uba', 'SELECT * FROM users WHERE emailAlias = ?').get(alias)),
    insertUser: (u) => prep('ui', `INSERT INTO users (id, username, passwordHash, token, emailAlias, createdAt)
      VALUES (@id, @username, @passwordHash, @token, @emailAlias, @createdAt)`).run(u),
    setUserToken: (id, token) => prep('ut', 'UPDATE users SET token = ? WHERE id = ?').run(token, id),
    setUserAlias: (id, alias) => prep('ual', 'UPDATE users SET emailAlias = ? WHERE id = ?').run(alias, id),
    /** first account adopts any pre-account rows */
    adoptOrphans: (userId) => {
      prep('ao1', "UPDATE articles SET userId = ? WHERE userId = ''").run(userId);
      prep('ao2', "UPDATE highlights SET userId = ? WHERE userId = ''").run(userId);
    },

    // ---------------- sessions
    getSession: (sid) => prep('sg', 'SELECT * FROM sessions WHERE sid = ?').get(sid) || null,
    putSession: (sid, userId, expiresAt) =>
      prep('sp', 'INSERT OR REPLACE INTO sessions (sid, userId, expiresAt) VALUES (?, ?, ?)').run(sid, userId, expiresAt),
    deleteSession: (sid) => prep('sd', 'DELETE FROM sessions WHERE sid = ?').run(sid),
    pruneSessions: (now) => prep('spr', 'DELETE FROM sessions WHERE expiresAt < ?').run(now),

    // ---------------- articles
    articleCount: (userId) => prep('ac', 'SELECT COUNT(*) c FROM articles WHERE userId = ?').get(userId).c,
    getArticle: (id, userId) =>
      rowArticle(prep('ag', 'SELECT * FROM articles WHERE id = ? AND userId = ?').get(id, userId)),
    articleByUrl: (userId, url) =>
      rowArticle(prep('abu', 'SELECT * FROM articles WHERE userId = ? AND url = ?').get(userId, url)),
    insertArticle: (a) => prep('ai', `INSERT INTO articles
      (id, userId, url, domain, savedAt, archived, favorite, readParagraph, title, byline, siteName, excerpt, html, textContent, wordCount, updatedAt)
      VALUES (@id, @userId, @url, @domain, @savedAt, @archived, @favorite, @readParagraph, @title, @byline, @siteName, @excerpt, @html, @textContent, @wordCount, @updatedAt)`)
      .run({ ...a, domain: hostOf(a.url), archived: a.archived ? 1 : 0, favorite: a.favorite ? 1 : 0, wordCount: articleWordCount(a) }),
    updateArticleContent: (id, f) => prep('auc', `UPDATE articles SET
      title = @title, byline = @byline, siteName = @siteName, excerpt = @excerpt,
      html = @html, textContent = @textContent, wordCount = @wordCount, updatedAt = @updatedAt WHERE id = @id`)
      .run({ ...f, id, wordCount: articleWordCount(f) }),
    patchArticle: (id, { archived, favorite, readParagraph, ttsParagraph, updatedAt }) =>
      prep('ap', `UPDATE articles SET
        archived = COALESCE(@archived, archived),
        favorite = COALESCE(@favorite, favorite),
        readParagraph = COALESCE(@readParagraph, readParagraph),
        ttsParagraph = COALESCE(@ttsParagraph, ttsParagraph),
        updatedAt = @updatedAt WHERE id = @id`)
        .run({
          id, updatedAt,
          archived: typeof archived === 'boolean' ? (archived ? 1 : 0) : null,
          favorite: typeof favorite === 'boolean' ? (favorite ? 1 : 0) : null,
          readParagraph: Number.isInteger(readParagraph) && readParagraph >= 0 ? readParagraph : null,
          ttsParagraph: Number.isInteger(ttsParagraph) && ttsParagraph >= 0 ? ttsParagraph : null,
        }),
    deleteArticle: (id) => {
      prep('adh', 'DELETE FROM highlights WHERE articleId = ?').run(id);
      return prep('ad', 'DELETE FROM articles WHERE id = ?').run(id);
    },

    /**
     * Search/filter a user's articles (metadata only — html/textContent never
     * leave the database here). All filters optional; newest first.
     */
    searchArticles: (userId, { q = '', domain = '', highlighted = false, includeArchived = false, since = 0, favoriteOnly = false, archivedOnly = false, minWords = 0, maxWords = 0, minHighlights = 0 } = {}) => {
      const where = ['a.userId = @userId'];
      const args = { userId };
      if (archivedOnly) where.push('a.archived = 1');
      else if (!includeArchived) where.push('a.archived = 0');
      if (favoriteOnly) where.push('a.favorite = 1');
      if (since) { where.push('a.updatedAt > @since'); args.since = since; }
      if (domain) {
        const d = String(domain).toLowerCase().replace(/^www\./, '');
        where.push("(a.domain = @domain OR a.domain LIKE '%.' || @domain)");
        args.domain = d;
      }
      if (minWords > 0) { where.push('a.wordCount >= @minWords'); args.minWords = minWords; }
      if (maxWords > 0) { where.push('a.wordCount <= @maxWords'); args.maxWords = maxWords; }
      if (minHighlights > 0) {
        where.push('(SELECT COUNT(*) FROM highlights h WHERE h.articleId = a.id) >= @minHighlights');
        args.minHighlights = minHighlights;
      } else if (highlighted) {
        where.push('EXISTS (SELECT 1 FROM highlights h WHERE h.articleId = a.id)');
      }
      const match = ftsQuery(q);
      if (match) {
        where.push('a.rowid IN (SELECT rowid FROM articles_fts WHERE articles_fts MATCH @match)');
        args.match = match;
      }
      const sql = `SELECT a.id, a.userId, a.url, a.domain, a.savedAt, a.archived, a.favorite, a.readParagraph,
          a.ttsParagraph, a.title, a.byline, a.siteName, a.excerpt, a.wordCount, a.updatedAt
        FROM articles a WHERE ${where.join(' AND ')} ORDER BY a.savedAt DESC`;
      return sqlite.prepare(sql).all(args).map(rowArticle);
    },

    domainCounts: (userId) =>
      prep('dc', "SELECT domain, COUNT(*) n FROM articles WHERE userId = ? AND domain != '' GROUP BY domain ORDER BY n DESC")
        .all(userId),

    // ---------------- highlights
    highlightCount: (userId) => prep('hc', 'SELECT COUNT(*) c FROM highlights WHERE userId = ?').get(userId).c,
    highlightsForArticle: (articleId) =>
      prep('hfa', 'SELECT * FROM highlights WHERE articleId = ? ORDER BY createdAt').all(articleId),
    highlightsForUser: (userId) => prep('hfu', `SELECT h.*, a.title articleTitle, a.url articleUrl
      FROM highlights h LEFT JOIN articles a ON a.id = h.articleId
      WHERE h.userId = ? ORDER BY h.createdAt DESC`).all(userId),
    /** Articles that have highlights, with counts — for the highlights page. */
    highlightedArticles: (userId) =>
      prep('hla', `SELECT a.id, a.title, a.siteName, a.savedAt, a.wordCount,
          COUNT(h.id) AS n, MAX(h.createdAt) AS lastHighlightAt
        FROM highlights h JOIN articles a ON a.id = h.articleId
        WHERE h.userId = ? GROUP BY a.id ORDER BY lastHighlightAt DESC`).all(userId),

    highlightCountsByArticle: (userId) => {
      const out = new Map();
      for (const r of prep('hcba', 'SELECT articleId, COUNT(*) n FROM highlights WHERE userId = ? GROUP BY articleId').all(userId)) {
        out.set(r.articleId, r.n);
      }
      return out;
    },
    highlightByClientId: (userId, clientId) =>
      prep('hbc', 'SELECT * FROM highlights WHERE userId = ? AND clientId = ?').get(userId, clientId) || null,

    // ---------------- saved views
    listViews: (userId) =>
      prep('vl', 'SELECT * FROM views WHERE userId = ? ORDER BY createdAt').all(userId)
        .map((v) => ({ ...v, filters: JSON.parse(v.filters) })),
    getView: (id, userId) => {
      const v = prep('vg', 'SELECT * FROM views WHERE id = ? AND userId = ?').get(id, userId);
      return v ? { ...v, filters: JSON.parse(v.filters) } : null;
    },
    insertView: (v) => prep('vi', `INSERT INTO views (id, userId, name, filters, createdAt)
      VALUES (@id, @userId, @name, @filters, @createdAt)`).run({ ...v, filters: JSON.stringify(v.filters) }),
    deleteView: (id, userId) =>
      prep('vd', 'DELETE FROM views WHERE id = ? AND userId = ?').run(id, userId),

    /** Everything the user owns, for backup/export. */
    exportUser: (userId) => ({
      articles: prep('exa', 'SELECT * FROM articles WHERE userId = ? ORDER BY savedAt').all(userId)
        .map(rowArticle)
        .map(({ userId: _u, domain: _d, ...a }) => a),
      highlights: prep('exh', 'SELECT * FROM highlights WHERE userId = ? ORDER BY createdAt').all(userId)
        .map(({ userId: _u, ...h }) => h),
    }),
    insertHighlight: (h) => prep('hi', `INSERT INTO highlights
      (id, userId, clientId, articleId, text, note, paragraphIndex, createdAt)
      VALUES (@id, @userId, @clientId, @articleId, @text, @note, @paragraphIndex, @createdAt)`).run(h),
    deleteHighlight: (id, userId) =>
      prep('hd', 'DELETE FROM highlights WHERE id = ? AND userId = ?').run(id, userId),
  };
  return db;
}

/** One-time import of the legacy JSON store into an empty SQLite database. */
function migrateLegacyJson(sqlite, dataDir) {
  const jsonFile = path.join(dataDir, 'db.json');
  if (!fs.existsSync(jsonFile)) return;
  const empty = sqlite.prepare('SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM articles) c').get().c === 0;
  if (!empty) return;
  let legacy;
  try { legacy = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); }
  catch (e) { console.error(`Legacy db.json unreadable, skipping import: ${e.message}`); return; }

  const insUser = sqlite.prepare(`INSERT INTO users (id, username, passwordHash, token, emailAlias, createdAt)
    VALUES (@id, @username, @passwordHash, @token, @emailAlias, @createdAt)`);
  const insSession = sqlite.prepare('INSERT OR REPLACE INTO sessions (sid, userId, expiresAt) VALUES (?, ?, ?)');
  const insArticle = sqlite.prepare(`INSERT OR IGNORE INTO articles
    (id, userId, url, domain, savedAt, archived, favorite, readParagraph, title, byline, siteName, excerpt, html, textContent, wordCount, updatedAt)
    VALUES (@id, @userId, @url, @domain, @savedAt, @archived, @favorite, @readParagraph, @title, @byline, @siteName, @excerpt, @html, @textContent, @wordCount, @updatedAt)`);
  const insHighlight = sqlite.prepare(`INSERT OR IGNORE INTO highlights
    (id, userId, clientId, articleId, text, note, paragraphIndex, createdAt)
    VALUES (@id, @userId, @clientId, @articleId, @text, @note, @paragraphIndex, @createdAt)`);

  const run = sqlite.transaction(() => {
    for (const u of legacy.users || []) {
      insUser.run({ emailAlias: u.emailAlias || `${u.username.toLowerCase()}-legacy`, ...u });
    }
    for (const [sid, s] of Object.entries(legacy.sessions || {})) {
      if (s && s.expiresAt > Date.now()) insSession.run(sid, s.userId, s.expiresAt);
    }
    for (const a of legacy.articles || []) {
      insArticle.run({
        byline: null, siteName: null, excerpt: null, html: null, textContent: null,
        ...a,
        userId: a.userId || '',
        domain: hostOf(a.url),
        archived: a.archived ? 1 : 0,
        favorite: a.favorite ? 1 : 0,
        readParagraph: a.readParagraph || 0,
        wordCount: articleWordCount(a),
        updatedAt: a.updatedAt || a.savedAt || Date.now(),
      });
    }
    for (const h of legacy.highlights || []) {
      insHighlight.run({
        clientId: null, note: null, paragraphIndex: null,
        ...h,
        userId: h.userId || '',
      });
    }
  });
  run();
  const counts = sqlite.prepare('SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM articles) a, (SELECT COUNT(*) FROM highlights) h').get();
  fs.renameSync(jsonFile, `${jsonFile}.migrated-${Date.now()}`);
  console.log(`Imported legacy db.json → SQLite (${counts.u} users, ${counts.a} articles, ${counts.h} highlights).`);
}

module.exports = { open, hostOf };

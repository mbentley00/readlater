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

/**
 * Hostname of an article URL, lowercased, without www. Emailed articles get
 * 'email' — both our own IMAP saves (email:<message-id>) and Readwise's
 * forwarded newsletters (mailto:reader-forwarded-email/<hash>), neither of
 * which has a hostname to parse.
 */
function hostOf(u) {
  const s = String(u);
  if (s.startsWith('email:') || s.startsWith('mailto:')) return 'email';
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

// ---------------------------------------------------------------- newsletters
// A forwarded newsletter carries no usable URL, so every one of them would file
// under a single 'email' bucket — 1,500 articles from dozens of publications,
// indistinguishable. The body knows better: a newsletter's links are
// overwhelmingly its own. What follows recovers the publication from them.

/** Hosts that never identify a publication: send/click infrastructure, CDNs,
 *  platform chrome, and the big sites every newsletter merely links out to. */
const INFRA_HOSTS = new Set([
  'substack.com', 'substackcdn.com', 'ghost.org', 'buttondown.com', 'buttondown.email',
  'beehiiv.com', 'beehiivstatus.com', 'awstrack.me', 'mjt.lu', 'list-manage.com',
  'mailchimp.com', 'sendgrid.net', 'mailgun.org', 'sparkpostmail.com',
  'passport.online', 'imgproxy.readwise.io', 'readwise.io', 'imagekit.io',
  'googleusercontent.com', 'gstatic.com', 'cloudfront.net', 'amazonaws.com',
  'spacergif.org', 'ytimg.com', 'gravatar.com', 'doubleclick.net',
  'google.com', 'youtube.com', 'x.com', 'twitter.com', 't.co', 'facebook.com',
  'instagram.com', 'linkedin.com', 'reddit.com', 'wikipedia.org', 'wiktionary.org',
  'spotify.com', 'goodreads.com', 'apple.com', 'amazon.com', 'github.com',
  'patreon.com', 'paypal.com', 'bit.ly', 'tinyurl.com',
  'domain.com', 'example.com', 'yourdomain.com', 'mysite.com', // template placeholders
]);

/** Subdomains an email service puts in front of the publisher's own domain
 *  (links.tedium.co → tedium.co). Stripped, not rejected. */
const WRAPPER_SUBS = new Set(['link', 'links', 'linkst', 'email', 'e', 'mail', 'click',
  'track', 'message', 'go', 'r', 'url', 'view', 'ct']);

/** Platform subdomains that are the platform itself, not a publication. */
const PLATFORM_SUBS = new Set(['open', 'email', 'eotrx', 'mg', 'mg2', 'mg-d0', 'mg-d1',
  'on', 'static', 'cdn', 'assets', 'www']);

const NEWSLETTER_PLATFORMS = ['substack.com', 'beehiiv.com', 'ghost.io', 'buttondown.email', 'kit.com'];

function normalizeHost(host) {
  let parts = String(host || '').toLowerCase().replace(/^www\./, '').split('.');
  while (parts.length > 2 && WRAPPER_SUBS.has(parts[0])) parts = parts.slice(1);
  return parts.join('.');
}

/** Can [h] stand as a publication's identity? */
function usableHost(h) {
  const parts = String(h || '').split('.');
  if (parts.length < 2) return false;
  if (INFRA_HOSTS.has(h)) return false;
  for (let i = 1; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join('.');
    if (!INFRA_HOSTS.has(suffix)) continue;
    // …unless it's a publication hosted ON a newsletter platform: keep
    // boondoggle.substack.com, drop open.substack.com.
    return NEWSLETTER_PLATFORMS.includes(suffix) && i === 1 && !PLATFORM_SUBS.has(parts[0]);
  }
  return true;
}

/**
 * Substack routes every link through substack.com/redirect/2/<base64>, whose
 * payload is JSON holding the real destination — including the publication's
 * own custom domain. Undecoded, a Substack newsletter looks like nothing but
 * links to substack.com. open.substack.com/pub/<slug> names it directly.
 */
function substackHosts(html) {
  const out = [];
  for (const m of html.matchAll(/substack\.com\/redirect\/2\/([A-Za-z0-9_+/=-]+)/g)) {
    let decoded;
    try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { continue; }
    // The payload is often cut short at the href boundary, so pull the url out
    // by pattern rather than requiring the JSON to parse.
    const url = (decoded.match(/"e"\s*:\s*"(https?:\/\/[^"]+)"/)
      || decoded.match(/(https?:\/\/[^"\\\s]+)/) || [])[1];
    if (url) out.push(url);
  }
  for (const m of html.matchAll(/open\.substack\.com\/pub\/([a-z0-9-]+)/gi)) {
    out.push(`https://${m[1].toLowerCase()}.substack.com/`);
  }
  return out;
}

/** The publication a newsletter came from, or '' if nothing stands out. */
function newsletterHost(html) {
  const src = String(html || '');
  const counts = new Map();
  const add = (u, weight) => {
    let h;
    try { h = normalizeHost(new URL(u).hostname); } catch { return; }
    if (usableHost(h)) counts.set(h, (counts.get(h) || 0) + weight);
  };
  for (const m of src.matchAll(/href\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) add(m[1], 1);
  // A decoded platform redirect is far better evidence than the wrapper around it.
  for (const u of substackHosts(src)) add(u, 3);
  let best = '', bestN = 0;
  for (const [h, n] of counts) if (n > bestN) { best = h; bestN = n; }
  return bestN >= 2 ? best : ''; // one stray citation shouldn't name the publication
}

/**
 * How to file an article: its host, or for a newsletter the publication we can
 * recover from the body. Also supplies a siteName when the article has none, so
 * every client shows the source without needing to know about any of this.
 */
function articleIdentity(a) {
  const host = hostOf(a.url);
  if (host !== 'email') return { domain: host, siteName: a.siteName ?? null };
  const pub = newsletterHost(a.html);
  // Our IMAP path stamps a literal "Email" as the site name; that is a
  // placeholder, not a source, so a publication we recognise outranks it.
  const existing = String(a.siteName || '').trim();
  const keep = existing && !/^e-?mail$/i.test(existing);
  return { domain: pub || 'email', siteName: (keep ? existing : pub) || existing || null };
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
  -- raw source captured at save time (email HTML, fetched page, or the
  -- extension's stripped page), kept so a mis-parsed article can be reparsed
  -- and its original shown. Large; never sent in list/full-article responses,
  -- only via the dedicated source getter.
  sourceHtml TEXT,
  -- how the article got here: 'browser-page' (extension, live DOM), 'browser-link'
  -- (extension, server-fetched link), 'android-share', 'email', 'url', … — kept
  -- as a debugging aid for diagnosing parse failures per save method.
  source TEXT,
  wordCount INTEGER NOT NULL DEFAULT 0,
  -- unguessable slug that makes the parsed article readable at /p/<shareId>
  -- without a session. NULL = not shared. Revoking clears it, which breaks
  -- every copy of the old link; re-sharing mints a fresh one.
  shareId TEXT,
  updatedAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS articles_user_url ON articles(userId, url);
CREATE INDEX IF NOT EXISTS articles_user_saved ON articles(userId, savedAt DESC);
CREATE INDEX IF NOT EXISTS articles_user_domain ON articles(userId, domain);
-- delta sync filters on updatedAt; without this it scans every row (each holding
-- large inline html/textContent), making a "1 new article" sync take ~15s+.
CREATE INDEX IF NOT EXISTS articles_user_updated ON articles(userId, updatedAt);

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

-- Boilerplate phrases ("Sign up for our newsletter") to drop from articles as
-- they are saved. Applied at save time only, never retroactively: paragraph
-- indices anchor highlights and reading positions in already-saved articles.
CREATE TABLE IF NOT EXISTS skip_rules (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  phrase TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS skip_rules_user ON skip_rules(userId);
CREATE UNIQUE INDEX IF NOT EXISTS skip_rules_user_phrase ON skip_rules(userId, phrase COLLATE NOCASE);

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

-- Highlights are searched too: the words you chose to keep are the strongest
-- signal you left on an article, and they are often nowhere in its title.
CREATE VIRTUAL TABLE IF NOT EXISTS highlights_fts USING fts5(
  text, note, content='highlights', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS highlights_ai AFTER INSERT ON highlights BEGIN
  INSERT INTO highlights_fts(rowid, text, note) VALUES (new.rowid, new.text, new.note);
END;
CREATE TRIGGER IF NOT EXISTS highlights_ad AFTER DELETE ON highlights BEGIN
  INSERT INTO highlights_fts(highlights_fts, rowid, text, note)
  VALUES ('delete', old.rowid, old.text, old.note);
END;
CREATE TRIGGER IF NOT EXISTS highlights_au AFTER UPDATE ON highlights BEGIN
  INSERT INTO highlights_fts(highlights_fts, rowid, text, note)
  VALUES ('delete', old.rowid, old.text, old.note);
  INSERT INTO highlights_fts(rowid, text, note) VALUES (new.rowid, new.text, new.note);
END;
`;

const rowUser = (r) => r || null;
const rowArticle = (r) => r && { ...r, archived: !!r.archived, favorite: !!r.favorite };

// Every article column EXCEPT the (potentially huge) raw sourceHtml, which is
// only ever fetched on demand via getArticleSource — never in the full-article
// GET or Android sync, which would otherwise double every article's payload.
const ARTICLE_COLS = 'id, userId, url, domain, savedAt, archived, favorite, readParagraph, '
  + 'ttsParagraph, title, byline, siteName, excerpt, html, textContent, imageUrl, publishedAt, '
  + 'source, wordCount, shareId, updatedAt';

// Extract readable text for word counting. Crucially, remove the CONTENT of
// script/style/head/noscript/svg blocks — not just their tags — or embedded
// JSON-LD and inline scripts (common in imported article HTML) inflate the
// count and make reading-time estimates far too long.
const htmlToText = (html) => String(html || '')
  .replace(/<(script|style|head|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<[^>]+>/g, ' ');
const countWords = (s) => {
  const t = String(s || '').trim();
  return t ? t.split(/\s+/).length : 0;
};
const articleWordCount = (a) => countWords(a.textContent || htmlToText(a.html));

/**
 * The body text to store for search. Clients may sync `html` without a matching
 * `textContent` (imports especially); since the FTS index reads textContent and
 * not html, taking that at face value would leave the article findable by title
 * alone. Fall back to the html's own text.
 */
const searchText = (a) => {
  if (String(a.textContent || '').trim()) return a.textContent;
  const derived = htmlToText(a.html).replace(/\s+/g, ' ').trim();
  return derived ? derived.slice(0, 400000) : (a.textContent ?? null);
};

/** Stable 32-bit hash (FNV-1a) of a string. */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const ARTICLE_SORTS = {
  newest: 'a.savedAt DESC',
  oldest: 'a.savedAt ASC',
  longest: 'a.wordCount DESC',
  shortest: 'a.wordCount ASC',
  // Shuffled, but repeatably so: the caller supplies a seed and gets the same
  // order back for every page of that result set. ORDER BY RANDOM() would
  // reshuffle on each request and make pagination drop/repeat articles.
  random: 'shuffle(@seed, a.id) ASC',
};

/** Shared WHERE builder for searchArticles + countArticles. */
function buildArticleWhere(userId, {
  q = '', domain = '', domains = null, highlighted = false, includeArchived = false, since = 0,
  favoriteOnly = false, archivedOnly = false, minWords = 0, maxWords = 0, minHighlights = 0,
} = {}) {
  const where = ['a.userId = @userId'];
  const args = { userId };
  if (archivedOnly) where.push('a.archived = 1');
  else if (!includeArchived) where.push('a.archived = 0');
  if (favoriteOnly) where.push('a.favorite = 1');
  if (since) { where.push('a.updatedAt > @since'); args.since = since; }
  if (domains && domains.length) {
    // An explicit set, resolved by the caller (the web UI expands a typed
    // fragment into the domains that contain it).
    where.push(`a.domain IN (${domains.map((_, i) => `@dom${i}`).join(', ')})`);
    domains.forEach((d, i) => { args[`dom${i}`] = String(d).toLowerCase(); });
  } else if (domain) {
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
  const m = ftsMatch(q);
  if (m) {
    where.push(m.clause);
    Object.assign(args, m.args);
  }
  return { where, args };
}

const HL_SORTS = {
  recent: 'lastHighlightAt DESC',
  oldest: 'lastHighlightAt ASC',
  most: 'n DESC',
  title: 'a.title COLLATE NOCASE ASC',
  random: 'shuffle(@seed, a.id) ASC',
};

/** Shared WHERE for highlighted-articles queries (userId + optional q/domain). */
function hlWhere(userId, q, domain, domains = null) {
  const parts = ['h.userId = @userId'];
  const args = { userId };
  const m = ftsMatch(q);
  if (m) { parts.push(m.clause); Object.assign(args, m.args); }
  if (domains && domains.length) {
    parts.push(`a.domain IN (${domains.map((_, i) => `@dom${i}`).join(', ')})`);
    domains.forEach((d, i) => { args[`dom${i}`] = String(d).toLowerCase(); });
  } else if (domain) {
    const d = String(domain).toLowerCase().replace(/^www\./, '');
    parts.push("(a.domain = @domain OR a.domain LIKE '%.' || @domain)");
    args.domain = d;
  }
  return { where: parts.join(' AND '), args };
}

/**
 * WHERE fragment (plus its bindings) matching a query against an article's own
 * text and the text of its highlights. Every term is required, but each may land
 * in either place — searching "marcos duterte" finds an article titled for
 * Marcos with Duterte in a highlight — so this emits one clause per term rather
 * than a single MATCH over the whole query.
 *
 * Terms are quoted and prefix-matched. Assumes the articles table is aliased
 * `a`; the highlights subquery needs no user check of its own, since `a` is
 * always already scoped to one user. Returns null when there are no terms.
 */
function ftsMatch(q) {
  const terms = String(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  const args = {};
  const clause = terms.map((t, i) => {
    const k = `match${i}`;
    args[k] = `"${t.replace(/"/g, '""')}"*`;
    return `(a.rowid IN (SELECT rowid FROM articles_fts WHERE articles_fts MATCH @${k})
      OR a.id IN (SELECT hq.articleId FROM highlights hq
                  WHERE hq.rowid IN (SELECT rowid FROM highlights_fts WHERE highlights_fts MATCH @${k})))`;
  }).join(' AND ');
  return { clause, args };
}

function open(dataDir) {
  const file = path.join(dataDir, 'readlater.db');
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(SCHEMA);

  // Deterministic per-(seed, id) shuffle key for the `random` sorts.
  sqlite.function('shuffle', { deterministic: true }, (seed, id) => hash32(`${seed}:${id}`));

  // Recompute wordCount for every article WITHOUT loading all bodies into
  // memory at once (24k full HTML bodies via .all() OOMs a small VM). Stream
  // the rows with an iterator, keep only {id, wordCount}, then batch-update.
  const recomputeAllWordCounts = () => {
    const sel = sqlite.prepare('SELECT id, textContent, html FROM articles');
    const pairs = [];
    for (const r of sel.iterate()) pairs.push([r.id, articleWordCount(r)]); // html not retained
    const upd = sqlite.prepare('UPDATE articles SET wordCount = ? WHERE id = ?');
    sqlite.transaction(() => {
      for (const [id, wc] of pairs) upd.run(wc, id);
    })();
  };

  // databases created before wordCount existed: add the column and backfill
  const articleCols = sqlite.prepare('PRAGMA table_info(articles)').all().map((c) => c.name);
  if (!articleCols.includes('wordCount')) {
    sqlite.exec("ALTER TABLE articles ADD COLUMN wordCount INTEGER NOT NULL DEFAULT 0");
    recomputeAllWordCounts();
  }
  // separate listening position (TTS) from the manual scroll position
  if (!articleCols.includes('ttsParagraph')) {
    sqlite.exec("ALTER TABLE articles ADD COLUMN ttsParagraph INTEGER NOT NULL DEFAULT 0");
  }
  // thumbnail image (og:image) for the article list
  if (!articleCols.includes('imageUrl')) {
    sqlite.exec("ALTER TABLE articles ADD COLUMN imageUrl TEXT");
  }
  // original publish date (ms), when the page exposes one
  if (!articleCols.includes('publishedAt')) {
    sqlite.exec("ALTER TABLE articles ADD COLUMN publishedAt INTEGER");
  }
  // raw source kept for reparse / "view original"
  if (!articleCols.includes('sourceHtml')) {
    sqlite.exec("ALTER TABLE articles ADD COLUMN sourceHtml TEXT");
  }
  // how the article was saved (browser-page / browser-link / android-share / …)
  if (!articleCols.includes('source')) {
    sqlite.exec("ALTER TABLE articles ADD COLUMN source TEXT");
  }
  // public share slug (/p/<shareId>)
  if (!articleCols.includes('shareId')) {
    sqlite.exec("ALTER TABLE articles ADD COLUMN shareId TEXT");
  }
  // Created here rather than in SCHEMA: on a database predating the column, the
  // CREATE INDEX in SCHEMA would run before the ALTER above and fail outright.
  // Unique so a slug can never resolve to two articles; SQLite treats NULLs as
  // distinct, so any number of unshared articles coexist.
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS articles_share ON articles(shareId)');
  // one-time recompute after the script/style-stripping fix (imported
  // articles were over-counted by embedded JSON-LD / scripts).
  if (sqlite.pragma('user_version', { simple: true }) < 2) {
    recomputeAllWordCounts();
    sqlite.pragma('user_version = 2');
  }

  // Search used to see only textContent, so an article that arrived with a body
  // in `html` but no `textContent` (imports, and any client that syncs one
  // without the other) was findable by its title alone. Backfill the text from
  // the stored html, then rebuild both indexes — highlights_fts is brand new and
  // starts empty on an existing database, and the backfill's UPDATEs fire the
  // articles triggers against rows that may never have been indexed.
  //
  // updatedAt is deliberately left untouched: bumping it would make every client
  // re-download the entire library on its next delta sync.
  if (sqlite.pragma('user_version', { simple: true }) < 3) {
    const stale = sqlite.prepare(`SELECT id FROM articles
      WHERE (textContent IS NULL OR textContent = '') AND html IS NOT NULL AND html != ''`).all();
    const getHtml = sqlite.prepare('SELECT html FROM articles WHERE id = ?');
    const upd = sqlite.prepare('UPDATE articles SET textContent = ? WHERE id = ?');
    let filled = 0;
    // One body at a time — 24k inline htmls will not fit in memory at once.
    sqlite.transaction(() => {
      for (const { id } of stale) {
        const text = htmlToText((getHtml.get(id) || {}).html).replace(/\s+/g, ' ').trim();
        if (text) { upd.run(text.slice(0, 400000), id); filled++; }
      }
    })();
    sqlite.exec("INSERT INTO articles_fts(articles_fts) VALUES('rebuild')");
    sqlite.exec("INSERT INTO highlights_fts(highlights_fts) VALUES('rebuild')");
    sqlite.pragma('user_version = 3');
    if (filled) console.log(`search: recovered body text for ${filled} article(s)`);
  }

  // Newsletters saved before we could tell them apart all sit under 'email' (or
  // under no domain at all, for Readwise's mailto: imports). Recover the
  // publication from each body. Only these rows are touched — a few thousand at
  // most — and updatedAt IS bumped here, unlike the backfill above: the point is
  // for phones to pick the new source label up on their next sync.
  if (sqlite.pragma('user_version', { simple: true }) < 4) {
    const rows = sqlite.prepare(
      "SELECT id FROM articles WHERE domain = '' OR domain = 'email'"
    ).all();
    const get = sqlite.prepare('SELECT id, url, html, siteName FROM articles WHERE id = ?');
    const upd = sqlite.prepare(
      'UPDATE articles SET domain = @domain, siteName = @siteName, updatedAt = @now WHERE id = @id'
    );
    const now = Date.now();
    let named = 0;
    sqlite.transaction(() => {
      for (const { id } of rows) {
        const a = get.get(id);
        if (!a) continue;
        const { domain, siteName } = articleIdentity(a);
        // Unrecognised newsletters still land in 'email' rather than keeping the
        // empty domain a mailto: import left them with — an empty domain shows
        // up nowhere at all in the picker.
        if (domain === a.domain && (siteName || null) === (a.siteName || null)) continue;
        upd.run({ id, domain, siteName, now });
        if (domain !== 'email') named++;
      }
    })();
    sqlite.pragma('user_version = 4');
    if (named) console.log(`sources: identified the publication for ${named} newsletter(s)`);
  }

  // Re-run for rows whose site name was the literal placeholder "Email"; those
  // kept it the first time round instead of taking the publication we found.
  if (sqlite.pragma('user_version', { simple: true }) < 5) {
    const rows = sqlite.prepare(
      "SELECT id FROM articles WHERE siteName = 'Email' COLLATE NOCASE"
    ).all();
    const get = sqlite.prepare('SELECT id, url, html, siteName FROM articles WHERE id = ?');
    const upd = sqlite.prepare(
      'UPDATE articles SET domain = @domain, siteName = @siteName, updatedAt = @now WHERE id = @id'
    );
    const now = Date.now();
    let fixed = 0;
    sqlite.transaction(() => {
      for (const { id } of rows) {
        const a = get.get(id);
        if (!a) continue;
        const { domain, siteName } = articleIdentity(a);
        if (domain === a.domain && (siteName || null) === (a.siteName || null)) continue;
        upd.run({ id, domain, siteName, now });
        fixed++;
      }
    })();
    sqlite.pragma('user_version = 5');
    if (fixed) console.log(`sources: replaced the "Email" placeholder on ${fixed} article(s)`);
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
      rowArticle(prep('ag', `SELECT ${ARTICLE_COLS} FROM articles WHERE id = ? AND userId = ?`).get(id, userId)),
    /** Raw captured source for reparse / "view original". Returns '' when none. */
    getArticleSource: (id, userId) =>
      (prep('ags', 'SELECT sourceHtml FROM articles WHERE id = ? AND userId = ?').get(id, userId) || {}).sourceHtml || '',
    articleByUrl: (userId, url) =>
      rowArticle(prep('abu', `SELECT ${ARTICLE_COLS} FROM articles WHERE userId = ? AND url = ?`).get(userId, url)),
    // Deliberately NOT scoped to a user: the whole point of a share slug is
    // that whoever holds it can read the article without being anyone.
    articleByShareId: (shareId) =>
      rowArticle(prep('abs', `SELECT ${ARTICLE_COLS} FROM articles WHERE shareId = ?`).get(shareId)),
    /** Publish (shareId) or revoke (null). Scoped to the owner. */
    setArticleShareId: (id, userId, shareId) =>
      prep('assh', 'UPDATE articles SET shareId = ? WHERE id = ? AND userId = ?').run(shareId, id, userId),
    insertArticle: (a) => prep('ai', `INSERT INTO articles
      (id, userId, url, domain, savedAt, archived, favorite, readParagraph, title, byline, siteName, excerpt, html, textContent, sourceHtml, imageUrl, publishedAt, source, wordCount, updatedAt)
      VALUES (@id, @userId, @url, @domain, @savedAt, @archived, @favorite, @readParagraph, @title, @byline, @siteName, @excerpt, @html, @textContent, @sourceHtml, @imageUrl, @publishedAt, @source, @wordCount, @updatedAt)`)
      .run({ imageUrl: null, publishedAt: null, sourceHtml: null, source: null, ...a, ...articleIdentity(a), archived: a.archived ? 1 : 0, favorite: a.favorite ? 1 : 0, textContent: searchText(a), wordCount: articleWordCount(a) }),
    // Update content; only overwrites imageUrl/publishedAt/sourceHtml when new ones are provided.
    updateArticleContent: (id, f) => prep('auc', `UPDATE articles SET
      title = @title, byline = @byline, siteName = @siteName, excerpt = @excerpt,
      html = @html, textContent = @textContent, imageUrl = COALESCE(@imageUrl, imageUrl),
      publishedAt = COALESCE(@publishedAt, publishedAt), sourceHtml = COALESCE(@sourceHtml, sourceHtml),
      wordCount = @wordCount, updatedAt = @updatedAt WHERE id = @id`)
      .run({ imageUrl: null, publishedAt: null, sourceHtml: null, ...f, id, textContent: searchText(f), wordCount: articleWordCount(f) }),
    // Adopt a new canonical URL (e.g. after resolving an email tracking
    // redirect to the publisher's real link). Keeps `domain` in step with it.
    setArticleUrl: (id, url) => prep('asu', 'UPDATE articles SET url = @url, domain = @domain WHERE id = @id')
      .run({ id, url, domain: hostOf(url) }),
    // How the content currently in the row got there. Normally fixed at insert,
    // but a highlight-only stub that later receives a real save is no longer a
    // stub, and the server keys off `source` to tell the two apart.
    setArticleSource: (id, source) => prep('ass', 'UPDATE articles SET source = @source WHERE id = @id')
      .run({ id, source }),
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
    /** Archive all of a user's non-archived articles saved before [beforeMs].
     *  Returns how many were archived. */
    bulkArchiveBefore: (userId, beforeMs, now) =>
      prep('bab', 'UPDATE articles SET archived = 1, updatedAt = @now WHERE userId = @userId AND archived = 0 AND savedAt < @before')
        .run({ userId, before: beforeMs, now }).changes,

    deleteArticle: (id) => {
      prep('adh', 'DELETE FROM highlights WHERE articleId = ?').run(id);
      return prep('ad', 'DELETE FROM articles WHERE id = ?').run(id);
    },

    /**
     * Search/filter a user's articles (metadata only — html/textContent never
     * leave the database here). All filters optional; newest first.
     */
    searchArticles: (userId, filters = {}) => {
      const { where, args } = buildArticleWhere(userId, filters);
      const sortKey = ARTICLE_SORTS[filters.sort] ? filters.sort : 'newest';
      if (sortKey === 'random') args.seed = String(filters.seed || '');
      const order = ARTICLE_SORTS[sortKey];
      let sql = `SELECT a.id, a.userId, a.url, a.domain, a.savedAt, a.archived, a.favorite, a.readParagraph,
          a.ttsParagraph, a.title, a.byline, a.siteName, a.excerpt, a.imageUrl, a.publishedAt, a.wordCount,
          a.shareId, a.updatedAt
        FROM articles a WHERE ${where.join(' AND ')} ORDER BY ${order}`;
      const lim = Number(filters.limit) || 0;
      if (lim > 0) {
        sql += ' LIMIT @limit OFFSET @offset';
        args.limit = lim;
        args.offset = Math.max(0, Number(filters.offset) || 0);
      }
      return sqlite.prepare(sql).all(args).map(rowArticle);
    },

    /** Total count for the same filters (for pagination). */
    countArticles: (userId, filters = {}) => {
      const { where, args } = buildArticleWhere(userId, filters);
      return sqlite.prepare(`SELECT COUNT(*) c FROM articles a WHERE ${where.join(' AND ')}`).get(args).c;
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
    highlightedArticles: (userId, { q = '', domain = '', domains = null, sort = 'recent', seed = '', limit = 0, offset = 0 } = {}) => {
      const { where, args } = hlWhere(userId, q, domain, domains);
      const sortKey = HL_SORTS[sort] ? sort : 'recent';
      if (sortKey === 'random') args.seed = String(seed || '');
      const order = HL_SORTS[sortKey];
      let sql = `SELECT a.id, a.title, a.siteName, a.domain, a.savedAt, a.wordCount,
          COUNT(h.id) AS n, MAX(h.createdAt) AS lastHighlightAt
        FROM highlights h JOIN articles a ON a.id = h.articleId
        WHERE ${where} GROUP BY a.id ORDER BY ${order}`;
      if (limit > 0) { sql += ' LIMIT @limit OFFSET @offset'; args.limit = limit; args.offset = Math.max(0, offset); }
      return sqlite.prepare(sql).all(args);
    },
    highlightedArticlesCount: (userId, { q = '', domain = '', domains = null } = {}) => {
      const { where, args } = hlWhere(userId, q, domain, domains);
      return sqlite.prepare(`SELECT COUNT(*) c FROM (SELECT a.id FROM highlights h
        JOIN articles a ON a.id = h.articleId WHERE ${where} GROUP BY a.id)`).get(args).c;
    },
    /** Domains among a user's highlighted articles, with counts (for the filter). */
    highlightedDomains: (userId) =>
      prep('hld', `SELECT a.domain, COUNT(DISTINCT a.id) n FROM highlights h JOIN articles a ON a.id = h.articleId
        WHERE h.userId = ? AND a.domain != '' GROUP BY a.domain ORDER BY n DESC`).all(userId),

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
    // ---- skip rules: boilerplate phrases stripped from articles as they save
    listSkipRules: (userId) =>
      prep('srl', 'SELECT * FROM skip_rules WHERE userId = ? ORDER BY createdAt').all(userId)
        .map(({ userId: _u, ...r }) => r),
    insertSkipRule: (r) => prep('sri', `INSERT INTO skip_rules (id, userId, phrase, hits, createdAt)
      VALUES (@id, @userId, @phrase, 0, @createdAt)`).run(r),
    deleteSkipRule: (id, userId) =>
      prep('srd', 'DELETE FROM skip_rules WHERE id = ? AND userId = ?').run(id, userId),
    /** Count how often a rule has actually fired, so dead rules are visible. */
    bumpSkipRuleHits: (id, n) =>
      prep('srh', 'UPDATE skip_rules SET hits = hits + ? WHERE id = ?').run(n, id),
    /** How many already-saved articles contain this phrase (rules are not
     *  retroactive — this is shown when adding one, so an over-broad phrase
     *  is obvious before it starts eating future saves). */
    countArticlesContaining: (userId, phrase) =>
      prep('sac', "SELECT COUNT(*) c FROM articles WHERE userId = ? AND textContent LIKE '%' || ? || '%'")
        .get(userId, phrase).c,

    deleteView: (id, userId) =>
      prep('vd', 'DELETE FROM views WHERE id = ? AND userId = ?').run(id, userId),

    /**
     * Everything the user owns, for backup/export. Loads every article (HTML
     * included) into memory — fine for small accounts and tests, but a large
     * one will exhaust the heap. Prefer iterExport() for anything user-facing.
     */
    exportUser: (userId) => ({
      articles: prep('exa', 'SELECT * FROM articles WHERE userId = ? ORDER BY savedAt').all(userId)
        .map(rowArticle)
        .map(({ userId: _u, domain: _d, ...a }) => a),
      highlights: prep('exh', 'SELECT * FROM highlights WHERE userId = ? ORDER BY createdAt').all(userId)
        .map(({ userId: _u, ...h }) => h),
    }),

    /**
     * Same rows as exportUser(), one at a time, so an account of any size can
     * be streamed straight to the socket. Uses fresh statements rather than the
     * prep() cache: an iterator holds its statement open for the whole walk, so
     * a cached one would be busy if two exports overlapped.
     */
    iterExport: {
      articles: function* (userId) {
        const stmt = sqlite.prepare('SELECT * FROM articles WHERE userId = ? ORDER BY savedAt');
        for (const row of stmt.iterate(userId)) {
          const { userId: _u, domain: _d, ...a } = rowArticle(row);
          yield a;
        }
      },
      highlights: function* (userId) {
        const stmt = sqlite.prepare('SELECT * FROM highlights WHERE userId = ? ORDER BY createdAt');
        for (const row of stmt.iterate(userId)) {
          const { userId: _u, ...h } = row;
          yield h;
        }
      },
    },
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
        textContent: searchText(a),
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

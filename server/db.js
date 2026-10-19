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
const quality = require('./quality');

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
  -- When the article was archived (ms), so the Archive list can be ordered by
  -- "most recently filed away" rather than by when it was saved. NULL while an
  -- article is in the inbox. Its own column rather than reusing updatedAt: that
  -- one moves for reparses and sync writes, and it sits after the html blobs,
  -- so ordering on it walks every row's overflow pages.
  archivedAt INTEGER,
  updatedAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS articles_user_url ON articles(userId, url);
CREATE INDEX IF NOT EXISTS articles_user_saved ON articles(userId, savedAt DESC);
CREATE INDEX IF NOT EXISTS articles_user_domain ON articles(userId, domain);
-- delta sync filters on updatedAt; without this it scans every row (each holding
-- large inline html/textContent), making a "1 new article" sync take ~15s+.
CREATE INDEX IF NOT EXISTS articles_user_updated ON articles(userId, updatedAt);
-- The inbox and archive are the two most-loaded pages and both filter on
-- (userId, archived) then order by savedAt. Without this the pagination count
-- fell back to articles_user_updated and read the table rows themselves --
-- which, with html/textContent/sourceHtml stored inline, means dragging
-- multi-KB rows off disk just to count them. As a covering index this answers
-- the count from the index alone: 219ms -> 2ms at 24k articles.
CREATE INDEX IF NOT EXISTS articles_user_arch_saved ON articles(userId, archived, savedAt DESC);
-- The highlights page's domain dropdown joins highlights → articles by id just
-- to read each article's domain. Covering (id, domain) answers that from the
-- index; without it every highlighted article's table row is touched, which on
-- the production volume means thousands of cold page reads per page load.
CREATE INDEX IF NOT EXISTS articles_id_domain ON articles(id, domain);

CREATE TABLE IF NOT EXISTS highlights (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  clientId TEXT,
  articleId TEXT NOT NULL,
  text TEXT NOT NULL,
  note TEXT,
  paragraphIndex INTEGER,
  -- Where the highlight sits in its ORIGINAL source, when that source has its
  -- own address space: a Kindle location/page number. Free text, because it is
  -- the source's identifier, not ours.
  location TEXT,
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

-- Articles that didn't really save: a 403, a consent wall, a page that never
-- parsed (see quality.js). They are kept out of the main list and shown in
-- their own, so a failed save is something to fix rather than something that
-- quietly looks like an article.
--
-- A side table rather than an articles column, deliberately. Every column added
-- to articles lands after the html/textContent blobs, so reading it for a list
-- of rows walks each row's overflow pages — the thing that made the old sorts
-- take 15 seconds. Asking a small table "is this id in here?" touches none of
-- that. The row is rewritten from scratch whenever an article's content
-- changes, so nothing here is ever stale.
CREATE TABLE IF NOT EXISTS article_problems (
  articleId TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  userId TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,
  detectedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS article_problems_user ON article_problems(userId, detectedAt DESC);

-- Podcast subscriptions (see feeds.js). etag/lastModified are the feed's own
-- caching headers, handed back on the next check so a quiet feed costs nothing.
CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  etag TEXT,
  lastModified TEXT,
  lastError TEXT,
  lastCheckedAt INTEGER,
  addedAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_url ON feeds(userId, url);

-- Which episodes a feed has already offered us. Adding a feed writes every
-- episode currently in it here WITHOUT importing any, which is what makes a
-- subscription start from the next one published rather than the back
-- catalogue. articleId is null when the episode could not be taken.
CREATE TABLE IF NOT EXISTS feed_items (
  feedId TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  articleId TEXT,
  seenAt INTEGER NOT NULL,
  PRIMARY KEY (feedId, guid)
);

-- Where an episode's audio can be fetched from, for an article that came from a
-- feed: the app downloads it from the publisher to play it. A side table for
-- the same reason article_problems is one — an articles column would sit behind
-- the html blobs, and this is read for every row of a list.
CREATE TABLE IF NOT EXISTS article_audio (
  articleId TEXT PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  durationS INTEGER,
  addedAt INTEGER NOT NULL
);

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
const rowArticle = (r) => r && {
  ...r,
  archived: !!r.archived,
  favorite: !!r.favorite,
  // Only the list query asks about the badly-saved flag; leave it absent (not
  // false) on the full-article reads, which say nothing about it either way.
  ...(r.problemDetail === undefined ? {} : { problem: r.problemDetail != null, problemDetail: r.problemDetail || null }),
  ...(r.audioUrl === undefined ? {} : { audioUrl: r.audioUrl || null }),
};

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
  // Archive-only: "newest" there means most recently FILED AWAY, not most
  // recently saved. Sorting by savedAt buried this morning's archiving under
  // whatever happened to be saved most recently. Served by
  // articles_user_archived_at, whose expression must stay identical to this one.
  // updatedAt is the fallback for rows archived before archivedAt existed.
  newestArchived: 'COALESCE(a.archivedAt, a.updatedAt) DESC',
  oldestArchived: 'COALESCE(a.archivedAt, a.updatedAt) ASC',
};

/** Shared WHERE builder for searchArticles + countArticles. */
function buildArticleWhere(userId, {
  q = '', domain = '', domains = null, highlighted = false, includeArchived = false, since = 0,
  favoriteOnly = false, archivedOnly = false, minWords = 0, maxWords = 0, minHighlights = 0,
  sources = null, problemsOnly = false, excludeProblems = false,
} = {}) {
  const where = ['a.userId = @userId'];
  const args = { userId };
  // How the article was saved (android-share, browser-page, email, …): the web
  // UI's "From phone" list is this with ['android-share'].
  if (sources && sources.length) {
    where.push(`a.source IN (${sources.map((_, i) => `@src${i}`).join(', ')})`);
    sources.forEach((s, i) => { args[`src${i}`] = String(s); });
  }
  // Badly-saved articles (see quality.js): their own list, and out of the main one.
  if (problemsOnly) where.push('EXISTS (SELECT 1 FROM article_problems p WHERE p.articleId = a.id)');
  else if (excludeProblems) where.push('NOT EXISTS (SELECT 1 FROM article_problems p WHERE p.articleId = a.id)');
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
function hlWhere(userId, q, domain, domains = null, sources = null) {
  const parts = ['h.userId = @userId'];
  const args = { userId };
  // Where the highlighted article came from ('kindle', 'android-share', …), so
  // the highlights page can be narrowed to one import.
  if (sources && sources.length) {
    parts.push(`a.source IN (${sources.map((_, i) => `@hsrc${i}`).join(', ')})`);
    sources.forEach((s, i) => { args[`hsrc${i}`] = String(s); });
  }
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
 * Bare terms are prefix-matched; a double-quoted phrase matches exactly and in
 * order. Assumes the articles table is aliased
 * `a`; the highlights subquery needs no user check of its own, since `a` is
 * always already scoped to one user. Returns null when there are no terms.
 */
/**
 * Split a query into terms, honouring double-quoted phrases: `booker "han kang"`
 * yields the bare term `booker` and the phrase `han kang`.
 *
 * Splitting on whitespace first (as this used to) tore a quoted phrase into
 * `"han` and `kang"`, whose quotes the escaping then neutralised — so a phrase
 * search silently became two independent prefix terms. That is worse than it
 * sounds, because a bare term is prefix-matched: `han*` also hits "handed" and
 * "handle", which any long article contains, so `"han kang"` matched more or
 * less anything mentioning Kang.
 *
 * An unclosed quote is treated as ordinary text rather than swallowing the rest
 * of the query.
 */
function parseQueryTerms(q) {
  const out = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(q == null ? '' : q)))) {
    if (m[1] != null) {
      const t = m[1].trim();
      if (t) out.push({ text: t, phrase: true });
    } else {
      const t = m[2].replace(/"/g, '').trim(); // stray quote from an unclosed pair
      if (t) out.push({ text: t, phrase: false });
    }
  }
  return out;
}

/**
 * One FTS5 expression per parsed term. A phrase matches those words adjacent
 * and in order; a bare term keeps the trailing `*` so partial words still find
 * things as you type.
 */
function ftsExpr(t) {
  const esc = String(t.text).replace(/"/g, '""');
  return t.phrase ? `"${esc}"` : `"${esc}"*`;
}

function ftsMatch(q) {
  const terms = parseQueryTerms(q);
  if (!terms.length) return null;
  const args = {};
  // One rowid set per term, the highlight matches converted to article rowids
  // inside it. This used to be `rowid IN (…) OR id IN (…)`, and the OR made
  // SQLite test every one of the user's articles — reading each one's table
  // row to get its id, because id isn't in the userId indexes. With everything
  // as a rowid set the indexes answer it alone (rowid rides along in every
  // index entry), so a search no longer reads the whole articles table off the
  // disk: on the 512 MB machine, where it can't stay cached, that took tens of
  // seconds and stalled every other request behind it.
  const clause = terms.map((t, i) => {
    const k = `match${i}`;
    args[k] = ftsExpr(t);
    return `a.rowid IN (SELECT rowid FROM articles_fts WHERE articles_fts MATCH @${k}
      UNION SELECT a2.rowid FROM highlights hq JOIN articles a2 ON a2.id = hq.articleId
            WHERE hq.rowid IN (SELECT rowid FROM highlights_fts WHERE highlights_fts MATCH @${k}))`;
  }).join(' AND ');
  return { clause, args };
}

// ------------------------------------------------------------ related articles

/** Words too common to say what an article is about (beyond the idf cut). */
const STOPWORDS = new Set(`
  about above after again against also although always among another anyone anything around
  because been before being below between both came cannot could does doing done down during each
  either else enough even ever every first from further gets getting give given goes going gone
  good great have having here hers herself himself however into itself just keep know known last
  least less like likely little long made make makes making many maybe might more most much must
  myself never next nothing often once only other others otherwise ours ourselves over own part
  people perhaps please put quite rather really said same saying says seem seemed seems several
  shall should show since some something sometimes soon still such take taken than that their
  theirs them themselves then there these they thing things think this those though three through
  thus time times today together told took toward towards under until upon used using very want
  wants well were what whatever when where whether which while whom whose will with within without
  work would year years your yours yourself also just like said says want get got new one two
`.split(/\s+/).filter(Boolean));

/** Roughly FTS5's unicode61 tokenizer: lower case, diacritics removed. */
const tokenize = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().split(/[^\p{L}\p{N}]+/u);

/**
 * A crude stem, so "ploughing", "ploughed" and "ploughs" count as one term
 * instead of crowding every other word out of the list. Null when stripping
 * would leave too little to prefix-match safely ("dates" → "dat" would match
 * "data"); such a word is matched exactly instead.
 */
const stemOf = (t) => {
  const s = t.replace(/(?:ies|ing|ed|es|ly|s)$/, '');
  return s.length >= 5 ? s : null;
};

/**
 * The terms that say what an article is about: frequent in it (title words
 * count extra) and rare across the library. dfOf(word) is the number of
 * articles containing the word. Each term comes back as
 * { display, expr (an FTS5 expression), weight }.
 */
function distinctiveTerms({ title, textContent }, docs, dfOf, max = 12) {
  const groups = new Map();
  const add = (text, weight) => {
    for (const t of tokenize(text)) {
      if (t.length < 4 || t.length > 30 || /^\d+$/.test(t) || STOPWORDS.has(t)) continue;
      const stem = stemOf(t);
      const key = stem || t;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { key, prefix: !!stem, tf: 0, forms: new Map() }));
      g.tf += weight;
      g.forms.set(t, (g.forms.get(t) || 0) + weight);
    }
  };
  add(title, 4);
  add(String(textContent || '').slice(0, 60000), 1);
  const scored = [];
  for (const g of [...groups.values()].sort((x, y) => y.tf - x.tf).slice(0, 80)) {
    if (g.tf < 2) continue;
    const df = Math.max(...[...g.forms.keys()].map(dfOf));
    if (df < 2) continue;                        // in no other article
    if (docs >= 50 && df > docs * 0.2) continue; // too common to mean anything
    const display = [...g.forms].sort((x, y) => y[1] - x[1])[0][0];
    const word = (g.prefix ? g.key : display).replace(/"/g, '""');
    scored.push({
      display,
      expr: g.prefix ? `"${word}"*` : `"${word}"`,
      weight: (1 + Math.log(g.tf)) * Math.log(1 + docs / df),
    });
  }
  return scored.sort((x, y) => y.weight - x.weight).slice(0, max);
}

/** A related article must share at least this many of the terms… */
const RELATED_MIN_SHARED = 2;
/** …weighing at least this fraction of the article's top three terms together.
 *  Stops one rare name in passing (a painter's article that mentions Pétain)
 *  from pulling in everything else about it. */
const RELATED_MIN_STRENGTH = 0.45;

/** Library size per database, for idf. Refreshed every few minutes. */
const docCounts = new WeakMap();

function open(dataDir) {
  const file = path.join(dataDir, 'readlater.db');
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');
  // SQLite defaults to a ~2MB page cache. This database is several GB on a
  // network-backed volume and its rows are huge (html, textContent and
  // sourceHtml all sit inline), so at the default nearly every query pages in
  // from disk and the whole server -- which is single-threaded and synchronous
  // -- stalls behind it. Negative cache_size is KiB, so this is 64MB. mmap
  // costs address space rather than resident memory, and lets reads come
  // straight from the page cache instead of being copied through a buffer.
  sqlite.pragma('cache_size = -65536');
  sqlite.pragma('mmap_size = 268435456');
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
  // When an article was archived, for the Archive list's ordering. Backfilled
  // from updatedAt for rows archived before the column existed — the best
  // approximation available, and what the Android app already falls back to.
  if (!articleCols.includes('archivedAt')) {
    sqlite.exec("ALTER TABLE articles ADD COLUMN archivedAt INTEGER");
    // Deliberately NOT backfilled with an UPDATE: every article row carries its
    // html/textContent/sourceHtml inline, so rewriting 20k+ rows would move
    // gigabytes to set one integer. Rows archived before this column existed
    // fall back to updatedAt in the ordering below instead — the same
    // approximation the Android app makes.
  }
  // Created here (not in SCHEMA) for the same reason as the shareId index: on a
  // database predating the column the CREATE would run before the ALTER above.
  // The expression must match ARTICLE_SORTS.newestArchived exactly for SQLite to
  // order from the index rather than sorting the whole archive on every page.
  sqlite.exec(`CREATE INDEX IF NOT EXISTS articles_user_archived_at
    ON articles(userId, archived, COALESCE(archivedAt, updatedAt) DESC)`);
  // Same problem for the length sorts: wordCount was added by ALTER TABLE, so
  // it sits past each row's html/textContent/sourceHtml. Ordering by it read
  // most of the database, and because the server is single-threaded and
  // synchronous that one query stalled EVERY other request behind it — which is
  // how an unrelated click (minting a share link) ended up hanging. Ordering
  // from this index touches no article rows but the page being shown.
  sqlite.exec('CREATE INDEX IF NOT EXISTS articles_user_wordcount ON articles(userId, archived, wordCount)');

  // Kindle location (or page) a highlight came from, so an imported highlight
  // points back at its exact spot in the book.
  // A feed's show artwork: null until a check has read it, '' when it has none
  // (feeds.js refetches past a 304 while it is null, to backfill episodes).
  const feedCols = sqlite.prepare('PRAGMA table_info(feeds)').all().map((c) => c.name);
  if (!feedCols.includes('imageUrl')) {
    sqlite.exec('ALTER TABLE feeds ADD COLUMN imageUrl TEXT');
  }
  // Off: new episodes wait on the Settings page for you to pick, rather than
  // being downloaded and transcribed as they arrive.
  if (!feedCols.includes('autoProcess')) {
    sqlite.exec('ALTER TABLE feeds ADD COLUMN autoProcess INTEGER NOT NULL DEFAULT 1');
  }
  // A waiting episode (pending = 1) keeps what is needed to take it later
  // without re-reading the feed, which may have dropped it by then.
  const itemCols = sqlite.prepare('PRAGMA table_info(feed_items)').all().map((c) => c.name);
  for (const [col, type] of [['pending', 'INTEGER NOT NULL DEFAULT 0'], ['title', 'TEXT'],
    ['url', 'TEXT'], ['publishedAt', 'INTEGER'], ['durationS', 'INTEGER'], ['imageUrl', 'TEXT']]) {
    if (!itemCols.includes(col)) sqlite.exec(`ALTER TABLE feed_items ADD COLUMN ${col} ${type}`);
  }
  const highlightCols = sqlite.prepare('PRAGMA table_info(highlights)').all().map((c) => c.name);
  if (!highlightCols.includes('location')) {
    sqlite.exec("ALTER TABLE highlights ADD COLUMN location TEXT");
  }
  // Created here rather than in SCHEMA: on a database predating the column, the
  // CREATE INDEX in SCHEMA would run before the ALTER above and fail outright.
  // Unique so a slug can never resolve to two articles; SQLite treats NULLs as
  // distinct, so any number of unshared articles coexist.
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS articles_share ON articles(shareId)');
  // The "From phone" list filters on source; without this, its count reads
  // every (blob-laden) row of the account. Same reasoning as articles_user_arch_saved.
  sqlite.exec('CREATE INDEX IF NOT EXISTS articles_user_source ON articles(userId, source)');
  // Per-term document counts straight from the FTS index (no copy of the data),
  // so "how rare is this word" is one index lookup — see distinctiveTerms.
  sqlite.exec("CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts_vocab USING fts5vocab(articles_fts, 'row')");
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

  /** Write (or clear) an article's badly-saved flag (see quality.js). */
  function setProblem(id, userId, problem) {
    if (!problem) {
      prep('pdel', 'DELETE FROM article_problems WHERE articleId = ?').run(id);
      return;
    }
    prep('pset', `INSERT INTO article_problems (articleId, userId, reason, detail, detectedAt)
      VALUES (@articleId, @userId, @reason, @detail, @detectedAt)
      ON CONFLICT(articleId) DO UPDATE SET reason = @reason, detail = @detail, detectedAt = @detectedAt`)
      .run({
        articleId: id,
        userId,
        reason: String(problem.reason),
        detail: String(problem.detail || ''),
        detectedAt: Date.now(),
      });
  }

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
    /** Owner and archived flag by id alone, for sweeping files kept per
     *  article. Both sit ahead of the content blobs. Undefined if gone. */
    articleState: (id) => prep('ast', 'SELECT userId, archived FROM articles WHERE id = ?').get(id),
    getArticle: (id, userId) =>
      rowArticle(prep('ag', `SELECT ${ARTICLE_COLS} FROM articles WHERE id = ? AND userId = ?`).get(id, userId)),
    /** Raw captured source for reparse / "view original". Returns '' when none. */
    getArticleSource: (id, userId) =>
      (prep('ags', 'SELECT sourceHtml FROM articles WHERE id = ? AND userId = ?').get(id, userId) || {}).sourceHtml || '',
    articleByUrl: (userId, url) =>
      rowArticle(prep('abu', `SELECT ${ARTICLE_COLS} FROM articles WHERE userId = ? AND url = ?`).get(userId, url)),
    /** Recent phone saves, for the extension's automatic re-save. Only id/url/
     *  savedAt are read, all ahead of the content blobs, and source is covered
     *  by articles_user_source — so this never walks overflow pages. */
    resaveCandidates: (userId, sinceSavedAt) =>
      prep('resaveCands', `SELECT id, url FROM articles
        WHERE userId = ? AND source = 'android-share' AND savedAt >= ?
        ORDER BY savedAt DESC LIMIT 1000`).all(userId, sinceSavedAt),
    // Deliberately NOT scoped to a user: the whole point of a share slug is
    // that whoever holds it can read the article without being anyone.
    articleByShareId: (shareId) =>
      rowArticle(prep('abs', `SELECT ${ARTICLE_COLS} FROM articles WHERE shareId = ?`).get(shareId)),
    /** Publish (shareId) or revoke (null). Scoped to the owner. */
    /** Just the share slug (and proof the article is this user's). The article
     *  rows carry html/textContent inline, so loading a whole article to read
     *  one short column pulled the entire body off the volume — which is what
     *  made the Share button sit there with an empty box. Returns undefined
     *  when there is no such article for this user. */
    articleShareId: (id, userId) =>
      prep('agsi', 'SELECT shareId FROM articles WHERE id = ? AND userId = ?').get(id, userId),
    setArticleShareId: (id, userId, shareId) =>
      prep('assh', 'UPDATE articles SET shareId = ? WHERE id = ? AND userId = ?').run(shareId, id, userId),
    insertArticle: (a) => {
      const r = prep('ai', `INSERT INTO articles
      (id, userId, url, domain, savedAt, archived, favorite, readParagraph, title, byline, siteName, excerpt, html, textContent, sourceHtml, imageUrl, publishedAt, source, wordCount, archivedAt, updatedAt)
      VALUES (@id, @userId, @url, @domain, @savedAt, @archived, @favorite, @readParagraph, @title, @byline, @siteName, @excerpt, @html, @textContent, @sourceHtml, @imageUrl, @publishedAt, @source, @wordCount, @archivedAt, @updatedAt)`)
      // An article created straight into the archive (a Kindle book, an
      // importer) is archived as of now unless the caller says otherwise.
        .run({ imageUrl: null, publishedAt: null, sourceHtml: null, source: null, ...a, ...articleIdentity(a), archived: a.archived ? 1 : 0, favorite: a.favorite ? 1 : 0, archivedAt: a.archived ? (a.archivedAt || a.updatedAt || a.savedAt) : null, textContent: searchText(a), wordCount: articleWordCount(a) });
      setProblem(a.id, a.userId, quality.detectProblem({ ...a, textContent: searchText(a) }));
      return r;
    },
    // Update content; only overwrites imageUrl/publishedAt/sourceHtml when new ones are provided.
    updateArticleContent: (id, f) => {
      const r = prep('auc', `UPDATE articles SET
      title = @title, byline = @byline, siteName = @siteName, excerpt = @excerpt,
      html = @html, textContent = @textContent, imageUrl = COALESCE(@imageUrl, imageUrl),
      publishedAt = COALESCE(@publishedAt, publishedAt), sourceHtml = COALESCE(@sourceHtml, sourceHtml),
      wordCount = @wordCount, updatedAt = @updatedAt WHERE id = @id`)
        .run({ imageUrl: null, publishedAt: null, sourceHtml: null, ...f, id, textContent: searchText(f), wordCount: articleWordCount(f) });
      // Re-decided from the content that just landed, so a re-save or a reparse
      // that fixes an article also clears its flag (and a fetch that fails on
      // retry re-raises it). Reads only the early columns.
      const meta = prep('aucm', 'SELECT userId, url, source FROM articles WHERE id = ?').get(id);
      if (meta) {
        setProblem(id, meta.userId, quality.detectProblem({
          ...f, textContent: searchText(f), url: meta.url, source: meta.source,
        }));
      }
      return r;
    },
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
        -- Stamped when this patch archives the article, cleared when it
        -- unarchives, and left alone by patches that touch neither (a reading
        -- position write must not reorder the archive).
        archivedAt = CASE
          WHEN @archived IS NULL THEN archivedAt
          WHEN @archived = 1 THEN @updatedAt
          ELSE NULL END,
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
      prep('bab', 'UPDATE articles SET archived = 1, archivedAt = @now, updatedAt = @now WHERE userId = @userId AND archived = 0 AND savedAt < @before')
        .run({ userId, before: beforeMs, now }).changes,

    deleteArticle: (id) => {
      prep('adh', 'DELETE FROM highlights WHERE articleId = ?').run(id);
      prep('adp', 'DELETE FROM article_problems WHERE articleId = ?').run(id);
      prep('ada', 'DELETE FROM article_audio WHERE articleId = ?').run(id);
      return prep('ad', 'DELETE FROM articles WHERE id = ?').run(id);
    },

    /** Why this article is flagged as badly saved, or undefined. */
    articleProblem: (id) =>
      prep('agp', 'SELECT reason, detail, detectedAt FROM article_problems WHERE articleId = ?').get(id),

    /** Articles flagged for this user, newest first (id + url + why). */
    listProblems: (userId, limit = 1000) =>
      prep('alp', `SELECT p.articleId AS id, p.reason, p.detail, a.url, a.title
        FROM article_problems p JOIN articles a ON a.id = p.articleId
        WHERE p.userId = ? ORDER BY p.detectedAt DESC LIMIT ?`).all(userId, limit),

    countProblems: (userId) =>
      prep('acp', 'SELECT COUNT(*) AS n FROM article_problems WHERE userId = ?').get(userId).n,

    /** Flag or unflag by hand — the list's "this one is fine" / "this is bad". */
    setArticleProblem: (id, userId, problem) => setProblem(id, userId, problem),

    // ---------------- podcast subscriptions (feeds.js)

    listFeeds: (userId) =>
      prep('flf', `SELECT f.*, (SELECT COUNT(*) FROM feed_items i WHERE i.feedId = f.id AND i.articleId IS NOT NULL) AS episodes,
        (SELECT COUNT(*) FROM feed_items i WHERE i.feedId = f.id AND i.pending = 1) AS pendingCount
        FROM feeds f WHERE f.userId = ? ORDER BY f.addedAt DESC`).all(userId),

    /** Every feed, for the poller — it runs for all users at once. */
    listAllFeeds: () => prep('flall', 'SELECT * FROM feeds ORDER BY addedAt').all(),

    feedByUrl: (userId, url) =>
      prep('fbu', 'SELECT * FROM feeds WHERE userId = ? AND url = ?').get(userId, String(url)),

    getFeed: (id, userId) =>
      prep('fg', 'SELECT * FROM feeds WHERE id = ? AND userId = ?').get(id, userId),

    insertFeed: (f) => prep('fi', `INSERT INTO feeds (id, userId, url, title, addedAt, autoProcess)
      VALUES (@id, @userId, @url, @title, @addedAt, @autoProcess)`)
      .run({ title: null, ...f, autoProcess: f.autoProcess === false ? 0 : 1 }),

    setFeedAutoProcess: (id, userId, on) =>
      prep('fap', 'UPDATE feeds SET autoProcess = ? WHERE id = ? AND userId = ?').run(on ? 1 : 0, id, userId).changes,

    /** Note a new episode without taking it (a feed with autoProcess off). */
    addPendingFeedItem: (feedId, item) =>
      prep('fipa', `INSERT OR IGNORE INTO feed_items
        (feedId, guid, articleId, seenAt, pending, title, url, publishedAt, durationS, imageUrl)
        VALUES (@feedId, @guid, NULL, @seenAt, 1, @title, @url, @publishedAt, @durationS, @imageUrl)`)
        .run({
          feedId, guid: String(item.guid).slice(0, 500), seenAt: Date.now(),
          title: item.title || null, url: item.url, publishedAt: item.publishedAt ?? null,
          durationS: item.durationS ?? null, imageUrl: item.imageUrl || null,
        }).changes,

    /** Waiting episodes, newest first. */
    listPendingFeedItems: (feedId, limit = 50) =>
      prep('fipl', `SELECT guid, title, url, publishedAt, durationS, imageUrl FROM feed_items
        WHERE feedId = ? AND pending = 1 ORDER BY COALESCE(publishedAt, seenAt) DESC LIMIT ?`).all(feedId, limit),

    getPendingFeedItem: (feedId, guid) =>
      prep('fipg', `SELECT guid, title, url, publishedAt, durationS, imageUrl FROM feed_items
        WHERE feedId = ? AND guid = ? AND pending = 1`).get(feedId, String(guid)),

    /** Stop offering a waiting episode (dismissed, or taken). */
    clearPendingFeedItem: (feedId, guid) =>
      prep('fipc', 'UPDATE feed_items SET pending = 0 WHERE feedId = ? AND guid = ?').run(feedId, String(guid)).changes,

    /** Offer an archived (dismissed) episode again — undo. Only one never
     *  taken, and only one that kept what is needed to take it. */
    restorePendingFeedItem: (feedId, guid) =>
      prep('fipr', `UPDATE feed_items SET pending = 1
        WHERE feedId = ? AND guid = ? AND articleId IS NULL AND url IS NOT NULL`).run(feedId, String(guid)).changes,

    /** Every waiting episode across a user's feeds, newest first — the
     *  phone's Podcasts tab, where they are picked. */
    listUserPendingFeedItems: (userId, limit = 500) =>
      prep('fipu', `SELECT i.feedId, i.guid, i.title, i.url, i.publishedAt, i.durationS, i.imageUrl, i.seenAt
        FROM feed_items i JOIN feeds f ON f.id = i.feedId
        WHERE f.userId = ? AND i.pending = 1
        ORDER BY COALESCE(i.publishedAt, i.seenAt) DESC LIMIT ?`).all(userId, limit),

    /** Which show each taken episode came from: [{articleId, feedId}]. Small
     *  rows, and no join on articles (their html sits in the same rows). */
    listUserFeedEpisodes: (userId) =>
      prep('fieu', `SELECT i.articleId, i.feedId FROM feed_items i JOIN feeds f ON f.id = i.feedId
        WHERE f.userId = ? AND i.articleId IS NOT NULL`).all(userId),

    deleteFeed: (id, userId) =>
      prep('fd', 'DELETE FROM feeds WHERE id = ? AND userId = ?').run(id, userId).changes,

    /** Record the outcome of a check. Only the fields given are written. */
    touchFeed: (id, { checkedAt, title, imageUrl, etag, lastModified, error } = {}) =>
      prep('ft', `UPDATE feeds SET
        lastCheckedAt = COALESCE(@checkedAt, lastCheckedAt),
        title = COALESCE(@title, title),
        imageUrl = COALESCE(@imageUrl, imageUrl),
        etag = @etag, lastModified = @lastModified, lastError = @error
        WHERE id = @id`)
        .run({
          id,
          checkedAt: checkedAt ?? null,
          title: title ?? null,
          imageUrl: imageUrl ?? null,
          etag: etag ?? null,
          lastModified: lastModified ?? null,
          error: error ?? null,
        }),

    feedItemSeen: (feedId, guid) =>
      !!prep('fis', 'SELECT 1 FROM feed_items WHERE feedId = ? AND guid = ?').get(feedId, String(guid)),

    markFeedItemSeen: (feedId, guid, articleId) =>
      prep('fim', `INSERT INTO feed_items (feedId, guid, articleId, seenAt)
        VALUES (@feedId, @guid, @articleId, @seenAt)
        ON CONFLICT(feedId, guid) DO UPDATE SET articleId = COALESCE(@articleId, articleId), pending = 0`)
        .run({ feedId, guid: String(guid).slice(0, 500), articleId: articleId ?? null, seenAt: Date.now() }),

    /** Give episodes already taken from a feed their artwork — only those
     *  with none, so an image set since is never overwritten. updatedAt moves
     *  so the app's next sync picks the change up. Returns how many changed. */
    backfillFeedArt: (feedId, items) => {
      const upd = prep('fart', `UPDATE articles SET imageUrl = @imageUrl, updatedAt = @now
        WHERE imageUrl IS NULL
          AND id = (SELECT articleId FROM feed_items WHERE feedId = @feedId AND guid = @guid)`);
      const now = Date.now();
      let n = 0;
      sqlite.transaction(() => {
        for (const { guid, imageUrl } of items) {
          if (imageUrl) n += upd.run({ feedId, guid: String(guid).slice(0, 500), imageUrl, now }).changes;
        }
      })();
      return n;
    },

    /** Artwork of the user's subscribed show with this name ('' if none) — for
     *  an episode shared from a player whose file carries no cover art. */
    feedArtByTitle: (userId, title) =>
      (title && (prep('fabt', `SELECT imageUrl FROM feeds
        WHERE userId = ? AND title = ? COLLATE NOCASE AND imageUrl != '' LIMIT 1`)
        .get(userId, String(title)) || {}).imageUrl) || '',

    /** Mark a whole feed's current contents as already seen — what subscribing
     *  does, so nothing from the back catalogue is imported. */
    markFeedItemsSeen: (feedId, guids) => {
      const ins = prep('fimb', `INSERT INTO feed_items (feedId, guid, articleId, seenAt)
        VALUES (?, ?, NULL, ?) ON CONFLICT(feedId, guid) DO NOTHING`);
      const now = Date.now();
      sqlite.transaction(() => {
        for (const g of guids) ins.run(feedId, String(g).slice(0, 500), now);
      })();
      return guids.length;
    },

    /** Where an article's episode audio can be downloaded from ('' if nowhere). */
    articleAudioUrl: (id) =>
      (prep('aau', 'SELECT url FROM article_audio WHERE articleId = ?').get(id) || {}).url || '',

    setArticleAudioUrl: (id, url, durationS) =>
      prep('aas', `INSERT INTO article_audio (articleId, url, durationS, addedAt)
        VALUES (@id, @url, @durationS, @addedAt)
        ON CONFLICT(articleId) DO UPDATE SET url = @url, durationS = COALESCE(@durationS, durationS)`)
        .run({ id, url: String(url), durationS: durationS ?? null, addedAt: Date.now() }),

    /**
     * Search/filter a user's articles (metadata only — html/textContent never
     * leave the database here). All filters optional; newest first.
     */
    searchArticles: (userId, filters = {}) => {
      const { where, args } = buildArticleWhere(userId, filters);
      const sortKey = ARTICLE_SORTS[filters.sort] ? filters.sort : 'newest';
      if (sortKey === 'random') args.seed = String(filters.seed || '');
      const order = ARTICLE_SORTS[sortKey];
      const cols = `a.id, a.userId, a.url, a.domain, a.savedAt, a.archived, a.favorite, a.readParagraph,
          a.ttsParagraph, a.title, a.byline, a.siteName, a.excerpt, a.imageUrl, a.publishedAt, a.wordCount,
          a.shareId, a.source, a.updatedAt,
          (SELECT p.detail FROM article_problems p WHERE p.articleId = a.id) AS problemDetail,
          (SELECT au.url FROM article_audio au WHERE au.articleId = a.id) AS audioUrl`;
      const lim = Number(filters.limit) || 0;
      if (lim <= 0) {
        // Unpaged (exports, sync): nothing to gain from the two-step below.
        return sqlite.prepare(`SELECT ${cols} FROM articles a
          WHERE ${where.join(' AND ')} ORDER BY ${order}`).all(args).map(rowArticle);
      }
      args.limit = lim;
      args.offset = Math.max(0, Number(filters.offset) || 0);
      // Pick the page by id FIRST, then read the columns for just those rows.
      //
      // Every article stores html/textContent/sourceHtml inline, and most of the
      // metadata this selects (updatedAt, wordCount, imageUrl, source, …) was
      // added by ALTER TABLE, so it lives PAST those blobs in the record. Naming
      // those columns in a query that matches thousands of rows made SQLite walk
      // every match's overflow-page chain just to build a 50-row page — which is
      // what made a search of a 24k-article library take tens of seconds. The
      // inner query touches only id plus the sort key (savedAt and the FTS
      // rowids are early/indexed), so the overflow reads drop from "every match"
      // to "the fifty rows actually shown".
      // The page is picked by rowid, not id: rowid is in every index entry and
      // id is not, so when the filters and sort are indexed the inner query
      // never opens a table row at all.
      return sqlite.prepare(`WITH page AS (
          SELECT a.rowid AS rid FROM articles a
          WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT @limit OFFSET @offset
        )
        SELECT ${cols} FROM articles a JOIN page ON page.rid = a.rowid ORDER BY ${order}`)
        .all(args).map(rowArticle);
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
    /**
     * Highlighted articles related to one article, for the web reader's
     * "Related" panel. The article's most distinctive terms are OR-searched
     * against everything the user highlighted (the passages they chose to
     * keep) and against the highlighted articles themselves (title weighted
     * most), and the two bm25 rankings are blended. Null when the article isn't
     * the user's.
     */
    relatedHighlighted: (userId, articleId, { limit = 8 } = {}) => {
      const src = prep('relSrc', 'SELECT title, textContent FROM articles WHERE id = ? AND userId = ?').get(articleId, userId);
      if (!src) return null;
      let docs = docCounts.get(sqlite);
      if (!docs || Date.now() - docs.at > 10 * 60 * 1000) {
        docs = { n: prep('relDocs', 'SELECT COUNT(*) c FROM articles').get().c, at: Date.now() };
        docCounts.set(sqlite, docs);
      }
      const dfStmt = prep('relDf', 'SELECT doc FROM articles_fts_vocab WHERE term = ?');
      const terms = distinctiveTerms(src, docs.n, (t) => (dfStmt.get(t) || {}).doc || 0);
      const display = terms.map((t) => t.display);
      if (!terms.length) return { terms: display, articles: [] };

      const q = terms.map((t) => t.expr).join(' OR ');
      const bind = { q, userId, id: articleId };
      const hlRows = prep('relHl', `SELECT h.articleId, h.text, h.note, bm25(highlights_fts) AS s
        FROM highlights_fts JOIN highlights h ON h.rowid = highlights_fts.rowid
        WHERE highlights_fts MATCH @q AND h.userId = @userId AND h.articleId != @id
        ORDER BY s LIMIT 300`).all(bind);
      // bm25 weights follow the FTS columns: title, byline, siteName, excerpt, textContent.
      const artRows = prep('relArt', `SELECT a.id, bm25(articles_fts, 8.0, 0.5, 0.5, 2.0, 1.0) AS s
        FROM articles_fts JOIN articles a ON a.rowid = articles_fts.rowid
        WHERE articles_fts MATCH @q AND a.userId = @userId AND a.id != @id
          AND EXISTS (SELECT 1 FROM highlights hx WHERE hx.articleId = a.id)
        ORDER BY s LIMIT 300`).all(bind);

      // bm25 is negative, best first: dividing by the best score puts each
      // ranking on a 0–1 scale so the two can be added.
      const scaled = (s, rows) => (rows.length && rows[0].s < 0 ? s / rows[0].s : 0);
      const byArticle = new Map();
      const entry = (id) => {
        if (!byArticle.has(id)) byArticle.set(id, { id, art: 0, hls: [] });
        return byArticle.get(id);
      };
      for (const r of artRows) entry(r.id).art = scaled(r.s, artRows);
      for (const r of hlRows) entry(r.articleId).hls.push({ text: r.text, note: r.note, w: scaled(r.s, hlRows) });
      const ranked = [...byArticle.values()]
        .map((e) => ({ ...e, score: e.art + 0.7 * e.hls.slice(0, 3).reduce((sum, h) => sum + h.w, 0) }))
        .sort((x, y) => y.score - x.score);
      // An OR query ranks a single strong word highly. Check, for the leading
      // candidates, which terms each one really shares — in its own text or its
      // highlights — and keep only those sharing enough of what this article is about.
      const pool = ranked.slice(0, 40);
      if (!pool.length) return { terms: display, articles: [] };
      const cph = pool.map((_, i) => `@c${i}`).join(', ');
      const cands = Object.fromEntries(pool.map((e, i) => [`c${i}`, e.id]));
      const artHas = sqlite.prepare(`SELECT a.id FROM articles_fts JOIN articles a ON a.rowid = articles_fts.rowid
        WHERE articles_fts MATCH @expr AND a.id IN (${cph})`);
      const hlHas = sqlite.prepare(`SELECT DISTINCT h.articleId AS id FROM highlights_fts JOIN highlights h ON h.rowid = highlights_fts.rowid
        WHERE highlights_fts MATCH @expr AND h.articleId IN (${cph})`);
      const shared = new Map(pool.map((e) => [e.id, []]));
      for (const t of terms) {
        const bindT = { ...cands, expr: t.expr };
        const hits = new Set([...artHas.all(bindT), ...hlHas.all(bindT)].map((r) => r.id));
        for (const id of hits) shared.get(id).push(t);
      }
      const topWeight = terms.slice(0, 3).reduce((sum, t) => sum + t.weight, 0) || 1;
      const picked = pool
        .map((e) => {
          const ts = shared.get(e.id);
          const strength = ts.reduce((sum, t) => sum + t.weight, 0) / topWeight;
          return { ...e, matched: ts.map((t) => t.display), strength, final: e.score * Math.min(1, strength) };
        })
        .filter((e) => e.matched.length >= RELATED_MIN_SHARED && e.strength >= RELATED_MIN_STRENGTH)
        .sort((x, y) => y.final - x.final)
        .slice(0, limit);
      if (!picked.length) return { terms: display, articles: [] };

      const ph = picked.map((_, i) => `@r${i}`).join(', ');
      const ids = Object.fromEntries(picked.map((e, i) => [`r${i}`, e.id]));
      // Early columns only — never the content blobs.
      const meta = new Map(sqlite.prepare(`SELECT id, title, siteName FROM articles WHERE id IN (${ph})`)
        .all(ids).map((r) => [r.id, r]));
      const counts = new Map(sqlite.prepare(`SELECT articleId, COUNT(*) n FROM highlights WHERE articleId IN (${ph}) GROUP BY articleId`)
        .all(ids).map((r) => [r.articleId, r.n]));
      const clip = (s) => (s && s.length > 280 ? `${s.slice(0, 280)}…` : s);
      const hfa = prep('relFirstHls', 'SELECT text, note FROM highlights WHERE articleId = ? ORDER BY createdAt LIMIT 2');
      return {
        terms: display,
        articles: picked.filter((e) => meta.has(e.id)).map((e) => ({
          id: e.id,
          title: meta.get(e.id).title,
          siteName: meta.get(e.id).siteName,
          highlightCount: counts.get(e.id) || 0,
          matched: e.matched,
          // The highlights that matched, best first; otherwise its first ones.
          snippets: (e.hls.length ? e.hls.slice(0, 2) : hfa.all(e.id))
            .map((h) => ({ text: clip(h.text), note: clip(h.note) || null })),
        })),
      };
    },
    highlightCountForArticle: (articleId) =>
      prep('hlCountArticle', 'SELECT COUNT(*) c FROM highlights WHERE articleId = ?').get(articleId).c,
    highlightsForArticle: (articleId) =>
      prep('hfa', 'SELECT * FROM highlights WHERE articleId = ? ORDER BY createdAt').all(articleId),
    highlightsForUser: (userId) => prep('hfu', `SELECT h.*, a.title articleTitle, a.url articleUrl,
        a.source articleSource, a.byline articleByline
      FROM highlights h LEFT JOIN articles a ON a.id = h.articleId
      WHERE h.userId = ? ORDER BY h.createdAt DESC`).all(userId),
    /** Articles that have highlights, with counts — for the highlights page. */
    highlightedArticles: (userId, { q = '', domain = '', domains = null, sources = null, sort = 'recent', seed = '', limit = 0, offset = 0 } = {}) => {
      const { where, args } = hlWhere(userId, q, domain, domains, sources);
      const sortKey = HL_SORTS[sort] ? sort : 'recent';
      if (sortKey === 'random') args.seed = String(seed || '');
      const order = HL_SORTS[sortKey];
      // Aggregate, sort and page on the highlights side first; join the full
      // article metadata only for the page actually shown. A single-pass
      // version selected a.wordCount for every group, and wordCount is stored
      // AFTER the inline html/textContent/sourceHtml blobs, so every non-index
      // sort walked each highlighted article's overflow-page chain — reading
      // most of a multi-GB table to render one page (~15s on the production
      // volume). The inner join still references only a.id (a covering index
      // probe) unless a domain filter or title sort needs a's cheap early
      // columns; every sort key except title comes from highlights alone.
      let inner = `SELECT h.articleId AS id, COUNT(h.id) AS n, MAX(h.createdAt) AS lastHighlightAt
          FROM highlights h JOIN articles a ON a.id = h.articleId
          WHERE ${where} GROUP BY h.articleId ORDER BY ${order}`;
      if (limit > 0) { inner += ' LIMIT @limit OFFSET @offset'; args.limit = limit; args.offset = Math.max(0, offset); }
      // The outer ORDER BY re-sorts the page: SQLite does not promise the join
      // preserves the subquery's order. The same sort expressions resolve here
      // (n / lastHighlightAt as output columns, a.title / a.id via the join).
      return sqlite.prepare(`SELECT a.id, a.title, a.siteName, a.domain, a.savedAt, a.wordCount,
          g.n AS n, g.lastHighlightAt AS lastHighlightAt
        FROM (${inner}) g JOIN articles a ON a.id = g.id ORDER BY ${order}`).all(args);
    },
    highlightedArticlesCount: (userId, { q = '', domain = '', domains = null, sources = null } = {}) => {
      const { where, args } = hlWhere(userId, q, domain, domains, sources);
      return sqlite.prepare(`SELECT COUNT(*) c FROM (SELECT a.id FROM highlights h
        JOIN articles a ON a.id = h.articleId WHERE ${where} GROUP BY a.id)`).get(args).c;
    },
    /** Domains among a user's highlighted articles, with counts (for the filter). */
    // INDEXED BY: without stats the planner probes the id autoindex and reads
    // each article's table row just for domain; the covering index answers it
    // without touching the huge rows. The index is part of SCHEMA, so it is
    // always there for INDEXED BY to name.
    highlightedDomains: (userId) =>
      prep('hld', `SELECT a.domain, COUNT(DISTINCT a.id) n
        FROM highlights h JOIN articles a INDEXED BY articles_id_domain ON a.id = h.articleId
        WHERE h.userId = ? AND a.domain != '' GROUP BY a.domain ORDER BY n DESC`).all(userId),

    highlightCountsByArticle: (userId) => {
      const out = new Map();
      for (const r of prep('hcba', 'SELECT articleId, COUNT(*) n FROM highlights WHERE userId = ? GROUP BY articleId').all(userId)) {
        out.set(r.articleId, r.n);
      }
      return out;
    },
    /**
     * Highlights to preview beside list rows, for the articles on ONE page.
     * Scoped to the given ids rather than the whole account on purpose: this
     * runs on every list render, and the whole-account form reads every
     * highlight the user owns to show a handful of them.
     *
     * Search matches highlight text as well as article text (see ftsMatch), so
     * an article can be in your results because of something you highlighted,
     * with nothing in its title or excerpt to show why. Given [q], the
     * highlights that matched it sort first; otherwise these are simply the
     * first few in reading order.
     */
    highlightSnippetsByArticle: (userId, articleIds, { q = '', perArticle = 2 } = {}) => {
      const out = new Map();
      const ids = (articleIds || []).filter(Boolean);
      if (!ids.length) return out;
      const args = { userId };
      ids.forEach((id, i) => { args[`hs${i}`] = id; });
      // Parsed exactly as the search itself parses it, so a quoted phrase
      // highlights the snippet that actually matched rather than any snippet
      // containing one of its words.
      const terms = parseQueryTerms(q);
      terms.forEach((t, i) => { args[`hm${i}`] = ftsExpr(t); });
      // Matching ALL terms, to mirror how ftsMatch decides an article matched.
      const matched = terms.length
        ? `CASE WHEN ${terms.map((_, i) =>
            `h.rowid IN (SELECT rowid FROM highlights_fts WHERE highlights_fts MATCH @hm${i})`
          ).join(' AND ')} THEN 1 ELSE 0 END`
        : '0';
      const rows = sqlite.prepare(`SELECT h.articleId, h.text, ${matched} AS matched
        FROM highlights h
        WHERE h.userId = @userId AND h.articleId IN (${ids.map((_, i) => `@hs${i}`).join(', ')})
        ORDER BY h.articleId, matched DESC, (h.paragraphIndex IS NULL), h.paragraphIndex, h.createdAt`)
        .all(args);
      for (const r of rows) {
        const cur = out.get(r.articleId);
        if (!cur) out.set(r.articleId, [{ text: r.text, matched: !!r.matched }]);
        else if (cur.length < perArticle) cur.push({ text: r.text, matched: !!r.matched });
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
      (id, userId, clientId, articleId, text, note, paragraphIndex, location, createdAt)
      VALUES (@id, @userId, @clientId, @articleId, @text, @note, @paragraphIndex, @location, @createdAt)`)
      // Defaulted here rather than at every call site: only imports that have a
      // source-side address (Kindle) set it.
      .run({ location: null, ...h }),
    // Re-importing a book refreshes each highlight's source address without
    // touching the highlight itself (its id, note and anchoring all survive).
    setHighlightLocation: (id, userId, location) =>
      prep('hsl', 'UPDATE highlights SET location = @location WHERE id = @id AND userId = @userId')
        .run({ id, userId, location: location || null }),
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

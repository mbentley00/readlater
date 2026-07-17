/**
 * ReadLater web UI — server-rendered pages for the sync server (zero-dep).
 *
 * Routes: /login /signup /logout (accounts), / (article list with
 * inbox/favorites/archive views), /read/:id (reader with highlights),
 * /highlights, /settings (API token for the extension / Android app).
 *
 * Untrusted article HTML is rendered under a strict CSP (scripts blocked,
 * only our own nonce'd script runs); all other user text is escaped.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const skip = require('./skip'); // MIN_PHRASE_CHARS, so the UI and server agree

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='13' font-size='13'%3E%F0%9F%93%9A%3C/text%3E%3C/svg%3E";

const CSS = `
:root { --bg:#faf9f7; --fg:#1a1a18; --muted:#77726a; --card:#ffffff; --line:#e6e2db; --accent:#3d6b52; --accent-fg:#ffffff; --mark:#f4e9c8; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#191a1c; --fg:#e8e6e1; --muted:#96918a; --card:#212326; --line:#33363a; --accent:#7fb99a; --accent-fg:#14150f; --mark:#4a4223; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 Georgia, 'Times New Roman', serif; }
a { color: var(--accent); }
header.site { display:flex; align-items:center; gap:1.25rem; padding:.8rem 1.2rem; border-bottom:1px solid var(--line); font-family: system-ui, sans-serif; }
header.site .brand { font-weight:700; text-decoration:none; color:var(--fg); font-size:1.05rem; }
header.site nav { display:flex; gap:.9rem; flex:1; }
header.site nav a { text-decoration:none; color:var(--muted); font-size:.95rem; }
header.site nav a.active { color:var(--fg); font-weight:600; }
header.site .who { color:var(--muted); font-size:.85rem; display:flex; align-items:center; gap:.6rem; }
header.site .who form { margin:0; }
main { max-width: 46rem; margin: 0 auto; padding: 1.4rem 1.2rem 4rem; }
h1 { font-size:1.5rem; }
.empty { color:var(--muted); text-align:center; margin:4rem 0; font-style:italic; }
ul.articles { list-style:none; padding:0; margin:0; }
ul.articles li { display:flex; gap:.8rem; align-items:flex-start; padding:.85rem .2rem; border-bottom:1px solid var(--line); }
ul.articles .main { flex:1; min-width:0; }
/* og:image thumbnail, mirroring the Android list card */
ul.articles .thumb { flex:none; width:84px; height:84px; object-fit:cover; border-radius:8px; background:var(--line); }
@media (max-width:560px) { ul.articles .thumb { width:56px; height:56px; } }
ul.articles .title { font-size:1.08rem; text-decoration:none; color:var(--fg); font-weight:600; }
ul.articles .title:hover { color:var(--accent); }
.meta { color:var(--muted); font-size:.8rem; font-family: system-ui, sans-serif; margin-top:.15rem; }
.actions { display:flex; gap:.35rem; font-family: system-ui, sans-serif; }
.skip-add { display:flex; gap:.4rem; margin:.6rem 0 .3rem; }
.skip-add input { flex:1; min-width:0; padding:.35rem .5rem; border:1px solid var(--line); border-radius:6px; background:transparent; color:var(--fg); }
ul.skip-rules { list-style:none; padding:0; margin:.5rem 0 0; }
ul.skip-rules li { display:flex; gap:.6rem; align-items:center; padding:.35rem 0; border-bottom:1px solid var(--line); }
ul.skip-rules .phrase { flex:1; min-width:0; color:var(--fg); overflow-wrap:anywhere; }
/* "Never import this text" editor, opened from the reader */
#skip-dialog, #reparse-dialog { position:fixed; inset:0; z-index:80; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; padding:1rem; }
#skip-dialog[hidden], #reparse-dialog[hidden] { display:none; }
.reparse-actions { display:flex; flex-direction:column; gap:.4rem; }
.reparse-actions .act { text-align:left; }
.skip-box { background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:1rem; width:min(34rem,100%); display:flex; flex-direction:column; gap:.6rem; box-shadow:0 8px 30px rgba(0,0,0,.35); }
.skip-box textarea { width:100%; box-sizing:border-box; padding:.5rem; border:1px solid var(--line); border-radius:6px; background:transparent; color:var(--fg); font:1rem/1.4 inherit; resize:vertical; }
.skip-actions { display:flex; gap:.4rem; justify-content:flex-end; }
.skip-box .act[disabled] { opacity:.5; cursor:not-allowed; }
button.act { background:none; border:1px solid var(--line); border-radius:6px; color:var(--muted); cursor:pointer; font-size:.78rem; padding:.15rem .5rem; }
.pager { display:flex; gap:1rem; align-items:center; justify-content:center; margin:1.5rem 0; }
.pager .act { padding:.35rem .8rem; text-decoration:none; }
.pager .act.disabled { opacity:.35; pointer-events:none; }
button.act:hover { color:var(--fg); border-color:var(--muted); }
button.act.fav { border:none; font-size:1rem; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:1.6rem; max-width:22rem; margin:4rem auto; font-family:system-ui,sans-serif; }
.card h1 { margin-top:0; font-size:1.2rem; }
.card label { display:block; font-size:.85rem; color:var(--muted); margin:.8rem 0 .2rem; }
.card input { width:100%; padding:.5rem .6rem; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); font-size:1rem; }
.card button[type=submit] { margin-top:1.1rem; width:100%; padding:.55rem; background:var(--accent); color:var(--accent-fg); border:none; border-radius:6px; font-size:1rem; cursor:pointer; }
.card .alt { font-size:.85rem; color:var(--muted); margin-top:1rem; text-align:center; }
.error { background:#a3333314; border:1px solid #a3333355; color:#c05a5a; border-radius:6px; padding:.5rem .7rem; font-size:.85rem; margin-bottom:.4rem; }
.notice { background:#3d6b5214; border:1px solid #3d6b5255; border-radius:6px; padding:.5rem .7rem; font-size:.85rem; margin-bottom:.4rem; font-family:system-ui,sans-serif; }
article.reader header { margin-bottom:1.6rem; border-bottom:1px solid var(--line); padding-bottom:1rem; }
article.reader h1 { margin:.2rem 0 .4rem; line-height:1.25; }
article.reader img { max-width:100%; height:auto; }
article.reader .content { overflow-wrap:break-word; }
article.reader .content pre { overflow-x:auto; background:var(--card); padding:.8rem; border-radius:8px; font-size:.85rem; }
article.reader .content blockquote { border-left:3px solid var(--line); margin-left:0; padding-left:1rem; color:var(--muted); }
mark[data-hl], mark[data-hl-id] { background:var(--mark); color:inherit; padding:0 .1em; border-radius:2px; }
mark.flash { animation: hlflash 1.6s ease; }
@keyframes hlflash { 0%,100% { background:var(--mark); } 25% { background:var(--accent); color:var(--accent-fg); } }
.hl-panel { position:fixed; top:0; right:0; height:100%; width:min(360px,88vw); background:var(--card); border-left:1px solid var(--line); box-shadow:-4px 0 24px rgba(0,0,0,.15); overflow-y:auto; z-index:50; font-family:system-ui,sans-serif; }
.hl-panel-head { display:flex; align-items:center; justify-content:space-between; padding:.9rem 1rem; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--card); }
.hl-panel-body { padding:.5rem; }
.hl-item { padding:.7rem .8rem; border-radius:8px; cursor:pointer; border:1px solid transparent; }
.hl-item:hover { background:var(--bg); border-color:var(--line); }
.hl-item-text { font-size:.9rem; line-height:1.45; }
.hl-item .note { font-size:.8rem; color:var(--muted); margin-top:.3rem; font-style:italic; }
.hl-item-actions { margin-top:.4rem; }
.hl-block { border-left:3px solid var(--accent); padding:.2rem 0 .2rem 1rem; margin:1rem 0; }
.hl-block .note { color:var(--muted); font-size:.9rem; }
.hl-block .from { font-size:.8rem; font-family:system-ui,sans-serif; margin-top:.2rem; }
.hl-count { font-size:.8rem; font-family:system-ui,sans-serif; color:var(--accent); white-space:nowrap; }
code.token { background:var(--card); border:1px solid var(--line); border-radius:6px; padding:.25rem .5rem; font-size:.85rem; user-select:all; overflow-wrap:anywhere; }
.reader-actions { margin-top:.6rem; }
/* article count on a view chip — present but never louder than the name */
.chip-n { color:var(--muted); font-size:.85em; font-variant-numeric:tabular-nums; }
.view-chip.active .chip-n { color:inherit; opacity:.75; }
form.search { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; font-family:system-ui,sans-serif; font-size:.85rem; margin-bottom:1rem; }
form.search input[type=search] { flex:1; min-width:12rem; padding:.4rem .6rem; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); }
form.search select { padding:.35rem .4rem; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); max-width:14rem; }
form.search label { color:var(--muted); display:flex; gap:.3rem; align-items:center; }
.views { display:flex; gap:.5rem; flex-wrap:wrap; margin-bottom:.8rem; font-family:system-ui,sans-serif; }
.view-chip { display:inline-flex; align-items:center; gap:.15rem; border:1px solid var(--line); border-radius:999px; padding:.15rem .3rem .15rem .7rem; font-size:.85rem; background:var(--card); }
.view-chip.active { border-color:var(--accent); background:var(--accent); }
.view-chip.active a { color:var(--accent-fg); }
.view-chip a { text-decoration:none; color:var(--fg); }
.view-chip .del-view { border:none; font-size:.9rem; padding:0 .3rem; }
form.saveview { display:flex; gap:.5rem; margin:.6rem 0 0; font-family:system-ui,sans-serif; }
form.saveview input[name=name] { padding:.3rem .5rem; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); font-size:.85rem; }
#hl-tip, #hl-menu { position:absolute; z-index:60; }
#hl-tip button, #hl-menu button { background:var(--accent); color:var(--accent-fg); border:none; border-radius:6px; padding:.35rem .8rem; cursor:pointer; font:.85rem system-ui,sans-serif; box-shadow:0 2px 8px rgba(0,0,0,.25); }
#hl-tip button + button, #hl-menu button + button { margin-left:.3rem; }
mark[data-hl-id] { cursor:pointer; }
/* When the panel is open on a wide screen, shrink the page so the article and
   panel are both fully visible instead of the panel overlapping the text. */
body { transition:padding-right .2s ease; }
@media (min-width:820px) { body.hl-open { padding-right:min(380px,42vw); } }
.settings dt { font-family:system-ui,sans-serif; font-size:.8rem; color:var(--muted); margin-top:1.2rem; }
.settings dd { margin:.25rem 0 0; }
.back { font-family:system-ui,sans-serif; font-size:.85rem; text-decoration:none; }
`;

function page({ title, body, user, active = '', nonce = '', script = '', articleCsp = false }) {
  const nav = user ? `
    <nav>
      <a href="/" class="${active === 'inbox' ? 'active' : ''}">Inbox</a>
      <a href="/?view=archive" class="${active === 'archive' ? 'active' : ''}">Archive</a>
      <a href="/highlights" class="${active === 'highlights' ? 'active' : ''}">Highlights</a>
    </nav>
    <div class="who">
      <a href="/settings" class="${active === 'settings' ? 'active' : ''}">${escapeHtml(user.username)}</a>
      <form method="post" action="/logout"><button class="act" type="submit">Log out</button></form>
    </div>` : '<nav></nav>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} — Earmark</title>
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
</head>
<body>
<header class="site"><a class="brand" href="/">📖 Earmark</a>${nav}</header>
<main>${body}</main>
${script ? `<script nonce="${nonce}">${script}</script>` : ''}
</body>
</html>`;
}

function send(res, status, html, { nonce = '', headers = {} } = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy':
      `default-src 'none'; img-src * data:; media-src *; style-src 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(html);
}

function redirect(res, to, headers = {}) {
  res.writeHead(303, { Location: to, ...headers });
  res.end();
}

const fmtDate = (ms) => new Date(ms || 0).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

// ---------------------------------------------------------------- pages
function authCard({ title, action, error, allowSignup, notice }) {
  const other = action === '/login'
    ? (allowSignup ? '<div class="alt">No account? <a href="/signup">Sign up</a></div>' : '')
    : '<div class="alt">Have an account? <a href="/login">Log in</a></div>';
  return `<div class="card">
  <h1>${escapeHtml(title)}</h1>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
  ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}
  <form method="post" action="${action}">
    <label for="u">Username</label><input id="u" name="username" autocomplete="username" required>
    <label for="p">Password</label><input id="p" name="password" type="password" autocomplete="${action === '/signup' ? 'new-password' : 'current-password'}" required>
    <button type="submit">${escapeHtml(title)}</button>
  </form>
  ${other}</div>`;
}

/** Map the web form's length buckets to word-count bounds (225 wpm). */
const LEN_BUCKETS = {
  short: { maxWords: 1124 },
  medium: { minWords: 1125, maxWords: 4500 },
  long: { minWords: 4501 },
};

/** Build searchArticles filters from web form params (q/domain/hl/len). */
function filtersFromParams(get) {
  const hl = get('hl') || (get('highlighted') === '1' ? '1' : '');
  return {
    q: (get('q') || '').trim(),
    domain: (get('domain') || '').trim(),
    highlighted: hl === '1',
    minHighlights: hl && hl !== '1' ? (parseInt(hl, 10) || 0) : 0,
    ...(LEN_BUCKETS[get('len') || ''] || {}),
  };
}

const PAGE_SIZE = 50;
const SORTS = { newest: 'Newest', oldest: 'Oldest', longest: 'Longest', shortest: 'Shortest' };

function listPage(ctx, user, view, url) {
  const get = (k) => url.searchParams.get(k) || '';
  const savedViews = ctx.store.listViews(user.id);
  const savedView = view.startsWith('v:') ? ctx.store.getView(view.slice(2), user.id) : null;

  const q = get('q').trim();
  const domain = get('domain').trim();
  const hl = get('hl') || (get('highlighted') === '1' ? '1' : '');
  const len = get('len');
  const sort = SORTS[get('sort')] ? get('sort') : 'newest';
  const searching = Boolean(q || domain || hl || len);
  const pageNum = Math.max(1, parseInt(get('page'), 10) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;
  const paging = { sort, limit: PAGE_SIZE, offset };

  // Base filters that define the current view/search (used for both list + count).
  let baseFilters, empty;
  if (savedView) {
    baseFilters = { ...savedView.filters, includeArchived: !!savedView.filters.includeArchived };
    empty = 'No articles match this view.';
  } else if (searching) {
    baseFilters = { ...filtersFromParams(get), includeArchived: true }; // search spans all
    empty = 'No articles match this search.';
  } else if (view === 'favorites') { baseFilters = { favoriteOnly: true, includeArchived: true }; empty = 'No favorites yet — star an article to keep it here.'; }
  else if (view === 'archive') { baseFilters = { archivedOnly: true }; empty = 'Nothing archived yet.'; }
  else { baseFilters = {}; empty = 'Inbox empty — save something with the Firefox extension, or check <a href="/settings">Settings</a> to connect it.'; }

  const total = ctx.countArticles(user, baseFilters);
  const list = ctx.searchArticles(user, { ...baseFilters, ...paging });
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // domain dropdown: every domain this user has saved from, with counts
  const domainOptions = ctx.store.domainCounts(user.id)
    .map(({ domain: h, n }) => `<option value="${escapeHtml(h)}" ${h === domain ? 'selected' : ''}>${escapeHtml(h)} (${n})</option>`).join('');

  // How many articles each view holds, so a view's size is visible before you
  // open it. These are plain indexed COUNT(*)s (one per view, plus the inbox) —
  // a few ms even on a 24k-article account — so they're exact rather than
  // estimated. If a view ever grows an expensive filter, cache it rather than
  // dropping the number: an approximate count is fine, a missing one isn't.
  const countFor = (filters) => {
    try { return ctx.store.countArticles(user.id, filters); }
    catch { return null; } // never let a count break the page
  };
  const inboxCount = countFor({});
  const chipCount = (n) => (n === null ? '' : ` <span class="chip-n">${n}</span>`);

  // saved views as chips; × deletes (via the page script)
  const viewChips = savedViews.length ? `
<div class="views">
  <span class="view-chip ${!savedView && !searching ? 'active' : ''}">
    <a href="/">Inbox${chipCount(inboxCount)}</a>
  </span>${savedViews.map((v) => `
  <span class="view-chip ${savedView && savedView.id === v.id ? 'active' : ''}">
    <a href="/?view=v:${v.id}">${escapeHtml(v.name)}${chipCount(countFor({ ...v.filters, includeArchived: !!v.filters.includeArchived }))}</a><button class="act del-view" data-view-id="${v.id}" title="Delete view">×</button>
  </span>`).join('')}
</div>` : '';

  // while searching (and not inside a saved view), offer to save the filters
  const saveViewForm = searching && !savedView ? `
<form class="saveview" method="post" action="/views/save">
  <input type="hidden" name="q" value="${escapeHtml(q)}">
  <input type="hidden" name="domain" value="${escapeHtml(domain)}">
  <input type="hidden" name="hl" value="${escapeHtml(hl)}">
  <input type="hidden" name="len" value="${escapeHtml(len)}">
  <input name="name" placeholder="Name this view…" required maxlength="64">
  <button class="act" type="submit">Save as view</button>
</form>` : '';

  const viewParam = get('view');
  // Build a URL preserving the current view/filters/sort with overrides.
  const buildQs = (overrides) => {
    const cur = { view: viewParam, q, domain, len, hl, sort, ...overrides };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(cur)) if (v && !(k === 'sort' && v === 'newest')) p.set(k, String(v));
    const s = p.toString();
    return s ? `/?${s}` : '/';
  };
  const sortOptions = Object.entries(SORTS)
    .map(([k, label]) => `<option value="${k}" ${k === sort ? 'selected' : ''}>${label}</option>`).join('');

  const searchForm = `
${viewChips}
<form class="search" method="get" action="/">
  ${viewParam ? `<input type="hidden" name="view" value="${escapeHtml(viewParam)}">` : ''}
  <input type="search" name="q" value="${escapeHtml(q)}" placeholder="Search title, author, text…">
  <select name="domain"><option value="">All domains</option>${domainOptions}</select>
  <select name="len">
    <option value="">Any length</option>
    <option value="short" ${len === 'short' ? 'selected' : ''}>&lt; 5 min</option>
    <option value="medium" ${len === 'medium' ? 'selected' : ''}>5–20 min</option>
    <option value="long" ${len === 'long' ? 'selected' : ''}>&gt; 20 min</option>
  </select>
  <select name="hl">
    <option value="">Highlights: any</option>
    <option value="1" ${hl === '1' ? 'selected' : ''}>has highlights</option>
    <option value="3" ${hl === '3' ? 'selected' : ''}>3+ highlights</option>
  </select>
  <select name="sort">${sortOptions}</select>
  <button class="act" type="submit">Search</button>
  ${searching || savedView ? `<a class="back" href="${viewParam ? `/?view=${escapeHtml(viewParam)}` : '/'}">Clear</a>` : ''}
</form>
${savedView ? `<div class="meta">${total.toLocaleString('en-US')} article${total === 1 ? '' : 's'} in “${escapeHtml(savedView.name)}”</div>` : ''}
${searching && !savedView ? `<div class="meta">${total.toLocaleString('en-US')} result${total === 1 ? '' : 's'}${q ? ` for “${escapeHtml(q)}”` : ''}${domain ? ` from ${escapeHtml(domain)}` : ''}</div>${saveViewForm}` : ''}
${!searching && !savedView ? `<div class="meta">${total.toLocaleString('en-US')} article${total === 1 ? '' : 's'}</div>` : ''}`;

  const pager = pageCount > 1 ? `<div class="pager">
  ${pageNum > 1 ? `<a class="act" href="${buildQs({ page: pageNum - 1 })}">← Prev</a>` : '<span class="act disabled">← Prev</span>'}
  <span class="meta">Page ${pageNum} of ${pageCount}</span>
  ${pageNum < pageCount ? `<a class="act" href="${buildQs({ page: pageNum + 1 })}">Next →</a>` : '<span class="act disabled">Next →</span>'}
</div>` : '';

  const hlCounts = ctx.store.highlightCountsByArticle(user.id);
  const items = list.map((a) => {
    const hlCount = hlCounts.get(a.id) || 0;
    const meta = [
      a.siteName || a.domain || null, // imported articles often lack a site name
      a.byline, fmtDate(a.savedAt),
      a.wordCount > 0 ? `~${Math.max(1, Math.round(a.wordCount / 225))} min` : null,
      a.readParagraph > 0 ? `¶${a.readParagraph} in progress` : null,
      hlCount ? `${hlCount} highlight${hlCount > 1 ? 's' : ''}` : null,
    ].filter(Boolean).map(escapeHtml).join(' · ');
    const thumb = a.imageUrl && /^https?:\/\//i.test(a.imageUrl)
      ? `<img class="thumb" src="${escapeHtml(a.imageUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
      : '';
    return `<li data-id="${a.id}">
      <div class="main"><a class="title" href="/read/${a.id}">${escapeHtml(a.title)}</a>
      <div class="meta">${meta}</div></div>
      ${thumb}
      <div class="actions">
        <button class="act fav" data-act="favorite" data-val="${a.favorite ? 'false' : 'true'}" title="Favorite">${a.favorite ? '★' : '☆'}</button>
        <button class="act" data-act="archive" data-val="${a.archived ? 'false' : 'true'}">${a.archived ? 'Unarchive' : 'Archive'}</button>
        <button class="act" data-act="delete">Delete</button>
      </div></li>`;
  }).join('\n');

  // Bulk-archive only makes sense on the inbox (not archive/favorites/search).
  const isInbox = !searching && !savedView && view !== 'archive' && view !== 'favorites';
  const importBar = `
<div class="importbar meta">
  <button id="import-pdf" class="act">Import PDF…</button>
  ${isInbox ? '<button id="bulk-archive" class="act">Archive older than 1 year</button>' : ''}
  <span id="import-status"></span>
  <input type="file" id="pdf-file" accept=".pdf,application/pdf" style="display:none">
</div>`;

  const body = searchForm + importBar + (list.length
    ? `<ul class="articles">${items}</ul>${pager}`
    : `<div class="empty">${empty}</div>`);

  const script = `
// Drop thumbnails whose og:image 404s or is hotlink-blocked, rather than
// leaving a broken-image icon. 'error' doesn't bubble, so listen on capture.
document.addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG' && e.target.classList.contains('thumb')) e.target.remove();
}, true);

document.addEventListener('click', async (e) => {
  const dv = e.target.closest('button.del-view');
  if (dv) {
    if (!confirm('Delete this view?')) return;
    await fetch('/api/views/' + dv.dataset.viewId, { method: 'DELETE' });
    location.href = '/';
    return;
  }
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const li = btn.closest('li[data-id]'); const id = li.dataset.id;
  const act = btn.dataset.act;
  if (act === 'delete') {
    if (!confirm('Delete this article and its highlights?')) return;
    await fetch('/api/articles/' + id, { method: 'DELETE' });
  } else {
    await fetch('/api/articles/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [act]: btn.dataset.val === 'true' }),
    });
  }
  location.reload();
});

// Bulk-archive everything older than a year.
const bulkBtn = document.getElementById('bulk-archive');
if (bulkBtn) bulkBtn.addEventListener('click', async () => {
  if (!confirm('Archive every inbox article older than 1 year?')) return;
  bulkBtn.disabled = true; bulkBtn.textContent = 'Archiving…';
  const res = await fetch('/api/articles/bulk-archive', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ olderThanDays: 365 }),
  });
  const d = await res.json().catch(() => ({}));
  alert('Archived ' + (d.archived || 0) + ' article(s) older than a year.');
  location.reload();
});

// PDF import: pick a file, POST it raw, reload to show the new article.
const pdfBtn = document.getElementById('import-pdf');
const pdfFile = document.getElementById('pdf-file');
const pdfStatus = document.getElementById('import-status');
if (pdfBtn) pdfBtn.addEventListener('click', () => pdfFile.click());
if (pdfFile) pdfFile.addEventListener('change', async () => {
  const f = pdfFile.files[0]; if (!f) return;
  pdfStatus.textContent = 'Importing ' + f.name + '…';
  const res = await fetch('/api/import/pdf?filename=' + encodeURIComponent(f.name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: f,
  });
  if (res.ok) { location.reload(); }
  else {
    const err = await res.json().catch(() => ({}));
    pdfStatus.textContent = 'Import failed: ' + (err.error || res.status);
  }
});`;
  return { body, script };
}

function readerPage(ctx, user, article) {
  const hls = ctx.store.highlightsForArticle(article.id);
  const meta = [article.siteName, article.byline, fmtDate(article.savedAt)].filter(Boolean).map(escapeHtml).join(' · ');
  const hlItems = hls.map((h) => `<div class="hl-item" data-hl-id="${h.id}">
      <div class="hl-item-text">${escapeHtml(h.text)}</div>
      ${h.note ? `<div class="note">${escapeHtml(h.note)}</div>` : ''}
      <div class="hl-item-actions"><button class="act del-hl" data-id="${h.id}">Delete</button></div>
    </div>`).join('\n');

  const body = `
<a class="back" href="/">&larr; Back to list</a>
<article class="reader">
  <header>
    <h1>${escapeHtml(article.title)}</h1>
    <div class="meta">${meta}${meta ? ' · ' : ''}<a href="/read/${escapeHtml(article.id)}/original" target="_blank" rel="noopener noreferrer">view original ↗</a></div>
    <div class="actions reader-actions">
      <button class="act fav" data-act="favorite" data-val="${article.favorite ? 'false' : 'true'}" title="Favorite">${article.favorite ? '★' : '☆'}</button>
      <button class="act" data-act="archive" data-val="${article.archived ? 'false' : 'true'}">${article.archived ? 'Unarchive' : 'Archive'}</button>
      <button class="act" id="hl-toggle">Highlights (${hls.length})</button>
      <button class="act" id="reparse-btn" title="Re-extract this article if it was parsed wrong">Fix parsing</button>
    </div>
    <div class="meta">Select any text to highlight it.</div>
  </header>
  <div class="content" id="content">${article.html}</div>
</article>
<aside id="hl-panel" class="hl-panel" hidden>
  <div class="hl-panel-head"><strong>Highlights (${hls.length})</strong><button class="act" id="hl-close">×</button></div>
  <div class="hl-panel-body">${hls.length ? hlItems : '<div class="meta">No highlights yet. Select text in the article to add one.</div>'}</div>
</aside>
<div id="hl-tip" hidden><button id="hl-save">Highlight</button><button id="skip-save" title="Drop this text from articles saved in future">Never import</button></div>
<div id="hl-menu" hidden><button id="hl-menu-del">Delete highlight</button><button id="hl-menu-skip">Never import</button></div>
<div id="reparse-dialog" hidden>
  <div class="skip-box">
    <strong>Fix parsing</strong>
    <div class="meta">What's wrong with how this article was parsed? We'll re-extract
    it from the original source.</div>
    <div class="reparse-actions">
      <button class="act" data-hint="too-short">Too short — text is missing</button>
      <button class="act" data-hint="too-long">Too long — extra menus/ads/junk</button>
      <button class="act" data-hint="other">Something else looks wrong</button>
    </div>
    <div id="reparse-msg" class="meta"></div>
    <div class="skip-actions">
      <button class="act" id="reparse-cancel" type="button">Cancel</button>
    </div>
  </div>
</div>
<div id="skip-dialog" hidden>
  <div class="skip-box">
    <strong>Never import this text</strong>
    <div class="meta">Trim it to just the part that repeats. Paragraphs containing this
    phrase are dropped from articles you save from now on; articles already saved keep it.</div>
    <textarea id="skip-text" rows="4" maxlength="300"></textarea>
    <div id="skip-dialog-msg" class="meta"></div>
    <div class="skip-actions">
      <button class="act" id="skip-cancel" type="button">Cancel</button>
      <button class="act" id="skip-confirm" type="button">Add rule</button>
    </div>
  </div>
</div>`;

  const script = `
const ARTICLE = ${JSON.stringify(article.id)};
const ORIGINAL_URL = ${JSON.stringify(article.url || '')};

// Keyboard shortcuts: o = open the original, e = archive and go back.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (e.key === 'o') {
    window.open('/read/' + ARTICLE + '/original', '_blank', 'noopener');
  } else if (e.key === 'e') {
    e.preventDefault();
    fetch('/api/articles/' + ARTICLE, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    }).then(() => { location.href = '/'; });
  }
});

// Anchor stored highlights onto the rendered article, tagging each mark with its
// id so the panel can jump to it. Matching is deliberately fuzzy: a highlight
// saved on Android carries markdown markers ("*Tribune*") and collapsed
// whitespace the rendered HTML ("<em>Tribune</em>") lacks, and a highlight can
// span inline elements. So we canonicalize both sides, match in canonical space,
// map the offsets back to the DOM, and wrap the range even across text nodes.
const HLS = ${JSON.stringify(hls.map((h) => ({ id: h.id, text: h.text })))};
const root = document.getElementById('content');
function isWs(c) { const n = c.charCodeAt(0); return n === 32 || n === 9 || n === 10 || n === 13 || n === 160; }
function canonChar(c) {
  const n = c.charCodeAt(0);
  if (n === 0x2018 || n === 0x2019 || n === 0x201B || n === 0x2032) return "'";
  if (n === 0x201C || n === 0x201D || n === 0x201F || n === 0x2033) return '"';
  if (n === 0x2013 || n === 0x2014 || n === 0x2212) return '-';
  return c;
}
function canonNeedle(s) {
  let out = '', prevSpace = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*' || c === '_') continue; // markdown emphasis markers
    if (isWs(c)) { if (!prevSpace && out) { out += ' '; prevSpace = true; } }
    else { out += canonChar(c); prevSpace = false; }
  }
  return prevSpace ? out.slice(0, -1) : out;
}
// Flatten root's (still-unmarked) text nodes into a canonical string, keeping a
// map from each canonical char back to its DOM position.
function buildIndex() {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (nd) => nd.parentElement && nd.parentElement.closest('mark[data-hl-id]')
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  });
  const segs = [];
  let orig = '', nd;
  while ((nd = walker.nextNode())) { segs.push({ node: nd, start: orig.length }); orig += nd.nodeValue; }
  let canon = '', prevSpace = false;
  const map = [];
  for (let i = 0; i < orig.length; i++) {
    const c = orig[i];
    if (isWs(c)) { if (!prevSpace && canon) { canon += ' '; map.push(i); prevSpace = true; } }
    else { canon += canonChar(c); map.push(i); prevSpace = false; }
  }
  return { segs, canon, map };
}
function wrapRange(segs, from, to, id) {
  for (const { node, start } of segs) {
    const s = Math.max(from, start), e = Math.min(to, start + node.nodeValue.length);
    if (s >= e) continue;
    const range = document.createRange();
    range.setStart(node, s - start);
    range.setEnd(node, e - start);
    const mark = document.createElement('mark');
    mark.dataset.hlId = id;
    try { range.surroundContents(mark); } catch (err) {}
  }
}
for (const h of HLS) {
  const needle = canonNeedle(h.text);
  if (!needle) continue;
  const { segs, canon, map } = buildIndex(); // rebuilt per highlight so earlier marks are excluded
  const ci = canon.indexOf(needle);
  if (ci < 0) continue;
  wrapRange(segs, map[ci], map[ci + needle.length - 1] + 1, h.id);
}

// Highlights side panel: toggle (pushes the page aside), jump-to, and delete.
const panel = document.getElementById('hl-panel');
function setPanel(open) { panel.hidden = !open; document.body.classList.toggle('hl-open', open); }
document.getElementById('hl-toggle').addEventListener('click', () => setPanel(panel.hidden));
document.getElementById('hl-close').addEventListener('click', () => setPanel(false));
function flashMark(id) {
  const mark = root.querySelector('mark[data-hl-id="' + CSS.escape(id) + '"]');
  if (mark) {
    mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    mark.classList.add('flash');
    setTimeout(() => mark.classList.remove('flash'), 1600);
  }
}
document.querySelectorAll('.hl-item').forEach((item) => {
  item.addEventListener('click', (e) => { if (!e.target.closest('button')) flashMark(item.dataset.hlId); });
});
async function deleteHighlight(id) {
  // No confirm, no page reload: delete, then update the DOM in place.
  const res = await fetch('/api/highlights/' + id, { method: 'DELETE' });
  if (!res.ok) { alert('Could not delete that highlight.'); return; }
  removeHighlightFromDom(id);
}
// Update the page in place instead of reloading: drop the panel row, unwrap the
// inline mark (keeping its words), and re-count.
function removeHighlightFromDom(id) {
  const sel = 'mark[data-hl-id="' + CSS.escape(id) + '"]';
  panel.querySelector('.hl-item[data-hl-id="' + CSS.escape(id) + '"]')?.remove();
  root.querySelectorAll(sel).forEach((mark) => {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize(); // merge the text nodes back together
  });
  const n = panel.querySelectorAll('.hl-item').length;
  document.getElementById('hl-toggle').textContent = 'Highlights (' + n + ')';
  const head = panel.querySelector('.hl-panel-head strong');
  if (head) head.textContent = 'Highlights (' + n + ')';
  if (n === 0) {
    const body = panel.querySelector('.hl-panel-body');
    if (body) body.innerHTML = '<div class="meta">No highlights yet. Select text in the article to add one.</div>';
  }
}
// Panel "Delete" buttons.
document.querySelectorAll('.hl-item .del-hl').forEach((b) => {
  b.addEventListener('click', (e) => { e.stopPropagation(); deleteHighlight(b.dataset.id); });
});

// Click a highlight inside the article -> a small Delete menu at that spot.
const menu = document.getElementById('hl-menu');
let menuHlId = null;
root.addEventListener('click', (e) => {
  const mark = e.target.closest('mark[data-hl-id]');
  if (!mark) return;
  e.stopPropagation();
  menuHlId = mark.dataset.hlId;
  const r = mark.getBoundingClientRect();
  menu.style.top = (window.scrollY + r.bottom + 4) + 'px';
  menu.style.left = (window.scrollX + r.left) + 'px';
  menu.hidden = false;
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#hl-menu') && !e.target.closest('mark[data-hl-id]')) menu.hidden = true;
});
document.getElementById('hl-menu-del').addEventListener('click', () => { menu.hidden = true; if (menuHlId) deleteHighlight(menuHlId); });

// archive/favorite/delete-highlight buttons
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'del-hl') {
    await fetch('/api/highlights/' + btn.dataset.id, { method: 'DELETE' });
  } else {
    await fetch('/api/articles/' + ARTICLE, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [act]: btn.dataset.val === 'true' }),
    });
  }
  location.reload();
});

// select text in the article -> floating Highlight button
const tip = document.getElementById('hl-tip');
document.addEventListener('selectionchange', () => {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !root.contains(sel.anchorNode)) { tip.hidden = true; return; }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  tip.style.top = (window.scrollY + rect.top - 42) + 'px';
  tip.style.left = (window.scrollX + rect.left) + 'px';
  tip.hidden = false;
});
document.getElementById('hl-save').addEventListener('mousedown', async (e) => {
  e.preventDefault(); // don't collapse the selection before we read it
  const text = String(document.getSelection()).trim();
  if (!text) return;
  await fetch('/api/articles/' + ARTICLE + '/highlights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 20000), clientId: 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2) }),
  });
  tip.hidden = true;
  location.reload();
});

// "Never import": open the phrase in an editable box, prefilled with whatever
// text you pointed at, so you can trim it down to the bit that actually
// repeats before committing. This article keeps the text either way — rules
// apply to future saves only, because paragraph indices anchor the highlights
// and reading position of anything already saved.
const MIN_SKIP_PHRASE = ${skip.MIN_PHRASE_CHARS};
const dlg = document.getElementById('skip-dialog');
const dlgText = document.getElementById('skip-text');
const dlgMsg = document.getElementById('skip-dialog-msg');
const dlgOk = document.getElementById('skip-confirm');

function refreshSkipDialog() {
  const n = dlgText.value.trim().length;
  dlgOk.disabled = n < MIN_SKIP_PHRASE;
  if (n && n < MIN_SKIP_PHRASE) dlgMsg.textContent = 'Use at least ' + MIN_SKIP_PHRASE + ' characters.';
  else if (dlgMsg.dataset.sticky !== '1') dlgMsg.textContent = '';
}
function openSkipDialog(text) {
  tip.hidden = true;
  menu.hidden = true;
  dlgMsg.dataset.sticky = '0';
  dlgMsg.textContent = '';
  dlgText.value = String(text || '').replace(/\\s+/g, ' ').trim().slice(0, 300);
  dlg.hidden = false;
  refreshSkipDialog();
  dlgText.focus();
  dlgText.select();
}
const closeSkipDialog = () => { dlg.hidden = true; };

dlgText.addEventListener('input', refreshSkipDialog);
document.getElementById('skip-cancel').addEventListener('click', closeSkipDialog);
dlg.addEventListener('click', (e) => { if (e.target === dlg) closeSkipDialog(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !dlg.hidden) closeSkipDialog(); });

// ---- "Fix parsing": pick what's wrong, reparse, reload on success -----------
const reparseDlg = document.getElementById('reparse-dialog');
const reparseMsg = document.getElementById('reparse-msg');
const closeReparse = () => { reparseDlg.hidden = true; };
document.getElementById('reparse-btn').addEventListener('click', () => {
  reparseMsg.textContent = '';
  reparseDlg.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  reparseDlg.hidden = false;
});
document.getElementById('reparse-cancel').addEventListener('click', closeReparse);
reparseDlg.addEventListener('click', (e) => { if (e.target === reparseDlg) closeReparse(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !reparseDlg.hidden) closeReparse(); });
reparseDlg.querySelectorAll('[data-hint]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    reparseDlg.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    reparseMsg.textContent = 'Reparsing… this can take a few seconds.';
    try {
      const res = await fetch('/api/articles/' + ARTICLE + '/reparse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hint: btn.dataset.hint }),
      });
      const d = await res.json();
      if (d.ok) { location.reload(); return; }
      reparseMsg.textContent = d.reason === 'no-source'
        ? "There's no saved original to reparse this one from."
        : "Couldn't get a better parse (" + (d.reason || 'unknown') + ').';
    } catch (err) {
      reparseMsg.textContent = 'Reparse failed: ' + err.message;
    }
    reparseDlg.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  });
});

// from a fresh selection
document.getElementById('skip-save').addEventListener('mousedown', (e) => {
  e.preventDefault(); // don't collapse the selection before we read it
  openSkipDialog(String(document.getSelection()));
});
// from an existing highlight's menu
document.getElementById('hl-menu-skip').addEventListener('click', (e) => {
  e.stopPropagation();
  const hl = HLS.find((h) => h.id === menuHlId);
  openSkipDialog(hl ? hl.text : '');
});

dlgOk.addEventListener('click', async () => {
  const phrase = dlgText.value.trim();
  if (phrase.length < MIN_SKIP_PHRASE) return;
  dlgOk.disabled = true;
  const res = await fetch('/api/skip-rules', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phrase }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    dlgMsg.dataset.sticky = '1';
    dlgMsg.textContent = data.error || 'Could not add that rule.';
    dlgOk.disabled = false;
    return;
  }
  dlgMsg.dataset.sticky = '1';
  dlgMsg.textContent = data.existingMatches
    ? 'Added. ' + data.existingMatches + ' article(s) you already saved contain it; those are left unchanged.'
    : 'Added.';
  setTimeout(closeSkipDialog, data.existingMatches ? 2200 : 800);
});`;
  return { body, script };
}

function highlightsPage(ctx, user, url) {
  // Grouped by article: which articles have highlights and how many. The
  // highlights themselves live on each article's reader page.
  const HL_SORTS = { recent: 'Recently highlighted', oldest: 'Oldest highlighted', most: 'Most highlights', title: 'Title A–Z' };
  const get = (k) => (url && url.searchParams.get(k)) || '';
  const q = get('q').trim();
  const domain = get('domain').trim();
  const sort = HL_SORTS[get('sort')] ? get('sort') : 'recent';
  const pageNum = Math.max(1, parseInt(get('page'), 10) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;

  const total = ctx.store.highlightedArticlesCount(user.id, { q, domain });
  const arts = ctx.store.highlightedArticles(user.id, { q, domain, sort, limit: PAGE_SIZE, offset });
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const buildQs = (o) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, domain, sort, ...o })) if (v && !(k === 'sort' && v === 'recent')) p.set(k, String(v));
    const s = p.toString();
    return s ? `/highlights?${s}` : '/highlights';
  };
  const domainOpts = ctx.store.highlightedDomains(user.id)
    .map(({ domain: d, n }) => `<option value="${escapeHtml(d)}" ${d === domain ? 'selected' : ''}>${escapeHtml(d)} (${n})</option>`).join('');
  const sortOpts = Object.entries(HL_SORTS)
    .map(([k, label]) => `<option value="${k}" ${k === sort ? 'selected' : ''}>${label}</option>`).join('');

  const items = arts.map((a) => {
    const meta = [
      a.siteName,
      a.wordCount > 0 ? `~${Math.max(1, Math.round(a.wordCount / 225))} min` : null,
      `highlighted ${fmtDate(a.lastHighlightAt)}`,
    ].filter(Boolean).map(escapeHtml).join(' · ');
    return `<li>
      <div class="main"><a class="title" href="/read/${a.id}">${escapeHtml(a.title)}</a>
      <div class="meta">${meta}</div></div>
      <div class="actions"><span class="hl-count">${a.n} highlight${a.n > 1 ? 's' : ''}</span></div>
    </li>`;
  }).join('\n');

  const pager = pageCount > 1 ? `<div class="pager">
  ${pageNum > 1 ? `<a class="act" href="${buildQs({ page: pageNum - 1 })}">← Prev</a>` : '<span class="act disabled">← Prev</span>'}
  <span class="meta">Page ${pageNum} of ${pageCount}</span>
  ${pageNum < pageCount ? `<a class="act" href="${buildQs({ page: pageNum + 1 })}">Next →</a>` : '<span class="act disabled">Next →</span>'}
</div>` : '';

  const searchForm = `<form class="search" method="get" action="/highlights">
  <input type="search" name="q" value="${escapeHtml(q)}" placeholder="Search highlighted articles…">
  <select name="domain"><option value="">All domains</option>${domainOpts}</select>
  <select name="sort">${sortOpts}</select>
  <button class="act" type="submit">Apply</button>
  ${q || domain || sort !== 'recent' ? '<a class="back" href="/highlights">Clear</a>' : ''}
</form>`;

  const body = `<h1>Highlights</h1>
${searchForm}
${total ? `<div class="meta">${total.toLocaleString('en-US')} article${total === 1 ? '' : 's'} with highlights — open one to read them in place.</div>
<ul class="articles">${items}</ul>${pager}`
    : `<div class="empty">${q || domain ? 'No highlighted articles match those filters.' : 'No highlights yet — long-press a paragraph in the Android app, or select text in the reader.'}</div>`}
<p class="meta"><a href="/api/highlights/export.md">Export all as Markdown</a></p>`;
  return { body, script: '' };
}

function settingsPage(ctx, user, url, req) {
  const msg = url.searchParams.get('msg');
  const rules = ctx.store.listSkipRules(user.id);
  const origin = `${(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http'}://${req.headers.host || 'localhost'}`;
  // Two ways in: an IMAP mailbox the server polls (one shared address, so it
  // takes precedence when configured), or a per-account alias via the
  // inbound-email webhook.
  const email = ctx.INBOUND_MAILBOX ? `
  <dt>Forward articles to</dt><dd><code class="token">${escapeHtml(ctx.INBOUND_MAILBOX)}</code>
  <div class="meta">Forward a newsletter here and it appears in your list within a couple of minutes.</div></dd>`
    : ctx.INBOUND_DOMAIN ? `
  <dt>Email articles to</dt><dd><code class="token">${escapeHtml(user.emailAlias)}@${escapeHtml(ctx.INBOUND_DOMAIN)}</code></dd>
  <dt>Regenerate email address</dt>
  <dd class="meta">If the address starts getting spam. Newsletters subscribed with the old address will stop arriving.<br><br>
  <form method="post" action="/settings/email-alias"><button class="act" type="submit">Regenerate email address</button></form></dd>` : '';
  const body = `<h1>Settings</h1>
${msg === 'token' ? '<div class="notice">API token regenerated — update the Firefox extension and Android app.</div>' : ''}
${msg === 'alias' ? '<div class="notice">Email address regenerated — update your newsletter subscriptions and forwarding rules.</div>' : ''}
<dl class="settings">
  <dt>Signed in as</dt><dd>${escapeHtml(user.username)} (since ${fmtDate(user.createdAt)})</dd>
  <dt>Server URL (for the Firefox extension and Android app)</dt><dd><code class="token">${escapeHtml(origin)}</code></dd>
  <dt>API token</dt><dd><code class="token">${escapeHtml(user.token)}</code></dd>${email}
  <dt>Regenerate token</dt>
  <dd class="meta">Invalidates the old token; you'll need to re-enter it on every device.<br><br>
  <form method="post" action="/settings/token"><button class="act" type="submit">Regenerate API token</button></form></dd>
  ${fs.existsSync(ctx.APK_FILE) ? `
  <dt>Android app</dt>
  <dd class="meta"><a href="/app.apk">Download the Android app (APK)</a> — open this page on your phone,
  download, and tap the file to install or update.</dd>` : ''}
  <dt>Skipped text</dt>
  <dd class="meta">Phrases dropped from articles as they are saved — newsletter
  sign-ups, import warnings. A paragraph containing one is removed. Existing
  articles are never changed; select text in the reader to add a rule quickly.
    <form id="skip-add" class="skip-add">
      <input type="text" id="skip-phrase" placeholder="Sign up for the latest from our newsletter" maxlength="300">
      <button class="act" type="submit">Add</button>
    </form>
    <div id="skip-msg" class="meta"></div>
    ${rules.length ? `<ul class="skip-rules">${rules.map((r) => `
      <li data-id="${escapeHtml(r.id)}">
        <span class="phrase">${escapeHtml(r.phrase)}</span>
        <span class="meta">${r.hits ? `removed ${r.hits}×` : 'never matched yet'}</span>
        <button class="act del-skip" type="button">Remove</button>
      </li>`).join('')}</ul>`
      : '<div class="meta">No rules yet.</div>'}
  </dd>
  <dt>Export your data</dt>
  <dd class="meta">
    <a href="/api/export.ndjson">Full backup (NDJSON)</a> — use this one; it streams and restores at any size ·
    <a href="/api/export.json">as one JSON document</a> ·
    <a href="/api/highlights/export.md">Highlights as Markdown</a>
  </dd>
</dl>`;

  const script = `
const msgEl = document.getElementById('skip-msg');
const say = (t, bad) => { msgEl.textContent = t; msgEl.style.color = bad ? '#b3261e' : ''; };

document.getElementById('skip-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('skip-phrase');
  const phrase = input.value.trim();
  if (!phrase) return;
  const res = await fetch('/api/skip-rules', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phrase }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return say(data.error || 'could not add that rule', true);
  input.value = '';
  // Rules are not retroactive: say so plainly when old articles contain it.
  say(data.existingMatches
    ? data.existingMatches + ' existing article(s) contain this — they are left as they are. Reloading…'
    : 'Added. Reloading…');
  setTimeout(() => location.reload(), data.existingMatches ? 1800 : 500);
});

document.querySelectorAll('.del-skip').forEach((b) => {
  b.addEventListener('click', async () => {
    const li = b.closest('li[data-id]');
    await fetch('/api/skip-rules/' + li.dataset.id, { method: 'DELETE' });
    li.remove();
  });
});
`;
  return { body, script };
}

// ---------------------------------------------------------------- handler
async function handle(ctx, req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const route = `${req.method} /${parts.join('/')}`;
  const user = ctx.getSessionUser(req);
  const nonce = crypto.randomBytes(16).toString('base64url');

  // ---- Firefox extension self-distribution (PUBLIC — Firefox's auto-updater
  // sends no session cookie). The signed .xpi and the update manifest it polls.
  if (route === 'GET /extension.xpi') {
    if (!ctx.EXT_XPI_FILE || !fs.existsSync(ctx.EXT_XPI_FILE)) { res.writeHead(404); return res.end('no extension uploaded'); }
    const stat = fs.statSync(ctx.EXT_XPI_FILE);
    res.writeHead(200, {
      'Content-Type': 'application/x-xpinstall',
      'Content-Length': stat.size,
      'Content-Disposition': 'attachment; filename="earmark.xpi"',
    });
    return fs.createReadStream(ctx.EXT_XPI_FILE).pipe(res);
  }
  if (route === 'GET /extension/updates.json') {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(ctx.EXT_META_FILE, 'utf8')); } catch (e) {}
    const base = `https://${req.headers.host}`;
    const updates = meta && meta.version ? [{
      version: meta.version,
      update_link: `${base}/extension.xpi`,
      ...(meta.sha256 ? { update_hash: `sha256:${meta.sha256}` } : {}),
    }] : [];
    const body = JSON.stringify({ addons: { 'readlater@selfhosted.local': { updates } } });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    return res.end(body);
  }

  // ---- account routes
  if (route === 'GET /login' || route === 'GET /signup') {
    if (user) return redirect(res, '/');
    const signup = route === 'GET /signup';
    if (signup && !ctx.ALLOW_SIGNUP) return send(res, 403, page({ title: 'Signups disabled', body: '<div class="card"><h1>Signups are disabled</h1><div class="alt"><a href="/login">Log in</a></div></div>', user: null, nonce }), { nonce });
    const notice = !signup && ctx.store.userCount() === 0 ? 'No accounts exist yet — sign up to create the first one.' : '';
    return send(res, 200, page({
      title: signup ? 'Sign up' : 'Log in',
      body: authCard({ title: signup ? 'Sign up' : 'Log in', action: signup ? '/signup' : '/login', allowSignup: ctx.ALLOW_SIGNUP, notice }),
      user: null, nonce,
    }), { nonce });
  }

  if (route === 'POST /signup' || route === 'POST /login') {
    const signup = route === 'POST /signup';
    if (signup && !ctx.ALLOW_SIGNUP) { res.writeHead(403); return res.end('signups disabled'); }
    let b;
    try { b = ctx.parseBody(await ctx.readBody(req), req.headers['content-type']); }
    catch { b = {}; }
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    let account, error;
    if (signup) {
      ({ user: account, error } = ctx.createUser(username, password));
    } else {
      const u = ctx.findUserByName(username);
      if (u && ctx.verifyPassword(u.passwordHash, password)) account = u;
      else { error = 'wrong username or password'; await new Promise((r) => setTimeout(r, 300)); }
    }
    if (!account) {
      return send(res, signup ? 400 : 401, page({
        title: signup ? 'Sign up' : 'Log in',
        body: authCard({ title: signup ? 'Sign up' : 'Log in', action: signup ? '/signup' : '/login', error, allowSignup: ctx.ALLOW_SIGNUP }),
        user: null, nonce,
      }), { nonce });
    }
    const sid = ctx.createSession(account.id);
    return redirect(res, '/', { 'Set-Cookie': ctx.sessionCookie(sid, req) });
  }

  if (route === 'POST /logout') {
    ctx.destroySession(req);
    return redirect(res, '/login', { 'Set-Cookie': ctx.sessionCookie('', req, { clear: true }) });
  }

  // ---- everything below needs a session
  if (!user) {
    if (req.method === 'GET') return redirect(res, '/login');
    res.writeHead(401); return res.end('unauthorized');
  }

  if (route === 'POST /settings/token') {
    ctx.store.setUserToken(user.id, crypto.randomBytes(24).toString('hex'));
    return redirect(res, '/settings?msg=token');
  }

  if (route === 'POST /settings/email-alias') {
    ctx.store.setUserAlias(user.id, ctx.newEmailAlias(user.username));
    return redirect(res, '/settings?msg=alias');
  }

  if (route === 'POST /views/save') {
    let b;
    try { b = ctx.parseBody(await ctx.readBody(req), req.headers['content-type']); }
    catch { b = {}; }
    const name = String(b.name || '').trim().slice(0, 64);
    if (!name) return redirect(res, '/');
    const v = {
      id: ctx.newId(),
      userId: user.id,
      name,
      filters: filtersFromParams((k) => String(b[k] || '')),
      createdAt: Date.now(),
    };
    ctx.store.insertView(v);
    return redirect(res, `/?view=v:${v.id}`);
  }

  // "View original": show the raw captured source (email HTML, extension-
  // captured page) in a sandboxed frame — no scripts, opaque origin, so it
  // can't run code or reach the session. Normal web articles where we kept no
  // copy just redirect to the real URL.
  if (req.method === 'GET' && parts[0] === 'read' && parts.length === 3 && parts[2] === 'original') {
    const article = ctx.store.getArticle(parts[1], user.id);
    if (!article) {
      return send(res, 404, page({ title: 'Not found', body: '<div class="empty">No such article.</div>', user, nonce }), { nonce });
    }
    const source = ctx.store.getArticleSource(parts[1], user.id);
    if (!source) {
      if (/^https?:\/\//i.test(article.url)) { res.writeHead(302, { Location: article.url }); return res.end(); }
      return send(res, 404, page({ title: 'No original', body: '<div class="empty">No original source was kept for this article.</div>', user, nonce }), { nonce });
    }
    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>Original — ${escapeHtml(article.title)}</title>`
      + `<style>body{margin:0;font-family:system-ui,sans-serif}.bar{padding:8px 12px;background:#f3efe6;color:#1a1a18;border-bottom:1px solid #d8cfbe;font-size:14px}`
      + `.bar a{color:#3d6b52}iframe{border:0;width:100%;height:calc(100vh - 38px)}</style></head>`
      + `<body><div class="bar">Original captured source · <a href="/read/${escapeHtml(article.id)}">← back to reader</a></div>`
      + `<iframe sandbox="" srcdoc="${escapeHtml(source)}"></iframe></body></html>`;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // No scripts anywhere; passive content (images/styles) may load so the
      // original renders. The iframe's empty sandbox is the real guard.
      'Content-Security-Policy': "script-src 'none'; img-src * data:; style-src * 'unsafe-inline'; font-src * data:; base-uri 'none'; form-action 'none'",
    });
    return res.end(doc);
  }

  // Android app download (uploaded to the server via POST /api/app.apk).
  // Extra named APKs (POST /api/apk/<name>) download at /apk/<name>.
  const apkTarget =
    route === 'GET /app.apk' ? { file: ctx.APK_FILE, name: 'readlater.apk' } :
    (parts[0] === 'apk' && parts.length === 2 && req.method === 'GET' && /^[a-z0-9-]{1,64}$/.test(parts[1]))
      ? { file: `${ctx.APK_FILE.replace(/app\.apk$/, '')}apk-${parts[1]}.apk`, name: `${parts[1]}.apk` }
      : null;
  if (apkTarget) {
    if (!fs.existsSync(apkTarget.file)) {
      return send(res, 404, page({ title: 'Not found', body: '<div class="empty">No such app build has been uploaded.</div>', user, nonce }), { nonce });
    }
    const stat = fs.statSync(apkTarget.file);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${apkTarget.name}"`,
    });
    return fs.createReadStream(apkTarget.file).pipe(res);
  }

  let made = null, title = 'ReadLater', active = 'inbox';
  if (route === 'GET /') {
    const view = url.searchParams.get('view') || 'inbox';
    made = listPage(ctx, user, view, url);
    active = ['favorites', 'archive'].includes(view) ? view : 'inbox';
    title = active[0].toUpperCase() + active.slice(1);
  } else if (route.startsWith('GET /read/') && parts.length === 2) {
    const article = ctx.store.getArticle(parts[1], user.id);
    if (article) { made = readerPage(ctx, user, article); title = article.title; active = ''; }
  } else if (route === 'GET /highlights') {
    made = highlightsPage(ctx, user, url); title = 'Highlights'; active = 'highlights';
  } else if (route === 'GET /settings') {
    made = settingsPage(ctx, user, url, req); title = 'Settings'; active = 'settings';
  } else if (route === 'GET /favicon.ico') {
    res.writeHead(302, { Location: FAVICON }); return res.end();
  }

  if (!made) {
    return send(res, 404, page({ title: 'Not found', body: '<div class="empty">Page not found. <a href="/">Back to your articles</a></div>', user, nonce }), { nonce });
  }
  return send(res, 200, page({ title, body: made.body, user, active, nonce, script: made.script }), { nonce });
}

module.exports = { handle };

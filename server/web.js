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
ul.articles li { display:flex; gap:.8rem; align-items:baseline; padding:.85rem .2rem; border-bottom:1px solid var(--line); }
ul.articles .main { flex:1; min-width:0; }
ul.articles .title { font-size:1.08rem; text-decoration:none; color:var(--fg); font-weight:600; }
ul.articles .title:hover { color:var(--accent); }
.meta { color:var(--muted); font-size:.8rem; font-family: system-ui, sans-serif; margin-top:.15rem; }
.actions { display:flex; gap:.35rem; font-family: system-ui, sans-serif; }
button.act { background:none; border:1px solid var(--line); border-radius:6px; color:var(--muted); cursor:pointer; font-size:.78rem; padding:.15rem .5rem; }
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
mark[data-hl] { background:var(--mark); color:inherit; padding:0 .1em; border-radius:2px; }
.hl-block { border-left:3px solid var(--accent); padding:.2rem 0 .2rem 1rem; margin:1rem 0; }
.hl-block .note { color:var(--muted); font-size:.9rem; }
.hl-block .from { font-size:.8rem; font-family:system-ui,sans-serif; margin-top:.2rem; }
.hl-count { font-size:.8rem; font-family:system-ui,sans-serif; color:var(--accent); white-space:nowrap; }
code.token { background:var(--card); border:1px solid var(--line); border-radius:6px; padding:.25rem .5rem; font-size:.85rem; user-select:all; overflow-wrap:anywhere; }
.reader-actions { margin-top:.6rem; }
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
#hl-tip { position:absolute; z-index:10; }
#hl-tip button { background:var(--accent); color:var(--accent-fg); border:none; border-radius:6px; padding:.35rem .8rem; cursor:pointer; font:.85rem system-ui,sans-serif; box-shadow:0 2px 8px rgba(0,0,0,.25); }
.settings dt { font-family:system-ui,sans-serif; font-size:.8rem; color:var(--muted); margin-top:1.2rem; }
.settings dd { margin:.25rem 0 0; }
.back { font-family:system-ui,sans-serif; font-size:.85rem; text-decoration:none; }
`;

function page({ title, body, user, active = '', nonce = '', script = '', articleCsp = false }) {
  const nav = user ? `
    <nav>
      <a href="/" class="${active === 'inbox' ? 'active' : ''}">Inbox</a>
      <a href="/?view=favorites" class="${active === 'favorites' ? 'active' : ''}">Favorites</a>
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
<title>${escapeHtml(title)} — ReadLater</title>
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
</head>
<body>
<header class="site"><a class="brand" href="/">📚 ReadLater</a>${nav}</header>
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

function listPage(ctx, user, view, url) {
  const get = (k) => url.searchParams.get(k) || '';
  const savedViews = ctx.store.listViews(user.id);
  const savedView = view.startsWith('v:') ? ctx.store.getView(view.slice(2), user.id) : null;

  const q = get('q').trim();
  const domain = get('domain').trim();
  const hl = get('hl') || (get('highlighted') === '1' ? '1' : '');
  const len = get('len');
  const searching = Boolean(q || domain || hl || len);

  let list, empty;
  if (savedView) {
    list = ctx.searchArticles(user, { ...savedView.filters, includeArchived: !!savedView.filters.includeArchived });
    empty = 'No articles match this view.';
  } else if (searching) {
    // search spans all views (archived included)
    list = ctx.searchArticles(user, { ...filtersFromParams(get), includeArchived: true });
    empty = 'No articles match this search.';
  } else if (view === 'favorites') { list = ctx.searchArticles(user, { favoriteOnly: true, includeArchived: true }); empty = 'No favorites yet — star an article to keep it here.'; }
  else if (view === 'archive') { list = ctx.searchArticles(user, { archivedOnly: true }); empty = 'Nothing archived yet.'; }
  else { list = ctx.searchArticles(user, {}); empty = 'Inbox empty — save something with the Firefox extension, or check <a href="/settings">Settings</a> to connect it.'; }

  // domain dropdown: every domain this user has saved from, with counts
  const domainOptions = ctx.store.domainCounts(user.id)
    .map(({ domain: h, n }) => `<option value="${escapeHtml(h)}" ${h === domain ? 'selected' : ''}>${escapeHtml(h)} (${n})</option>`).join('');

  // saved views as chips; × deletes (via the page script)
  const viewChips = savedViews.length ? `
<div class="views">${savedViews.map((v) => `
  <span class="view-chip ${savedView && savedView.id === v.id ? 'active' : ''}">
    <a href="/?view=v:${v.id}">${escapeHtml(v.name)}</a><button class="act del-view" data-view-id="${v.id}" title="Delete view">×</button>
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

  const searchForm = `
${viewChips}
<form class="search" method="get" action="/">
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
  <button class="act" type="submit">Search</button>
  ${searching || savedView ? '<a class="back" href="/">Clear</a>' : ''}
</form>
${savedView ? `<div class="meta">${list.length} article${list.length === 1 ? '' : 's'} in “${escapeHtml(savedView.name)}”</div>` : ''}
${searching && !savedView ? `<div class="meta">${list.length} result${list.length === 1 ? '' : 's'}${q ? ` for “${escapeHtml(q)}”` : ''}${domain ? ` from ${escapeHtml(domain)}` : ''}</div>${saveViewForm}` : ''}
${!searching && !savedView ? `<div class="meta">${list.length.toLocaleString('en-US')} article${list.length === 1 ? '' : 's'}</div>` : ''}`;

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
    return `<li data-id="${a.id}">
      <div class="main"><a class="title" href="/read/${a.id}">${escapeHtml(a.title)}</a>
      <div class="meta">${meta}</div></div>
      <div class="actions">
        <button class="act fav" data-act="favorite" data-val="${a.favorite ? 'false' : 'true'}" title="Favorite">${a.favorite ? '★' : '☆'}</button>
        <button class="act" data-act="archive" data-val="${a.archived ? 'false' : 'true'}">${a.archived ? 'Unarchive' : 'Archive'}</button>
        <button class="act" data-act="delete">Delete</button>
      </div></li>`;
  }).join('\n');

  const importBar = `
<div class="importbar meta">
  <button id="import-pdf" class="act">Import PDF…</button>
  <span id="import-status"></span>
  <input type="file" id="pdf-file" accept=".pdf,application/pdf" style="display:none">
</div>`;

  const body = searchForm + importBar + (list.length
    ? `<ul class="articles">${items}</ul>`
    : `<div class="empty">${empty}</div>`);

  const script = `
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
  const hlSection = hls.length ? `
  <section>
    <h2>Highlights</h2>
    ${hls.map((h) => `<div class="hl-block"><div>${escapeHtml(h.text)}</div>${h.note ? `<div class="note">${escapeHtml(h.note)}</div>` : ''}
      <div class="from meta"><button class="act" data-act="del-hl" data-id="${h.id}">Delete</button></div></div>`).join('\n')}
  </section>` : '';

  const body = `
<a class="back" href="/">&larr; Back to list</a>
<article class="reader">
  <header>
    <h1>${escapeHtml(article.title)}</h1>
    <div class="meta">${meta}${meta ? ' · ' : ''}<a href="${escapeHtml(article.url)}" rel="noopener noreferrer">original ↗</a></div>
    <div class="actions reader-actions">
      <button class="act fav" data-act="favorite" data-val="${article.favorite ? 'false' : 'true'}" title="Favorite">${article.favorite ? '★' : '☆'}</button>
      <button class="act" data-act="archive" data-val="${article.archived ? 'false' : 'true'}">${article.archived ? 'Unarchive' : 'Archive'}</button>
    </div>
    <div class="meta">Select any text to highlight it.</div>
  </header>
  <div class="content" id="content">${article.html}</div>
</article>
${hlSection}
<div id="hl-tip" hidden><button id="hl-save">Highlight</button></div>`;

  const script = `
const ARTICLE = ${JSON.stringify(article.id)};

// mark existing highlights in the rendered article (best-effort text match)
const HLS = ${JSON.stringify(hls.map((h) => h.text))};
const root = document.getElementById('content');
for (const text of HLS) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const i = node.nodeValue.indexOf(text);
    if (i < 0) continue;
    const range = document.createRange();
    range.setStart(node, i); range.setEnd(node, i + text.length);
    const mark = document.createElement('mark'); mark.dataset.hl = '1';
    try { range.surroundContents(mark); } catch (e) {}
    break;
  }
}

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
});`;
  return { body, script };
}

function highlightsPage(ctx, user) {
  // Grouped by article: which articles have highlights and how many. The
  // highlights themselves live on each article's reader page.
  const arts = ctx.store.highlightedArticles(user.id);
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
  const body = `<h1>Highlights</h1>
${arts.length ? `<div class="meta">${arts.length} article${arts.length === 1 ? '' : 's'} with highlights — open one to read them in place.</div>
<ul class="articles">${items}</ul>`
    : '<div class="empty">No highlights yet — long-press a paragraph in the Android app, or select text in the reader.</div>'}
<p class="meta"><a href="/api/highlights/export.md">Export all as Markdown</a></p>`;
  return { body, script: '' };
}

function settingsPage(ctx, user, url, req) {
  const msg = url.searchParams.get('msg');
  const origin = `${(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http'}://${req.headers.host || 'localhost'}`;
  const email = ctx.INBOUND_DOMAIN ? `
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
  <dt>Export your data</dt>
  <dd class="meta">
    <a href="/api/export.json">Everything as JSON</a> (articles with full text + highlights) ·
    <a href="/api/highlights/export.md">Highlights as Markdown</a>
  </dd>
</dl>`;
  return { body, script: '' };
}

// ---------------------------------------------------------------- handler
async function handle(ctx, req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const route = `${req.method} /${parts.join('/')}`;
  const user = ctx.getSessionUser(req);
  const nonce = crypto.randomBytes(16).toString('base64url');

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
    made = highlightsPage(ctx, user); title = 'Highlights'; active = 'highlights';
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

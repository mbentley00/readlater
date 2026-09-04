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

/**
 * JSON for embedding inside an inline <script>.
 *
 * JSON.stringify does not escape '<', so any value containing the literal
 * "</script>" closes the tag early — the rest of the reader's JS is then parsed
 * as HTML, silently killing highlights, archive and share, and injecting markup.
 * That is reachable without touching the account: a hostile page can put
 * anything in its og:url, and the extension saves it as the article URL. <
 * is the same string to JSON.parse, but inert to the HTML parser.
 */
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

/**
 * Reading-type settings, as a <head> script.
 *
 * Four CSS custom properties on <html> are the entire model; the Aa panel just
 * writes them. This has to run in the head, before first paint: applying it
 * from the body script instead would render the article at the default size and
 * then visibly reflow it on every page load.
 *
 * Per-device (localStorage) rather than per-account on purpose — the size that
 * suits a tablet on the sofa is not the size that suits a desktop monitor.
 */
const TYPE_SCRIPT = `
(function () {
  var KEY = 'earmark-type';
  var DEFAULTS = { family: 'serif', size: 19, lead: 165, width: 46 };
  var FAMILIES = {
    serif: "Georgia, 'Times New Roman', serif",
    sans: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    humanist: "'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif",
    mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
  };
  function clamp(v, lo, hi, dflt) {
    v = Number(v);
    return (isFinite(v) && v >= lo && v <= hi) ? Math.round(v) : dflt;
  }
  function read() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { s = {}; }
    return {
      family: FAMILIES[s.family] ? s.family : DEFAULTS.family,
      size: clamp(s.size, 14, 30, DEFAULTS.size),
      lead: clamp(s.lead, 130, 220, DEFAULTS.lead),
      width: clamp(s.width, 30, 70, DEFAULTS.width)
    };
  }
  function apply(s) {
    var r = document.documentElement.style;
    r.setProperty('--read-family', FAMILIES[s.family] || FAMILIES.serif);
    r.setProperty('--read-size', s.size + 'px');
    r.setProperty('--read-lead', String(s.lead / 100));
    r.setProperty('--read-width', s.width + 'rem');
  }
  function save(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {}
    apply(s);
  }
  window.__type = { read: read, save: save, apply: apply, DEFAULTS: DEFAULTS };
  apply(read());
})();
`;

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='13' font-size='13'%3E%F0%9F%93%9A%3C/text%3E%3C/svg%3E";

const CSS = `
:root { --bg:#faf9f7; --fg:#1a1a18; --muted:#77726a; --card:#ffffff; --line:#e6e2db; --accent:#3d6b52; --accent-fg:#ffffff; --mark:#f4e9c8; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#191a1c; --fg:#e8e6e1; --muted:#96918a; --card:#212326; --line:#33363a; --accent:#7fb99a; --accent-fg:#14150f; --mark:#4a4223; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 Georgia, 'Times New Roman', serif; }
a { color: var(--accent); }
/* Sticky: the reader puts Back and Highlights up here, and they are useless
   3,000 words down an article if the header has scrolled away. Below the
   highlights drawer (z-index 50) and the modals (80). */
header.site { position:sticky; top:0; z-index:40; display:flex; align-items:center; gap:1.25rem; padding:.8rem 1.2rem; border-bottom:1px solid var(--line); font-family: system-ui, sans-serif; background:var(--bg); }
header.site .brand { font-weight:700; text-decoration:none; color:var(--fg); font-size:1.05rem; white-space:nowrap; }
/* Wraps rather than overflowing: "Random Highlights" is long enough to push the
   search box and account block off a phone screen otherwise. */
header.site nav { display:flex; flex-wrap:wrap; gap:.35rem .9rem; flex:1; }
header.site nav a { text-decoration:none; color:var(--muted); font-size:.95rem; white-space:nowrap; }
header.site nav a.active { color:var(--fg); font-weight:600; }
header.site .who { color:var(--muted); font-size:.85rem; display:flex; align-items:center; gap:.6rem; }
header.site .who form { margin:0; }
/* Quick search, on every page. Sits between the nav (or the reader's own
   controls) and the account block, and grows when you focus it. */
header.site .hdr-search { margin:0; display:flex; flex:0 1 auto; min-width:0; }
header.site .hdr-search input { width:min(20ch,30vw); padding:.35rem .7rem; border:1px solid var(--line); border-radius:999px; background:var(--card); color:var(--fg); font:inherit; font-size:.85rem; font-family:system-ui,sans-serif; min-width:0; }
header.site .hdr-search input:focus { width:min(32ch,55vw); outline:2px solid var(--accent); outline-offset:1px; }
/* On a phone the reader header runs out of room first; the article title is
   the one thing already visible in the article itself, so it goes. */
@media (max-width:760px) {
  header.site { gap:.7rem; padding:.7rem .8rem; }
  header.site .hdr-title { display:none; }
  header.site .hdr-search input { width:min(12ch,26vw); }
}
/* Per-page controls standing in for the nav links (see page()). */
header.site .hdr-ctx { display:flex; align-items:center; gap:.75rem; flex:1; min-width:0; }
header.site .hdr-ctx .back { color:var(--muted); white-space:nowrap; }
/* The article title, shown only when there is room for it. */
header.site .hdr-title { font-family:system-ui,sans-serif; font-size:.9rem; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
header.site .hdr-ctx .act { margin-left:auto; white-space:nowrap; }
@media (max-width:700px) { header.site .hdr-title { display:none; } header.site { gap:.7rem; padding:.7rem .8rem; } }
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
/* Dropping a PDF/EPUB anywhere on the list imports it; outline the whole page
   so the target is obviously the window and not one small strip of it. */
body.dropping::after { content:'Drop to import'; position:fixed; inset:.5rem; z-index:90; display:flex; align-items:center; justify-content:center; border:2px dashed var(--accent); border-radius:12px; background:rgba(0,0,0,.35); color:var(--fg); font:600 1.1rem/1 system-ui,sans-serif; pointer-events:none; }
.actions { display:flex; gap:.35rem; font-family: system-ui, sans-serif; }
.skip-add { display:flex; gap:.4rem; margin:.6rem 0 .3rem; }
.skip-add input { flex:1; min-width:0; padding:.35rem .5rem; border:1px solid var(--line); border-radius:6px; background:transparent; color:var(--fg); }
ul.skip-rules { list-style:none; padding:0; margin:.5rem 0 0; }
ul.skip-rules li { display:flex; gap:.6rem; align-items:center; padding:.35rem 0; border-bottom:1px solid var(--line); }
ul.skip-rules .phrase { flex:1; min-width:0; color:var(--fg); overflow-wrap:anywhere; }
/* "Never import this text" editor, opened from the reader */
#skip-dialog, #reparse-dialog, #share-dialog, #type-dialog { position:fixed; inset:0; z-index:80; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; padding:1rem; }
#skip-dialog[hidden], #reparse-dialog[hidden], #share-dialog[hidden], #type-dialog[hidden] { display:none; }
/* Reading-type controls. Rows stay finger-sized: this is mostly used on a tablet. */
.type-row { display:flex; align-items:center; gap:.6rem; font-family:system-ui,sans-serif; font-size:.85rem; color:var(--muted); flex-wrap:wrap; }
.type-row input[type=range] { flex:1; min-width:9rem; accent-color:var(--accent); height:1.9rem; }
.type-row select { padding:.4rem .5rem; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); font-size:.9rem; margin-left:auto; }
.type-row output { color:var(--fg); font-variant-numeric:tabular-nums; min-width:3.2rem; }
.skip-box input.link { width:100%; box-sizing:border-box; padding:.5rem; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); font:.9rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
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
/* Reading type. The four custom properties are the whole settings model: the
   Aa panel writes them onto <html>, and an inline head script replays the saved
   values before first paint so the article never visibly reflows. */
body.reading main { max-width: var(--read-width, 46rem); }
article.reader .content { overflow-wrap:break-word; font-family:var(--read-family, Georgia, 'Times New Roman', serif); font-size:var(--read-size, 16px); line-height:var(--read-lead, 1.6); }
article.reader h1 { font-family:var(--read-family, Georgia, 'Times New Roman', serif); }
article.reader .content pre { overflow-x:auto; background:var(--card); padding:.8rem; border-radius:8px; font-size:.85rem; }
article.reader .content blockquote { border-left:3px solid var(--line); margin-left:0; padding-left:1rem; color:var(--muted); }
mark[data-hl], mark[data-hl-id] { background:var(--mark); color:inherit; padding:0 .1em; margin:0 -.1em; border-radius:2px; }
/* The negative margin cancels the padding's advance width, so a paragraph
   wraps identically whether or not it carries a highlight — removing one
   used to reflow the paragraph. It matters more than it looks: wrapRange()
   emits one <mark> per text node, so a highlight spanning an <em> or <i>
   becomes three marks and paid the padding at every internal seam, which
   showed up as visible gaps around the inline element. */
mark.flash { animation: hlflash 1.6s ease; }
@keyframes hlflash { 0%,100% { background:var(--mark); } 25% { background:var(--accent); color:var(--accent-fg); } }
.hl-panel { position:fixed; top:0; right:0; height:100%; width:min(360px,88vw); background:var(--card); border-left:1px solid var(--line); box-shadow:-4px 0 24px rgba(0,0,0,.15); overflow-y:auto; z-index:50; font-family:system-ui,sans-serif; }
.hl-panel-head { display:flex; align-items:center; justify-content:space-between; padding:.9rem 1rem; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--card); }
.hl-panel-body { padding:.5rem; }
.hl-item-loc { font-size:.75rem; color:var(--muted); margin-top:.25rem; }
.hl-item-loc a { color:var(--muted); }
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
/* Archive/Back repeated at the end of the article, where you actually finish. */
.end-actions { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap; margin-top:3rem; padding-top:1.2rem; border-top:1px solid var(--line); font-family:system-ui,sans-serif; }
.end-actions .act { font-size:.95rem; padding:.6rem 1.1rem; border-radius:8px; text-decoration:none; border:1px solid var(--line); color:var(--muted); background:none; cursor:pointer; }
.end-actions .act:hover { color:var(--fg); border-color:var(--muted); }
.end-actions button.act { color:var(--accent-fg); background:var(--accent); border-color:var(--accent); }
.end-actions button.act:hover { color:var(--accent-fg); opacity:.9; }
/* Public (shared) reader: a quiet strip saying where this came from. */
.pub-note { font-family:system-ui,sans-serif; font-size:.8rem; color:var(--muted); border-top:1px solid var(--line); margin-top:2.5rem; padding-top:.8rem; }
button.act.on { color:var(--accent); border-color:var(--accent); }
/* article count on a view chip — present but never louder than the name */
.chip-n { color:var(--muted); font-size:.85em; font-variant-numeric:tabular-nums; }
.view-chip.active .chip-n { color:inherit; opacity:.75; }
form.search { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; font-family:system-ui,sans-serif; font-size:.85rem; margin-bottom:1rem; }
form.search input[type=search] { flex:1; min-width:12rem; padding:.4rem .6rem; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); }
form.search select { padding:.35rem .4rem; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); max-width:14rem; }
/* Domain combobox — matches the selects it sits beside. */
form.search input[list] { width:13rem; padding:.4rem .6rem; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--fg); font:inherit; }
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
/* touch-action: a double-tap on the text is "highlight this paragraph", never
   "zoom". Declaring that in CSS lets the touch listeners stay passive, which
   is what keeps scrolling smooth on iPad — a non-passive touch handler makes
   WebKit wait for JS before it may scroll. */
article.reader .content { touch-action:manipulation; }
/* Floating bar: appears when you scroll UP mid-article (that's the "I want to
   do something other than keep reading" gesture) or when text is selected,
   so Back/Archive/Highlight are one tap away without returning to the top.
   Below the highlights drawer (50) and the modals (80). */
#float-bar { position:fixed; left:50%; bottom:calc(.9rem + env(safe-area-inset-bottom, 0px)); transform:translate(-50%, 140%); z-index:45; display:flex; align-items:center; gap:.3rem; padding:.35rem; border-radius:999px; background:var(--card); border:1px solid var(--line); box-shadow:0 6px 24px rgba(0,0,0,.18); font-family:system-ui,sans-serif; transition:transform .18s ease, opacity .18s ease; opacity:0; pointer-events:none; max-width:calc(100vw - 1.5rem); }
#float-bar.show { transform:translate(-50%, 0); opacity:1; pointer-events:auto; }
#float-bar .act, #float-bar a.act { font-size:.9rem; padding:.45rem .85rem; border-radius:999px; text-decoration:none; border:none; background:none; color:var(--fg); cursor:pointer; white-space:nowrap; }
#float-bar .act.primary { background:var(--accent); color:var(--accent-fg); }
#float-bar .sel-only { display:none; }
#float-bar.has-sel .sel-only { display:inline-block; }
/* Full-screen reading: just the text. The site header goes; the floating bar
   is how you get Back/Archive/exit while it's on. */
body.fullscreen header.site { display:none; }
body.fullscreen article.reader header .actions, body.fullscreen article.reader header .meta { display:none; }
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

/**
 * [headerExtra] lets a page put its own controls in the sticky header in place
 * of the nav links — the reader uses it for Back and Highlights. It replaces
 * rather than joins the nav so the header stays a single line on a phone.
 */
/** "/" focuses the header search from anywhere. Present on every signed-in page. */
const NAV_SCRIPT = `
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const box = document.querySelector('.hdr-search input');
  if (!box) return;
  e.preventDefault(); // otherwise the "/" lands in the box
  box.focus();
  box.select();
});`;

function page({ title, body, user, active = '', nonce = '', script = '', articleCsp = false, headerExtra = '', brandLink = true, noindex = false, bodyClass = '', headScript = '', searchQ = '' }) {
  const nav = user ? `
    <nav>
      <a href="/" class="${active === 'inbox' ? 'active' : ''}">Inbox</a>
      <a href="/?view=archive" class="${active === 'archive' ? 'active' : ''}">Archive</a>
      <a href="/?src=phone" class="${active === 'phone' ? 'active' : ''}" title="Saved from the phone's share sheet and short enough (under ~5 minutes of text) that the fetch may have missed content — open the original and re-save from Firefox to be sure the right version was kept">From phone</a>
      <a href="/highlights" class="${active === 'highlights' ? 'active' : ''}">Highlights</a>
      <a href="/highlights?sort=random" class="${active === 'highlights-random' ? 'active' : ''}">Random Highlights</a>
    </nav>` : '<nav></nav>';
  const who = user ? `
    <div class="who">
      <a href="/settings" class="${active === 'settings' ? 'active' : ''}">${escapeHtml(user.username)}</a>
      <form method="post" action="/logout"><button class="act" type="submit">Log out</button></form>
    </div>` : '';
  const middle = user && headerExtra ? headerExtra : nav;
  // Reachable from the reader and the highlights page too, not just the list —
  // the point is not having to navigate somewhere before you can search.
  const quickSearch = user ? `
    <form class="hdr-search" method="get" action="/" role="search">
      <input type="search" name="q" value="${escapeHtml(searchQ)}" placeholder="Search articles…" aria-label="Search articles" autocomplete="off">
    </form>` : '';
  const pageScript = [user ? NAV_SCRIPT : '', script].filter(Boolean).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
${noindex ? '<meta name="robots" content="noindex, nofollow">\n' : ''}<title>${escapeHtml(title)} — Earmark</title>
<link rel="icon" href="${FAVICON}">
<style>${CSS}</style>
${headScript ? `<script nonce="${nonce}">${headScript}</script>\n` : ''}</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
<header class="site">${brandLink ? '<a class="brand" href="/">📖 Earmark</a>' : '<span class="brand">📖 Earmark</span>'}${middle}${quickSearch}${who}</header>
<main>${body}</main>
${pageScript ? `<script nonce="${nonce}">${pageScript}</script>` : ''}
</body>
</html>`;
}

function send(res, status, html, { nonce = '', headers = {} } = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    // Every page here is per-account and changes the instant you archive or
    // favorite something. Sending no cache directive at all leaves browsers to
    // guess at freshness, and a reload issued right after an action can then be
    // answered from cache — the archived article stays on screen and the button
    // looks broken. Also stops a shared cache holding one account's inbox.
    'Cache-Control': 'no-store',
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

/**
 * Resolve what was typed in the domain box against the domains this user
 * actually has. An exact domain (or a parent of one, so "nytimes.com" still
 * pulls in "cooking.nytimes.com") filters exactly as before; anything else is
 * treated as a fragment and expands to every domain containing it, so "nyt"
 * finds nytimes.com and nyti.ms. A fragment matching nothing stays exact, which
 * keeps the empty state honest rather than silently showing everything.
 */
function domainFilter(typed, known) {
  const d = String(typed || '').trim().toLowerCase().replace(/^www\./, '');
  if (!d) return {};
  if (known.some((k) => k === d || k.endsWith('.' + d))) return { domain: d };
  const hits = known.filter((k) => k.includes(d));
  return hits.length ? { domains: hits } : { domain: d };
}

/**
 * Which articles a search is allowed to reach, by their state.
 *
 * 'any' is the default because a search you typed is a search of everything —
 * an article you archived last year is exactly what you're usually digging for.
 * The other three narrow it, which is what the inbox needed: until now a search
 * silently spanned the archive with no way to say "only the ones I haven't
 * dealt with yet".
 */
const STATES = {
  any: { includeArchived: true },
  inbox: { includeArchived: false },
  archived: { archivedOnly: true },
  favorites: { favoriteOnly: true, includeArchived: true },
};
const STATE_LABELS = {
  any: 'Anywhere',
  inbox: 'Inbox only',
  archived: 'Archived only',
  favorites: 'Favorites only',
};
const cleanState = (v) => (STATES[v] ? v : 'any');

/**
 * Where an article came from, grouped for the "Saved from" filter. The phone
 * group is the one that earns its keep: the share sheet makes the server
 * fetch the page, which can miss paywalled or JS-rendered content the Firefox
 * extension (capturing the live DOM) would have got — so those are the saves
 * worth opening in Firefox and saving again. A Firefox re-save moves the
 * article out of the group (server: POST /api/articles updates `source`).
 */
const SOURCES = {
  phone: { label: 'Saved from phone', sources: ['android-share'] },
  firefox: { label: 'Saved from Firefox', sources: ['browser-page', 'browser-link', 'browser-highlight'] },
  email: { label: 'Saved by email', sources: ['email'] },
  import: { label: 'Imported PDF/EPUB', sources: ['pdf', 'epub'] },
  kindle: { label: 'Kindle books', sources: ['kindle'] },
  podcast: { label: 'Podcast transcripts', sources: ['audio'] },
};
const cleanSrc = (v) => (SOURCES[v] ? v : '');

/** Build searchArticles filters from web form params (q/domain/hl/len/state/src). */
function filtersFromParams(get, knownDomains = []) {
  const hl = get('hl') || (get('highlighted') === '1' ? '1' : '');
  const src = cleanSrc(get('src'));
  // The "From phone" list is a to-do list: shares whose server-side fetch may
  // have missed content, worth re-saving from Firefox. A share that landed
  // with more than ~5 minutes of reading (the app's "short" cutoff at 225 wpm)
  // clearly imported fine, so it has no business on the list. Only when the
  // user hasn't asked for a length bucket themselves, which must win.
  const phoneCap = src === 'phone' && !LEN_BUCKETS[get('len') || ''] ? { maxWords: 1124 } : {};
  return {
    sources: src ? SOURCES[src].sources : [],
    ...phoneCap,
    q: (get('q') || '').trim(),
    ...domainFilter(get('domain'), knownDomains),
    highlighted: hl === '1',
    minHighlights: hl && hl !== '1' ? (parseInt(hl, 10) || 0) : 0,
    ...(LEN_BUCKETS[get('len') || ''] || {}),
    // Owns includeArchived/archivedOnly/favoriteOnly, so callers must not
    // clamp them afterwards or the state dropdown silently does nothing.
    ...STATES[cleanState(get('state'))],
  };
}

/** A type-to-filter domain box: native combobox, no JS, substring matching. */
function domainPicker(rows, current) {
  const opts = rows.map(({ domain: d, n }) =>
    `<option value="${escapeHtml(d)}">${escapeHtml(d)} (${n})</option>`).join('');
  return `<input name="domain" list="domain-list" value="${escapeHtml(current)}"
    placeholder="Any domain — type to filter" autocomplete="off" spellcheck="false">
  <datalist id="domain-list">${opts}</datalist>`;
}

const PAGE_SIZE = 50;
const SORTS = { newest: 'Newest', oldest: 'Oldest', longest: 'Longest', shortest: 'Shortest', random: 'Random' };

/** A shuffle seed: kept in the URL so paging through a random order is stable. */
const newSeed = () => crypto.randomBytes(4).toString('hex');
const cleanSeed = (s) => (/^[a-z0-9]{1,16}$/i.test(s) ? s : '');

/**
 * The sort you picked sticks, in a cookie, until you pick another one. That
 * is mostly about Random: the order is a hash of (seed, article id), so
 * keeping the seed keeps the order — coming back to the list tomorrow shows
 * the same pile in the same order, with anything saved since dropped in at a
 * random spot rather than everything reshuffling. Only an explicit ?sort=
 * (the dropdown) or ↻ Shuffle (a fresh seed) changes it. Cookie value is
 * `<sort>` or `random:<seed>`; a bad or missing one means "newest".
 */
const PREF_COOKIE_AGE = 60 * 60 * 24 * 365;
const prefCookie = (name, value) => `${name}=${value}; Path=/; SameSite=Lax; HttpOnly; Max-Age=${PREF_COOKIE_AGE}`;
function parseCookies(req) {
  const out = {};
  for (const part of String((req && req.headers && req.headers.cookie) || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
/** Resolve sort + seed from ?sort/?seed and the stored pref; returns the cookie to set, if any. */
function stickySort(get, stored, sorts, dflt) {
  const [storedSort, storedSeed] = String(stored || '').split(':');
  const asked = get('sort');
  const sort = sorts[asked] ? asked : (sorts[storedSort] ? storedSort : dflt);
  const seed = sort === 'random'
    ? (cleanSeed(get('seed')) || (storedSort === 'random' ? cleanSeed(storedSeed || '') : '') || newSeed())
    : '';
  const value = sort === 'random' ? `random:${seed}` : sort;
  return { sort, seed, setCookie: value !== stored ? value : '' };
}

/**
 * Where "Back" should go, taken from ?from=. The list a reader was opened from
 * has to travel in the URL because the site sends `no-referrer`, so there is no
 * Referer to read it out of. This ends up in an href, so it must never be able
 * to become an absolute URL: same-origin absolute paths only, and a leading
 * `//` or `/\` (which browsers resolve as protocol-relative) is rejected.
 */
const safeBackTo = (v) => (/^\/(?![/\\])[^\s"'<>]*$/.test(v || '') ? v : '/');

/** Article link that remembers the list it was opened from. */
const readHref = (id, backTo) =>
  `/read/${id}${backTo && backTo !== '/' ? `?from=${encodeURIComponent(backTo)}` : ''}`;

function listPage(ctx, user, view, url, prefs = {}) {
  const get = (k) => url.searchParams.get(k) || '';
  const savedViews = ctx.store.listViews(user.id);
  const savedView = view.startsWith('v:') ? ctx.store.getView(view.slice(2), user.id) : null;

  const q = get('q').trim();
  const domain = get('domain').trim();
  const hl = get('hl') || (get('highlighted') === '1' ? '1' : '');
  const len = get('len');
  const state = cleanState(get('state'));
  const src = cleanSrc(get('src'));
  // Sort (and the random order's seed) persist across visits — see stickySort.
  const { sort, seed, setCookie } = stickySort(get, prefs.sort, SORTS, 'newest');
  // Narrowing the state counts as searching on its own: "show me everything
  // still in my inbox" is a useful query with no words in it.
  const searching = Boolean(q || domain || hl || len || src || state !== 'any');
  const pageNum = Math.max(1, parseInt(get('page'), 10) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;
  // On the Archive tab "Newest" means most recently archived — the list is a
  // record of what you have filed away, so ordering it by save date hid this
  // morning's archiving behind whatever was saved most recently. Only for the
  // plain tab: a search or a saved view keeps the ordinary savedAt meaning.
  const archiveOrder = view === 'archive' && !savedView && !searching;
  const effSort = archiveOrder && (sort === 'newest' || sort === 'oldest')
    ? `${sort}Archived` : sort;
  const paging = { sort: effSort, seed, limit: PAGE_SIZE, offset };

  // Every domain this user has saved from, with counts — both the picker's
  // options and the list a typed fragment is resolved against.
  const domainRows = ctx.store.domainCounts(user.id);
  const knownDomains = domainRows.map((r) => r.domain);

  // Base filters that define the current view/search (used for both list + count).
  let baseFilters, empty;
  if (savedView) {
    // Resolve the stored domain the same way the search box does, or a view
    // saved from a typed fragment ("nyt") would come back empty.
    baseFilters = {
      ...savedView.filters,
      ...domainFilter(savedView.filters.domain, knownDomains),
      includeArchived: !!savedView.filters.includeArchived,
    };
    empty = 'No articles match this view.';
  } else if (searching) {
    // filtersFromParams already resolved the state (defaulting to 'any', which
    // spans the archive) — don't override it here.
    baseFilters = filtersFromParams(get, knownDomains);
    empty = src === 'phone' && !q && !domain && !hl && !len && state === 'any'
      ? 'Nothing saved from the phone is waiting — everything shared from it has since been re-saved from Firefox (or deleted).'
      : 'No articles match this search.';
  } else if (view === 'favorites') { baseFilters = { favoriteOnly: true, includeArchived: true }; empty = 'No favorites yet — star an article to keep it here.'; }
  else if (view === 'archive') { baseFilters = { archivedOnly: true }; empty = 'Nothing archived yet.'; }
  else { baseFilters = {}; empty = 'Inbox empty — save something with the Firefox extension, or check <a href="/settings">Settings</a> to connect it.'; }

  const total = ctx.countArticles(user, baseFilters);
  const list = ctx.searchArticles(user, { ...baseFilters, ...paging });
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
  <span class="view-chip ${!savedView && !searching && !['favorites', 'archive'].includes(view) ? 'active' : ''}">
    <a href="/">Inbox${chipCount(inboxCount)}</a>
  </span>${savedViews.map((v) => `
  <span class="view-chip ${savedView && savedView.id === v.id ? 'active' : ''}">
    <a href="/?view=v:${v.id}">${escapeHtml(v.name)}${chipCount(countFor({ ...v.filters, ...domainFilter(v.filters.domain, knownDomains), includeArchived: !!v.filters.includeArchived }))}</a><button class="act del-view" data-view-id="${v.id}" title="Delete view">×</button>
  </span>`).join('')}
</div>` : '';

  // while searching (and not inside a saved view), offer to save the filters
  const saveViewForm = searching && !savedView ? `
<form class="saveview" method="post" action="/views/save">
  <input type="hidden" name="q" value="${escapeHtml(q)}">
  <input type="hidden" name="domain" value="${escapeHtml(domain)}">
  <input type="hidden" name="hl" value="${escapeHtml(hl)}">
  <input type="hidden" name="len" value="${escapeHtml(len)}">
  <input type="hidden" name="state" value="${escapeHtml(state)}">
  <input type="hidden" name="src" value="${escapeHtml(src)}">
  <input name="name" placeholder="Name this view…" required maxlength="64">
  <button class="act" type="submit">Save as view</button>
</form>` : '';

  const viewParam = get('view');
  // Build a URL preserving the current view/filters/sort with overrides.
  const buildQs = (overrides) => {
    const cur = { view: viewParam, q, domain, len, hl, src, state: state === 'any' ? '' : state, sort, seed, ...overrides };
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
  <input type="search" name="q" value="${escapeHtml(q)}" placeholder="Search title, author, text, highlights…">
  ${domainPicker(domainRows, domain)}
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
  <select name="state" title="Which articles to search">${Object.entries(STATE_LABELS)
    .map(([k, label]) => `<option value="${k}" ${k === state ? 'selected' : ''}>${label}</option>`).join('')}
  </select>
  <select name="src" title="How the article was saved">
    <option value="">Saved from: anywhere</option>${Object.entries(SOURCES)
    .map(([k, { label }]) => `<option value="${k}" ${k === src ? 'selected' : ''}>${label}</option>`).join('')}
  </select>
  <select name="sort">${sortOptions}</select>
  <button class="act" type="submit">Search</button>
  ${sort === 'random' ? `<a class="act" href="${buildQs({ seed: newSeed(), page: '' })}" title="Reshuffle">↻ Shuffle</a>` : ''}
  ${searching || savedView ? `<a class="back" href="${viewParam ? `/?view=${escapeHtml(viewParam)}` : '/'}">Clear</a>` : ''}
</form>
${savedView ? `<div class="meta">${total.toLocaleString('en-US')} article${total === 1 ? '' : 's'} in “${escapeHtml(savedView.name)}”</div>` : ''}
${searching && !savedView ? `<div class="meta">${total.toLocaleString('en-US')} result${total === 1 ? '' : 's'}${q ? ` for “${escapeHtml(q)}”` : ''}${domain ? ` from ${escapeHtml(domain)}` : ''}${state !== 'any' ? ` · ${escapeHtml(STATE_LABELS[state].toLowerCase())}` : ''}${src ? ` · ${escapeHtml(SOURCES[src].label.toLowerCase())}` : ''}${src === 'phone' && total ? ' — open the original and save it again from Firefox to be sure the right version was kept' : ''}</div>${saveViewForm}` : ''}
${!searching && !savedView ? `<div class="meta">${total.toLocaleString('en-US')} article${total === 1 ? '' : 's'}</div>` : ''}`;

  const pager = pageCount > 1 ? `<div class="pager">
  ${pageNum > 1 ? `<a class="act" href="${buildQs({ page: pageNum - 1 })}">← Prev</a>` : '<span class="act disabled">← Prev</span>'}
  <span class="meta">Page ${pageNum} of ${pageCount}</span>
  ${pageNum < pageCount ? `<a class="act" href="${buildQs({ page: pageNum + 1 })}">Next →</a>` : '<span class="act disabled">Next →</span>'}
</div>` : '';

  const hlCounts = ctx.store.highlightCountsByArticle(user.id);
  // Every article link carries this list back with it — view, filters, sort,
  // shuffle seed and page — so the reader's Back returns to exactly this screen.
  const backTo = buildQs({});
  const items = list.map((a) => {
    const hlCount = hlCounts.get(a.id) || 0;
    const meta = [
      a.siteName || a.domain || null, // imported articles often lack a site name
      a.byline, fmtDate(a.savedAt),
      a.wordCount > 0 ? `~${Math.max(1, Math.round(a.wordCount / 225))} min` : null,
      a.readParagraph > 0 ? `¶${a.readParagraph} in progress` : null,
      hlCount ? `${hlCount} highlight${hlCount > 1 ? 's' : ''}` : null,
      // So it's visible from the list which articles are readable by anyone
      // holding a link, without opening each one.
      a.shareId ? 'shared' : null,
      a.source === 'android-share' ? 'saved from phone' : null,
    ].filter(Boolean).map(escapeHtml).join(' · ');
    // The real page, in a new tab: from here you can re-save it with the
    // extension. (The reader's "view original" shows the *captured* copy,
    // which is the wrong thing when the point is to check the capture.)
    const openOriginal = /^https?:\/\//i.test(a.url || '')
      ? `${meta ? ' · ' : ''}<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">open original ↗</a>`
      : '';
    const thumb = a.imageUrl && /^https?:\/\//i.test(a.imageUrl)
      ? `<img class="thumb" src="${escapeHtml(a.imageUrl)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
      : '';
    return `<li data-id="${a.id}">
      <div class="main"><a class="title" href="${escapeHtml(readHref(a.id, backTo))}">${escapeHtml(a.title)}</a>
      <div class="meta">${meta}${openOriginal}</div></div>
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
  <button id="import-doc" class="act" title="PDF and EPUB import as-is; an audio file (a downloaded podcast episode) is transcribed into a readable article">Import PDF, EPUB or audio…</button>
  ${isInbox ? '<button id="bulk-archive" class="act">Archive older than 1 year</button>' : ''}
  <span id="import-status"></span>
  <input type="file" id="doc-file" multiple
    accept=".pdf,.epub,.mp3,.m4a,.aac,.ogg,.opus,.wav,.flac,application/pdf,application/epub+zip,audio/*" style="display:none">
</div>`;

  const body = searchForm + importBar + (list.length
    ? `<ul class="articles">${items}</ul>${pager}`
    : `<div class="empty">${empty}</div>`);

  const script = `
// Which list this is, so a toggle knows whether the row still belongs here.
// Saved views and searches report 'other': their membership rules are the
// server's business, so those fall back to a reload.
const VIEW = ${jsonForScript(savedView || searching ? 'other'
  : (['favorites', 'archive'].includes(view) ? view : 'inbox'))};

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
  const li = btn.closest('li[data-id]'); if (!li) return;
  const id = li.dataset.id;
  const act = btn.dataset.act;
  const on = btn.dataset.val === 'true';

  btn.disabled = true;
  let res;
  if (act === 'delete') {
    if (!confirm('Delete this article and its highlights?')) { btn.disabled = false; return; }
    res = await fetch('/api/articles/' + id, { method: 'DELETE' });
  } else {
    res = await fetch('/api/articles/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // data-act is the verb ('archive'); the API field is the state
      // ('archived'). Sending the verb silently did nothing.
      body: JSON.stringify({ [act === 'archive' ? 'archived' : act]: on }),
    });
  }
  // A failed request used to fall through to reload() and look exactly like
  // "the button does nothing" — an expired session being the likeliest cause.
  if (!res.ok) {
    btn.disabled = false;
    alert(res.status === 401
      ? 'Your session has expired — log in again, then retry.'
      : 'That did not save (the server said ' + res.status + ').');
    return;
  }

  // Take the row out here rather than leaning on the reload. The row is gone
  // the moment the server agrees, so the result is visible even if the reload
  // is slow, and there is no flash of the article still sitting in the list.
  const gone = act === 'delete'
    || (act === 'archive' && (VIEW === 'inbox' || VIEW === 'archive'))
    || (act === 'favorite' && VIEW === 'favorites' && !on);
  if (gone) {
    li.remove();
    if (!document.querySelector('ul.articles li')) location.reload(); // show the empty state
    return;
  }
  location.reload(); // saved views and searches: let the server decide membership
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

// Document import: pick PDFs/EPUBs (or drop them on the page), POST each raw,
// reload to show the new articles. The server sniffs the format from the bytes,
// so nothing here has to work out which is which.
const docBtn = document.getElementById('import-doc');
const docFile = document.getElementById('doc-file');
const docStatus = document.getElementById('import-status');

async function importDocs(files) {
  const list = [...files];
  if (!list.length) return;
  if (docBtn) docBtn.disabled = true;
  const failed = [];
  let done = 0;
  // One at a time: parsing is synchronous on a single-threaded server, so
  // firing a dozen books at once would just queue them while blocking
  // everything else the server has to answer.
  for (const f of list) {
    docStatus.textContent = list.length > 1
      ? 'Importing ' + (done + 1) + ' of ' + list.length + ': ' + f.name + '…'
      : 'Importing ' + f.name + '…';
    try {
      const res = await fetch('/api/import/file?filename=' + encodeURIComponent(f.name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: f,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        failed.push(f.name + ' — ' + (err.error || res.status));
      }
    } catch (e) {
      failed.push(f.name + ' — ' + e.message);
    }
    done++;
  }
  if (docBtn) docBtn.disabled = false;
  if (docFile) docFile.value = ''; // so re-picking the same file fires 'change'
  // Reload when anything landed, so the new articles are actually visible; keep
  // the failures on screen when nothing did.
  if (failed.length < list.length) {
    if (failed.length) alert('Some files could not be imported:\\n\\n' + failed.join('\\n'));
    location.reload();
  } else {
    docStatus.textContent = 'Import failed: ' + failed.join('; ');
  }
}

if (docBtn) docBtn.addEventListener('click', () => docFile.click());
if (docFile) docFile.addEventListener('change', () => importDocs(docFile.files));

// Drag a book anywhere onto the list to import it.
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
    e.preventDefault();
    document.body.classList.add('dropping');
  }
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dropping');
});
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  document.body.classList.remove('dropping');
  importDocs(e.dataTransfer.files);
});`;
  return { body, script, setCookie };
}

/**
 * The article as a stranger sees it at /p/<shareId>: the parsed text and
 * nothing else.
 *
 * Everything personal is left out by construction rather than by hiding it —
 * this builds its own body instead of reusing readerPage(), so highlights,
 * notes, reading position, favorite/archive state, the "view original" copy of
 * the captured source (which may be a page you were logged in to) and the
 * owner's identity cannot leak by someone later adding a field to the reader.
 * `savedAt` is left out for the same reason: when you filed something away is
 * your business, not the reader's.
 */
function publicReaderPage(article) {
  const meta = [
    article.siteName || null,
    article.byline || null,
    article.publishedAt ? fmtDate(article.publishedAt) : null,
  ].filter(Boolean).map(escapeHtml).join(' · ');
  const original = /^https?:\/\//i.test(article.url || '')
    ? `<a href="${escapeHtml(article.url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(article.url)}</a>`
    : '';

  const body = `
<article class="reader">
  <header>
    <h1>${escapeHtml(article.title)}</h1>
    ${meta ? `<div class="meta">${meta}</div>` : ''}
  </header>
  <div class="content">${article.html || ''}</div>
  <div class="pub-note">Shared read-only via Earmark.${original ? ` Original: ${original}` : ''}</div>
</article>`;
  return { body };
}

function readerPage(ctx, user, article, url) {
  const hls = ctx.store.highlightsForArticle(article.id);
  const backTo = safeBackTo(url && url.searchParams.get('from'));
  // These two live in the sticky header rather than in the article, so they stay
  // reachable at any scroll depth.
  const headerExtra = `
    <div class="hdr-ctx">
      <a class="back" href="${escapeHtml(backTo)}">&larr; Back</a>
      <span class="hdr-title">${escapeHtml(article.title)}</span>
      <button class="act" id="hl-toggle">Highlights (${hls.length})</button>
    </div>`;
  const meta = [article.siteName, article.byline, fmtDate(article.savedAt)].filter(Boolean).map(escapeHtml).join(' · ');
  // An uploaded PDF/EPUB has no original to go back to: nothing to re-fetch (the
  // url is a content hash) and no captured source (the file itself isn't kept).
  // The link would only ever reach "no original source was kept".
  // A Kindle-imported article is keyed kindle:<ASIN>; that ASIN is what makes
  // each highlight traceable back to its spot in the actual book.
  const kindleAsin = (/^kindle:(.+)$/i.exec(article.url || '') || [])[1] || '';
  const kindleHref = (loc) => `https://read.amazon.com/?asin=${encodeURIComponent(kindleAsin.toUpperCase())}`
    + (loc ? `&location=${encodeURIComponent(loc)}` : '');
  const hasOriginal = !/^(pdf|epub|audio|kindle):/i.test(article.url || '');
  const originalLink = hasOriginal
    ? `${meta ? ' · ' : ''}<a href="/read/${escapeHtml(article.id)}/original" target="_blank" rel="noopener noreferrer">view original ↗</a>`
    // An imported book has no captured source, but it does have a real place to
    // go back to: the book itself, in the Kindle reader.
    : (kindleAsin ? `${meta ? ' · ' : ''}<a href="${escapeHtml(kindleHref(''))}" target="_blank" rel="noopener noreferrer">open in Kindle ↗</a>` : '');
  const hlItems = hls.map((h) => `<div class="hl-item" data-hl-id="${h.id}">
      <div class="hl-item-text">${escapeHtml(h.text)}</div>
      ${h.note ? `<div class="note">${escapeHtml(h.note)}</div>` : ''}
      ${h.location ? `<div class="hl-item-loc">${kindleAsin
        ? `<a href="${escapeHtml(kindleHref(h.location))}" target="_blank" rel="noopener noreferrer">Location ${escapeHtml(h.location)} ↗</a>`
        : `Location ${escapeHtml(h.location)}`}</div>` : ''}
      <div class="hl-item-actions"><button class="act del-hl" data-id="${h.id}">Delete</button></div>
    </div>`).join('\n');

  const body = `
<article class="reader">
  <header>
    <h1>${escapeHtml(article.title)}</h1>
    <div class="meta">${meta}${originalLink}</div>
    <div class="actions reader-actions">
      <button class="act fav" data-act="favorite" data-val="${article.favorite ? 'false' : 'true'}" title="Favorite">${article.favorite ? '★' : '☆'}</button>
      <button class="act" data-act="archive" data-val="${article.archived ? 'false' : 'true'}">${article.archived ? 'Unarchive' : 'Archive'}</button>
      <button class="act${article.shareId ? ' on' : ''}" id="share-btn" title="Public link to the parsed article — your highlights are not shown">${article.shareId ? 'Shared ✓' : 'Share'}</button>
      <button class="act" id="type-btn" title="Text size, spacing, width and typeface">Aa</button>
      <button class="act" id="fs-btn" title="Full screen (f)">&#x26F6;</button>
      <button class="act" id="reparse-btn" title="Re-extract this article if it was parsed wrong">Fix parsing</button>
    </div>
    <div class="meta">Select text — or double-tap a paragraph — to highlight it. Scroll up mid-article for Back / Archive.</div>
  </header>
  <div class="content" id="content">${article.html}</div>
  <!-- Finishing an article is the moment you want to file it, and that moment
       happens at the BOTTOM. Scrolling back up to the header to archive was the
       one thing the reader made you do twice. -->
  <div class="end-actions">
    <button class="act big" data-act="archive" data-val="${article.archived ? 'false' : 'true'}">${article.archived ? 'Unarchive' : 'Archive'}${article.archived ? '' : ' and go back'}</button>
    <a class="act big" href="${escapeHtml(backTo)}">Back to the list</a>
  </div>
</article>
<aside id="hl-panel" class="hl-panel" hidden>
  <div class="hl-panel-head"><strong>Highlights (${hls.length})</strong><button class="act" id="hl-close">×</button></div>
  <div class="hl-panel-body">${hls.length ? hlItems : '<div class="meta">No highlights yet. Select text in the article to add one.</div>'}</div>
</aside>
<div id="hl-tip" hidden><button id="hl-save">Highlight</button><button id="skip-save" title="Drop this text from articles saved in future">Never import</button></div>
<div id="float-bar">
  <a class="act" href="${escapeHtml(backTo)}">&larr; Back</a>
  <button class="act" data-act="archive" data-val="${article.archived ? 'false' : 'true'}">${article.archived ? 'Unarchive' : 'Archive'}</button>
  <button class="act" id="fs-float" title="Full screen">&#x26F6;</button>
  <button class="act primary sel-only" id="hl-save-float">Highlight</button>
  <button class="act sel-only" id="skip-save-float" title="Drop this text from articles saved in future">Never import</button>
</div>
<div id="hl-menu" hidden><button id="hl-menu-del">Delete highlight</button><button id="hl-menu-skip">Never import</button></div>
<div id="type-dialog" hidden>
  <div class="skip-box">
    <strong>Reading type</strong>
    <div class="meta">Applies to every article, on this device.</div>
    <label class="type-row">Typeface
      <select id="type-family">
        <option value="serif">Serif (Georgia)</option>
        <option value="sans">Sans (system)</option>
        <option value="humanist">Humanist (Iowan, Palatino)</option>
        <option value="mono">Monospace</option>
      </select>
    </label>
    <label class="type-row">Text size <output id="type-size-out"></output>
      <input type="range" id="type-size" min="14" max="30" step="1">
    </label>
    <label class="type-row">Line spacing <output id="type-lead-out"></output>
      <input type="range" id="type-lead" min="130" max="220" step="5">
    </label>
    <label class="type-row">Column width <output id="type-width-out"></output>
      <input type="range" id="type-width" min="30" max="70" step="2">
    </label>
    <div class="skip-actions">
      <button class="act" id="type-reset" type="button">Reset</button>
      <button class="act" id="type-close" type="button">Done</button>
    </div>
  </div>
</div>
<div id="share-dialog" hidden>
  <div class="skip-box">
    <strong>Public link</strong>
    <div class="meta">Anyone with this link can read the parsed article — no account needed.
    Your highlights, notes and reading position are not shown. Stop sharing to break the link.</div>
    <input class="link" id="share-url" readonly value="">
    <div id="share-msg" class="meta"></div>
    <div class="skip-actions">
      <button class="act" id="share-revoke" type="button">Stop sharing</button>
      <button class="act" id="share-close" type="button">Close</button>
      <button class="act" id="share-copy" type="button">Copy link</button>
    </div>
  </div>
</div>
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
const ARTICLE = ${jsonForScript(article.id)};
const ORIGINAL_URL = ${jsonForScript(article.url || '')};
const HAS_ORIGINAL = ${jsonForScript(hasOriginal)};
const BACK_TO = ${jsonForScript(backTo)};

// Keyboard shortcuts: o = open the original, e = archive and go back.
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (e.key === 'o') {
    if (HAS_ORIGINAL) window.open('/read/' + ARTICLE + '/original', '_blank', 'noopener');
  } else if (e.key === 'e') {
    e.preventDefault();
    fetch('/api/articles/' + ARTICLE, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    }).then(() => { location.href = BACK_TO; });
  }
});

// Anchor stored highlights onto the rendered article, tagging each mark with its
// id so the panel can jump to it. Matching is deliberately fuzzy: a highlight
// saved on Android carries markdown markers ("*Tribune*") and collapsed
// whitespace the rendered HTML ("<em>Tribune</em>") lacks, and a highlight can
// span inline elements. So we canonicalize both sides, match in canonical space,
// map the offsets back to the DOM, and wrap the range even across text nodes.
const HLS = ${jsonForScript(hls.map((h) => ({ id: h.id, text: h.text })))};
const root = document.getElementById('content');
function isWs(c) { const n = c.charCodeAt(0); return n === 32 || n === 9 || n === 10 || n === 13 || n === 160; }
function canonChar(c) {
  const n = c.charCodeAt(0);
  if (n === 0x2018 || n === 0x2019 || n === 0x201B || n === 0x2032) return "'";
  if (n === 0x201C || n === 0x201D || n === 0x201F || n === 0x2033) return '"';
  if (n === 0x2013 || n === 0x2014 || n === 0x2212) return '-';
  return c;
}
// Markdown constructs the reader renders as something shorter than the source.
// "[press release](https://…)" shows as "press release", so leaving the URL in
// the needle means searching the article for text it does not contain — and the
// whole highlight fails to anchor. Images vanish entirely; code keeps its text
// but loses the backticks.
function stripMarkdown(s) {
  return String(s)
    .replace(/!\\[[^\\]]*\\]\\([^\\s)]*(?:\\s+"[^"]*")?\\)/g, '')
    .replace(/\\[([^\\]]*)\\]\\([^\\s)]*(?:\\s+"[^"]*")?\\)/g, '$1')
    .replace(/\`+/g, '');
}
function canonNeedle(s) {
  const src = stripMarkdown(s);
  let out = '', prevSpace = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
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
// Wrap [text] where it occurs in the article, if it does. The index is rebuilt
// per call so text already marked is excluded — which also stops a second
// attempt from re-matching what the first one just wrapped.
function anchor(text, id) {
  const { segs, canon, map } = buildIndex();
  const ci = canon.indexOf(text);
  if (ci < 0) return false;
  wrapRange(segs, map[ci], map[ci + text.length - 1] + 1, id);
  return true;
}
function anchorHighlight(h) {
  const needle = canonNeedle(h.text);
  if (!needle) return;
  if (anchor(needle, h.id)) return;
  // The stored text still doesn't line up with the rendered article — some
  // markdown we don't know about, an edit upstream, a reparse. Rather than show
  // nothing at all, mark whichever sentences do line up. Short fragments are
  // skipped: "Yes." would match almost anywhere.
  for (const chunk of (needle.match(/[^.!?]+[.!?]*/g) || [])) {
    const c = chunk.trim();
    if (c.length >= 24) anchor(c, h.id);
  }
}
for (const h of HLS) anchorHighlight(h);

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
function wirePanelItem(item) {
  item.addEventListener('click', (e) => { if (!e.target.closest('button')) flashMark(item.dataset.hlId); });
  const b = item.querySelector('.del-hl');
  if (b) b.addEventListener('click', (e) => { e.stopPropagation(); deleteHighlight(b.dataset.id); });
}
document.querySelectorAll('.hl-item').forEach(wirePanelItem);
// A freshly saved highlight goes straight into the page: mark the text and add
// a panel row. Reloading did the same thing with a flash of blank page, which
// on a tablet read as "the app just refreshed on me".
function addHighlightToDom(h) {
  HLS.push({ id: h.id, text: h.text });
  anchorHighlight(h);
  const body = panel.querySelector('.hl-panel-body');
  if (body) {
    if (!body.querySelector('.hl-item')) body.innerHTML = '';
    const item = document.createElement('div');
    item.className = 'hl-item';
    item.dataset.hlId = h.id;
    const t = document.createElement('div'); t.className = 'hl-item-text'; t.textContent = h.text;
    const acts = document.createElement('div'); acts.className = 'hl-item-actions';
    const del = document.createElement('button'); del.className = 'act del-hl'; del.dataset.id = h.id; del.textContent = 'Delete';
    acts.appendChild(del); item.appendChild(t); item.appendChild(acts);
    body.appendChild(item);
    wirePanelItem(item);
  }
  const n = panel.querySelectorAll('.hl-item').length;
  document.getElementById('hl-toggle').textContent = 'Highlights (' + n + ')';
  const head = panel.querySelector('.hl-panel-head strong');
  if (head) head.textContent = 'Highlights (' + n + ')';
}

// Click a highlight inside the article -> a small Delete menu at that spot.
const menu = document.getElementById('hl-menu');
let menuHlId = null;
root.addEventListener('click', (e) => {
  const mark = e.target.closest('mark[data-hl-id]');
  if (!mark) return;
  e.stopPropagation();
  menuHlId = mark.dataset.hlId;
  // At the click itself, not under the mark: a highlight spanning a long
  // paragraph has its bottom edge well off screen when you click near its top.
  // Show first so the menu has a size to clamp with; keep it inside the
  // viewport, flipping above the click when there's no room below.
  menu.hidden = false;
  const mw = menu.offsetWidth, mh = menu.offsetHeight, pad = 8;
  let x = e.clientX, y = e.clientY + 12;
  if (y + mh > window.innerHeight - pad) y = e.clientY - mh - 12;
  x = Math.max(pad, Math.min(x, window.innerWidth - mw - pad));
  y = Math.max(pad, y);
  menu.style.top = (window.scrollY + y) + 'px';
  menu.style.left = (window.scrollX + x) + 'px';
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#hl-menu') && !e.target.closest('mark[data-hl-id]')) menu.hidden = true;
});
document.getElementById('hl-menu-del').addEventListener('click', () => { menu.hidden = true; if (menuHlId) deleteHighlight(menuHlId); });

// archive/favorite/delete-highlight buttons (top of the article and the end bar)
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'del-hl') {
    const r = await fetch('/api/highlights/' + btn.dataset.id, { method: 'DELETE' });
    if (!r.ok) { alert('Could not delete that highlight.'); return; }
    location.reload();
    return;
  }
  const val = btn.dataset.val === 'true';
  btn.disabled = true;
  const res = await fetch('/api/articles/' + ARTICLE, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    // See the list page: the button's verb is not the API's field name.
    body: JSON.stringify({ [act === 'archive' ? 'archived' : act]: val }),
  });
  // Silently reloading on failure looked exactly like "the button does nothing".
  if (!res.ok) {
    btn.disabled = false;
    alert(res.status === 401
      ? 'Your session has expired — log in again, then retry.'
      : 'That did not save (the server said ' + res.status + ').');
    return;
  }
  // Archiving means "done with this", so hand back the list you came from
  // rather than re-rendering an article you just filed away. Unarchiving stays
  // put — you only just rescued it, and you probably want to read it.
  if (act === 'archive' && val) { location.href = BACK_TO; return; }
  location.reload();
});

// select text in the article -> floating Highlight button
const tip = document.getElementById('hl-tip');
const bar = document.getElementById('float-bar');
// On a touch screen the browser draws its own callout (Copy / Look Up / ...)
// right above a long-press selection — exactly where the tip would go. Two
// stacked menus there was a mess on iPad Firefox, so on touch the Highlight
// button lives in the floating bar at the bottom instead.
const COARSE = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
document.addEventListener('selectionchange', () => {
  const sel = document.getSelection();
  const has = !!(sel && !sel.isCollapsed && root.contains(sel.anchorNode));
  bar.classList.toggle('has-sel', has);
  updateBar();
  if (!has || COARSE) { tip.hidden = true; return; }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  tip.style.top = (window.scrollY + rect.top - 42) + 'px';
  tip.style.left = (window.scrollX + rect.left) + 'px';
  tip.hidden = false;
});
/** POST one highlight and re-render. Shared by the tip button and double-tap. */
async function saveHighlight(text) {
  text = String(text || '').trim();
  if (!text) return;
  const res = await fetch('/api/articles/' + ARTICLE + '/highlights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 20000), clientId: 'web-' + Date.now() + '-' + Math.random().toString(36).slice(2) }),
  });
  if (!res.ok) { alert('Could not save that highlight (' + res.status + ').'); return; }
  tip.hidden = true;
  const sel = document.getSelection();
  if (sel) sel.removeAllRanges(); // also dismisses the browser's own callout
  bar.classList.remove('has-sel'); updateBar();
  let h = null;
  try { h = await res.json(); } catch (e) {}
  if (h && h.id) addHighlightToDom(h); else location.reload();
}

// The tip has to answer touch as well as mouse. 'mousedown' alone left the
// button dead on a tablet in the common case, because the tap collapses the
// selection before any synthesised mouse event arrives.
for (const id of ['hl-save', 'hl-save-float']) {
  for (const evt of ['mousedown', 'touchstart']) {
    document.getElementById(id).addEventListener(evt, async (e) => {
      e.preventDefault(); // don't collapse the selection before we read it
      await saveHighlight(String(document.getSelection()));
    }, { passive: false });
  }
}

// ---- floating bar: show on scroll-up (or with a selection), hide on scroll-down
let lastScrollY = window.scrollY, scrolledUp = false;
function updateBar() {
  const fs = document.body.classList.contains('fullscreen');
  const show = bar.classList.contains('has-sel') || (scrolledUp && (fs || window.scrollY > 300));
  bar.classList.toggle('show', show);
}
window.addEventListener('scroll', () => {
  const y = window.scrollY, dy = y - lastScrollY;
  if (Math.abs(dy) > 6) { scrolledUp = dy < 0; lastScrollY = y; }
  updateBar();
}, { passive: true });

// ---- full screen: hide everything but the text. Uses the real Fullscreen API
// where there is one (desktop, iPadOS Safari); elsewhere the CSS-only version
// still drops the chrome. Escape / the bar's button / 'f' toggle it back.
function setFullscreen(on) {
  document.body.classList.toggle('fullscreen', on);
  const de = document.documentElement;
  try {
    if (on && !document.fullscreenElement && de.requestFullscreen) de.requestFullscreen().catch(() => {});
    else if (on && !document.webkitFullscreenElement && de.webkitRequestFullscreen) de.webkitRequestFullscreen();
    else if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (!on && document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
  } catch (e) {}
  updateBar();
}
const toggleFullscreen = () => setFullscreen(!document.body.classList.contains('fullscreen'));
document.getElementById('fs-btn').addEventListener('click', toggleFullscreen);
document.getElementById('fs-float').addEventListener('click', toggleFullscreen);
for (const evt of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(evt, () => {
    // Leaving via Escape or the system gesture: drop the class too.
    if (!document.fullscreenElement && !document.webkitFullscreenElement) { document.body.classList.remove('fullscreen'); updateBar(); }
  });
}
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (e.key === 'f') toggleFullscreen();
  else if (e.key === 'Escape' && document.body.classList.contains('fullscreen')) setFullscreen(false);
});

// ---- double-tap / double-click a paragraph to highlight all of it ----------
// Select-then-aim-at-a-small-button is fiddly on a tablet, so make one gesture
// do the whole thing: the block you tapped (paragraph, list item, quote,
// heading) becomes one highlight. The browser's own double-tap word selection
// is ignored — and cleared, so its callout menu goes away too.
const BLOCK = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, dd, dt, figcaption, td, th';

/** The block element under (x, y) inside the article, or null. */
function blockAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || !root.contains(el)) return null;
  const block = el.closest(BLOCK);
  return block && root.contains(block) ? block : null;
}

// dblclick and the hand-rolled touch double-tap both fire on some browsers
// (iPad Firefox among them), which saved the same text twice. One gesture,
// one highlight: anything within a second of the last one is the same tap.
let lastHighlightAt = 0;
async function highlightAt(x, y) {
  const now = Date.now();
  if (now - lastHighlightAt < 1000) return;
  const block = blockAt(x, y);
  if (!block) return;
  lastHighlightAt = now;
  const sel = document.getSelection();
  if (sel) sel.removeAllRanges();
  await saveHighlight(block.textContent);
}

// Don't fire on an existing highlight — a double-tap there means "open the
// delete menu", which the click handler above already owns.
const onExistingMark = (x, y) => {
  const el = document.elementFromPoint(x, y);
  return !!(el && el.closest && el.closest('mark[data-hl-id]'));
};

root.addEventListener('dblclick', (e) => {
  if (onExistingMark(e.clientX, e.clientY)) return;
  highlightAt(e.clientX, e.clientY);
});

// Touch double-tap, detected by hand: iOS only fires dblclick sometimes, and
// never when it decides the gesture was a zoom. The listener is passive —
// zoom is already off via touch-action on the content, and a non-passive
// touch handler on the whole article made every scroll wait for JS (that was
// the "sluggish on iPad" feel). The window is generous because Firefox on
// iPad spaces the two taps out more than Safari does.
let lastTapAt = 0, lastTapX = 0, lastTapY = 0;
root.addEventListener('touchend', (e) => {
  if (e.touches.length || !e.changedTouches.length) return;
  const t = e.changedTouches[0];
  const now = Date.now();
  const near = Math.abs(t.clientX - lastTapX) < 30 && Math.abs(t.clientY - lastTapY) < 30;
  if (now - lastTapAt < 500 && near) {
    lastTapAt = 0;
    if (onExistingMark(t.clientX, t.clientY)) return;
    highlightAt(t.clientX, t.clientY);
    return;
  }
  lastTapAt = now; lastTapX = t.clientX; lastTapY = t.clientY;
}, { passive: true });

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

// ---- "Aa": text size, spacing, column width, typeface ----------------------
// Every control writes through on 'input', so the article reflows under your
// finger and you can judge the result against the actual text rather than a
// preview. window.__type is defined by the head script.
const typeDlg = document.getElementById('type-dialog');
const typeCtl = {
  family: document.getElementById('type-family'),
  size: document.getElementById('type-size'),
  lead: document.getElementById('type-lead'),
  width: document.getElementById('type-width'),
};
const typeOut = {
  size: document.getElementById('type-size-out'),
  lead: document.getElementById('type-lead-out'),
  width: document.getElementById('type-width-out'),
};
function typeFill(s) {
  typeCtl.family.value = s.family;
  typeCtl.size.value = s.size;
  typeCtl.lead.value = s.lead;
  typeCtl.width.value = s.width;
  typeOut.size.textContent = s.size + 'px';
  typeOut.lead.textContent = (s.lead / 100).toFixed(2);
  typeOut.width.textContent = s.width + 'rem';
}
const typeCurrent = () => ({
  family: typeCtl.family.value,
  size: Number(typeCtl.size.value),
  lead: Number(typeCtl.lead.value),
  width: Number(typeCtl.width.value),
});
const closeType = () => { typeDlg.hidden = true; };
document.getElementById('type-btn').addEventListener('click', () => {
  typeFill(window.__type.read());
  typeDlg.hidden = false;
});
for (const el of [typeCtl.family, typeCtl.size, typeCtl.lead, typeCtl.width]) {
  el.addEventListener('input', () => { const s = typeCurrent(); typeFill(s); window.__type.save(s); });
}
document.getElementById('type-reset').addEventListener('click', () => {
  const d = window.__type.DEFAULTS;
  typeFill(d);
  window.__type.save(d);
});
document.getElementById('type-close').addEventListener('click', closeType);
typeDlg.addEventListener('click', (e) => { if (e.target === typeDlg) closeType(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !typeDlg.hidden) closeType(); });

// ---- "Share": mint (or reuse) a public link to the parsed article -----------
// POST is idempotent server-side, so reopening the dialog shows the same link
// rather than quietly invalidating one you already sent.
const shareDlg = document.getElementById('share-dialog');
const shareBtn = document.getElementById('share-btn');
const shareUrl = document.getElementById('share-url');
const shareMsg = document.getElementById('share-msg');
const shareRevoke = document.getElementById('share-revoke');
const closeShare = () => { shareDlg.hidden = true; };

function setShared(on) {
  shareBtn.textContent = on ? 'Shared ✓' : 'Share';
  shareBtn.classList.toggle('on', on);
  shareRevoke.hidden = !on;
}

shareBtn.addEventListener('click', async () => {
  shareMsg.textContent = '';
  shareUrl.value = '';
  // Say what is happening. The link is minted server-side, and an empty box
  // with no explanation looked exactly like a bug when that took a moment.
  shareUrl.placeholder = 'Creating link…';
  shareBtn.disabled = true;
  shareDlg.hidden = false;
  try {
    const res = await fetch('/api/articles/' + ARTICLE + '/share', { method: 'POST' });
    if (!res.ok) throw new Error('server replied ' + res.status);
    const d = await res.json();
    shareUrl.value = d.url;
    setShared(true);
    shareUrl.focus();
    shareUrl.select();
  } catch (err) {
    shareMsg.textContent = "Couldn't create a link: " + err.message;
  } finally {
    shareBtn.disabled = false;
    shareUrl.placeholder = '';
  }
});

document.getElementById('share-copy').addEventListener('click', async () => {
  if (!shareUrl.value) return;
  shareUrl.select();
  try {
    // navigator.clipboard needs a secure context — absent when the server is
    // reached over plain http on a LAN, so keep the old command as a fallback.
    if (navigator.clipboard) await navigator.clipboard.writeText(shareUrl.value);
    else document.execCommand('copy');
    shareMsg.textContent = 'Copied.';
  } catch (err) {
    shareMsg.textContent = 'Copy that link from the box above.';
  }
});

shareRevoke.addEventListener('click', async () => {
  shareMsg.textContent = '';
  try {
    const res = await fetch('/api/articles/' + ARTICLE + '/share', { method: 'DELETE' });
    if (!res.ok) throw new Error('server replied ' + res.status);
    shareUrl.value = '';
    setShared(false);
    shareMsg.textContent = 'Sharing stopped — that link no longer works.';
  } catch (err) {
    shareMsg.textContent = "Couldn't stop sharing: " + err.message;
  }
});

document.getElementById('share-close').addEventListener('click', closeShare);
shareDlg.addEventListener('click', (e) => { if (e.target === shareDlg) closeShare(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !shareDlg.hidden) closeShare(); });
setShared(${article.shareId ? 'true' : 'false'});

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
for (const id of ['skip-save', 'skip-save-float']) {
  for (const evt of ['mousedown', 'touchstart']) {
    document.getElementById(id).addEventListener(evt, (e) => {
      e.preventDefault(); // don't collapse the selection before we read it
      openSkipDialog(String(document.getSelection()));
    }, { passive: false });
  }
}
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
  // bodyClass drives the reader-only column width; headScript replays the saved
  // type settings before first paint so the article doesn't reflow on load.
  return { body, script, headerExtra, bodyClass: 'reading', headScript: TYPE_SCRIPT };
}

function highlightsPage(ctx, user, url, prefs = {}) {
  // Grouped by article: which articles have highlights and how many. The
  // highlights themselves live on each article's reader page.
  const HL_SORTS = { recent: 'Recently highlighted', oldest: 'Oldest highlighted', most: 'Most highlights', title: 'Title A–Z', random: 'Random' };
  const get = (k) => (url && url.searchParams.get(k)) || '';
  const q = get('q').trim();
  const domain = get('domain').trim();
  const src = cleanSrc(get('src'));
  // Only the random seed sticks here (the nav links name each sort outright):
  // the same shuffled pile on every visit until ↻ Shuffle or another sort.
  const { sort, seed, setCookie } = stickySort(get, prefs.hlSort, HL_SORTS, 'recent');
  const pageNum = Math.max(1, parseInt(get('page'), 10) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;

  const domainRows = ctx.store.highlightedDomains(user.id);
  const dom = domainFilter(domain, domainRows.map((r) => r.domain));
  const sources = src ? SOURCES[src].sources : null;
  const total = ctx.store.highlightedArticlesCount(user.id, { q, ...dom, sources });
  const arts = ctx.store.highlightedArticles(user.id, { q, ...dom, sources, sort, seed, limit: PAGE_SIZE, offset });
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const buildQs = (o) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ q, domain, src, sort, seed, ...o })) if (v && !(k === 'sort' && v === 'recent')) p.set(k, String(v));
    const s = p.toString();
    return s ? `/highlights?${s}` : '/highlights';
  };
  const sortOpts = Object.entries(HL_SORTS)
    .map(([k, label]) => `<option value="${k}" ${k === sort ? 'selected' : ''}>${label}</option>`).join('');

  const backTo = buildQs({}); // reader's Back returns to this filtered page
  const items = arts.map((a) => {
    const meta = [
      a.siteName || a.domain || null, // same fallback the inbox uses
      a.wordCount > 0 ? `~${Math.max(1, Math.round(a.wordCount / 225))} min` : null,
      `highlighted ${fmtDate(a.lastHighlightAt)}`,
    ].filter(Boolean).map(escapeHtml).join(' · ');
    return `<li>
      <div class="main"><a class="title" href="${escapeHtml(readHref(a.id, backTo))}">${escapeHtml(a.title)}</a>
      <div class="meta">${meta}</div></div>
      <div class="actions"><span class="hl-count">${a.n} highlight${a.n > 1 ? 's' : ''}</span></div>
    </li>`;
  }).join('\n');

  const pager = pageCount > 1 ? `<div class="pager">
  ${pageNum > 1 ? `<a class="act" href="${buildQs({ page: pageNum - 1 })}">← Prev</a>` : '<span class="act disabled">← Prev</span>'}
  <span class="meta">Page ${pageNum} of ${pageCount}</span>
  ${pageNum < pageCount ? `<a class="act" href="${buildQs({ page: pageNum + 1 })}">Next →</a>` : '<span class="act disabled">Next →</span>'}
</div>` : '';

  const srcOpts = ['<option value="">Any source</option>']
    .concat(Object.entries(SOURCES).map(([k, v]) =>
      `<option value="${k}" ${k === src ? 'selected' : ''}>${escapeHtml(v.label)}</option>`)).join('');
  const searchForm = `<form class="search" method="get" action="/highlights">
  <input type="search" name="q" value="${escapeHtml(q)}" placeholder="Search highlight text, titles…">
  ${domainPicker(domainRows, domain)}
  <select name="src" title="Where the highlighted article came from">${srcOpts}</select>
  <select name="sort">${sortOpts}</select>
  <button class="act" type="submit">Apply</button>
  ${sort === 'random' ? `<a class="act" href="${buildQs({ seed: newSeed(), page: '' })}" title="Reshuffle">↻ Shuffle</a>` : ''}
  ${q || domain || src || sort !== 'recent' ? '<a class="back" href="/highlights">Clear</a>' : ''}
</form>`;

  const body = `<h1>Highlights</h1>
${searchForm}
${total ? `<div class="meta">${total.toLocaleString('en-US')} article${total === 1 ? '' : 's'} with highlights — open one to read them in place.</div>
<ul class="articles">${items}</ul>${pager}`
    : `<div class="empty">${q || domain || src ? 'No highlighted articles match those filters.' : 'No highlights yet — long-press a paragraph in the Android app, or select text in the reader.'}</div>`}
<p class="meta"><a href="/api/highlights/export.md">Export all as Markdown</a></p>`;
  return { body, script: '', setCookie };
}

function settingsPage(ctx, user, url, req) {
  const msg = url.searchParams.get('msg');
  const rules = ctx.store.listSkipRules(user.id);
  const origin = ctx.originOf(req);
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

  // ---- shared article (PUBLIC — holding the link is the whole authorization).
  // Sits above the session gate on purpose; the slug is looked up across all
  // users, and only an article whose owner has published it can be found this
  // way. Highlights and everything else personal are never rendered here.
  if (req.method === 'GET' && parts[0] === 'p' && parts.length === 2) {
    const article = parts[1] && ctx.store.articleByShareId(parts[1]);
    if (!article) {
      return send(res, 404, page({
        title: 'Not shared',
        body: '<div class="empty">This link is not valid — it may have been revoked by whoever shared it.</div>',
        user: null, nonce, brandLink: false, noindex: true,
      }), { nonce });
    }
    const made = publicReaderPage(article);
    return send(res, 200, page({
      title: article.title, body: made.body,
      // No session context at all: no nav, no username, and the logo is not a
      // link into someone else's library.
      user: null, nonce, brandLink: false, noindex: true,
    }), { nonce, headers: { 'X-Robots-Tag': 'noindex, nofollow' } });
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

  // Sort preferences (see stickySort) ride in cookies; a page that changes
  // one hands back the Set-Cookie to send with it.
  const cookies = parseCookies(req);
  const prefs = { sort: cookies.rl_sort || '', hlSort: cookies.rl_hlsort || '' };
  const extraHeaders = {};

  let made = null, title = 'ReadLater', active = 'inbox';
  if (route === 'GET /') {
    const view = url.searchParams.get('view') || 'inbox';
    made = listPage(ctx, user, view, url, prefs);
    if (made.setCookie) extraHeaders['Set-Cookie'] = prefCookie('rl_sort', made.setCookie);
    if (url.searchParams.get('src') === 'phone' && !url.searchParams.get('q')) {
      active = 'phone'; title = 'From phone';
    } else {
      active = ['favorites', 'archive'].includes(view) ? view : 'inbox';
      title = active[0].toUpperCase() + active.slice(1);
    }
  } else if (route.startsWith('GET /read/') && parts.length === 2) {
    const article = ctx.store.getArticle(parts[1], user.id);
    if (article) { made = readerPage(ctx, user, article, url); title = article.title; active = ''; }
  } else if (route === 'GET /highlights') {
    made = highlightsPage(ctx, user, url, prefs);
    if (made.setCookie) extraHeaders['Set-Cookie'] = prefCookie('rl_hlsort', made.setCookie);
    // The nav has a link for each: /highlights and the shuffled view of it.
    const random = url.searchParams.get('sort') === 'random';
    title = random ? 'Random highlights' : 'Highlights';
    active = random ? 'highlights-random' : 'highlights';
  } else if (route === 'GET /settings') {
    made = settingsPage(ctx, user, url, req); title = 'Settings'; active = 'settings';
  } else if (route === 'GET /favicon.ico') {
    res.writeHead(302, { Location: FAVICON }); return res.end();
  }

  if (!made) {
    return send(res, 404, page({ title: 'Not found', body: '<div class="empty">Page not found. <a href="/">Back to your articles</a></div>', user, nonce }), { nonce });
  }
  return send(res, 200, page({
    title, body: made.body, user, active, nonce, script: made.script, headerExtra: made.headerExtra || '',
    bodyClass: made.bodyClass || '', headScript: made.headScript || '',
    // Only the article list: /highlights has its own q meaning something else,
    // and echoing that into an article-search box would be a lie.
    searchQ: route === 'GET /' ? (url.searchParams.get('q') || '') : '',
  }), { nonce, headers: extraHeaders });
}

module.exports = { handle };

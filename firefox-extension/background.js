/** ReadLater background script: orchestrates extract → POST to your server. */
'use strict';

async function getSettings() {
  const s = await browser.storage.local.get({ serverUrl: '', token: '', notifyMode: 'summary' });
  return {
    serverUrl: (s.serverUrl || '').trim().replace(/\/+$/, ''),
    token: (s.token || '').trim(),
    // 'summary' one toast per burst · 'errors' only failures · 'none' badge only
    notifyMode: ['summary', 'errors', 'none'].includes(s.notifyMode) ? s.notifyMode : 'summary',
  };
}

// ------------------------------------------------------------- notifications
//
// Saving ten tabs used to raise ten OS toasts, because notifications.create()
// without an id mints a new one every call and Windows queues them all. Now
// each kind of notification owns a fixed id — creating it again *replaces* the
// one on screen — and bursts are coalesced into a single summary that is only
// shown once the saves stop arriving.

const NOTIF_SAVED = 'earmark-saved';
const NOTIF_HIGHLIGHT = 'earmark-highlight';
const NOTIF_ERROR = 'earmark-error';
const NOTIF_SETUP = 'earmark-setup';

const QUIET_MS = 2500;    // flush once nothing new has arrived for this long
const MAX_WAIT_MS = 12000; // ...but never sit on a summary longer than this

// Toolbar badge timings. The outcome badge ('✓' / '!') has to outlast a glance
// away from the screen, so it holds well past the save itself.
const BADGE_HOLD_MS = 5000;   // how long '✓' / '!' stay on the icon
const BADGE_STUCK_MS = 75000; // safety net: never pin '…' to the icon forever

// A hung server is worse than a dead one: fetch() with no signal never settles,
// so the catch blocks below never run and the save fails *silently*. (A server
// that is genuinely down rejects at once and does report an error.) Generous,
// because /api/save-url has the server fetch and parse the page itself — its
// own outbound fetch already allows 25s. BADGE_STUCK_MS outlasts this so the
// timeout, not the badge net, is what normally ends a stuck save.
const SAVE_TIMEOUT_MS = 60000;

// notificationId -> URL to open when the user clicks the notification.
const notifUrls = new Map();

function show(id, title, message, url) {
  if (url) notifUrls.set(id, url); else notifUrls.delete(id);
  // Same id => replaces rather than stacks.
  browser.notifications.create(id, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('icons/icon.svg'),
    title,
    message,
  }).catch(() => {});
}

/** Debounced batch: collects items, then hands them all to `flush` at once. */
function batcher(flush) {
  let items = [];
  let timer = null;
  let deadline = 0;

  const fire = () => {
    timer = null;
    deadline = 0;
    const batch = items;
    items = [];
    if (batch.length) flush(batch);
  };

  return (item) => {
    items.push(item);
    const now = Date.now();
    if (!deadline) deadline = now + MAX_WAIT_MS;
    if (timer) clearTimeout(timer);
    // Whichever comes first: a quiet gap, or the ceiling on total delay.
    timer = setTimeout(fire, Math.max(0, Math.min(QUIET_MS, deadline - now)));
  };
}

const queueSaved = batcher(async (saves) => {
  const { serverUrl, notifyMode } = await getSettings();
  if (notifyMode !== 'summary') return;
  if (saves.length === 1) {
    const s = saves[0];
    show(NOTIF_SAVED, 'Saved to Earmark', s.title + (s.url ? ' — click to open' : ''), s.url);
    return;
  }
  const titles = saves.slice(0, 3).map((s) => `• ${s.title}`).join('\n');
  const more = saves.length > 3 ? `\n…and ${saves.length - 3} more` : '';
  show(NOTIF_SAVED, `Saved ${saves.length} articles to Earmark`,
    `${titles}${more}`, serverUrl || null);
});

const queueError = batcher(async (errors) => {
  const { notifyMode } = await getSettings();
  if (notifyMode === 'none') return;
  if (errors.length === 1) {
    show(NOTIF_ERROR, errors[0].title, errors[0].message);
    return;
  }
  // Distinct reasons, so ten copies of one network error read as one problem.
  const reasons = [...new Set(errors.map((e) => e.message))].slice(0, 3);
  show(NOTIF_ERROR, `Earmark: ${errors.length} saves failed`, reasons.join('\n'));
});

// Highlights get their own channel rather than sharing the page-save summary:
// "Saved 3 articles" would be a lie, and a quote saved right after a page save
// would silently replace that notification.
const queueHighlight = batcher(async (hls) => {
  const { serverUrl, notifyMode } = await getSettings();
  if (notifyMode !== 'summary') return;
  if (hls.length === 1) {
    const h = hls[0];
    // The quote itself is the useful confirmation — you can see at a glance
    // whether you grabbed the right words.
    const quote = h.text.length > 120 ? `${h.text.slice(0, 120)}…` : h.text;
    show(NOTIF_HIGHLIGHT, `Highlight saved — ${h.title}`, `“${quote}”`, h.url);
    return;
  }
  show(NOTIF_HIGHLIGHT, `Saved ${hls.length} highlights to Earmark`,
    [...new Set(hls.map((h) => `• ${h.title}`))].slice(0, 3).join('\n'),
    `${serverUrl}/highlights`);
});

/** A save that failed. Always surfaced (unless notifications are off). */
const notifyError = (title, message) => queueError({ title, message: String(message) });
/** A save that worked. Coalesced; suppressed entirely in 'errors'/'none' mode. */
const notifySaved = (title, url) => queueSaved({ title, url });
/** A highlight that stuck. Same coalescing rules as a page save. */
const notifyHighlight = (title, text, url) => queueHighlight({ title, text, url });

// Clicking a notification opens the article (or the article list, for a batch).
browser.notifications.onClicked.addListener((id) => {
  const url = notifUrls.get(id);
  if (url) {
    browser.tabs.create({ url });
    notifUrls.delete(id);
  }
  browser.notifications.clear(id);
});

/**
 * A per-tab badge writer, shared by every save path.
 *
 * The badge is the primary "did that work?" signal, so it has to survive long
 * enough to be seen. Each call cancels the previous auto-clear: '…' used to
 * schedule its own wipe 2.5s after the save STARTED, which then fired on top
 * of the '✓' that replaced it — so a save taking ~2s flashed the checkmark for
 * a few hundred ms, and one taking 2.5s never showed it at all. Only terminal
 * states auto-clear; '…' holds until the outcome replaces it.
 *
 * [expireTo] is what the hold timer leaves behind. '…' expires to '!' rather
 * than to a blank icon: a save that silently stops showing progress reads as
 * "nothing happened", which is exactly how a hung server used to look.
 */
const BADGE_ERR = '#b3261e';

function badgeFor(tabId) {
  let badgeTimer = null;
  const paint = (text, color) => {
    const a = browser.browserAction || browser.action;
    if (!a) return;
    try { a.setBadgeBackgroundColor({ color: color || '#3d6b52', tabId }); } catch (e) {}
    try { a.setBadgeText({ text, tabId }); } catch (e) {}
  };
  return (text, color, holdMs, expireTo) => {
    if (badgeTimer !== null) { clearTimeout(badgeTimer); badgeTimer = null; }
    paint(text, color);
    if (!text || !holdMs) return;
    badgeTimer = setTimeout(() => {
      badgeTimer = null;
      if (!expireTo) return paint('', null);
      // Expired into an outcome — let that outcome have its own hold, then go.
      paint(expireTo, BADGE_ERR);
      badgeTimer = setTimeout(() => { badgeTimer = null; paint('', null); }, BADGE_HOLD_MS);
    }, holdMs);
  };
}

/**
 * POST JSON and return the parsed reply, or throw with a message fit to show.
 *
 * Every save goes through here so none of them can hang forever. The timeout
 * case is called out by name: "no reply" and "refused the save" send you to
 * very different places, and only the first one means the article is still
 * sitting unsaved in a tab you can retry from.
 */
async function postJson(path, payload) {
  const { serverUrl, token } = await getSettings();
  let res;
  try {
    res = await fetch(`${serverUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
    });
  } catch (e) {
    if (e && e.name === 'TimeoutError') {
      throw new Error(`no reply from the server in ${Math.round(SAVE_TIMEOUT_MS / 1000)}s — it may be overloaded. Nothing was saved; try again.`);
    }
    throw new Error(`could not reach the server (${(e && e.message) || e})`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`server replied ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json().catch(() => ({}));
}

/** Extract the article from the tab's live DOM and POST it to the server. */
async function savePage(tabId) {
  const { serverUrl, token } = await getSettings();
  if (!serverUrl || !token) {
    show(NOTIF_SETUP, 'Earmark: not configured', 'Set your server URL and token in the extension options first.');
    browser.runtime.openOptionsPage();
    return { ok: false, error: 'not configured' };
  }

  const setBadge = badgeFor(tabId);
  // Immediate feedback so a slow/cold server doesn't feel like nothing happened.
  // Every path below replaces this; the long timer is only a safety net so an
  // unforeseen throw can't leave '…' pinned to the icon forever.
  setBadge('…', null, BADGE_STUCK_MS, '!');

  let article;
  try {
    // Readability first (same sandbox); extractor.js uses it when present.
    await browser.tabs.executeScript(tabId, {
      file: 'Readability.js',
      runAt: 'document_idle',
    });
    const results = await browser.tabs.executeScript(tabId, {
      file: 'extractor.js',
      runAt: 'document_idle',
    });
    article = results && results[0];
  } catch (e) {
    setBadge('!', BADGE_ERR, BADGE_HOLD_MS);
    notifyError('Earmark: cannot read this page', e.message || e);
    return { ok: false, error: `This page cannot be captured (${e.message || e})` };
  }
  if (!article || !article.html) {
    setBadge('!', BADGE_ERR, BADGE_HOLD_MS);
    notifyError('Earmark: nothing to save', 'Could not find article content on this page.');
    return { ok: false, error: 'no article content found' };
  }

  try {
    // Tag how this was saved (live-DOM capture of the open tab) so parse
    // failures can be diagnosed by save method on the server.
    const data = await postJson('/api/articles', { ...article, source: 'browser-page' });
    setBadge('✓', null, BADGE_HOLD_MS);
    const readUrl = data && data.id ? `${serverUrl}/read/${data.id}` : null;
    notifySaved(article.title, readUrl);
    return { ok: true, title: article.title };
  } catch (e) {
    setBadge('!', BADGE_ERR, BADGE_HOLD_MS);
    notifyError('Earmark: save failed', e.message || e);
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Save the tab's current text selection as a highlight on whatever page it is.
 *
 * The page itself is never captured: the server attaches the quote to the
 * article if it already has one for this URL, and otherwise keeps a stub that
 * holds nothing but the quotes. So this works on any page you happen to be
 * reading, not just ones already in the library.
 */
async function saveHighlight(tabId, { withNote = false } = {}) {
  const { serverUrl, token } = await getSettings();
  if (!serverUrl || !token) {
    show(NOTIF_SETUP, 'Earmark: not configured', 'Set your server URL and token in the extension options first.');
    browser.runtime.openOptionsPage();
    return { ok: false, error: 'not configured' };
  }

  const setBadge = badgeFor(tabId);
  setBadge('…', null, BADGE_STUCK_MS, '!');

  let sel;
  try {
    const results = await browser.tabs.executeScript(tabId, {
      file: 'selection.js',
      runAt: 'document_idle',
    });
    sel = results && results[0];
  } catch (e) {
    setBadge('!', BADGE_ERR, BADGE_HOLD_MS);
    notifyError('Earmark: cannot read this page', e.message || e);
    return { ok: false, error: `This page cannot be read (${e.message || e})` };
  }
  if (!sel || !sel.text) {
    setBadge('!', BADGE_ERR, BADGE_HOLD_MS);
    notifyError('Earmark: nothing selected', 'Select some text on the page first, then save it as a highlight.');
    return { ok: false, error: 'no text selected' };
  }

  let note = null;
  if (withNote) {
    // Asked for after the selection is in hand — a modal can clear it.
    try {
      const results = await browser.tabs.executeScript(tabId, { file: 'note-prompt.js' });
      const answer = (results && results[0]) || {};
      if (answer.cancelled) { setBadge('', null, 0); return { ok: false, error: 'cancelled' }; }
      note = answer.note || null;
    } catch (e) {
      // Prompting failed (a page that blocked dialogs, say) — the quote is
      // still worth keeping, so fall through and save it without a note.
    }
  }

  try {
    const data = await postJson('/api/highlights', {
      url: sel.url,
      title: sel.title,
      siteName: sel.siteName,
      text: sel.text,
      note,
      source: 'browser-highlight',
    });
    setBadge('✓', null, BADGE_HOLD_MS);
    const readUrl = data && data.articleId ? `${serverUrl}/read/${data.articleId}` : `${serverUrl}/highlights`;
    notifyHighlight(sel.title, sel.text, readUrl);
    return { ok: true, title: sel.title };
  } catch (e) {
    setBadge('!', BADGE_ERR, BADGE_HOLD_MS);
    notifyError('Earmark: highlight failed', e.message || e);
    return { ok: false, error: String(e.message || e) };
  }
}

/** Save a URL (e.g. a right-clicked link) — the server fetches + extracts it. */
async function saveLink(linkUrl) {
  const { serverUrl, token } = await getSettings();
  if (!serverUrl || !token) {
    show(NOTIF_SETUP, 'Earmark: not configured', 'Set your server URL and token in the extension options first.');
    browser.runtime.openOptionsPage();
    return;
  }
  try {
    const data = await postJson('/api/save-url', { url: linkUrl, source: 'browser-link' });
    const readUrl = data && data.id ? `${serverUrl}/read/${data.id}` : null;
    notifySaved(data.title || linkUrl, readUrl);
  } catch (e) {
    notifyError('Earmark: save link failed', e.message || e);
  }
}

// Context menus: "Save link" on a link saves the link's target (server fetches
// it); "Save page" elsewhere saves the current page as rendered.
browser.contextMenus.create({
  id: 'earmark-save-link',
  title: 'Save link to Earmark',
  contexts: ['link'],
});
browser.contextMenus.create({
  id: 'earmark-save-page',
  title: 'Save page to Earmark',
  contexts: ['page', 'selection'],
});
// On a selection, the quote is usually what you want — not the whole page.
browser.contextMenus.create({
  id: 'earmark-save-highlight',
  title: 'Save highlight to Earmark',
  contexts: ['selection'],
});
browser.contextMenus.create({
  id: 'earmark-save-highlight-note',
  title: 'Save highlight with note…',
  contexts: ['selection'],
});
browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'earmark-save-link' && info.linkUrl) saveLink(info.linkUrl);
  else if (info.menuItemId === 'earmark-save-highlight' && tab) saveHighlight(tab.id);
  else if (info.menuItemId === 'earmark-save-highlight-note' && tab) saveHighlight(tab.id, { withNote: true });
  else if (info.menuItemId === 'earmark-save-page' && tab) savePage(tab.id);
});

// Keyboard shortcut (Alt+D). Avoid Alt+{F,E,V,S,B,T,H}: those are Firefox's
// menubar access keys, which swallow the keypress before the extension sees it
// — and the match ignores Shift, so Alt+Shift+S is taken by History too.
browser.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-page' && command !== 'save-highlight') return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === 'save-highlight') saveHighlight(tab.id);
  else savePage(tab.id);
});

// Toolbar icon: save the current page immediately (no popup / extra click).
browser.browserAction.onClicked.addListener((tab) => {
  if (tab) savePage(tab.id);
});

// Put the real save shortcut in the toolbar tooltip. Read it from the commands
// API rather than the manifest: the user can rebind it in about:addons, and a
// hardcoded string would then be a lie. If they cleared the binding entirely,
// getAll() returns an empty shortcut and we show just the plain title.
async function refreshToolbarTitle() {
  const base = 'Save to Earmark';
  try {
    const cmds = await browser.commands.getAll();
    const save = cmds.find((c) => c.name === 'save-page');
    const shortcut = save && save.shortcut ? save.shortcut : '';
    browser.browserAction.setTitle({ title: shortcut ? `${base} (${shortcut})` : base });
  } catch (e) {
    browser.browserAction.setTitle({ title: base });
  }
}
refreshToolbarTitle();
browser.runtime.onInstalled.addListener(refreshToolbarTitle);
browser.runtime.onStartup.addListener(refreshToolbarTitle);

// Messages from the popup.
browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'save-page') return savePage(msg.tabId);
  if (msg && msg.type === 'save-highlight') return saveHighlight(msg.tabId, { withNote: msg.withNote === true });
  if (msg && msg.type === 'get-settings') return getSettings();
  return undefined;
});

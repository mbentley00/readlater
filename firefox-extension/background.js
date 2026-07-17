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
const NOTIF_ERROR = 'earmark-error';
const NOTIF_SETUP = 'earmark-setup';

const QUIET_MS = 2500;    // flush once nothing new has arrived for this long
const MAX_WAIT_MS = 12000; // ...but never sit on a summary longer than this

// Toolbar badge timings. The outcome badge ('✓' / '!') has to outlast a glance
// away from the screen, so it holds well past the save itself.
const BADGE_HOLD_MS = 5000;   // how long '✓' / '!' stay on the icon
const BADGE_STUCK_MS = 60000; // safety net: never pin '…' to the icon forever

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

/** A save that failed. Always surfaced (unless notifications are off). */
const notifyError = (title, message) => queueError({ title, message: String(message) });
/** A save that worked. Coalesced; suppressed entirely in 'errors'/'none' mode. */
const notifySaved = (title, url) => queueSaved({ title, url });

// Clicking a notification opens the article (or the article list, for a batch).
browser.notifications.onClicked.addListener((id) => {
  const url = notifUrls.get(id);
  if (url) {
    browser.tabs.create({ url });
    notifUrls.delete(id);
  }
  browser.notifications.clear(id);
});

/** Extract the article from the tab's live DOM and POST it to the server. */
async function savePage(tabId) {
  const { serverUrl, token } = await getSettings();
  if (!serverUrl || !token) {
    show(NOTIF_SETUP, 'Earmark: not configured', 'Set your server URL and token in the extension options first.');
    browser.runtime.openOptionsPage();
    return { ok: false, error: 'not configured' };
  }

  // The badge is the primary "did that work?" signal, so it has to survive long
  // enough to be seen. Each call cancels the previous auto-clear: '…' used to
  // schedule its own wipe 2.5s after the save STARTED, which then fired on top
  // of the '✓' that replaced it — so a save taking ~2s flashed the checkmark for
  // a few hundred ms, and one taking 2.5s never showed it at all. Only terminal
  // states auto-clear; '…' holds until the outcome replaces it.
  let badgeTimer = null;
  const setBadge = (text, color, holdMs) => {
    const a = browser.browserAction || browser.action;
    if (!a) return;
    if (badgeTimer !== null) { clearTimeout(badgeTimer); badgeTimer = null; }
    try { a.setBadgeBackgroundColor({ color: color || '#3d6b52', tabId }); } catch (e) {}
    try { a.setBadgeText({ text, tabId }); } catch (e) {}
    if (!text || !holdMs) return;
    badgeTimer = setTimeout(() => { try { a.setBadgeText({ text: '', tabId }); } catch (e) {} }, holdMs);
  };
  // Immediate feedback so a slow/cold server doesn't feel like nothing happened.
  // Every path below replaces this; the long timer is only a safety net so an
  // unforeseen throw can't leave '…' pinned to the icon forever.
  setBadge('…', null, BADGE_STUCK_MS);

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
    setBadge('!', '#b3261e', BADGE_HOLD_MS);
    notifyError('Earmark: cannot read this page', e.message || e);
    return { ok: false, error: `This page cannot be captured (${e.message || e})` };
  }
  if (!article || !article.html) {
    setBadge('!', '#b3261e', BADGE_HOLD_MS);
    notifyError('Earmark: nothing to save', 'Could not find article content on this page.');
    return { ok: false, error: 'no article content found' };
  }

  try {
    const res = await fetch(`${serverUrl}/api/articles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(article),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`server replied ${res.status}: ${body.slice(0, 200)}`);
    }
    setBadge('✓', null, BADGE_HOLD_MS);
    const data = await res.json().catch(() => ({}));
    const readUrl = data && data.id ? `${serverUrl}/read/${data.id}` : null;
    notifySaved(article.title, readUrl);
    return { ok: true, title: article.title };
  } catch (e) {
    setBadge('!', '#b3261e', BADGE_HOLD_MS);
    notifyError('Earmark: save failed', e.message || e);
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
    const res = await fetch(`${serverUrl}/api/save-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ url: linkUrl }),
    });
    if (!res.ok) throw new Error(`server replied ${res.status}`);
    const data = await res.json().catch(() => ({}));
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
browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'earmark-save-link' && info.linkUrl) saveLink(info.linkUrl);
  else if (info.menuItemId === 'earmark-save-page' && tab) savePage(tab.id);
});

// Keyboard shortcut (Alt+D). Avoid Alt+{F,E,V,S,B,T,H}: those are Firefox's
// menubar access keys, which swallow the keypress before the extension sees it
// — and the match ignores Shift, so Alt+Shift+S is taken by History too.
browser.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-page') return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) savePage(tab.id);
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
  if (msg && msg.type === 'get-settings') return getSettings();
  return undefined;
});

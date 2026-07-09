/** ReadLater background script: orchestrates extract → POST to your server. */
'use strict';

async function getSettings() {
  const s = await browser.storage.local.get({ serverUrl: '', token: '' });
  return {
    serverUrl: (s.serverUrl || '').trim().replace(/\/+$/, ''),
    token: (s.token || '').trim(),
  };
}

// notificationId -> URL to open when the user clicks the notification.
const notifUrls = new Map();

function notify(title, message, url) {
  const p = browser.notifications.create({
    type: 'basic',
    iconUrl: browser.runtime.getURL('icons/icon.svg'),
    title,
    message,
  });
  if (url && p && typeof p.then === 'function') {
    p.then((id) => notifUrls.set(id, url)).catch(() => {});
  }
}

// Clicking the "Saved to Earmark" notification opens that article's web reader.
browser.notifications.onClicked.addListener((id) => {
  const url = notifUrls.get(id);
  if (url) {
    browser.tabs.create({ url });
    notifUrls.delete(id);
    browser.notifications.clear(id);
  }
});

/** Extract the article from the tab's live DOM and POST it to the server. */
async function savePage(tabId) {
  const { serverUrl, token } = await getSettings();
  if (!serverUrl || !token) {
    notify('Earmark: not configured', 'Set your server URL and token in the extension options first.');
    browser.runtime.openOptionsPage();
    return { ok: false, error: 'not configured' };
  }

  const setBadge = (text, color) => {
    const a = browser.browserAction || browser.action;
    if (!a) return;
    try { a.setBadgeBackgroundColor({ color: color || '#3d6b52', tabId }); } catch (e) {}
    try { a.setBadgeText({ text, tabId }); } catch (e) {}
    if (!text) return;
    setTimeout(() => { try { a.setBadgeText({ text: '', tabId }); } catch (e) {} }, 2500);
  };
  // Immediate feedback so a slow/cold server doesn't feel like nothing happened.
  setBadge('…');

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
    setBadge('!', '#b3261e');
    notify('Earmark: cannot read this page', String(e.message || e));
    return { ok: false, error: `This page cannot be captured (${e.message || e})` };
  }
  if (!article || !article.html) {
    setBadge('!', '#b3261e');
    notify('Earmark: nothing to save', 'Could not find article content on this page.');
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
    setBadge('✓');
    const data = await res.json().catch(() => ({}));
    const readUrl = data && data.id ? `${serverUrl}/read/${data.id}` : null;
    notify('Saved to Earmark', article.title + (readUrl ? ' — click to open' : ''), readUrl);
    return { ok: true, title: article.title };
  } catch (e) {
    setBadge('!', '#b3261e');
    notify('Earmark: save failed', String(e.message || e));
    return { ok: false, error: String(e.message || e) };
  }
}

/** Save a URL (e.g. a right-clicked link) — the server fetches + extracts it. */
async function saveLink(linkUrl) {
  const { serverUrl, token } = await getSettings();
  if (!serverUrl || !token) {
    notify('Earmark: not configured', 'Set your server URL and token in the extension options first.');
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
    notify('Saved link to Earmark', (data.title || linkUrl) + (readUrl ? ' — click to open' : ''), readUrl);
  } catch (e) {
    notify('Earmark: save link failed', String(e.message || e));
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

// Keyboard shortcut (Alt+T by default).
browser.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-page') return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) savePage(tab.id);
});

// Toolbar icon: save the current page immediately (no popup / extra click).
browser.browserAction.onClicked.addListener((tab) => {
  if (tab) savePage(tab.id);
});

// Messages from the popup.
browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'save-page') return savePage(msg.tabId);
  if (msg && msg.type === 'get-settings') return getSettings();
  return undefined;
});

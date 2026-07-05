'use strict';

const saveBtn = document.getElementById('save');
const statusEl = document.getElementById('status');
const titleEl = document.getElementById('page-title');

let currentTab = null;

async function init() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  titleEl.textContent = tab ? tab.title : '';

  const settings = await browser.runtime.sendMessage({ type: 'get-settings' });
  if (!settings.serverUrl || !settings.token) {
    statusEl.textContent = 'Configure your server in Settings first.';
    statusEl.className = 'err';
  }
}

saveBtn.addEventListener('click', async () => {
  if (!currentTab) return;
  saveBtn.disabled = true;
  statusEl.textContent = 'Saving…';
  statusEl.className = '';
  const result = await browser.runtime.sendMessage({ type: 'save-page', tabId: currentTab.id });
  if (result && result.ok) {
    statusEl.textContent = 'Saved ✔';
    statusEl.className = 'ok';
    setTimeout(() => window.close(), 900);
  } else {
    statusEl.textContent = (result && result.error) || 'Failed to save.';
    statusEl.className = 'err';
    saveBtn.disabled = false;
  }
});

document.getElementById('open-options').addEventListener('click', (e) => {
  e.preventDefault();
  browser.runtime.openOptionsPage();
});

init();

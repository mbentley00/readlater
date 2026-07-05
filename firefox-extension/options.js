'use strict';

const urlEl = document.getElementById('serverUrl');
const tokenEl = document.getElementById('token');
const statusEl = document.getElementById('status');

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
}

async function load() {
  const s = await browser.storage.local.get({ serverUrl: '', token: '' });
  urlEl.value = s.serverUrl;
  tokenEl.value = s.token;
}

document.getElementById('save').addEventListener('click', async () => {
  await browser.storage.local.set({
    serverUrl: urlEl.value.trim().replace(/\/+$/, ''),
    token: tokenEl.value.trim(),
  });
  setStatus('Saved ✔', 'ok');
});

document.getElementById('test').addEventListener('click', async () => {
  const base = urlEl.value.trim().replace(/\/+$/, '');
  const token = tokenEl.value.trim();
  if (!base || !token) return setStatus('Enter a server URL and token first.', 'err');
  setStatus('Testing…');
  try {
    const res = await fetch(`${base}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    setStatus(`Connected ✔ (${body.articles} articles on server)`, 'ok');
  } catch (e) {
    setStatus(`Connection failed: ${e.message}`, 'err');
  }
});

load();

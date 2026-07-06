'use strict';

const DEFAULT_SERVER = 'https://readlater-mbent.fly.dev';

const urlEl = document.getElementById('serverUrl');
const userEl = document.getElementById('username');
const passEl = document.getElementById('password');
const tokenEl = document.getElementById('token');
const statusEl = document.getElementById('status');

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
}

const baseUrl = () => (urlEl.value.trim() || DEFAULT_SERVER).replace(/\/+$/, '');

async function load() {
  const s = await browser.storage.local.get({ serverUrl: '', token: '', username: '' });
  urlEl.value = s.serverUrl || DEFAULT_SERVER;
  userEl.value = s.username;
  tokenEl.value = s.token;
}

document.getElementById('signin').addEventListener('click', async () => {
  const username = userEl.value.trim();
  const password = passEl.value;
  if (!username || !password) return setStatus('Enter username and password.', 'err');
  setStatus('Signing in…');
  try {
    const res = await fetch(`${baseUrl()}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (res.status === 401) throw new Error('wrong username or password');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    await browser.storage.local.set({ serverUrl: baseUrl(), token: body.token, username: body.username });
    tokenEl.value = body.token;
    passEl.value = '';
    setStatus(`Signed in as ${body.username} ✔`, 'ok');
  } catch (e) {
    setStatus(`Sign-in failed: ${e.message}`, 'err');
  }
});

document.getElementById('saveToken').addEventListener('click', async () => {
  await browser.storage.local.set({
    serverUrl: baseUrl(),
    token: tokenEl.value.trim(),
  });
  setStatus('Token saved ✔', 'ok');
});

document.getElementById('test').addEventListener('click', async () => {
  const { token } = await browser.storage.local.get({ token: '' });
  const t = tokenEl.value.trim() || token;
  if (!t) return setStatus('Sign in (or save a token) first.', 'err');
  setStatus('Testing…');
  try {
    const res = await fetch(`${baseUrl()}/api/health`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    setStatus(`Connected ✔ (${body.articles} articles on server)`, 'ok');
  } catch (e) {
    setStatus(`Connection failed: ${e.message}`, 'err');
  }
});

load();

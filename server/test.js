#!/usr/bin/env node
/** End-to-end smoke test: boots the server on a random port and exercises every endpoint,
 * including accounts (signup/login/logout), per-user isolation, legacy-token adoption,
 * and the web UI. */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const PORT = 18090 + Math.floor(Math.random() * 1000);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'readlater-test-'));
const TOKEN = 'test-token-123'; // legacy token — adopted by the first account
const BASE = `http://127.0.0.1:${PORT}`;
const HEADERS = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

async function api(method, p, body, headers = HEADERS) {
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

/** POST an urlencoded form (as a browser would); no redirect following. */
async function form(p, fields, cookie) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  return res;
}

const cookieOf = (res) => (res.headers.get('set-cookie') || '').split(';')[0];

async function main() {
  // pre-seed an old-format db (no users) to test legacy migration
  fs.writeFileSync(path.join(DATA_DIR, 'db.json'), JSON.stringify({
    articles: [{ id: 'orphan01', url: 'https://example.com/orphan', savedAt: 1000, archived: false, favorite: false, readParagraph: 0, title: 'Orphan Article', html: '<p>pre-account content</p>', updatedAt: 1000 }],
    highlights: [],
  }));

  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), READLATER_DATA_DIR: DATA_DIR, READLATER_TOKEN: TOKEN,
      READLATER_INBOUND_SECRET: 'whsec-test', READLATER_INBOUND_DOMAIN: 'in.test',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  // wait for server to come up
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + '/login');
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    // ---- accounts -----------------------------------------------------
    // before any account exists: API token rejected, web redirects to login
    let r = await api('GET', '/api/articles');
    assert.strictEqual(r.status, 401, 'token useless before first signup');
    let res = await fetch(BASE + '/', { redirect: 'manual' });
    assert.strictEqual(res.status, 303, 'web root redirects when logged out');
    assert.strictEqual(res.headers.get('location'), '/login');

    // signup validation
    res = await form('/signup', { username: 'al', password: 'longenough1' });
    assert.strictEqual(res.status, 400, 'short username rejected');
    res = await form('/signup', { username: 'alice', password: 'short' });
    assert.strictEqual(res.status, 400, 'short password rejected');

    // first account adopts the legacy token + orphaned articles
    res = await form('/signup', { username: 'alice', password: 'correct-horse' });
    assert.strictEqual(res.status, 303, 'signup redirects to /');
    const aliceCookie = cookieOf(res);
    assert.ok(aliceCookie.startsWith('rl_sid='), 'session cookie set');

    r = await api('GET', '/api/me');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.username, 'alice');
    assert.strictEqual(r.body.token, TOKEN, 'first account adopts legacy token');

    r = await api('GET', '/api/articles');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.articles.length, 1, 'orphan article adopted');
    assert.strictEqual(r.body.articles[0].title, 'Orphan Article');

    // duplicate username rejected
    res = await form('/signup', { username: 'ALICE', password: 'whatever123' });
    assert.strictEqual(res.status, 400, 'duplicate username rejected (case-insensitive)');

    // login: wrong password fails, right password sets a session
    res = await form('/login', { username: 'alice', password: 'wrong-password' });
    assert.strictEqual(res.status, 401);
    res = await form('/login', { username: 'alice', password: 'correct-horse' });
    assert.strictEqual(res.status, 303);

    // ---- article API (as alice, via bearer token) ----------------------
    r = await api('POST', '/api/articles', {
      url: 'https://example.com/story',
      title: 'A Great Story',
      byline: 'Jane Writer',
      siteName: 'Example News',
      excerpt: 'The first lines of a great story...',
      html: '<h2>Chapter 1</h2><p>It was a dark and stormy night.</p><p>Then it got worse.</p>',
      textContent: 'Chapter 1 It was a dark and stormy night. Then it got worse.',
    });
    assert.strictEqual(r.status, 201);
    const articleId = r.body.id;
    assert.ok(articleId, 'article gets an id');
    assert.strictEqual(r.body.userId, undefined, 'userId not leaked in responses');

    // re-saving same URL updates, not duplicates
    r = await api('POST', '/api/articles', {
      url: 'https://example.com/story',
      title: 'A Great Story (updated)',
      html: '<p>Updated content.</p>',
    });
    assert.strictEqual(r.body.id, articleId, 're-save dedupes by url');

    // validation
    r = await api('POST', '/api/articles', { title: 'no url or html' });
    assert.strictEqual(r.status, 400);

    // list (metadata only, no html)
    r = await api('GET', '/api/articles');
    assert.strictEqual(r.body.articles.length, 2);
    assert.strictEqual(r.body.articles[0].title, 'A Great Story (updated)');
    assert.strictEqual(r.body.articles[0].html, undefined, 'list omits html');

    // fetch full article
    r = await api('GET', `/api/articles/${articleId}`);
    assert.strictEqual(r.body.html, '<p>Updated content.</p>');

    // patch state (as the app does)
    r = await api('PATCH', `/api/articles/${articleId}`, { favorite: true, readParagraph: 3 });
    assert.strictEqual(r.body.favorite, true);
    assert.strictEqual(r.body.readParagraph, 3);

    // archive filtering
    await api('PATCH', `/api/articles/${articleId}`, { archived: true });
    r = await api('GET', '/api/articles');
    assert.strictEqual(r.body.articles.length, 1, 'archived hidden by default');
    r = await api('GET', '/api/articles?includeArchived=1');
    assert.strictEqual(r.body.articles.length, 2);

    // highlights
    r = await api('POST', `/api/articles/${articleId}/highlights`, {
      text: 'It was a dark and stormy night.',
      note: 'classic opener',
      paragraphIndex: 1,
      clientId: 'client-uuid-1',
    });
    assert.strictEqual(r.status, 201);
    const hlId = r.body.id;

    // idempotent re-post by clientId
    r = await api('POST', `/api/articles/${articleId}/highlights`, {
      text: 'It was a dark and stormy night.',
      clientId: 'client-uuid-1',
    });
    assert.strictEqual(r.body.id, hlId, 'clientId dedupes');

    r = await api('GET', `/api/articles/${articleId}/highlights`);
    assert.strictEqual(r.body.highlights.length, 1);

    r = await api('GET', '/api/highlights');
    assert.strictEqual(r.body.highlights[0].articleTitle, 'A Great Story (updated)');

    const md = await fetch(BASE + '/api/highlights/export.md', { headers: HEADERS });
    const mdText = await md.text();
    assert.ok(mdText.includes('> It was a dark and stormy night.'), 'markdown export contains quote');

    // ---- second account is isolated ------------------------------------
    res = await form('/signup', { username: 'bob', password: 'bobs-password' });
    assert.strictEqual(res.status, 303);
    const bobCookie = cookieOf(res);
    r = await api('GET', '/api/me', undefined, { Cookie: bobCookie });
    const bobToken = r.body.token;
    assert.ok(bobToken && bobToken !== TOKEN, 'second account gets its own token');
    const BOB = { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' };

    r = await api('GET', '/api/articles?includeArchived=1', undefined, BOB);
    assert.strictEqual(r.body.articles.length, 0, "bob can't see alice's articles");
    r = await api('GET', `/api/articles/${articleId}`, undefined, BOB);
    assert.strictEqual(r.status, 404, "bob can't fetch alice's article by id");
    r = await api('DELETE', `/api/highlights/${hlId}`, undefined, BOB);
    assert.strictEqual(r.status, 404, "bob can't delete alice's highlight");
    r = await api('GET', '/api/health', undefined, BOB);
    assert.strictEqual(r.body.articles, 0, 'health counts are per-user');

    // ---- web UI ---------------------------------------------------------
    res = await fetch(BASE + '/', { headers: { Cookie: aliceCookie } });
    assert.strictEqual(res.status, 200);
    let html = await res.text();
    assert.ok(html.includes('A Great Story (updated)') === false, 'archived article not in inbox');
    assert.ok(html.includes('Orphan Article'), 'inbox lists article');
    assert.ok(res.headers.get('content-security-policy').includes("script-src 'nonce-"), 'CSP present');

    res = await fetch(BASE + `/?view=archive`, { headers: { Cookie: aliceCookie } });
    html = await res.text();
    assert.ok(html.includes('A Great Story (updated)'), 'archive view lists archived article');

    res = await fetch(BASE + `/read/${articleId}`, { headers: { Cookie: aliceCookie } });
    html = await res.text();
    assert.ok(html.includes('<p>Updated content.</p>'), 'reader renders stored html');
    assert.ok(html.includes('It was a dark and stormy night.'), 'reader shows highlights');

    res = await fetch(BASE + `/read/${articleId}`, { headers: { Cookie: bobCookie } });
    assert.strictEqual(res.status, 404, "bob can't read alice's article in the web UI");

    res = await fetch(BASE + '/settings', { headers: { Cookie: aliceCookie } });
    html = await res.text();
    assert.ok(html.includes(TOKEN), 'settings shows the API token');

    // session cookie works on /api (used by the web UI's buttons)
    r = await api('PATCH', `/api/articles/${articleId}`, { archived: false }, { Cookie: aliceCookie, 'Content-Type': 'application/json' });
    assert.strictEqual(r.status, 200);

    // logout kills the session
    res = await form('/logout', {}, aliceCookie);
    assert.strictEqual(res.status, 303);
    res = await fetch(BASE + '/', { headers: { Cookie: aliceCookie }, redirect: 'manual' });
    assert.strictEqual(res.status, 303, 'session destroyed after logout');

    // ---- search & filters -----------------------------------------------
    const aliceCookie2 = cookieOf(await form('/login', { username: 'alice', password: 'correct-horse' }));
    await api('PATCH', `/api/articles/${articleId}`, { archived: true }); // was unarchived by the web UI test
    await api('POST', '/api/articles', {
      url: 'https://blog.rust-lang.org/some-post',
      title: 'Ownership Explained',
      html: '<p>The borrow checker enforces aliasing rules.</p>',
      textContent: 'The borrow checker enforces aliasing rules.',
    });
    // q matches body text, multi-term is AND
    r = await api('GET', '/api/articles?q=borrow+checker');
    assert.strictEqual(r.body.articles.length, 1, 'search matches textContent');
    assert.strictEqual(r.body.articles[0].title, 'Ownership Explained');
    r = await api('GET', '/api/articles?q=borrow+zebra');
    assert.strictEqual(r.body.articles.length, 0, 'all terms must match');
    // q matches archived only with includeArchived
    r = await api('GET', '/api/articles?q=great+story');
    assert.strictEqual(r.body.articles.length, 0, 'archived excluded by default');
    r = await api('GET', '/api/articles?q=great+story&includeArchived=1');
    assert.strictEqual(r.body.articles.length, 1, 'archived searchable with includeArchived');
    // domain filter (subdomain matches, www stripped)
    r = await api('GET', '/api/articles?domain=rust-lang.org');
    assert.strictEqual(r.body.articles.length, 1, 'domain filter matches subdomain');
    r = await api('GET', '/api/articles?domain=example.com&includeArchived=1');
    assert.strictEqual(r.body.articles.length, 2, 'domain filter scopes to domain');
    // highlighted filter
    r = await api('GET', '/api/articles?highlighted=1&includeArchived=1');
    assert.strictEqual(r.body.articles.length, 1, 'highlighted filter');
    assert.strictEqual(r.body.articles[0].id, articleId);
    // web: search form + results
    res = await fetch(BASE + '/?q=borrow', { headers: { Cookie: bobCookie } });
    html = await res.text();
    assert.ok(html.includes('No articles match'), "search is per-user (bob finds nothing)");
    res = await fetch(BASE + '/?q=borrow', { headers: { Cookie: aliceCookie2 } });
    html = await res.text();
    assert.ok(html.includes('Ownership Explained'), 'web search finds article');
    assert.ok(html.includes('1 result'), 'web search shows count');

    // web highlight creation (what the reader's selection button does)
    r = await api('POST', `/api/articles/${articleId}/highlights`,
      { text: 'Then it got worse.', clientId: 'web-test-1' },
      { Cookie: aliceCookie2, 'Content-Type': 'application/json' });
    assert.strictEqual(r.status, 201, 'session cookie can create highlights');
    await api('DELETE', `/api/highlights/${r.body.id}`);

    // ---- email-to-save webhook ------------------------------------------
    r = await api('GET', '/api/me');
    const aliceEmail = r.body.emailAddress;
    assert.ok(/^alice-[0-9a-f]{6}@in\.test$/.test(aliceEmail), 'account has an email alias');

    const emailPayload = {
      From: 'writer@newsletter.example',
      FromFull: { Email: 'writer@newsletter.example', Name: 'A Newsletter' },
      ToFull: [{ Email: aliceEmail, Name: '' }],
      Subject: 'Issue #42',
      MessageID: 'msg-abc-123',
      Date: 'Sat, 5 Jul 2026 10:00:00 +0000',
      HtmlBody: '<h1>Issue #42</h1><script>evil()</script><p onclick="x()">Hello subscriber.</p>',
      TextBody: 'Issue #42. Hello subscriber.',
    };
    // secret required
    let er = await fetch(BASE + '/api/inbound-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(emailPayload) });
    assert.strictEqual(er.status, 403, 'webhook rejects missing secret');
    er = await fetch(BASE + '/api/inbound-email?secret=wrong', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(emailPayload) });
    assert.strictEqual(er.status, 403, 'webhook rejects wrong secret');

    // delivery creates an article for alice
    er = await fetch(BASE + '/api/inbound-email?secret=whsec-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(emailPayload) });
    assert.strictEqual(er.status, 200);
    const emailArt = (await er.json()).id;
    assert.ok(emailArt, 'email becomes an article');

    r = await api('GET', `/api/articles/${emailArt}`);
    assert.strictEqual(r.body.title, 'Issue #42');
    assert.strictEqual(r.body.siteName, 'Email');
    assert.strictEqual(r.body.byline, 'A Newsletter');
    assert.ok(!r.body.html.includes('<script>'), 'script tags stripped from email html');
    assert.ok(!r.body.html.includes('onclick'), 'inline handlers stripped from email html');
    assert.ok(r.body.html.includes('Hello subscriber.'), 'email body preserved');

    // provider retries are idempotent (same MessageID)
    er = await fetch(BASE + '/api/inbound-email?secret=whsec-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(emailPayload) });
    assert.strictEqual((await er.json()).id, emailArt, 'redelivery dedupes by MessageID');

    // unknown recipient accepted but dropped
    er = await fetch(BASE + '/api/inbound-email?secret=whsec-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...emailPayload, MessageID: 'msg-other', ToFull: [{ Email: 'nobody-000000@in.test' }] }) });
    assert.strictEqual(er.status, 200);
    assert.strictEqual((await er.json()).dropped, 'unknown recipient');

    // bob doesn't see alice's email article
    r = await api('GET', `/api/articles/${emailArt}`, undefined, BOB);
    assert.strictEqual(r.status, 404, "email article is private to alice");

    await api('DELETE', `/api/articles/${emailArt}`);

    // ---- deletes (as alice, token auth still fine) ----------------------
    r = await api('DELETE', `/api/highlights/${hlId}`);
    assert.strictEqual(r.body.ok, true);
    r = await api('DELETE', `/api/highlights/${hlId}`);
    assert.strictEqual(r.status, 404);

    r = await api('DELETE', `/api/articles/${articleId}`);
    assert.strictEqual(r.body.ok, true);
    r = await api('GET', `/api/articles/${articleId}`);
    assert.strictEqual(r.status, 404);

    console.log('All server tests passed ✔');
  } finally {
    const exited = new Promise((resolve) => proc.on('exit', resolve));
    proc.kill('SIGTERM');
    await exited;
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); }
    catch { /* windows can hold the db file briefly after exit */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

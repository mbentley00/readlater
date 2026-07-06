#!/usr/bin/env node
/** End-to-end smoke test: boots the server on a random port and exercises every endpoint,
 * including accounts (signup/login/logout), per-user isolation, legacy-token adoption,
 * and the web UI. */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
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

/** A minimal but structurally valid one-page PDF containing `text`. */
function makeTestPdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const bodies = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (const b of bodies) { offsets.push(out.length); out += b; }
  const xrefPos = out.length;
  out += 'xref\n0 6\n0000000000 65535 f \n' +
    offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

/** Fake Anthropic Messages API: always "finds" a long article in the page. */
const LLM_HTML = '<p>' + 'This is the rescued article body, recovered by the language model from the raw page. '.repeat(12).trim() + '</p>';
function startMockAnthropic(port) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_mock', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: LLM_HTML }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 100 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const MOCK_LLM_PORT = PORT + 1;
  const mockLlm = await startMockAnthropic(MOCK_LLM_PORT);

  // pre-seed an old-format db (no users) to test legacy migration
  fs.writeFileSync(path.join(DATA_DIR, 'db.json'), JSON.stringify({
    articles: [{ id: 'orphan01', url: 'https://example.com/orphan', savedAt: 1000, archived: false, favorite: false, readParagraph: 0, title: 'Orphan Article', html: '<p>pre-account content</p>', updatedAt: 1000 }],
    highlights: [],
  }));

  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), READLATER_DATA_DIR: DATA_DIR, READLATER_TOKEN: TOKEN,
      READLATER_INBOUND_SECRET: 'whsec-test', READLATER_INBOUND_DOMAIN: 'in.test',
      ANTHROPIC_API_KEY: 'sk-ant-test-not-real',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_LLM_PORT}`,
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

    // patch state (as the app does) — scroll and TTS positions are separate
    r = await api('PATCH', `/api/articles/${articleId}`, { favorite: true, readParagraph: 3 });
    assert.strictEqual(r.body.favorite, true);
    assert.strictEqual(r.body.readParagraph, 3);
    r = await api('PATCH', `/api/articles/${articleId}`, { ttsParagraph: 7 });
    assert.strictEqual(r.body.ttsParagraph, 7);
    assert.strictEqual(r.body.readParagraph, 3, 'ttsParagraph patch leaves readParagraph alone');

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

    // highlights page groups by article with counts
    res = await fetch(BASE + '/highlights', { headers: { Cookie: aliceCookie } });
    html = await res.text();
    assert.ok(html.includes('1 highlight'), 'highlights page shows per-article count');
    assert.ok(html.includes(`/read/${articleId}`), 'highlights page links to the article');

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

    // ---- token exchange (device login) -----------------------------------
    r = await api('POST', '/api/login', { username: 'alice', password: 'correct-horse' }, { 'Content-Type': 'application/json' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.token, TOKEN, 'login returns the API token');
    assert.strictEqual(r.body.username, 'alice');
    r = await api('POST', '/api/login', { username: 'alice', password: 'nope-nope-nope' }, { 'Content-Type': 'application/json' });
    assert.strictEqual(r.status, 401, 'wrong password rejected');
    r = await api('POST', '/api/login', { username: 'ghost', password: 'whatever123' }, { 'Content-Type': 'application/json' });
    assert.strictEqual(r.status, 401, 'unknown user rejected');

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
    assert.strictEqual(r.body.articles[0].wordCount, 6, 'list metadata carries wordCount');
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

    // ---- length/highlight filters + saved views ---------------------------
    r = await api('GET', '/api/articles?minWords=5&includeArchived=1');
    assert.strictEqual(r.body.articles.length, 1, 'minWords filter');
    assert.strictEqual(r.body.articles[0].title, 'Ownership Explained');
    r = await api('GET', '/api/articles?maxWords=4&includeArchived=1');
    assert.strictEqual(r.body.articles.length, 2, 'maxWords filter');
    r = await api('GET', '/api/articles?minHighlights=1&includeArchived=1');
    assert.strictEqual(r.body.articles.length, 1, 'minHighlights filter');
    assert.strictEqual(r.body.articles[0].id, articleId);

    r = await api('POST', '/api/views', { name: 'Long reads', filters: { minWords: 5 } });
    assert.strictEqual(r.status, 201);
    const viewId = r.body.id;
    r = await api('GET', '/api/views');
    assert.strictEqual(r.body.views.length, 1);
    assert.strictEqual(r.body.views[0].name, 'Long reads');
    assert.strictEqual(r.body.views[0].filters.minWords, 5);

    res = await fetch(BASE + `/?view=v:${viewId}`, { headers: { Cookie: aliceCookie2 } });
    html = await res.text();
    assert.ok(html.includes('Ownership Explained'), 'saved view filters the web list');
    assert.ok(html.includes('Long reads'), 'view chip rendered');

    res = await form('/views/save', { name: 'From example', domain: 'example.com', q: '', hl: '', len: '' }, aliceCookie2);
    assert.strictEqual(res.status, 303, 'save-as-view form works');
    r = await api('GET', '/api/views');
    assert.strictEqual(r.body.views.length, 2);

    r = await api('DELETE', `/api/views/${viewId}`);
    assert.strictEqual(r.body.ok, true);
    r = await api('GET', '/api/views');
    assert.strictEqual(r.body.views.length, 1);

    // ---- PDF import -------------------------------------------------------
    const pdfBuf = makeTestPdf('The PDF import pipeline extracted this sentence.');
    res = await fetch(BASE + '/api/import/pdf?filename=my-test-doc.pdf', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/pdf' },
      body: pdfBuf,
    });
    assert.strictEqual(res.status, 201, 'pdf import accepted');
    const pdfArticle = await res.json();
    assert.ok(pdfArticle.textContent.includes('extracted this sentence'), 'pdf text extracted');
    assert.strictEqual(pdfArticle.siteName, 'PDF');
    assert.ok(pdfArticle.title.includes('my test doc'), 'title from filename');

    // re-importing the same file dedupes by content hash
    res = await fetch(BASE + '/api/import/pdf?filename=my-test-doc.pdf', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/pdf' },
      body: pdfBuf,
    });
    assert.strictEqual((await res.json()).id, pdfArticle.id, 'pdf re-import dedupes');

    res = await fetch(BASE + '/api/import/pdf?filename=nope.pdf', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/pdf' },
      body: Buffer.from('this is not a pdf'),
    });
    assert.strictEqual(res.status, 400, 'non-pdf rejected');
    await api('DELETE', `/api/articles/${pdfArticle.id}`);

    // web highlight creation (what the reader's selection button does)
    r = await api('POST', `/api/articles/${articleId}/highlights`,
      { text: 'Then it got worse.', clientId: 'web-test-1' },
      { Cookie: aliceCookie2, 'Content-Type': 'application/json' });
    assert.strictEqual(r.status, 201, 'session cookie can create highlights');
    await api('DELETE', `/api/highlights/${r.body.id}`);

    // ---- LLM parse rescue -------------------------------------------------
    // A save flagged with fallbackHtml gets asynchronously re-extracted.
    r = await api('POST', '/api/articles', {
      url: 'https://paywalled.example.com/thin-article',
      title: 'Badly Parsed Article',
      html: '<p>You are reading a teaser.</p>',
      textContent: 'You are reading a teaser.',
      fallbackHtml: '<div class="page"><nav>menu</nav><div class="body">the real article text lives here</div></div>',
    });
    assert.strictEqual(r.status, 201);
    const rescueId = r.body.id;
    assert.ok(r.body.html.includes('teaser'), 'save responds immediately with the thin version');

    let rescued = null;
    for (let i = 0; i < 50; i++) {
      r = await api('GET', `/api/articles/${rescueId}`);
      if (r.body.html && r.body.html.includes('rescued article body')) { rescued = r.body; break; }
      await new Promise((res2) => setTimeout(res2, 100));
    }
    assert.ok(rescued, 'article upgraded by the LLM rescue in the background');
    assert.ok(rescued.textContent.includes('rescued article body'), 'textContent replaced too');
    assert.strictEqual(rescued.title, 'Badly Parsed Article', 'title preserved through rescue');

    // a save without fallbackHtml is never sent to the LLM
    r = await api('POST', '/api/articles', {
      url: 'https://example.com/fine-article',
      title: 'Fine Article',
      html: '<p>Parsed fine.</p>',
      textContent: 'Parsed fine.',
    });
    const fineId = r.body.id;
    await new Promise((res2) => setTimeout(res2, 400));
    r = await api('GET', `/api/articles/${fineId}`);
    assert.strictEqual(r.body.html, '<p>Parsed fine.</p>', 'unflagged save untouched');
    await api('DELETE', `/api/articles/${rescueId}`);
    await api('DELETE', `/api/articles/${fineId}`);

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

    // ---- export + apk hosting --------------------------------------------
    res = await fetch(BASE + '/api/export.json', { headers: HEADERS });
    assert.strictEqual(res.status, 200);
    assert.ok((res.headers.get('content-disposition') || '').includes('readlater-export.json'));
    const exported = await res.json();
    assert.strictEqual(exported.username, 'alice');
    assert.ok(exported.articles.length >= 3, 'export contains all articles');
    assert.ok(exported.articles.some((a) => typeof a.html === 'string' && a.html.length > 0), 'export includes article html');
    assert.ok(Array.isArray(exported.highlights) && exported.highlights.length >= 1, 'export includes highlights');

    const fakeApk = Buffer.from('PK-not-really-an-apk-' + 'x'.repeat(100));
    res = await fetch(BASE + '/api/app.apk?versionName=9.9&versionCode=99', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: fakeApk,
    });
    assert.strictEqual(res.status, 201, 'apk upload accepted');
    r = await api('GET', '/api/app-version');
    assert.strictEqual(r.body.versionName, '9.9');
    assert.strictEqual(r.body.versionCode, 99, 'app-version reports uploaded metadata');
    res = await fetch(BASE + '/app.apk', { headers: { Cookie: aliceCookie2 } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.strictEqual(Buffer.from(await res.arrayBuffer()).toString(), fakeApk.toString(), 'apk round-trips');
    res = await fetch(BASE + '/app.apk', { redirect: 'manual' });
    assert.strictEqual(res.status, 303, 'apk download requires login');

    // named side-APKs (e.g. TTS engines)
    res = await fetch(BASE + '/api/apk/test-engine', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: Buffer.from('PK-side-apk'),
    });
    assert.strictEqual(res.status, 201, 'named apk upload accepted');
    res = await fetch(BASE + '/apk/test-engine', { headers: { Cookie: aliceCookie2 } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(Buffer.from(await res.arrayBuffer()).toString(), 'PK-side-apk', 'named apk round-trips');
    res = await fetch(BASE + '/api/apk/Bad Name!', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: Buffer.from('x'),
    });
    assert.strictEqual(res.status, 400, 'invalid apk name rejected');

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
    mockLlm.close();
    const exited = new Promise((resolve) => proc.on('exit', resolve));
    proc.kill('SIGTERM');
    await exited;
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); }
    catch { /* windows can hold the db file briefly after exit */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

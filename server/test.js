#!/usr/bin/env node
/** End-to-end smoke test: boots the server on a random port and exercises every endpoint. */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const PORT = 18090 + Math.floor(Math.random() * 1000);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'readlater-test-'));
const TOKEN = 'test-token-123';
const BASE = `http://127.0.0.1:${PORT}`;
const HEADERS = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), READLATER_DATA_DIR: DATA_DIR, READLATER_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  // wait for server to come up
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + '/api/health', { headers: HEADERS });
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    // auth required
    const unauth = await fetch(BASE + '/api/articles');
    assert.strictEqual(unauth.status, 401, 'unauthenticated request should 401');

    // health
    let r = await api('GET', '/api/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);

    // save article (as the extension does)
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
    assert.strictEqual(r.body.articles.length, 1);
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
    assert.strictEqual(r.body.articles.length, 0, 'archived hidden by default');
    r = await api('GET', '/api/articles?includeArchived=1');
    assert.strictEqual(r.body.articles.length, 1);

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

    // delete highlight
    r = await api('DELETE', `/api/highlights/${hlId}`);
    assert.strictEqual(r.body.ok, true);
    r = await api('DELETE', `/api/highlights/${hlId}`);
    assert.strictEqual(r.status, 404);

    // delete article
    r = await api('DELETE', `/api/articles/${articleId}`);
    assert.strictEqual(r.body.ok, true);
    r = await api('GET', `/api/articles/${articleId}`);
    assert.strictEqual(r.status, 404);

    console.log('All server tests passed ✔');
  } finally {
    proc.kill('SIGTERM');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

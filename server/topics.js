/**
 * Topic search over highlighted articles: find them by what they are about
 * ("eastern european history before 1900") rather than by the words in them.
 *
 * Two halves, both on Claude Haiku 5.5:
 *
 *  1. Topic cards. A background worker writes one small card per highlighted
 *     article — a one-sentence summary, subject tags, the places it concerns
 *     and the span of years it covers — from the title, the opening of the
 *     text and the highlights. Cards live in article_topics and are rewritten
 *     when an article's highlights change. Roughly $0.0003 per card.
 *
 *  2. Search. The query goes to the model along with the whole catalogue of
 *     cards (~70 tokens each), and the model returns the articles that fit,
 *     best first, each with a short reason. A model rather than keyword or
 *     embedding matching because the hard part of such queries is judgment:
 *     whether Habsburg Galicia counts as eastern Europe, whether an article
 *     on 1890s–1920s Poland is "before 1900". The catalogue is cut into
 *     shards kept under Haiku 5.5's 100k-token price break, searched in
 *     parallel, and prompt-cached, so a repeat search within five minutes
 *     reads it at a tenth of the price. ~$0.01 per shard uncached.
 *
 * Enabled when ANTHROPIC_API_KEY is set, like the rest of llm.js.
 */
'use strict';

const llm = require('./llm');

const MODEL = 'claude-haiku-5-5';

// ---------------------------------------------------------------- cards

const CARD_SYSTEM = `You catalogue articles in a personal reading library so they can be found later by topic. You get an article's title, source, the opening of its text, and the passages the reader highlighted. The highlights show what the reader cared about, so weigh them most.

Describe what the article is about:
- summary: one sentence, at most 30 words, saying what the article covers (its subject matter, not its style).
- subjects: 3 to 8 topic tags, from broad to specific, e.g. ["history", "military history", "Napoleonic Wars"] or ["biology", "genetics", "CRISPR"]. Lower case except proper nouns.
- places: the countries and regions the content is about, both specific and broad, with historical names where they apply alongside modern ones, e.g. ["Galicia", "Austrian Empire", "Poland", "Ukraine", "Eastern Europe"]. An empty list when the subject is not tied to a place.
- from, to: the span of years the content is about — not when it was written. Negative numbers for BCE. For an article about the present day, the recent years it covers. Both null only when the subject has no particular time (a recipe, a math proof, general advice).`;

const CARD_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    subjects: { type: 'array', items: { type: 'string' } },
    places: { type: 'array', items: { type: 'string' } },
    from: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    to: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
  },
  required: ['summary', 'subjects', 'places', 'from', 'to'],
  additionalProperties: false,
};

const MAX_HIGHLIGHT_CHARS = 6000;

function cardPrompt(src) {
  let hls = '';
  for (const h of src.highlights) {
    const line = `- ${h.text}${h.note ? ` [reader's note: ${h.note}]` : ''}\n`;
    if (hls.length + line.length > MAX_HIGHLIGHT_CHARS) { hls += '- …\n'; break; }
    hls += line;
  }
  return [
    `Title: ${src.title || '(untitled)'}`,
    `Source: ${[src.siteName, src.byline].filter(Boolean).join(' — ') || '(unknown)'}`,
    src.excerpt ? `Excerpt: ${src.excerpt}` : '',
    `\nOpening of the text:\n${(src.opening || '').replace(/\s+/g, ' ').trim()}`,
    `\nHighlighted passages:\n${hls}`,
  ].filter(Boolean).join('\n');
}

/** Parsed JSON from a structured-output reply. Throws ModelDeclined (a
 *  problem with this input, not the service) on a refusal, truncation or
 *  unparseable reply. */
class ModelDeclined extends Error {}
function replyJson(response) {
  if (response.stop_reason === 'refusal') throw new ModelDeclined('refused');
  if (response.stop_reason === 'max_tokens') throw new ModelDeclined('ran out of tokens');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(text); } catch { throw new ModelDeclined('unparseable reply'); }
}

const strList = (v, max) => (Array.isArray(v) ? v : [])
  .map((s) => String(s || '').trim()).filter(Boolean).slice(0, max).map((s) => s.slice(0, 80));
const year = (v) => (Number.isInteger(v) && v > -10000 && v < 3000 ? v : null);

async function writeCard(client, src) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000, // thinking counts toward this; the card itself is ~150 tokens
    system: CARD_SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: CARD_SCHEMA } },
    messages: [{ role: 'user', content: cardPrompt(src) }],
  });
  const c = replyJson(response);
  let from = year(c.from), to = year(c.to);
  if (from != null && to != null && to < from) [from, to] = [to, from];
  return {
    title: String(src.title || '').slice(0, 200),
    site: String(src.siteName || '').slice(0, 80),
    summary: String(c.summary || '').trim().slice(0, 300),
    subjects: strList(c.subjects, 8),
    places: strList(c.places, 10),
    from: from ?? to,
    to: to ?? from,
  };
}

/** Is this API error worth retrying later (rate limit, overload, network)? */
const transient = (e) => !e.status || e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;

const WORKER_BATCH = 30;
const WORKER_CONCURRENCY = 3;
const WORKER_IDLE_MS = 10 * 60 * 1000; // new highlights show up in search within ~10 min
const WORKER_BACKOFF_MS = 15 * 60 * 1000;

/**
 * Writes cards for one batch of pending articles. Returns how many it tried;
 * throws on an error that should pause the whole worker (rate limit, outage,
 * bad key or model).
 */
async function cardBatch(store) {
  const client = llm.getClient();
  if (!client) return 0;
  const pending = store.topicPending(WORKER_BATCH);
  let i = 0;
  let fatal = null;
  const one = async () => {
    while (i < pending.length && !fatal) {
      const p = pending[i++];
      const src = store.topicSource(p.articleId);
      if (!src || !src.highlights.length) {
        store.putTopicCard({ ...p, card: '' });
        continue;
      }
      try {
        const card = await writeCard(client, src);
        store.putTopicCard({ ...p, card: JSON.stringify(card) });
      } catch (e) {
        if (e instanceof ModelDeclined) {
          // Something about this article; don't retry until its highlights
          // change. (A 400 is NOT treated this way: every request has the same
          // shape, so it means a bug here, and marking would bury the backlog.)
          console.error(`topics: no card for ${p.articleId} (${e.message})`);
          store.putTopicCard({ ...p, card: '' });
        } else {
          fatal = e;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: WORKER_CONCURRENCY }, one));
  if (fatal) throw fatal;
  return pending.length;
}

/** Keeps every highlighted article's card current, in the background. */
function startWorker(store) {
  if (!llm.enabled()) return;
  let total = 0;
  const run = async () => {
    let delay = WORKER_IDLE_MS;
    try {
      const n = await cardBatch(store);
      total += n;
      if (n === WORKER_BATCH) delay = 0; // backlog (first run after deploy): keep going
      else if (total) { console.log(`topics: ${total} topic card(s) written`); total = 0; }
    } catch (e) {
      console.error(`topics: card worker paused (${e.status || ''} ${e.message})`);
      if (!transient(e)) delay = 6 * 60 * 60 * 1000; // bad key/model: don't hammer
      else delay = WORKER_BACKOFF_MS;
    }
    setTimeout(run, delay).unref();
  };
  // Not right at boot: let first syncs and page loads go first.
  setTimeout(run, 60 * 1000).unref();
}

// ---------------------------------------------------------------- search

const SEARCH_SYSTEM = `You search a reader's personal library of articles they highlighted, by topic. Below is a catalogue, one article per line:
#id | title | site | years the article covers | places | subjects | summary

Given the reader's request, return every article that genuinely fits it, best fit first. Read the request the way a thoughtful librarian would:
- A broad category includes its parts. "Eastern Europe", for instance, takes in Poland, the Baltics, Belarus, Ukraine, Hungary, Czechia, Slovakia, Romania, Moldova, the Balkans and European Russia, and historical states there such as the Polish–Lithuanian Commonwealth, the Habsburg crown lands of Galicia or Bohemia, and the Ottoman Balkans.
- Date limits apply to the years the article covers, not when it was written. "Before 1900" fits an article on 1848; an article spanning 1880–1920 fits partly.
- A subject request fits articles mainly about that subject, not ones that mention it in passing.

fit is "strong" when the article squarely matches, "partial" when it overlaps only in part (straddles a date limit, touches the topic as a side theme). Leave out anything that does not fit at all. why: at most 15 words on what makes it fit. Use only ids that appear in the catalogue; return an empty list if nothing fits.`;

const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          fit: { type: 'string', enum: ['strong', 'partial'] },
          why: { type: 'string' },
        },
        required: ['id', 'fit', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['matches'],
  additionalProperties: false,
};

const fmtYear = (y) => (y < 0 ? `${-y} BCE` : String(y));
function catalogueLine(n, c) {
  const years = c.from == null ? '-' : c.from === c.to ? fmtYear(c.from) : `${fmtYear(c.from)}–${fmtYear(c.to)}`;
  const clean = (s) => String(s).replace(/[|\n]/g, ' ');
  return `#${n} | ${clean(c.title)} | ${clean(c.site || '-')} | ${years} | ${clean(c.places.join('; ') || '-')} | ${clean(c.subjects.join('; '))} | ${clean(c.summary)}`;
}

// ~4 characters a token for English, with headroom for Haiku 5.5's tokenizer
// and the system prompt: each shard's prompt stays under the 100k-token line
// above which Haiku 5.5's input price is 5x.
const SHARD_CHARS = 240000;

function shardsOf(cards) {
  const shards = [];
  let cur = [], len = 0;
  for (const c of cards) {
    const line = catalogueLine(c.n, c.card);
    if (len + line.length > SHARD_CHARS && cur.length) { shards.push(cur); cur = []; len = 0; }
    cur.push(line); len += line.length + 1;
  }
  if (cur.length) shards.push(cur);
  return shards;
}

async function searchShard(client, lines, query) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: [
      { type: 'text', text: SEARCH_SYSTEM },
      // Shards are cut in card order, so all but the newest stay byte-identical
      // between searches and their cache entries stay valid.
      { type: 'text', text: `Catalogue:\n${lines.join('\n')}`, cache_control: { type: 'ephemeral' } },
    ],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SEARCH_SCHEMA } },
    messages: [{ role: 'user', content: `Request: ${query}` }],
  });
  return replyJson(response).matches || [];
}

const resultCache = new Map(); // `${userId}\n${query}` → { version, at, value }
const RESULT_TTL_MS = 60 * 60 * 1000;

/**
 * Highlighted articles matching a topic request, best first:
 * { results: [{ articleId, fit, why }], searched, failed } where [searched]
 * is how many cards were searched and [failed] how many shards errored (their
 * articles are simply missing from the results). Null when disabled.
 */
async function search(store, userId, query) {
  const client = llm.getClient();
  if (!client) return null;
  const q = String(query).trim().slice(0, 300);
  const { version } = store.topicStats(userId);
  const key = `${userId}\n${q.toLowerCase()}`;
  const hit = resultCache.get(key);
  if (hit && hit.version === version && Date.now() - hit.at < RESULT_TTL_MS) return hit.value;

  const cards = store.topicCards(userId).map((r) => {
    try { return { n: r.n, articleId: r.articleId, card: JSON.parse(r.card) }; } catch { return null; }
  }).filter(Boolean);
  const byN = new Map(cards.map((c) => [c.n, c]));
  const shards = shardsOf(cards);
  const settled = await Promise.allSettled(shards.map((lines) => searchShard(client, lines, q)));

  // Merge: strong before partial; within each, interleave the shards' own
  // rankings (each shard ranked only its own slice of the library).
  const merged = [];
  let failed = 0;
  settled.forEach((s, shard) => {
    if (s.status === 'rejected') {
      failed++;
      console.error(`topics: search shard ${shard} failed (${s.reason?.status || ''} ${s.reason?.message})`);
      return;
    }
    const seen = new Set();
    s.value.forEach((m, rank) => {
      const c = byN.get(m.id);
      if (!c || seen.has(m.id)) return; // invented or repeated id
      seen.add(m.id);
      merged.push({ articleId: c.articleId, fit: m.fit === 'partial' ? 'partial' : 'strong',
        why: String(m.why || '').slice(0, 200), rank });
    });
  });
  merged.sort((a, b) => (a.fit === b.fit ? a.rank - b.rank : a.fit === 'strong' ? -1 : 1));
  const value = { results: merged.map(({ rank, ...r }) => r), searched: cards.length, failed };

  if (!failed) {
    resultCache.delete(key);
    resultCache.set(key, { version, at: Date.now(), value });
    if (resultCache.size > 100) resultCache.delete(resultCache.keys().next().value);
  }
  return value;
}

module.exports = { startWorker, search, cardBatch, catalogueLine, shardsOf };

'use strict';

/**
 * Podcast subscriptions: an RSS feed whose new episodes arrive in Earmark by
 * themselves, transcribed like an episode shared from a player.
 *
 * Two deliberate limits, both about not surprising you:
 *
 *  - Adding a feed imports NOTHING. Every episode already in it is written down
 *    as seen, so the flow starts with the next one published. A podcast's back
 *    catalogue is hundreds of hours of transcription nobody asked for.
 *  - A feed can be set not to take anything by itself (autoProcess off): new
 *    episodes are then only written down as waiting, for you to pick from on
 *    the Settings page, and nothing is downloaded until you do.
 *  - A poll takes at most [MAX_PER_POLL] episodes from a feed. A show that
 *    dumps a season at once then drains over the following polls instead of
 *    queueing forty transcriptions at midnight.
 *
 * The XML is read by hand rather than with a parser dependency, in the way the
 * EPUB reader reads ZIP: podcast RSS is a shallow, well-travelled format, and
 * the whole of what we need from it is the channel title and, per item, a guid,
 * a title, a date and an <enclosure> url.
 */

const MAX_PER_POLL = 3;

/** Feeds are checked this often. Podcasts publish daily at most. */
const POLL_INTERVAL_MS = 30 * 60 * 1000;

/** A feed body past this is not a feed. */
const FEED_MAX_BYTES = 8 * 1024 * 1024;

const UA = 'Earmark/1.0 (+podcast subscriptions)';

// ------------------------------------------------------------------ parsing

/** Text of the first <tag> in [xml], CDATA unwrapped and entities decoded. */
function tagText(xml, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return m ? decode(m[1]) : '';
}

/** Value of an attribute on the first [tag] element. */
function tagAttr(xml, tag, attr) {
  const el = new RegExp(`<${tag}(\\s[^>]*?)/?>`, 'i').exec(xml);
  if (!el) return '';
  const m = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(el[1]);
  return m ? decode(m[2] !== undefined ? m[2] : m[3]) : '';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

function decode(s) {
  return String(s == null ? '' : s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, ent) => {
      const key = ent.toLowerCase();
      if (ENTITIES[key]) return ENTITIES[key];
      if (key[0] === '#') {
        const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
      }
      return whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** Audio enclosures only: a feed's items can carry images and video too. */
const audioEnclosure = (item) => {
  const url = tagAttr(item, 'enclosure', 'url');
  if (!url || !/^https?:\/\//i.test(url)) return '';
  const type = tagAttr(item, 'enclosure', 'type').toLowerCase();
  if (type && !/^(audio\/|application\/(ogg|octet-stream))/.test(type)) return '';
  return url;
};

/** An http(s) image url, or '' — artwork is shown straight from the host. */
const httpUrl = (u) => (/^https?:\/\//i.test(u || '') ? u.slice(0, 2000) : '');

/** Show artwork: <itunes:image href>, else RSS's own <image><url>. */
function channelImage(head) {
  const itunes = httpUrl(tagAttr(head, 'itunes:image', 'href'));
  if (itunes) return itunes;
  const block = /<image(?:\s[^>]*)?>([\s\S]*?)<\/image>/i.exec(head);
  return block ? httpUrl(tagText(block[1], 'url')) : '';
}

/**
 * Parse a podcast feed. Returns { title, imageUrl, items: [{guid, title, url,
 * publishedAt, durationS, imageUrl}] }, newest first as the feed gave them.
 * An item's imageUrl is its own episode art, '' when it has none (the show's
 * artwork is the fallback, left to the caller).
 */
function parseFeed(xml) {
  const body = String(xml || '');
  // The channel's own title, not an item's: cut at the first <item>.
  const head = body.split(/<item[\s>]/i)[0];
  const title = tagText(head, 'title') || '';
  const imageUrl = channelImage(head);
  const items = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const item = m[1];
    const url = audioEnclosure(item);
    if (!url) continue; // an item with no audio is not an episode
    const pub = tagText(item, 'pubDate');
    const when = pub ? Date.parse(pub) : NaN;
    items.push({
      // guid is optional in practice; the enclosure url is the fallback
      // identity, which is what a re-published item keeps stable.
      guid: (tagText(item, 'guid') || url).slice(0, 500),
      title: tagText(item, 'title').slice(0, 300),
      url,
      publishedAt: Number.isFinite(when) ? when : null,
      durationS: parseDuration(tagText(item, 'itunes:duration')),
      imageUrl: httpUrl(tagAttr(item, 'itunes:image', 'href')),
    });
  }
  return { title, imageUrl, items };
}

/** iTunes durations come as seconds, or mm:ss, or hh:mm:ss. */
function parseDuration(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  const parts = t.split(':').map((p) => parseInt(p, 10));
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// ----------------------------------------------------------------- fetching

/** Fetch a feed, honouring the caching headers we stored last time. */
async function fetchFeed(url, { etag, lastModified } = {}) {
  const headers = { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' };
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;
  const resp = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (resp.status === 304) return { unchanged: true };
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > FEED_MAX_BYTES) throw new Error('feed is too large');
  return {
    xml: buf.toString('utf8'),
    etag: resp.headers.get('etag') || null,
    lastModified: resp.headers.get('last-modified') || null,
  };
}

/**
 * Download an episode. Refuses anything over [maxBytes] — from the
 * Content-Length when the host gives one, and again while reading when it
 * doesn't, so a host that lies cannot fill the disk.
 */
async function fetchEpisode(url, maxBytes) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const declared = parseInt(resp.headers.get('content-length') || '0', 10);
  if (declared && declared > maxBytes) {
    throw new Error(`episode is ${Math.round(declared / 1024 / 1024)}MB (limit ${Math.round(maxBytes / 1024 / 1024)}MB)`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of resp.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('episode is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ polling

/**
 * Check every feed once.
 *
 * @param deps.store        the database
 * @param deps.onEpisode    async ({feed, item, buf}) => void — saves + transcribes
 * @param deps.maxBytes     episode size cap
 * @param deps.log
 * @returns how many episodes were taken
 */
async function pollOnce(deps) {
  const { store, onEpisode, maxBytes, log = console.log } = deps;
  let taken = 0;
  for (const feed of store.listAllFeeds()) {
    try {
      // imageUrl is null until a check has read the show's artwork ('' when it
      // has none). Until then, skip the caching headers: a quiet feed would
      // answer 304 forever and its episodes would never get their art.
      const artKnown = feed.imageUrl != null;
      const got = await fetchFeed(feed.url, artKnown ? { etag: feed.etag, lastModified: feed.lastModified } : {});
      if (got.unchanged) { store.touchFeed(feed.id, { checkedAt: Date.now() }); continue; }
      const parsed = parseFeed(got.xml);
      if (!artKnown) {
        // Episodes taken before artwork was tracked: give them theirs, once.
        const n = store.backfillFeedArt(feed.id,
          parsed.items.map((i) => ({ guid: i.guid, imageUrl: i.imageUrl || parsed.imageUrl })));
        if (n) log(`feed: added artwork to ${n} episode(s) from ${feed.title || parsed.title || feed.url}`);
      }
      const show = { ...feed, imageUrl: feed.imageUrl || parsed.imageUrl };
      // Oldest first, so a batch arrives in the order it was published.
      const fresh = parsed.items.filter((i) => !store.feedItemSeen(feed.id, i.guid)).reverse();
      if (feed.autoProcess === 0) {
        // Waiting, not taken: costs a row each, so there is no per-poll cap.
        let waiting = 0;
        for (const item of fresh) {
          waiting += store.addPendingFeedItem(feed.id,
            { ...item, imageUrl: item.imageUrl || show.imageUrl || '' });
        }
        if (waiting) log(`feed: ${waiting} new episode(s) waiting from ${feed.title || feed.url}`);
      }
      for (const item of feed.autoProcess === 0 ? [] : fresh.slice(0, MAX_PER_POLL)) {
        try {
          const buf = await fetchEpisode(item.url, maxBytes);
          await onEpisode({ feed: show, item, buf });
          taken++;
        } catch (e) {
          // Mark it seen anyway: a broken enclosure would otherwise be retried
          // every half hour forever, and the failure is recorded on the feed.
          store.markFeedItemSeen(feed.id, item.guid, null);
          log(`feed: "${item.title || item.guid}" from ${feed.title || feed.url} failed (${e.message})`);
        }
      }
      store.touchFeed(feed.id, {
        checkedAt: Date.now(),
        title: feed.title || parsed.title || null,
        imageUrl: parsed.imageUrl,
        etag: got.etag,
        lastModified: got.lastModified,
        error: null,
      });
      if (feed.autoProcess !== 0 && fresh.length > MAX_PER_POLL) {
        log(`feed: ${fresh.length - MAX_PER_POLL} more waiting from ${feed.title || feed.url} — taking up to ${MAX_PER_POLL} a poll`);
      }
    } catch (e) {
      store.touchFeed(feed.id, { checkedAt: Date.now(), error: String(e.message || e).slice(0, 300) });
      log(`feed: ${feed.url} failed (${e.message})`);
    }
  }
  return taken;
}

/** Self-scheduling poll loop, in the shape inbound.js uses: a slow check can
 *  never overlap the next one. Returns a stop function. */
function start(deps) {
  const log = deps.log || console.log;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const n = await pollOnce({ ...deps, log });
      if (n) log(`feed: took ${n} new episode(s)`);
    } catch (e) {
      log(`feed: poll failed (${e.message})`);
    }
    if (!stopped) setTimeout(tick, POLL_INTERVAL_MS).unref();
  };
  // Not at boot: a deploy restarts the process, and a feed check that fights
  // the first syncs of every client is a bad first minute.
  setTimeout(tick, 60 * 1000).unref();
  return () => { stopped = true; };
}

/**
 * Pull feed URLs out of whatever was pasted or uploaded: an OPML export from a
 * podcast app (its xmlUrl attributes), or plain text with URLs anywhere in it.
 * OPML wins when present, since its other attributes (htmlUrl) are links to
 * the show's website, not feeds. Deduped, in the order given.
 */
function feedUrlsFrom(text) {
  const t = String(text || '');
  const opml = [...t.matchAll(/\bxmlUrl\s*=\s*(["'])(.*?)\1/gi)].map((m) => decode(m[2]).trim());
  // Pasted lists are often comma-separated, or sentences: trailing punctuation
  // belongs to the text around the URL, not to it.
  const found = opml.length ? opml
    : (t.match(/https?:\/\/[^\s"'<>]+/gi) || []).map((u) => u.replace(/[),.;:\]]+$/, ''));
  return [...new Set(found.filter((u) => /^https?:\/\//i.test(u)).map((u) => u.slice(0, 2000)))];
}

module.exports = {
  feedUrlsFrom,
  parseFeed, parseDuration, fetchFeed, fetchEpisode, pollOnce, start,
  MAX_PER_POLL, POLL_INTERVAL_MS,
};

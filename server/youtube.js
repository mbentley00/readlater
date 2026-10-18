'use strict';

/**
 * Saving a YouTube video as something to read: its transcript.
 *
 * A watch page has no article in it. Readability (server or extension) finds
 * nothing but the footer — "About Press Copyright Contact us…" — and that is
 * what YouTube saves used to come out as. The words are in the captions, which
 * nearly every video has (auto-generated when the uploader added none).
 *
 * Captions come from YouTube's own player API, asked as the Android app: the
 * web player's caption URLs now want a proof-of-origin token that only a real
 * browser can mint, while the app's come back plain. When there are no
 * captions, the video's description is the fallback — still more of the video
 * than the footer was. When neither can be had, callers keep their old path.
 *
 * No dependencies, like the rest of the server: the caption format is a flat
 * list of <text start dur> elements.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ANDROID_CLIENT = { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en' };
/** The player API's public key, used when the watch page doesn't yield one. */
const FALLBACK_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const TIMEOUT_MS = 20000;

const YT_HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$/i;
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** The video id of a YouTube link (watch, youtu.be, shorts, live, embed), or ''. */
function videoIdOf(url) {
  let u;
  try { u = new URL(String(url)); } catch { return ''; }
  const host = u.hostname.toLowerCase();
  let id = '';
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    id = u.pathname.split('/')[1] || '';
  } else if (YT_HOSTS.test(host)) {
    if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else {
      const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/?#]+)/);
      if (m) id = m[1];
    }
  }
  return ID_RE.test(id) ? id : '';
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeOnce(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, ent) => {
    const key = ent.toLowerCase();
    if (ENTITIES[key]) return ENTITIES[key];
    if (key[0] === '#') {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}
/** Caption text is escaped twice over ("There&amp;#39;s"), so decode until it settles. */
function decode(s) {
  let prev = String(s || '');
  for (let i = 0; i < 3; i++) {
    const next = decodeOnce(prev);
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

const escapeText = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Parse caption XML into [{start, text}]. Sound tags alone ("[Music]") are dropped. */
function parseCaptions(xml) {
  const out = [];
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) {
    const start = parseFloat((m[1].match(/\bstart="([\d.]+)"/) || [])[1]);
    const text = decode(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!text || /^\[[^\]]*\]$/.test(text)) continue;
    out.push({ start: Number.isFinite(start) ? start : null, text });
  }
  return out;
}

/** Paragraph length, in words: aim for the low end, end at a sentence when one comes. */
const PARA_MIN_WORDS = 70;
const PARA_MAX_WORDS = 160;
const PAUSE_S = 2.5;

/**
 * Caption lines are a few words each, broken wherever they fit on screen.
 * Join them into paragraphs: past PARA_MIN_WORDS, break at the end of a
 * sentence or at a pause; past PARA_MAX_WORDS (auto captions often have no
 * punctuation at all), break regardless.
 */
function captionsToParagraphs(segs) {
  const paras = [];
  let cur = [];
  let words = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    cur.push(s.text);
    words += s.text.split(' ').length;
    const next = segs[i + 1];
    const pause = next && s.start != null && next.start != null && next.start - s.start > PAUSE_S + s.text.split(' ').length * 0.6;
    if ((words >= PARA_MIN_WORDS && (/[.?!]["”’)]?$/.test(s.text) || pause)) || words >= PARA_MAX_WORDS) {
      paras.push(cur.join(' '));
      cur = [];
      words = 0;
    }
  }
  if (cur.length) paras.push(cur.join(' '));
  return paras;
}

/** Best caption track: the uploader's English, then English auto-captions, then anything. */
function pickTrack(tracks) {
  const en = (t) => /^en\b/i.test(t.languageCode || '');
  const asr = (t) => t.kind === 'asr';
  return tracks.find((t) => en(t) && !asr(t)) || tracks.find(en)
    || tracks.find((t) => !asr(t)) || tracks[0] || null;
}

async function getText(url, init = {}) {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

/**
 * Fetch a video's details and transcript. Returns article fields ready to
 * store ({title, byline, siteName, imageUrl, publishedAt, excerpt, html,
 * textContent, transcript: bool}), or throws with the reason it couldn't.
 */
async function fetchVideoArticle(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  // The watch page gives the API key and the publish date. It is not needed
  // for the transcript itself, so a failure here is not the end.
  let page = '';
  try {
    page = await getText(watchUrl, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' },
    });
  } catch { /* carry on with the fallback key */ }
  const key = (page.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || FALLBACK_KEY;
  const published = Date.parse((page.match(/"(?:publishDate|uploadDate)":"([^"]+)"/) || [])[1] || '');

  const player = JSON.parse(await getText(`https://www.youtube.com/youtubei/v1/player?key=${key}&prettyPrint=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip' },
    body: JSON.stringify({ context: { client: ANDROID_CLIENT }, videoId }),
  }));
  const status = player.playabilityStatus || {};
  const details = player.videoDetails || {};
  if (!details.title) {
    throw new Error(status.reason || status.status || 'YouTube returned no video details');
  }

  const tracks = ((player.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks || [];
  const track = pickTrack(tracks);
  let paras = [];
  if (track && track.baseUrl) {
    // fmt=srv3 (the default for some clients) nests words in <s>; plain is flat.
    const xml = await getText(track.baseUrl.replace(/&fmt=[^&]*/g, ''));
    paras = captionsToParagraphs(parseCaptions(xml));
  }
  const description = String(details.shortDescription || '').trim();
  const transcript = paras.length > 0;
  if (!transcript && !description) throw new Error('no captions and no description');

  const thumbs = ((details.thumbnail || {}).thumbnails || []).filter((t) => /^https:\/\//.test(t.url || ''));
  const imageUrl = thumbs.length
    ? thumbs.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a)).url
    : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  const body = transcript
    ? paras
    : description.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const lead = transcript
    ? (track.kind === 'asr' ? 'Transcript (auto-generated captions).' : 'Transcript.')
    : 'This video has no captions, so here is its description.';
  const html = `<p><em>${escapeText(lead)} <a href="${escapeText(watchUrl)}">Watch on YouTube</a></em></p>\n`
    + body.map((p) => `<p>${escapeText(p)}</p>`).join('\n');
  const textContent = body.join(' ');
  return {
    title: String(details.title).slice(0, 500),
    byline: details.author ? String(details.author).slice(0, 200) : null,
    siteName: 'YouTube',
    imageUrl,
    publishedAt: Number.isFinite(published) ? published : null,
    excerpt: textContent.slice(0, 300),
    html,
    textContent,
    transcript,
  };
}

module.exports = {
  videoIdOf, fetchVideoArticle, parseCaptions, captionsToParagraphs, pickTrack, decode,
  PARA_MIN_WORDS, PARA_MAX_WORDS,
};

'use strict';

const { spawn } = require('child_process');

// Podcast/audio upload → transcript article, via an OpenAI-compatible
// /audio/transcriptions endpoint (Whisper on DeepInfra by default — the same
// account the Kokoro TTS voice bills to, so TTS_API_KEY doubles as the key
// and no new secret is needed).
//
// Configuration (fly secrets / env):
//   TRANSCRIBE_API_KEY  default TTS_API_KEY; either one enables the feature
//   TRANSCRIBE_API_URL  default https://api.deepinfra.com/v1/openai/audio/transcriptions
//   TRANSCRIBE_MODEL    default openai/whisper-large-v3-turbo
//
// No dependencies: fetch/FormData/Blob are Node globals, ffmpeg/ffprobe are
// already in the image for TTS encoding.

const DEFAULT_URL = 'https://api.deepinfra.com/v1/openai/audio/transcriptions';

/** Title for an episode with neither a usable filename nor an embedded title
 *  (until the transcript names it). */
const PLACEHOLDER_TITLE = 'Podcast episode';

const cfg = () => ({
  url: process.env.TRANSCRIBE_API_URL || DEFAULT_URL,
  key: process.env.TRANSCRIBE_API_KEY || process.env.TTS_API_KEY || '',
  model: process.env.TRANSCRIBE_MODEL || 'openai/whisper-large-v3-turbo',
});

const enabled = () => !!cfg().key;

/** Downmix to 16 kHz mono Opus before uploading. Whisper hears nothing above
 *  16 kHz anyway, and this turns a 60 MB episode into ~10 MB, so the upload to
 *  the API stops being the slow (or failing) part. Falls back to the original
 *  bytes if ffmpeg is missing or can't read the file — the provider decodes
 *  most podcast formats itself. */
function transcodeForStt(buf) {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '16000',
      '-c:a', 'libopus', '-b:a', '24k', '-f', 'ogg', 'pipe:1',
    ]);
    const out = [];
    ff.stdout.on('data', (c) => out.push(c));
    ff.stderr.resume(); // keep the pipe drained
    ff.on('error', () => resolve(buf)); // ffmpeg not installed → passthrough
    ff.on('close', (code) => {
      const ogg = Buffer.concat(out);
      resolve(code === 0 && ogg.length > 0 ? ogg : buf);
    });
    ff.stdin.on('error', () => {}); // EPIPE when ffmpeg bails early
    ff.stdin.end(buf);
  });
}

// ------------------------------------------------------------------ metadata

/** Embedded tags (ID3, MP4, Vorbis comments) of an audio file on disk, keys
 *  lower-cased. Read from a file rather than a pipe: an MP4's tags can sit at
 *  the end, which ffprobe can only reach by seeking. {} when ffprobe is missing
 *  or the file has none. */
function probeTags(file) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_entries', 'format_tags', file]);
    const timer = setTimeout(() => p.kill('SIGKILL'), 15000);
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.resume();
    p.on('error', () => { clearTimeout(timer); resolve({}); });
    p.on('close', () => {
      clearTimeout(timer);
      try {
        const tags = JSON.parse(out).format?.tags || {};
        resolve(Object.fromEntries(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v])));
      } catch { resolve({}); }
    });
  });
}

/** The cover art embedded in an audio file (an ID3 APIC frame, an MP4 covr
 *  atom), as a JPEG no wider than 600px — or null when it has none or ffmpeg
 *  is missing. Read from a file for the same reason as probeTags. */
function extractCover(file) {
  return new Promise((resolve) => {
    const out = [];
    const ff = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', file,
      '-map', '0:v:0', '-an', '-frames:v', '1',
      '-vf', "scale='min(600,iw)':-2", '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2', 'pipe:1',
    ]);
    const timer = setTimeout(() => ff.kill('SIGKILL'), 15000);
    ff.stdout.on('data', (c) => out.push(c));
    ff.stderr.resume();
    ff.on('error', () => { clearTimeout(timer); resolve(null); });
    ff.on('close', (code) => {
      clearTimeout(timer);
      const jpg = Buffer.concat(out);
      // An error exit is the usual "no picture stream"; the size check
      // drops a stray few bytes.
      resolve(code === 0 && jpg.length > 200 ? jpg : null);
    });
  });
}

/** A filename that names nothing: a player's episode id, a hash, "audio", "track 3". */
const OPAQUE_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(audio|episode|download|file|track|recording|media|podcast episode)?[\s_-]*\d*)$/i;

const cleanTag = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * Title, show and host for an uploaded episode. The embedded title wins — it's
 * what the publisher called the episode — then a filename that actually says
 * something. title is null when neither does; the transcript names it later.
 */
function audioMeta(filename, tags) {
  const t = {};
  for (const [k, v] of Object.entries(tags || {})) t[k.toLowerCase()] = cleanTag(v);
  const stem = String(filename || '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  const show = t.album || '';
  const artist = t.artist || t.album_artist || '';
  return {
    title: t.title || (OPAQUE_NAME.test(stem) ? null : stem),
    siteName: show || artist || 'Podcast',
    byline: show && artist && artist.toLowerCase() !== show.toLowerCase() ? artist : null,
  };
}

// --------------------------------------------------------------- paragraphing

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Longest paragraph. Breaks only ever land between sentences. */
const PARA_MAX = 900;
/** A sentence longer than this (Whisper sometimes drops punctuation for
 *  minutes at a time) is cut at commas, then words, into pieces this size. */
const RUN_ON_MAX = 1000;
const RUN_ON_PIECE = 600;

const TERMINAL = /[.!?…]["'”’)\]]*$/;
/** "Dr." / "U.S." / "J." end in a period without ending the sentence. */
const ABBREV = /(^|[\s(])(mr|mrs|ms|dr|prof|st|vs|etc|jr|sr|inc|vol|e\.g|i\.e|u\.s|u\.k|[a-z])\.$/i;
/** Sentence openers where a speaker usually moves to a new point. */
const TURN = /^(so|okay|ok|alright|all right|anyway|now|well|right|next|first(ly)?|second(ly)?|finally|let's|let me|here's the thing|the (first|second|next|other|last|big) (thing|point|question))\b/i;

const endsSentence = (s) => TERMINAL.test(s) && !ABBREV.test(s.replace(/["'”’)\]]+$/, ''));

function splitRunOn(text) {
  if (text.length <= RUN_ON_MAX) return [text];
  const pieces = [];
  let rest = text;
  while (rest.length > RUN_ON_MAX) {
    const window = rest.slice(0, RUN_ON_PIECE + 200);
    let cut = window.lastIndexOf(', ');
    if (cut < RUN_ON_PIECE / 2) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = RUN_ON_PIECE;
    pieces.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * Whisper segments → sentences, each carrying the silence before it and when
 * it starts and ends in the audio (seconds; null when the provider gave no
 * timestamps). Segment boundaries fall mid-sentence as often as not, so a
 * sentence is stitched back together across them, and only a pause that opens
 * a sentence counts — a breath in the middle of one is not a paragraph break.
 * A sentence that starts partway into a segment gets a time interpolated by
 * character position: Whisper doesn't time sentences, and this is close enough
 * for a player to land at the right paragraph.
 */
function segmentsToSentences(segments) {
  const out = [];
  let pending = null;
  let lastEnd = null;
  for (const seg of segments || []) {
    const text = String(seg.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const timed = typeof seg.start === 'number' && typeof seg.end === 'number';
    const gap = lastEnd != null && typeof seg.start === 'number' ? Math.max(0, seg.start - lastEnd) : 0;
    if (typeof seg.end === 'number') lastEnd = seg.end;
    const at = (chars) => (timed ? seg.start + (seg.end - seg.start) * (chars / text.length) : null);
    const pieces = text.match(/[^.!?…]*[.!?…]+["'”’)\]]*\s*|[^.!?…]+$/g) || [text];
    let offset = 0;
    pieces.forEach((raw, i) => {
      const lead = raw.length - raw.trimStart().length;
      const piece = raw.trim();
      const from = offset + lead;
      offset += raw.length;
      if (!piece) return;
      if (pending) pending.text += ' ' + piece;
      else pending = { text: piece, pause: i === 0 ? gap : 0, start: at(from) };
      pending.end = at(Math.min(text.length, from + piece.length));
      if (endsSentence(pending.text)) { out.push(pending); pending = null; }
    });
  }
  if (pending) out.push(pending);
  // Run-ons become several pieces; only the first keeps the pause before it,
  // and the rest are timed by where they fall in the sentence.
  return out.flatMap((s) => {
    const pieces = splitRunOn(s.text);
    let chars = 0;
    return pieces.map((text, i) => {
      const start = s.start == null || s.end == null ? s.start
        : s.start + (s.end - s.start) * (chars / s.text.length);
      chars += text.length + 1;
      return { text, pause: i === 0 ? s.pause : 0, start };
    });
  });
}

/**
 * Group sentences into paragraphs the way a transcript editor would: a real
 * silence, an answer after a question, or a speaker turning to a new point
 * starts one, and a paragraph never runs past PARA_MAX. Every break falls
 * between sentences. Each paragraph starts when its first sentence does.
 */
function sentencesToParagraphs(sentences) {
  const paras = [];
  let cur = null;
  let prev = '';
  for (const s of sentences) {
    if (cur) {
      const len = cur.text.length;
      const brk = s.pause >= 2
        || (s.pause >= 0.8 && len >= 200)
        || (s.pause >= 0.3 && len >= 250 && /\?["'”’)\]]*$/.test(prev))
        || (len >= 450 && TURN.test(s.text))
        || len + 1 + s.text.length > PARA_MAX;
      if (brk) { paras.push(cur); cur = null; }
    }
    if (cur) cur.text += ` ${s.text}`;
    else cur = { text: s.text, start: s.start ?? null };
    prev = s.text;
  }
  if (cur) paras.push(cur);
  return paras;
}

/** Paragraphs as { text, start } — start in seconds, null if untimed. */
const segmentsToTimedParagraphs = (segments) => sentencesToParagraphs(segmentsToSentences(segments));

const segmentsToParagraphs = (segments) => segmentsToTimedParagraphs(segments).map((p) => p.text);

/**
 * Group sentences into paragraphs at chosen breaks: [starts] holds the indices
 * of sentences that open one. PARA_MAX still holds, so a break the chooser
 * missed can't leave a wall of text. Each paragraph remembers its first
 * sentence, which is how ad spans find their paragraphs.
 */
function sentencesToParagraphsAt(sentences, starts) {
  const paras = [];
  let cur = null;
  sentences.forEach((s, i) => {
    // Whisper's leftovers around music (".", "...") are no paragraph of their own.
    const bare = !/[\p{L}\p{N}]/u.test(s.text);
    if (cur && !bare && (starts.has(i) || cur.text.length + 1 + s.text.length > PARA_MAX)) {
      paras.push(cur);
      cur = null;
    }
    if (cur) cur.text += ` ${s.text}`;
    else cur = { text: s.text, start: s.start ?? null, first: i };
  });
  if (cur) paras.push(cur);
  return paras;
}

/** No podcast runs an ad shorter than this; anything shorter that was flagged
 *  is the model mistaking a mention for a pitch, and skipping it would cut
 *  the show itself. */
const MIN_AD_S = 30;
/** Except at the very top: nothing of the show comes before a pre-roll, so
 *  there is nothing to cut, and the one-line underwriting reads public radio
 *  opens with ("This episode's sponsor is…") run 15 seconds or so. */
const MIN_PREROLL_S = 10;
/** Two ads with less than this between them are one break (the "and now a
 *  word from…" between two sponsors), so they are judged as one length. */
const AD_JOIN_GAP_S = 5;

/**
 * Ad spans as sentence ranges plus where they sit in the audio. An ad runs
 * from its first sentence's start to the start of whatever follows it — the
 * jingle or silence after the last word is part of the break — or to the end
 * of the episode. One at the very top starts at 0, taking the intro sting with
 * it, and needs only MIN_PREROLL_S to count. Spans that touch are joined
 * before the length rule is applied, so a break made of two short spots is
 * kept whole. Untimed transcripts get none:
 * there is nothing to skip by.
 */
function adSpans(sentences, ads, durationS) {
  const startOf = (i) => (i === 0 ? 0 : sentences[i].start);
  const endOf = (last) => (last + 1 < sentences.length ? sentences[last + 1].start : durationS);
  const merged = [];
  for (const a of [...ads].sort((x, y) => x.first - y.first)) {
    const prev = merged[merged.length - 1];
    const gap = prev && startOf(a.first) != null && endOf(prev.last) != null
      ? startOf(a.first) - endOf(prev.last) : Infinity;
    if (prev && (a.first <= prev.last + 1 || gap < AD_JOIN_GAP_S)) {
      prev.last = Math.max(prev.last, a.last);
      if (a.what && !prev.what.includes(a.what)) prev.what += `; ${a.what}`;
    } else {
      merged.push({ first: a.first, last: a.last, what: a.what || '' });
    }
  }
  return merged
    .map((a) => ({ ...a, startS: startOf(a.first), endS: endOf(a.last) }))
    .filter((a) => typeof a.startS === 'number' && typeof a.endS === 'number'
      && a.endS - a.startS >= (a.first === 0 ? MIN_PREROLL_S : MIN_AD_S));
}

/**
 * Sentences → paragraphs, plus the ads among them. The model chooses the
 * breaks (speaker changes, new points) and finds the ads; without it, breaks
 * fall on pauses as before and nothing is marked. Every ad begins and ends on
 * a paragraph boundary, so a paragraph is all ad or none, and each ad
 * paragraph carries adEnd: where the break is over, which is where the app
 * jumps to.
 */
async function structureSentences(sentences, durationS) {
  const s = await require('./llm').structureTranscript(sentences);
  if (!s) return { paras: sentencesToParagraphs(sentences), ads: [] };
  const ads = adSpans(sentences, s.ads, durationS);
  for (const a of ads) {
    s.starts.add(a.first);
    if (a.last + 1 < sentences.length) s.starts.add(a.last + 1);
  }
  const paras = sentencesToParagraphsAt(sentences, s.starts);
  for (const p of paras) {
    const ad = ads.find((a) => p.first >= a.first && p.first <= a.last);
    if (ad) p.adEnd = ad.endS;
  }
  return { paras, ads };
}

/**
 * Transcript paragraphs → article HTML. Each timed paragraph carries its start
 * in the audio as data-t (seconds), which is how the app plays the episode in
 * step with the text. An attribute rather than a side table: skip rules delete
 * paragraphs from the stored HTML, and the survivors keep their own times.
 *
 * Ad paragraphs also carry data-ad-end, the end of their whole break, for the
 * same reason — any one survivor is enough to skip the break by — and
 * data-dur, the length of the audio the times were taken from, so a player
 * holding a different cut of the episode (hosts stitch ads per download) can
 * tell that the times are not its own.
 */
function paragraphsToHtml(paras, durationS) {
  const dur = typeof durationS === 'number' ? ` data-dur="${durationS.toFixed(2)}"` : '';
  return paras.map((p) => {
    if (p.start == null) return `<p>${escapeText(p.text)}</p>`;
    const ad = typeof p.adEnd === 'number' ? ` data-ad-end="${p.adEnd.toFixed(2)}"${dur}` : '';
    return `<p data-t="${Math.max(0, p.start).toFixed(2)}"${ad}>${escapeText(p.text)}</p>`;
  }).join('\n');
}

const unescapeText = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Sentences back out of a stored transcript, for re-structuring one whose
 * audio is long gone. Only paragraph starts survive, so each sentence is timed
 * by where its text falls between its paragraph's start and the next one's —
 * within a few seconds, which is close enough for a paragraph break and for
 * an ad that runs half a minute or more. The last paragraph's end comes from
 * [durationS], or failing that from the transcript's own pace. Null unless
 * every paragraph is timed.
 */
function sentencesFromTranscriptHtml(html, durationS) {
  const paras = [...String(html || '').matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)].map((m) => ({
    start: parseFloat((m[1].match(/data-t="([\d.]+)"/) || [])[1]),
    text: unescapeText(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(),
  })).filter((p) => p.text);
  if (!paras.length || paras.some((p) => Number.isNaN(p.start))) return null;
  const last = paras[paras.length - 1];
  const before = paras.slice(0, -1).reduce((n, p) => n + p.text.length, 0);
  const span = last.start - paras[0].start;
  const pace = before > 0 && span > 0 ? before / span : 15; // chars per second
  const end = typeof durationS === 'number' && durationS > last.start
    ? durationS : last.start + last.text.length / pace;
  const out = [];
  paras.forEach((p, i) => {
    const next = i + 1 < paras.length ? paras[i + 1].start : end;
    const pieces = p.text.match(/[^.!?…]*[.!?…]+["'”’)\]]*\s*|[^.!?…]+$/g) || [p.text];
    let chars = 0;
    let pending = null; // pieces stitched back across "L. L. Bean" / "Dr."
    for (const raw of pieces) {
      const text = raw.trim();
      if (text) {
        if (pending) pending.text += ` ${text}`;
        else pending = { text, pause: 0, start: p.start + (next - p.start) * (chars / p.text.length) };
        if (endsSentence(pending.text)) { out.push(pending); pending = null; }
      }
      chars += raw.length;
    }
    if (pending) out.push(pending);
  });
  return { sentences: out, durationS: end };
}

/**
 * Re-paragraph a stored transcript and find its ads ("Fix parsing" on an
 * episode). The words are left exactly as they are — only where paragraphs
 * break, and which are ads, changes — so highlights still find their text.
 * Null when the transcript has no times to work from or the model is off.
 */
async function restructureTranscriptHtml(html, durationS) {
  const parsed = sentencesFromTranscriptHtml(html, durationS);
  if (!parsed || !require('./llm').enabled()) return null;
  const { paras, ads } = await structureSentences(parsed.sentences, parsed.durationS);
  return {
    html: paragraphsToHtml(paras, typeof durationS === 'number' ? durationS : null),
    textContent: paras.map((p) => p.text).join(' '),
    ads,
  };
}

/** Fallback when the provider returns plain text without segments: the same
 *  grouping, just without pauses to go on. */
const textToParagraphs = (text) => segmentsToParagraphs([{ text }]);

/**
 * Transcribe an uploaded audio file and shape it like the other importers:
 * returns { html, textContent, durationS }. Throws on API failure or silence.
 */
async function transcribeToArticle(buf, filename) {
  const c = cfg();
  if (!c.key) throw new Error('transcription is not configured');
  const audio = await transcodeForStt(buf);
  const form = new FormData();
  form.append('model', c.model);
  form.append('response_format', 'verbose_json'); // segments carry the timestamps paragraphing needs
  form.append('file',
    new Blob([audio], { type: audio === buf ? 'application/octet-stream' : 'audio/ogg' }),
    audio === buf ? (filename || 'audio.mp3') : 'audio.ogg');
  const resp = await fetch(c.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.key}` },
    body: form,
  });
  if (!resp.ok) {
    throw new Error(`transcription api ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = await resp.json();
  const durationS = typeof data.duration === 'number' ? data.duration : null;
  const sentences = segmentsToSentences(Array.isArray(data.segments) && data.segments.length
    ? data.segments : [{ text: data.text }]);
  if (!sentences.length) throw new Error('no speech found in the audio');
  const { paras, ads } = await structureSentences(sentences, durationS);
  return {
    html: paragraphsToHtml(paras, durationS),
    textContent: paras.map((p) => p.text).join(' '),
    durationS,
    ads,
  };
}

module.exports = {
  enabled, transcribeToArticle, probeTags, extractCover, audioMeta, PLACEHOLDER_TITLE,
  segmentsToParagraphs, segmentsToTimedParagraphs, paragraphsToHtml, textToParagraphs, PARA_MAX,
  sentencesToParagraphsAt, adSpans, sentencesFromTranscriptHtml, restructureTranscriptHtml, MIN_AD_S,
};

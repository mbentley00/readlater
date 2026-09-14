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
 * Whisper segments → sentences, each carrying the silence before it. Segment
 * boundaries fall mid-sentence as often as not, so a sentence is stitched back
 * together across them, and only a pause that opens a sentence counts — a
 * breath in the middle of one is not a paragraph break.
 */
function segmentsToSentences(segments) {
  const out = [];
  let pending = null;
  let lastEnd = null;
  for (const seg of segments || []) {
    const text = String(seg.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const gap = lastEnd != null && typeof seg.start === 'number' ? Math.max(0, seg.start - lastEnd) : 0;
    if (typeof seg.end === 'number') lastEnd = seg.end;
    const pieces = text.match(/[^.!?…]*[.!?…]+["'”’)\]]*\s*|[^.!?…]+$/g) || [text];
    pieces.forEach((raw, i) => {
      const piece = raw.trim();
      if (!piece) return;
      if (pending) pending.text += ' ' + piece;
      else pending = { text: piece, pause: i === 0 ? gap : 0 };
      if (endsSentence(pending.text)) { out.push(pending); pending = null; }
    });
  }
  if (pending) out.push(pending);
  // Run-ons become several pieces; only the first keeps the pause before it.
  return out.flatMap((s) => splitRunOn(s.text).map((text, i) => ({ text, pause: i === 0 ? s.pause : 0 })));
}

/**
 * Group sentences into paragraphs the way a transcript editor would: a real
 * silence, an answer after a question, or a speaker turning to a new point
 * starts one, and a paragraph never runs past PARA_MAX. Every break falls
 * between sentences.
 */
function sentencesToParagraphs(sentences) {
  const paras = [];
  let cur = '';
  let prev = '';
  for (const s of sentences) {
    if (cur) {
      const len = cur.length;
      const brk = s.pause >= 2
        || (s.pause >= 0.8 && len >= 200)
        || (s.pause >= 0.3 && len >= 250 && /\?["'”’)\]]*$/.test(prev))
        || (len >= 450 && TURN.test(s.text))
        || len + 1 + s.text.length > PARA_MAX;
      if (brk) { paras.push(cur); cur = ''; }
    }
    cur = cur ? `${cur} ${s.text}` : s.text;
    prev = s.text;
  }
  if (cur) paras.push(cur);
  return paras;
}

const segmentsToParagraphs = (segments) => sentencesToParagraphs(segmentsToSentences(segments));

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
  const paras = Array.isArray(data.segments) && data.segments.length
    ? segmentsToParagraphs(data.segments)
    : textToParagraphs(data.text);
  if (!paras.length) throw new Error('no speech found in the audio');
  return {
    html: paras.map((p) => `<p>${escapeText(p)}</p>`).join('\n'),
    textContent: paras.join(' '),
    durationS: typeof data.duration === 'number' ? data.duration : null,
  };
}

module.exports = {
  enabled, transcribeToArticle, probeTags, audioMeta, PLACEHOLDER_TITLE,
  segmentsToParagraphs, textToParagraphs, PARA_MAX,
};

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
// No dependencies: fetch/FormData/Blob are Node globals, ffmpeg is already in
// the image for TTS encoding.

const DEFAULT_URL = 'https://api.deepinfra.com/v1/openai/audio/transcriptions';

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

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Group Whisper segments into readable paragraphs. A silence gap between
 *  segments is where speakers or topics change, so a gap after a finished
 *  sentence starts a new paragraph; a hard length cap keeps a monologue from
 *  becoming one wall of text. */
function segmentsToParagraphs(segments) {
  const paras = [];
  let cur = '', lastEnd = null;
  for (const seg of segments || []) {
    const text = String(seg.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const gap = lastEnd != null && typeof seg.start === 'number' ? seg.start - lastEnd : 0;
    const sentenceEnd = /[.!?…]["')\]]?$/.test(cur);
    if (cur && ((gap > 1.5 && sentenceEnd) || (cur.length > 700 && sentenceEnd) || cur.length > 1600)) {
      paras.push(cur);
      cur = '';
    }
    cur = cur ? cur + ' ' + text : text;
    if (typeof seg.end === 'number') lastEnd = seg.end;
  }
  if (cur) paras.push(cur);
  return paras;
}

/** Fallback when the provider returns plain text without segments: group
 *  sentences into ~600-char paragraphs. */
function textToParagraphs(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…]+[.!?…]*["')\]]?\s*/g) || [clean];
  const paras = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length > 600) { paras.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) paras.push(cur.trim());
  return paras;
}

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

module.exports = { enabled, transcribeToArticle };

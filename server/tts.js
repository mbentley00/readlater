'use strict';

// Server-side text-to-speech: synthesize an article to a single WAV using a
// Kokoro (or any OpenAI-compatible /audio/speech) endpoint, with per-paragraph
// time offsets so the app can keep paragraph-level position/resume/highlight.
//
// Configuration (fly secrets / env):
//   TTS_API_KEY   required to enable the feature
//   TTS_API_URL   default https://api.deepinfra.com/v1/openai/audio/speech
//   TTS_MODEL     default hexgrad/Kokoro-82M
//   TTS_VOICE     default af_bella
//   TTS_SAMPLE_RATE default 24000 (Kokoro's native rate)

const DEFAULT_URL = 'https://api.deepinfra.com/v1/openai/audio/speech';
const MAX_CHUNK_CHARS = 1800; // keep each API call within limits

const cfg = () => ({
  url: process.env.TTS_API_URL || DEFAULT_URL,
  key: process.env.TTS_API_KEY || '',
  model: process.env.TTS_MODEL || 'hexgrad/Kokoro-82M',
  voice: process.env.TTS_VOICE || 'af_bella',
  sampleRate: parseInt(process.env.TTS_SAMPLE_RATE || '24000', 10),
});

const enabled = () => !!cfg().key;

// ---- article → ordered paragraph strings ------------------------------------

const decodeEntities = (s) => String(s)
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));

/** Extract speakable paragraphs from article HTML in document order. Mirrors
 *  the kinds of blocks the reader speaks (paragraphs, headings, quotes, list
 *  items); images and empty blocks are skipped. */
function paragraphsOf(article) {
  const html = String(article.html || '');
  if (!html) {
    // fall back to blank-line-separated plain text
    return String(article.textContent || '')
      .split(/\n\s*\n+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }
  // drop non-content blocks entirely
  const cleaned = html
    .replace(/<(script|style|head|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const out = [];
  const re = /<(p|h[1-6]|blockquote|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (text) out.push(text);
  }
  if (!out.length) {
    const text = decodeEntities(cleaned.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (text) out.push(text);
  }
  return out;
}

/** Split a long paragraph into <=MAX_CHUNK_CHARS pieces at sentence bounds. */
function chunkText(text) {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const sentences = text.match(/[^.!?]+[.!?]+[\s]*|[^.!?]+$/g) || [text];
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length > MAX_CHUNK_CHARS) { chunks.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

// ---- WAV helpers ------------------------------------------------------------

/** Return the PCM data (Buffer) from a WAV file buffer, plus its sample rate. */
function pcmOf(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('not a WAV response');
  }
  let sampleRate = 24000;
  let off = 12;
  let data = null;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === 'fmt ') sampleRate = wav.readUInt32LE(off + 12);
    else if (id === 'data') { data = wav.slice(off + 8, off + 8 + size); break; }
    off += 8 + size + (size & 1);
  }
  if (!data) throw new Error('WAV data chunk not found');
  return { pcm: data, sampleRate };
}

function wavHeader(pcmLen, sampleRate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcmLen, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); // byte rate (mono 16-bit)
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcmLen, 40);
  return h;
}

// ---- synthesis --------------------------------------------------------------

async function synthChunk(text) {
  const c = cfg();
  const resp = await fetch(c.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: c.model, voice: c.voice, input: text, response_format: 'wav' }),
  });
  if (!resp.ok) throw new Error(`tts api ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * Synthesize a whole article. Returns { wav, sampleRate, durationMs,
 * paragraphOffsetsMs } where paragraphOffsetsMs[i] is the start time of
 * paragraph i (paragraphOffsetsMs.length === number of spoken paragraphs).
 */
async function synthesizeArticle(article) {
  const paragraphs = paragraphsOf(article);
  if (!paragraphs.length) throw new Error('no speakable text');
  const c = cfg();
  const pcmParts = [];
  const paragraphOffsetsMs = [];
  let totalBytes = 0;
  let sampleRate = c.sampleRate;
  const bytesToMs = (bytes) => Math.round((bytes / 2) / sampleRate * 1000); // mono 16-bit

  for (const para of paragraphs) {
    paragraphOffsetsMs.push(bytesToMs(totalBytes));
    for (const chunk of chunkText(para)) {
      const wav = await synthChunk(chunk);
      const { pcm, sampleRate: sr } = pcmOf(wav);
      sampleRate = sr;
      pcmParts.push(pcm);
      totalBytes += pcm.length;
    }
  }
  const pcm = Buffer.concat(pcmParts, totalBytes);
  const wav = Buffer.concat([wavHeader(pcm.length, sampleRate), pcm]);
  return {
    wav,
    sampleRate,
    durationMs: bytesToMs(totalBytes),
    paragraphOffsetsMs,
    voice: c.voice,
  };
}

module.exports = { enabled, paragraphsOf, synthesizeArticle, cfg };

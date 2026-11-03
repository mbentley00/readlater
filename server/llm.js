/**
 * LLM article-extraction rescue. When the extension flags a save as badly
 * parsed (it sends the stripped page as `fallbackHtml`), we ask a cheap
 * model — Claude Haiku 4.5 — to pull the article body out of the raw HTML.
 *
 * Enabled when ANTHROPIC_API_KEY is set (ANTHROPIC_BASE_URL is honored by
 * the SDK, which the test suite uses to point at a mock). Costs roughly
 * $0.02–0.05 per rescued article at Haiku pricing ($1/M input tokens).
 */
'use strict';

const MODEL = 'claude-haiku-4-5';
const MAX_INPUT_CHARS = 350000; // ~90k tokens, well inside Haiku's 200k window

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic(); // reads ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
  }
  return client;
}

const SYSTEM = `You extract the main article from raw web page HTML.
Return ONLY the article body as clean semantic HTML using <p>, <h2>, <h3>, <blockquote>, <ul>/<ol>/<li>, <pre> and <img> tags (keep original image src URLs).
Preserve the complete article text word for word — do not summarize, shorten, translate, or add commentary.
Exclude navigation, ads, related-article lists, comments, newsletter signups, and other boilerplate.
If the page contains no article at all, respond with exactly: NONE`;

/**
 * Returns {html, textContent} or null (disabled / no article found / error —
 * callers keep whatever extraction they already have).
 */
/** When a user reparses a mis-parsed article, they say what was wrong; turn
 *  that into a concrete instruction so the model corrects that failure mode. */
function hintInstruction(hint) {
  switch (hint) {
    case 'too-short':
      return '\n\nThe previous extraction was TOO SHORT — it dropped real article '
        + 'text. Be thorough: include the COMPLETE body, every paragraph, and do '
        + 'not stop early.';
    case 'too-long':
      return '\n\nThe previous extraction was TOO LONG — it kept boilerplate. Be '
        + 'stricter: return ONLY the article body, excluding navigation, ads, '
        + 'related links, comments, newsletter chrome, headers and footers.';
    default:
      return '';
  }
}

async function extractArticle({ url, title, pageHtml, hint }) {
  const c = getClient();
  if (!c) return null;
  try {
    const response = await c.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `URL: ${url}\nTitle hint: ${title}${hintInstruction(hint)}\n\nPage HTML:\n${String(pageHtml).slice(0, MAX_INPUT_CHARS)}`,
      }],
    });
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text || text === 'NONE' || text.length < 400) return null;
    const textContent = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (textContent.length < 300) return null;
    return { html: text, textContent };
  } catch (e) {
    console.error(`LLM extraction failed for ${url}: ${e.message}`);
    return null;
  }
}

const TITLE_SYSTEM = `You name podcast episodes. Given the opening of an episode's transcript, reply with a concise, specific title (3 to 10 words) saying what the episode is about.
Reply with the title only: no quotes, no trailing period, no "Episode" prefix, and no show name unless the show itself is the subject.`;

/** A title for an episode that arrived with no usable name, from the start of
 *  its transcript. Null when disabled, on error, or when the reply isn't a
 *  plausible one-line title — the caller keeps its placeholder. */
async function titleForTranscript(text) {
  const c = getClient();
  if (!c || !text) return null;
  try {
    const response = await c.messages.create({
      model: MODEL,
      max_tokens: 60,
      system: TITLE_SYSTEM,
      messages: [{ role: 'user', content: String(text).slice(0, 12000) }],
    });
    const title = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
      .replace(/^["'“‘]+|["'”’.]+$/g, '')
      .trim();
    if (title.length < 3 || title.length > 120 || /[\n<>]/.test(title)) return null;
    return title;
  } catch (e) {
    console.error(`LLM episode title failed: ${e.message}`);
    return null;
  }
}

const STRUCTURE_SYSTEM = `You edit machine transcripts of podcast episodes. You get the episode as numbered sentences, each with its start time. You do two jobs.

1. PARAGRAPHS. Choose where paragraphs begin, the way a careful transcript editor would. Speakers are not labelled, so you must work out from the words alone who is talking. The most important rule: every change of speaker starts a new paragraph, however short the turn. Signs of a change:
- a question, then its answer ("Three beers each?" / "Each, each, each.");
- a switch between the host's scripted narration (third person, past tense, polished: "Dawn grew up in a suburb of Hartford") and a recorded interviewee (first person, conversational: "My mother was a homemaker. You know, I...");
- self-introductions ("I'm a professor at…", "This is producer Justin Kramer"), and replies like "Yeah.", "Right.", "Okay.", "Sure." that answer the line before;
- a narrator's line that introduces a clip ("Leslie grew up in Providence.") followed by the clip itself.
Also start one when the same speaker moves to a new point, scene or topic. Keep paragraphs readable: usually 2 to 5 sentences, never more than 8.

2. ADS. Find the advertising: sponsor reads (host-read or produced), ad breaks, promos for other shows, and pitches to buy or subscribe to something (including the show's own paid membership). Give each break as the first and last sentence of the span. A break often holds several spots back to back: the span runs from the first spot through the last, up to where the show itself resumes — include the lead-in ("this episode is brought to you by", "this message comes from") and stop before the show's own words return. A spot need not announce itself: copy that sells a product or service (brand names, offers, web addresses, "terms apply") is an ad wherever it sits, including the very start of the episode before the show's own opening. After the closing credits, spots usually run back to back to the end of the episode — follow them all the way down. Ads run 30 seconds or more, except a short sponsor line at the very start ("This episode's sponsor is…"), which counts too; never mark a passing mention of a product, the show's own intro or credits, or a teaser for what comes after the break. When unsure, it is not an ad.

Use the sentence numbers exactly as given. Report through the transcript_structure tool.`;

const STRUCTURE_TOOL = {
  name: 'transcript_structure',
  description: 'Paragraph starts and ad spans for the transcript.',
  input_schema: {
    type: 'object',
    properties: {
      paragraph_starts: {
        type: 'array', items: { type: 'integer' },
        description: 'Sentence numbers that begin a paragraph, ascending.',
      },
      ads: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            first: { type: 'integer', description: 'First sentence of the ad span.' },
            last: { type: 'integer', description: 'Last sentence of the ad span.' },
            what: { type: 'string', description: 'A few words on what is advertised.' },
          },
          required: ['first', 'last'],
        },
      },
    },
    required: ['paragraph_starts', 'ads'],
  },
};

/** Sentences per request. Given a whole hour (~800 sentences) at once the
 *  model gets lazy and breaks only every few hundred words; in pieces this
 *  size it follows each change of speaker. The pieces run in parallel, and an
 *  ad break straddling a seam is rejoined downstream. */
const STRUCTURE_CHUNK = 200;

const mmss = (s) => (s == null ? '--:--'
  : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

async function structureChunk(c, sentences, offset) {
  const lines = sentences.map((s, i) => `[${offset + i}] (${mmss(s.start)}) ${s.text}`).join('\n');
  const response = await c.messages.create({
    model: MODEL,
    max_tokens: 8000,
    temperature: 0, // the same episode should come out the same way twice
    system: STRUCTURE_SYSTEM,
    tools: [STRUCTURE_TOOL],
    tool_choice: { type: 'tool', name: STRUCTURE_TOOL.name },
    messages: [{ role: 'user', content: lines }],
  });
  const use = response.content.find((b) => b.type === 'tool_use' && b.name === STRUCTURE_TOOL.name);
  if (!use || !Array.isArray(use.input?.paragraph_starts)) return null;
  const inRange = (n) => Number.isInteger(n) && n >= offset && n < offset + sentences.length;
  return {
    starts: use.input.paragraph_starts.filter(inRange),
    ads: (Array.isArray(use.input.ads) ? use.input.ads : [])
      .filter((a) => inRange(a?.first) && inRange(a?.last) && a.last >= a.first)
      .map((a) => ({ first: a.first, last: a.last, what: String(a.what || '').slice(0, 100) })),
  };
}

/**
 * Paragraph breaks and ad spans for a transcript, from the model. [sentences]
 * are { text, start } in order. Returns { starts: Set of sentence indices that
 * begin a paragraph, ads: [{ first, last, what }] } with every index valid, or
 * null when disabled or the model gave nothing usable — the caller then falls
 * back to breaking on pauses and marks no ads. A chunk that fails on its own
 * fails the whole thing: half an episode in one style and half in another
 * reads worse than either.
 */
async function structureTranscript(sentences) {
  const c = getClient();
  if (!c || !sentences?.length) return null;
  try {
    const jobs = [];
    for (let off = 0; off < sentences.length; off += STRUCTURE_CHUNK) {
      jobs.push(structureChunk(c, sentences.slice(off, off + STRUCTURE_CHUNK), off));
    }
    const parts = await Promise.all(jobs);
    if (parts.some((p) => !p)) return null;
    const starts = new Set([0]);
    parts.forEach((p, i) => { starts.add(i * STRUCTURE_CHUNK); p.starts.forEach((n) => starts.add(n)); });
    return { starts, ads: parts.flatMap((p) => p.ads) };
  } catch (e) {
    console.error(`LLM transcript structure failed: ${e.message}`);
    return null;
  }
}

const enabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

module.exports = { extractArticle, titleForTranscript, structureTranscript, enabled };

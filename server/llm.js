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
async function extractArticle({ url, title, pageHtml }) {
  const c = getClient();
  if (!c) return null;
  try {
    const response = await c.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `URL: ${url}\nTitle hint: ${title}\n\nPage HTML:\n${String(pageHtml).slice(0, MAX_INPUT_CHARS)}`,
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

const enabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

module.exports = { extractArticle, enabled };

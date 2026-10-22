// Text-generation transport. Every server-side text call goes through
// chatCompletion(), which returns an OpenRouter-shaped response
// ({ choices: [{ message: { content } }], usage, error }) so the callers'
// fallback chains, usage tracking and A/B bookkeeping did not have to change.
//
// Claude models (`anthropic/...` slugs) go straight to the Anthropic API when
// ANTHROPIC_API_KEY is set. Everything else, and Claude too when that key is
// absent, still goes to OpenRouter. Image generation never comes through here:
// Anthropic has no image models, so lib/social/media.js and the image handler
// keep calling OpenRouter directly.
//
// Model slugs stay in OpenRouter form throughout (rules, A/B config and the
// pricing table in lib/usage.js are all keyed by them); only the request to
// Anthropic uses the native ID.
import Anthropic from '@anthropic-ai/sdk';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://vance-content-generator.vercel.app';

// OpenRouter slug -> Anthropic model ID. The general rule is "drop the
// prefix, dots become dashes" (anthropic/claude-sonnet-4.5 -> claude-sonnet-4-5),
// which holds for every Claude slug the UI offers today. Listed explicitly so an
// unknown slug is a visible miss rather than a guessed ID.
const ANTHROPIC_MODEL_IDS = {
  'anthropic/claude-sonnet-5':   'claude-sonnet-5',
  'anthropic/claude-sonnet-5.5': 'claude-sonnet-5-5',
  'anthropic/claude-sonnet-4.5': 'claude-sonnet-4-5',
  'anthropic/claude-opus-5':     'claude-opus-5',
  'anthropic/claude-opus-5.5':   'claude-opus-5-5',
  'anthropic/claude-opus-4.5':   'claude-opus-4-5',
  'anthropic/claude-haiku-4.5':  'claude-haiku-4-5',
  'anthropic/claude-haiku-5.5':  'claude-haiku-5-5',
};

export function anthropicModelId(slug) {
  return ANTHROPIC_MODEL_IDS[slug] || null;
}

// True when this call will be served by Anthropic directly.
export function usesAnthropicDirect(model) {
  return Boolean(process.env.ANTHROPIC_API_KEY) && anthropicModelId(model) !== null;
}

// Callers check one of these before starting; a run that can only reach Claude
// should not fail just because the OpenRouter key was removed, and vice versa.
export function hasTextProviderKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY);
}

/**
 * @param {object} req
 * @param {string} req.model        OpenRouter-style slug
 * @param {Array}  req.messages     [{ role, content }]
 * @param {number} [req.max_tokens]
 * @param {number} [req.temperature] OpenRouter only; Anthropic rejects sampling params
 * @param {string} [req.title]      X-Title header for OpenRouter
 * @param {Function} [req.fetchFn]  injectable fetch (tests)
 * @returns {Promise<object>} OpenRouter-shaped response body; never throws for API errors
 */
export async function chatCompletion({ model, messages, max_tokens, temperature, title = 'Vance Content Generator', fetchFn = fetch }) {
  if (usesAnthropicDirect(model)) {
    return callAnthropic({ model, messages, max_tokens, fetchFn });
  }
  if (!process.env.OPENROUTER_API_KEY) {
    // Without this the request goes out as "Bearer undefined" and the 401 reads
    // like a content failure. Non-Claude fallbacks still need OpenRouter.
    return { error: { code: 'no-key', message: `OPENROUTER_API_KEY is not set, so ${model} cannot be called` } };
  }
  const body = { model, messages };
  if (max_tokens) body.max_tokens = max_tokens;
  if (temperature !== undefined) body.temperature = temperature;
  const res = await fetchFn(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': APP_URL,
      'X-Title': title,
    },
    body: JSON.stringify(body),
  });
  // An upstream 502 can arrive as an HTML page; report it as an error body
  // rather than throwing, so the caller's fallback chain still sees a 5xx.
  try {
    return await res.json();
  } catch {
    return { error: { code: res.status, message: `OpenRouter returned a non-JSON ${res.status} response` } };
  }
}

async function callAnthropic({ model, messages, max_tokens, fetchFn }) {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    fetch: fetchFn,
    // The callers run their own fallback chain, so the SDK does not retry. The
    // timeout is per attempt; at 120 s one attempt plus one fallback still fits
    // inside the functions' 300 s maxDuration.
    maxRetries: 0,
    timeout: 120_000,
  });
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const turns = messages.filter(m => m.role !== 'system');
  try {
    const msg = await client.messages.create({
      model: anthropicModelId(model),
      max_tokens: max_tokens || 16000,
      ...(system ? { system } : {}),
      messages: turns,
    });
    const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    if (msg.stop_reason === 'refusal') {
      return { error: { code: 'refusal', message: `Claude declined the request (${msg.stop_details?.category || 'no category'})` } };
    }
    if (!text.trim()) {
      // Thinking can use the whole max_tokens budget and leave no text. Report it
      // as a 5xx so the caller's chain moves on to the next model.
      return { error: { code: 503, message: `Anthropic: ${model} returned no text (stop_reason ${msg.stop_reason})` } };
    }
    return {
      // 'length' is OpenRouter's name for a max_tokens stop.
      choices: [{ message: { role: 'assistant', content: text }, finish_reason: msg.stop_reason === 'max_tokens' ? 'length' : msg.stop_reason }],
      usage: {
        prompt_tokens: msg.usage.input_tokens,
        completion_tokens: msg.usage.output_tokens,
        total_tokens: msg.usage.input_tokens + msg.usage.output_tokens,
      },
      model,
      provider: 'anthropic',
    };
  } catch (err) {
    // Same shape OpenRouter uses for failures, so each caller's existing
    // "try the next model?" logic (numeric 429 / 5xx codes) applies unchanged.
    // Timeouts and dropped connections become 504 / 503 so they fall through too.
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      return { error: { code: 504, message: 'Anthropic: request timed out' } };
    }
    if (err instanceof Anthropic.APIError && err.status) {
      return { error: { code: err.status, message: `Anthropic: ${err.message}` } };
    }
    return { error: { code: 503, message: `Anthropic: ${err.message}` } };
  }
}

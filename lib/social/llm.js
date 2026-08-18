// lib/social/llm.js
//
// Shared OpenRouter caller for the social module. Lifted verbatim out of
// lib/social/handlers/generate.js when the carousel generator became a second
// caller — the A/B variant pick, the free→paid fallback chain and the usage
// accounting are all things the two must do identically, and duplicating them
// would have meant two places to keep the model list correct.
//
// The only change from the original is that `source` is now a parameter instead
// of the hard-coded string 'social-generate', so usage stats stay attributable
// per feature.

import { recordLlmUsage, recordLlmFailure } from '../usage.js';
import { pickModelForGeneration } from '../ab-test.js';

// Paid equivalents tried in order once the free tier rate-limits.
const PAID_FALLBACKS = [
  'google/gemma-3-27b-it',
  'google/gemma-3-12b-it',
  'meta-llama/llama-3.3-70b-instruct',
];

/**
 * Should we fall through to the next model in the chain, or fail outright?
 *
 * Rate limits were the original case. The second case was found in production on
 * 2026-07-27: OpenRouter withdraws a model's free tier and then answers
 * `:free` requests with a **404** — "This model is unavailable for free. The paid
 * version is available now - use this slug instead: google/gemma-3-27b-it" —
 * which is exactly the model already sitting next in the chain. Treating that as
 * fatal meant every social generation died on a fallback we were one step away
 * from taking. Model-availability 404s are a fall-through, not a failure.
 *
 * Deliberately narrow: a 404 only falls through when the message is about model
 * availability, so a genuinely bad model slug still surfaces as an error rather
 * than silently burning through the whole chain.
 */
function shouldTryNextModel(data) {
  const code = data.error?.code;
  const msg = (data.error?.message || '').toLowerCase();
  if (code === 429 || msg.includes('rate-limit') || msg.includes('rate limit')) return true;
  return (
    msg.includes('unavailable for free')
    || msg.includes('use this slug instead')
    || msg.includes('no endpoints found')
    || msg.includes('no allowed providers')
  );
}

/**
 * Call OpenRouter with the A/B-selected primary model, falling back through its
 * paid twin and then the generic paid chain on rate limits.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.source] - usage-tracking label (e.g. 'social-carousel')
 * @returns {Promise<string>} the model's text response, trimmed
 * @throws {Error} on a non-rate-limit failure, or if every model is rate-limited
 */
export async function callOpenRouter(prompt, { source = 'social-generate' } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  // Was 'google/gemma-3-27b-it:free' until 2026-08-18. That free tier is gone, so
  // every call 404'd and fell through to this exact paid twin — same model, one
  // wasted round-trip. Naming it directly changes nothing but the waste.
  const envDefault = process.env.DEFAULT_LLM_MODEL || 'google/gemma-3-27b-it';
  // A/B harness: override primary with the picked variant when the test is on.
  const ab = await pickModelForGeneration(envDefault);
  const primaryModel = ab.model;
  const pickedVariant = ab.variant;

  const chain = [primaryModel];
  if (primaryModel.endsWith(':free')) chain.push(primaryModel.replace(/:free$/, ''));
  for (const m of PAID_FALLBACKS) { if (!chain.includes(m)) chain.push(m); }

  let lastError = null;
  for (const [idx, model] of chain.entries()) {
    const isPickedVariant = idx === 0;
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://vance-content-generator.vercel.app',
        'X-Title': 'Vance Content Generator',
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    const textOut = data.choices?.[0]?.message?.content;
    if (textOut) {
      if (data.usage) {
        recordLlmUsage({
          model, usage: data.usage, source,
          outcome: 'success',
          variant: isPickedVariant ? pickedVariant : null,
        }).catch(() => {});
      }
      return textOut.trim();
    }

    // First-attempt failure for the picked A/B variant — record it so the
    // variant's failure rate stays accurate.
    if (isPickedVariant && data?.error) {
      recordLlmFailure({
        model, source, variant: pickedVariant,
        failureReason: data.error?.message || data.error?.code,
      }).catch(() => {});
    }

    if (shouldTryNextModel(data)) {
      lastError = `${model}: ${data.error?.message || 'unavailable'}`;
      continue;
    }
    throw new Error(`LLM call failed: ${JSON.stringify(data).slice(0, 300)}`);
  }
  throw new Error(`All models in the fallback chain failed. Last: ${lastError}`);
}

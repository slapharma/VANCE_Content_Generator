import { recordLlmUsage, recordLlmFailure } from './usage.js';
import { pickModelForGeneration } from './ab-test.js';

// Three of the four entries here were retired slugs until 2026-08-18, so every
// revision burned a wasted 404 before landing on the paid Llama at position 2.
// Llama now leads: that is what this chain already resolved to in practice.
const REVISION_MODELS = [
  'meta-llama/llama-3.3-70b-instruct',
  'google/gemma-3-27b-it',
  'google/gemma-4-31b-it:free',
];
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

export async function callRevisionLLM(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured');
  const ab = await pickModelForGeneration(REVISION_MODELS[0]);
  const chain = [ab.model, ...REVISION_MODELS.filter(m => m !== ab.model)];
  const pickedVariant = ab.variant;

  let lastErr = 'no model attempted';
  for (const [idx, model] of chain.entries()) {
    const isPickedVariant = idx === 0;
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': APP_URL,
          'X-Title': 'Vance Content Revision',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
        }),
      });
      const data = await r.json();
      if (data.error) {
        if (isPickedVariant) {
          recordLlmFailure({
            model, source: 'ai-revise', variant: pickedVariant,
            failureReason: data.error?.message || data.error?.code,
          }).catch(() => {});
        }
        lastErr = `${model}: ${data.error.message || data.error}`;
        continue;
      }
      const text = data.choices?.[0]?.message?.content;
      if (text && text.trim()) {
        if (data.usage) {
          recordLlmUsage({
            model, usage: data.usage, source: 'ai-revise',
            outcome: 'success',
            variant: isPickedVariant ? pickedVariant : null,
          }).catch(() => {});
        }
        return { text: text.trim(), model };
      }
      if (isPickedVariant) {
        recordLlmFailure({
          model, source: 'ai-revise', variant: pickedVariant,
          failureReason: 'empty response',
        }).catch(() => {});
      }
      lastErr = `${model}: empty response`;
    } catch (err) {
      if (isPickedVariant) {
        recordLlmFailure({
          model, source: 'ai-revise', variant: pickedVariant,
          failureReason: err.message,
        }).catch(() => {});
      }
      lastErr = `${model}: ${err.message}`;
    }
  }
  throw new Error(`All revision models failed. Last: ${lastErr}`);
}

export function buildRevisionPrompt({ title, body, comments }) {
  const feedbackBlock = comments.map((c, i) => {
    const who = c.reviewerName || c.reviewerId || 'reviewer';
    return `Feedback ${i + 1} (from ${who}):\n${c.comment}`;
  }).join('\n\n');
  return `You are revising a published-quality medical/health article for Vance Medical Foods (vancemedicalfoods.com). The article was reviewed and the reviewer(s) requested specific changes. Your job is to rewrite the article so it addresses every piece of feedback below.

REVIEWER FEEDBACK TO ADDRESS:
${feedbackBlock}

ORIGINAL ARTICLE TITLE: ${title}

ORIGINAL ARTICLE BODY:
${body}

INSTRUCTIONS:
- Revise the article so it addresses every piece of feedback above.
- Keep the overall structure, length, and tone unless the feedback explicitly asks to change them.
- Preserve all medical accuracy, citations, study names, drug names, dose values, and statistical figures unless the feedback explicitly calls them out.
- Output ONLY the revised article in clean markdown format (first line "# Title", optional second line "# Subtitle" prefixed with "# ", then "##" section headers). NO preamble, NO commentary about what you changed, NO "Here is the revised article", NO wrapping in code fences.
- Do not insert phrases like "as requested by the reviewer" — incorporate the changes naturally.
- UK British English. Active voice where natural.`;
}

// scripts/check-model-fallback.mjs
// Guards the OpenRouter fallback predicate in lib/automation/handlers/run.js.
//
// Case 1 is the exact payload that killed the Industry News rule on 2026-08-18:
// OpenRouter withdrew the llama-3.3-70b free tier and answered with a 404 whose
// message names the paid slug already next in the chain. The predicate must fall
// through. Cases 4-5 keep the match narrow — a bad slug or a real auth failure
// must still be fatal rather than burning the whole chain.
import { shouldRetryWithNextModel } from '../lib/automation/handlers/run.js';

const cases = [
  ['free tier withdrawn (production 2026-08-18)', true, {
    error: { code: 404, message: 'This model is unavailable for free. The paid version is available now - use this slug instead: meta-llama/llama-3.3-70b-instruct' },
  }],
  ['model retired', true, { error: { code: 404, message: 'No endpoints found for meta-llama/llama-3.3-70b-instruct:free.' } }],
  ['rate limited', true, { error: { code: 429, message: 'Rate limit exceeded' } }],
  ['upstream 5xx', true, { error: { code: 502, message: 'Bad gateway' } }],
  ['bad model slug is fatal', false, { error: { code: 404, message: 'meta-llama/llama-3.3-70b-instrukt is not a valid model ID' } }],
  ['auth failure is fatal', false, { error: { code: 401, message: 'No auth credentials found' } }],
];

let failed = 0;
for (const [name, expected, payload] of cases) {
  const got = shouldRetryWithNextModel(payload);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — expected ${expected}, got ${got}`);
}
console.log(failed ? `\n${failed}/${cases.length} failed` : `\nall ${cases.length} passed`);
process.exit(failed ? 1 : 0);

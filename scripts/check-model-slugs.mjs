// scripts/check-model-slugs.mjs
//
// Every model slug this app can actually CALL, checked against OpenRouter's live
// catalogue. Model slugs rot silently: OpenRouter retires a model, or withdraws
// its free tier, and nothing fails until the day that model is reached. On
// 2026-08-18 an audit found seven dead slugs across four chains — one of them
// had been silently degrading every hero image prompt to a hardcoded fallback.
//
// Scope note: lib/usage.js is deliberately NOT scanned. Its price table keeps
// retired models on purpose so historical spend still costs correctly.
//
// Run: node scripts/check-model-slugs.mjs
import { readFileSync } from 'node:fs';

const FILES = [
  'lib/automation/handlers/run.js',
  'lib/revise.js',
  'lib/social/llm.js',
  'lib/social/media.js',
];

const res = await fetch('https://openrouter.ai/api/v1/models').catch(() => null);
if (!res?.ok) {
  console.error('SKIPPED: could not reach OpenRouter. This check did not run.');
  process.exit(2); // distinct from pass(0)/fail(1) so it is never silently green
}
const catalogue = (await res.json()).data ?? [];
const ids = new Set(catalogue.map(m => m.id));
// Vendor prefixes seen in the catalogue. Used to tell a model slug apart from a
// MIME type — 'anthropic/...' is a model, 'application/json' is not — without
// hand-maintaining an exclusion list that would drift.
const vendors = new Set(catalogue.map(m => m.id.split('/')[0]));

// A comment naming a retired slug (to explain why it was replaced) is
// documentation, not a call site, and must not trip this check. Only whole-line
// `//` comments are dropped, so a URL's `//` inside real code survives.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter(line => !/^\s*\/\//.test(line))
    .join('\n');
}

let dead = 0, checked = 0;
for (const file of FILES) {
  const src = stripComments(readFileSync(file, 'utf8'));
  const found = new Set();
  for (const [, slug] of src.matchAll(/'([a-z0-9-]+\/[a-zA-Z0-9._-]+(?::[a-z]+)?)'/g)) {
    if (vendors.has(slug.split('/')[0])) found.add(slug);
  }
  for (const slug of [...found].sort()) {
    checked++;
    const ok = ids.has(slug);
    if (!ok) dead++;
    console.log(`${ok ? 'LIVE' : 'DEAD'}  ${file}  ${slug}`);
  }
}

console.log(`\n${checked} slugs checked, ${dead} dead`);
if (dead) console.log('A dead slug costs a wasted round-trip at best, and silent quality loss at worst.');
process.exit(dead ? 1 : 0);

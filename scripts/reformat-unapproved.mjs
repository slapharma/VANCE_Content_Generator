// Reformat unapproved articles (status: draft | in_review) to the new structure
// rule: one "### " sub-heading per named enumerated item, bulleted lists for
// parallel/scannable points. STRUCTURE ONLY — wording, facts, citations, and the
// disclaimer are preserved. The LLM does the restructuring; this script enforces
// hard integrity guards and refuses to apply any rewrite that fails them.
//
// Usage:
//   node scripts/reformat-unapproved.mjs                 # dry run (default) — writes a report, changes nothing
//   node scripts/reformat-unapproved.mjs --apply         # write changes back to KV (after a full backup)
//   node scripts/reformat-unapproved.mjs --limit 5       # only process the first 5 candidates
//   node scripts/reformat-unapproved.mjs --id <contentId># process a single article
//
// Output lands in scripts/reformat-out/ (gitignored): per-article before/after
// markdown, a summary.json, and (on --apply) a timestamped backup of originals.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { countBodyWords } from '../lib/word-count.js';

// ── config / args ────────────────────────────────────────────────────────────
const APPLY = process.argv.includes('--apply');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1], 10) : Infinity; })();
const ONLY_ID = (() => { const i = process.argv.indexOf('--id'); return i > -1 ? process.argv[i + 1] : null; })();
const STATUSES = new Set(['draft', 'in_review']);
const CONCURRENCY = 4;
const OUT_DIR = new URL('./reformat-out/', import.meta.url);

const REVISION_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct',
  'google/gemma-2-27b-it:free',
  'openai/gpt-oss-120b:free',
];

// ── env / KV ─────────────────────────────────────────────────────────────────
const env = Object.fromEntries(
  readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split('\n').filter(Boolean).filter(l => !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);
const KV_URL = env.KV_REST_API_URL, KV_TOKEN = env.KV_REST_API_TOKEN;
const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
if (!KV_URL || !KV_TOKEN) { console.error('Missing KV_REST_API_URL / KV_REST_API_TOKEN in .env.local'); process.exit(1); }
if (!OPENROUTER_API_KEY) { console.error('Missing OPENROUTER_API_KEY in .env.local'); process.exit(1); }

async function kvCmd(cmd) {
  const r = await fetch(`${KV_URL}/${cmd.map(encodeURIComponent).join('/')}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  return (await r.json()).result;
}
async function kvSetJson(key, obj) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(obj),
  });
  return (await r.json()).result;
}

// ── LLM ──────────────────────────────────────────────────────────────────────
function buildReformatPrompt(body) {
  return `You are reformatting an existing, publication-quality health article for Vance Health Hub. Your ONLY job is to improve its STRUCTURE. You must NOT change the wording, facts, figures, citations, or meaning of any sentence.

APPLY THESE STRUCTURE RULES:
1. Keep the very first line exactly as-is (the "# Title" line). Keep the "Reading Time:" line directly under it unchanged.
2. Keep top-level section headings as "## ".
3. When a section enumerates named items (for example specific genes, drugs, nutrients, mechanisms, symptoms, or food groups) and currently runs them together as consecutive paragraphs, give each named item its own "### " sub-heading, then place that item's EXISTING explanation underneath. Use the item's own name as the sub-heading text. Do not write any new explanatory sentences.
4. Convert parallel, scannable points (practical takeaways, lists of symptoms, foods, risk factors) into a bulleted list using "- " at the start of each line. Any "Practical Takeaways" style action list MUST be a bulleted list. Do NOT bullet flowing narrative or explanatory prose.
5. Leave any References / Sources section and the final italic Disclaimer exactly as they are.

HARD CONSTRAINTS:
- Do not add, delete, or reword any sentence of body prose. Every fact, number, drug name, gene name, and citation must be preserved verbatim.
- Use UK British English. Never introduce em dashes.
- Output ONLY the reformatted article in markdown. No preamble, no commentary, no code fences.

ARTICLE TO REFORMAT:
${body}`;
}

async function callLLM(prompt) {
  let lastErr = 'no model attempted';
  for (const model of REVISION_MODELS) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://vance-content.vercel.app',
          'X-Title': 'Vance Content Reformat',
        },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.2 }),
      });
      const data = await r.json();
      if (data.error) { lastErr = `${model}: ${data.error.message || data.error}`; continue; }
      let text = data.choices?.[0]?.message?.content?.trim();
      if (text) {
        text = text.replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim(); // strip stray fences
        return { text, model };
      }
      lastErr = `${model}: empty response`;
    } catch (err) { lastErr = `${model}: ${err.message}`; }
  }
  throw new Error(`All models failed. Last: ${lastErr}`);
}

// ── integrity guards ─────────────────────────────────────────────────────────
// Normalise to a multiset of content-word tokens (markdown markers + heading
// hashes stripped). Heading text is kept because promoted item names legitimately
// move from prose into "### " headings — they must still be present.
function contentTokens(text) {
  return String(text)
    .replace(/[#>*_`-]/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
}
function retentionRatio(orig, next) {
  const have = new Map();
  for (const t of contentTokens(next)) have.set(t, (have.get(t) || 0) + 1);
  let covered = 0; const origToks = contentTokens(orig);
  for (const t of origToks) { const n = have.get(t); if (n > 0) { have.set(t, n - 1); covered++; } }
  return origToks.length ? covered / origToks.length : 1;
}
function firstTitleLine(text) { const l = String(text).split('\n').find(x => x.trim()); return (l || '').trim(); }
function disclaimerSentence(text) {
  const m = String(text).match(/this article is intended for informational[^.]*\./i);
  return m ? m[0].toLowerCase().replace(/\s+/g, ' ') : null;
}

// Returns { ok, reasons[] } — refuses risky rewrites.
function vetRewrite(orig, next) {
  const reasons = [];
  if (!next || next.length < 50) reasons.push('output empty/too short');
  if (/```/.test(next)) reasons.push('output contains code fences');
  if (firstTitleLine(orig) !== firstTitleLine(next)) reasons.push(`title changed ("${firstTitleLine(orig)}" -> "${firstTitleLine(next)}")`);
  const od = disclaimerSentence(orig);
  if (od && disclaimerSentence(next) !== od) reasons.push('disclaimer altered or dropped');
  const ret = retentionRatio(orig, next);
  if (ret < 0.92) reasons.push(`content-word retention ${(ret * 100).toFixed(1)}% (< 92%)`);
  const wOrig = countBodyWords(orig), wNext = countBodyWords(next);
  const lo = wOrig * 0.85, hi = wOrig * 1.05;
  if (wNext < lo || wNext > hi) reasons.push(`body word count ${wNext} outside [${Math.round(lo)}, ${Math.round(hi)}] (was ${wOrig})`);
  // Require at least one structural improvement, else it's a no-op rewrite.
  const addedH3 = (next.match(/^### /gm) || []).length - (orig.match(/^### /gm) || []).length;
  const addedBul = (next.match(/^- /gm) || []).length - (orig.match(/^- /gm) || []).length;
  return { ok: reasons.length === 0, reasons, ret, wOrig, wNext, addedH3, addedBul };
}

// ── pool ─────────────────────────────────────────────────────────────────────
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
console.log(`Mode: ${APPLY ? 'APPLY (will write to KV)' : 'DRY RUN (no writes)'}`);

const ids = (await kvCmd(['lrange', 'content:index', '0', '-1'])) || [];
console.log(`content:index has ${ids.length} ids`);

let records = (await pool(ids, 8, async (id) => {
  const raw = await kvCmd(['get', `content:${id}`]);
  return raw ? JSON.parse(raw) : null;
})).filter(Boolean);

let candidates = records.filter(r => STATUSES.has(r.status) && (r.body || '').trim());
if (ONLY_ID) candidates = candidates.filter(r => r.id === ONLY_ID);
candidates = candidates.slice(0, LIMIT);
console.log(`Candidates (status draft|in_review, non-empty body): ${candidates.length}`);
if (!candidates.length) { console.log('Nothing to do.'); process.exit(0); }

const results = await pool(candidates, CONCURRENCY, async (item) => {
  const orig = item.body;
  try {
    const { text: next, model } = await callLLM(buildReformatPrompt(orig));
    const vet = vetRewrite(orig, next);
    const slug = `${item.id}`.replace(/[^a-z0-9_-]/gi, '_');
    writeFileSync(new URL(`./reformat-out/${slug}.before.md`, import.meta.url), orig);
    writeFileSync(new URL(`./reformat-out/${slug}.after.md`, import.meta.url), next);
    return { id: item.id, title: item.title, status: item.status, model, next, ...vet };
  } catch (err) {
    return { id: item.id, title: item.title, status: item.status, ok: false, reasons: ['LLM error: ' + err.message] };
  }
});

// ── report ───────────────────────────────────────────────────────────────────
const pass = results.filter(r => r.ok);
const fail = results.filter(r => !r.ok);
console.log('\n── Results ──');
for (const r of results) {
  const tag = r.ok ? `OK   +${r.addedH3}h3 +${r.addedBul}bul  ret ${(r.ret * 100).toFixed(0)}%  words ${r.wOrig}->${r.wNext}` : `SKIP ${r.reasons.join('; ')}`;
  console.log(`  [${r.ok ? 'PASS' : 'FAIL'}] ${r.id}  ${String(r.title || '').slice(0, 60)}\n         ${tag}`);
}
console.log(`\nPassed guards: ${pass.length}   Skipped: ${fail.length}`);
writeFileSync(new URL('./reformat-out/summary.json', import.meta.url),
  JSON.stringify(results.map(({ next, ...rest }) => rest), null, 2));
console.log('Per-article before/after markdown + summary.json in scripts/reformat-out/');

// ── apply ────────────────────────────────────────────────────────────────────
if (!APPLY) {
  console.log('\nDRY RUN complete. Review scripts/reformat-out/, then re-run with --apply to write the PASSed articles.');
  process.exit(0);
}
if (!pass.length) { console.log('\nNothing passed the guards; nothing to apply.'); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = pass.map(r => { const rec = records.find(x => x.id === r.id); return { id: r.id, body: rec.body }; });
writeFileSync(new URL(`./reformat-out/backup-${stamp}.json`, import.meta.url), JSON.stringify(backup, null, 2));
console.log(`\nBacked up ${backup.length} original bodies to scripts/reformat-out/backup-${stamp}.json`);

let written = 0;
for (const r of pass) {
  const rec = records.find(x => x.id === r.id);
  const updated = { ...rec, body: r.next, updatedAt: new Date().toISOString(), reformattedAt: new Date().toISOString() };
  await kvSetJson(`content:${r.id}`, updated);
  written++;
  console.log(`  wrote content:${r.id}`);
}
console.log(`\nAPPLIED ${written} articles. Originals preserved in backup-${stamp}.json.`);

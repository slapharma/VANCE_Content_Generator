/**
 * scrub-prompt-instruction.mjs
 * Removes an unwanted instruction from every copy of a prompt saved in KV.
 *
 *   node scripts/scrub-prompt-instruction.mjs            — dry run (shows the plan)
 *   node scripts/scrub-prompt-instruction.mjs --apply    — write the changes
 *
 * Why this exists. A category prompt lives in THREE places that drift apart
 * (see docs/learnings-from-alpha.md):
 *
 *   1. the hardcoded constant, duplicated in index.html and
 *      lib/automation/handlers/run.js — edit those in the repo;
 *   2. the shared library at KV `vance:article-prompts`, which is what the
 *      Categories page and the generator actually show;
 *   3. a frozen snapshot copied onto each rule at save time
 *      (`automation:rule:<id>` → `.generation.prompt`), which run.js prefers
 *      over everything else.
 *
 * A repo edit fixes (1) only. This script fixes (2) and (3). Both are needed:
 * skip the library and the next rule created from a preset reintroduces the
 * instruction; skip the rules and every existing rule keeps its old copy.
 *
 * Credentials come from .env.local (KV_REST_API_URL / KV_REST_API_TOKEN).
 * Do NOT hardcode them — several older scripts in this directory embed the
 * live read-write token in tracked source, which is how it ended up in git
 * history.
 *
 * Safety properties, in case this gets adapted for the next scrub:
 *   • dry run by default; --apply is required to write;
 *   • every key read is backed up to a gitignored *-backup-*.json BEFORE any
 *     write, and --apply aborts if that backup can't be written;
 *   • edits are exact-substring, never regex, so a partial/fuzzy match cannot
 *     silently mangle a prompt somebody hand-edited;
 *   • a residual check re-scans the result for the instruction in any brand
 *     spelling, and reports loudly if one survives.
 *
 * Re-running is a no-op once the scrub has landed: the exact strings are gone,
 * so nothing matches and the plan comes back empty.
 *
 * ── The 2026-08-31 scrub (the EDITS below) ───────────────────────────────────
 * The Industry News prompt demanded a "Gastro Health News: " title prefix while
 * telling the model it wrote for Vance Health Hub. The model split the
 * difference and emitted "Vance Health News:", which the title sanitizer —
 * matching the literal old brand — passed straight through. The prefix mandate
 * appeared TWICE in the 9,913-char preset ("Daisy Prompt 16/07/26"): once as an
 * explicit block, once restated in a suggested-structure list. Both are removed
 * here. Note the smart quotes: that preset was pasted from a word processor, so
 * the strings use U+201C/U+201D and U+2014, not ASCII.
 */

import fs from 'node:fs';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const BACKUP_DIR = process.argv[process.argv.indexOf('--backup-dir') + 1] || process.cwd();

const LQ = '“', RQ = '”', DASH = '—';

/**
 * Exact [old, new] substring pairs. Order is irrelevant; each is applied
 * wherever it occurs. Anything not present is skipped silently, which is what
 * lets one EDITS list cover prompts that share only some of their text.
 */
const EDITS = [
  // The mandate itself, in the "Daisy Prompt 16/07/26" family.
  [ `The headline must start with:\n\nGastro Health News:`,
    `Do not add a category prefix to the headline. Never open it with ${LQ}Gastro Health News:${RQ}, ${LQ}Vance Health News:${RQ}, ${LQ}Healthcare News:${RQ} or any similar category label. The headline stands on its own.` ],

  // The same mandate restated further down, in the suggested-structure list.
  [ `Headline ${DASH} starts with ${LQ}Gastro Health News:${RQ}`,
    `Headline ${DASH} clear, informative, and free of any category prefix` ],

  // The library's "Default Prompt", which mirrors the hardcoded constant.
  [ `1. Headline (~10 words) ${DASH} MUST start with "Gastro Health News: " followed by a clear, informative phrase. No clickbait.`,
    `1. Headline (~10 words) ${DASH} a clear, informative phrase describing what happened. No clickbait. Do NOT open the headline with a category label such as "Health News", "Healthcare News", or "Industry News".` ],
];

/**
 * Anything still telling the model to start a title with a category label, in
 * any brand spelling. Deliberately broader than EDITS: it is there to catch a
 * variant the exact-match edits did not know about, so a wording we have never
 * seen still gets surfaced rather than passing silently.
 */
const RESIDUAL = /(start(s|ing)? with|prefixed with|begin(s|ning)? with)[^\n]{0,60}(gastro|vance|ibd)?\s*health(care)? news/i;

// ── KV plumbing ───────────────────────────────────────────────────────────────

function loadEnv() {
  let raw;
  try {
    raw = fs.readFileSync('.env.local', 'utf8');
  } catch {
    console.error('Cannot read .env.local — run this from the repo root.');
    process.exit(1);
  }
  const env = Object.fromEntries(
    raw.split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')];
    })
  );
  if (!env.KV_REST_API_URL || !env.KV_REST_API_TOKEN) {
    console.error('Missing KV_REST_API_URL / KV_REST_API_TOKEN in .env.local.');
    process.exit(1);
  }
  return env;
}

const env = loadEnv();

async function kv(pathname) {
  const r = await fetch(`${env.KV_REST_API_URL}/${pathname}`, {
    headers: { Authorization: `Bearer ${env.KV_REST_API_TOKEN}` },
  });
  if (!r.ok) throw new Error(`GET ${pathname} -> ${r.status} ${await r.text()}`);
  return (await r.json()).result;
}

const kvGet = key => kv(`get/${encodeURIComponent(key)}`);

async function kvSet(key, value) {
  const r = await fetch(`${env.KV_REST_API_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.KV_REST_API_TOKEN}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error(`SET ${key} -> ${r.status} ${await r.text()}`);
  return (await r.json()).result;
}

// ── Scrub ─────────────────────────────────────────────────────────────────────

/** Returns {text, applied[]} if anything changed, else null. */
function scrub(text, label) {
  if (typeof text !== 'string' || !text) return null;
  let out = text;
  const applied = [];
  for (const [i, [oldS, newS]] of EDITS.entries()) {
    const hits = out.split(oldS).length - 1;
    if (!hits) continue;
    if (hits > 1) console.log(`   note: edit #${i} matched ${hits}x in ${label} — replacing all`);
    out = out.split(oldS).join(newS);
    applied.push(i);
  }
  return out === text ? null : { text: out, applied };
}

const backups = {};
const plan = [];

// 1. Per-rule prompt snapshots.
const ruleIds = (await kv('lrange/automation:rules:index/0/-1')) || [];
for (const id of ruleIds) {
  const key = `automation:rule:${id}`;
  const raw = await kvGet(key);
  if (!raw) continue;
  backups[key] = raw;

  let rule;
  try {
    rule = JSON.parse(raw);
  } catch {
    console.log(`!! ${key} is not valid JSON — skipped, fix it by hand`);
    continue;
  }

  const res = scrub(rule.generation?.prompt, rule.name);
  if (!res) continue;
  rule.generation.prompt = res.text;
  plan.push({
    key,
    label: `RULE ${JSON.stringify(rule.name)} [${rule.category}] enabled=${rule.enabled}`,
    value: rule,
    checks: [{ label: rule.name, text: res.text, applied: res.applied }],
  });
}

// 2. The shared prompt library.
const LIB_KEY = 'vance:article-prompts';
const libRaw = await kvGet(LIB_KEY);
if (libRaw) {
  backups[LIB_KEY] = libRaw;
  const lib = JSON.parse(libRaw);
  const checks = [];
  for (const [cat, prompts] of Object.entries(lib.categories || {})) {
    for (const p of prompts || []) {
      const res = scrub(p.text, `${cat}/${p.name}`);
      if (!res) continue;
      p.text = res.text;
      checks.push({ label: `${cat} / ${JSON.stringify(p.name)}`, text: res.text, applied: res.applied });
    }
  }
  if (checks.length) {
    plan.push({ key: LIB_KEY, label: `LIBRARY (${checks.length} preset(s))`, value: lib, checks });
  }
}

// 3. The master prompt.
const MASTER_KEY = 'vance:master-prompt';
const master = await kvGet(MASTER_KEY);
if (typeof master === 'string' && master) {
  backups[MASTER_KEY] = master;
  const res = scrub(master, 'master-prompt');
  if (res) {
    plan.push({
      key: MASTER_KEY,
      label: 'MASTER PROMPT',
      value: res.text,
      checks: [{ label: 'master-prompt', text: res.text, applied: res.applied }],
    });
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(72)}`);
console.log(APPLY ? 'APPLYING' : 'DRY RUN — no writes');
console.log('='.repeat(72));

if (!plan.length) {
  console.log('\nNothing to change. (Already scrubbed, or the EDITS no longer match.)');
  process.exit(0);
}

let residuals = 0;
for (const p of plan) {
  console.log(`\n• ${p.label}\n  key: ${p.key}`);
  for (const c of p.checks) {
    console.log(`    - ${c.label}  (edits ${c.applied.join(', ')})`);
    if (RESIDUAL.test(c.text)) {
      residuals++;
      console.log(`      !! RESIDUAL: still instructs a title prefix — inspect by hand`);
    }
  }
}

// Back up before writing, always — and refuse to write if it fails.
const backupFile = path.join(BACKUP_DIR, `kv-prompt-backup-${ruleIds.length}rules.json`);
try {
  fs.writeFileSync(backupFile, JSON.stringify(backups, null, 2), 'utf8');
  console.log(`\nBacked up ${Object.keys(backups).length} key(s) -> ${backupFile}`);
} catch (e) {
  console.error(`\nCould not write backup (${e.message}).`);
  if (APPLY) { console.error('Refusing to --apply without a backup.'); process.exit(1); }
}

if (residuals) {
  console.log(`\n${residuals} residual instruction(s) found. These are NOT covered by EDITS —`);
  console.log('add an exact-match pair for each before relying on this scrub.');
}

if (!APPLY) {
  console.log('\nRe-run with --apply to write.');
  process.exit(0);
}

for (const p of plan) console.log(`  wrote ${p.key}: ${await kvSet(p.key, p.value)}`);

console.log('\nWrites complete. Re-read the keys to confirm before trusting this output.');

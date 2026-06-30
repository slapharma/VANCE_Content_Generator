// scripts/admin-reset.mjs
// One-shot CLI over lib/admin/reset.js — the same logic the Settings → Reset
// Databases tool uses, runnable from the terminal. Hits prod KV directly (with
// the project's KV_PREFIX), so no session/auth is needed.
//
// Usage:
//   vercel env pull .env.local
//   node --env-file=.env.local scripts/admin-reset.mjs                    # dry run (default targets)
//   node --env-file=.env.local scripts/admin-reset.mjs --delete           # live wipe (default targets)
//   node --env-file=.env.local scripts/admin-reset.mjs --targets=usage    # choose targets
//   node --env-file=.env.local scripts/admin-reset.mjs --delete --targets=content,jobs
//
// Default targets match the agreed run-now scope (content, jobs, logs, social,
// counters, processed). LLM usage + bibliography are opt-in via --targets.

import { resetDatabases, RESET_TARGETS } from '../lib/admin/reset.js';

const DELETE = process.argv.includes('--delete');
const targetsArg = process.argv.find((a) => a.startsWith('--targets='));
const DEFAULT_TARGETS = ['content', 'jobs', 'logs', 'social', 'counters', 'processed'];
const targets = targetsArg
  ? targetsArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_TARGETS;

async function main() {
  console.log(DELETE ? 'LIVE — deleting' : 'DRY RUN — no changes will be made');
  console.log(`KV_PREFIX: "${process.env.KV_PREFIX || '(none)'}"`);
  console.log(`Targets  : ${targets.join(', ')}`);

  const known = new Set(RESET_TARGETS.map((t) => t.id));
  const unknown = targets.filter((t) => !known.has(t));
  if (unknown.length) {
    console.error(`\nUnknown target(s): ${unknown.join(', ')}`);
    console.error(`Valid targets    : ${[...known].join(', ')}`);
    process.exit(1);
  }

  const { results } = await resetDatabases(targets, { dryRun: !DELETE });

  console.log('\n--- Results ---');
  for (const [k, v] of Object.entries(results)) console.log(`  ${k}: ${v.detail}`);
  console.log(DELETE ? '\nDone — datasets wiped.' : '\nDry run complete. Re-run with --delete to apply.');
}

main().catch((e) => { console.error(e); process.exit(1); });

// One-off: wipe articles + pipeline/job data from KV.
// Touches: content:*, content:index, automation:job:*, automation:jobs:index, automation:log:*
// Preserves: master-prompt, automation rules, users, reviewers, usage logs, bibliography, social kits, auth tokens.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envText = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { kv } = await import('@vercel/kv');

const DRY_RUN = process.argv.includes('--dry-run');

const PATTERNS = ['content:*', 'automation:job:*', 'automation:log:*'];
const FIXED_LIST_KEYS = ['content:index', 'automation:jobs:index'];

console.log(`Mode: ${DRY_RUN ? 'DRY-RUN (no deletes)' : 'LIVE (deletes will happen)'}`);

let totalKeys = 0;
for (const pattern of PATTERNS) {
  const keys = await kv.keys(pattern);
  console.log(`  ${pattern}: ${keys.length} keys`);
  totalKeys += keys.length;
  if (!DRY_RUN) {
    for (const k of keys) await kv.del(k);
  }
}

for (const k of FIXED_LIST_KEYS) {
  const len = await kv.llen(k).catch(() => 0);
  console.log(`  ${k}: list len=${len}`);
  if (!DRY_RUN) await kv.del(k);
}

console.log(`\nDone. ${DRY_RUN ? 'Would delete' : 'Deleted'} ${totalKeys} keyed entries plus ${FIXED_LIST_KEYS.length} index lists.`);

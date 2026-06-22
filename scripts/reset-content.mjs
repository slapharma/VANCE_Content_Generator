/**
 * reset-content.mjs
 * Deletes generated content from KV, leaving all user config intact.
 *
 * Safe to delete:
 *   content:*            — generated articles + content:index
 *   automation:job:*     — automation job records + automation:jobs:index
 *   automation:log:*     — automation run logs + automation:logs:index
 *   social:kit:*         — social media kits + indexes
 *   social:kits:*        — kit indexes + by-article mappings
 *   social:postref:*     — post references
 *   social:queue         — scheduled post queue
 *   social:posted:index  — posted index
 *
 * Preserved (never touched):
 *   automation:rule:*    — automation rules
 *   automation:rules:index
 *   users / reviewers
 *   vance:*              — master-prompt, hero-prompts, article-prompts
 *   bibliography:*       — user-curated bibliographies + papers
 *   auth:*               — OAuth tokens
 *   usage:* / pricing:*
 *   sheets:processed:*
 *   migration:*
 *   social:conn-health:*
 *
 * Usage:
 *   node scripts/reset-content.mjs            — dry run (shows counts only)
 *   node scripts/reset-content.mjs --delete   — actually deletes
 */

const KV_URL   = 'https://nearby-werewolf-76207.upstash.io';
const KV_TOKEN = 'gQAAAAAAASmvAAIncDI3MjExMjExZWM1NGE0MGNlYjYxNzZiODg1ODEzNWY5MnAyNzYyMDc';

const DRY_RUN = !process.argv.includes('--delete');

const SCAN_PATTERNS = [
  'content:*',
  'automation:job:*',
  'automation:log:*',
  'social:kit:*',
  'social:kits:*',
  'social:postref:*',
];

// Fixed keys that don't match a wildcard pattern
const FIXED_KEYS = [
  'automation:jobs:index',
  'automation:logs:index',
  'social:queue',
  'social:posted:index',
];

// Safety check — these prefixes must never appear in the delete list
const PRESERVE_PREFIXES = [
  'automation:rule:',
  'automation:rules:',
  'users',
  'reviewers',
  'vance:',
  'bibliography:',
  'auth:',
  'usage:',
  'pricing:',
  'sheets:processed:',
  'migration:',
  'social:conn-health:',
];

function isSafe(key) {
  return !PRESERVE_PREFIXES.some(p => key === p || key.startsWith(p));
}

async function kvRest(path) {
  const resp = await fetch(`${KV_URL}${path}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!resp.ok) throw new Error(`KV ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function scanPattern(pattern) {
  const keys = [];
  let cursor = 0;
  do {
    const result = await kvRest(`/scan/${cursor}?match=${encodeURIComponent(pattern)}&count=200`);
    cursor = parseInt(result.result[0], 10);
    keys.push(...result.result[1]);
  } while (cursor !== 0);
  return keys;
}

async function deleteKeys(keys) {
  if (!keys.length) return;
  // Upstash REST: /del/key1/key2/... (up to ~500 per call)
  const BATCH = 200;
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH).map(k => encodeURIComponent(k)).join('/');
    await kvRest(`/del/${batch}`);
    process.stdout.write(`  deleted ${Math.min(i + BATCH, keys.length)}/${keys.length}\r`);
  }
  process.stdout.write('\n');
}

async function main() {
  console.log(`\n=== VANCE KV Content Reset ${DRY_RUN ? '[DRY RUN]' : '[LIVE DELETE]'} ===\n`);

  const allKeys = new Set();

  // Scan wildcard patterns
  for (const pattern of SCAN_PATTERNS) {
    process.stdout.write(`Scanning ${pattern}...`);
    const keys = await scanPattern(pattern);
    process.stdout.write(` ${keys.length} keys\n`);
    keys.forEach(k => allKeys.add(k));
  }

  // Add fixed keys that exist
  for (const key of FIXED_KEYS) {
    const exists = await kvRest(`/exists/${encodeURIComponent(key)}`);
    if (exists.result === 1) {
      allKeys.add(key);
      console.log(`Found fixed key: ${key}`);
    }
  }

  // Safety filter
  const toDelete = [...allKeys].filter(isSafe);
  const blocked  = [...allKeys].filter(k => !isSafe(k));

  if (blocked.length) {
    console.warn(`\nWARNING: Safety filter blocked ${blocked.length} keys that matched a preserve prefix:`);
    blocked.forEach(k => console.warn('  BLOCKED:', k));
  }

  console.log(`\nTotal keys to delete: ${toDelete.length}`);

  if (DRY_RUN) {
    console.log('\nDry run — no changes made.');
    console.log('Sample (first 20):');
    toDelete.slice(0, 20).forEach(k => console.log(' ', k));
    if (toDelete.length > 20) console.log(`  ...and ${toDelete.length - 20} more`);
    console.log('\nRe-run with --delete to actually delete these keys.');
    return;
  }

  console.log('\nDeleting...');
  await deleteKeys(toDelete);
  console.log(`\nDone. ${toDelete.length} keys deleted.`);
}

main().catch(e => { console.error(e); process.exit(1); });

// scripts/wipe-articles.js
// One-shot cleanup: removes all generated articles and their derived
// pipeline/notification/social data from KV. Preserves reviewers,
// automation rules, OAuth credentials, and filesystem source data.
//
// Usage:
//   vercel env pull .env.local
//   node --env-file=.env.local scripts/wipe-articles.js [--dry-run]

import { kv as raw } from '@vercel/kv';

const PREFIX = process.env.KV_PREFIX ? `${process.env.KV_PREFIX}:` : '';
const p = (k) => `${PREFIX}${k}`;
const DRY = process.argv.includes('--dry-run');

const stats = {};
function bump(k, n = 1) { stats[k] = (stats[k] || 0) + n; }

async function delKey(label, fullKey) {
  if (DRY) { bump(`${label} (would delete)`); return; }
  await raw.del(fullKey);
  bump(`${label} deleted`);
}

async function wipeListIndex(indexKey, itemKeyFn, label) {
  const ids = await raw.lrange(p(indexKey), 0, -1);
  console.log(`  ${indexKey}: ${ids.length} ids`);
  for (const id of ids) {
    await delKey(label, p(itemKeyFn(id)));
  }
  await delKey(`${indexKey} (index)`, p(indexKey));
  return ids;
}

async function main() {
  console.log(DRY ? 'DRY RUN — no deletes will happen' : 'LIVE — deleting');
  console.log(`KV_PREFIX: "${PREFIX || '(none)'}"`);

  // 1. Articles (covers draft, in_review, approved, scheduled, published, trash, archived statuses)
  console.log('\n[1/5] content:*');
  const articleIds = await wipeListIndex('content:index', (id) => `content:${id}`, 'article');

  // 2. Automation jobs (pipeline / dashboard)
  console.log('\n[2/5] automation:job:*');
  await wipeListIndex('automation:jobs:index', (id) => `automation:job:${id}`, 'job');

  // 3. Automation logs (notifications history)
  console.log('\n[3/5] automation:log:*');
  await wipeListIndex('automation:logs:index', (id) => `automation:log:${id}`, 'log');

  // 4. Social kits + per-article lookup
  console.log('\n[4/5] social:kit:*');
  const kitIds = await wipeListIndex('social:kits:index', (id) => `social:kit:${id}`, 'social kit');
  // Clean per-article lookup keys for any article id we just wiped
  for (const aid of articleIds) {
    await delKey('social:kits:by-article', p(`social:kits:by-article:${aid}`));
  }

  // 5. Social post refs + queue
  console.log('\n[5/5] social:postref:* + social:queue');
  const postedRefs = await raw.lrange(p('social:posted:index'), 0, -1);
  console.log(`  social:posted:index: ${postedRefs.length} refs`);
  for (const ref of postedRefs) await delKey('postref', p(`social:postref:${ref}`));
  await delKey('social:posted:index', p('social:posted:index'));

  // Pending queue (sorted set of postref ids waiting to be sent)
  const queued = await raw.zrange(p('social:queue'), 0, -1);
  console.log(`  social:queue: ${queued.length} pending`);
  for (const ref of queued) await delKey('postref (queued)', p(`social:postref:${ref}`));
  await delKey('social:queue', p('social:queue'));

  console.log('\n--- Summary ---');
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v}`);
  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });

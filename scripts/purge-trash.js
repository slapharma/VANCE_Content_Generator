// scripts/purge-trash.js
// Hard-deletes all articles with status='trash' from KV (content:{id} key +
// content:index list entry). Also cleans up associated automation jobs.
// After purging, reconciles rule.stats.articlesGenerated for each affected rule.
//
// Usage:
//   vercel env pull .env.local
//   node --env-file=.env.local scripts/purge-trash.js [--dry-run]

import { kv } from '@vercel/kv';

const DRY = process.argv.includes('--dry-run');

async function main() {
  console.log(DRY ? 'DRY RUN — no changes will be saved' : 'LIVE — deleting');
  console.log('');

  // 1. Find all trash articles
  const allIds = await kv.lrange('content:index', 0, -1);
  const allItems = (await Promise.all(allIds.map(id => kv.get(`content:${id}`)))).filter(Boolean);

  const trashItems = allItems.filter(a => a.status === 'trash');
  const trashIds = new Set(trashItems.map(a => a.id));
  const affectedRules = new Set(trashItems.map(a => a.automationRuleId).filter(Boolean));

  console.log(`Total articles : ${allItems.length}`);
  console.log(`Trash to purge : ${trashItems.length}`);
  console.log(`Remaining after: ${allItems.length - trashItems.length}`);
  console.log('');

  if (!trashItems.length) { console.log('Nothing to purge.'); return; }

  if (DRY) {
    for (const a of trashItems) {
      console.log(`  would delete: [${a.status}] "${a.title || a.id}" (${a.automationRuleName || 'manual'})`);
    }
    console.log('\nDRY RUN — no changes made.');
    return;
  }

  // 2. Delete content KV keys
  for (const a of trashItems) {
    await kv.del(`content:${a.id}`);
  }

  // 3. Rebuild content:index without trash IDs
  const survivingIds = allIds.filter(id => !trashIds.has(id));
  await kv.del('content:index');
  if (survivingIds.length) {
    await kv.rpush('content:index', ...survivingIds);
  }
  console.log(`✓ Purged ${trashItems.length} trash articles. content:index now has ${survivingIds.length} entries.`);

  // 4. Clean up orphaned jobs (jobs whose contentId was just deleted)
  const jobIds = await kv.lrange('automation:jobs:index', 0, -1);
  const orphanJobIds = [];
  for (const jid of jobIds) {
    const job = await kv.get(`automation:job:${jid}`);
    if (job && trashIds.has(job.contentId)) orphanJobIds.push(jid);
  }
  if (orphanJobIds.length) {
    for (const jid of orphanJobIds) await kv.del(`automation:job:${jid}`);
    const survivingJobIds = jobIds.filter(id => !orphanJobIds.includes(id));
    await kv.del('automation:jobs:index');
    if (survivingJobIds.length) await kv.rpush('automation:jobs:index', ...survivingJobIds);
    console.log(`✓ Removed ${orphanJobIds.length} orphaned jobs.`);
  }

  // 5. Reconcile rule.stats for affected automation rules
  const ruleIds = await kv.lrange('automation:rules:index', 0, -1);
  for (const rid of ruleIds) {
    const rule = await kv.get(`automation:rule:${rid}`);
    if (!rule || !affectedRules.has(rule.id)) continue;

    // Recount from surviving articles
    const surviving = (await Promise.all(survivingIds.map(id => kv.get(`content:${id}`)))).filter(Boolean);
    const generated = surviving.filter(a => a.automationRuleId === rule.id).length;
    const published = surviving.filter(a => a.automationRuleId === rule.id && a.status === 'published').length;

    await kv.set(`automation:rule:${rid}`, {
      ...rule,
      stats: { ...(rule.stats || {}), articlesGenerated: generated, articlesPublished: published },
      updatedAt: new Date().toISOString(),
    });
    console.log(`✓ Rule "${rule.name}": stats updated → generated=${generated} published=${published}`);
  }

  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });

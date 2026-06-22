// scripts/reconcile-rule-stats.js
// Recount rule.stats (articlesGenerated + articlesPublished) from the live
// content:index for a named automation rule, so the automation card matches
// the dashboard's real-time counts.
//
// Usage:
//   vercel env pull .env.local
//   node --env-file=.env.local scripts/reconcile-rule-stats.js [--dry-run]

import { kv } from '@vercel/kv';

const RULE_NAME = 'Blog Approved Titles_3rdJune2026';
const DRY = process.argv.includes('--dry-run');

async function main() {
  console.log(DRY ? 'DRY RUN — no changes will be saved' : 'LIVE — changes will be saved');
  console.log(`Rule: "${RULE_NAME}"\n`);

  // 1. Find rule
  const ruleIds = await kv.lrange('automation:rules:index', 0, -1);
  let rule = null, ruleKey = null;
  for (const id of ruleIds) {
    const r = await kv.get(`automation:rule:${id}`);
    if (r && r.name === RULE_NAME) { rule = r; ruleKey = `automation:rule:${id}`; break; }
  }
  if (!rule) { console.error(`✗ Rule not found: "${RULE_NAME}"`); process.exit(1); }
  console.log(`✓ Found rule: ${rule.id}`);
  console.log(`  Current stats: generated=${rule.stats?.articlesGenerated ?? 0}  published=${rule.stats?.articlesPublished ?? 0}\n`);

  // 2. Count from content:index (same source the dashboard uses)
  const articleIds = await kv.lrange('content:index', 0, -1);
  let generated = 0, published = 0;
  for (const aid of articleIds) {
    const a = await kv.get(`content:${aid}`);
    if (!a || a.automationRuleId !== rule.id) continue;
    generated++;
    if (a.status === 'published') published++;
  }

  console.log(`  Live counts  : generated=${generated}  published=${published}`);

  if (generated === (rule.stats?.articlesGenerated ?? 0) && published === (rule.stats?.articlesPublished ?? 0)) {
    console.log('\nStats already match — nothing to update.');
    return;
  }

  console.log('');
  if (DRY) {
    console.log(`DRY RUN — would update: articlesGenerated ${rule.stats?.articlesGenerated ?? 0} → ${generated}, articlesPublished ${rule.stats?.articlesPublished ?? 0} → ${published}`);
  } else {
    await kv.set(ruleKey, {
      ...rule,
      stats: {
        ...(rule.stats || {}),
        articlesGenerated: generated,
        articlesPublished: published,
      },
      updatedAt: new Date().toISOString(),
    });
    console.log(`✓ Stats updated: articlesGenerated=${generated}  articlesPublished=${published}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

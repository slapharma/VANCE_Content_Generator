// scripts/recover-todays-reviews.js
// Audit and recover today's articles that should have been sent for review but
// weren't (cron function timed out before reaching the notify step).
//
// Usage:
//   node --env-file=.env.local scripts/recover-todays-reviews.js [--dry-run]

import { kv } from '@vercel/kv';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://vance-content.vercel.app';
const DRY = process.argv.includes('--dry-run');

function startOfTodayUtcMs() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

async function findTodaysContent() {
  const ids = await kv.lrange('content:index', 0, -1);
  const items = await Promise.all(ids.map(id => kv.get(`content:${id}`)));
  const todayStart = startOfTodayUtcMs();
  return items.filter(c => c && c.createdAt && new Date(c.createdAt).getTime() >= todayStart);
}

async function recoverOne(item, rule) {
  const reviewerIds = rule?.notifications?.email?.userIds || [];
  if (!reviewerIds.length) {
    return { ok: false, reason: 'rule has no email recipients configured' };
  }
  if (DRY) return { ok: true, dryRun: true, reviewerIds };

  const res = await fetch(`${APP_URL}/api/review/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contentId: item.id,
      requireAllApprovals: (rule.review?.mode ?? 'any') === 'all',
      urgent: false,
      reviewerIds,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}: ${data.error || res.statusText}` };
  return { ok: true, sent: data.sent, failed: data.failed };
}

function statusLabel(item) {
  if (item.status === 'in_review') return 'in_review';
  if (item.status === 'draft' && !item.sentForReviewAt) return 'STUCK_DRAFT';
  return item.status;
}

async function main() {
  console.log(DRY ? '=== DRY RUN ===' : '=== LIVE — will trigger review emails ===');
  const todays = await findTodaysContent();
  console.log(`Found ${todays.length} content items created today (UTC).\n`);

  // Cache rules so we don't hit KV repeatedly
  const ruleCache = new Map();
  async function getRule(id) {
    if (!id) return null;
    if (ruleCache.has(id)) return ruleCache.get(id);
    const r = await kv.get(`automation:rule:${id}`);
    ruleCache.set(id, r);
    return r;
  }

  const rows = [];
  for (const item of todays) {
    const rule = await getRule(item.automationRuleId);
    rows.push({ item, rule, status: statusLabel(item) });
  }

  // Group + display
  const buckets = { STUCK_DRAFT: [], in_review: [], approved: [], rejected: [], scheduled: [], published: [], other: [] };
  for (const row of rows) (buckets[row.status] ?? buckets.other).push(row);

  console.log('=== Audit ===');
  for (const [label, list] of Object.entries(buckets)) {
    if (!list.length) continue;
    console.log(`\n[${label}] ${list.length} item(s):`);
    for (const row of list) {
      const ruleInfo = row.rule
        ? `${row.rule.name} (review.required=${row.rule.review?.required}, userIds=${row.rule.notifications?.email?.userIds?.length ?? 0})`
        : '(no rule / manual creation)';
      console.log(`  - "${(row.item.title || '').slice(0, 80)}" — ${ruleInfo}`);
    }
  }

  // Recovery: STUCK_DRAFT items with a rule that has review.required=true
  const toRecover = buckets.STUCK_DRAFT.filter(r => r.rule?.review?.required);
  console.log(`\n=== Recovery candidates: ${toRecover.length} ===`);
  for (const row of toRecover) {
    console.log(`\nRecovering: "${(row.item.title || '').slice(0, 90)}"`);
    const result = await recoverOne(row.item, row.rule);
    if (result.ok) {
      if (result.dryRun) {
        console.log(`  [dry-run] would email ${result.reviewerIds.length} reviewer(s)`);
      } else {
        console.log(`  ✓ sent=${result.sent} failed=${result.failed ?? 0}`);
      }
    } else {
      console.log(`  ✗ ${result.reason}`);
    }
  }

  // Drafts that don't qualify for recovery (no rule, or review not required)
  const skipped = buckets.STUCK_DRAFT.filter(r => !r.rule?.review?.required);
  if (skipped.length) {
    console.log(`\n=== Skipped (review not required or no rule): ${skipped.length} ===`);
    for (const row of skipped) {
      console.log(`  - "${(row.item.title || '').slice(0, 80)}"`);
    }
  }

  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });

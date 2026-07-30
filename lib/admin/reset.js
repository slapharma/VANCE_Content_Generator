// lib/admin/reset.js
// Selective KV reset powering the admin "Reset Databases" tool (Settings page)
// and scripts/admin-reset.mjs. Every operation is index- or rule-driven, so it
// uses only the prefix-safe `kv` wrapper from lib/kv.js — no KEYS scanning and
// no double-prefix pitfalls.
//
// NEVER touched: prompts (vance:* — except the used stock-photo ledger, which has
// its own opt-in target), users/reviewers, auth:*, pricing:*,
// migration:*, the automation rule objects themselves (only `stats` and per-source
// consumed-arrays are mutated), bibliography papers (only the `processed` flag
// flips when that target is selected), and rule.lastRunAt (so time-based RSS/URL
// sources don't re-flood after a reset).

import { kv } from '../kv.js';
import { clearLogs } from '../automation/log.js';
import { STOCK_USED_KEY, stockLedgerSize } from '../social/stock-ledger.js';

// Source of truth for the UI checkboxes and the API catalogue.
export const RESET_TARGETS = [
  { id: 'content',      label: 'Generated content (articles)',  defaultOn: true,
    detail: 'Deletes every article and the content index.' },
  { id: 'jobs',         label: 'Automation jobs & pipeline',    defaultOn: true,
    detail: 'Clears automation run records — also zeroes the dashboard pipeline and the notifications badge.' },
  { id: 'logs',         label: 'Logs & notification history',   defaultOn: true,
    detail: 'Clears the automation run/event log.' },
  { id: 'social',       label: 'Social kits, queue & posts',    defaultOn: true,
    detail: 'Deletes generated social kits, the scheduled queue, and post history.' },
  { id: 'counters',     label: 'Reset automation counters',     defaultOn: true,
    detail: 'Resets each rule’s run / generated / published counts to zero.' },
  { id: 'processed',    label: 'Reset source processed-state',  defaultOn: true,
    detail: 'Lets automations re-process source rows/files (upload, Drive, Sheets). Live sheet cells are not modified.' },
  { id: 'usage',        label: 'LLM usage & cost stats',        defaultOn: false,
    detail: 'Deletes recorded token-usage events (zeroes the usage/cost panel).' },
  { id: 'bibliography', label: 'Bibliography processed flags',  defaultOn: false,
    detail: 'Marks every saved paper unprocessed so bibliography rules can re-generate. Papers themselves are kept.' },
  { id: 'stockimages',  label: 'Used stock-photo ledger',       defaultOn: false,
    detail: 'Forgets which Pexels/Unsplash photos have been used, so they can be offered and used again. Off by default — the ledger deliberately outlives a content wipe, because photos already published to WordPress are still in use out there.' },
];

const VALID = new Set(RESET_TARGETS.map(t => t.id));

// ── Per-target operations ─────────────────────────────────────────────────────

async function resetContent(dryRun) {
  const ids = await kv.lrange('content:index', 0, -1);
  if (!dryRun) {
    for (const id of ids) await kv.del(`content:${id}`);
    await kv.del('content:index');
  }
  return { affected: ids.length, detail: `${ids.length} article(s)` };
}

async function resetJobs(dryRun) {
  const ids = await kv.lrange('automation:jobs:index', 0, -1);
  if (!dryRun) {
    for (const id of ids) await kv.del(`automation:job:${id}`);
    await kv.del('automation:jobs:index');
  }
  return { affected: ids.length, detail: `${ids.length} job(s)` };
}

async function resetLogs(dryRun) {
  const ids = await kv.lrange('automation:logs:index', 0, -1);
  if (!dryRun) await clearLogs();   // deletes automation:log:* + the index
  return { affected: ids.length, detail: `${ids.length} log entr(ies)` };
}

async function resetSocial(dryRun) {
  const kitIds     = await kv.lrange('social:kits:index', 0, -1);
  const postedRefs = await kv.lrange('social:posted:index', 0, -1);
  const queuedRefs = await kv.zrange('social:queue', 0, -1);
  if (!dryRun) {
    for (const id of kitIds) {
      const kit = await kv.get(`social:kit:${id}`);
      if (kit?.articleId) await kv.del(`social:kits:by-article:${kit.articleId}`);
      await kv.del(`social:kit:${id}`);
    }
    await kv.del('social:kits:index');
    for (const ref of postedRefs) await kv.del(`social:postref:${ref}`);
    await kv.del('social:posted:index');
    for (const ref of queuedRefs) await kv.del(`social:postref:${ref}`);
    await kv.del('social:queue');
  }
  const total = kitIds.length + postedRefs.length + queuedRefs.length;
  return {
    affected: total,
    detail: `${kitIds.length} kit(s), ${postedRefs.length} posted, ${queuedRefs.length} queued`,
  };
}

// counters + processed both mutate rule objects — do them in a single pass so a
// rule that needs both changes is loaded and saved only once.
async function resetRules({ counters, processed, dryRun }) {
  const ruleIds = await kv.lrange('automation:rules:index', 0, -1);
  let countersChanged = 0, sourcesCleared = 0, sheetsKeys = 0;

  for (const id of ruleIds) {
    const rule = await kv.get(`automation:rule:${id}`);
    if (!rule) continue;
    let changed = false;
    const next = { ...rule };

    if (counters) {
      const s = rule.stats || {};
      if (s.totalRuns || s.articlesGenerated || s.articlesPublished) countersChanged++;
      next.stats = { ...s, totalRuns: 0, articlesGenerated: 0, articlesPublished: 0 };
      changed = true;
    }

    if (processed) {
      const sources = Array.isArray(rule.sources) ? rule.sources : [];
      next.sources = sources.map((src) => {
        const out = { ...src };
        let cleared = false;
        if (Array.isArray(src.consumedUrls)    && src.consumedUrls.length)    { out.consumedUrls    = []; cleared = true; }
        if (Array.isArray(src.consumedTitles)  && src.consumedTitles.length)  { out.consumedTitles  = []; cleared = true; }
        if (Array.isArray(src.consumedFileIds) && src.consumedFileIds.length) { out.consumedFileIds = []; cleared = true; }
        if (cleared) sourcesCleared++;
        return out;
      });
      changed = true;
      // Google Sheets processed-rows live in a dedicated KV key per source —
      // reconstruct the exact key (no scanning needed) and delete it.
      for (const src of sources) {
        if (src.type === 'google_sheets' && src.sheetId) {
          const sheetName = src.sheetName || 'Sheet1';
          sheetsKeys++;
          if (!dryRun) await kv.del(`sheets:processed:${rule.id}:${src.sheetId}:${sheetName}`);
        }
      }
    }

    if (changed && !dryRun) {
      next.updatedAt = new Date().toISOString();
      await kv.set(`automation:rule:${id}`, next);
    }
  }

  return { ruleCount: ruleIds.length, countersChanged, sourcesCleared, sheetsKeys };
}

async function resetUsage(dryRun) {
  const events = await kv.lrange('usage:llm:events', 0, -1);
  if (!dryRun) await kv.del('usage:llm:events');
  return { affected: events.length, detail: `${events.length} usage event(s)` };
}

async function resetStockLedger(dryRun) {
  const keys = await stockLedgerSize();
  if (!dryRun && keys) await kv.del(STOCK_USED_KEY);
  // Two keys per photo (provider id + image path), so report photos, not keys.
  return { affected: keys, detail: `${keys} ledger key(s) — roughly ${Math.ceil(keys / 2)} photo(s)` };
}

async function resetBibliographyProcessed(dryRun) {
  const bibIds = await kv.lrange('bibliography:index', 0, -1);
  let flipped = 0;
  for (const bibId of bibIds) {
    const paperIds = await kv.lrange(`bibliography:papers:${bibId}`, 0, -1);
    for (const pid of paperIds) {
      const paper = await kv.get(`bibliography:paper:${pid}`);
      if (paper && paper.processed) {
        flipped++;
        if (!dryRun) await kv.set(`bibliography:paper:${pid}`, { ...paper, processed: false });
      }
    }
  }
  return { affected: flipped, detail: `${flipped} paper(s) marked unprocessed` };
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Reset the selected datasets.
 * @param {string[]} targetIds  - ids from RESET_TARGETS
 * @param {{dryRun?: boolean}} opts - dryRun defaults to true (safe)
 * @returns {{dryRun:boolean, targets:string[], results:Object}}
 */
export async function resetDatabases(targetIds, { dryRun = true } = {}) {
  const targets = (Array.isArray(targetIds) ? targetIds : []).filter((t) => VALID.has(t));
  const results = {};

  if (targets.includes('content')) results.content = await resetContent(dryRun);
  if (targets.includes('jobs'))    results.jobs    = await resetJobs(dryRun);
  if (targets.includes('logs'))    results.logs    = await resetLogs(dryRun);
  if (targets.includes('social'))  results.social  = await resetSocial(dryRun);

  const wantCounters  = targets.includes('counters');
  const wantProcessed = targets.includes('processed');
  if (wantCounters || wantProcessed) {
    const r = await resetRules({ counters: wantCounters, processed: wantProcessed, dryRun });
    if (wantCounters) {
      results.counters = {
        affected: r.countersChanged,
        detail: `${r.countersChanged} of ${r.ruleCount} rule(s) had non-zero counters`,
      };
    }
    if (wantProcessed) {
      results.processed = {
        affected: r.sourcesCleared,
        detail: `${r.sourcesCleared} source(s) cleared, ${r.sheetsKeys} sheet tracker(s) across ${r.ruleCount} rule(s)`,
      };
    }
  }

  if (targets.includes('usage'))        results.usage        = await resetUsage(dryRun);
  if (targets.includes('bibliography')) results.bibliography = await resetBibliographyProcessed(dryRun);
  if (targets.includes('stockimages'))  results.stockimages  = await resetStockLedger(dryRun);

  return { dryRun, targets, results };
}

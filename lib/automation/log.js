// lib/automation/log.js
// Lightweight run/event log for the automation system.
// Entries are pushed to a capped Redis list ('automation:logs:index') with the
// full record stored at 'automation:log:<id>'.
import { kv } from '../kv.js';

const INDEX_KEY = 'automation:logs:index';
const MAX_LOGS  = 200;

export async function writeLog(entry) {
  try {
    const id  = `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const rec = {
      id,
      at:        new Date().toISOString(),
      ruleId:    entry.ruleId    || null,
      ruleName:  entry.ruleName  || null,
      level:     entry.level     || 'info',     // 'info' | 'success' | 'error' | 'warn'
      message:   entry.message   || '',
      jobId:     entry.jobId     || null,
      contentId: entry.contentId || null,
      meta:      entry.meta      || null,
    };
    await kv.set(`automation:log:${id}`, rec);
    await kv.lpush(INDEX_KEY, id);
    // Cap the index to MAX_LOGS most recent
    await kv.ltrim(INDEX_KEY, 0, MAX_LOGS - 1);
    return rec;
  } catch (err) {
    // Logging must never throw — fall back to console
    console.error('writeLog failed:', err.message);
    return null;
  }
}

export async function readLogs(limit = 100) {
  const ids = await kv.lrange(INDEX_KEY, 0, Math.max(0, limit - 1));
  if (!ids.length) return [];
  const records = await Promise.all(ids.map(id => kv.get(`automation:log:${id}`)));
  return records.filter(Boolean);
}

export async function clearLogs() {
  const ids = await kv.lrange(INDEX_KEY, 0, -1);
  await Promise.all(ids.map(id => kv.del(`automation:log:${id}`)));
  await kv.del(INDEX_KEY);
}

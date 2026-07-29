// lib/social/promo-store.js
//
// KV persistence for Promotional Carousel campaigns and the promo prompt library.
//
// Two things live here:
//
//   social:promo:{id}      one campaign
//   social:promos:index    newest-first list of campaign ids, capped
//   social:promo-prompts   the saved prompt template library
//
// The prompt library is in KV rather than localStorage on purpose. The existing
// Social ▸ Prompts library (getSocialPromptsForPlat in index.html) is
// localStorage-backed, which is fine for a prompt a human pastes into a form in
// their own browser — but a promo template is read by the hourly cron when it
// mints an occurrence, with no browser anywhere. A localStorage-backed template
// would simply be invisible at the moment it is needed.

import { kv } from '../kv.js';
import { buildPromo, nextOccurrence, PROMO_STATUS } from './promo-schema.js';

export const PROMO_INDEX = 'social:promos:index';
export const PROMPT_LIBRARY_KEY = 'social:promo-prompts';
const INDEX_CAP = 200;

export const promoKey = (id) => `social:promo:${id}`;

export async function savePromo(promo, { indexIt = false } = {}) {
  const record = { ...promo, updatedAt: new Date().toISOString() };
  await kv.set(promoKey(record.id), record);
  if (indexIt) {
    await kv.lpush(PROMO_INDEX, record.id);
    await kv.ltrim(PROMO_INDEX, 0, INDEX_CAP - 1);
  }
  return record;
}

export async function getPromo(id) {
  if (!id) return null;
  return (await kv.get(promoKey(id))) || null;
}

export async function listPromos({ limit = 100 } = {}) {
  const ids = await kv.lrange(PROMO_INDEX, 0, Math.max(0, limit - 1));
  if (!ids?.length) return [];
  const records = await Promise.all(ids.map((id) => kv.get(promoKey(id))));
  return records.filter(Boolean);
}

export async function deletePromo(id) {
  const promo = await getPromo(id);
  if (!promo) return false;
  await kv.del(promoKey(id));
  await kv.lrem(PROMO_INDEX, 0, id);
  return true;
}

/**
 * Recompute and persist `nextRunAt`.
 *
 * Called after every edit and after every occurrence, because both can change
 * the answer — an edit to the schedule obviously, and an occurrence because
 * `occurrenceCount` feeds the limit check. A campaign whose schedule has run out
 * is moved to `ended` here rather than being left `active` with a null
 * nextRunAt, so the cron never has to distinguish "not due yet" from "finished".
 */
export async function refreshNextRun(promo, from = new Date()) {
  const next = nextOccurrence(promo, from);
  const updated = {
    ...promo,
    nextRunAt: next,
    status: (!next && promo.status === PROMO_STATUS.active) ? PROMO_STATUS.ended : promo.status,
  };
  return savePromo(updated);
}

/**
 * Record a minted occurrence against its campaign and advance every cursor.
 *
 * Advancing `csvCursor` here rather than in the spec builder keeps the builder
 * pure and, more importantly, means the cursor only moves when a deck was
 * actually created — a failed build re-uses the same CSV row next time instead
 * of silently skipping that message forever.
 */
export async function recordOccurrence(promo, carouselId, { at = new Date() } = {}) {
  const rowCount = (promo.csvRows || []).length;
  let cursor = promo.csvCursor || 0;
  let status = promo.status;

  if (promo.messagingMode === 'csv' && rowCount) {
    cursor += 1;
    if (cursor >= rowCount) {
      if (promo.csvWrap) cursor = 0;
      else status = PROMO_STATUS.ended; // the script has run out; stop cleanly
    }
  }

  const updated = {
    ...promo,
    status,
    csvCursor: cursor,
    lastRunAt: at.toISOString(),
    lastError: null,
    occurrenceCount: (promo.occurrenceCount || 0) + 1,
    occurrences: [
      { carouselId, at: at.toISOString() },
      ...(promo.occurrences || []),
    ].slice(0, 50),
  };

  // Only re-arm a campaign that is still running — refreshNextRun on an `ended`
  // one would leave it ended with a stale nextRunAt, which reads as a bug on the
  // campaign card.
  if (status === PROMO_STATUS.active) return refreshNextRun(updated, at);
  return savePromo({ ...updated, nextRunAt: null });
}

export async function recordFailure(promo, message, { at = new Date() } = {}) {
  // Deliberately still re-arms: one bad occurrence (an LLM 5xx, a WP upload
  // refusing a slide) must not silently kill a campaign that runs for months.
  const updated = { ...promo, lastError: String(message || '').slice(0, 300), lastRunAt: at.toISOString() };
  return refreshNextRun(updated, at);
}

// ── prompt template library ──────────────────────────────────────────────────

/** @returns {Promise<Array<{id, name, createdBy, text, updatedAt}>>} */
export async function listPromptPresets() {
  const raw = await kv.get(PROMPT_LIBRARY_KEY);
  return Array.isArray(raw) ? raw : [];
}

export async function savePromptPreset(preset) {
  const presets = await listPromptPresets();
  const now = new Date().toISOString();
  const record = {
    id: preset.id || `pp_${Date.now()}`,
    name: String(preset.name || 'Untitled prompt').trim().slice(0, 120),
    createdBy: String(preset.createdBy || 'Vance Medical Foods').trim().slice(0, 80),
    text: String(preset.text || '').slice(0, 6000),
    updatedAt: now,
  };
  const idx = presets.findIndex((p) => p.id === record.id);
  if (idx >= 0) presets[idx] = { ...presets[idx], ...record };
  else presets.unshift(record);
  await kv.set(PROMPT_LIBRARY_KEY, presets.slice(0, 50));
  return record;
}

export async function deletePromptPreset(id) {
  const presets = await listPromptPresets();
  const next = presets.filter((p) => p.id !== id);
  await kv.set(PROMPT_LIBRARY_KEY, next);
  return presets.length !== next.length;
}

export { buildPromo };

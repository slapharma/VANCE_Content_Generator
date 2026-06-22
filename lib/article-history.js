// lib/article-history.js — per-article audit log + body version snapshots.
//
// Two structures live on each content item, both persisted in KV alongside the
// article:
//   item.auditLog[] — append-only event log, small + uncapped:
//       { type, at, actor, detail }
//   item.versions[] — body snapshots taken BEFORE each meaningful change, so a
//     before/after diff is possible. Capped at MAX_VERSIONS to bound KV size:
//       { at, actor, reason, body }
//
// Used server-side from the content PUT endpoint, the review (approve / request
// changes) endpoint, the AI-revise endpoint, and the automation compression pass.

export const MAX_VERSIONS = 10;

// Append an event to the article's audit log. Mutates and returns `item`.
export function logEvent(item, { type, actor, at, detail } = {}) {
  if (!item) return item;
  if (!Array.isArray(item.auditLog)) item.auditLog = [];
  item.auditLog.push({
    type: type || 'event',
    at: at || new Date().toISOString(),
    actor: actor != null ? actor : null,
    detail: detail != null ? detail : null,
  });
  return item;
}

// Snapshot the CURRENT body before it is overwritten. Mutates and returns `item`.
// No-op when the item has no body yet. Keeps only the most recent MAX_VERSIONS.
export function snapshotBody(item, { actor, at, reason } = {}) {
  if (!item || typeof item.body !== 'string' || !item.body) return item;
  if (!Array.isArray(item.versions)) item.versions = [];
  item.versions.push({
    at: at || new Date().toISOString(),
    actor: actor != null ? actor : null,
    reason: reason || null,
    body: item.body,
  });
  if (item.versions.length > MAX_VERSIONS) {
    item.versions = item.versions.slice(-MAX_VERSIONS);
  }
  return item;
}

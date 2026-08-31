import { kv } from '../../lib/kv.js';
import { getCurrentUser, requireRole } from '../../lib/auth.js';
import { logEvent, snapshotBody } from '../../lib/article-history.js';
import { withErrorBoundary } from '../../lib/api.js';
import { markStockUsed, heroAsStockPhoto } from '../../lib/social/stock-ledger.js';

// Note: 'rejected' is intentionally absent from in_review's allowed targets.
// Reviewers' "Request Changes" feedback is stored as comments on the article but
// does NOT terminate the review — the article stays in_review until enough
// approvals arrive. The legacy 'rejected' rows in KV are still readable; the
// 'rejected → draft / trash' transition stays available so admins can clear them.
const VALID_TRANSITIONS = {
  draft:      ['in_review', 'approved', 'draft', 'trash'],
  in_review:  ['approved', 'draft', 'trash'],
  rejected:   ['draft', 'trash'], // legacy items only — new items never reach this state
  approved:   ['scheduled', 'published', 'draft', 'trash'],
  scheduled:  ['published', 'approved', 'trash'],
  published:  ['trash'],
  trash:      ['draft'],  // restore
};

export function applyStatusTransition(current, next) {
  if (!VALID_TRANSITIONS[current]?.includes(next)) {
    throw new Error(`invalid status transition: ${current} -> ${next}`);
  }
  return next;
}

// `store` and `currentUser` are injected so the auth guards below can be tested
// without a live KV or a real session — same deps-object shape as
// lib/automation/handlers/run.js. Production passes neither and gets the real ones.
export async function handler(req, res, { store = kv, currentUser = getCurrentUser } = {}) {
  const { id } = req.query;
  const item = await store.get(`content:${id}`);
  if (!item) return res.status(404).json({ error: 'Not found' });

  // GET is left as it was. Gating a single item by id here would be theatre while
  // /api/content (the list) still answers unauthenticated — that is the real read
  // boundary and it is a separate, larger change. This commit closes the writes,
  // which are the part that lets an anonymous caller alter the pipeline.
  if (req.method === 'GET') {
    return res.json(item);
  }

  if (req.method === 'PUT') {
    // Any signed-in user: editing an article and moving it through the pipeline is
    // the content team's core job, so this is not role-restricted. It is checked
    // before the transition is validated and before anything is written, so an
    // anonymous request cannot reach kv.set at all.
    //
    // Until 2026-08-18 there was no check here. getCurrentUser was called, but only
    // to label the audit entry, falling back to 'Content team' when absent — so an
    // unauthenticated caller could retitle, rewrite or trash any article, including
    // a published one, and the audit log recorded it as the content team.
    const me = await currentUser(req).catch(() => null);
    if (!me) return res.status(401).json({ error: 'Not authenticated' });

    const updates = { ...req.body };
    if (updates.status && updates.status !== item.status) {
      try {
        applyStatusTransition(item.status, updates.status);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }
    const now = new Date().toISOString();
    const statusTimestamps = {};
    if (updates.status && updates.status !== item.status) {
      if (updates.status === 'in_review'  && !item.sentForReviewAt) statusTimestamps.sentForReviewAt = now;
      if (updates.status === 'approved'   && !item.approvedAt)      statusTimestamps.approvedAt      = now;
      if (updates.status === 'scheduled'  && !item.scheduledAt)     statusTimestamps.scheduledAt     = now;
      if (updates.status === 'published'  && !item.publishedAt)     statusTimestamps.publishedAt     = now;
    }

    // Audit log + body snapshots, attributed to the caller resolved above. There is
    // no anonymous branch any more: a request without a session was rejected before
    // reaching here, so every entry names a real user. Mutations happen on `item`
    // so they survive the spread.
    const actor = me.name || me.email || me.id;
    const bodyChanged = typeof updates.body === 'string' && updates.body !== item.body;
    if (bodyChanged) {
      snapshotBody(item, { actor, at: now, reason: 'edit' });
      logEvent(item, {
        type: 'edit', actor, at: now,
        detail: {
          wordsBefore: (item.body || '').split(/\s+/).filter(Boolean).length,
          wordsAfter: updates.body.split(/\s+/).filter(Boolean).length,
        },
      });
    }
    if (updates.status && updates.status !== item.status) {
      logEvent(item, { type: 'status', actor, at: now, detail: { from: item.status, to: updates.status } });
    }
    if (typeof updates.title === 'string' && updates.title !== item.title) {
      logEvent(item, { type: 'title', actor, at: now, detail: { from: item.title || '', to: updates.title } });
    }

    const updated = { ...item, ...updates, ...statusTimestamps, updatedAt: now };
    await store.set(`content:${id}`, updated);
    // Spend the stock hero on save (idempotent), so a photo picked by hand is never
    // offered again. Swapping a hero therefore spends both photos — deliberate, and
    // cheap against a pool of millions.
    await markStockUsed(heroAsStockPhoto(updated));
    return res.json(updated);
  }

  if (req.method === 'DELETE') {
    // Admin only, and deliberately stricter than PUT: this is a hard kv.del with no
    // trash state and no undo. The pipeline's own "delete" is a PUT to status
    // 'trash', which is reversible and stays open to the whole content team.
    const guard = requireRole(await currentUser(req).catch(() => null), 'admin');
    if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
    await store.del(`content:${id}`);
    const ids = await store.lrange('content:index', 0, -1);
    await store.del('content:index');
    const remaining = ids.filter(i => i !== id);
    if (remaining.length) await store.rpush('content:index', ...remaining);
    return res.status(204).end();
  }

  res.status(405).json({ error: 'Method not allowed' });
}

export default withErrorBoundary(handler);

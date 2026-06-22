import { kv } from '../../lib/kv.js';
import { getCurrentUser } from '../../lib/auth.js';
import { logEvent, snapshotBody } from '../../lib/article-history.js';

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

export default async function handler(req, res) {
  const { id } = req.query;
  const item = await kv.get(`content:${id}`);
  if (!item) return res.status(404).json({ error: 'Not found' });

  if (req.method === 'GET') {
    return res.json(item);
  }

  if (req.method === 'PUT') {
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

    // Audit log + body snapshots. Edits made from the app are attributed to the
    // logged-in user; if no session is present (e.g. internal scripts) fall back
    // to a generic label. Mutations happen on `item` so they survive the spread.
    const me = await getCurrentUser(req).catch(() => null);
    const actor = me ? (me.name || me.email || me.id) : 'Content team';
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
    await kv.set(`content:${id}`, updated);
    return res.json(updated);
  }

  if (req.method === 'DELETE') {
    await kv.del(`content:${id}`);
    const ids = await kv.lrange('content:index', 0, -1);
    await kv.del('content:index');
    const remaining = ids.filter(i => i !== id);
    if (remaining.length) await kv.rpush('content:index', ...remaining);
    return res.status(204).end();
  }

  res.status(405).json({ error: 'Method not allowed' });
}

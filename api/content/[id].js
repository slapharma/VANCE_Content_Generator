import { kv } from '../../lib/kv.js';

const VALID_TRANSITIONS = {
  draft:      ['in_review', 'approved', 'draft', 'trash'],
  in_review:  ['approved', 'rejected', 'draft', 'trash'],
  rejected:   ['draft', 'trash'],
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
    // Capture per-status timestamps on first transition into that status
    const statusTimestamps = {};
    if (updates.status && updates.status !== item.status) {
      if (updates.status === 'in_review'  && !item.sentForReviewAt) statusTimestamps.sentForReviewAt = now;
      if (updates.status === 'approved'   && !item.approvedAt)      statusTimestamps.approvedAt      = now;
      if (updates.status === 'scheduled'  && !item.scheduledAt)     statusTimestamps.scheduledAt     = now;
      if (updates.status === 'published'  && !item.publishedAt)     statusTimestamps.publishedAt     = now;
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

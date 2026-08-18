import { kv } from '../../lib/kv.js';
import { getCurrentUser } from '../../lib/auth.js';

export function validateScheduleDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) throw new Error('invalid date');
  if (d <= new Date()) throw new Error('scheduled date must be in the future');
}

export async function handler(req, res, { currentUser = getCurrentUser } = {}) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Until 2026-08-18 an anonymous POST could move any approved article to
  // 'scheduled' with a caller-chosen date, which the 08:00 cron then published.
  // Only the browser calls this — nothing schedules server-to-server.
  const me = await currentUser(req).catch(() => null);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });

  const { contentId, scheduledAt } = req.body;
  try { validateScheduleDate(scheduledAt); } catch (e) { return res.status(400).json({ error: e.message }); }

  const item = await kv.get(`content:${contentId}`);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (!['approved', 'scheduled'].includes(item.status)) {
    return res.status(400).json({ error: 'Content must be approved before scheduling' });
  }

  const updated = { ...item, status: 'scheduled', scheduledAt, updatedAt: new Date().toISOString() };
  await kv.set(`content:${contentId}`, updated);
  return res.json(updated);
}

export default handler;

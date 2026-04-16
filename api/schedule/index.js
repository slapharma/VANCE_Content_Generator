import { kv } from '../../lib/kv.js';

export function validateScheduleDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) throw new Error('invalid date');
  if (d <= new Date()) throw new Error('scheduled date must be in the future');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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

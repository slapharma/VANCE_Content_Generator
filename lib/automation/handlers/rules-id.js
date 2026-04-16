// lib/automation/handlers/rules-id.js
import { kv } from '../../kv.js';

export default async function handler(req, res) {
  const { id } = req.query;
  try {
    if (req.method === 'GET') {
      const rule = await kv.get(`automation:rule:${id}`);
      if (!rule) return res.status(404).json({ error: 'Rule not found' });
      return res.status(200).json(rule);
    }

    if (req.method === 'PATCH') {
      const rule = await kv.get(`automation:rule:${id}`);
      if (!rule) return res.status(404).json({ error: 'Rule not found' });
      const updated = { ...rule, ...req.body, id, updatedAt: new Date().toISOString() };
      await kv.set(`automation:rule:${id}`, updated);
      return res.status(200).json(updated);
    }

    if (req.method === 'DELETE') {
      const existing = await kv.get(`automation:rule:${id}`);
      if (!existing) return res.status(404).json({ error: 'Rule not found' });
      await kv.del(`automation:rule:${id}`);
      await kv.lrem('automation:rules:index', 0, id);
      return res.status(200).json({ deleted: id });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('rules-id handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

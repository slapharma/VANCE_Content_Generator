// lib/automation/handlers/jobs-index.js
import { kv } from '../../kv.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const ids = await kv.lrange('automation:jobs:index', 0, -1);
      if (!ids.length) return res.status(200).json([]);
      const jobs = await Promise.all(ids.map(id => kv.get(`automation:job:${id}`)));
      const valid = jobs.filter(Boolean);
      const { status, ruleId } = req.query;
      const filtered = valid.filter(j => {
        if (status && j.status !== status) return false;
        if (ruleId && j.ruleId !== ruleId) return false;
        return true;
      });
      return res.status(200).json(filtered);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('jobs-index handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

// lib/automation/handlers/jobs-id.js
import { kv } from '../../kv.js';

export default async function handler(req, res) {
  const { id } = req.query;
  if (req.method === 'GET') {
    const job = await kv.get(`automation:job:${id}`);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.status(200).json(job);
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

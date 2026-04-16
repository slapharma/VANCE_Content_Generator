import { kv } from '../../kv.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const kitIds = await kv.lrange('social:kits:index', 0, 49); // newest 50
    if (!kitIds || !kitIds.length) return res.status(200).json([]);

    const kits = await Promise.all(kitIds.map(id => kv.get(`social:kit:${id}`)));
    return res.status(200).json(kits.filter(Boolean));
  } catch (err) {
    console.error('[kits-index] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

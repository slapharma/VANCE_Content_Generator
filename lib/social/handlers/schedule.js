import { kv } from '../../kv.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Fetch all postRefs sorted by scheduledAt (score = epoch ms) — ascending order (default)
    const postRefIds = await kv.zrange('social:queue', 0, -1); // ascending by score (scheduledAt epoch ms) — default, no withScores needed

    if (!postRefIds || !postRefIds.length) return res.status(200).json([]);

    const postRefs = await Promise.all(postRefIds.map(id => kv.get(`social:postref:${id}`)));
    return res.status(200).json(postRefs.filter(Boolean));
  } catch (err) {
    console.error('[schedule] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

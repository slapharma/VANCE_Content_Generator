// lib/social/handlers/deploy.js
import { kv } from '../../kv.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { kitId } = req.body || {};
  if (!kitId) return res.status(400).json({ error: 'kitId is required' });

  try {
    const kit = await kv.get(`social:kit:${kitId}`);
    if (!kit) return res.status(404).json({ error: 'Kit not found' });

    const queued = [];
    const substack = 'substack'; // never queued

    for (const [platform, data] of Object.entries(kit.platforms)) {
      if (platform === substack) continue;
      if (!data.approved) continue;
      if (!data.scheduledAt) continue;

      const postRefId = `postref_${kitId}_${platform}`;
      const score = new Date(data.scheduledAt).getTime(); // epoch ms for sorted set

      const postRef = {
        id: postRefId,
        kitId,
        platform,
        scheduledAt: data.scheduledAt,
        status: 'queued',
        createdAt: new Date().toISOString(),
      };

      await kv.set(`social:postref:${postRefId}`, postRef);
      await kv.zadd('social:queue', { score, member: postRefId });
      queued.push(postRefId);
    }

    // Update kit status
    const updatedKit = { ...kit, status: 'scheduled', updatedAt: new Date().toISOString() };
    await kv.set(`social:kit:${kitId}`, updatedKit);

    return res.status(200).json({ queued, count: queued.length });
  } catch (err) {
    console.error('[deploy] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

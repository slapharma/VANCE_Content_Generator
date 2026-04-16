import { kv } from '../../kv.js';

export default async function handler(req, res, kitId) {
  try {
    if (req.method === 'GET') {
      const kit = await kv.get(`social:kit:${kitId}`);
      if (!kit) return res.status(404).json({ error: 'Kit not found' });
      return res.status(200).json(kit);
    }

    if (req.method === 'PATCH') {
      const kit = await kv.get(`social:kit:${kitId}`);
      if (!kit) return res.status(404).json({ error: 'Kit not found' });

      // Deep merge platforms if provided, shallow merge top-level fields
      const body = req.body || {};
      const updated = {
        ...kit,
        ...body,
        id: kitId,
        updatedAt: new Date().toISOString(),
        platforms: body.platforms
          ? mergePlatforms(kit.platforms, body.platforms)
          : kit.platforms,
      };

      await kv.set(`social:kit:${kitId}`, updated);
      return res.status(200).json(updated);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[kits-id] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Deep merge platform data so a PATCH of one platform doesn't wipe others
function mergePlatforms(existing, incoming) {
  const result = { ...existing };
  for (const [platform, data] of Object.entries(incoming)) {
    result[platform] = { ...(existing[platform] || {}), ...data };
  }
  return result;
}

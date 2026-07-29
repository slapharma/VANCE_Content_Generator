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

    if (req.method === 'DELETE') {
      const kit = await kv.get(`social:kit:${kitId}`);
      if (!kit) return res.status(404).json({ error: 'Kit not found' });

      await deleteKit(kit);
      return res.status(200).json({ id: kitId, deleted: true });
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

/**
 * Permanently remove a kit: queue entries (one per platform), index entry,
 * by-article pointer and the record itself. Mirrors carousel-store.js's
 * deleteCarousel — same reasoning throughout:
 *   - the by-article pointer is only cleared if it still points at *this* kit
 *     (a regen overwrites it, so a blind delete could orphan a newer kit)
 *   - already-posted platform refs are left alone; only queued ones are pulled
 *     and marked cancelled, preserving the audit trail
 * No external media cleanup needed — kit images/videos are remote URLs
 * (OpenRouter/FAL), not WP media ids.
 */
async function deleteKit(kit) {
  const platforms = Object.keys(kit.platforms || {});
  for (const platform of platforms) {
    const postRefId = `postref_${kit.id}_${platform}`;
    const removed = await kv.zrem('social:queue', postRefId);
    if (removed > 0) {
      const ref = await kv.get(`social:postref:${postRefId}`);
      if (ref && ref.status !== 'posted') {
        await kv.set(`social:postref:${postRefId}`, {
          ...ref, status: 'cancelled', cancelledAt: new Date().toISOString(),
        });
      }
    }
  }

  await kv.lrem('social:kits:index', 0, kit.id);

  if (kit.articleId) {
    const pointer = await kv.get(`social:kits:by-article:${kit.articleId}`);
    if (pointer === kit.id) await kv.del(`social:kits:by-article:${kit.articleId}`);
  }

  await kv.del(`social:kit:${kit.id}`);
}

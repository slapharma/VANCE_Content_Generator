// lib/social/handlers/cron.js
import { kv } from '../../kv.js';
import { dispatch } from '../platforms/index.js';

function isAuthorised(req) {
  const cronHeader = req.headers['x-vercel-cron'];
  const authHeader = req.headers['authorization'];
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  return cronHeader === '1' || authHeader === expectedAuth;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorised(req)) return res.status(401).json({ error: 'Unauthorised' });

  const nowMs = Date.now();

  try {
    // Fetch all postRef IDs due now (score <= nowMs)
    const dueIds = await kv.zrangebyscore('social:queue', 0, nowMs);
    if (!dueIds || !dueIds.length) return res.status(200).json({ processed: 0 });

    const results = [];

    for (const postRefId of dueIds) {
      // Atomically remove from queue before processing (prevents double-fire on concurrent crons)
      const removed = await kv.zrem('social:queue', postRefId);
      if (removed === 0) continue; // another cron already took it

      const postRef = await kv.get(`social:postref:${postRefId}`);
      if (!postRef) { console.warn(`[cron] postRef not found: ${postRefId}`); continue; }

      const kit = await kv.get(`social:kit:${postRef.kitId}`);
      if (!kit) { console.warn(`[cron] kit not found for postRef ${postRefId}: kitId=${postRef.kitId}`); continue; }

      const platformData = kit.platforms[postRef.platform];
      if (!platformData) { console.warn(`[cron] no platform data for ${postRef.platform} in kit ${postRef.kitId}`); continue; }

      try {
        const result = await dispatch(postRef.platform, platformData);

        // Update kit with posted info
        kit.platforms[postRef.platform] = {
          ...platformData,
          postedAt: new Date().toISOString(),
          platformPostId: result.postId || null,
        };
        kit.updatedAt = new Date().toISOString();
        await kv.set(`social:kit:${kit.id}`, kit);

        // Update postRef status
        await kv.set(`social:postref:${postRefId}`, { ...postRef, status: 'posted', postedAt: new Date().toISOString() });
        await kv.lpush('social:posted:index', postRefId);

        results.push({ postRefId, status: 'posted', platform: postRef.platform });
      } catch (err) {
        console.error(`[cron] failed to post ${postRefId}:`, err.message);

        // Re-enqueue with 30-minute retry
        const retryMs = nowMs + 30 * 60 * 1000;
        await kv.zadd('social:queue', { score: retryMs, member: postRefId });
        await kv.set(`social:postref:${postRefId}`, { ...postRef, status: 'retry', lastError: err.message });

        results.push({ postRefId, status: 'retry', error: err.message });
      }
    }

    return res.status(200).json({ processed: results.length, results });
  } catch (err) {
    console.error('[cron] fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}

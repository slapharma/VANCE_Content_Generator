// lib/social/handlers/post.js
import { kv } from '../../kv.js';
import { dispatch } from '../platforms/index.js';
import { resolveAccount } from '../accounts.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { kitId, platform } = req.body || {};
  if (!kitId || !platform) return res.status(400).json({ error: 'kitId and platform are required' });

  try {
    const kit = await kv.get(`social:kit:${kitId}`);
    if (!kit) return res.status(404).json({ error: 'Kit not found' });

    const platformData = kit.platforms[platform];
    if (!platformData) return res.status(400).json({ error: `Platform ${platform} not in kit` });

    // Resolve which connected account to post from (null → legacy env-var path).
    const account = await resolveAccount(platform, platformData.accountId);
    const result = await dispatch(platform, platformData, account);

    // Mark posted on kit
    const updatedKit = { ...kit, updatedAt: new Date().toISOString() };
    updatedKit.platforms[platform] = {
      ...platformData,
      postedAt: new Date().toISOString(),
      platformPostId: result.postId || null,
    };
    await kv.set(`social:kit:${kitId}`, updatedKit);

    // Prepend to posted history
    const postRefId = `postref_${kitId}_${platform}`;
    await kv.lpush('social:posted:index', postRefId);

    return res.status(200).json({ success: true, postId: result.postId });
  } catch (err) {
    console.error('[post] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

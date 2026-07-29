// lib/social/handlers/post.js
import { kv } from '../../kv.js';
import { dispatch } from '../platforms/index.js';
import { resolveAccount } from '../accounts.js';
import { withArticleLink } from '../article-link.js';

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
    // Enrich with the published article URL (used by LinkedIn's ARTICLE share).
    const dataForPost = await withArticleLink(platformData, kit);
    const result = await dispatch(platform, dataForPost, account);

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
    // The ref may not exist yet — this path bypasses the queue — so write one,
    // otherwise Social > Posted has an id pointing at nothing.
    const existingRef = await kv.get(`social:postref:${postRefId}`);
    await kv.set(`social:postref:${postRefId}`, {
      ...(existingRef || { id: postRefId, kitId, platform, createdAt: new Date().toISOString() }),
      status: 'posted',
      postedAt: new Date().toISOString(),
    });
    await kv.lrem('social:posted:index', 0, postRefId);
    await kv.lpush('social:posted:index', postRefId);
    await kv.ltrim('social:posted:index', 0, 499);

    return res.status(200).json({ success: true, postId: result.postId });
  } catch (err) {
    console.error('[post] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

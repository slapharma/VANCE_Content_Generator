import { kv } from '../../lib/kv.js';
import { randomUUID } from 'crypto';

// ── Pure helpers (exported for testing) ─────────────────────────────────────

export function buildContentItem(data) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: data.title,
    body: data.body ?? '',
    excerpt: data.excerpt ?? '',
    category: data.category ?? 'uncategorised',
    template: data.template ?? 'standard',
    model: data.model ?? null,
    status: 'draft',
    sourceId: data.sourceId ?? null,      // links back to archive item id
    heroImageUrl: data.heroImageUrl ?? null,   // stored for WP featured image upload
    heroImageType: data.heroImageType ?? null, // 'pexels' | 'ai'
    wpCategorySlug: data.wpCategorySlug ?? null, // per-category WP slug override
    createdAt: now,
    updatedAt: now,
    reviewers: [],
    approvals: [],
    rejections: [],
    requireAllApprovals: data.requireAllApprovals ?? false,
    scheduledAt: null,
    publishedAt: null,
    wpPostId: null,
  };
}

export function validateContentItem(data) {
  if (!data.title) throw new Error('title is required');
  // body is optional — allow empty articles (title-only drafts)
}

// ── HTTP handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const ids = await kv.lrange('content:index', 0, -1);
    if (!ids.length) return res.json([]);
    const items = await Promise.all(ids.map(id => kv.get(`content:${id}`)));
    return res.json(items.filter(Boolean).reverse());
  }

  if (req.method === 'POST') {
    try {
      validateContentItem(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const item = buildContentItem(req.body);
    await kv.set(`content:${item.id}`, item);
    await kv.lpush('content:index', item.id);
    return res.status(201).json(item);
  }

  res.status(405).json({ error: 'Method not allowed' });
}

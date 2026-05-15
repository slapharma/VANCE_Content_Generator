import { kv } from '../../../lib/kv.js';
import { getCurrentUser, requireRole } from '../../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { id } = req.query;
  const item = await kv.get(`content:${id}`);
  if (!item) return res.status(404).json({ error: 'Not found' });

  const me = await getCurrentUser(req);
  const guard = requireRole(me, 'admin', 'content');
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });

  const { newBody, newTitle } = req.body || {};
  if (!newBody || typeof newBody !== 'string') return res.status(400).json({ error: 'newBody is required' });

  const now = new Date().toISOString();
  const excerpt = newBody.replace(/^#.*$/gm, '').replace(/<[^>]+>/g, '').split(/\s+/).filter(Boolean).slice(0, 30).join(' ') + '…';
  const updated = {
    ...item,
    title: (newTitle || item.title || '').toString().trim() || item.title,
    body: newBody,
    excerpt,
    status: 'draft',
    priorRejectionComments: item.rejectionComments || [],
    rejectionComments: [],
    rejections: [],
    revisedByAi: {
      at: now,
      by: me.id,
      model: req.body?.model || null,
      addressedComments: req.body?.addressedCommentIndexes || [],
    },
    updatedAt: now,
  };
  await kv.set(`content:${id}`, updated);
  return res.json(updated);
}

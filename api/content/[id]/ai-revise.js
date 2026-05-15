import { kv } from '../../../lib/kv.js';
import { getCurrentUser, requireRole } from '../../../lib/auth.js';
import { callRevisionLLM, buildRevisionPrompt } from '../../../lib/revise.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { id } = req.query;
  const item = await kv.get(`content:${id}`);
  if (!item) return res.status(404).json({ error: 'Not found' });

  const me = await getCurrentUser(req);
  const guard = requireRole(me, 'admin', 'content');
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });

  const { commentIndexes, applyAll = false } = req.body || {};
  const allComments = Array.isArray(item.rejectionComments) ? item.rejectionComments : [];
  if (!allComments.length) return res.status(400).json({ error: 'This article has no rejection comments to revise from.' });

  let selected;
  if (applyAll) {
    selected = allComments;
  } else if (Array.isArray(commentIndexes) && commentIndexes.length) {
    selected = commentIndexes.map(i => allComments[i]).filter(Boolean);
  } else {
    return res.status(400).json({ error: 'Either applyAll=true or commentIndexes=[…] required' });
  }
  if (!selected.length) return res.status(400).json({ error: 'No matching comments to revise from' });

  const users = (await kv.get('users')) ?? (await kv.get('reviewers')) ?? [];
  const byId = new Map(users.map(u => [u.id, u]));
  const enriched = selected.map(c => ({
    ...c,
    reviewerName: byId.get(c.reviewerId)?.name || (typeof c.reviewerId === 'string' && c.reviewerId.includes('@') ? c.reviewerId : 'reviewer'),
  }));

  try {
    const { text, model } = await callRevisionLLM(buildRevisionPrompt({
      title: item.title || '',
      body: item.body || item.excerpt || '',
      comments: enriched,
    }));
    const lines = text.split('\n');
    let newTitle = item.title;
    const firstHeader = lines.find(l => /^#\s+/.test(l));
    if (firstHeader) newTitle = firstHeader.replace(/^#\s+/, '').trim();
    return res.json({
      proposedBody: text,
      proposedTitle: newTitle,
      addressedCommentIndexes: applyAll ? allComments.map((_, i) => i) : commentIndexes,
      model,
    });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}

import { kv } from '../../../lib/kv.js';
import { getCurrentUser, requireRole } from '../../../lib/auth.js';
import { logEvent } from '../../../lib/article-history.js';

// Append an in-app comment to an article. App-user comments share the same
// stream as reviewer "Request changes" feedback (stored in rejectionComments),
// but are attributed to the logged-in user and tagged viaApp:true so the UI can
// label them. Comments are feedback only — they never change the article body
// or its review status.
export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

  const { id } = req.query;
  const item = await kv.get(`content:${id}`);
  if (!item) return res.status(404).json({ error: 'Not found' });

  const me = await getCurrentUser(req);
  const guard = requireRole(me, 'admin', 'content');
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });

  // PATCH — resolve, unresolve, or soft-delete a comment by index
  if (req.method === 'PATCH') {
    const { action, index } = req.body || {};
    if (!['resolve', 'unresolve', 'delete'].includes(action)) {
      return res.status(400).json({ error: 'action must be resolve, unresolve, or delete' });
    }
    const idx = Number(index);
    if (!Number.isFinite(idx) || idx < 0 || !item.rejectionComments?.[idx]) {
      return res.status(400).json({ error: 'Invalid comment index' });
    }
    const now = new Date().toISOString();
    const c = item.rejectionComments[idx];
    if (action === 'resolve') {
      c.resolved = true; c.resolvedAt = now; c.resolvedBy = me.id;
    } else if (action === 'unresolve') {
      delete c.resolved; delete c.resolvedAt; delete c.resolvedBy;
    } else {
      c.deleted = true; c.deletedAt = now; c.deletedBy = me.id;
    }
    item.updatedAt = now;
    await kv.set(`content:${id}`, item);
    return res.json(item);
  }

  const overall = (req.body?.overall || '').toString().trim();

  let highlights = [];
  if (Array.isArray(req.body?.highlights)) {
    highlights = req.body.highlights
      .filter(h => h && typeof h.quote === 'string' && typeof h.comment === 'string')
      .map(h => ({ quote: h.quote.slice(0, 1000), comment: h.comment.slice(0, 2000) }));
  }

  if (!overall && !highlights.length) {
    return res.status(400).json({ error: 'A comment or at least one inline note is required' });
  }

  // Merge inline notes + overall into `comment` so legacy surfaces (and AI revise)
  // see the full text, exactly like the reviewer flow.
  const preamble = highlights
    .map(h => `> "${h.quote.replace(/\s+/g, ' ').trim()}"\n↳ ${h.comment}`)
    .join('\n\n');
  const comment = [preamble, overall].filter(Boolean).join('\n\n');

  const now = new Date().toISOString();
  const authorName = me.name || me.email || me.id;
  item.rejectionComments = [
    ...(item.rejectionComments || []),
    { reviewerId: me.id, authorName, comment, overall, at: now, highlights, viaApp: true },
  ];
  item.updatedAt = now;
  logEvent(item, {
    type: 'comment', actor: authorName, at: now,
    detail: { hasOverall: !!overall, inlineNotes: highlights.length },
  });
  await kv.set(`content:${id}`, item);
  return res.json(item);
}

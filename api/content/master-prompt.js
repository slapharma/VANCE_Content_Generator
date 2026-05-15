import { kv } from '../../lib/kv.js';
import { getCurrentUser, requireRole } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated' });
    const rec = (await kv.get('vance:master-prompt')) || { text: '', updatedAt: null };
    return res.json(rec);
  }
  if (req.method === 'PUT') {
    const me = await getCurrentUser(req);
    const guard = requireRole(me, 'admin', 'content');
    if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
    const text = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
    const rec = { text, updatedAt: new Date().toISOString(), updatedBy: me.id };
    await kv.set('vance:master-prompt', rec);
    return res.json(rec);
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

import { getCurrentUser, requireRole } from '../../lib/auth.js';
import { getAbConfig, saveAbConfig } from '../../lib/ab-test.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated' });
    return res.json(await getAbConfig());
  }
  if (req.method === 'PUT') {
    const me = await getCurrentUser(req);
    const guard = requireRole(me, 'admin', 'content');
    if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
    const saved = await saveAbConfig(req.body || {});
    return res.json(saved);
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

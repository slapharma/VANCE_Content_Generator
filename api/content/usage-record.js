import { recordLlmUsage } from '../../lib/usage.js';
import { getCurrentUser } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const { model, usage, source } = req.body || {};
  if (!model || !usage) return res.status(400).json({ error: 'model and usage required' });
  await recordLlmUsage({ model, usage, source: source ?? 'client', userId: me.id });
  return res.json({ ok: true });
}

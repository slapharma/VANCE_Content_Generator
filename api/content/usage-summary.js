import { summarizeUsage } from '../../lib/usage.js';
import { getCurrentUser } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  return res.json(await summarizeUsage());
}

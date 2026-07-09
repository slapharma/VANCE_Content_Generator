import { summarizeUsage } from '../../lib/usage.js';
import { getCurrentUser } from '../../lib/auth.js';
import { loadUsers } from '../../lib/users.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const summary = await summarizeUsage();
  const users = await loadUsers();
  summary.users = summary.users.map(u => {
    if (!u.userId) return { ...u, name: 'Automation / System', email: null, appRole: null };
    const match = users.find(x => x.id === u.userId);
    return match
      ? { ...u, name: match.name, email: match.email, appRole: match.appRole }
      : { ...u, name: 'Deleted user', email: null, appRole: null };
  });
  return res.json(summary);
}

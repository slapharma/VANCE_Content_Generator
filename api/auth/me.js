import { getCurrentUser } from '../../lib/auth.js';
import { loadUsers } from '../../lib/users.js';
import { withErrorBoundary } from '../../lib/api.js';

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const users = await loadUsers();
  const full = users.find(u => u.id === me.id);
  return res.json({ ...me, mustChangePassword: full?.mustChangePassword ?? false });
}

export default withErrorBoundary(handler);

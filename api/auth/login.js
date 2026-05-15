import { loadUsers, safe } from '../../lib/users.js';
import { verifyPassword, signSession, setSessionCookie } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const users = await loadUsers();
  const user = users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = await signSession(user.id);
  setSessionCookie(res, token);
  return res.json({ user: safe(user) });
}

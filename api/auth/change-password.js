import { getCurrentUser, hashPassword, verifyPassword } from '../../lib/auth.js';
import { loadUsers, saveUsers } from '../../lib/users.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const me = await getCurrentUser(req);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'newPassword must be at least 4 characters' });
  }
  const users = await loadUsers();
  const idx = users.findIndex(u => u.id === me.id);
  if (idx === -1) return res.status(404).json({ error: 'User missing' });
  if (!users[idx].mustChangePassword) {
    if (!oldPassword || !verifyPassword(oldPassword, users[idx].passwordHash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
  }
  users[idx].passwordHash = hashPassword(newPassword);
  users[idx].mustChangePassword = false;
  users[idx].updatedAt = new Date().toISOString();
  await saveUsers(users);
  return res.json({ ok: true });
}

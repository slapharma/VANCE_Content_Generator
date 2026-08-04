import { getCurrentUser, requireRole, hashPassword, SEED_PASSWORD } from '../../lib/auth.js';
import {
  APP_ROLES, validUser, buildUser, safe, loadUsers, saveUsers,
} from '../../lib/users.js';

export function validateReviewer(data) { return validUser(data); }
export function buildReviewer(data) { return buildUser({ ...data, password: data.password ?? SEED_PASSWORD, mustChangePassword: false }); }

export default async function handler(req, res) {
  const me = await getCurrentUser(req);

  // Reading the directory requires being signed in — any role, because reviewer
  // names are resolved from it all over the app, not just in Settings.
  //
  // This branch used to sit ABOVE the auth check, so the whole user list was
  // world-readable: names, email addresses, roles, Google account ids and
  // profile picture URLs, returned to any anonymous caller. `safe()` strips the
  // password hash and nothing else, so it looked deliberate. The write methods
  // below were always admin-gated; only the read was missed.
  if (req.method === 'GET') {
    if (!me) return res.status(401).json({ error: 'Not authenticated' });
    const users = await loadUsers();
    return res.json(users.map(safe));
  }

  const guard = requireRole(me, 'admin');
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });

  if (req.method === 'POST') {
    try { validUser(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
    const users = await loadUsers();
    if (users.find(u => u.email.toLowerCase() === req.body.email.toLowerCase())) {
      return res.status(409).json({ error: 'A user with that email already exists' });
    }
    const user = buildUser({ ...req.body, password: req.body.password ?? SEED_PASSWORD, mustChangePassword: req.body.mustChangePassword ?? true });
    users.push(user);
    await saveUsers(users);
    return res.status(201).json(safe(user));
  }

  if (req.method === 'PATCH') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const users = await loadUsers();
    const idx = users.findIndex(u => u.id === id);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    const u = users[idx];
    if (req.body.name !== undefined) u.name = req.body.name;
    if (req.body.email !== undefined) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.email)) return res.status(400).json({ error: 'email is invalid' });
      u.email = req.body.email;
    }
    if (req.body.appRole !== undefined) {
      if (!APP_ROLES.includes(req.body.appRole)) return res.status(400).json({ error: 'invalid appRole' });
      if (u.appRole === 'admin' && req.body.appRole !== 'admin') {
        const adminCount = users.filter(x => x.appRole === 'admin').length;
        if (adminCount <= 1) return res.status(400).json({ error: 'Cannot demote the last admin' });
      }
      u.appRole = req.body.appRole;
    }
    if (req.body.role !== undefined) u.role = req.body.role;
    if (req.body.resetPassword === true) {
      u.passwordHash = hashPassword(SEED_PASSWORD);
      u.mustChangePassword = true;
    }
    u.updatedAt = new Date().toISOString();
    await saveUsers(users);
    return res.json(safe(u));
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    const users = await loadUsers();
    const target = users.find(u => u.id === id);
    if (target?.appRole === 'admin' && users.filter(u => u.appRole === 'admin').length <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last admin' });
    }
    const next = users.filter(u => u.id !== id);
    await saveUsers(next);
    return res.status(204).end();
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

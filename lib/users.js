import { kv } from './kv.js';
import { randomUUID } from 'crypto';
import { hashPassword, INITIAL_USERS, SEED_PASSWORD, bustUsersCache } from './auth.js';

export const APP_ROLES = ['user', 'content', 'admin'];

export function validUser(data) {
  if (!data.email) throw new Error('email is required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw new Error('email is invalid');
  if (data.appRole && !APP_ROLES.includes(data.appRole)) throw new Error('appRole must be user, content, or admin');
}

export function buildUser(data) {
  return {
    id: randomUUID(),
    name: data.name ?? data.email,
    email: data.email,
    appRole: data.appRole ?? 'user',
    role: data.role ?? 'must_approve',
    passwordHash: hashPassword(data.password ?? SEED_PASSWORD),
    mustChangePassword: data.mustChangePassword ?? true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function safe(u) {
  if (!u) return u;
  const { passwordHash, ...rest } = u;
  return rest;
}

export async function loadUsers() {
  let users = await kv.get('users');
  if (Array.isArray(users)) return users;

  const legacy = (await kv.get('reviewers')) ?? [];
  const seeded = INITIAL_USERS.map(u => buildUser({ ...u, password: SEED_PASSWORD, mustChangePassword: true }));
  for (const r of legacy) {
    if (!seeded.find(s => s.email.toLowerCase() === (r.email || '').toLowerCase())) {
      seeded.push(buildUser({ name: r.name, email: r.email, appRole: 'user', password: SEED_PASSWORD, mustChangePassword: true }));
    }
  }
  await kv.set('users', seeded);
  await kv.set('reviewers', seeded.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role })));
  bustUsersCache();
  return seeded;
}

export async function saveUsers(users) {
  await kv.set('users', users);
  await kv.set('reviewers', users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role })));
  bustUsersCache();
}

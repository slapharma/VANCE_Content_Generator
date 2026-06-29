// lib/auth.js — password hashing + JWT session helpers
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { kv } from './kv.js';

const SESSION_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? 'dev-secret-replace-in-production'
);
const COOKIE_NAME = 'vance_session';
const SESSION_TTL_DAYS = 30;

// ── Password hashing (scrypt; no extra deps) ──────────────────────────────────

export function hashPassword(plain) {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(plain, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ── Session JWTs ──────────────────────────────────────────────────────────────

export async function signSession(userId) {
  return new SignJWT({ uid: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_DAYS}d`)
    .sign(SESSION_SECRET);
}

async function verifySession(token) {
  try {
    const { payload } = await jwtVerify(token, SESSION_SECRET);
    return payload.uid;
  } catch {
    return null;
  }
}

// ── Cookie plumbing ───────────────────────────────────────────────────────────

function parseCookies(header) {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map(c => {
      const [k, ...rest] = c.trim().split('=');
      return [k, decodeURIComponent(rest.join('='))];
    })
  );
}

export function setSessionCookie(res, token) {
  const maxAge = SESSION_TTL_DAYS * 24 * 60 * 60;
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
  );
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

// ── User lookup + auth guard ──────────────────────────────────────────────────

// ── Hot-path cache for the `users` list ───────────────────────────────────────
// getCurrentUser runs on every authenticated request; without this it reads the
// full `users` key from KV each time, which dominates KV request volume. Cache
// it briefly per warm serverless instance. Writes (saveUsers, and loadUsers
// seeding) call bustUsersCache() so role/password changes propagate within
// USERS_CACHE_TTL_MS on the same instance; other instances catch up by TTL.
let _usersCache = null;
const USERS_CACHE_TTL_MS = 10_000;
export function bustUsersCache() { _usersCache = null; }
async function readUsersForAuth() {
  const now = Date.now();
  if (_usersCache && (now - _usersCache.at) < USERS_CACHE_TTL_MS) return _usersCache.data;
  const data = (await kv.get('users')) ?? [];
  _usersCache = { at: now, data };
  return data;
}

export async function getCurrentUser(req) {
  const cookies = parseCookies(req.headers?.cookie);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const uid = await verifySession(token);
  if (!uid) return null;
  const users = await readUsersForAuth();
  const u = users.find(x => x.id === uid);
  if (!u) return null;
  // Never leak the password hash to callers
  const { passwordHash, ...safe } = u;
  return safe;
}

export function requireRole(user, ...allowed) {
  if (!user) return { ok: false, status: 401, error: 'Not authenticated' };
  if (!allowed.includes(user.appRole)) {
    return { ok: false, status: 403, error: `Requires role: ${allowed.join(' or ')}` };
  }
  return { ok: true };
}

// ── Seed data ─────────────────────────────────────────────────────────────────

export const INITIAL_USERS = [
  { name: 'Clifton Flack', email: 'cflack@slapharma.com',  appRole: 'admin'   },
  { name: 'Justin Slagel', email: 'jslagel@slapharma.com', appRole: 'content' },
  { name: 'Laura Slagel',  email: 'lslagel@slapharma.com', appRole: 'content' },
  { name: 'Mia Yaniv',     email: 'myaniv@slapharma.com',  appRole: 'content' },
  { name: 'Daisy Gershon', email: 'dgershon@slapharma.com', appRole: 'user'   },
];
export const SEED_PASSWORD = '2026';

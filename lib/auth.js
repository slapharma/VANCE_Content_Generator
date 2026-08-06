// lib/auth.js — password hashing + JWT session helpers
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { kv } from './kv.js';
import { ssoEmail } from './vance-sso.js';
import { reportPassportUse } from './passport-report.js';
import { matchGoogleUser } from './auth/google-login.js';

const SESSION_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET ?? 'dev-secret-replace-in-production'
);
const COOKIE_NAME = 'vance_session';

/**
 * One working day, matching the CS console, the Alerts dashboard and the Vance
 * Passport itself.
 *
 * This was 30 days. Sessions across the estate are stateless — there is no
 * store to read, which is what lets sign-in keep working during a KV or
 * Postgres outage — and the price of that is a session cannot be revoked
 * before it expires. A 30-day window meant a copied cookie stayed good for a
 * month, and it meant somebody removed from the user list kept their session
 * far longer than anyone would assume.
 *
 * 12 hours bounds that to a shift. The visible cost is that people sign in
 * more often than they used to; with the Passport that is once a day, for the
 * whole estate rather than per app.
 */
const SESSION_TTL_HOURS = 12;

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
    .setExpirationTime(`${SESSION_TTL_HOURS}h`)
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
  const maxAge = SESSION_TTL_HOURS * 60 * 60;
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

  // 1. This app's own session. Checked first so the Content Generator keeps
  //    working on its own login regardless of what the rest of the estate is
  //    doing, and so there is still a way in if the Passport is misconfigured.
  const token = cookies[COOKIE_NAME];
  if (token) {
    const uid = await verifySession(token);
    if (uid) {
      const users = await readUsersForAuth();
      const u = users.find(x => x.id === uid);
      // Never leak the password hash to callers
      if (u) { const { passwordHash, ...safe } = u; return safe; }
      return null;
    }
  }

  // 2. The estate-wide Vance Passport, issued by V-Net. Verified OFFLINE —
  //    an HMAC check against a shared secret, with no network call to V-Net.
  //
  //    A Passport proves WHO somebody is. It does not create an account here:
  //    `matchGoogleUser` still has to resolve the address to an existing user
  //    record, and a valid Passport for an unknown address returns null. That
  //    is the rule this app's Google login already applies — being on the
  //    domain is not enough — and the Passport must not become a way round it.
  //
  //    `appRole` therefore always comes from the KV record, never from the
  //    token, so a role change takes effect on the next request.
  const passport = ssoEmail(req);
  if (!passport) return null;

  const users = await readUsersForAuth();
  // Read-only on purpose. matchGoogleUser is pure and may report `migrateTo`
  // for somebody still on the legacy domain; the migration WRITE stays in the
  // interactive Google callback. An ordinary page request must not rewrite the
  // user list as a side effect — it would mean every request from a
  // not-yet-migrated account was a KV write.
  const match = matchGoogleUser(users, passport);
  if (!match?.user) return null;

  // Tell HQ this app was reached on this session, so its admin page can show a
  // real number instead of "Not reporting". Deliberately AFTER the user record
  // resolves, so it counts people who actually got in — a valid Passport for an
  // address with no account here is not a use of the Content Generator.
  //
  // Not awaited, cannot throw, and adds nothing to this request: if HQ is down
  // it does nothing and nobody finds out. The offline verification above must
  // not acquire a dependency on HQ being up.
  reportPassportUse(req, 'content');

  const { passwordHash, ...safe } = match.user;
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

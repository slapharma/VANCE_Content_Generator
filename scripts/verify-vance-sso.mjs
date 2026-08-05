/**
 * Verification for Vance Passport acceptance in the Content Generator.
 *
 * This app has the most to lose from getting it wrong: it has real roles
 * (admin / content / reviewer), a KV-backed user list, and a legacy-domain
 * migration path. The properties asserted here:
 *
 *   1. A Passport does NOT create an account. `matchGoogleUser` must resolve
 *      the address to an existing record — the same rule the Google login
 *      already applies.
 *   2. `appRole` comes from the KV record, never from the token.
 *   3. The legacy domain still resolves, and resolving it performs NO write —
 *      an ordinary page request must not rewrite the user list as a side
 *      effect.
 *   4. The app's own session keeps priority, so it still stands alone.
 *   5. The password hash never leaks to a caller, by either route.
 *
 *   node scripts/verify-vance-sso.mjs
 *
 * KV is stubbed, so this runs with no network and no Vercel environment.
 */

import { createHmac } from 'node:crypto';

const SSO_SECRET = 'shared-estate-secret-hhhhhhhhhhhh';
process.env.VANCE_SSO_SECRET = SSO_SECRET;
process.env.JWT_SECRET = 'content-generator-own-secret-iiii';
process.env.GOOGLE_LOGIN_DOMAIN = 'slapharmagroup.com';
process.env.GOOGLE_LEGACY_DOMAIN = 'slapharma.com';

/* ── Stub KV before lib/auth.js imports it ──────────────────────────────────
   A tiny module-mock via a loader would be heavier than this: kv.js reads its
   config lazily, so setting the store here and importing after is enough. */
const USERS = [
  { id: 'u1', name: 'Boss',   email: 'boss@slapharmagroup.com', appRole: 'admin',    passwordHash: 'SECRET-HASH-1' },
  { id: 'u2', name: 'Writer', email: 'writer@slapharma.com',    appRole: 'content',  passwordHash: 'SECRET-HASH-2' },
  { id: 'u3', name: 'Dup A',  email: 'dup@slapharma.com',       appRole: 'content',  passwordHash: 'SECRET-HASH-3' },
  { id: 'u4', name: 'Dup B',  email: 'dup@slapharma.com',       appRole: 'reviewer', passwordHash: 'SECRET-HASH-4' },
];

let kvWrites = 0;
const { kv } = await import('../lib/kv.js');
kv.get = async (key) => (key === 'users' ? JSON.parse(JSON.stringify(USERS)) : null);
kv.set = async () => { kvWrites++; };

const { getCurrentUser, signSession, bustUsersCache } = await import('../lib/auth.js');

let pass = 0;
let fail = 0;

function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}`); }
}

function passport(email, secret = SSO_SECRET, ttlMs = 12 * 3600 * 1000, v = 1) {
  const now = Date.now();
  const body = Buffer.from(
    JSON.stringify({ v, sub: String(email).toLowerCase(), iat: now, exp: now + ttlMs })
  ).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

const req = (cookie) => ({ headers: { cookie } });
const withPassport = (email, ...a) => req(`vance_sso=${passport(email, ...a)}`);

console.log('\n  Passport acceptance\n');

{
  bustUsersCache();
  const u = await getCurrentUser(withPassport('boss@slapharmagroup.com'));
  check('a valid Passport for a known user signs them in', u?.email === 'boss@slapharmagroup.com');
  check('the role comes from the KV record, not the token', u?.appRole === 'admin');
  check('the password hash is never returned', u && !('passwordHash' in u));
}

check('no cookie means nobody', (await getCurrentUser(req(''))) === null);

console.log('\n  A Passport is not an account\n');

check(
  'a valid Passport for an address with NO user record is refused',
  (await getCurrentUser(withPassport('stranger@slapharmagroup.com'))) === null
);
check(
  'an off-domain Passport is refused',
  (await getCurrentUser(withPassport('someone@gmail.com'))) === null
);
check(
  'a Passport signed with the wrong secret is refused',
  (await getCurrentUser(withPassport('boss@slapharmagroup.com', 'another-secret-entirely'))) === null
);
check(
  'an expired Passport is refused',
  (await getCurrentUser(withPassport('boss@slapharmagroup.com', SSO_SECRET, -1000))) === null
);
check(
  'an unknown Passport version is refused',
  (await getCurrentUser(withPassport('boss@slapharmagroup.com', SSO_SECRET, 3600_000, 99))) === null
);
{
  const [, sig] = passport('boss@slapharmagroup.com').split('.');
  const forged = Buffer.from(
    JSON.stringify({ v: 1, sub: 'boss@slapharmagroup.com', iat: Date.now(), exp: Date.now() + 1e7 })
  ).toString('base64url');
  check(
    'a re-signed payload with a stolen signature is refused',
    (await getCurrentUser(req(`vance_sso=${forged}.${sig}`))) === null
  );
}
check('garbage in the cookie does not throw', (await getCurrentUser(req('vance_sso=nonsense'))) === null);

console.log('\n  Legacy domain, without writing\n');

{
  kvWrites = 0;
  bustUsersCache();
  // writer@slapharma.com is the record; the Passport carries the new domain.
  const u = await getCurrentUser(withPassport('writer@slapharmagroup.com'));
  check('a not-yet-migrated user still resolves via the legacy domain', u?.id === 'u2');
  check('and keeps their own role', u?.appRole === 'content');
  check('resolving them performs NO write to the user list', kvWrites === 0);
}

check(
  'an ambiguous legacy match (two records) is refused rather than guessed',
  (await getCurrentUser(withPassport('dup@slapharmagroup.com'))) === null
);

console.log('\n  The app still stands alone\n');

{
  bustUsersCache();
  const native = await signSession('u1');
  const u = await getCurrentUser(req(`vance_session=${native}`));
  check("the app's own session still signs you in", u?.id === 'u1');
  check('and still hides the password hash', u && !('passwordHash' in u));
}

{
  const native = await signSession('u1');
  const u = await getCurrentUser(req(`vance_session=${native}; vance_sso=${passport('writer@slapharmagroup.com')}`));
  check('the app session takes priority over a Passport for someone else', u?.id === 'u1');
}

{
  const u = await getCurrentUser(req(`vance_session=rubbish; vance_sso=${passport('boss@slapharmagroup.com')}`));
  check('an invalid app session falls through to a valid Passport', u?.id === 'u1');
}

{
  const stale = await signSession('deleted-user-id');
  check(
    'a session for a deleted user is refused, not fallen through',
    (await getCurrentUser(req(`vance_session=${stale}`))) === null
  );
}

console.log('\n  Session lifetime\n');

{
  const token = await signSession('u1');
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  const hours = (claims.exp - claims.iat) / 3600;
  check(`a new session lasts 12 hours, not 30 days (got ${hours}h)`, hours === 12);
}

console.log('\n  Verification is offline\n');

{
  const realFetch = global.fetch;
  global.fetch = () => { throw new Error('getCurrentUser attempted a network call'); };
  let ok = false;
  try {
    bustUsersCache();
    ok = (await getCurrentUser(withPassport('boss@slapharmagroup.com')))?.id === 'u1';
  } finally {
    global.fetch = realFetch;
  }
  check('signing in with a Passport makes no network call', ok);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

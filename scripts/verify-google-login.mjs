/**
 * Google sign-in verification. `npm run verify:login`
 *
 * No network, no credentials, no KV. Pure functions only, which is why the
 * matching logic was pulled out of the callback in the first place.
 *
 * The cases that matter are the refusals. This gate is the only thing standing
 * between a Google account and someone else's admin session, and the failure
 * mode of a domain check is silent: a suffix test that lets
 * `evil@notslapharmagroup.com` through looks identical to a correct one until
 * somebody registers that domain.
 */

import assert from 'node:assert';
import {
  emailDomain, emailLocalPart, matchGoogleUser, applyEmailMigration,
  loginDomain, legacyDomain,
} from '../lib/auth/google-login.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name} ${extra}`);
  }
};

/* The real shape of the user list, as read from production on 2026-08-04. */
const USERS = () => [
  { id: 'u1', email: 'cflack@slapharma.com', appRole: 'admin', role: 'must_approve' },
  { id: 'u2', email: 'jslagel@slapharma.com', appRole: 'content', role: 'must_approve' },
  { id: 'u3', email: 'lslagel@slapharma.com', appRole: 'content', role: 'must_approve' },
  { id: 'u4', email: 'myaniv@slapharma.com', appRole: 'admin', role: 'must_approve' },
  { id: 'u5', email: 'dgershon@slapharma.com', appRole: 'admin', role: 'must_approve' },
  { id: 'u6', email: 'cliftonflack@gmail.com', appRole: 'content', role: 'must_approve' },
];

/* ── 1. Domain parsing ────────────────────────────────────────────────────── */
console.log('\n1. Domain parsing');
{
  ok('plain address', emailDomain('cflack@slapharmagroup.com') === 'slapharmagroup.com');
  ok('case is normalised', emailDomain('CFlack@SlapharmaGroup.COM') === 'slapharmagroup.com');
  ok('surrounding space ignored', emailDomain('  cflack@slapharmagroup.com  ') === 'slapharmagroup.com');
  ok('no @ yields empty', emailDomain('not-an-address') === '');
  ok('empty input yields empty', emailDomain('') === '' && emailDomain(null) === '' && emailDomain(undefined) === '');

  // The two shapes a suffix check would wave through.
  ok('a lookalike domain is a DIFFERENT domain',
    emailDomain('evil@notslapharmagroup.com') !== 'slapharmagroup.com',
    emailDomain('evil@notslapharmagroup.com'));
  ok('a subdomain of an attacker domain is not ours',
    emailDomain('x@slapharmagroup.com.attacker.net') !== 'slapharmagroup.com',
    emailDomain('x@slapharmagroup.com.attacker.net'));

  // An `@` in the local part must not smuggle a domain past the split.
  ok('splits on the LAST @', emailDomain('a@b@slapharmagroup.com') === 'slapharmagroup.com');
  ok('local part is everything before it', emailLocalPart('a@b@slapharmagroup.com') === 'a@b');
  ok('local part of a normal address', emailLocalPart('cflack@slapharmagroup.com') === 'cflack');

  ok('defaults are the two real domains',
    loginDomain({}) === 'slapharmagroup.com' && legacyDomain({}) === 'slapharma.com');
  ok('both are overridable', loginDomain({ GOOGLE_LOGIN_DOMAIN: 'example.test' }) === 'example.test');
}

/* ── 2. Exact match still wins ────────────────────────────────────────────── */
console.log('\n2. Exact match');
{
  const users = USERS();
  const m = matchGoogleUser(users, 'cliftonflack@gmail.com');
  ok('a registered gmail resolves', m?.user?.id === 'u6');
  ok('and is not treated as a migration', m?.migrateTo === null);

  ok('case-insensitive', matchGoogleUser(users, 'CFlack@Slapharma.COM')?.user?.id === 'u1');

  // Once migrated, the record is on the new domain and must resolve exactly —
  // not fall through to the migration branch a second time.
  const migrated = [{ id: 'u1', email: 'cflack@slapharmagroup.com', appRole: 'admin' }];
  const again = matchGoogleUser(migrated, 'cflack@slapharmagroup.com');
  ok('an already-migrated user matches exactly', again?.user?.id === 'u1');
  ok('and does not migrate twice', again?.migrateTo === null);
}

/* ── 3. Migration ─────────────────────────────────────────────────────────── */
console.log('\n3. Same person, new domain');
{
  const users = USERS();
  const m = matchGoogleUser(users, 'cflack@slapharmagroup.com');
  ok('resolves the legacy record by prefix', m?.user?.id === 'u1');
  ok('flags the address to move to', m?.migrateTo === 'cflack@slapharmagroup.com');

  const before = { ...m.user };
  applyEmailMigration(m.user, m.migrateTo, new Date('2026-08-04T12:00:00Z'));
  ok('email moves to the new domain', m.user.email === 'cflack@slapharmagroup.com');
  ok('the old address is kept for audit', m.user.previousEmail === 'cflack@slapharma.com');
  ok('the migration is timestamped', m.user.emailMigratedAt === '2026-08-04T12:00:00.000Z');

  // The load-bearing assertion of this whole file: signing in must not be a
  // route to a different permission set.
  ok('id is unchanged', m.user.id === before.id);
  ok('appRole is unchanged', m.user.appRole === before.appRole, `${before.appRole} → ${m.user.appRole}`);
  ok('role is unchanged', m.user.role === before.role);

  ok('every other legacy user resolves too',
    ['jslagel', 'lslagel', 'myaniv', 'dgershon'].every(
      (p) => matchGoogleUser(USERS(), `${p}@slapharmagroup.com`)?.migrateTo === `${p}@slapharmagroup.com`
    ));
}

/* ── 4. Refusals ──────────────────────────────────────────────────────────── */
console.log('\n4. Refusals — no account is ever created');
{
  const users = USERS();

  ok('an unregistered address on OUR domain is refused',
    matchGoogleUser(users, 'newstarter@slapharmagroup.com') === null);
  ok('...which is the whole "no auto-provisioning" decision',
    users.length === 6);

  ok('a lookalike domain is refused',
    matchGoogleUser(users, 'cflack@notslapharmagroup.com') === null);
  ok('an attacker subdomain is refused',
    matchGoogleUser(users, 'cflack@slapharmagroup.com.attacker.net') === null);
  ok('an unrelated consumer gmail is refused',
    matchGoogleUser(users, 'someone@gmail.com') === null);
  ok('a prefix that matches nobody is refused',
    matchGoogleUser(users, 'nobody@slapharmagroup.com') === null);
  ok('empty input is refused', matchGoogleUser(users, '') === null && matchGoogleUser(users, null) === null);
  ok('an empty user list refuses everything',
    matchGoogleUser([], 'cflack@slapharmagroup.com') === null);

  // Migration only runs from the one legacy domain. A third domain sharing a
  // prefix must not be adopted.
  const other = [{ id: 'x', email: 'cflack@someothercompany.com', appRole: 'admin' }];
  ok('only the legacy domain migrates', matchGoogleUser(other, 'cflack@slapharmagroup.com') === null);

  // Two records sharing a prefix: a human has to resolve that, not a login.
  const collide = [
    { id: 'a', email: 'cflack@slapharma.com', appRole: 'admin' },
    { id: 'b', email: 'cflack@slapharma.com', appRole: 'user' },
  ];
  ok('a prefix collision refuses rather than guessing',
    matchGoogleUser(collide, 'cflack@slapharmagroup.com') === null);

  // And if the target address is already taken by a different record, the exact
  // match owns it — the legacy record is not folded in behind it.
  const both = [
    { id: 'old', email: 'cflack@slapharma.com', appRole: 'admin' },
    { id: 'new', email: 'cflack@slapharmagroup.com', appRole: 'user' },
  ];
  const r = matchGoogleUser(both, 'cflack@slapharmagroup.com');
  ok('an existing new-domain record wins outright', r?.user?.id === 'new');
  ok('and nothing is merged into it', r?.migrateTo === null);
}

/* ── Summary ──────────────────────────────────────────────────────────────── */
console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
assert.equal(fail, 0, `${fail} sign-in assertion(s) failed`);

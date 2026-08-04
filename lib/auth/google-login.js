// lib/auth/google-login.js — Google Sign-In (identity only, existing users only).
// Separate from lib/auth/oauth.js, which handles the Drive/Gmail/Calendar
// data-access connection (broader scopes, refresh tokens, its own KV keys).
// This module never touches auth:google:creds/tokens.

import { randomBytes } from 'crypto';

export const STATE_COOKIE = 'vance_glogin_state';

/**
 * Read an OAuth credential, tolerating surrounding whitespace.
 *
 * A secret pasted into a terminal prompt or a dashboard field very often arrives
 * with a trailing newline. Google does not trim it either — it answers
 * `invalid_client`, which reads exactly like a revoked or mistyped credential and
 * sends whoever is debugging to the Cloud console rather than to the env var.
 *
 * Empty-after-trim collapses to null, so a variable set to whitespace counts as
 * "not configured" and the login button stays hidden, rather than being treated
 * as a real credential that always fails.
 */
export function readOAuthEnv(name, env = process.env) {
  const v = env[name];
  return (typeof v === 'string' ? v.trim() : '') || null;
}

export const googleClientId = (env = process.env) => readOAuthEnv('GOOGLE_OAUTH_CLIENT_ID', env);
export const googleClientSecret = (env = process.env) => readOAuthEnv('GOOGLE_OAUTH_CLIENT_SECRET', env);

/* ── Which Google accounts may sign in ──────────────────────────────────────
   The company moved from @slapharma.com to @slapharmagroup.com. Everyone's
   Google identity is on the new domain; every user record here is still on the
   old one, with the same prefix (cflack → cflack). So a sign-in has to be able
   to recognise `cflack@slapharmagroup.com` as the existing `cflack@slapharma.com`
   account and carry that record over.

   What this deliberately does NOT do is create accounts. Being on the domain is
   not by itself permission to be here: a new Workspace mailbox grants nothing
   until an admin adds the user. Recognising an existing person under a new
   address, and admitting a new person, are different questions.
   ────────────────────────────────────────────────────────────────────────── */

export const loginDomain = (env = process.env) => readOAuthEnv('GOOGLE_LOGIN_DOMAIN', env) ?? 'slapharmagroup.com';
export const legacyDomain = (env = process.env) => readOAuthEnv('GOOGLE_LEGACY_DOMAIN', env) ?? 'slapharma.com';

/**
 * The domain part of an address: everything after the LAST `@`, lowercased.
 *
 * Compared whole, never with `endsWith`, and this is the security-critical part
 * of the file. `evil@notslapharmagroup.com` ends with "slapharmagroup.com", and
 * `x@slapharmagroup.com.attacker.net` contains it — both would pass a suffix
 * test and neither is us. Splitting on the last `@` also means a local part
 * containing an `@` cannot smuggle a second domain past this.
 */
export function emailDomain(email) {
  const s = String(email ?? '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  return at === -1 ? '' : s.slice(at + 1);
}

/** The part before the last `@`, lowercased. */
export function emailLocalPart(email) {
  const s = String(email ?? '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  return at === -1 ? '' : s.slice(0, at);
}

/**
 * Resolve a verified Google identity to an existing user, or to nothing.
 *
 * @returns {{ user: object, migrateTo: string|null }|null}
 *   `migrateTo` set means: this is the right person, under an address the record
 *   does not carry yet. Null means no account — the caller refuses.
 */
export function matchGoogleUser(users, email, env = process.env) {
  const address = String(email ?? '').trim().toLowerCase();
  if (!address) return null;

  // 1. Exact match. Unchanged behaviour, and it stays first so a record that has
  //    already been migrated resolves here rather than through the rules below.
  const exact = (users || []).find((u) => String(u.email ?? '').trim().toLowerCase() === address);
  if (exact) return { user: exact, migrateTo: null };

  // 2. Same person, new domain. Only from the one legacy domain to the one
  //    current domain — this is a migration path, not a general alias rule.
  if (emailDomain(address) !== loginDomain(env)) return null;

  const local = emailLocalPart(address);
  if (!local) return null;

  const legacy = `${local}@${legacyDomain(env)}`;
  const candidates = (users || []).filter((u) => String(u.email ?? '').trim().toLowerCase() === legacy);

  // Exactly one, or nothing. Two records sharing a prefix is a situation a human
  // has to resolve: merging them here would silently hand one person's history
  // and permissions to whoever signed in first.
  if (candidates.length !== 1) return null;

  return { user: candidates[0], migrateTo: address };
}

/**
 * Apply a migration in place and return the fields that changed, for logging.
 * `id`, `appRole` and `role` are deliberately untouched — signing in must never
 * change what somebody is allowed to do.
 */
export function applyEmailMigration(user, newEmail, now = new Date()) {
  const previousEmail = user.email;
  user.previousEmail = previousEmail;
  user.email = newEmail;
  user.emailMigratedAt = now.toISOString();
  user.updatedAt = now.toISOString();
  return { previousEmail, newEmail };
}

export function loginBaseUrl() {
  return process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://vance-content.vercel.app';
}

export function loginRedirectUri() {
  return `${loginBaseUrl()}/api/auth/google/callback`;
}

export function buildGoogleLoginUrl(clientId, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export function generateState() {
  return randomBytes(16).toString('hex');
}

export function stateCookieString(state) {
  return `${STATE_COOKIE}=${state}; Path=/api/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}

export function clearStateCookieString() {
  return `${STATE_COOKIE}=; Path=/api/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// lib/auth.js's parseCookies is not exported — small local copy.
export function parseCookies(header) {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map(c => {
      const [k, ...rest] = c.trim().split('=');
      return [k, decodeURIComponent(rest.join('='))];
    })
  );
}

// setSessionCookie() (lib/auth.js) uses res.setHeader('Set-Cookie', <single string>),
// which overwrites rather than appends. This lets the session cookie and the
// state-cookie-clear both survive on the same response regardless of order.
export function appendCookie(res, cookieString) {
  const existing = res.getHeader('Set-Cookie');
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  list.push(cookieString);
  res.setHeader('Set-Cookie', list);
}

export function failRedirect(res, code) {
  appendCookie(res, clearStateCookieString());
  return res.redirect(302, `/?login_error=${code}`);
}

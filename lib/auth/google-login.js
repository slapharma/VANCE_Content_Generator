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

/**
 * Vance Passport — VERIFIER.
 * vance-sso.js  v1.0.0
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │  VENDORED FILE — copy this into each consuming app as lib/vance-sso.  │
 * │  Do not edit a copy in place. Change it here in the V-Net repo, bump  │
 * │  the version above, and re-copy to every app. When two copies         │
 * │  disagree, the version header is how you find out.                    │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * Consumers, and the extension each uses — follow the local convention of the
 * directory it lands in, since the CONTENTS are what must stay identical:
 *
 *   Uptime-Dashboard      lib/vance-sso.js
 *   Content-Generator     lib/vance-sso.js
 *   CustomerService/app   lib/vance-sso.mjs
 *
 * ── What this is for ─────────────────────────────────────────────────────
 *
 * V-Net signs one cookie, scoped to .vancemedicalfoods.co.uk, that every
 * internal Vance system accepts. This file is how a system accepts it.
 *
 * Verification is OFFLINE — an HMAC check against a shared secret, with no
 * network call to V-Net, ever. That is the whole point, and it is not an
 * optimisation. The Alerts dashboard's founding constraint is that it must
 * not go down with the things it watches; if checking a session meant asking
 * V-Net, then V-Net would become a thing that can take the dashboard down at
 * exactly the moment somebody opens it to find out what is wrong.
 *
 * ── How to wire it in ────────────────────────────────────────────────────
 *
 * Each app has exactly ONE function where a request becomes an identity.
 * Add the Passport as a fallback inside that function — never as a new
 * middleware layer, and never in place of the native session:
 *
 *   Content-Generator      getCurrentUser(req)     lib/auth.js
 *   CustomerService        sessionUser(req)        lib/users-db.mjs
 *   Uptime-Dashboard       sessionOf(req, env)     lib/auth.js
 *
 * The order matters:
 *
 *   1. Native session cookie valid → use it, unchanged. This keeps every app
 *      able to stand alone, and keeps a way in if the Passport is misconfigured.
 *   2. Passport valid → the request is from this email address.
 *   3. Neither → 401, or redirect to V-Net's sign-in.
 *
 * ── Identity, not authorisation ──────────────────────────────────────────
 *
 * A valid Passport says WHO somebody is. It does not say what they may do.
 *
 * For the Content Generator and the CS console, resolve the email against the
 * app's OWN user table and FAIL CLOSED when there is no matching record.
 * Being on the company domain is not an account — that is already the stated
 * policy in Content-Generator/lib/auth/google-login.js, and the Passport must
 * not become a way around it.
 *
 * The Alerts dashboard has no user records and no roles, so a valid Passport
 * on the right domain is sufficient there.
 *
 * ── Configuration ────────────────────────────────────────────────────────
 *
 *   VANCE_SSO_SECRET       required. Identical across V-Net and every app.
 *   VANCE_SSO_SECRET_PREV  optional. The previous secret during a rotation.
 *
 * Zero dependencies: node:crypto only.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SSO_COOKIE = 'vance_sso';
const SSO_VERSION = 1;

/** Trimmed — a secret pasted into a dashboard field or piped in by a shell
 *  very often carries a trailing newline, and an exact-match comparison then
 *  fails with nothing visible to debug. */
const read = (v) => (typeof v === 'string' ? v.trim() : '') || null;

const sign = (secret, body) => createHmac('sha256', secret).update(body).digest('base64url');

function sigMatches(expected, actual) {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Is the Passport switched on for this deployment? */
export function ssoConfigured(env = process.env) {
  return Boolean(read(env.VANCE_SSO_SECRET));
}

/**
 * Validate a Passport token.
 * @returns {{v:number, sub:string, iat:number, exp:number}|null}
 */
export function verifySso(token, env = process.env, now = Date.now()) {
  if (typeof token !== 'string' || !token.includes('.')) return null;

  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  const secrets = [read(env.VANCE_SSO_SECRET), read(env.VANCE_SSO_SECRET_PREV)].filter(Boolean);
  if (!secrets.length) return null;
  if (!secrets.some((s) => sigMatches(sign(s, body), sig))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  // Checked only AFTER the signature, so a forged token cannot be told apart
  // from a merely expired one by how long the answer takes to come back.
  if (payload?.v !== SSO_VERSION) return null;
  if (!payload.sub || typeof payload.sub !== 'string') return null;
  if (typeof payload.exp !== 'number' || payload.exp <= now) return null;

  return payload;
}

export function parseSsoCookies(header) {
  if (!header) return {};
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * The Passport identity on this request, or null.
 * This is the function to call from an app's auth choke-point.
 */
export function ssoEmail(req, env = process.env, now = Date.now()) {
  const token = parseSsoCookies(req.headers?.cookie)[SSO_COOKIE];
  return verifySso(token, env, now)?.sub || null;
}

/**
 * Clear the Passport, for an app's own sign-out.
 *
 * Must carry the same Domain the cookie was set with, or the browser treats
 * it as a different cookie and the original quietly survives — which presents
 * as "I signed out and I am still signed in".
 */
export function clearSsoCookie(env = process.env) {
  const domain = read(env.SSO_COOKIE_DOMAIN) ?? '.vancemedicalfoods.co.uk';
  return `${SSO_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Domain=${domain}`;
}

/** Where to send somebody who has no session at all. */
export function signinUrl(req, env = process.env) {
  const base = (read(env.VNET_URL) || 'https://vnet.vancemedicalfoods.co.uk').replace(/\/+$/, '');
  const host = req?.headers?.host;
  const path = req?.url || '/';
  const next = host ? `https://${host}${path}` : path;
  return `${base}/signin.html?next=${encodeURIComponent(next)}`;
}

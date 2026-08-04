import { decodeJwt } from 'jose';
import { loadUsers, saveUsers } from '../../../lib/users.js';
import { signSession, setSessionCookie } from '../../../lib/auth.js';
import { exchangeGoogleCode } from '../../../lib/auth/oauth.js';
import { withErrorBoundary } from '../../../lib/api.js';
import {
  loginRedirectUri, parseCookies, appendCookie, clearStateCookieString,
  failRedirect, STATE_COOKIE, googleClientId, googleClientSecret,
  matchGoogleUser, applyEmailMigration, loginDomain,
} from '../../../lib/auth/google-login.js';

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { code, state, error } = req.query;
  const cookieState = parseCookies(req.headers?.cookie)[STATE_COOKIE];

  if (error) return failRedirect(res, 'google_denied');
  if (!state || !cookieState || state !== cookieState) return failRedirect(res, 'invalid_state');

  // Trimmed at the same accessor the authorize step uses, so the credential that
  // starts the flow is byte-for-byte the one that finishes it.
  const clientId = googleClientId();
  const clientSecret = googleClientSecret();
  if (!clientId || !clientSecret) return failRedirect(res, 'oauth_failed');

  try {
    const tokenRes = await exchangeGoogleCode(code, clientId, clientSecret, loginRedirectUri());
    const claims = decodeJwt(tokenRes.id_token);

    const now = Math.floor(Date.now() / 1000);
    const validIss = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
    if (claims.aud !== clientId || !validIss || !claims.exp || claims.exp < now) {
      return failRedirect(res, 'oauth_failed');
    }
    if (claims.email_verified !== true) return failRedirect(res, 'email_unverified');

    // `hd` is Google's hosted-domain claim: present and authoritative for
    // Workspace accounts, absent for consumer ones. When it is there it must
    // agree with our domain, which closes the gap where a consumer account has
    // simply been *named* something@ourdomain. It tightens the email check
    // rather than replacing it — absent `hd` is not by itself a refusal, or no
    // legitimately-registered gmail account could ever sign in.
    if (claims.hd && String(claims.hd).toLowerCase() !== loginDomain()) {
      return failRedirect(res, 'not_authorized');
    }

    const users = await loadUsers();
    const match = matchGoogleUser(users, claims.email);
    if (!match) return failRedirect(res, 'not_authorized');

    const { user, migrateTo } = match;
    let dirty = false;

    // Same person, address moved to the new domain. Their id, appRole and role
    // are untouched: this recognises who they already are, it does not decide
    // anything about what they may do.
    if (migrateTo) {
      const { previousEmail } = applyEmailMigration(user, migrateTo);
      console.log(`[google-login] migrated ${previousEmail} → ${migrateTo} (id ${user.id}, role unchanged: ${user.appRole})`);
      dirty = true;
    }

    if (user.googleId !== claims.sub || user.picture !== claims.picture || user.mustChangePassword) {
      user.googleId = claims.sub;
      user.picture = claims.picture;
      user.googleLinkedAt = user.googleLinkedAt ?? new Date().toISOString();
      user.mustChangePassword = false;
      user.updatedAt = new Date().toISOString();
      dirty = true;
    }

    // One write covering both, so a migration cannot be persisted without the
    // identity link that justified it.
    if (dirty) await saveUsers(users);

    const token = await signSession(user.id);
    setSessionCookie(res, token);
    appendCookie(res, clearStateCookieString());
    return res.redirect(302, '/');
  } catch (err) {
    console.error('[google-login-callback]', err?.stack || err);
    return failRedirect(res, 'oauth_failed');
  }
}

export default withErrorBoundary(handler);

import { withErrorBoundary } from '../../../lib/api.js';
import {
  loginRedirectUri, buildGoogleLoginUrl, generateState, stateCookieString,
  googleClientId, googleClientSecret,
} from '../../../lib/auth/google-login.js';

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const clientId = googleClientId();

  // Availability probe for the login screen, so the button is only rendered
  // when pressing it can actually work. Deliberately reports a boolean and
  // nothing else — never the client id, and never a hint about which half of
  // the pair is missing.
  if (req.query?.probe === '1') {
    return res.status(200).json({
      configured: Boolean(clientId && googleClientSecret()),
    });
  }

  // Unconfigured, but reached anyway (a stale tab, a bookmark, a direct hit).
  // Redirect into the app's own error channel rather than answering with raw
  // JSON — the login screen already knows how to render `login_error`, and a
  // 500 body is not something to show a person who pressed a button.
  if (!clientId) return res.redirect(302, '/?login_error=not_configured');

  const state = generateState();
  res.setHeader('Set-Cookie', stateCookieString(state));
  return res.redirect(302, buildGoogleLoginUrl(clientId, loginRedirectUri(), state));
}

export default withErrorBoundary(handler);

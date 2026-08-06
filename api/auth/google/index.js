import { withErrorBoundary } from '../../../lib/api.js';
import {
  loginRedirectUri, buildGoogleLoginUrl, generateState, stateCookieString,
  googleClientId, googleClientSecret, loginDomain,
} from '../../../lib/auth/google-login.js';

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const clientId = googleClientId();

  // Availability probe for the login screen, so the button is only rendered
  // when pressing it can actually work. Deliberately reports a boolean and the
  // expected domain, and nothing else — never the client id, and never a hint
  // about which half of the pair is missing.
  //
  // The domain is named so the hint under the button is sourced from the server
  // that will actually enforce it, rather than typed into the page where it can
  // quietly drift; HQ and the Alerts dashboard publish it on the same grounds.
  // It is not a secret — it is the domain on everyone's business card.
  if (req.query?.probe === '1') {
    return res.status(200).json({
      configured: Boolean(clientId && googleClientSecret()),
      domain: loginDomain(),
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

import { clearSessionCookie } from '../../lib/auth.js';
import { clearSsoCookie } from '../../lib/vance-sso.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Both cookies. Either one alone is enough to stay signed in, so clearing
  // only this app's session would leave somebody who arrived on a Vance
  // Passport still signed in after pressing sign-out — which reads as the
  // button being broken.
  //
  // clearSessionCookie sets the header itself, so the SSO cookie has to be
  // appended to what it wrote. A second bare setHeader would overwrite it and
  // silently undo the app's own sign-out.
  clearSessionCookie(res);
  const existing = res.getHeader('Set-Cookie');
  const cookies = Array.isArray(existing) ? existing : [existing].filter(Boolean);
  res.setHeader('Set-Cookie', [...cookies, clearSsoCookie()]);

  return res.json({ ok: true });
}

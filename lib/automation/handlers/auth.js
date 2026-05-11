// lib/automation/handlers/auth.js
// Handles all /api/automation/auth/* routes for Google Drive and Dropbox OAuth.
// Routed from api/automation/[...slug].js when slug[0] === 'auth'.

import {
  getCredentials, saveCredentials, getTokens, saveTokens, deleteTokens,
  getGoogleAuthUrl, exchangeGoogleCode, refreshGoogleToken,
  getDropboxAuthUrl, exchangeDropboxCode,
} from '../../auth/oauth.js';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://vance-content-generator.vercel.app';

// Exported so gmail.js (and other source modules) can obtain a valid access token
// without duplicating KV read/write or token-refresh logic.
export async function getValidGoogleToken() {
  const tokens = await getTokens('google');
  if (!tokens?.accessToken) {
    throw new Error('Google account not connected. Go to Settings → Google Connections and click Connect Google.');
  }
  if (Date.now() < tokens.expiresAt - 300_000) return tokens.accessToken;
  // Token expires within 5 minutes — refresh it
  const creds = await getCredentials('google');
  if (!creds) throw new Error('Google credentials not found in KV');
  const fresh = await refreshGoogleToken(tokens.refreshToken, creds.clientId, creds.clientSecret);
  const updated = {
    accessToken: fresh.access_token,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + fresh.expires_in * 1000,
  };
  await saveTokens('google', updated);
  return updated.accessToken;
}

function redirectUri(service) {
  return `${APP_URL}/api/automation/auth/${service}/callback`;
}

// Tiny HTML page sent back after OAuth. Notifies opener via postMessage then closes.
function oauthDonePage(message, success) {
  return `<!DOCTYPE html><html><head><title>Authentication</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f9fafb;}
.box{text-align:center;padding:32px;border:1px solid #e5e7eb;max-width:360px;}
.icon{font-size:2.5rem;margin-bottom:12px;}p{color:#374151;font-size:0.9rem;}</style></head>
<body><div class="box"><div class="icon">${success ? '✓' : '✗'}</div><p>${message}</p>
<p style="color:#6b7280;font-size:0.8rem;">This window will close automatically.</p></div>
<script>
try{window.opener.postMessage({type:'oauth-complete',success:${success}},'*');}catch(e){}
setTimeout(function(){window.close();},1500);
</script></body></html>`;
}

export default async function handler(req, res, slug) {
  // slug = ['auth', second, third?]  e.g. ['auth','google','callback']
  const second = slug[1]; // 'config' | 'status' | 'google' | 'dropbox'
  const third  = slug[2]; // 'callback' or undefined

  // POST /auth/config — save client credentials to KV
  if (req.method === 'POST' && second === 'config') {
    const { service, clientId, clientSecret } = req.body || {};
    if (!service || !clientId || !clientSecret) {
      return res.status(400).json({ error: 'service, clientId, clientSecret required' });
    }
    if (!['google', 'dropbox'].includes(service)) {
      return res.status(400).json({ error: 'service must be google or dropbox' });
    }
    await saveCredentials(service, { clientId, clientSecret });
    return res.status(200).json({ ok: true });
  }

  // GET /auth/status — return connection status for all services
  if (req.method === 'GET' && second === 'status') {
    const [gCreds, gTokens, dCreds, dTokens] = await Promise.all([
      getCredentials('google'), getTokens('google'),
      getCredentials('dropbox'), getTokens('dropbox'),
    ]);
    return res.status(200).json({
      google:  { credsSaved: !!gCreds, connected: !!gTokens?.accessToken },
      dropbox: {
        credsSaved: !!dCreds,
        connected: !!dTokens?.accessToken,
        hasRefreshToken: !!dTokens?.refreshToken,
        tokenKeys: dTokens ? Object.keys(dTokens) : [],
      },
    });
  }

  // ── Google ────────────────────────────────────────────────────────────────

  // GET /auth/google — redirect to Google consent screen
  if (req.method === 'GET' && second === 'google' && !third) {
    const creds = await getCredentials('google');
    if (!creds) {
      return res.status(400).send('Google credentials not saved. Enter your Client ID and Secret in Settings first.');
    }
    return res.redirect(302, getGoogleAuthUrl(creds.clientId, redirectUri('google'), 'gdrive'));
  }

  // GET /auth/google/callback — exchange code, store tokens
  if (req.method === 'GET' && second === 'google' && third === 'callback') {
    const { code, error } = req.query;
    if (error) {
      return res.status(200).send(oauthDonePage(`Google auth failed: ${error}`, false));
    }
    try {
      const creds = await getCredentials('google');
      if (!creds) throw new Error('Google credentials not found');
      const tokens = await exchangeGoogleCode(code, creds.clientId, creds.clientSecret, redirectUri('google'));
      await saveTokens('google', {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
      });
      return res.status(200).send(oauthDonePage('Google Drive connected!', true));
    } catch (err) {
      return res.status(200).send(oauthDonePage(`Error: ${err.message}`, false));
    }
  }

  // DELETE /auth/google — disconnect (delete tokens)
  if (req.method === 'DELETE' && second === 'google' && !third) {
    await deleteTokens('google');
    return res.status(200).json({ ok: true });
  }

  // ── Dropbox ───────────────────────────────────────────────────────────────

  // GET /auth/dropbox — redirect to Dropbox consent screen
  if (req.method === 'GET' && second === 'dropbox' && !third) {
    const creds = await getCredentials('dropbox');
    if (!creds) {
      return res.status(400).send('Dropbox credentials not saved. Enter your App Key and Secret in Settings first.');
    }
    return res.redirect(302, getDropboxAuthUrl(creds.clientId, redirectUri('dropbox'), 'dropbox'));
  }

  // GET /auth/dropbox/callback — exchange code, store tokens
  if (req.method === 'GET' && second === 'dropbox' && third === 'callback') {
    const { code, error } = req.query;
    if (error) {
      return res.status(200).send(oauthDonePage(`Dropbox auth failed: ${error}`, false));
    }
    try {
      const creds = await getCredentials('dropbox');
      if (!creds) throw new Error('Dropbox credentials not found');
      const tokens = await exchangeDropboxCode(code, creds.clientId, creds.clientSecret, redirectUri('dropbox'));
      await saveTokens('dropbox', {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
      });
      return res.status(200).send(oauthDonePage('Dropbox connected!', true));
    } catch (err) {
      return res.status(200).send(oauthDonePage(`Error: ${err.message}`, false));
    }
  }

  // DELETE /auth/dropbox — disconnect
  if (req.method === 'DELETE' && second === 'dropbox' && !third) {
    await deleteTokens('dropbox');
    return res.status(200).json({ ok: true });
  }

  return res.status(404).json({ error: 'Not found' });
}

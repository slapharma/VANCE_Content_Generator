// lib/auth/oauth.js
// OAuth helpers for Google Drive and Dropbox integrations.
// Credentials and tokens are stored in Vercel KV, never in client-side state.

import { kv } from '../kv.js';

// ── KV helpers ────────────────────────────────────────────────────────────────

export async function getCredentials(service) {
  return kv.get(`auth:${service}:creds`);
}

export async function saveCredentials(service, creds) {
  await kv.set(`auth:${service}:creds`, creds);
}

export async function getTokens(service) {
  return kv.get(`auth:${service}:tokens`);
}

export async function saveTokens(service, tokens) {
  await kv.set(`auth:${service}:tokens`, tokens);
}

export async function deleteTokens(service) {
  await kv.del(`auth:${service}:tokens`);
}

// ── Google OAuth ──────────────────────────────────────────────────────────────

export function getGoogleAuthUrl(clientId, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeGoogleCode(code, clientId, clientSecret, redirectUri, fetchFn = fetch) {
  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json();
}

export async function refreshGoogleToken(refreshToken, clientId, clientSecret, fetchFn = fetch) {
  const res = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  return res.json();
}

// ── Dropbox OAuth ─────────────────────────────────────────────────────────────

export function getDropboxAuthUrl(appKey, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: appKey,
    redirect_uri: redirectUri,
    response_type: 'code',
    token_access_type: 'offline',
    state,
  });
  return `https://www.dropbox.com/oauth2/authorize?${params}`;
}

export async function refreshDropboxToken(refreshToken, appKey, appSecret, fetchFn = fetch) {
  const credentials = Buffer.from(`${appKey}:${appSecret}`).toString('base64');
  const res = await fetchFn('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Dropbox token refresh failed: ${await res.text()}`);
  return res.json();
}

export async function exchangeDropboxCode(code, appKey, appSecret, redirectUri, fetchFn = fetch) {
  const credentials = Buffer.from(`${appKey}:${appSecret}`).toString('base64');
  const res = await fetchFn('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new Error(`Dropbox token exchange failed: ${await res.text()}`);
  return res.json();
}

// lib/social/composio.js
// Thin wrapper around the Composio SDK for multi-account social posting.
//
// The SDK is imported LAZILY (dynamic import inside functions) so this module
// loads fine even when @composio/core is not installed or COMPOSIO_API_KEY is
// unset — the legacy env-var posting path keeps working until Composio is
// configured. Only the functions below throw when Composio is actually used.
//
// Setup (one-time, in the Composio dashboard):
//   1. Create an account → copy the API key → Vercel env COMPOSIO_API_KEY.
//   2. For each platform, create an Auth Config (OAuth) and copy its ac_… id
//      into the matching env var below (COMPOSIO_AUTHCONFIG_<PLATFORM>).
//   3. Connect accounts via the hosted link() flow (see handlers/accounts.js).

// One stable Composio userID for this single-tenant app. Multiple *accounts*
// per platform are distinguished by connectedAccountId, not userId.
export const COMPOSIO_USER_ID = process.env.COMPOSIO_USER_ID || 'vance';

// Auth Config id per platform (ac_… from the Composio dashboard).
const AUTH_CONFIGS = {
  twitter:   process.env.COMPOSIO_AUTHCONFIG_TWITTER,
  linkedin:  process.env.COMPOSIO_AUTHCONFIG_LINKEDIN,
  facebook:  process.env.COMPOSIO_AUTHCONFIG_FACEBOOK,
  instagram: process.env.COMPOSIO_AUTHCONFIG_INSTAGRAM,
  tiktok:    process.env.COMPOSIO_AUTHCONFIG_TIKTOK,
};

export function authConfigFor(platform) {
  const id = AUTH_CONFIGS[platform];
  if (!id) throw new Error(`No Composio auth config for "${platform}". Set COMPOSIO_AUTHCONFIG_${platform.toUpperCase()}.`);
  return id;
}

export function isComposioConfigured() {
  return Boolean(process.env.COMPOSIO_API_KEY);
}

let _client = null;
async function getComposio() {
  if (_client) return _client;
  if (!process.env.COMPOSIO_API_KEY) throw new Error('COMPOSIO_API_KEY not set');
  const mod = await import('@composio/core');
  const Composio = mod.Composio || mod.default;
  _client = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
  return _client;
}

/**
 * Begin connecting a new account for a platform via Composio hosted OAuth.
 * Returns the redirect URL to send the user to, plus the pending connection id.
 * link() allows multiple accounts per toolkit by default.
 */
export async function linkAccount(platform, { userId = COMPOSIO_USER_ID } = {}) {
  const composio = await getComposio();
  const conn = await composio.connectedAccounts.link(userId, authConfigFor(platform));
  return {
    redirectUrl: conn.redirectUrl || conn.redirect_url,
    connectionId: conn.id || conn.connectedAccountId || conn.connected_account_id,
  };
}

/**
 * List the user's Composio connections, normalised. Optionally filter to ACTIVE.
 * @returns {Array<{ id, status, toolkit }>}
 */
export async function listConnections({ userId = COMPOSIO_USER_ID, activeOnly = false } = {}) {
  const composio = await getComposio();
  const opts = { userIds: [userId] };
  if (activeOnly) opts.statuses = ['ACTIVE'];
  const resp = await composio.connectedAccounts.list(opts);
  const items = resp?.items || resp?.data || resp || [];
  return items.map((a) => ({
    id: a.id || a.connectedAccountId || a.connected_account_id,
    status: a.status,
    toolkit: a.toolkit?.slug || a.toolkitSlug || a.appName,
  }));
}

/**
 * Execute a Composio tool against a specific connected account.
 * @param {string} slug - tool slug, e.g. 'TWITTER_CREATION_OF_A_POST'
 * @param {object} opts - { connectedAccountId, arguments, userId }
 * @returns {object} the tool's response data
 */
export async function executeTool(slug, { connectedAccountId, arguments: args, userId = COMPOSIO_USER_ID }) {
  const composio = await getComposio();
  const res = await composio.tools.execute(slug, {
    userId,
    connectedAccountId,
    arguments: args || {},
    // Manual tool execution otherwise errors "Toolkit version not specified".
    // We run against the latest tool schema (fine for these stable social tools);
    // pin per-toolkit versions here if a future schema change ever breaks posting.
    dangerouslySkipVersionCheck: true,
  });
  // SDK returns { successful, data, error } (camel/snake varies by version).
  const ok = res?.successful ?? res?.successfull ?? res?.success;
  if (ok === false) {
    throw new Error(`Composio ${slug} failed: ${res?.error || JSON.stringify(res?.data || res).slice(0, 300)}`);
  }
  return res?.data ?? res;
}

// lib/social/accounts.js
// Multi-account registry for social posting, persisted in KV.
//
// Each account is one connected destination (e.g. "Vance IG", "Founder IG").
// Composio stores/refreshes the OAuth tokens; we store only the pointer
// (connectedAccountId) plus a label and which account is the platform default.
//
// KV key: social:accounts → Array<Account>
//   Account = {
//     id, platform, label, provider: 'composio',
//     connectedAccountId, isDefault, status, createdAt,
//     config: { pageId?, authorUrn?, igUserId? }  // platform-specific identifiers
//   }
//
// `config` carries the extra IDs some platform tools require as explicit args
// (confirmed against the live Composio toolkit schemas, 2026-07-01):
//   - facebook:  config.pageId    → FACEBOOK_CREATE_POST/PHOTO_POST `page_id` (required)
//   - linkedin:  config.authorUrn → LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE `author` (required, urn:li:person|organization:…)
//   - instagram: config.igUserId  → INSTAGRAM_* `ig_user_id` (publish requires it; falls back to 'me')

import { kv } from '../kv.js';

const KEY = 'social:accounts';

export async function listAccounts(platform = null) {
  const all = (await kv.get(KEY)) || [];
  return platform ? all.filter((a) => a.platform === platform) : all;
}

export async function addAccount({ platform, label, connectedAccountId, provider = 'composio', status = 'ACTIVE', config = {} }) {
  const all = (await kv.get(KEY)) || [];
  const id = `acct_${platform}_${Date.now().toString(36)}`;
  const isFirstForPlatform = !all.some((a) => a.platform === platform);
  const account = {
    id, platform, label: label || platform, provider,
    connectedAccountId, status,
    config: config && typeof config === 'object' ? config : {},
    isDefault: isFirstForPlatform, // first account for a platform becomes its default
    createdAt: new Date().toISOString(),
  };
  all.push(account);
  await kv.set(KEY, all);
  return account;
}

export async function removeAccount(id) {
  const all = (await kv.get(KEY)) || [];
  const removed = all.find((a) => a.id === id);
  let next = all.filter((a) => a.id !== id);
  // If we removed a platform's default, promote another account of that platform.
  if (removed?.isDefault) {
    const sibling = next.find((a) => a.platform === removed.platform);
    if (sibling) sibling.isDefault = true;
  }
  await kv.set(KEY, next);
  return Boolean(removed);
}

export async function setDefaultAccount(id) {
  const all = (await kv.get(KEY)) || [];
  const target = all.find((a) => a.id === id);
  if (!target) return false;
  for (const a of all) {
    if (a.platform === target.platform) a.isDefault = a.id === id;
  }
  await kv.set(KEY, all);
  return true;
}

/**
 * Resolve which account to post a platform from.
 * @param {string} platform
 * @param {string} [accountId] - explicit account id from the kit (optional)
 * @returns {Promise<Account|null>} null → caller falls back to the legacy env-var adapter
 */
export async function resolveAccount(platform, accountId = null) {
  const accts = await listAccounts(platform);
  if (!accts.length) return null;
  if (accountId) return accts.find((a) => a.id === accountId) || null;
  return accts.find((a) => a.isDefault) || accts[0];
}

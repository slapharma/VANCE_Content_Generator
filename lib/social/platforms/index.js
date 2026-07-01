// lib/social/platforms/index.js
import { postInstagram } from './instagram.js';
import { postTikTok } from './tiktok.js';
import { postLinkedIn } from './linkedin.js';
import { postTwitter } from './twitter.js';
import { postFacebook } from './facebook.js';
import { postViaComposio } from './composio.js';

const adapters = {
  instagram: postInstagram,
  tiktok:    postTikTok,
  linkedin:  postLinkedIn,
  twitter:   postTwitter,
  facebook:  postFacebook,
};

/**
 * Post content to a platform.
 * - If `account` is a Composio-connected account, post through it (multi-account).
 * - Otherwise fall back to the legacy server-side env-var adapter (single account).
 * @param {string} platform
 * @param {object} platformData - The platform slice from a ContentKit (caption, hashtags, image, video, reelScript, etc.)
 * @param {object|null} [account] - resolved account from lib/social/accounts.js, or null
 * @returns {Promise<{ postId: string }>} - All adapters must return this shape
 * @throws {Error} If platform has no registered adapter
 */
export async function dispatch(platform, platformData, account = null) {
  if (account && account.provider === 'composio') {
    return postViaComposio(platform, platformData, account);
  }
  const adapter = adapters[platform];
  if (!adapter) throw new Error(`No adapter for platform "${platform}". Known: ${Object.keys(adapters).join(', ')}`);
  return adapter(platformData);
}

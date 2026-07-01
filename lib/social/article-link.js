// lib/social/article-link.js
// Resolve the published article URL for a kit, so platform adapters that need a
// link (e.g. LinkedIn's ARTICLE share) point at the actual article instead of a
// brand-homepage fallback. The URL is written onto the content record as
// `wpPostUrl` by api/publish when the article is published to WordPress.

import { kv } from '../kv.js';

/**
 * @param {object} kit - a social kit ({ articleId, ... })
 * @returns {Promise<string|null>} the published article URL, or null if unknown
 */
export async function articleLinkFor(kit) {
  if (!kit?.articleId) return null;
  try {
    const article = await kv.get(`content:${kit.articleId}`);
    return article?.wpPostUrl || null;
  } catch {
    return null;
  }
}

/**
 * Return a copy of a kit's platform slice enriched with the resolved article
 * link (without clobbering an explicit link already on the slice).
 */
export async function withArticleLink(platformData, kit) {
  const link = await articleLinkFor(kit);
  if (!link) return platformData;
  return { ...platformData, link: platformData.link || link };
}

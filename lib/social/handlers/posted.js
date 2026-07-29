// lib/social/handlers/posted.js
//
//   GET /api/social/posted?limit=200
//
// Everything this account has actually published, newest first, with the
// provenance a reviewer needs to filter it: how it was generated, which campaign
// or automation rule produced it, which platform it went to, and when.
//
// Three sources are merged rather than one, because no single index sees every
// post:
//
//   1. `social:posted:index` — post refs the cron (or a "post now") drained. This
//      is the only record of a *kit* post going live.
//   2. The carousel indexes — every deck with a `postedAt`. Catches decks posted
//      through paths that predate the posted index, and is the only place a
//      deck's campaign/rule provenance and slide thumbnails live.
//   3. The kit index — kit platforms carrying a `postedAt` whose ref never made
//      it into (1), which is every kit posted before that lpush existed.
//
// Entries are de-duplicated on a stable identity (`carousel:{id}` /
// `kit:{kitId}:{platform}`), with the richer record winning.

import { kv } from '../../kv.js';
import { listCarousels, getCarousel, saveCarousel } from '../carousel-store.js';
import { categoryLabelFor } from '../carousel-theme.js';
import { resolveAccount } from '../accounts.js';
import { resolveInstagramPermalink, profileUrlFor } from '../instagram-permalink.js';

const POSTED_INDEX = 'social:posted:index';
const KITS_INDEX = 'social:kits:index';

const refKey = (id) => `social:postref:${id}`;

/** First non-empty string among the candidates, trimmed for a list row. */
function preview(...candidates) {
  for (const c of candidates) {
    const s = Array.isArray(c) ? c[0] : c;
    if (typeof s === 'string' && s.trim()) return s.trim().slice(0, 240);
  }
  return '';
}

function carouselEntry(deck, postedAt) {
  return {
    key: `carousel:${deck.id}`,
    id: deck.id,
    kind: 'carousel',
    generationType: deck.promoId ? 'promo-carousel' : 'article-carousel',
    platform: 'instagram',
    title: deck.articleTitle || 'Carousel',
    caption: preview(deck.caption),
    postedAt: postedAt || deck.postedAt || null,
    articleId: deck.articleId || null,
    category: deck.category || null,
    // Resolved rather than trusted: decks built before categoryLabel was stamped
    // carry null, and a facet list mixing "Healthcare news" with "industry-news"
    // reads as two different content types when it is one.
    categoryLabel: deck.categoryLabel || (deck.category ? categoryLabelFor(deck.category) : null),
    ruleId: deck.ruleId || null,
    promoId: deck.promoId || null,
    promoName: deck.promoName || null,
    accountId: deck.accountId || null,
    platformPostId: deck.platformPostId || null,
    slideCount: deck.slides?.length || deck.slideCount || 0,
    thumb: deck.slides?.[0]?.url || deck.heroImageUrl || null,
    degraded: !!deck.degraded,
    createdBy: deck.createdBy || null,
  };
}

function kitEntry(kit, platform, data, postedAt) {
  return {
    key: `kit:${kit.id}:${platform}`,
    id: kit.id,
    kind: 'kit',
    generationType: 'kit',
    platform,
    title: kit.articleTitle || kit.id,
    caption: preview(data?.caption, data?.hook, data?.thread, data?.teaser),
    postedAt: postedAt || data?.postedAt || null,
    articleId: kit.articleId || null,
    category: null,
    categoryLabel: null,
    ruleId: null,
    promoId: null,
    promoName: null,
    accountId: data?.accountId || null,
    platformPostId: data?.platformPostId || null,
    slideCount: 0,
    thumb: data?.image?.url || null,
    degraded: false,
    createdBy: null,
    pillar: kit.pillar || null,
  };
}

/** Newest `postedAt` wins for the shared key; a richer record replaces a stub. */
function merge(map, entry) {
  if (!entry) return;
  const existing = map.get(entry.key);
  if (!existing) { map.set(entry.key, entry); return; }
  map.set(entry.key, {
    ...existing,
    ...Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== null && v !== undefined && v !== '')),
    postedAt: existing.postedAt || entry.postedAt,
  });
}

/** id → name for every automation rule referenced by the feed. */
async function ruleNames(ids) {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return {};
  const rules = await Promise.all(wanted.map((id) => kv.get(`automation:rule:${id}`)));
  const out = {};
  wanted.forEach((id, i) => { out[id] = rules[i]?.name || null; });
  return out;
}

/**
 * GET /api/social/posted/:carouselId/permalink
 *
 * Resolves (and caches, including the negative) the public Instagram URL for a
 * posted deck, plus the account profile as a fallback destination.
 */
async function permalinkRoute(req, res, id) {
  const deck = await getCarousel(id);
  if (!deck) return res.status(404).json({ error: `No carousel ${id}` });

  const account = await resolveAccount('instagram', deck.accountId);
  const result = await resolveInstagramPermalink(deck, account);

  // Persist whichever way it went, so the ladder is not walked on every click.
  // The timestamp is what lets a failure expire — see NEGATIVE_TTL_MS.
  if (!result.cached) {
    await saveCarousel(result.permalink
      ? { ...deck, permalink: result.permalink, permalinkUnavailable: null }
      : { ...deck, permalinkUnavailable: result.reason, permalinkCheckedAt: new Date().toISOString() });
  }

  return res.status(200).json({
    permalink: result.permalink,
    reason: result.reason || null,
    profileUrl: profileUrlFor(account),
    accountLabel: account?.label || null,
    platformPostId: deck.platformPostId || null,
  });
}

export default async function handler(req, res, { id, action } = {}) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (id && action === 'permalink') return permalinkRoute(req, res, id);
  if (id) return res.status(404).json({ error: `Unknown posted route "${action || ''}"` });

  const limit = Math.min(Number(req.query?.limit) || 200, 500);
  const byKey = new Map();

  // 1. Post refs the queue drained.
  const refIds = (await kv.lrange(POSTED_INDEX, 0, limit - 1)) || [];
  const refs = (await Promise.all([...new Set(refIds)].map((id) => kv.get(refKey(id))))).filter(Boolean);
  const postedRefs = refs.filter((r) => r.status === 'posted');

  await Promise.all(postedRefs.map(async (ref) => {
    if (ref.kind === 'carousel') {
      const deck = await getCarousel(ref.carouselId);
      if (deck) return merge(byKey, carouselEntry(deck, ref.postedAt));
      return merge(byKey, {
        key: `carousel:${ref.carouselId}`, id: ref.carouselId, kind: 'carousel',
        generationType: 'article-carousel', platform: 'instagram', title: 'Carousel (record removed)',
        caption: '', postedAt: ref.postedAt || null, articleId: null, category: null, categoryLabel: null,
        ruleId: null, promoId: null, promoName: null, accountId: null, platformPostId: null,
        slideCount: 0, thumb: null, degraded: false, createdBy: null,
      });
    }
    const kit = await kv.get(`social:kit:${ref.kitId}`);
    if (!kit) return;
    merge(byKey, kitEntry(kit, ref.platform, kit.platforms?.[ref.platform], ref.postedAt));
  }));

  // 2. Every carousel that has gone live, whichever path took it there.
  const decks = await listCarousels({ limit: Math.min(limit, 300), kind: 'all' });
  decks.filter((d) => d.postedAt).forEach((d) => merge(byKey, carouselEntry(d)));

  // 3. Kit platforms that went live before the posted index existed.
  const kitIds = (await kv.lrange(KITS_INDEX, 0, 99)) || [];
  const kits = (await Promise.all(kitIds.map((id) => kv.get(`social:kit:${id}`)))).filter(Boolean);
  kits.forEach((kit) => {
    Object.entries(kit.platforms || {}).forEach(([platform, data]) => {
      if (data?.postedAt) merge(byKey, kitEntry(kit, platform, data));
    });
  });

  const items = [...byKey.values()]
    .filter((i) => i.postedAt)
    .sort((a, b) => String(b.postedAt).localeCompare(String(a.postedAt)))
    .slice(0, limit);

  // Rule names ride along so the filter can offer "Weekly clinical review"
  // rather than `rule_1738…`.
  const names = await ruleNames(items.map((i) => i.ruleId));
  items.forEach((i) => { i.ruleName = i.ruleId ? (names[i.ruleId] || i.ruleId) : null; });

  // Facets are derived from what is actually in the feed, so a filter can never
  // offer an option that matches nothing.
  const uniq = (vals) => [...new Set(vals.filter(Boolean))].sort();
  const pairs = (idKey, nameKey) => {
    const seen = new Map();
    items.forEach((i) => { if (i[idKey]) seen.set(i[idKey], i[nameKey] || i[idKey]); });
    return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  };

  return res.status(200).json({
    items,
    facets: {
      generationTypes: uniq(items.map((i) => i.generationType)),
      platforms: uniq(items.map((i) => i.platform)),
      categories: uniq(items.map((i) => i.categoryLabel || i.category)),
      campaigns: pairs('promoId', 'promoName'),
      rules: pairs('ruleId', 'ruleName'),
    },
  });
}

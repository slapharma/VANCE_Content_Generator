// lib/social/carousel-store.js
//
// KV shape + lifecycle for Article Carousel records.
//
// A carousel is a first-class record rather than part of a social kit. Kits are
// user-initiated (pick article → pillar → CTA) and cost six LLM calls; carousels
// are automation-initiated and cost one. Keeping them separate also lets a Reel
// and a carousel exist for the same article on different schedules instead of
// competing for the single `platforms.instagram` slice.
//
// Scheduling and posting deliberately reuse the kit queue (`social:queue` +
// `social:postref:*`, drained by lib/social/handlers/cron.js), so retries and
// backoff come for free. Post refs are tagged `kind: 'carousel'`; refs with no
// `kind` are kit posts, which is what every pre-existing ref is.

import { kv } from '../kv.js';
import { autoSchedule } from './scheduler.js';
import { MAX_CAROUSEL_SLIDES, categoryLabelFor } from './carousel-theme.js';

/**
 * Two indexes, not one.
 *
 * Both kinds of deck used to share a single capped list, which meant promotional
 * volume was measured against article volume: a daily campaign adds an entry a
 * day, so within about seven months it would have pushed every article deck off
 * the end of a 200-entry list. Nothing is destroyed when that happens — the
 * `social:carousel:{id}` record and the `by-article` pointer both survive, so
 * idempotency and re-renders keep working — but the deck becomes invisible in the
 * review list, which is indistinguishable from having been deleted.
 *
 * Splitting them makes the two rates independent. A campaign can now run daily
 * forever without costing an article deck its place, and each list is capped on
 * its own terms: articles at roughly a year of output, promo occurrences at
 * enough to cover any campaign an operator would still be reviewing.
 *
 * `CAROUSEL_INDEX` deliberately keeps its original key so the decks already in it
 * stay listed with no migration.
 */
export const CAROUSEL_INDEX = 'social:carousels:index';
export const PROMO_CAROUSEL_INDEX = 'social:carousels:promo-index';

/** ~10 articles/week for a year. Reads are bounded by the caller's `limit`, not
 *  by the cap, so a larger list costs storage only. */
const INDEX_CAP = 500;
const PROMO_INDEX_CAP = 300;

/** Which list does this deck belong in? Promo decks carry `promoId`. */
export const indexKeyFor = (carousel) => (carousel?.promoId ? PROMO_CAROUSEL_INDEX : CAROUSEL_INDEX);
const capFor = (indexKey) => (indexKey === PROMO_CAROUSEL_INDEX ? PROMO_INDEX_CAP : INDEX_CAP);

export const key = (id) => `social:carousel:${id}`;
export const byArticleKey = (articleId) => `social:carousel:by-article:${articleId}`;

/**
 * Carousel statuses:
 *   draft     — record exists, copy generated, slides not yet rendered
 *   rendering — a render is in flight
 *   ready     — slides rendered + hosted, awaiting approval
 *   scheduled — approved and queued for posting
 *   posted    — live on Instagram
 *   failed    — render or post gave up; `error` explains
 *   rejected  — a human said no; off the queue, off the Ready count, but the
 *               record and its hosted slides survive so it can be restored
 */
export const STATUS = {
  draft: 'draft', rendering: 'rendering', ready: 'ready',
  scheduled: 'scheduled', posted: 'posted', failed: 'failed',
  rejected: 'rejected',
};

/**
 * Build a new carousel record. Pure — does not touch KV.
 *
 * @param {object} args
 * @param {object} args.article - the source `content:{id}` record
 * @param {object} args.generated - output of buildCarouselSpec()
 * @param {string} [args.ruleId] - automation rule that triggered this, if any
 * @param {string} [args.createdBy='automation']
 * @param {string} [args.postMode='approval'] - see generation.carouselPostMode
 * @param {number} [args.delayHours=24] - only used by the 'delay' mode
 * @param {string} [args.style='education'] - 'education' or 'relatable'; must
 *   match whatever style buildCarouselSpec() used to produce `generated`, and
 *   is stamped here (not derived at render time) for the same reason
 *   categoryLabel is: a re-render must reproduce the deck that was actually
 *   generated even if defaults change later.
 */
export function buildCarousel({
  article, generated, ruleId = null, createdBy = 'automation',
  postMode = 'approval', delayHours = 24, accountId = null, style = 'education',
}) {
  const now = new Date().toISOString();
  return {
    id: `car_${Date.now()}`,
    articleId: article.id,
    articleTitle: article.title,
    category: article.category ?? null,
    // Resolved once here rather than at render time so the tag printed on the
    // slides stays stable even if the category label map later changes.
    categoryLabel: categoryLabelFor(article.category),
    subCategory: article.subCategory ?? null,
    ruleId,

    status: STATUS.draft,
    style,
    slideCount: generated.slideCount,
    spec: generated.spec,
    caption: generated.caption,
    hashtags: generated.hashtags,

    // Copied onto the record rather than read from the article at render time, so
    // a later hero change on the article cannot silently desync the deck from the
    // slides already hosted on WP.
    heroImageUrl: article.heroImageUrl ?? null,
    heroImageCredit: article.heroImageCredit ?? null,

    // Copied off the rule so the approve handler can act on the schedule without
    // re-reading (or depending on the continued existence of) the rule that
    // created this carousel.
    postMode,
    delayHours,

    slides: [],
    approved: false,
    scheduledAt: null,
    postedAt: null,
    platformPostId: null,
    accountId,
    error: null,
    rejectedAt: null,
    rejectReason: null,
    // A flag, not a status: status still gates the posting path (queueCarousel,
    // restoreCarousel, etc.), and the main archive use case is hiding a *posted*
    // deck from the review list without disturbing that it is posted.
    archived: false,
    archivedAt: null,

    createdAt: now,
    updatedAt: now,
    createdBy,
  };
}

/**
 * Build a carousel record for one occurrence of a promotional campaign.
 *
 * Produces the *same shape* as buildCarousel so that from here on a promo deck is
 * indistinguishable to the renderer, the editor, the queue and the poster — the
 * only differences are `articleId: null` and the promo provenance fields.
 *
 * `articleTitle` carries the campaign name rather than being left null: it is
 * what the review card renders as the deck's heading and what handlers/carousel.js
 * slugifies into the uploaded slide filenames. A null there produces a card with
 * no title and eight files called `image-carousel-01-cover.jpg`.
 *
 * @param {object} args
 * @param {object} args.promo     - the campaign
 * @param {object} args.generated - `{ spec, caption, hashtags, slideCount }`
 * @param {number} args.occurrence - 1-based occurrence number, for the card
 */
export function buildPromoCarousel({
  promo, generated, occurrence = 1, createdBy = 'promo',
  // Resolved from the campaign's design template (resolveTemplateForDeck). Both
  // are stamped on the record rather than looked up at render time, for the same
  // reason `spec` is: a re-render months later must reproduce the deck that was
  // actually published, not whatever the template says today.
  style = null, themeOverride = null,
}) {
  const now = new Date().toISOString();
  return {
    id: `car_${Date.now()}`,
    articleId: null,
    // No em dash: this string is generated content (it becomes the review card's
    // heading and the slugified slide filenames), and the house rule bans them
    // everywhere outside source comments.
    articleTitle: `${promo.name} #${occurrence}`,
    category: null,
    categoryLabel: promo.categoryLabel || 'Vance',
    subCategory: null,
    ruleId: null,

    // Promo provenance. `promoId` is what lets the campaign card list its own
    // occurrences and what a future cleanup would filter on.
    promoId: promo.id,
    promoName: promo.name,
    occurrenceOf: occurrence,

    status: STATUS.draft,
    style: style || promo.style,
    templateId: promo.templateId ?? null,
    themeOverride,
    slideCount: generated.slideCount,
    spec: generated.spec,
    caption: generated.caption,
    hashtags: generated.hashtags,

    heroImageUrl: promo.coverImageUrl ?? null,
    // Null for uploads and AI-generated covers, which have nobody to credit, but
    // populated for a stock pick — the same attribution an article hero carries,
    // stamped onto the WP media item by slideCredit() in handlers/carousel.js.
    heroImageCredit: promo.coverCredit ?? null,

    postMode: promo.postMode,
    delayHours: promo.delayHours,

    slides: [],
    approved: false,
    scheduledAt: null,
    postedAt: null,
    platformPostId: null,
    accountId: promo.accountId ?? null,
    error: null,
    rejectedAt: null,
    rejectReason: null,
    archived: false,
    archivedAt: null,

    createdAt: now,
    updatedAt: now,
    createdBy,
  };
}

/** Persist a carousel and register it in the indexes. */
export async function saveCarousel(carousel, { indexIt = false } = {}) {
  const record = { ...carousel, updatedAt: new Date().toISOString() };
  await kv.set(key(record.id), record);
  if (indexIt) {
    // Promo occurrences go in their own list so their rate cannot evict article
    // decks — see the note by PROMO_CAROUSEL_INDEX.
    const indexKey = indexKeyFor(record);
    await kv.lpush(indexKey, record.id);
    await kv.ltrim(indexKey, 0, capFor(indexKey) - 1);
    // Guarded: promotional decks have no article behind them, and writing
    // `social:carousel:by-article:null` would give every promo deck ever built
    // the same pointer — each one silently overwriting the last, and
    // getCarouselForArticle(null) resolving to whichever ran most recently.
    if (record.articleId) await kv.set(byArticleKey(record.articleId), record.id);
  }
  return record;
}

export async function getCarousel(id) {
  return kv.get(key(id));
}

/**
 * Drives createCarousel's idempotency check — an archived deck is deliberately
 * excluded, so an automation re-run (or a manual re-create) builds a fresh deck
 * rather than silently reviving one the user chose to put away.
 */
export async function getCarouselForArticle(articleId) {
  const id = await kv.get(byArticleKey(articleId));
  if (!id) return null;
  const carousel = await getCarousel(id);
  return carousel && !carousel.archived ? carousel : null;
}

/**
 * Newest-first page of carousels.
 *
 * Slide entries are returned whole — they are just WP URLs and ids, not image
 * bytes — but `spec` is dropped unless asked for, since a list view only needs
 * headline metadata and the thumbnails.
 */
export async function listCarousels({ limit = 50, withSpec = false, kind = 'all' } = {}) {
  // Each list is already newest-first, so a single-kind read needs no sorting.
  // 'all' reads `limit` from each and merges, which is why the merge sorts by
  // createdAt rather than trusting either list's order across the join.
  const sources = kind === 'article' ? [CAROUSEL_INDEX]
    : kind === 'promo' ? [PROMO_CAROUSEL_INDEX]
    : [CAROUSEL_INDEX, PROMO_CAROUSEL_INDEX];

  const idLists = await Promise.all(sources.map((k) => kv.lrange(k, 0, limit - 1)));
  const ids = idLists.flat().filter(Boolean);
  if (!ids.length) return [];

  const records = (await Promise.all(ids.map((id) => kv.get(key(id))))).filter(Boolean);
  records.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return records.slice(0, limit).map((c) => (withSpec ? c : { ...c, spec: undefined }));
}

/**
 * How full each index is, and therefore how close either kind is to losing its
 * oldest entries from the review list.
 *
 * Exposed so the UI can warn *before* decks start dropping off rather than after
 * an operator notices something missing — the failure mode here is silent by
 * nature, since an evicted deck looks exactly like one that was never built.
 */
export async function indexUsage() {
  const [articleLen, promoLen] = await Promise.all([
    kv.llen(CAROUSEL_INDEX),
    kv.llen(PROMO_CAROUSEL_INDEX),
  ]);
  return {
    article: { count: articleLen || 0, cap: INDEX_CAP },
    promo: { count: promoLen || 0, cap: PROMO_INDEX_CAP },
  };
}

/**
 * Approve a carousel and put it on the posting queue.
 *
 * Scheduling reuses `autoSchedule(['instagram'])` so carousels land in the same
 * optimal Instagram windows as kit posts. An explicit `scheduledAt` (set by a
 * user in the UI) always wins over the computed slot.
 *
 * @returns {Promise<object>} the updated carousel
 */
export async function queueCarousel(carousel, { scheduledAt = null } = {}) {
  if (carousel.status !== STATUS.ready && carousel.status !== STATUS.scheduled) {
    throw new Error(`Carousel ${carousel.id} is "${carousel.status}" — only a ready carousel can be queued`);
  }
  if (!carousel.slides?.length) {
    throw new Error(`Carousel ${carousel.id} has no rendered slides to post`);
  }

  const when = scheduledAt
    || carousel.scheduledAt
    || autoSchedule(['instagram'])?.instagram
    || new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const postRefId = postRefIdFor(carousel.id);
  await kv.set(`social:postref:${postRefId}`, {
    id: postRefId,
    kind: 'carousel',
    carouselId: carousel.id,
    platform: 'instagram',
    scheduledAt: when,
    status: 'queued',
    createdAt: new Date().toISOString(),
  });
  await kv.zadd('social:queue', { score: new Date(when).getTime(), member: postRefId });

  return saveCarousel({
    ...carousel,
    approved: true,
    scheduledAt: when,
    status: STATUS.scheduled,
  });
}

/** The queue member id for a carousel. One per carousel, so re-queueing a
 *  carousel replaces its entry rather than adding a second one. */
export const postRefIdFor = (carouselId) => `postref_${carouselId}_carousel`;

/**
 * Remove a carousel from the posting queue.
 *
 * Required before posting immediately: without it, a carousel that was already
 * scheduled stays in `social:queue` and the social cron posts it a *second* time
 * when its slot comes round. Marking the ref 'cancelled' rather than deleting it
 * keeps the audit trail of what was queued.
 *
 * @returns {Promise<boolean>} true if something was actually dequeued
 */
export async function dequeueCarousel(carouselId) {
  const postRefId = postRefIdFor(carouselId);
  const removed = await kv.zrem('social:queue', postRefId);
  const ref = await kv.get(`social:postref:${postRefId}`);
  if (ref && ref.status !== 'posted') {
    await kv.set(`social:postref:${postRefId}`, {
      ...ref, status: 'cancelled', cancelledAt: new Date().toISOString(),
    });
  }
  return removed > 0;
}

/**
 * Reject a carousel — the "no" that the review surface was otherwise missing.
 *
 * Deliberately non-destructive: the record and its hosted slides survive, so
 * restoring is instant and costs nothing. What it does do is take the deck off
 * the posting queue and out of the Ready count, so a deck that should never go
 * out stops looking like one that is merely waiting.
 *
 * Refuses an already-posted deck: rejecting cannot un-publish anything, and
 * pretending otherwise would be the misleading outcome.
 *
 * @returns {Promise<object>} the updated carousel
 */
export async function rejectCarousel(carousel, { reason = null } = {}) {
  if (carousel.postedAt) {
    throw new Error('This carousel is already live on Instagram — rejecting it here cannot un-post it.');
  }
  await dequeueCarousel(carousel.id);
  return saveCarousel({
    ...carousel,
    status: STATUS.rejected,
    approved: false,
    scheduledAt: null,
    rejectedAt: new Date().toISOString(),
    rejectReason: reason,
  });
}

/**
 * Undo a rejection. Lands on `ready` when the slides are still hosted (the
 * normal case, since reject leaves them alone) and `draft` when they are not,
 * which is exactly what the UI needs to decide whether to offer "Approve".
 *
 * @returns {Promise<object>} the updated carousel
 */
export async function restoreCarousel(carousel) {
  if (carousel.status !== STATUS.rejected) {
    throw new Error(`Carousel ${carousel.id} is "${carousel.status}", not rejected — nothing to restore`);
  }
  return saveCarousel({
    ...carousel,
    status: carousel.slides?.length ? STATUS.ready : STATUS.draft,
    rejectedAt: null,
    rejectReason: null,
  });
}

/**
 * Put a carousel away without touching its status. Unlike reject, this is
 * meant for decks that are done being useful in the review list regardless of
 * lifecycle stage — most commonly a `posted` deck the reviewer no longer needs
 * to see, but nothing stops archiving a draft or a rejected one either.
 *
 * Dequeues if it was still scheduled (archiving a not-yet-posted deck should
 * also pull it off the posting queue), but leaves `status` exactly as it was —
 * that is the whole point of a flag instead of a status value.
 *
 * @returns {Promise<object>} the updated carousel
 */
export async function archiveCarousel(carousel) {
  if (carousel.archived) {
    throw new Error(`Carousel ${carousel.id} is already archived`);
  }
  if (carousel.scheduledAt && !carousel.postedAt) {
    await dequeueCarousel(carousel.id);
  }
  return saveCarousel({
    ...carousel,
    archived: true,
    archivedAt: new Date().toISOString(),
    ...(carousel.scheduledAt && !carousel.postedAt ? { scheduledAt: null } : {}),
  });
}

/**
 * Undo an archive. Deliberately does not restore a schedule that archiving
 * cleared — if it should still go out, the reviewer re-queues it explicitly via
 * Approve & queue, the same action that would apply to any other ready deck.
 *
 * @returns {Promise<object>} the updated carousel
 */
export async function unarchiveCarousel(carousel) {
  if (!carousel.archived) {
    throw new Error(`Carousel ${carousel.id} is not archived`);
  }
  return saveCarousel({
    ...carousel,
    archived: false,
    archivedAt: null,
  });
}

/**
 * Permanently remove a carousel: queue entry, index entry and record.
 *
 * Hosted slides are the caller's problem — deleting WP media needs `wpAuth()`,
 * which belongs to the HTTP layer, and a media-library failure must not stop the
 * record from being removed.
 *
 * The by-article pointer is only cleared when it still points at *this* deck. If
 * a newer carousel has since been built for the same article, that pointer is
 * now its own, and blanking it would make the automation run treat the article
 * as having no deck and build a third.
 */
export async function deleteCarousel(carousel) {
  await dequeueCarousel(carousel.id);
  // Removed from both lists rather than only the one indexKeyFor picks: a deck
  // whose promoId was added or lost between indexing and deletion would
  // otherwise leave a dangling id behind, and lrem on a list that never held it
  // is a no-op.
  await kv.lrem(CAROUSEL_INDEX, 0, carousel.id);
  await kv.lrem(PROMO_CAROUSEL_INDEX, 0, carousel.id);
  // Same guard as saveCarousel: a promotional deck has no by-article pointer, and
  // reading/deleting `…:by-article:null` would touch a key that never belonged
  // to it.
  if (carousel.articleId) {
    const pointer = await kv.get(byArticleKey(carousel.articleId));
    if (pointer === carousel.id) await kv.del(byArticleKey(carousel.articleId));
  }
  await kv.del(key(carousel.id));
  return { id: carousel.id, deleted: true };
}

/**
 * Guard against decks Instagram will reject outright. The Graph API accepts
 * 2..10 children in a carousel, so this is a hard error rather than a silent
 * truncation — quietly dropping teaching slides would be worse than failing.
 */
export function assertPostableSlideCount(n) {
  // 1 is allowed and is not a carousel: Instagram's carousel endpoint requires
  // 2..10 children, so a single-slide deck is published as a single image post
  // instead (see postSingleViaGraph in platforms/instagram-carousel.js). The
  // upper bound is still a hard error rather than a silent truncation — quietly
  // dropping slides would be worse than failing.
  if (n < 1) throw new Error(`A deck needs at least 1 slide; got ${n}`);
  if (n > MAX_CAROUSEL_SLIDES) {
    throw new Error(`Instagram accepts at most ${MAX_CAROUSEL_SLIDES} carousel slides; got ${n}`);
  }
}

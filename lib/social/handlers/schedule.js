// lib/social/handlers/schedule.js
//
// The post queue — what is waiting to go out, and what an operator can do to it.
//
//   GET    /api/social/schedule                    enriched, schedule-ordered queue
//   POST   /api/social/schedule/:refId/pause       off the clock, record kept
//   POST   /api/social/schedule/:refId/resume      back on the clock
//   POST   /api/social/schedule/:refId/reschedule  move to a new slot
//   POST   /api/social/schedule/:refId/post-now    send it immediately
//   DELETE /api/social/schedule/:refId             take it off the queue
//
// Two kinds of post share this queue: kit posts (no `kind` on the ref) and
// Article/Promotional carousels (`kind: 'carousel'`). Everything below dispatches
// on that, because a carousel owns a record with its own lifecycle — pausing one
// has to move the deck out of `scheduled`, or the Instagram pane would keep
// claiming it is going out.
//
// Pause needs its own index. The cron reads `social:queue` (a sorted set scored by
// scheduledAt), so the only way to stop a post firing is to remove it from there —
// which would also remove it from this list. `social:queue:paused` holds the ids
// that are off the clock but still belong on screen.

import { kv } from '../../kv.js';
import { dispatch } from '../platforms/index.js';
import { resolveAccount } from '../accounts.js';
import { withArticleLink } from '../article-link.js';
import { postCarouselNow } from '../carousel-post.js';
import { getCarousel, saveCarousel, STATUS } from '../carousel-store.js';
import { categoryLabelFor } from '../carousel-theme.js';

const QUEUE_KEY = 'social:queue';
const PAUSED_KEY = 'social:queue:paused';
const POSTED_INDEX = 'social:posted:index';

const refKey = (id) => `social:postref:${id}`;
const kitKey = (id) => `social:kit:${id}`;

const isCarouselRef = (ref) => ref?.kind === 'carousel';

/** First non-empty string among the candidates, trimmed to `max`. */
function preview(...candidates) {
  for (const c of candidates) {
    const s = Array.isArray(c) ? c[0] : c;
    if (typeof s === 'string' && s.trim()) return s.trim().slice(0, 240);
  }
  return '';
}

// ── read ────────────────────────────────────────────────────────────────────

/**
 * Hydrate a post ref into something the queue UI can render and act on without
 * a second round trip: a title, a thumbnail, the provenance a filter needs, and
 * the flags that decide which buttons are live.
 */
async function enrichRef(ref) {
  const base = {
    ...ref,
    kind: isCarouselRef(ref) ? 'carousel' : 'kit',
    paused: ref.status === 'paused',
  };

  if (isCarouselRef(ref)) {
    const deck = await getCarousel(ref.carouselId);
    if (!deck) {
      return { ...base, missing: true, title: `Carousel ${ref.carouselId}`, generationType: 'article-carousel' };
    }
    return {
      ...base,
      title: deck.articleTitle || 'Carousel',
      generationType: deck.promoId ? 'promo-carousel' : 'article-carousel',
      articleId: deck.articleId || null,
      category: deck.category || null,
      // Older decks carry no stamped label; resolve so the row does not read a
      // raw slug next to rows that show a proper name.
      categoryLabel: deck.categoryLabel || (deck.category ? categoryLabelFor(deck.category) : null),
      ruleId: deck.ruleId || null,
      promoId: deck.promoId || null,
      promoName: deck.promoName || null,
      accountId: deck.accountId || null,
      slideCount: deck.slides?.length || deck.slideCount || 0,
      thumb: deck.slides?.[0]?.url || deck.heroImageUrl || null,
      caption: preview(deck.caption),
      staleRender: !!deck.staleRender,
      recordStatus: deck.status,
      // Re-render only means something when there is a deck to re-render.
      canRender: true,
    };
  }

  const kit = await kv.get(kitKey(ref.kitId));
  const data = kit?.platforms?.[ref.platform] || null;
  return {
    ...base,
    title: kit?.articleTitle || ref.kitId || 'Post',
    generationType: 'kit',
    articleId: kit?.articleId || null,
    category: null,
    categoryLabel: null,
    ruleId: null,
    promoId: null,
    promoName: null,
    accountId: data?.accountId || null,
    thumb: data?.image?.url || null,
    caption: preview(data?.caption, data?.hook, data?.thread, data?.teaser),
    staleRender: false,
    recordStatus: kit?.status || null,
    // A kit post has no render step — its image was generated once, with the kit.
    canRender: false,
    missing: !kit || !data,
  };
}

async function listQueue(req, res) {
  const [liveIds, pausedIds] = await Promise.all([
    kv.zrange(QUEUE_KEY, 0, -1), // ascending by scheduledAt
    kv.lrange(PAUSED_KEY, 0, -1),
  ]);

  const ids = [...new Set([...(liveIds || []), ...(pausedIds || [])])];
  if (!ids.length) return res.status(200).json([]);

  const refs = (await Promise.all(ids.map((id) => kv.get(refKey(id))))).filter(Boolean);
  // A ref that has already gone out (or was cancelled) can linger in the paused
  // list if something raced; the queue is "what is still waiting", so filter.
  const waiting = refs.filter((r) => r.status !== 'posted' && r.status !== 'cancelled');

  const items = await Promise.all(waiting.map(enrichRef));
  items.sort((a, b) => new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0));
  return res.status(200).json(items);
}

// ── mutations ───────────────────────────────────────────────────────────────

async function pause(res, ref) {
  if (ref.status === 'paused') return res.status(200).json({ ...ref, alreadyPaused: true });

  await kv.zrem(QUEUE_KEY, ref.id);
  // lrem first so repeated pauses cannot stack duplicate ids in the list.
  await kv.lrem(PAUSED_KEY, 0, ref.id);
  await kv.lpush(PAUSED_KEY, ref.id);

  const updated = { ...ref, status: 'paused', pausedAt: new Date().toISOString() };
  await kv.set(refKey(ref.id), updated);

  // Mirror onto the deck, otherwise the Instagram pane keeps showing it as
  // scheduled while nothing is actually armed to post it.
  if (isCarouselRef(ref)) {
    const deck = await getCarousel(ref.carouselId);
    if (deck && deck.status === STATUS.scheduled) {
      await saveCarousel({ ...deck, status: STATUS.ready, approved: false, scheduledAt: null });
    }
  }
  return res.status(200).json(updated);
}

async function resume(res, ref) {
  if (ref.status !== 'paused') return res.status(409).json({ error: 'This post is not paused.' });

  // A slot that has already passed would fire on the very next cron sweep, which
  // is rarely what "resume" means a week later. Push it a minute out instead.
  const when = new Date(ref.scheduledAt || 0).getTime();
  const scheduledAt = when > Date.now()
    ? ref.scheduledAt
    : new Date(Date.now() + 60 * 1000).toISOString();

  await kv.lrem(PAUSED_KEY, 0, ref.id);
  await kv.zadd(QUEUE_KEY, { score: new Date(scheduledAt).getTime(), member: ref.id });

  const updated = { ...ref, status: 'queued', scheduledAt, pausedAt: null };
  await kv.set(refKey(ref.id), updated);

  if (isCarouselRef(ref)) {
    const deck = await getCarousel(ref.carouselId);
    if (deck && deck.status !== STATUS.posted) {
      await saveCarousel({ ...deck, status: STATUS.scheduled, approved: true, scheduledAt });
    }
  }
  return res.status(200).json(updated);
}

async function reschedule(req, res, ref) {
  const { scheduledAt } = req.body || {};
  const ts = new Date(scheduledAt || '').getTime();
  if (!scheduledAt || Number.isNaN(ts)) {
    return res.status(400).json({ error: 'scheduledAt must be a valid date/time' });
  }
  if (ts < Date.now() - 60 * 1000) {
    return res.status(400).json({ error: 'Pick a time in the future — a past slot would post on the next sweep.' });
  }

  // Rescheduling a paused post also un-pauses it: choosing a new slot is a
  // statement that it should go out then.
  await kv.lrem(PAUSED_KEY, 0, ref.id);
  await kv.zadd(QUEUE_KEY, { score: ts, member: ref.id });

  const updated = { ...ref, status: 'queued', scheduledAt: new Date(ts).toISOString(), pausedAt: null };
  await kv.set(refKey(ref.id), updated);

  if (isCarouselRef(ref)) {
    const deck = await getCarousel(ref.carouselId);
    if (deck && deck.status !== STATUS.posted) {
      await saveCarousel({ ...deck, status: STATUS.scheduled, approved: true, scheduledAt: updated.scheduledAt });
    }
  }
  return res.status(200).json(updated);
}

/**
 * Take a post off the queue without destroying anything it was built from.
 *
 * The deck or kit survives — a carousel drops back to `ready` and reappears in
 * the Instagram review pane, a kit post goes back to un-approved in Kit Builder.
 * Deleting the underlying record is a separate, explicit action on that record.
 */
async function trash(res, ref) {
  await kv.zrem(QUEUE_KEY, ref.id);
  await kv.lrem(PAUSED_KEY, 0, ref.id);
  await kv.set(refKey(ref.id), { ...ref, status: 'cancelled', cancelledAt: new Date().toISOString() });

  if (isCarouselRef(ref)) {
    const deck = await getCarousel(ref.carouselId);
    if (deck && deck.status === STATUS.scheduled) {
      await saveCarousel({ ...deck, status: STATUS.ready, approved: false, scheduledAt: null });
    }
  } else {
    const kit = await kv.get(kitKey(ref.kitId));
    const data = kit?.platforms?.[ref.platform];
    if (kit && data && !data.postedAt) {
      kit.platforms[ref.platform] = { ...data, approved: false, scheduledAt: null };
      await kv.set(kitKey(kit.id), { ...kit, updatedAt: new Date().toISOString() });
    }
  }
  return res.status(200).json({ id: ref.id, removed: true });
}

/**
 * Send a queued post now.
 *
 * Dequeues before dispatching, in both branches: leaving the ref armed means the
 * cron posts the same thing a second time when its original slot arrives.
 */
async function postNow(res, ref) {
  await kv.zrem(QUEUE_KEY, ref.id);
  await kv.lrem(PAUSED_KEY, 0, ref.id);

  if (isCarouselRef(ref)) {
    const deck = await getCarousel(ref.carouselId);
    if (!deck) return res.status(404).json({ error: 'The carousel behind this queue entry no longer exists.' });
    try {
      const { carousel, degraded } = await postCarouselNow(deck);
      await kv.set(refKey(ref.id), { ...ref, status: 'posted', postedAt: new Date().toISOString() });
      await kv.lpush(POSTED_INDEX, ref.id);
      return res.status(200).json({ posted: true, degraded, platformPostId: carousel.platformPostId });
    } catch (err) {
      const isPreflight = /rendered slides|Re-render before posting|at least 2 slides|at most|rejected/.test(err.message);
      // Put it back on the clock when the platform failed — the operator has not
      // been given a reason to abandon the slot, only this attempt.
      if (!isPreflight && ref.scheduledAt) {
        await kv.zadd(QUEUE_KEY, { score: new Date(ref.scheduledAt).getTime(), member: ref.id });
      }
      return res.status(isPreflight ? 400 : 502).json({ error: err.message });
    }
  }

  const kit = await kv.get(kitKey(ref.kitId));
  const data = kit?.platforms?.[ref.platform];
  if (!kit || !data) return res.status(404).json({ error: 'The kit behind this queue entry no longer exists.' });

  try {
    const account = await resolveAccount(ref.platform, data.accountId);
    const result = await dispatch(ref.platform, await withArticleLink(data, kit), account);

    kit.platforms[ref.platform] = {
      ...data,
      postedAt: new Date().toISOString(),
      platformPostId: result.postId || null,
    };
    await kv.set(kitKey(kit.id), { ...kit, updatedAt: new Date().toISOString() });
    await kv.set(refKey(ref.id), { ...ref, status: 'posted', postedAt: new Date().toISOString() });
    await kv.lpush(POSTED_INDEX, ref.id);

    return res.status(200).json({ posted: true, platformPostId: result.postId || null });
  } catch (err) {
    if (ref.scheduledAt) {
      await kv.zadd(QUEUE_KEY, { score: new Date(ref.scheduledAt).getTime(), member: ref.id });
    }
    return res.status(502).json({ error: `${ref.platform} post failed: ${err.message}` });
  }
}

// ── router ──────────────────────────────────────────────────────────────────

/**
 * @param {string} [id] - post ref id
 * @param {string} [action] - 'pause' | 'resume' | 'reschedule' | 'post-now'
 */
export default async function handler(req, res, { id, action } = {}) {
  try {
    if (!id) {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      return await listQueue(req, res);
    }

    const ref = await kv.get(refKey(id));
    if (!ref) return res.status(404).json({ error: `No queued post ${id}` });

    if (req.method === 'DELETE' && !action) return await trash(res, ref);

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    if (action === 'pause')      return await pause(res, ref);
    if (action === 'resume')     return await resume(res, ref);
    if (action === 'reschedule') return await reschedule(req, res, ref);
    if (action === 'post-now')   return await postNow(res, ref);
    if (action === 'trash')      return await trash(res, ref);

    return res.status(404).json({ error: `Unknown queue action "${action}"` });
  } catch (err) {
    console.error('[schedule] error:', err);
    if (res.headersSent) throw err;
    return res.status(500).json({ error: err.message });
  }
}

// lib/social/carousel-post.js
//
// Posting and scheduling for Article Carousels — the single implementation shared
// by the "Post now" button, the automation run, and the approve-on-review path.
//
// The scheduling rule that matters: every automatic mode is anchored to the moment
// the ARTICLE goes live, never to when the carousel was generated. Since decks are
// built off the back of a successful WordPress publish
// (lib/social/carousel-on-publish.js), those two moments now coincide. Without
// this anchoring a carousel could post while its "READ THE FULL ARTICLE" slide
// still pointed at an unpublished post, and the caption's deep link (injected from
// `wpPostUrl`) would resolve to nothing — which is exactly what happened while the
// approve handler applied post modes regardless of whether its publish succeeded.

import { kv } from '../kv.js';
import { dispatchCarousel } from './platforms/index.js';
import { acquirePostGate } from './post-gate.js';
import { resolveAccount } from './accounts.js';
import { articleLinkFor } from './article-link.js';
import { autoSchedule } from './scheduler.js';
import {
  saveCarousel, queueCarousel, dequeueCarousel, assertPostableSlideCount, STATUS,
  postRefIdFor,
} from './carousel-store.js';

/** Fallback when autoSchedule somehow yields nothing. */
const FALLBACK_DELAY_MS = 60 * 60 * 1000;

/** How many entries the posted feed keeps. Reads are bounded by the caller's
 *  `limit`, so a longer list costs storage only. */
const POSTED_INDEX_CAP = 500;

/**
 * Add a deck to the posted feed, minting the post ref if the deck never went
 * through the queue (an immediate post has no ref of its own).
 */
async function recordPosted(carouselId) {
  const refId = postRefIdFor(carouselId);
  const existing = await kv.get(`social:postref:${refId}`);
  await kv.set(`social:postref:${refId}`, {
    ...(existing || { id: refId, kind: 'carousel', carouselId, platform: 'instagram', createdAt: new Date().toISOString() }),
    status: 'posted',
    postedAt: new Date().toISOString(),
  });
  await kv.lrem('social:posted:index', 0, refId);
  await kv.lpush('social:posted:index', refId);
  await kv.ltrim('social:posted:index', 0, POSTED_INDEX_CAP - 1);
}

/**
 * Publish a carousel to Instagram right now.
 *
 * Dequeues first: if the deck was already scheduled it is sitting in
 * `social:queue`, and leaving it there means the social cron posts it a second
 * time when its slot arrives. Dequeue precedes the post so a crash mid-post cannot
 * leave a duplicate armed.
 *
 * On failure the deck is left `failed` with the reason rather than re-queued —
 * an immediate post is a deliberate act, so the operator should see it and decide.
 *
 * @param {object} carousel
 * @returns {Promise<object>} the updated carousel (with a transient `cleanup`-style
 *   `degraded` flag when the platform could only manage a single image)
 */
export async function postCarouselNow(carousel) {
  if (carousel.status === STATUS.rejected) {
    throw new Error('This carousel was rejected. Restore it before posting.');
  }
  if (!carousel.slides?.length) {
    throw new Error('No rendered slides to post — render the carousel first.');
  }
  if (carousel.staleRender) {
    throw new Error('Copy was edited after these slides were rendered. Re-render before posting.');
  }
  assertPostableSlideCount(carousel.slides.length);

  const dequeued = await dequeueCarousel(carousel.id);
  const link = await articleLinkFor({ articleId: carousel.articleId });
  const account = await resolveAccount('instagram', carousel.accountId);

  // Space this post against every other invocation posting right now. A bulk
  // publish fans out one invocation per article, all of which reach here within
  // seconds of each other, and Meta's crawler cannot keep up with the resulting
  // wall of slide fetches. See post-gate.js.
  const gate = await acquirePostGate();
  if (!gate.gated) console.warn(`[carousel] posting ${carousel.id} without the spacing gate — ${gate.reason}`);

  try {
    const result = await dispatchCarousel(carousel, account, link);
    const saved = await saveCarousel({
      ...carousel,
      status: STATUS.posted,
      approved: true,
      postedAt: new Date().toISOString(),
      platformPostId: result.postId || null,
      error: null,
      // Assigned, not spread-when-true: a retry that finally succeeds as a real
      // carousel must be able to clear an earlier degraded flag.
      degraded: !!result.degraded,
    });
    // Register in the posted feed. Without this a deck sent straight out (Post
    // now, or an `immediate` post mode) is invisible in Social > Posted until the
    // carousel-index fallback happens to still hold it.
    await recordPosted(carousel.id).catch(() => {});
    return { carousel: saved, dequeued, degraded: !!result.degraded };
  } catch (err) {
    await saveCarousel({ ...carousel, status: STATUS.failed, error: err.message });
    throw err;
  }
}

/**
 * Resolve a post mode into the instant it should go out, or null for "don't".
 *
 * @param {string} mode
 * @param {number} delayHours
 * @param {Date} [anchor] - when the article went live; defaults to now
 * @returns {string|null} ISO timestamp, or null when no automatic post applies
 */
export function resolvePostTime(mode, delayHours, anchor = new Date()) {
  if (mode === 'delay') {
    const hours = Math.min(168, Math.max(1, Number(delayHours) || 24));
    return new Date(anchor.getTime() + hours * 3600 * 1000).toISOString();
  }
  if (mode === 'optimal') {
    return autoSchedule(['instagram'], anchor)?.instagram
      || new Date(anchor.getTime() + FALLBACK_DELAY_MS).toISOString();
  }
  return null; // 'immediate' posts directly; 'approval' waits for a human
}

/**
 * Act on a carousel's configured post mode, now that its article is live.
 *
 * Called from carousel-on-publish.js (for a deck that already existed when its
 * article went live) and from createCarousel's `applySchedule` branch (for one
 * built by that same publish). Callers are responsible for only calling it once
 * the article is actually on WordPress.
 *
 * Never throws: a social asset must not be able to fail an article publish or an
 * approval. The outcome is described in the return value and stamped on the record.
 *
 * @param {object} carousel
 * @returns {Promise<{action: string, scheduledAt?: string, error?: string}>}
 */
export async function applyPostMode(carousel) {
  const mode = carousel.postMode || 'approval';

  // A reject can land before the article does — on a review-required rule the
  // deck is reviewable for as long as the article sits in review, and approve.js
  // calls this the moment the article goes live. Without this check an automatic
  // mode would happily post a deck a human had already turned down.
  if (carousel.status === STATUS.rejected) return { action: 'skipped', error: 'carousel was rejected' };

  if (mode === 'approval') return { action: 'awaiting_approval' };

  if (!carousel.slides?.length) {
    return { action: 'skipped', error: 'no rendered slides' };
  }

  try {
    if (mode === 'immediate') {
      const { degraded } = await postCarouselNow(carousel);
      return { action: degraded ? 'posted_degraded' : 'posted' };
    }

    const when = resolvePostTime(mode, carousel.delayHours);
    const saved = await queueCarousel(carousel, { scheduledAt: when });
    return { action: 'scheduled', scheduledAt: saved.scheduledAt };
  } catch (err) {
    // Leave the deck reviewable rather than silently dead: an operator can still
    // fix and post it by hand from Social ▸ Carousels.
    await saveCarousel({ ...carousel, status: STATUS.failed, error: err.message }).catch(() => {});
    return { action: 'failed', error: err.message };
  }
}

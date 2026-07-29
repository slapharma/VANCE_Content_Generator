// lib/social/handlers/carousel.js
//
// HTTP surface for Article Carousels:
//
//   POST   /api/social/carousel                  create (spec + render + host) for a contentId
//   GET    /api/social/carousels                 newest-first list
//   GET    /api/social/carousels/:id             one record, with spec
//   PATCH  /api/social/carousels/:id             edit copy / approval / schedule
//   DELETE /api/social/carousels/:id             permanent delete, slides included
//   POST   /api/social/carousels/:id/render      re-render after copy edits
//   POST   /api/social/carousels/:id/deploy      approve + queue for posting
//   POST   /api/social/carousels/:id/post-now    post to Instagram immediately
//   POST   /api/social/carousels/:id/reject      take it off the queue, keep the record
//   POST   /api/social/carousels/:id/restore     undo a reject
//
// Create is synchronous — spec generation, eight renders and eight WP uploads run
// to completion before responding. That totals well under 30s against the 300s
// function budget, and returning a half-built carousel would leave the caller
// (the automation run, or the UI) with nothing useful to show or retry against.

import { kv } from '../../kv.js';
import { buildCarouselSpec, DEFAULT_SLIDE_COUNT, CAROUSEL_STYLES } from '../carousel-spec.js';
import { uploadImageBufferToWp, uploadImageUrlToWp, deleteWpMedia, wpAuth, slugify } from '../wp-media.js';
import { BRAND } from '../ava-prompts.js';
// Posting + schedule resolution live in carousel-post.js, shared with the
// automation run and the approve-on-review path so all three behave identically.
import { postCarouselNow, applyPostMode } from '../carousel-post.js';
import {
  buildCarousel, saveCarousel, getCarousel, getCarouselForArticle,
  listCarousels, queueCarousel, assertPostableSlideCount, STATUS,
  rejectCarousel, restoreCarousel, deleteCarousel,
  archiveCarousel, unarchiveCarousel, indexUsage,
} from '../carousel-store.js';

/** Attribution for the cover photo, stamped onto every uploaded slide's media
 *  item. Mirrors buildHeroCredit() in api/publish so stock-photo credit travels
 *  with the image wherever it is hosted, per the Unsplash API guidelines. */
function slideCredit(carousel) {
  const c = carousel.heroImageCredit;
  if (!c?.photographer) return null;
  const isUnsplash = (c.provider || '') === 'unsplash';
  const svc = isUnsplash ? 'Unsplash' : 'Pexels';
  const utm = 'utm_source=vance_health_hub&utm_medium=referral';
  const home = isUnsplash ? `https://unsplash.com/?${utm}` : 'https://www.pexels.com/';
  let pUrl = c.photographerUrl || '';
  if (pUrl && isUnsplash) pUrl += (pUrl.includes('?') ? '&' : '?') + utm;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const name = pUrl
    ? `<a href="${esc(pUrl)}" target="_blank" rel="noopener nofollow">${esc(c.photographer)}</a>`
    : esc(c.photographer);
  return {
    plain: `Photo by ${c.photographer} on ${svc}`,
    html: `Photo by ${name} on <a href="${esc(home)}" target="_blank" rel="noopener nofollow">${svc}</a>`,
  };
}

/**
 * Render the deck and host every slide in the WP media library.
 *
 * Hosting on WP is what makes the slides postable at all: Instagram's Graph API
 * fetches `image_url` itself, so the bytes need a public home, and WP gives
 * permanent URLs on the brand's own domain without needing a post to exist.
 *
 * Uploads are sequential to stay gentle on the WP REST endpoint — eight parallel
 * multi-hundred-KB POSTs is a good way to get rate-limited by a shared host.
 *
 * Exported for lib/social/promo-run.js, which mints promotional decks and must
 * host them identically — same filenames, same sequential uploads, same
 * supersede-and-clean-up behaviour. Two copies of this would drift.
 *
 * @returns {Promise<object>} the updated, saved carousel
 */
export async function renderAndHost(carousel) {
  const working = await saveCarousel({ ...carousel, status: STATUS.rendering, error: null });

  try {
    // Imported lazily so satori + resvg + jpeg-js (and the embedded fonts) are
    // only loaded when something actually renders. They are by far the heaviest
    // thing in this function's bundle, and /api/social/* also serves deploy, cron,
    // connections and accounts — none of which should pay that cold-start cost.
    const { renderCarouselSlides } = await import('../carousel-render.js');
    const rendered = await renderCarouselSlides(working, { handle: BRAND.handle });
    assertPostableSlideCount(rendered.length);

    const { siteUrl, authHeader } = wpAuth();
    if (!siteUrl) throw new Error('WP_SITE_URL is not configured — cannot host carousel slides');

    const credit = slideCredit(working);
    const titleSlug = slugify(working.articleTitle, 32);
    const slides = [];

    for (const slide of rendered) {
      const filename = `${titleSlug}-carousel-${String(slide.index).padStart(2, '0')}-${slide.type}.jpg`;
      const media = await uploadImageBufferToWp(slide.buffer, {
        filename,
        contentType: 'image/jpeg',
        siteUrl,
        authHeader,
        // Credit belongs on the two slides that actually show the photo.
        credit: slide.type === 'cover' || slide.type === 'cta' ? credit : null,
        logPrefix: 'carousel',
      });
      if (!media?.url) {
        throw new Error(`Slide ${slide.index} (${slide.type}) failed to upload to the WP media library`);
      }
      slides.push({ index: slide.index, type: slide.type, mediaId: media.id, url: media.url });
    }

    // Re-read before the final save. A render holds `working` for as long as the
    // spec generation, eight renders and eight WP uploads take, and a reject
    // landing inside that window would otherwise be overwritten by this save —
    // the deck would come back 'ready' and post itself. The new slides are still
    // committed either way; only the status defers to the reject.
    const current = await getCarousel(working.id);
    const rejectedMidRender = current?.status === STATUS.rejected;

    const saved = await saveCarousel({
      ...working,
      ...(rejectedMidRender ? { rejectedAt: current.rejectedAt, rejectReason: current.rejectReason } : {}),
      slides,
      slideCount: slides.length,
      status: rejectedMidRender ? STATUS.rejected : STATUS.ready,
      error: null,
      staleRender: false,
    });

    // Bin the slides this render replaced. WP never overwrites — re-uploading the
    // same filename produces `…-1.jpg`, `…-2.jpg` — so without this every
    // re-render would orphan 8 files in the media library. Deliberately after the
    // save: if cleanup fails we have already committed the new, working slides.
    //
    // Safe even for an already-posted deck: the Graph API downloads `image_url` at
    // publish time and serves its own copy from Instagram's CDN, so the WP file is
    // only ever the source for that fetch, never what viewers load.
    const superseded = (carousel.slides || [])
      .map((s) => s.mediaId)
      .filter((id) => id && !slides.some((n) => n.mediaId === id));
    if (superseded.length) {
      const r = await deleteWpMedia(superseded, { siteUrl, authHeader, logPrefix: 'carousel' });
      console.log(`[carousel] cleaned up ${r.deleted}/${r.attempted} superseded slide(s) for ${carousel.id}`);
      // Reported on the response but never persisted: housekeeping outcome is
      // useful for diagnosing a permissions problem, and Vercel's log API is not
      // always reachable. Non-enumerable so it cannot leak into a later save.
      Object.defineProperty(saved, 'cleanup', { value: r, enumerable: true });
    }

    return saved;
  } catch (err) {
    await saveCarousel({ ...working, status: STATUS.failed, error: err.message });
    throw err;
  }
}

/**
 * Host slide images that were rendered somewhere else, and save the deck.
 *
 * The Canva path's counterpart to renderAndHost: the artwork already exists as
 * finished pages, so there is nothing to render, but the images still have to be
 * copied onto WP. That is not optional — Canva's export URLs expire (and
 * Instagram's Graph API fetches `image_url` itself at publish time), so posting
 * a deck that points at them would work today and break next week.
 *
 * @param {object} carousel
 * @param {string[]} urls - public image URLs, in page order
 * @returns {Promise<object>} the updated, saved carousel
 */
export async function hostExternalSlides(carousel, urls) {
  const working = await saveCarousel({ ...carousel, status: STATUS.rendering, error: null });

  try {
    assertPostableSlideCount(urls.length);
    const { siteUrl, authHeader } = wpAuth();
    if (!siteUrl) throw new Error('WP_SITE_URL is not configured — cannot host carousel slides');

    const slides = [];

    // Sequential, matching renderAndHost: eight parallel multi-hundred-KB POSTs
    // is a good way to get rate-limited by a shared host.
    for (const [i, url] of urls.entries()) {
      const index = i + 1;
      // uploadImageUrlToWp slugifies the title itself, so the filenames land in
      // the same shape renderAndHost produces.
      const media = await uploadImageUrlToWp(url, {
        title: `${working.articleTitle} slide ${index}`,
        siteUrl,
        authHeader,
        suffix: `carousel-${String(index).padStart(2, '0')}`,
        logPrefix: 'carousel-external',
      });
      if (!media?.url) {
        throw new Error(`Slide ${index} could not be copied from Canva into the WP media library`);
      }
      slides.push({ index, type: index === 1 ? 'cover' : 'canva', mediaId: media.id, url: media.url });
    }

    // Same reject-mid-render guard renderAndHost uses: a human saying no while a
    // long export was in flight must not be overwritten by this save.
    const current = await getCarousel(working.id);
    const rejectedMidRender = current?.status === STATUS.rejected;

    const saved = await saveCarousel({
      ...working,
      ...(rejectedMidRender ? { rejectedAt: current.rejectedAt, rejectReason: current.rejectReason } : {}),
      slides,
      slideCount: slides.length,
      status: rejectedMidRender ? STATUS.rejected : STATUS.ready,
      error: null,
      staleRender: false,
    });

    const superseded = (carousel.slides || [])
      .map((s) => s.mediaId)
      .filter((id) => id && !slides.some((n) => n.mediaId === id));
    if (superseded.length) {
      const r = await deleteWpMedia(superseded, { siteUrl, authHeader, logPrefix: 'carousel-external' });
      console.log(`[carousel] cleaned up ${r.deleted}/${r.attempted} superseded slide(s) for ${carousel.id}`);
    }

    return saved;
  } catch (err) {
    await saveCarousel({ ...working, status: STATUS.failed, error: err.message });
    throw err;
  }
}

// ── POST /api/social/carousel ──────────────────────────────────────────────

async function createCarousel(req, res) {
  const {
    contentId, slideCount = DEFAULT_SLIDE_COUNT, ruleId = null, force = false, createdBy,
    // How and when this deck should post. `applySchedule` says whether the
    // article is already live: carousel-on-publish.js passes true, because it
    // only ever runs after a successful WordPress publish. The UI's manual
    // "create carousel" leaves it false — an operator building a deck by hand
    // decides for themselves when it goes out.
    postMode = 'approval', delayHours = 24, applySchedule = false,
    // Which Instagram account this deck should post to. null keeps today's
    // behaviour (resolveAccount falls back to the platform default) — see
    // lib/social/accounts.js resolveAccount() and carousel-post.js.
    accountId = null,
    // Content style — see buildCarouselSpec's style param and CAROUSEL_STYLES
    // above. Unknown values fall back to 'education' rather than failing the
    // request, matching the rule schema's own enum-whitelist idiom.
    style: rawStyle,
  } = req.body || {};
  const style = CAROUSEL_STYLES.includes(rawStyle) ? rawStyle : 'education';
  if (!contentId) return res.status(400).json({ error: 'contentId is required' });

  const article = await kv.get(`content:${contentId}`);
  if (!article) return res.status(404).json({ error: `No content record for ${contentId}` });

  // Idempotency matters here: the automation run retries, and the social cron can
  // re-enter. Without this, one article could accumulate several decks and
  // several sets of uploaded media.
  if (!force) {
    const existing = await getCarouselForArticle(contentId);
    if (existing) {
      return res.status(200).json({ ...existing, reused: true });
    }
  }

  const generated = await buildCarouselSpec({ article, slideCount, style });
  const created = await saveCarousel(
    buildCarousel({
      article, generated, ruleId, createdBy: createdBy || 'automation',
      postMode, delayHours, accountId, style,
    }),
    { indexIt: true },
  );

  const hosted = await renderAndHost(created);

  // Only act on the schedule once the article is actually live. applyPostMode is
  // non-throwing, so a posting problem surfaces in the payload instead of failing
  // the whole build — the deck is already rendered and hosted by this point.
  if (applySchedule) {
    const outcome = await applyPostMode(hosted);
    const refreshed = (await getCarousel(hosted.id)) || hosted;
    return res.status(201).json({ ...refreshed, schedule: outcome });
  }
  return res.status(201).json(hosted);
}

// ── GET /api/social/carousels ──────────────────────────────────────────────

async function indexCarousels(req, res) {
  const limit = Math.min(Number(req.query?.limit) || 50, 200);
  // `kind` selects which index to read: 'article', 'promo', or both (default).
  // Article and promo decks live in separate capped lists so promo volume cannot
  // evict article decks — see PROMO_CAROUSEL_INDEX in carousel-store.js.
  const kind = ['article', 'promo', 'all'].includes(req.query?.kind) ? req.query.kind : 'all';
  const carousels = await listCarousels({ limit, kind });

  // Index headroom rides along on the list response rather than needing its own
  // round trip. The UI warns on it, because an evicted deck is invisible in a way
  // that looks identical to one that was never built.
  return res.status(200).json({ carousels, usage: await indexUsage() });
}

// ── /api/social/carousels/:id ──────────────────────────────────────────────

/** Fields a client may edit. Everything else (slides, status, ids, timestamps)
 *  is owned by the server. */
const EDITABLE = ['spec', 'caption', 'hashtags', 'accountId', 'scheduledAt', 'approved'];

/**
 * Post a carousel to Instagram immediately, bypassing the queue.
 *
 * Three things this has to get right, because the action is public and
 * irreversible:
 *
 *   1. **Dequeue first.** If the carousel was already scheduled it is sitting in
 *      `social:queue`, and leaving it there means the social cron posts the same
 *      deck a second time when its slot arrives. Dequeue happens before the post
 *      so a crash mid-post cannot leave a duplicate armed.
 *   2. **Refuse an already-posted deck** unless explicitly forced. Double-posting
 *      the same carousel is the most likely way to misuse this button.
 *   3. **Stale renders are a hard stop.** If the copy was edited after the slides
 *      were rendered, the hosted images do not match the approved copy — posting
 *      that is worse than refusing, so the caller has to re-render first.
 */
async function postNowRoute(req, res, carousel) {
  const { force = false } = req.body || {};

  // The one guard that stays at this layer rather than in the shared core:
  // refusing a repeat protects a human from double-posting, and none of the
  // automated paths ever re-post a deck.
  if (carousel.postedAt && !force) {
    return res.status(409).json({
      error: `Already posted at ${carousel.postedAt}${carousel.platformPostId ? ` (post ${carousel.platformPostId})` : ''}. Pass force: true to post it again.`,
    });
  }

  try {
    const { carousel: posted, dequeued, degraded } = await postCarouselNow(carousel);
    return res.status(200).json({ ...posted, dequeued, degraded });
  } catch (err) {
    // 400 when the operator has to fix something first, 502 for a platform failure.
    const isPreflight = /rendered slides|Re-render before posting|at least 2 slides|at most/.test(err.message);
    return res.status(isPreflight ? 400 : 502).json({
      error: isPreflight ? err.message : `Instagram post failed: ${err.message}`,
    });
  }
}

async function carouselById(req, res, id, action) {
  const carousel = await getCarousel(id);
  if (!carousel) return res.status(404).json({ error: 'Carousel not found' });

  if (action === 'render') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    return res.status(200).json(await renderAndHost(carousel));
  }

  if (action === 'deploy') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { scheduledAt = null } = req.body || {};
    return res.status(200).json(await queueCarousel(carousel, { scheduledAt }));
  }

  if (action === 'post-now') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    return postNowRoute(req, res, carousel);
  }

  if (action === 'reject') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    // 409, not 500: rejecting a live deck is a state conflict the caller can
    // understand and act on, not a server fault.
    try {
      return res.status(200).json(await rejectCarousel(carousel, { reason: req.body?.reason || null }));
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
  }

  if (action === 'restore') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      return res.status(200).json(await restoreCarousel(carousel));
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
  }

  if (action === 'archive') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      return res.status(200).json(await archiveCarousel(carousel));
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
  }

  if (action === 'unarchive') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      return res.status(200).json(await unarchiveCarousel(carousel));
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
  }

  if (req.method === 'GET') return res.status(200).json(carousel);

  // Permanent delete. Slides go first because they need the record to know which
  // media ids to bin; the record is removed regardless of how WP responds, so a
  // media-library permission problem cannot leave an undeletable carousel behind.
  if (req.method === 'DELETE') {
    let cleanup = null;
    const mediaIds = (carousel.slides || []).map((s) => s.mediaId).filter(Boolean);
    if (mediaIds.length) {
      try {
        const { siteUrl, authHeader } = wpAuth();
        if (siteUrl) {
          cleanup = await deleteWpMedia(mediaIds, { siteUrl, authHeader, logPrefix: 'carousel' });
          console.log(`[carousel] deleted ${cleanup.deleted}/${cleanup.attempted} slide(s) for ${carousel.id}`);
        }
      } catch (err) {
        console.warn(`[carousel] slide cleanup failed for ${carousel.id}: ${err.message}`);
        cleanup = { error: err.message };
      }
    }
    return res.status(200).json({ ...(await deleteCarousel(carousel)), cleanup });
  }

  if (req.method === 'PATCH') {
    const body = req.body || {};
    const patch = {};
    for (const field of EDITABLE) {
      if (field in body) patch[field] = body[field];
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: `Nothing to update. Editable fields: ${EDITABLE.join(', ')}` });
    }
    // Editing the copy invalidates the hosted images — they were rendered from
    // the previous spec. Flag it rather than silently re-rendering, so the client
    // decides when to pay for a render (and can show "needs re-render").
    const specChanged = 'spec' in patch && JSON.stringify(patch.spec) !== JSON.stringify(carousel.spec);
    return res.status(200).json(await saveCarousel({
      ...carousel,
      ...patch,
      ...(specChanged ? { staleRender: true } : {}),
    }));
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ── router ─────────────────────────────────────────────────────────────────

/**
 * @param {string} resource - 'carousel' (create) or 'carousels' (collection)
 * @param {string} [id]
 * @param {string} [action] - 'render' | 'deploy' | 'post-now' | 'reject' | 'restore'
 */
export default async function handler(req, res, { resource, id, action } = {}) {
  try {
    if (resource === 'carousel' && !id) {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      return await createCarousel(req, res);
    }
    if (resource === 'carousels' && !id) return await indexCarousels(req, res);
    if (id) return await carouselById(req, res, id, action);
    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('[carousel] error:', err);
    if (res.headersSent) throw err;
    return res.status(500).json({ error: err.message });
  }
}

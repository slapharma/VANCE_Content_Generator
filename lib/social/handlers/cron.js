// lib/social/handlers/cron.js
import { kv } from '../../kv.js';
import { dispatch, dispatchCarousel } from '../platforms/index.js';
import { resolveAccount } from '../accounts.js';
import { withArticleLink, articleLinkFor } from '../article-link.js';
import { getCarousel, saveCarousel, STATUS } from '../carousel-store.js';
import { listPromos } from '../promo-store.js';
import { isDue } from '../promo-schema.js';
import { runPromoOccurrence } from '../promo-run.js';
import { heartbeat } from '../../heartbeat.js';

/** Ceiling on promo occurrences minted in one sweep. Each one is an LLM call
 *  plus 6-10 renders plus 6-10 WP uploads (~60-100s), and this function shares a
 *  300s budget with draining the post queue. Anything not minted this hour is
 *  still due next hour — `nextRunAt` is only advanced once a deck exists. */
const MAX_PROMOS_PER_SWEEP = 2;

// Stop retrying a post after this many failed attempts (was: retry forever).
const MAX_RETRIES = Number(process.env.SOCIAL_MAX_RETRIES) || 5;

function isAuthorised(req) {
  const cronHeader = req.headers['x-vercel-cron'];
  const authHeader = req.headers['authorization'];
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  return cronHeader === '1' || authHeader === expectedAuth;
}

export default async function handler(req, res) {
  // GET is the Vercel cron path, POST the manual one. Both are gated by
  // isAuthorised, so the method carries no authority of its own.
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!isAuthorised(req)) return res.status(401).json({ error: 'Unauthorised' });

  const nowMs = Date.now();

  try {
    // Promotional campaigns are swept first, before the post queue is drained.
    // Order matters: a campaign in `immediate` mode posts inside its own mint, and
    // one in `delay`/`optimal` mode lands on social:queue with a future score, so
    // running the sweep first never makes this invocation's drain do more work —
    // but running it second would leave an immediate-mode promo a full hour late.
    const promoResults = await sweepPromoCampaigns();

    // Fetch all postRef IDs due now (score <= nowMs)
    const dueIds = await kv.zrangebyscore('social:queue', 0, nowMs);
    if (!dueIds || !dueIds.length) {
      // An empty queue is the normal outcome for most runs, and it still has to
      // report in — "nothing to post" and "the cron is dead" look identical from
      // outside, and only this ping tells them apart.
      await heartbeat('cg-social-cron', {
        status: promoResults.failed ? 'warn' : 'ok',
        message: promoResults.total
          ? `nothing due; ${promoResults.minted} promo occurrence(s) minted`
          : 'nothing due',
      });
      return res.status(200).json({ processed: 0, promos: promoResults });
    }

    const results = [];

    for (const postRefId of dueIds) {
      // Atomically remove from queue before processing (prevents double-fire on concurrent crons)
      const removed = await kv.zrem('social:queue', postRefId);
      if (removed === 0) continue; // another cron already took it

      const postRef = await kv.get(`social:postref:${postRefId}`);
      if (!postRef) { console.warn(`[cron] postRef not found: ${postRefId}`); continue; }

      // Two kinds of queued post share this queue so they share its retry and
      // backoff behaviour. A ref with no `kind` is a kit post — that is every
      // ref written before Article Carousels existed.
      const isCarousel = postRef.kind === 'carousel';

      let kit = null;
      let carousel = null;
      let platformData = null;

      if (isCarousel) {
        carousel = await getCarousel(postRef.carouselId);
        if (!carousel) { console.warn(`[cron] carousel not found for postRef ${postRefId}: carouselId=${postRef.carouselId}`); continue; }
        // Reject dequeues, so normally this ref would not be here at all — but a
        // reject landing between this run's zrangebyscore and its zrem would slip
        // through. Cheap insurance against posting something a human said no to.
        if (carousel.status === STATUS.rejected) { console.log(`[cron] carousel ${carousel.id} was rejected — skipping`); continue; }
        if (!carousel.slides?.length) { console.warn(`[cron] carousel ${carousel.id} has no rendered slides — skipping`); continue; }
      } else {
        kit = await kv.get(`social:kit:${postRef.kitId}`);
        if (!kit) { console.warn(`[cron] kit not found for postRef ${postRefId}: kitId=${postRef.kitId}`); continue; }

        platformData = kit.platforms[postRef.platform];
        if (!platformData) { console.warn(`[cron] no platform data for ${postRef.platform} in kit ${postRef.kitId}`); continue; }
      }

      try {
        const accountId = isCarousel ? carousel.accountId : platformData.accountId;
        const account = await resolveAccount(postRef.platform, accountId);

        let result;
        if (isCarousel) {
          // The article link is resolved at posting time, not render time: on the
          // review path the carousel exists before the article is published, so
          // `wpPostUrl` only becomes available later.
          const link = await articleLinkFor({ articleId: carousel.articleId });
          result = await dispatchCarousel(carousel, account, link);

          await saveCarousel({
            ...carousel,
            status: STATUS.posted,
            postedAt: new Date().toISOString(),
            platformPostId: result.postId || null,
            degraded: !!result.degraded,
          });
        } else {
          const dataForPost = await withArticleLink(platformData, kit);
          result = await dispatch(postRef.platform, dataForPost, account);

          // Update kit with posted info
          kit.platforms[postRef.platform] = {
            ...platformData,
            postedAt: new Date().toISOString(),
            platformPostId: result.postId || null,
          };
          kit.updatedAt = new Date().toISOString();
          await kv.set(`social:kit:${kit.id}`, kit);
        }

        // Update postRef status
        await kv.set(`social:postref:${postRefId}`, { ...postRef, status: 'posted', postedAt: new Date().toISOString() });
        await kv.lpush('social:posted:index', postRefId);
        // Capped for the same reason the carousel indexes are: the posted feed
        // reads a bounded page, so an unbounded list only costs storage.
        await kv.ltrim('social:posted:index', 0, 499);

        results.push({ postRefId, status: 'posted', platform: postRef.platform, ...(isCarousel ? { kind: 'carousel' } : {}) });
      } catch (err) {
        console.error(`[cron] failed to post ${postRefId}:`, err.message);

        const attempts = (postRef.attempts || 0) + 1;
        if (attempts >= MAX_RETRIES) {
          // Give up after MAX_RETRIES — mark failed, leave OUT of the queue.
          await kv.set(`social:postref:${postRefId}`, { ...postRef, status: 'failed', attempts, lastError: err.message });
          // Mirror the terminal failure onto the carousel record too, otherwise it
          // would sit at 'scheduled' forever with nothing left in the queue to
          // move it — invisible in the UI as a stuck post.
          if (isCarousel && carousel) {
            await saveCarousel({ ...carousel, status: STATUS.failed, error: err.message });
          }
          results.push({ postRefId, status: 'failed', attempts, error: err.message });
        } else {
          // Re-enqueue with 30-minute retry
          const retryMs = nowMs + 30 * 60 * 1000;
          await kv.zadd('social:queue', { score: retryMs, member: postRefId });
          await kv.set(`social:postref:${postRefId}`, { ...postRef, status: 'retry', attempts, lastError: err.message });
          results.push({ postRefId, status: 'retry', attempts, error: err.message });
        }
      }
    }

    // Only terminal failures count against the run. A post sitting on 'retry' has
    // not failed yet — it has attempts left, and flagging it now would put the
    // monitor amber for something that will very likely succeed in 30 minutes.
    const posted = results.filter(r => r.status === 'posted').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const retry  = results.filter(r => r.status === 'retry').length;

    await heartbeat('cg-social-cron', {
      status: (failed === 0 && !promoResults.failed) ? 'ok' : posted === 0 ? 'fail' : 'warn',
      message: `${posted} posted, ${failed} gave up, ${retry} retrying`
        + (promoResults.total ? `, ${promoResults.minted}/${promoResults.total} promo occurrence(s)` : ''),
    });

    return res.status(200).json({ processed: results.length, results, promos: promoResults });
  } catch (err) {
    console.error('[cron] fatal error:', err);
    await heartbeat('cg-social-cron', { status: 'fail', message: err.message });
    return res.status(500).json({ error: err.message });
  }
}

/**
 * Mint an occurrence for every promotional campaign whose slot has arrived.
 *
 * Sequential, not parallel: each occurrence renders 6-10 slides (a ~5.8 MB RGBA
 * buffer each) and uploads them one by one, and running several campaigns at once
 * would spike memory for no wall-clock gain inside a single invocation.
 *
 * Never throws. The post queue below it is the more important half of this cron —
 * a broken campaign brief must not stop already-scheduled decks from going out.
 */
async function sweepPromoCampaigns() {
  const out = { total: 0, minted: 0, failed: 0, skipped: 0, results: [] };
  try {
    const promos = await listPromos({ limit: 200 });
    const due = promos.filter((p) => isDue(p));
    out.total = due.length;
    if (!due.length) return out;

    // Oldest-due first, so a campaign that has been waiting longest is not
    // starved by a newer one every hour when more are due than the cap allows.
    due.sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)));

    for (const promo of due.slice(0, MAX_PROMOS_PER_SWEEP)) {
      const result = await runPromoOccurrence(promo);
      if (result.ok) {
        out.minted++;
        out.results.push({ promoId: promo.id, name: promo.name, carouselId: result.carousel.id, schedule: result.schedule?.action });
      } else {
        out.failed++;
        out.results.push({ promoId: promo.id, name: promo.name, error: result.error });
      }
    }

    out.skipped = Math.max(0, due.length - MAX_PROMOS_PER_SWEEP);
    if (out.skipped) {
      // Never silently truncate: a deferred campaign looks identical to a
      // forgotten one unless the run says so.
      console.log(`[cron] ${out.skipped} due promo campaign(s) deferred to the next sweep (cap ${MAX_PROMOS_PER_SWEEP})`);
    }
  } catch (err) {
    console.error('[cron] promo sweep failed:', err.message);
    out.failed++;
  }
  return out;
}

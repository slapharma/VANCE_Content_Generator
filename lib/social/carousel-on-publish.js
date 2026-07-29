// lib/social/carousel-on-publish.js
//
// Build and action an article's Instagram carousel at the one moment that is
// safe to do it: immediately after the article has gone live on WordPress.
//
// Why here, and not in the automation run (where this used to live):
//
//   1. The deck is a snapshot. The cover uses the hero image and the slides use
//      the title/body as they stood when the spec was generated. Building before
//      review meant every hero swap or copy edit made during review silently
//      desynced the carousel from the article it advertises. After publish, what
//      is on WordPress is final by definition.
//   2. The CTA slide and the caption both say "read the full article". The link
//      is resolved from `content.wpPostUrl`, which only exists once WP has the
//      post. Building and posting before that produced captions with no link at
//      all (articleLinkFor returns null and buildCarouselCaption drops the line).
//   3. api/publish is the single choke point every publish path goes through —
//      the automation run's auto-publish, approve-on-review, the scheduled
//      /api/cron/publish sweep, and the manual "Publish Now" button. Hooking it
//      once gives all four identical behaviour, where the old placement covered
//      only the two automation paths.
//
// Config still comes from the rule (`generation.articleCarousel` and friends), so
// "a carousel for every article, as per the rule" holds; an article with no
// automation rule behind it is left alone.
//
// This module never throws. A social asset must not be able to turn a successful
// publish into an error.

import { kv } from '../kv.js';
import { writeLog } from '../automation/log.js';
import { getCarousel, getCarouselForArticle, STATUS } from './carousel-store.js';
import { applyPostMode } from './carousel-post.js';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

/** A spec call plus 6-10 renders plus 6-10 WP uploads. Measured at 60-100s. */
const BUILD_TIMEOUT_MS = 150_000;

/** One retry only. The observed failures (an OpenRouter 5xx, a WP media upload
 *  refusing a single slide) are transient, and a second full build is already
 *  most of the function's budget. */
const BUILD_ATTEMPTS = 2;

/**
 * POST to our own /api/social/* surface, bounded by a timeout.
 *
 * The heavy render path (satori + resvg + the embedded fonts) has to stay inside
 * api/social/[...slug].js — importing it here would drag it into api/publish's
 * bundle and its cold start. Actioning, by contrast, is a plain KV/HTTP affair,
 * so applyPostMode is called in-process below.
 */
async function socialPost(path, body, fetchFn) {
  const req = fetchFn(`${APP_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const res = await Promise.race([
    req,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(`timed out after ${BUILD_TIMEOUT_MS / 1000}s`)),
      BUILD_TIMEOUT_MS,
    )),
  ]);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return res.json().catch(() => ({}));
}

async function withRetry(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= BUILD_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < BUILD_ATTEMPTS) {
        console.warn(`[carousel-on-publish] ${label} attempt ${attempt} failed: ${err.message} — retrying`);
      }
    }
  }
  throw lastErr;
}

/**
 * Read the carousel settings that apply to an article.
 *
 * `automationRuleId` is stamped on the content record at generation time; a
 * hand-written article has none and therefore no carousel policy.
 *
 * @returns {Promise<{rule: object|null, gen: object|null, reason: string|null}>}
 */
async function resolveCarouselConfig(article) {
  const ruleId = article.automationRuleId || null;
  if (!ruleId) return { rule: null, gen: null, reason: 'article has no automation rule' };

  const rule = await kv.get(`automation:rule:${ruleId}`);
  if (!rule) return { rule: null, gen: null, reason: `rule ${ruleId} no longer exists` };
  if (!rule.generation?.articleCarousel) {
    return { rule, gen: null, reason: `rule "${rule.name}" has articleCarousel off` };
  }
  return { rule, gen: rule.generation, reason: null };
}

/**
 * Generate (if needed) and action the Instagram carousel for a just-published
 * article.
 *
 * Idempotent by design: /api/publish can legitimately be called twice for the
 * same article (a retried cron sweep, an operator re-publishing), and the social
 * cron can re-enter. Every path below either reuses the existing deck or does
 * nothing.
 *
 * @param {object} article - the content record AFTER the publish write-back, so
 *   `wpPostUrl` and `status: 'published'` are already on it
 * @param {object} [opts]
 * @param {Function} [opts.fetchFn] - injectable for tests
 * @returns {Promise<{action: string, reason?: string, carouselId?: string, error?: string}>}
 */
export async function carouselOnPublish(article, { fetchFn = fetch } = {}) {
  if (!article?.id) return { action: 'skipped', reason: 'no article' };

  try {
    const { rule, gen, reason } = await resolveCarouselConfig(article);
    if (!gen) return { action: 'skipped', reason };

    const log = (level, message, meta = null) => writeLog({
      ruleId: rule?.id ?? null,
      ruleName: rule?.name ?? null,
      level, message, contentId: article.id, meta,
    });

    const existing = await getCarouselForArticle(article.id);

    // ── An earlier deck is already in play ────────────────────────────────
    if (existing) {
      // Terminal or in-flight: nothing useful to do. `posted`/`scheduled` are
      // already actioned, `rejected` was turned down by a human, and `rendering`
      // means another invocation is mid-build right now.
      if ([STATUS.posted, STATUS.scheduled, STATUS.rejected, STATUS.rendering].includes(existing.status)) {
        return { action: 'skipped', reason: `existing deck is ${existing.status}`, carouselId: existing.id };
      }

      // Built and hosted but never actioned — the normal case for a deck that
      // was created before this article's publish (including every deck built by
      // the old pre-publish flow). Action it now that the article is live.
      if (existing.status === STATUS.ready) {
        if (existing.approved) {
          return { action: 'skipped', reason: 'existing deck already approved', carouselId: existing.id };
        }
        const outcome = await applyPostMode(existing);
        await log(
          outcome.action === 'failed' ? 'error' : 'success',
          `Instagram carousel ${outcome.action}`
            + (outcome.scheduledAt ? ` for ${outcome.scheduledAt}` : '')
            + (outcome.error ? ` — ${outcome.error}` : ''),
          { carouselId: existing.id },
        );
        return { ...outcome, carouselId: existing.id, reused: true };
      }

      // `failed` or `draft`: the copy exists, the render or the WP upload is what
      // broke. Re-render rather than rebuilding from scratch — it is the cheaper
      // half, and it preserves the record along with any operator edits to it.
      try {
        await withRetry('re-render', () => socialPost(`/api/social/carousels/${existing.id}/render`, {}, fetchFn));
        const rerendered = await getCarousel(existing.id);
        const outcome = rerendered ? await applyPostMode(rerendered) : { action: 'failed', error: 'deck vanished after render' };
        await log(
          outcome.action === 'failed' ? 'error' : 'success',
          `Instagram carousel re-rendered after a failed build, then ${outcome.action}`
            + (outcome.scheduledAt ? ` for ${outcome.scheduledAt}` : '')
            + (outcome.error ? ` — ${outcome.error}` : ''),
          { carouselId: existing.id },
        );
        return { ...outcome, carouselId: existing.id, rerendered: true };
      } catch (err) {
        await log('error', `Instagram carousel re-render failed for "${article.title}": ${err.message}`, { carouselId: existing.id });
        return { action: 'failed', error: err.message, carouselId: existing.id };
      }
    }

    // ── No deck yet: build one ────────────────────────────────────────────
    // `applySchedule: true` unconditionally — reaching this function at all means
    // the article is live, which is precisely the anchor every non-'approval'
    // post mode is measured from.
    try {
      const created = await withRetry('build', () => socialPost('/api/social/carousel', {
        contentId: article.id,
        slideCount: gen.carouselSlideCount ?? 8,
        ruleId: rule?.id ?? null,
        postMode: gen.carouselPostMode ?? 'approval',
        delayHours: gen.carouselDelayHours ?? 24,
        style: gen.carouselStyle ?? 'education',
        accountId: gen.carouselAccountId ?? null,
        createdBy: 'publish',
        applySchedule: true,
      }, fetchFn));

      const outcome = created.schedule ?? { action: 'built' };
      await log(
        outcome.action === 'failed' ? 'error' : 'success',
        `Built Instagram carousel for: ${article.title} — ${outcome.action}`
          + (outcome.scheduledAt ? ` for ${outcome.scheduledAt}` : '')
          + (outcome.error ? ` — ${outcome.error}` : ''),
        { carouselId: created.id ?? null },
      );
      return { ...outcome, carouselId: created.id ?? null, built: true };
    } catch (err) {
      // Left for an operator to retry from Social ▸ Carousels. Publishing the
      // article was the important half and it already succeeded.
      await log('error', `Carousel failed for "${article.title}": ${err.message}`);
      return { action: 'failed', error: err.message };
    }
  } catch (err) {
    console.error('[carousel-on-publish] unexpected failure:', err.message);
    return { action: 'failed', error: err.message };
  }
}

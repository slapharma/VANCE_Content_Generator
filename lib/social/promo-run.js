// lib/social/promo-run.js
//
// Mint one occurrence of a promotional campaign: decide the copy, build the deck,
// render and host the slides, then hand it to the ordinary posting path.
//
// Shared by the "Run now" button and the hourly cron sweep so a manually-fired
// occurrence and a scheduled one are the same thing — the only difference is what
// woke it up.
//
// Where an article deck waits for its article to reach WordPress before its post
// mode is applied, a promo deck has no such gate: nothing about it depends on a
// URL existing. The moment the slides are hosted it is as live as it will ever
// be, so applyPostMode runs immediately.

import { buildPromoCarousel, saveCarousel, getCarousel, STATUS } from './carousel-store.js';
import { renderAndHost, hostExternalSlides } from './handlers/carousel.js';
import { buildPromoSpec, repeatPromoSpec } from './promo-spec.js';
import { applyPostMode } from './carousel-post.js';
import { recordOccurrence, recordFailure } from './promo-store.js';
import { resolveTemplateForDeck } from './design-templates.js';
import {
  exportDesignPages, autofillBrandTemplate, buildAutofillData, MAX_CANVA_PAGES,
} from './canva.js';

/**
 * Work out what this occurrence should say.
 *
 * `repeat` is resolved by reading the previous deck rather than by regenerating,
 * and falls back to a fresh build the first time a campaign runs — a campaign set
 * to "repeat" with nothing to repeat yet has to produce something.
 */
async function resolveCopy(promo) {
  if (promo.messagingMode === 'repeat') {
    const lastId = promo.occurrences?.[0]?.carouselId;
    const previous = lastId ? await getCarousel(lastId) : null;
    if (previous?.spec) return { generated: repeatPromoSpec(promo, previous), variation: { mode: 'repeat' } };
    // First run of a repeat campaign: there is nothing to clone, so build once
    // from the brief. Every later occurrence will then clone this one.
    return { generated: await buildPromoSpec({ promo }), variation: { mode: 'first' } };
  }

  if (promo.messagingMode === 'csv') {
    const rows = promo.csvRows || [];
    if (!rows.length) throw new Error('This campaign is set to use a CSV but has no rows loaded');
    // Cursor is advanced by recordOccurrence, only after a deck actually exists —
    // so a failed build retries the same message instead of skipping it.
    const row = rows[Math.min(promo.csvCursor || 0, rows.length - 1)];
    const variation = { mode: 'csv', message: row.message, cta: row.cta };
    return { generated: await buildPromoSpec({ promo, variation }), variation };
  }

  const variation = { mode: 'topic', topic: promo.topic };
  return { generated: await buildPromoSpec({ promo, variation }), variation };
}

/**
 * Produce the slide images for a Canva-backed occurrence.
 *
 * 'canva-design' exports an existing design's pages verbatim — the words are
 * whatever is in Canva, so the model's spec is only used for the caption.
 * 'canva-template' autofills a brand template with the generated copy first.
 *
 * Canva's download URLs expire, so the caller immediately re-hosts them on WP.
 *
 * @returns {Promise<string[]>} public image URLs, in page order
 */
async function canvaSlideUrls(promo, spec) {
  let designId = promo.canvaDesignId;

  if (promo.renderer === 'canva-template') {
    if (!promo.canvaBrandTemplateId) throw new Error('This campaign has no Canva brand template selected');
    const data = buildAutofillData(spec, promo.canvaFields || []);
    if (!Object.keys(data).length) {
      throw new Error('None of the brand template\'s field names matched the generated copy. Rename the template fields (for example hookTitle, brief, point1, point1body, cta) and try again.');
    }
    designId = await autofillBrandTemplate(promo.canvaBrandTemplateId, data, promo.name);
  }

  if (!designId) throw new Error('This campaign has no Canva design selected');

  const urls = await exportDesignPages(designId);
  if (urls.length > MAX_CANVA_PAGES) {
    // Truncated rather than failed, but never silently — Instagram caps a
    // carousel at 10 and an operator should know their 14-page deck was cut.
    console.warn(`[promo-run] Canva design ${designId} has ${urls.length} pages; using the first ${MAX_CANVA_PAGES}`);
    return urls.slice(0, MAX_CANVA_PAGES);
  }
  return urls;
}

/**
 * Run one occurrence end to end.
 *
 * Never throws: a campaign that fails one week must keep its schedule and try
 * again the next, and the cron sweep processes many campaigns in one invocation —
 * one bad brief must not abort the rest. The failure is stamped on the campaign
 * as `lastError` and surfaced on its card.
 *
 * @param {object} promo
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] - build and render but do not save, index, host
 *   or post. Powers the builder's live preview.
 * @returns {Promise<{ok: boolean, carousel?: object, schedule?: object, error?: string}>}
 */
export async function runPromoOccurrence(promo, { dryRun = false } = {}) {
  const occurrence = (promo.occurrenceCount || 0) + 1;

  try {
    const { generated } = await resolveCopy(promo);
    // Resolved per occurrence, then frozen onto the record: a template edit
    // reaches campaigns from their next occurrence, but never rewrites a deck
    // that has already been rendered and hosted.
    const { style, themeOverride } = await resolveTemplateForDeck(promo.templateId);
    const record = buildPromoCarousel({ promo, generated, occurrence, style, themeOverride });

    const usesCanva = promo.renderer === 'canva-design' || promo.renderer === 'canva-template';

    if (dryRun) {
      // Nothing is written to KV and nothing is uploaded to WP, so a preview
      // cannot leave orphaned media behind however many times it is pressed.
      if (usesCanva) {
        // Canva's own export URLs are returned directly. They are temporary, but
        // a preview is temporary too, and re-hosting them on WP would be exactly
        // the persistent side effect a preview must not have.
        const urls = await canvaSlideUrls(promo, record.spec);
        return {
          ok: true,
          preview: {
            spec: record.spec,
            caption: record.caption,
            hashtags: record.hashtags,
            slideCount: urls.length,
            renderer: promo.renderer,
            slides: urls.map((url, i) => ({ index: i + 1, type: 'canva', dataUri: url })),
          },
        };
      }
      const { renderCarouselSlides } = await import('./carousel-render.js');
      const slides = await renderCarouselSlides(record);
      return {
        ok: true,
        preview: {
          spec: record.spec,
          caption: record.caption,
          hashtags: record.hashtags,
          slideCount: record.slideCount,
          renderer: 'vance',
          slides: slides.map((s) => ({
            index: s.index,
            type: s.type,
            dataUri: `data:image/jpeg;base64,${s.buffer.toString('base64')}`,
          })),
        },
      };
    }

    const saved = await saveCarousel(record, { indexIt: true });
    // Canva decks skip the satori renderer entirely: their pages are already
    // finished artwork, and they only need re-hosting on WP because Canva's
    // download links expire and Instagram fetches `image_url` itself.
    const hosted = usesCanva
      ? await hostExternalSlides(saved, await canvaSlideUrls(promo, saved.spec))
      : await renderAndHost(saved);

    // A promo deck has no article to wait for, so its post mode applies now.
    // applyPostMode never throws; a posting problem lands on the deck, not here.
    const schedule = hosted.status === STATUS.ready
      ? await applyPostMode(hosted)
      : { action: 'skipped', error: hosted.error || `deck is ${hosted.status}` };

    await recordOccurrence(promo, hosted.id);
    return { ok: true, carousel: hosted, schedule };
  } catch (err) {
    console.error(`[promo-run] ${promo.id} occurrence ${occurrence} failed:`, err.message);
    if (!dryRun) await recordFailure(promo, err.message).catch(() => {});
    return { ok: false, error: err.message };
  }
}

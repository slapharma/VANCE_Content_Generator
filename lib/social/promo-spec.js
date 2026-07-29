// lib/social/promo-spec.js
//
// Copy generation for Promotional Carousels.
//
// The article path (carousel-spec.js) summarises a document that already exists.
// A promo has no document: the source material is a campaign brief the operator
// wrote, optionally varied per occurrence by a CSV row or a topic. So this is a
// separate builder rather than a fourth style inside buildCarouselSpec — but it
// deliberately returns the **identical** envelope
// (`{ spec, caption, hashtags, slideCount }`) so everything downstream — the
// renderer, the store, the editor, the poster — treats a promo deck as an
// ordinary deck.
//
// The spec fields it fills are the ones planSlides(spec, 'promotional') asks for:
// eyebrow, hookTitle, brief.body, points[], update.body, cta. Those are the same
// fields breaking-news uses, which is why promotional borrows its two layouts
// (see STYLES.promotional in carousel-theme.js).

import { callOpenRouter } from './llm.js';
import { BRAND, PILLAR_INSTRUCTIONS } from './ava-prompts.js';
import { clampWords, extractJson } from './carousel-spec.js';
import { normaliseHashtags } from './carousel-text.js';
import { PROMO_FIXED_SLIDES } from './promo-schema.js';

const MIN_POINTS = 2;
const MAX_POINTS = 6;
const HUB_DOMAIN = process.env.BRAND_HUB_DOMAIN || 'vancehealthhub.co.uk';

/**
 * House rules every promo prompt carries.
 *
 * The em-dash ban is a standing instruction across this project, enforced in two
 * places on purpose: asked for here, and stripped unconditionally downstream by
 * stripDashes() in carousel-text.js. Models ignore the instruction often enough
 * that the prompt alone is not a control.
 */
const HOUSE_RULES = `
WRITING RULES (all mandatory):
- Never use em dashes or en dashes. Use commas, full stops or brackets.
- No emoji anywhere.
- Plain British English. Short sentences.
- Never make a medical claim, never promise a clinical outcome, and never imply
  the product treats, cures or prevents any condition. This is a food business.
- Never address the reader's own medical care or tell them to change treatment.
- Write for ${BRAND.name} (${BRAND.niche}). Social handle ${BRAND.handle}.`;

/**
 * The JSON shape asked of the model, matched to the slides this deck will
 * actually have.
 *
 * A short deck drops slides (see planSlides), and asking for copy that will never
 * be rendered is not merely wasteful — it invites the model to spend its best
 * material on a slide nobody will see. So the shape is built from the same
 * thresholds planSlides uses.
 */
function jsonShape({ pointCount, hasBrief, hasClose }) {
  const parts = [
    `  "eyebrow": "2-4 word label for the top of the cover, e.g. 'New Range' or 'Now Available'"`,
    `  "hookTitle": "The cover headline. MAXIMUM 10 WORDS. Make someone stop scrolling. State the substance, do not tease vaguely."`,
  ];

  if (hasBrief) {
    parts.push(`  "brief": {
    "body": "What this actually is, in 1-2 plain sentences. MAXIMUM 35 WORDS. The reader should finish this slide knowing what is being offered."
  }`);
  }

  if (pointCount > 0) {
    parts.push(`  "points": [
    ${Array.from({ length: pointCount }, () => `{
      "headline": "One benefit or feature. MAXIMUM 8 WORDS.",
      "body": "Make it concrete and specific. MAXIMUM 30 WORDS."
    }`).join(',\n    ')}
  ]`);
  }

  if (hasClose) {
    parts.push(`  "update": {
    "body": "The closing push: what to do next and why now. MAXIMUM 30 WORDS. Confident, specific, no hard sell, no medical claim."
  }`);
  }

  parts.push(`  "caption": "Instagram caption. 2-4 short paragraphs separated by blank lines. Open with the single most compelling thing, then what it is, then the call to action. MAXIMUM 180 WORDS. No hashtags here."`);
  parts.push(`  "hashtags": ["5-8 relevant tags, no # prefix, e.g. ${BRAND.hashtagExamples.replace(/#/g, '')}"]`);

  return `{\n${parts.join(',\n')}\n}`;
}

/**
 * Assemble the prompt for one occurrence.
 *
 * `variation` is what makes occurrence N differ from occurrence N-1:
 *   - csv   → a specific message + call to action from the operator's script
 *   - topic → an angle the model writes to, using the Ava 'sell' pillar
 *   - repeat→ never reaches here (the caller clones the previous spec instead)
 */
function buildPromoPrompt({ promo, variation, pointCount, hasBrief, hasClose, total }) {
  const lines = [
    total === 1
      ? 'You are writing a single-image Instagram post that PROMOTES a product or offer. Everything has to land in one image, so the headline carries the whole idea.'
      : `You are writing a ${total}-slide Instagram carousel that PROMOTES a product or offer.`,
    '',
    PILLAR_INSTRUCTIONS.sell,
    HOUSE_RULES,
    '',
    'CAMPAIGN BRIEF (this is the operator\'s own description, follow it closely):',
    promo.prompt || '(no brief given)',
  ];

  if (variation?.mode === 'csv' && variation.message) {
    lines.push(
      '',
      'THIS OCCURRENCE must be built around the following specific message.',
      'Do not drift off it, and do not merge it with other ideas:',
      `MESSAGE: ${variation.message}`,
      variation.cta ? `CALL TO ACTION: ${variation.cta}` : '',
    );
  } else if (variation?.mode === 'topic' && variation.topic) {
    lines.push(
      '',
      `THIS OCCURRENCE should take the following angle on the campaign: ${variation.topic}`,
      'Find a fresh way in. Do not simply restate the brief.',
    );
  }

  lines.push(
    '',
    pointCount > 0
      ? `Return ONLY valid JSON, no prose before or after, exactly ${pointCount} entries in "points":`
      : 'Return ONLY valid JSON, no prose before or after:',
    jsonShape({ pointCount, hasBrief, hasClose }),
  );

  return lines.filter((l) => l !== '').join('\n');
}

/**
 * Generate the copy for one promotional deck.
 *
 * @param {object} args
 * @param {object} args.promo    - the campaign record
 * @param {object} [args.variation] - `{ mode, message, cta, topic }`
 * @param {number} [args.slideCount] - overrides the campaign's own
 * @returns {Promise<{spec: object, caption: string, hashtags: string[], slideCount: number}>}
 */
export async function buildPromoSpec({ promo, variation = null, slideCount = null }) {
  if (!promo?.prompt && !variation?.message && !variation?.topic) {
    throw new Error('A promotional carousel needs a campaign brief, a CSV message or a topic');
  }

  const total = Math.min(10, Math.max(1, slideCount || promo.slideCount || 8));
  // Mirrors planSlides exactly: below 5 slides there is no room for points, and
  // the brief and close drop out at 3 and 4. Deriving both from the same
  // thresholds is what stops the prompt asking for copy the deck cannot show.
  const pointCount = total >= 5
    ? Math.min(MAX_POINTS, total - PROMO_FIXED_SLIDES)
    : 0;
  const hasBrief = total >= 3;
  const hasClose = total >= 4;

  const raw = await callOpenRouter(
    buildPromoPrompt({ promo, variation, pointCount, hasBrief, hasClose, total }),
    { source: 'social-promo' },
  );
  const parsed = extractJson(raw);

  // Word caps are enforced here, not merely requested in the prompt — a model
  // that overruns silently produces a slide with text running off the bottom,
  // and the render has no way to detect it.
  // Truncated to exactly what was asked for. Models routinely return more points
  // than the prompt requested — observed returning 4 when 1 was asked for — and
  // taking them all would silently turn an operator's 5-slide choice into an
  // 8-slide deck. The requested count wins; it is the setting they chose.
  const points = (Array.isArray(parsed.points) ? parsed.points : [])
    .map((p) => ({
      headline: clampWords(p?.headline, 8),
      body: clampWords(p?.body, 30),
    }))
    .filter((p) => p.headline || p.body)
    .slice(0, pointCount > 0 ? pointCount : 0);

  // Only enforced when points were actually asked for. A 1-4 slide deck has none
  // by design, and failing it for that would make short decks impossible.
  if (pointCount > 0 && points.length < Math.min(MIN_POINTS, pointCount)) {
    throw new Error(`Promo copy came back with only ${points.length} point slide(s), needed ${pointCount}`);
  }

  const spec = {
    eyebrow: clampWords(parsed.eyebrow, 4) || 'Vance',
    hookTitle: clampWords(parsed.hookTitle, 10) || promo.name,
    brief: { body: clampWords(parsed.brief?.body, 35) },
    points,
    update: { body: clampWords(parsed.update?.body, 30) },
    // The CTA is campaign config, never model output: an offer's wording and
    // destination are a commercial decision, not a creative one. Blank strings
    // fall through to STYLES.promotional's defaults at render time.
    cta: {
      domain: promo.ctaDomain || HUB_DOMAIN,
      label: promo.ctaLabel || '',
      note: promo.ctaNote || '',
    },
  };

  return {
    spec,
    caption: clampWords(parsed.caption, 180),
    // Campaign-level tags win when set: an operator who has curated them should
    // not have the model overwrite that on every occurrence.
    hashtags: promo.hashtags?.length ? normaliseHashtags(promo.hashtags) : normaliseHashtags(parsed.hashtags),
    // For a full-length deck the real count follows what the model produced, so a
    // model that returns 5 points instead of 4 still yields a consistent record.
    // For a short deck the requested total IS the shape, since planSlides derives
    // it from the count rather than from the points.
    slideCount: pointCount > 0 ? points.length + PROMO_FIXED_SLIDES : total,
  };
}

/**
 * Clone a previous occurrence's copy for a `repeat` campaign.
 *
 * Deliberately not an LLM call. "Repeat" means repeat: an operator who picked
 * this mode wants the same deck again, and regenerating "the same thing" through
 * a model would produce quiet drift they never asked for. The CTA is re-read
 * from the campaign so a changed offer link still propagates.
 */
export function repeatPromoSpec(promo, previous) {
  if (!previous?.spec) throw new Error('No previous occurrence to repeat — run this campaign once first');
  return {
    spec: {
      ...previous.spec,
      cta: {
        domain: promo.ctaDomain || previous.spec.cta?.domain || HUB_DOMAIN,
        label: promo.ctaLabel || previous.spec.cta?.label || '',
        note: promo.ctaNote || previous.spec.cta?.note || '',
      },
    },
    caption: previous.caption || '',
    hashtags: promo.hashtags?.length ? normaliseHashtags(promo.hashtags) : (previous.hashtags || []),
    slideCount: previous.slideCount || promo.slideCount || 8,
  };
}

/**
 * Suggest hashtags for a campaign, independent of building a deck.
 *
 * Powers the "Generate" button next to the hashtag field, so an operator can
 * curate tags once at campaign level and have every occurrence inherit them
 * (see the hashtags branch in buildPromoSpec).
 *
 * Never throws: an empty list simply leaves the field as the operator left it.
 *
 * @returns {Promise<string[]>}
 */
export async function suggestHashtags({ prompt = '', topic = '', name = '' } = {}) {
  const brief = [name, topic, prompt].filter(Boolean).join('\n').slice(0, 2000);
  if (!brief.trim()) return [];

  try {
    const raw = await callOpenRouter(
      `Suggest Instagram hashtags for this ${BRAND.name} campaign (${BRAND.niche}).\n\n`
      + `CAMPAIGN:\n${brief}\n\n`
      + 'Rules: 6-8 tags. No # prefix. No spaces or punctuation inside a tag. '
      + 'Mix broad reach tags with specific niche ones. No medical claims. '
      + `House examples for tone: ${BRAND.hashtagExamples}\n\n`
      + 'Return ONLY a JSON object, no prose:\n{ "hashtags": ["Tag1", "Tag2"] }',
      { source: 'social-promo-hashtags' },
    );
    return normaliseHashtags(extractJson(raw).hashtags);
  } catch (err) {
    console.error('[promo-spec] hashtag suggestion failed:', err.message);
    return [];
  }
}

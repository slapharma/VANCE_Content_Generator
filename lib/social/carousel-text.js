// lib/social/carousel-text.js
//
// Text sanitising shared by the carousel spec generator and the renderer.
//
// It runs in BOTH places on purpose. Sanitising only at generation time leaves
// three ways for banned characters to reach a slide: a carousel generated before
// the rule existed and later re-rendered, copy a user typed into the editor and
// PATCHed, and a spec loaded straight from disk by scripts/carousel-preview.mjs.
// Applying it again in the renderer is what makes the rule absolute rather than
// merely likely.

/**
 * Strip inline markdown that models emit even when asked for plain JSON.
 *
 * Found in production: a point body came back as "normally *reduces* inflammation".
 * satori has no markdown support, so the asterisks render literally on the slide.
 */
export function stripInlineMarkdown(s) {
  return String(s ?? '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:!?)]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1');
}

/**
 * Remove em and en dashes.
 *
 * House style forbids them. The generation prompt says so too, but models reach for
 * em dashes constantly and the instruction alone is not reliable, so this is the
 * guarantee rather than the hope.
 *
 * Spacing is the only available signal about which job the dash was doing, so it
 * decides the replacement: a spaced dash was a parenthetical break and becomes a
 * comma, an unspaced one was joining two tokens and becomes a hyphen.
 */
export function stripDashes(s) {
  return String(s ?? '')
    .replace(/\s+[—–]\s+/g, ', ')
    .replace(/([A-Za-z0-9])[—–]([A-Za-z0-9])/g, '$1-$2')
    .replace(/[—–]/g, '')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ');
}

/** Everything a string must pass through before it can appear on a slide. */
export function sanitiseSlideText(s) {
  return stripDashes(stripInlineMarkdown(s));
}

/**
 * Normalise hashtags to a deduped, #-prefixed, capped list.
 *
 * Lives here rather than in carousel-spec.js because the promotional spec builder
 * needs the identical rules and importing carousel-spec (and with it the whole
 * OpenRouter chain) just for a string helper would be the wrong dependency. An
 * article caption and a promo caption must produce identically-shaped tags.
 *
 * Accepts an array, or a raw string of comma/space-separated tags — the promo UI
 * lets an operator type them freehand.
 *
 * Instagram counts hashtags against the 30-tag limit and readability collapses
 * long before that, hence the cap of 8.
 */
export function normaliseHashtags(list) {
  const source = Array.isArray(list) ? list : String(list ?? '').split(/[\s,]+/);
  const seen = new Set();
  const out = [];
  for (const raw of source) {
    const tag = String(raw || '').trim().replace(/^#+/, '').replace(/[^A-Za-z0-9_]/g, '');
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`#${tag}`);
    if (out.length >= 8) break;
  }
  return out;
}

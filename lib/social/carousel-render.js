// lib/social/carousel-render.js
//
// Renders an Article Carousel spec into Instagram-ready JPEG buffers.
//
// Pipeline: spec → satori element trees → SVG → resvg (RGBA) → jpeg-js (JPEG).
//
// Three things about that chain are worth knowing before editing:
//
//   1. satori outlines every glyph to <path>, so the rasteriser never needs font
//      access. The two base64 faces in ./fonts/montserrat.js are the whole font
//      story — there is nothing to configure on resvg.
//   2. JPEG is not optional. Instagram's Graph API requires `image_url` to be a
//      JPEG; resvg only emits PNG, hence the jpeg-js step on the raw pixels.
//   3. satori implements a *subset* of CSS: flexbox only (no grid), and every
//      element with more than one child needs an explicit `display: 'flex'`.
//      Element trees are plain `{ type, props }` objects, so this file needs no
//      JSX and no build step — which is why satori was picked over alternatives.
//
// The hero photo is fetched here and inlined as a data URI rather than passed to
// satori as a remote URL: satori's own fetching has no timeout control, and a
// slow stock-photo CDN would otherwise hang the whole render.

import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import jpeg from 'jpeg-js';
import { SATORI_FONTS } from './fonts/montserrat.js';
import { logoFor, LOGO_ASPECT } from './assets/logo.js';
import { sanitiseSlideText } from './carousel-text.js';
// Single source of truth for the handle, shared with every platform prompt — a
// hardcoded default here previously let the slides drift from BRAND.handle.
import { BRAND } from './ava-prompts.js';
import {
  SLIDE_W, SLIDE_H, C, MUTED, TYPE, PAD, SCRIM, FIXED_COPY, LOGO_H,
  categoryLabelFor, themeFor, resolveTheme, BREAKING_BG, PROMO_STYLE,
} from './carousel-theme.js';

const JPEG_QUALITY = 88;
const HERO_FETCH_TIMEOUT_MS = 15_000;

// ── element helpers ────────────────────────────────────────────────────────
// `h` keeps the trees readable; satori accepts these objects directly.
const h = (type, style, children) => ({ type, props: { style, children } });

/**
 * A text node, sanitised on the way in.
 *
 * Sanitising here as well as in the spec generator is deliberate: this is the last
 * point every string passes through before it becomes pixels, so it is the only
 * place that also covers copy which never went through generation — a deck built
 * before the house style existed and later re-rendered, text a user typed into the
 * slide editor, or a spec loaded from disk by the preview script.
 */
const text = (content, style) => h('div', style, sanitiseSlideText(content));

/**
 * The frame every slide shares: a padded column whose content block absorbs all
 * spare vertical space, with the footer (and any bottom-pinned extras) sitting
 * below it at natural height.
 *
 * This shape matters. The obvious alternative — `justifyContent: 'center'` on the
 * outer column plus a `flexGrow` spacer before the footer — fights itself: the
 * spacer wins and every slide ends up top-heavy with a dead bottom third. Letting
 * the *content block* grow and align internally is what keeps copy optically
 * centred while the footer stays welded to the bottom edge.
 *
 * @param {object}   opts
 * @param {'center'|'flex-end'} opts.align - vertical alignment of the content block
 * @param {boolean}  opts.centerText       - centre content horizontally (CTA slide)
 * @param {Array}    [opts.header]         - pinned to the top (category tag + logo)
 * @param {Array}    opts.content          - the slide's copy
 * @param {Array}    [opts.bottom]         - pinned above the footer (e.g. disclaimer)
 * @param {Array}    opts.footer
 */
const slideFrame = ({ align = 'center', centerText = false, header = null, content, bottom = [], footer: foot }) =>
  h('div', {
    display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
    padding: PAD,
  }, [
    header,
    h('div', {
      display: 'flex', flexDirection: 'column', flexGrow: 1,
      justifyContent: align,
      ...(centerText ? { alignItems: 'center', textAlign: 'center' } : {}),
    }, content.filter(Boolean)),
    ...bottom.filter(Boolean),
    foot,
  ].filter(Boolean));

/**
 * Top band: the category this article came from on the left, the Vance mark on
 * the right.
 *
 * The category tag appears on every slide so a reader who lands mid-swipe — or
 * sees a single slide reshared — still knows which strand of the Health Hub it
 * belongs to. Education omits the logo from its cover on purpose: that slide
 * already carries the topic eyebrow and the headline, and a mark there
 * competes with the headline instead of supporting it. Relatable's cover
 * layout is different enough (see relatableCoverSlide) that it places the
 * logo in its own bottom card instead of this header band.
 *
 * The tag sits in a filled navy block with white type on every slide: 12.72:1, and
 * fixed regardless of what is behind it. As plain coloured text on the two photo
 * slides its contrast depended on where the scrim happened to land. Square corners,
 * per the global `--radius: 0` house rule.
 *
 * The logo sits directly on the slide with no block of its own, which is why
 * ./assets/logo.js ships a keyed-out transparent pair rather than the supplied
 * JPEG: `onInk` selects the variant that stays legible on this ground.
 */
function headerBand({ categoryLabel, onInk, withLogo }) {
  return h('div', {
    display: 'flex', flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', width: '100%', marginBottom: 44,
  }, [
    h('div', {
      display: 'flex', alignItems: 'center', background: C.ink,
      paddingTop: 10, paddingBottom: 10, paddingLeft: 18, paddingRight: 18,
    }, [
      text(String(categoryLabel || '').toUpperCase(), { ...TYPE.tag, color: C.white }),
    ]),
    withLogo
      ? (() => {
          const img = h('img', {
            width: Math.round(LOGO_H * LOGO_ASPECT), height: LOGO_H, objectFit: 'contain',
          }, undefined);
          img.props.src = logoFor(onInk);
          return img;
        })()
      : h('div', { display: 'flex' }, undefined),
  ]);
}

// ── hero image ─────────────────────────────────────────────────────────────

/**
 * Fetch the hero photo and return a data URI, or null on any failure.
 *
 * Non-fatal by design: a carousel with a flat-colour cover is far better than no
 * carousel, so callers fall back to an ink ground rather than aborting.
 *
 * @param {string|null} url
 * @returns {Promise<string|null>} `data:image/...;base64,...`
 */
export async function fetchHeroDataUri(url) {
  if (!url) return null;
  // Already inlined (the generator UI stores uploads as data URIs).
  if (url.startsWith('data:')) return url;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HERO_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        // Mirrors the UA api/publish uses for hero fetches — some stock CDNs
        // reject requests without one.
        'User-Agent': 'Mozilla/5.0 (compatible; VanceBot/1.0; +https://vancehealthhub.co.uk)',
        Accept: 'image/*',
      },
    });
    if (!res.ok) {
      console.warn(`[carousel-render] hero fetch failed ${res.status}: ${url}`);
      return null;
    }
    const type = res.headers.get('content-type') || 'image/jpeg';
    if (!type.startsWith('image/')) {
      console.warn(`[carousel-render] hero is not an image (${type}): ${url}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch (err) {
    console.warn(`[carousel-render] hero fetch error: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Full-bleed hero photo behind a gradient scrim.
 *
 * Scrim strength is not a matter of taste here — it is the only thing standing
 * between white text and whatever happens to be bright in a stock photo. A
 * mid-strength scrim tested badly: on the cover, the headline crossed a brightly
 * lit surgical glove and lost most of its contrast. So the stops below keep the
 * *text band* effectively opaque and spend the remaining transparency at the top
 * of the frame, where nothing is written.
 *
 * `stops` is a list of `[position%, opacity]` running bottom → top, so each slide
 * type can shape its own falloff. When no photo is available the whole thing
 * collapses to a flat ink ground, which is why callers can treat hero as
 * optional and never branch on it.
 *
 * `tintRgb` is the scrim colour as an `"r,g,b"` triple, navy by default.
 * Relatable's CTA slide passes the Vance teal triple instead (see ctaSlide) —
 * the only other colour this file ever tints a photo scrim with.
 */
function photoGround(heroDataUri, stops, tintRgb = '27,51,85') {
  const scrim = `linear-gradient(to top, ${stops
    .map(([pos, op]) => `rgba(${tintRgb},${op}) ${pos}%`)
    .join(', ')})`;
  const layers = [];
  if (heroDataUri) {
    layers.push(h('img', {
      position: 'absolute', top: 0, left: 0, width: SLIDE_W, height: SLIDE_H,
      objectFit: 'cover',
    }, undefined));
    // `img` carries src as a prop, not a style — patch it in.
    layers[0].props.src = heroDataUri;
  }
  layers.push(h('div', {
    position: 'absolute', top: 0, left: 0, width: SLIDE_W, height: SLIDE_H,
    background: heroDataUri ? scrim : C.ink,
  }, undefined));
  return layers;
}

// ── shared furniture ───────────────────────────────────────────────────────

/**
 * Persistent footer: brand handle left, slide counter right.
 *
 * The counter is what tells a reader how much is left to swipe, so it appears on
 * every slide including the cover. `space-between` rather than padded spaces —
 * satori collapses consecutive whitespace, so alignment must come from flexbox.
 *
 * `colorOverride` exists for grounds neither MUTED value was measured
 * against — currently only Relatable's teal-backed reassure/cta slides, which
 * pass MUTED.onPrimary instead (see the module note by that constant in
 * carousel-theme.js for why onInk's alpha isn't safe there).
 */
function footer(handle, index, total, onInk, colorOverride) {
  const color = colorOverride || (onInk ? MUTED.onInk : MUTED.onPaper);
  return h('div', {
    display: 'flex', flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', width: '100%', marginTop: 48,
  }, [
    text(handle, { ...TYPE.footer, color }),
    text(`${index}/${total}`, { ...TYPE.footer, color, fontWeight: 700 }),
  ]);
}

/** Short accent rule used to separate the label from the content beneath it.
 *  `height` defaults to the original 6px; Relatable uses a thicker rule for a
 *  more energetic feel — purely decorative, no contrast implication. */
const rule = (color, width = 96, marginTop = 24, marginBottom = 36, height = 6) =>
  h('div', { width, height, background: color, marginTop, marginBottom }, undefined);

/** Uppercase label. Content is upper-cased here so the LLM's casing can't leak
 *  through — satori has no `text-transform`. */
const eyebrow = (label, color) =>
  text(String(label || '').toUpperCase(), { ...TYPE.eyebrow, color });

// ── slide layouts ──────────────────────────────────────────────────────────

/** The outer positioned box for the two photo slides. `tintRgb` forwards to
 *  photoGround — see there for why the CTA slide is the only caller that ever
 *  passes one. */
const photoSlide = (heroDataUri, stops, inner, tintRgb) =>
  h('div', {
    position: 'relative', display: 'flex', width: SLIDE_W, height: SLIDE_H,
    fontFamily: 'Montserrat', background: C.ink,
  }, [
    ...photoGround(heroDataUri, stops, tintRgb),
    // `position: relative` lifts the content above the absolutely-positioned
    // photo and scrim layers without needing a z-index.
    h('div', { position: 'relative', display: 'flex', width: '100%', height: '100%' }, [inner]),
  ]);

/**
 * The outer box for the flat-ground slides. `backdrop` is an optional array of
 * decorative layers (see relatableBackdrop) rendered behind the content —
 * used by Relatable's feeling/point/reassure slides, which otherwise have
 * nothing but a solid colour fill.
 */
const flatSlide = (background, inner, backdrop = null) =>
  h('div', {
    position: 'relative', display: 'flex', width: SLIDE_W, height: SLIDE_H,
    fontFamily: 'Montserrat', background,
  }, [
    ...(backdrop || []),
    h('div', { position: 'relative', display: 'flex', width: '100%', height: '100%' }, [inner]),
  ]);

/**
 * A subtle corner fragment of the hero photo, confined the same way the
 * rotated squares below are: low opacity, cornered, never spanning the text
 * column. Used on Relatable's white inner slides (feeling/point) so every
 * slide carries a trace of the article's own image, not just cover/cta.
 * ~14% of an arbitrary photo over a solid white/paper base shifts effective
 * luminance only slightly — nowhere near enough to threaten the ink-on-white
 * pairing those slides otherwise hold at 12.7:1.
 */
function heroImageAccent(heroDataUri) {
  if (!heroDataUri) return null;
  const img = h('img', {
    position: 'absolute', top: -70, right: -90, width: 440, height: 440,
    objectFit: 'cover', opacity: 0.14,
  }, undefined);
  img.props.src = heroDataUri;
  return img;
}

/**
 * Relatable style's decorative backdrop: a large, low-opacity rotated square
 * in brand colour, plus (when a hero photo is available) a subtle fragment of
 * it in the opposite corner. Squares rather than circles because the house
 * rule is square corners everywhere (RADIUS = 0, see carousel-theme.js) —
 * rotating a square keeps every corner a right angle, it just tilts the shape
 * in space.
 *
 * This is what gives the flat-ground Relatable slides (feeling/point/
 * reassure) a background where education has none, without spending any of
 * the file's verified text-contrast pairings: everything here sits BEHIND the
 * content, at low enough opacity that even where a layer crosses the text
 * column the effective ground luminance barely moves. A faint accent/primary
 * wash over paper or ink shifts contrast by hundredths, not whole points —
 * nowhere near enough to threaten the 8.35:1 (onPaper) / 7.38:1 (onInk)
 * floors this file holds everywhere else.
 *
 * @param {boolean} onInk
 * @param {string|null} [heroDataUri] - omit on slides that shouldn't carry the
 *   photo fragment (reassure keeps the closing beat photo-free, see its call site)
 */
function relatableBackdrop(onInk, heroDataUri = null) {
  const tint = onInk ? C.accent : C.primary;
  const soft = onInk ? 0.10 : 0.05;
  const layers = [];
  const photoAccent = heroImageAccent(heroDataUri);
  if (photoAccent) layers.push(photoAccent);
  layers.push(h('div', {
    position: 'absolute', bottom: -160, left: -120, width: 360, height: 360,
    background: tint, opacity: soft, transform: 'rotate(-12deg)',
  }, undefined));
  return layers;
}

function coverSlide(args) {
  if (args.style === 'relatable') return relatableCoverSlide(args);
  if (args.style === 'breaking-news') return breakingCoverSlide(args);
  return educationCoverSlide(args);
}

function educationCoverSlide({ spec, heroDataUri, handle, categoryLabel, index, total }) {
  return photoSlide(heroDataUri, SCRIM.cover, slideFrame({
    // The cover is the one bottom-anchored slide: the headline sits on the
    // heaviest part of the scrim and the photo breathes above it.
    align: 'flex-end',
    // Category tag only — no logo here (see headerBand).
    header: headerBand({ categoryLabel, onInk: true, withLogo: false }),
    content: [
      eyebrow(spec.eyebrow, C.accent),
      rule(C.accent, 96, 20, 28),
      text(spec.hookTitle, { ...TYPE.coverHead, color: C.white }),
      // Swipe affordance as an outlined block — square corners, house rule.
      h('div', {
        display: 'flex', flexDirection: 'row', alignItems: 'center',
        alignSelf: 'flex-start', marginTop: 44, paddingTop: 14, paddingBottom: 14,
        paddingLeft: 26, paddingRight: 26, border: `3px solid ${C.accent}`,
      }, [
        text(`${FIXED_COPY.swipe}  →`, { ...TYPE.footer, fontWeight: 700, color: C.accent, letterSpacing: 3 }),
      ]),
    ],
    footer: footer(handle, index, total, true),
  }));
}

/**
 * Relatable's cover: no dark filter over the photo at all — the image reads
 * completely clean, full brightness, no scrim. That only works because every
 * piece of text sits on its own solid white card instead of directly on the
 * photo: a top card carries the eyebrow + headline + swipe hint, a bottom card
 * carries the category tag + logo + footer, and the photo shows through
 * untouched in between. Every colour here is ink/primary-on-white — the
 * safest pairings in the file (12.72:1 / ~6.05:1, the latter for short accent
 * labels only, same carve-out Note 2 already grants chips and rules).
 */
function relatableCoverSlide({ spec, heroDataUri, handle, categoryLabel, index, total }) {
  let img = null;
  if (heroDataUri) {
    img = h('img', {
      position: 'absolute', top: 0, left: 0, width: SLIDE_W, height: SLIDE_H,
      objectFit: 'cover',
    }, undefined);
    img.props.src = heroDataUri;
  }

  const topCard = h('div', {
    position: 'relative', display: 'flex', flexDirection: 'column',
    background: C.white, width: '100%', padding: PAD, paddingBottom: 36,
  }, [
    eyebrow(spec.eyebrow, C.primary),
    rule(C.primary, 96, 18, 26, 10),
    text(spec.hookTitle, { ...TYPE.coverHead, color: C.ink }),
    text(`${FIXED_COPY.swipe}  →`, {
      ...TYPE.footer, fontWeight: 700, color: C.primary, letterSpacing: 3, marginTop: 28,
    }),
  ]);

  const bottomCard = h('div', {
    position: 'relative', display: 'flex', flexDirection: 'column',
    background: C.white, width: '100%', padding: PAD, paddingTop: 28,
  }, [
    headerBand({ categoryLabel, onInk: false, withLogo: true }),
    footer(handle, index, total, false),
  ]);

  return h('div', {
    position: 'relative', display: 'flex', flexDirection: 'column',
    width: SLIDE_W, height: SLIDE_H, fontFamily: 'Montserrat', background: C.ink,
  }, [
    img,
    h('div', {
      position: 'relative', display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
    }, [
      topCard,
      // No background here on purpose — this is the "clean image" gap between
      // the two cards, the photo showing through completely unfiltered.
      h('div', { display: 'flex', flexGrow: 1 }, undefined),
      bottomCard,
    ]),
  ].filter(Boolean));
}

/**
 * Breaking News's cover: the CNN-style "breaking news" DESIGN LANGUAGE — a
 * bold urgent strip announcing the format, a chyron-style headline band —
 * rendered in Vance's own navy/teal rather than a literal red trade-dress
 * copy (this is a health brand's carousel, not a broadcaster's actual
 * on-air graphic). A thin ink strip up top carries the "BREAKING NEWS" label,
 * a small square alert marker (square, not a dot — the house rule is no
 * border-radius anywhere in this renderer), and the Vance mark in its top
 * right corner; the photo shows clean in the middle, same as Relatable's
 * cover, because nothing sits on it directly; the headline lives in a bottom
 * band on BREAKING_BG (#aedbdb), ticker-style, with the category tag and
 * footer beneath it.
 *
 * The top strip stays on ink, so its text keeps the same white/accent-on-ink
 * pairings used throughout this file (12.72:1 / the established accent
 * carve-out). The bottom band does NOT — BREAKING_BG is light (see the note
 * on that constant in carousel-theme.js), so every colour there is ink
 * instead, matching breakingUpdateSlide's calibration for the same ground
 * (8.45:1 for the headline, MUTED.onBreakingBg's 8.26:1 for the footer).
 */
function breakingCoverSlide({ spec, heroDataUri, handle, categoryLabel, index, total }) {
  let img = null;
  if (heroDataUri) {
    img = h('img', {
      position: 'absolute', top: 0, left: 0, width: SLIDE_W, height: SLIDE_H,
      objectFit: 'cover',
    }, undefined);
    img.props.src = heroDataUri;
  }

  const logoImg = h('img', {
    width: Math.round(LOGO_H * LOGO_ASPECT), height: LOGO_H, objectFit: 'contain',
  }, undefined);
  logoImg.props.src = logoFor(true); // top strip stays ink, so the light-ground mark

  const topStrip = h('div', {
    position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', background: C.ink, width: '100%',
    paddingTop: 26, paddingBottom: 26, paddingLeft: PAD, paddingRight: PAD,
  }, [
    h('div', { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 16 }, [
      h('div', { width: 20, height: 20, background: C.accent }, undefined),
      // +4px over the shared eyebrow scale — an explicit override here, not a
      // change to TYPE.eyebrow, which every other style's eyebrow also uses.
      text('BREAKING NEWS', { ...TYPE.eyebrow, fontSize: TYPE.eyebrow.fontSize + 4, color: C.white, letterSpacing: 4 }),
    ]),
    logoImg,
  ]);

  const bottomBand = h('div', {
    position: 'relative', display: 'flex', flexDirection: 'column',
    background: BREAKING_BG, width: '100%', padding: PAD, paddingTop: 32,
  }, [
    // No logo here — it now lives in the top strip's corner.
    headerBand({ categoryLabel, onInk: false, withLogo: false }),
    eyebrow(spec.eyebrow, C.ink),
    rule(C.ink, 96, 16, 24, 10),
    text(spec.hookTitle, { ...TYPE.coverHead, color: C.ink }),
    text(`${FIXED_COPY.swipe}  →`, {
      ...TYPE.footer, fontWeight: 700, color: C.ink, letterSpacing: 3, marginTop: 26,
    }),
    footer(handle, index, total, false, MUTED.onBreakingBg),
  ]);

  return h('div', {
    position: 'relative', display: 'flex', flexDirection: 'column',
    width: SLIDE_W, height: SLIDE_H, fontFamily: 'Montserrat', background: C.ink,
  }, [
    img,
    h('div', {
      position: 'relative', display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
    }, [
      topStrip,
      // Clean photo gap, same reasoning as Relatable's cover — nothing sits
      // on it directly, so it doesn't need a scrim.
      h('div', { display: 'flex', flexGrow: 1 }, undefined),
      bottomBand,
    ]),
  ].filter(Boolean));
}

function contextSlide({ spec, handle, categoryLabel, index, total }) {
  return flatSlide(C.ink, slideFrame({
    header: headerBand({ categoryLabel, onInk: true, withLogo: true }),
    content: [
      eyebrow(spec.context?.label || FIXED_COPY.contextLabel, C.accent),
      rule(C.accent),
      text(spec.context?.body || '', { ...TYPE.contextBody, color: C.white }),
    ],
    footer: footer(handle, index, total, true),
  }));
}

/**
 * Per-style skin for the point slides. Every colour here is one already
 * measured elsewhere in this file or in carousel-theme.js — nothing new is
 * introduced for Breaking News: white-on-ink and ink-on-white are the file's
 * two strongest pairings (12.72:1 either direction), and accent-on-ink is the
 * same pairing contextSlide already uses.
 *
 *   education      — paper ground, ink chip, hairline rule (unchanged design)
 *   relatable      — white ground, primary chip, thick rule, brand backdrop
 *   breaking-news  — ink ground (the "navy background, white text" ask),
 *                     white chip (so it isn't a navy chip vanishing into a
 *                     navy slide), accent rule to match contextSlide's idiom
 *                     for ink grounds
 */
const POINT_STYLE = {
  education: {
    fill: C.paper, chipFill: C.ink, chipText: C.white, headline: C.ink,
    body: MUTED.onPaper, ruleColor: C.primary, ruleHeight: 6, ruleMarginBottom: 28,
    onInk: false, backdrop: false,
  },
  relatable: {
    fill: C.white, chipFill: C.primary, chipText: C.white, headline: C.ink,
    body: MUTED.onPaper, ruleColor: C.primary, ruleHeight: 10, ruleMarginBottom: 32,
    onInk: false, backdrop: true,
  },
  'breaking-news': {
    fill: C.ink, chipFill: C.white, chipText: C.ink, headline: C.white,
    body: MUTED.onInk, ruleColor: C.accent, ruleHeight: 10, ruleMarginBottom: 32,
    onInk: true, backdrop: false,
  },
};

function pointSlide({ point, number, handle, categoryLabel, index, total, style, heroDataUri }) {
  const cfg = POINT_STYLE[style] || POINT_STYLE.education;
  return flatSlide(cfg.fill, slideFrame({
    header: headerBand({ categoryLabel, onInk: cfg.onInk, withLogo: true }),
    content: [
      h('div', {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 104, height: 104, background: cfg.chipFill, marginBottom: 44,
      }, [
        text(String(number), { fontSize: 56, fontWeight: 700, color: cfg.chipText, lineHeight: 1 }),
      ]),
      text(point.headline, { ...TYPE.pointHead, color: cfg.headline }),
      rule(cfg.ruleColor, 72, 28, cfg.ruleMarginBottom, cfg.ruleHeight),
      text(point.body, { ...TYPE.body, color: cfg.body }),
    ],
    footer: footer(handle, index, total, cfg.onInk),
  }), cfg.backdrop ? relatableBackdrop(false, heroDataUri) : null);
}

/** Small filled chip for study type / sample size. */
const chip = (label) =>
  h('div', {
    display: 'flex', paddingTop: 12, paddingBottom: 12, paddingLeft: 22, paddingRight: 22,
    background: C.primary, marginRight: 16, marginTop: 16,
  }, [text(label, { ...TYPE.footer, fontWeight: 700, color: C.white })]);

function evidenceSlide({ spec, handle, categoryLabel, index, total }) {
  const e = spec.evidence || {};
  const chips = [e.studyType, e.sampleSize].filter(Boolean).map(chip);
  const byline = [e.authors, e.year].filter(Boolean).join(' · ');
  // Many articles name no journal, author or year. A citation-only slide then
  // renders as a lone chip in a large empty frame, which reads as broken. So the
  // takeaway always carries the slide, the citation decorates it when present,
  // and the label follows whichever of the two is actually leading.
  const hasCitation = Boolean(e.journal || byline || chips.length);
  const label = hasCitation ? FIXED_COPY.evidenceLabel : FIXED_COPY.takeawayLabel;
  return flatSlide(C.paper, slideFrame({
    header: headerBand({ categoryLabel, onInk: false, withLogo: true }),
    content: [
      eyebrow(label, C.primary),
      rule(C.primary),
      e.journal ? text(e.journal, { ...TYPE.journal, color: C.ink }) : null,
      byline ? text(byline, { ...TYPE.body, color: MUTED.onPaper, marginTop: 20 }) : null,
      chips.length
        ? h('div', { display: 'flex', flexDirection: 'row', flexWrap: 'wrap', marginTop: 20 }, chips)
        : null,
      spec.takeaway
        ? text(spec.takeaway, {
            ...(hasCitation ? TYPE.body : TYPE.contextBody),
            color: hasCitation ? MUTED.onPaper : C.ink,
            marginTop: hasCitation ? 30 : 0,
          })
        : null,
    ],
    // The disclaimer is fixed copy, never model-generated, and is pinned to the
    // bottom above a hairline so it reads as a standing notice rather than as
    // part of the citation it sits under.
    bottom: [
      h('div', { width: '100%', height: 2, background: 'rgba(26,35,50,0.18)', marginBottom: 24 }, undefined),
      text(FIXED_COPY.disclaimer, { ...TYPE.micro, color: MUTED.onPaper }),
    ],
    footer: footer(handle, index, total, false),
  }));
}

/**
 * Relatable style's post-cover slide — "if this sounds familiar". Structurally
 * the same slot contextSlide fills for education (name the situation, right
 * after the hook), but on whichever ground themeFor(style) assigns it, using
 * only the two colour pairings already verified in this file (white/accent on
 * ink, ink/primary on paper — see Notes 1 and 2 in carousel-theme.js). No new
 * pairing is introduced; only which of the two already-safe grounds opens the
 * deck varies by style.
 */
function feelingSlide({ spec, handle, categoryLabel, index, total, style, heroDataUri, theme: themeIn }) {
  const theme = themeIn || themeFor(style);
  const onInk = theme.feelingGround === 'ink';
  const accentColor = onInk ? C.accent : C.primary;
  const bodyText = spec.feeling?.body ?? spec.context?.body ?? '';
  // Pure white, not paper — brighter base, and ink-on-white is only ever
  // safer than the already-verified ink-on-paper pairing it replaces.
  return flatSlide(onInk ? C.ink : C.white, slideFrame({
    header: headerBand({ categoryLabel, onInk, withLogo: true }),
    content: [
      eyebrow(theme.feelingLabel, accentColor),
      rule(accentColor, 96, 20, 32, 10),
      // Full ink/white rather than the muted body tone: this is the slide's
      // sole content, the same "hero text" treatment evidenceSlide gives its
      // takeaway when there is no citation to share the frame with.
      text(bodyText, { ...TYPE.contextBody, color: onInk ? C.white : C.ink }),
    ],
    footer: footer(handle, index, total, onInk),
  }), relatableBackdrop(onInk, heroDataUri));
}

/**
 * Relatable style's pre-CTA slide — "you're not alone". Fills the slot
 * evidenceSlide holds for education, but relatable never carries a citation,
 * so this is always evidenceSlide's "no citation" branch: label, rule,
 * takeaway, disclaimer. Ground CHOICE follows themeFor(style) the same way
 * feelingSlide does, but for Relatable the dark option is filled with Vance
 * teal (#006868) instead of navy — the deck's closing colour, not its
 * opening one.
 *
 * That swap changes which colours are safe, not just the fill: accent
 * (#4DBDBD) on navy is an established pairing, but accent on teal measures
 * only 2.93:1 (both are teal-family — too little separation), so the eyebrow
 * and rule move to white instead. Same story for the disclaimer: MUTED.onInk
 * was tuned for navy (72%-alpha white, 7.38:1) and only reaches ~4.24:1 here,
 * so this uses MUTED.onPrimary instead (see the note by that constant in
 * carousel-theme.js for why 6.13:1, not 7+, is the honest ceiling on this
 * ground).
 */
function reassureSlide({ spec, handle, categoryLabel, index, total, style, theme: themeIn }) {
  const theme = themeIn || themeFor(style);
  const onInk = theme.closingGround === 'ink';
  const isRelatable = style === 'relatable';
  const fill = onInk ? (isRelatable ? C.primary : C.ink) : C.paper;
  const accentColor = onInk ? (isRelatable ? C.white : C.accent) : C.primary;
  const bodyMutedColor = onInk ? (isRelatable ? MUTED.onPrimary : MUTED.onInk) : MUTED.onPaper;
  const bodyText = spec.reassure?.body ?? spec.takeaway ?? '';
  return flatSlide(fill, slideFrame({
    header: headerBand({ categoryLabel, onInk, withLogo: true }),
    content: [
      eyebrow(theme.closingLabelPlain, accentColor),
      rule(accentColor, 96, 24, 36, 10),
      text(bodyText, { ...TYPE.contextBody, color: onInk ? C.white : C.ink }),
    ],
    // The disclaimer is fixed copy, never model-generated, on every style —
    // see the module note on FIXED_COPY.
    bottom: [
      h('div', { width: '100%', height: 2, background: onInk ? 'rgba(255,255,255,0.18)' : 'rgba(26,35,50,0.18)', marginBottom: 24 }, undefined),
      text(FIXED_COPY.disclaimer, { ...TYPE.micro, color: bodyMutedColor }),
    ],
    // No hero-image fragment on this one — the closing beat stays a clean
    // flat colour, not photo clutter (see relatableBackdrop's default).
    footer: footer(handle, index, total, onInk, onInk && isRelatable ? MUTED.onPrimary : undefined),
  }), relatableBackdrop(onInk));
}

/**
 * Breaking News's post-cover slide — the bulletin's opening line. Structurally
 * identical to contextSlide (the same slot education fills), and deliberately
 * so: "navy background, white text" was the ask for every inner slide, and
 * this is the same ink/accent/white pairing contextSlide already uses.
 */
function breakingBriefSlide({ spec, handle, categoryLabel, index, total, style, theme: briefThemeIn }) {
  // Label comes from the theme so promotional decks, which reuse this layout,
  // can say "WHAT YOU GET" instead of "WHAT WE KNOW". A design template's
  // resolved theme arrives via ctx; themeFor is the fallback for callers that
  // render a bare style (the preview script, older records).
  const theme = briefThemeIn || themeFor(style);
  return flatSlide(C.ink, slideFrame({
    header: headerBand({ categoryLabel, onInk: true, withLogo: true }),
    content: [
      eyebrow(theme.feelingLabel || 'WHAT WE KNOW', C.accent),
      rule(C.accent, 96, 24, 36, 10),
      text(spec.brief?.body || '', { ...TYPE.contextBody, color: C.white }),
    ],
    footer: footer(handle, index, total, true),
  }));
}

/**
 * Breaking News's pre-CTA slide — the closing update. This is the one slide
 * in the whole file that sits on BREAKING_BG (#aedbdb) rather than any of
 * `C`'s established grounds, so every colour here is picked against that
 * lighter tint specifically: ink text (8.45:1), and MUTED.onBreakingBg for
 * the disclaimer (see the note by that constant in carousel-theme.js). No
 * white anywhere on this slide — white-on-BREAKING_BG measures only 1.5:1.
 */
function breakingUpdateSlide({ spec, handle, categoryLabel, index, total, style, theme: themeIn }) {
  const bodyText = spec.update?.body ?? spec.takeaway ?? '';
  const theme = themeIn || themeFor(style);
  // Empty disclaimer omits the rule + line entirely rather than rendering an
  // orphaned divider. Promotional decks take that branch: a medical-education
  // disclaimer on an offer slide is wrong, not merely redundant.
  const disclaimer = theme.disclaimer ?? FIXED_COPY.disclaimer;
  return flatSlide(BREAKING_BG, slideFrame({
    header: headerBand({ categoryLabel, onInk: false, withLogo: true }),
    content: [
      eyebrow(theme.closingLabelPlain || 'THE UPDATE', C.ink),
      rule(C.ink, 96, 24, 36, 10),
      text(bodyText, { ...TYPE.contextBody, color: C.ink }),
    ],
    bottom: disclaimer ? [
      h('div', { width: '100%', height: 2, background: 'rgba(26,35,50,0.18)', marginBottom: 24 }, undefined),
      text(disclaimer, { ...TYPE.micro, color: MUTED.onBreakingBg }),
    ] : undefined,
    footer: footer(handle, index, total, false, MUTED.onBreakingBg),
  }));
}

/**
 * The CTA slide is shared by all three styles, but Relatable and Breaking
 * News each retint the scrim to match their own closing colour — see
 * reassureSlide/breakingUpdateSlide for the full rationale on each ground.
 * Colours safe against a navy scrim are not safe against a lighter one, so
 * several change per style:
 *
 *   relatable      — scrim retints to Vance teal (0,104,104). Accent-on-navy
 *                    (the domain line) measures only 2.93:1 on teal (too
 *                    little separation, both teal-family), so it becomes
 *                    white, matching white-on-primary's 6.60:1 ceiling (Note 2
 *                    in carousel-theme.js). "Link in bio" was MUTED.onInk
 *                    (7.38:1 on navy); on teal that alpha falls to ~4.24:1, so
 *                    this uses MUTED.onPrimary instead (~6.13:1).
 *   breaking-news  — scrim retints to BREAKING_BG (174,219,219), a LIGHT
 *                    tint, which flips which text colour works entirely:
 *                    white collapses to ~1.5:1 here, so domain/link/note all
 *                    move to ink or primary, matching breakingUpdateSlide's
 *                    ink-on-BREAKING_BG (8.45:1) and its MUTED.onBreakingBg
 *                    (8.26:1) for the muted line. The logo also switches to
 *                    its dark-ground... light-ground variant (onInk: false).
 *
 * The white button block and its ink text are untouched throughout: solid
 * white is unaffected by whatever is behind it.
 */
function ctaSlide({ spec, heroDataUri, handle, categoryLabel, index, total, style, theme: themeIn }) {
  const cta = spec.cta || {};
  const theme = themeIn || themeFor(style);
  const isRelatable = style === 'relatable';
  // Read from the theme rather than testing for the breaking-news style by name:
  // promotional closes on the same light tint and needs identical treatment, and
  // every future style that does will get it by declaring the flag rather than
  // by being added to a condition here.
  const isLightClose = !!theme.lightCloseGround;
  const tintRgb = isRelatable ? '0,104,104' : isLightClose ? '174,219,219' : undefined;
  const domainColor = isLightClose ? C.primary : isRelatable ? C.white : C.accent;
  const linkInBioColor = isLightClose ? MUTED.onBreakingBg : isRelatable ? MUTED.onPrimary : MUTED.onInk;
  const noteColor = isLightClose ? C.ink : C.white;
  const footerOverride = isLightClose ? MUTED.onBreakingBg : isRelatable ? MUTED.onPrimary : undefined;
  return photoSlide(heroDataUri, SCRIM.cta, slideFrame({
    centerText: true,
    header: headerBand({ categoryLabel, onInk: !isLightClose, withLogo: true }),
    content: [
      // A white block with ink text: 12.72:1, the strongest pairing available,
      // and the hardest-popping element possible against any scrim tint.
      h('div', {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: C.white, paddingTop: 30, paddingBottom: 30,
        paddingLeft: 52, paddingRight: 52,
      }, [
        // Per-deck override first, then the style's own default, then the global
        // fixed copy. A promo deck must not fall through to "READ THE FULL
        // ARTICLE" — there is no article behind it.
        text(`${cta.label || theme.ctaLabel || FIXED_COPY.ctaLabel}  →`, { ...TYPE.ctaLabel, color: C.ink }),
      ]),
      text(cta.domain || '', { ...TYPE.body, fontWeight: 700, color: domainColor, marginTop: 40 }),
      text('Link in bio', { ...TYPE.footer, color: linkInBioColor, marginTop: 12 }),
      text(cta.note || theme.ctaNote || FIXED_COPY.ctaNote, {
        ...TYPE.body, color: noteColor, marginTop: 48, maxWidth: 760,
      }),
    ],
    footer: footer(handle, index, total, !isLightClose, footerOverride),
  }), tintRgb);
}

// ── deck assembly ──────────────────────────────────────────────────────────

/**
 * Expand a spec into the ordered list of slide descriptors.
 *
 * Kept separate from rendering so the API layer and the UI can both reason about
 * "what slides will this produce" (count, types, per-slide copy) without paying
 * for a render.
 *
 * `style` swaps the post-cover and pre-CTA slide types: education keeps
 * context/evidence, relatable uses feeling/reassure, breaking-news uses
 * brief/update — none of the three carry a citation slide except education
 * (see feelingSlide/reassureSlide, breakingBriefSlide/breakingUpdateSlide,
 * and themeFor in carousel-theme.js). The point slides in between are the
 * same slide type either way — see POINT_STYLE for how they're skinned.
 *
 * @param {object} spec
 * @param {string} [style='education']
 * @returns {Array<{type: string, number?: number, point?: object}>}
 */
export function planSlides(spec, style = 'education', slideCount = null) {
  const points = Array.isArray(spec?.points) ? spec.points : [];
  // Promotional borrows breaking-news's two slides rather than adding a pair of
  // near-identical layouts: both are a label + a plain body, one on ink and one
  // on the light tint, with no citation block. What differs is the microcopy and
  // the disclaimer, and both of those now come from themeFor(style).
  const usesBrief = style === 'breaking-news' || style === PROMO_STYLE;
  const briefType = style === 'relatable' ? 'feeling' : usesBrief ? 'brief' : 'context';
  const closeType = style === 'relatable' ? 'reassure' : usesBrief ? 'update' : 'evidence';

  // Decks of 1-4 slides have no room for the full arc, so slides are dropped in
  // reverse order of how much they carry: the cover always survives, then the
  // CTA (a deck that cannot ask for anything is a wasted post), then the opening
  // brief, then the close. Points go first because they are the part a short
  // deck is short *of*.
  //
  // `slideCount` is passed by the renderer from the record. Omitted, it falls
  // back to the old points-derived shape, so every deck built before short decks
  // existed plans exactly as it always did.
  const total = Number(slideCount) || (points.length + 4);
  if (total <= 4) {
    const out = [{ type: 'cover' }];
    if (total >= 3) out.push({ type: briefType });
    if (total >= 4) out.push({ type: closeType });
    if (total >= 2) out.push({ type: 'cta' });
    return out;
  }

  // Capped as well as floored: when an explicit slideCount is supplied it is the
  // authority, so a spec carrying more points than the deck was sized for cannot
  // stretch it. Without this a model returning 4 points for a 5-slide deck would
  // produce 8 slides, and the operator's choice would be silently overridden.
  const maxPoints = Math.max(0, total - 4);
  const used = slideCount ? points.slice(0, maxPoints) : points;

  return [
    { type: 'cover' },
    { type: briefType },
    ...used.map((point, i) => ({ type: 'point', point, number: i + 1 })),
    { type: closeType },
    { type: 'cta' },
  ];
}

const LAYOUTS = {
  cover: coverSlide,
  context: contextSlide,
  feeling: feelingSlide,
  brief: breakingBriefSlide,
  point: pointSlide,
  evidence: evidenceSlide,
  reassure: reassureSlide,
  update: breakingUpdateSlide,
  cta: ctaSlide,
};

/**
 * Render one slide to a JPEG buffer.
 *
 * @returns {Promise<Buffer>}
 */
async function renderOne(descriptor, ctx) {
  const layout = LAYOUTS[descriptor.type];
  if (!layout) throw new Error(`Unknown carousel slide type "${descriptor.type}"`);

  const element = layout({ ...ctx, ...descriptor });
  const svg = await satori(element, { width: SLIDE_W, height: SLIDE_H, fonts: SATORI_FONTS });
  const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: SLIDE_W } }).render();
  const { data } = jpeg.encode(
    { data: Buffer.from(rendered.pixels), width: rendered.width, height: rendered.height },
    JPEG_QUALITY,
  );
  return data;
}

/**
 * Render a whole carousel.
 *
 * Slides are rendered sequentially, not in parallel: each render allocates a
 * 1080x1350 RGBA buffer (~5.8 MB) plus the hero copy, and eight of those at once
 * is a needless memory spike inside a serverless function. Sequential rendering
 * of eight slides costs well under a second in total.
 *
 * @param {object} carousel - a carousel record ({ spec, heroImageUrl, heroImageCredit, ... })
 * @param {object} [opts]
 * @param {string} [opts.handle] - brand handle for the footer; defaults to BRAND.handle
 * @returns {Promise<Array<{index: number, type: string, buffer: Buffer}>>}
 */
export async function renderCarouselSlides(carousel, { handle = BRAND.handle } = {}) {
  const spec = carousel?.spec;
  if (!spec) throw new Error('renderCarouselSlides: carousel.spec is required');

  // Stamped on the record at build time (see buildCarousel); falls back to
  // 'education' for decks created before content styles existed.
  const style = carousel.style || 'education';
  const plan = planSlides(spec, style, carousel.slideCount);
  const heroDataUri = await fetchHeroDataUri(carousel.heroImageUrl);

  // No visible photo-credit text is rendered on the slide itself (per an
  // explicit call to keep attribution out of the reader-facing image, mirroring
  // the same call already made for the WP article hero — see
  // docs/learnings-from-alpha.md 2026-07-21). Attribution is not lost: it is
  // still stamped onto the uploaded WP media item's metadata by
  // slideCredit()/uploadImageBufferToWp() in handlers/carousel.js, which reads
  // carousel.heroImageCredit directly rather than through this render path.

  // Prefer the label stamped on the record at build time; fall back to deriving it
  // from the category id, which is what carousels created before the category tag
  // existed will need on a re-render.
  const categoryLabel = carousel.categoryLabel || categoryLabelFor(carousel.category);

  // Resolved once per deck, not per slide: a design template's overrides
  // (lib/social/design-templates.js) are layered onto the base style's theme
  // here, and every slide reads the result off ctx. Decks with no override
  // resolve to exactly the base theme, so nothing changes for them.
  const theme = resolveTheme(style, carousel.themeOverride || null);

  const ctx = { spec, heroDataUri, handle, categoryLabel, total: plan.length, style, theme };

  const out = [];
  for (const [i, descriptor] of plan.entries()) {
    const buffer = await renderOne(descriptor, { ...ctx, index: i + 1 });
    out.push({ index: i + 1, type: descriptor.type, buffer });
  }
  return out;
}

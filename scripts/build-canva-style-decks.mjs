// scripts/build-canva-style-decks.mjs
//
// Emit one self-contained HTML deck per house style, for import into Canva as an
// EDITABLE design (Canva's URL import turns each `data-document-role="page"`
// element into a page, and its text into real, selectable text boxes).
//
// Why not export the app's own renderer? Because satori outlines every glyph to
// paths on its way to SVG, so anything that pipeline produces is flat artwork
// with no editable text — exactly what this is meant to avoid. So the decks are
// rebuilt here in HTML, mirroring lib/social/carousel-render.js layout for
// layout, and reading every colour, size and gutter from
// lib/social/carousel-theme.js rather than restating them.
//
// The three styles are NOT minor variations on one another. Each has its own
// cover composition and its own inner-slide skin, and a deck that flattens them
// into a single layout with different labels is not a copy of anything:
//
//   education      cover  scrimmed photo, bottom-anchored, outlined swipe box
//                  inner  paper ground, ink chip, thin primary rule
//                  close  evidence — citation block + takeaway on paper
//   relatable      cover  UNSCRIMMED photo between two solid white cards
//                  inner  white ground, primary chip, thick rule, tinted backdrop
//                  close  reassure — on Vance TEAL (#006868), white eyebrow
//   breaking-news  cover  ink top strip + clean photo + BREAKING_BG headline band
//                  inner  INK ground, white chip, white headline, accent rule
//                  close  update — on BREAKING_BG, ink throughout
//
// Each editable box carries the app's FIELD NAME as its placeholder text
// ("hookTitle", "point1body", …). That is what makes the binding legible when
// the deck is published as a brand template, and it is what buildAutofillData()
// in lib/social/canva.js matches on.
//
// Usage:  node scripts/build-canva-style-decks.mjs [outDir]
// Default outDir is ./canva-styles, which Vercel serves statically at
// /canva-styles/<style>.html. Those files exist only to be fetched once by
// Canva's importer and are deleted again afterwards.

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  SLIDE_W, SLIDE_H, C, MUTED, BREAKING_BG, TYPE, PAD, CONTENT_W, LOGO_H,
  FIXED_COPY, themeFor,
} from '../lib/social/carousel-theme.js';
import { LOGO_DARK, LOGO_LIGHT, LOGO_ASPECT } from '../lib/social/assets/logo.js';

/**
 * Where the importer will fetch the logo PNGs from.
 *
 * Canva's importer resolves `<img src>` over the network, so the mark cannot be
 * inlined as a data URI the way the satori renderer does it — it has to be a
 * real URL on the same public host the HTML itself is served from. Both files
 * are written next to the decks and deleted with them after the import.
 */
const ASSET_BASE = process.argv[3] || 'https://vance-content.vercel.app/canva-styles';

/** Rendered mark size. Width follows LOGO_ASPECT, exactly as the renderer does. */
const LOGO_W = Math.round(LOGO_H * LOGO_ASPECT);

const STYLE_IDS = ['education', 'relatable', 'breaking-news'];

const TITLE = {
  education:       'Vance Carousel - Education',
  relatable:       'Vance Carousel - Relatable',
  'breaking-news': 'Vance Carousel - Breaking News',
};

/** How many point slides an 8-slide deck carries — planSlides()'s `total - 4`. */
const POINTS = 4;
const TOTAL = POINTS + 4;
const TAG = 'HEALTH EDUCATION';

/**
 * Composite an `rgba(r,g,b,a)` colour onto an opaque hex ground, returning solid
 * hex.
 *
 * Canva's HTML importer drops the alpha channel on text colours and lands on
 * #000000, which put black body text on the navy ground on the first import.
 * Flattening here is not an approximation of MUTED: alpha compositing over a
 * KNOWN opaque ground is exactly the calculation the contrast ratios in
 * carousel-theme.js were measured against, so #BFC6CF on ink is the same pixel
 * the app renders and holds the same measured 7.38:1.
 */
function flatten(rgba, groundHex) {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(rgba);
  if (!m) return rgba;
  const [, r, g, b, a = '1'] = m;
  const alpha = Number(a);
  const bg = groundHex.replace('#', '');
  const channel = (fg, i) => {
    const back = parseInt(bg.slice(i * 2, i * 2 + 2), 16);
    return Math.round(alpha * Number(fg) + (1 - alpha) * back);
  };
  return `#${[channel(r, 0), channel(g, 1), channel(b, 2)]
    .map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** The four muted tones, flattened against the ground each was measured on. */
const MUTED_ON = {
  ink:      flatten(MUTED.onInk, C.ink),
  paper:    flatten(MUTED.onPaper, C.paper),
  white:    flatten(MUTED.onPaper, C.white),
  primary:  flatten(MUTED.onPrimary, C.primary),
  breaking: flatten(MUTED.onBreakingBg, BREAKING_BG),
};

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const css = (o) => Object.entries(o)
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${k}:${v}`).join(';');

function typeCss(t, extra = {}) {
  return css({
    'font-size': `${t.fontSize}px`,
    'font-weight': t.fontWeight,
    'line-height': t.lineHeight,
    'letter-spacing': t.letterSpacing ? `${t.letterSpacing}px` : undefined,
    ...extra,
  });
}

/**
 * Reserve vertical space for a box whose real content is longer than its
 * placeholder.
 *
 * Canva's import freezes flow layout into absolute positions, and a FIXED page
 * never reflows siblings afterwards — so a box sized to the word "hookTitle"
 * is rendered straight over whatever sits beneath it the moment a three-line
 * headline is autofilled. Every growable field therefore reserves the height
 * its longest realistic copy needs, up front.
 */
const reserve = (t, lines) => `${Math.ceil(t.fontSize * t.lineHeight * lines)}px`;

/** An editable, autofill-bound text box. `field` becomes its placeholder copy. */
const fieldBox = (field, t, color, extra = {}) =>
  `<p data-field="${esc(field)}" style="${typeCss(t, { color, ...extra })}">${esc(field)}</p>`;

/** Fixed furniture — a label, the disclaimer, a counter. Never autofilled. */
const staticBox = (txt, t, color, extra = {}) =>
  `<p style="${typeCss(t, { color, ...extra })}">${esc(txt)}</p>`;

/** Uppercase editorial label above the content. */
const eyebrow = (label, color) =>
  staticBox(String(label).toUpperCase(), TYPE.eyebrow, color);

/** Short accent rule separating the label from the content beneath it. */
const rule = (color, { width = 96, marginTop = 24, marginBottom = 36, height = 6 } = {}) =>
  `<div style="${css({
    width: `${width}px`, height: `${height}px`, background: color,
    'margin-top': `${marginTop}px`, 'margin-bottom': `${marginBottom}px`,
  })}"></div>`;

/**
 * The Vance mark, in the variant its ground needs.
 *
 * Two files because the source ink is teal, which is unreadable on the navy and
 * photo slides: DARK keeps the original teals for light grounds, LIGHT remaps
 * them to white and brand accent for dark ones. Same split as logoFor(onInk) in
 * the renderer, so the two never disagree about which mark belongs where.
 */
const logo = (onInk) =>
  `<img src="${ASSET_BASE}/logo-${onInk ? 'light' : 'dark'}.png" alt="Vance" style="${css({
    width: `${LOGO_W}px`, height: `${LOGO_H}px`, 'object-fit': 'contain',
  })}">`;

/** Category tag left, Vance mark right. */
const headerBand = (onInk, muted, withLogo = true) => `<div class="row">
      ${staticBox(TAG, TYPE.tag, muted)}
      ${withLogo ? logo(onInk) : ''}
    </div>`;

/** Brand handle left, slide counter right. */
const footer = (n, muted) => `<div class="row">
      ${staticBox('vancemedicalfoods.com', TYPE.footer, muted)}
      ${staticBox(`${n}/${TOTAL}`, { ...TYPE.footer, fontWeight: 700 }, muted)}
    </div>`;

/** A hairline above pinned bottom copy, matching the renderer's disclaimer rule. */
const hairline = (onDark) => `<div style="${css({
  width: '100%', height: '2px',
  background: onDark ? 'rgba(255,255,255,0.18)' : 'rgba(26,35,50,0.18)',
  'margin-bottom': '24px',
})}"></div>`;

/**
 * Relatable's decorative backdrop: a large, low-opacity rotated square in brand
 * colour behind the content. Squares rather than circles because the house rule
 * is square corners everywhere; rotating a square keeps every corner a right
 * angle. Sits BEHIND the text at an opacity too low to move effective ground
 * luminance, so it spends none of the file's verified contrast pairings.
 */
const backdrop = (onInk) => `<div style="${css({
  position: 'absolute', bottom: '-160px', left: '-120px',
  width: '360px', height: '360px',
  background: onInk ? C.accent : C.primary,
  opacity: onInk ? 0.10 : 0.05,
  transform: 'rotate(-12deg)',
})}"></div>`;

/**
 * One standard page: header top, content middle, footer bottom.
 *
 * `bottom` is copy pinned just above the footer (the disclaimer). `extra` holds
 * decorative layers rendered behind everything.
 */
function page(label, bg, { header, content, bottom = '', footer: foot, extra = '', align = 'center' }) {
  return `
  <div data-document-role="page" data-label="${esc(label)}" style="${css({ background: bg, position: 'relative' })}">
    ${extra}
    <div class="frame">
      <div>${header}</div>
      <div class="body" style="${css({ 'justify-content': align })}">${content}</div>
      <div>${bottom}${foot}</div>
    </div>
  </div>`;
}

// ── per-style slide builders ───────────────────────────────────────────────

/**
 * Education's cover: the headline sits on the heaviest part of the scrim and
 * the photo breathes above it, so the content is bottom-anchored. The swipe
 * affordance is an outlined block, square corners per the house rule.
 *
 * There is no photo here — drop one in behind and the colours already hold.
 * Ink is what photoGround falls back to when no hero is available, so this is
 * exactly what the app renders for a heroless education deck.
 */
const educationCover = () => page('1 Cover', C.ink, {
  align: 'flex-end',
  header: headerBand(true, MUTED_ON.ink, false),
  content: [
    fieldBox('eyebrow', TYPE.eyebrow, C.accent, { 'text-transform': 'uppercase' }),
    rule(C.accent, { marginTop: 20, marginBottom: 28 }),
    fieldBox('hookTitle', TYPE.coverHead, C.white, { 'min-height': reserve(TYPE.coverHead, 3) }),
    `<div style="${css({
      display: 'inline-flex', 'align-self': 'flex-start', 'align-items': 'center',
      'margin-top': '44px', padding: '14px 26px', border: `3px solid ${C.accent}`,
    })}">${staticBox(`${FIXED_COPY.swipe}  →`, { ...TYPE.footer, fontWeight: 700, letterSpacing: 3 }, C.accent)}</div>`,
  ].join('\n      '),
  footer: footer(1, MUTED_ON.ink),
});

/**
 * Relatable's cover: no scrim over the photo at all. That works only because
 * every piece of text sits on its own solid white card — a top card carries the
 * eyebrow, headline and swipe hint, a bottom card carries the tag, wordmark and
 * footer, and the photo shows through untouched in the gap between them.
 */
const relatableCover = () => `
  <div data-document-role="page" data-label="1 Cover" style="${css({ background: C.ink, position: 'relative', display: 'flex', 'flex-direction': 'column', padding: '0' })}">
    <div style="${css({ background: C.white, width: '100%', padding: `${PAD}px`, 'padding-bottom': '36px' })}">
      ${fieldBox('eyebrow', TYPE.eyebrow, C.primary, { 'text-transform': 'uppercase' })}
      ${rule(C.primary, { marginTop: 18, marginBottom: 26, height: 10 })}
      ${fieldBox('hookTitle', TYPE.coverHead, C.ink, { 'min-height': reserve(TYPE.coverHead, 3) })}
      ${staticBox(`${FIXED_COPY.swipe}  →`, { ...TYPE.footer, fontWeight: 700, letterSpacing: 3 }, C.primary, { 'margin-top': '28px' })}
    </div>
    <div style="${css({ flex: '1 1 auto' })}"></div>
    <div style="${css({ background: C.white, width: '100%', padding: `${PAD}px`, 'padding-top': '28px' })}">
      ${headerBand(false, MUTED_ON.white)}
      ${footer(1, MUTED_ON.white)}
    </div>
  </div>`;

/**
 * Breaking News's cover: the broadcast design language rendered in Vance's own
 * navy and teal rather than a literal red trade-dress copy. A thin ink strip up
 * top carries the format label, a square alert marker and the wordmark; the
 * photo shows clean in the middle; the headline lives in a bottom band on
 * BREAKING_BG, ticker-style.
 *
 * The top strip stays on ink so its text keeps the white/accent-on-ink pairings.
 * The bottom band does not — BREAKING_BG is light, so every colour there is ink.
 * Never put white on that band: it measures 1.5:1.
 */
const breakingCover = () => `
  <div data-document-role="page" data-label="1 Cover" style="${css({ background: C.ink, position: 'relative', display: 'flex', 'flex-direction': 'column', padding: '0' })}">
    <div style="${css({ background: C.ink, width: '100%', display: 'flex', 'flex-direction': 'row', 'align-items': 'center', 'justify-content': 'space-between', padding: `26px ${PAD}px` })}">
      <div style="${css({ display: 'flex', 'flex-direction': 'row', 'align-items': 'center', gap: '16px' })}">
        <div style="${css({ width: '20px', height: '20px', background: C.accent })}"></div>
        ${staticBox('BREAKING NEWS', { ...TYPE.eyebrow, fontSize: TYPE.eyebrow.fontSize + 4, letterSpacing: 4 }, C.white)}
      </div>
      ${logo(true)}
    </div>
    <div style="${css({ flex: '1 1 auto' })}"></div>
    <div style="${css({ background: BREAKING_BG, width: '100%', padding: `${PAD}px`, 'padding-top': '32px' })}">
      ${headerBand(false, MUTED_ON.breaking, false)}
      ${fieldBox('eyebrow', TYPE.eyebrow, C.ink, { 'text-transform': 'uppercase' })}
      ${rule(C.ink, { marginTop: 16, marginBottom: 24, height: 10 })}
      ${fieldBox('hookTitle', TYPE.coverHead, C.ink, { 'min-height': reserve(TYPE.coverHead, 3) })}
      ${staticBox(`${FIXED_COPY.swipe}  →`, { ...TYPE.footer, fontWeight: 700, letterSpacing: 3 }, C.ink, { 'margin-top': '26px' })}
      ${footer(1, MUTED_ON.breaking)}
    </div>
  </div>`;

/** Slide 2. Same slot in every style, but its ground, rule weight and backdrop
 *  are the style's own — see contextSlide / feelingSlide / breakingBriefSlide. */
function briefPage(styleId, theme) {
  const relatable = styleId === 'relatable';
  const bg = relatable ? C.white : C.ink;
  const accent = relatable ? C.primary : C.accent;
  const body = relatable ? C.ink : C.white;
  const muted = relatable ? MUTED_ON.white : MUTED_ON.ink;
  const label = relatable ? '2 Feeling' : styleId === 'breaking-news' ? '2 Brief' : '2 Context';
  return page(label, bg, {
    header: headerBand(!relatable, muted),
    content: [
      eyebrow(theme.feelingLabel, accent),
      rule(accent, relatable ? { marginTop: 20, marginBottom: 32, height: 10 } : { height: styleId === 'breaking-news' ? 10 : 6, marginBottom: 36 }),
      fieldBox('brief', TYPE.contextBody, body, { 'min-height': reserve(TYPE.contextBody, 4) }),
    ].join('\n      '),
    footer: footer(2, muted),
    extra: relatable ? backdrop(false) : '',
  });
}

/**
 * Per-style skin for the point slides, lifted from POINT_STYLE in
 * carousel-render.js. Nothing here is invented: white-on-ink and ink-on-white
 * are the file's two strongest pairings, and accent-on-ink is the pairing the
 * context slide already uses.
 */
const POINT_STYLE = {
  education: {
    fill: C.paper, chipFill: C.ink, chipText: C.white, headline: C.ink,
    body: MUTED_ON.paper, muted: MUTED_ON.paper, ruleColor: C.primary,
    ruleHeight: 6, ruleMarginBottom: 28, backdrop: false, onInk: false,
  },
  relatable: {
    fill: C.white, chipFill: C.primary, chipText: C.white, headline: C.ink,
    body: MUTED_ON.white, muted: MUTED_ON.white, ruleColor: C.primary,
    ruleHeight: 10, ruleMarginBottom: 32, backdrop: true, onInk: false,
  },
  'breaking-news': {
    fill: C.ink, chipFill: C.white, chipText: C.ink, headline: C.white,
    body: MUTED_ON.ink, muted: MUTED_ON.ink, ruleColor: C.accent,
    ruleHeight: 10, ruleMarginBottom: 32, backdrop: false, onInk: true,
  },
};

function pointPage(styleId, i) {
  const cfg = POINT_STYLE[styleId];
  const n = i + 2;
  return page(`${n} Point ${i}`, cfg.fill, {
    header: headerBand(cfg.onInk, cfg.muted),
    content: [
      `<div style="${css({
        display: 'flex', 'align-items': 'center', 'justify-content': 'center',
        width: '104px', height: '104px', background: cfg.chipFill, 'margin-bottom': '44px',
      })}">${staticBox(String(i), { fontSize: 56, fontWeight: 700, lineHeight: 1 }, cfg.chipText)}</div>`,
      fieldBox(`point${i}`, TYPE.pointHead, cfg.headline, { 'min-height': reserve(TYPE.pointHead, 2) }),
      rule(cfg.ruleColor, { width: 72, marginTop: 28, marginBottom: cfg.ruleMarginBottom, height: cfg.ruleHeight }),
      fieldBox(`point${i}body`, TYPE.body, cfg.body, { 'min-height': reserve(TYPE.body, 3) }),
    ].join('\n      '),
    footer: footer(n, cfg.muted),
    extra: cfg.backdrop ? backdrop(false) : '',
  });
}

/**
 * Slide 7, the closing beat, and the one that differs most between styles.
 *
 *   education      evidence  — citation block + takeaway on paper
 *   relatable      reassure  — on Vance TEAL, not navy. Accent on teal measures
 *                              only 2.93:1 (both teal-family), so the eyebrow
 *                              and rule move to white, and the disclaimer uses
 *                              MUTED.onPrimary rather than onInk.
 *   breaking-news  update    — on BREAKING_BG, ink throughout, never white.
 */
function closePage(styleId, theme) {
  const n = TOTAL - 1;
  if (styleId === 'relatable') {
    return page(`${n} Close`, C.primary, {
      header: headerBand(true, MUTED_ON.primary),
      content: [
        eyebrow(theme.closingLabelPlain, C.white),
        rule(C.white, { marginTop: 24, marginBottom: 36, height: 10 }),
        fieldBox('update', TYPE.contextBody, C.white, { 'min-height': reserve(TYPE.contextBody, 4) }),
      ].join('\n      '),
      bottom: hairline(true) + staticBox(theme.disclaimer, TYPE.micro, MUTED_ON.primary),
      footer: footer(n, MUTED_ON.primary),
      extra: backdrop(true),
    });
  }
  if (styleId === 'breaking-news') {
    return page(`${n} Close`, BREAKING_BG, {
      header: headerBand(false, MUTED_ON.breaking),
      content: [
        eyebrow(theme.closingLabelPlain, C.ink),
        rule(C.ink, { marginTop: 24, marginBottom: 36, height: 10 }),
        fieldBox('update', TYPE.contextBody, C.ink, { 'min-height': reserve(TYPE.contextBody, 4) }),
      ].join('\n      '),
      bottom: hairline(false) + staticBox(theme.disclaimer, TYPE.micro, MUTED_ON.breaking),
      footer: footer(n, MUTED_ON.breaking),
    });
  }
  // Education's evidence slide. The citation decorates the takeaway rather than
  // carrying the slide: many articles name no journal, and a lone chip in a
  // large empty frame reads as broken. Journal/authors/chips are left as static
  // furniture because no autofill field maps to them.
  return page(`${n} Close`, C.paper, {
    header: headerBand(false, MUTED_ON.paper),
    content: [
      eyebrow(theme.closingLabelWithCitation || theme.closingLabelPlain, C.primary),
      rule(C.primary),
      staticBox('Journal name', TYPE.journal, C.ink),
      staticBox('Authors · Year', TYPE.body, MUTED_ON.paper, { 'margin-top': '20px' }),
      `<div style="${css({ display: 'flex', 'flex-direction': 'row', 'flex-wrap': 'wrap', 'margin-top': '20px' })}">
        ${['Study type', 'Sample size'].map((l) => `<div style="${css({
          display: 'inline-flex', padding: '12px 22px', background: C.primary,
          'margin-right': '16px', 'margin-top': '16px',
        })}">${staticBox(l, { ...TYPE.footer, fontWeight: 700 }, C.white)}</div>`).join('')}
      </div>`,
      fieldBox('update', TYPE.body, MUTED_ON.paper, { 'margin-top': '30px', 'min-height': reserve(TYPE.body, 3) }),
    ].join('\n      '),
    bottom: hairline(false) + staticBox(theme.disclaimer, TYPE.micro, MUTED_ON.paper),
    footer: footer(n, MUTED_ON.paper),
  });
}

/**
 * The CTA. One layout across all three styles, but each retints the ground to
 * its own closing colour, and colours safe against navy are not safe against a
 * lighter one — so the domain, the link line and the note all move per style.
 * The white button block and its ink text are untouched throughout: solid white
 * is unaffected by whatever sits behind it.
 *
 * In the app this ground is a photo behind a near-opaque scrim. Here it is the
 * scrim's own tint, flat, so the template shows the intended per-style colour
 * and a designer can drop a photo in behind it without any text colour moving.
 */
function ctaPage(styleId, theme) {
  const light = !!theme.lightCloseGround;
  const relatable = styleId === 'relatable';
  const bg = light ? BREAKING_BG : relatable ? C.primary : C.ink;
  const domain = light ? C.primary : relatable ? C.white : C.accent;
  const link = light ? MUTED_ON.breaking : relatable ? MUTED_ON.primary : MUTED_ON.ink;
  const note = light ? C.ink : C.white;
  const muted = light ? MUTED_ON.breaking : relatable ? MUTED_ON.primary : MUTED_ON.ink;
  const disclaimer = theme.disclaimer;

  return page(`${TOTAL} CTA`, bg, {
    header: headerBand(!light, muted),
    content: [
      // The chip must RESERVE the width its longest realistic label needs, not
      // shrink-wrap the placeholder: fixed pages never reflow, so a chip sized
      // to the 3-letter placeholder "cta" is overrun by the first real autofill
      // ("SHOP THE RANGE" spilled outside the white box). 800px of centred text
      // holds "READ THE FULL ARTICLE" at TYPE.ctaLabel with headroom.
      `<div style="${css({
        display: 'flex', 'align-self': 'center', 'align-items': 'center',
        'justify-content': 'center', background: C.white, padding: '30px 0', width: '860px',
      })}">${fieldBox('cta', TYPE.ctaLabel, C.ink, { 'text-transform': 'uppercase', 'text-align': 'center', width: '800px' })}</div>`,
      fieldBox('domain', { ...TYPE.body, fontWeight: 700 }, domain, { 'margin-top': '40px', 'text-align': 'center' }),
      staticBox('Link in bio', TYPE.footer, link, { 'margin-top': '12px', 'text-align': 'center' }),
      staticBox(FIXED_COPY.ctaNote, TYPE.body, note, { 'margin-top': '48px', 'max-width': '760px', 'text-align': 'center' }),
    ].join('\n      '),
    bottom: disclaimer ? hairline(!light) + staticBox(disclaimer, TYPE.micro, muted) : '',
    footer: footer(TOTAL, muted),
  });
}

function buildPages(styleId) {
  const theme = themeFor(styleId);
  const cover = styleId === 'relatable' ? relatableCover()
    : styleId === 'breaking-news' ? breakingCover()
      : educationCover();

  return [
    cover,
    briefPage(styleId, theme),
    ...Array.from({ length: POINTS }, (_, i) => pointPage(styleId, i + 1)),
    closePage(styleId, theme),
    ctaPage(styleId, theme),
  ].join('\n');
}

function buildHtml(styleId) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(TITLE[styleId])}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Montserrat', Arial, sans-serif; }
  [data-document-role="page"] {
    width:${SLIDE_W}px; height:${SLIDE_H}px; overflow:hidden;
  }
  .frame {
    position:relative; width:100%; height:100%; padding:${PAD}px;
    display:flex; flex-direction:column; justify-content:space-between;
  }
  .row { display:flex; flex-direction:row; justify-content:space-between; align-items:center; width:100%; }
  .body { display:flex; flex-direction:column; flex:1 1 auto; width:${CONTENT_W}px; }
  p { max-width:${CONTENT_W}px; }
</style>
</head>
<body>
${buildPages(styleId)}
</body>
</html>`;
}

const outDir = resolve(process.argv[2] || 'canva-styles');
await mkdir(outDir, { recursive: true });

// The mark is a data URI in the renderer; the importer needs it as a fetchable
// file, so both variants are decoded out next to the decks.
const b64 = (dataUri) => Buffer.from(dataUri.split(',')[1], 'base64');
await writeFile(resolve(outDir, 'logo-dark.png'), b64(LOGO_DARK));
await writeFile(resolve(outDir, 'logo-light.png'), b64(LOGO_LIGHT));
console.log(`wrote logo-dark.png / logo-light.png (${LOGO_W}x${LOGO_H})`);

for (const styleId of STYLE_IDS) {
  await writeFile(resolve(outDir, `${styleId}.html`), buildHtml(styleId), 'utf8');
  console.log(`wrote ${resolve(outDir, `${styleId}.html`)}`);
}
console.log(`\n${STYLE_IDS.length} decks at ${SLIDE_W}x${SLIDE_H}, ${TOTAL} pages each.`);

// scripts/build-canva-promo-decks.mjs
//
// Emit one self-contained HTML deck per PROMO template, for import into Canva as
// an EDITABLE design. Sibling of build-canva-style-decks.mjs, which does the same
// job for the three editorial house styles; read that file's header first, the
// reasoning about why HTML rather than the satori renderer applies here too.
//
// These four decks are 3 pages, not 8, and follow a compressed arc:
//
//   page 1  cover   headline + subhead
//   page 2  points  point1 + point1body
//   page 3  close   update + note + ctaLink
//
// Seven autofill fields, not eight: the URL was removed from the cover and the
// points page in favour of the Vance mark, so `domain` no longer exists. Only the
// closing slide carries a link, and it stays an autofill field (`ctaLink`) so the
// CSV decides whether that is an apex domain or a deep path.
//
// ── Grounds ────────────────────────────────────────────────────────────────
// Each deck runs its own three-ground sequence, set by the operator. Text colour
// is NOT specified per deck: it is derived from the ground's luminance by
// inkFor() below and asserted against 7:1 at build time, so a ground can be
// changed here without anyone having to remember which slides then need
// inverting.
//
// ── The teal problem, and why the ground is not #008080 ────────────────────
// The brand kit's teal is #008080. White on it measures 4.77:1 — AA for normal
// text, but short of the 7:1 this project holds itself to, and carousel-theme.js
// Note 2 already refuses teal as a text ground for that reason (it rejected the
// LIGHTER #006868 at 6.60:1). Every teal slide here carries a headline and body
// copy, so the ground is TEAL_DEEP #004d4d (9.68:1), which is already the ground
// on the hand-built Vance-Ai deck. #008080 survives as the accent, where a 3:1
// non-text floor applies and it passes comfortably.
//
// Usage:  node scripts/build-canva-promo-decks.mjs [outDir] [assetBase]
// Default outDir is ./canva-promos, served by Vercel at /canva-promos/*. Those
// files exist only to be fetched once by Canva's importer; delete and redeploy
// afterwards, exactly as the style decks do.

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SLIDE_W, SLIDE_H, C, TYPE, PAD, CONTENT_W, LOGO_H } from '../lib/social/carousel-theme.js';
import { LOGO_DARK, LOGO_LIGHT, LOGO_ASPECT } from '../lib/social/assets/logo.js';

const ASSET_BASE = process.argv[3] || 'https://vance-content.vercel.app/canva-promos';
const LOGO_W = Math.round(LOGO_H * LOGO_ASPECT);

// ── palette ─────────────────────────────────────────────────────────────────
// Purples are the two the operator added to the VANCE-Social Media Kit. Only the
// deep one is a ground: #8e7dbe reaches 3.60:1 with white and 4.38:1 with body
// text, both of which are "AA large text only", and this deck's body copy is 44
// slide px (~16px effective, per carousel-theme.js Note 1) which is NOT large.
// So the light purple is an accent, and even then only over white or navy.
const P = {
  navy:       C.ink,        // #1b3355 — white 12.72:1
  teal:       '#004d4d',    // white 9.68:1  (see header)
  tealAccent: '#008080',    // brand kit teal, chips and rules only
  white:      C.white,      // #ffffff — body 15.78:1
  purple:     '#632c94',    // white 9.06:1
  purpleLt:   '#8e7dbe',    // accent only, never a text ground
  body:       C.body,       // #1a2332
};

// ── fonts ───────────────────────────────────────────────────────────────────
// Canva's importer maps font-family NAMES against its own library; it does not
// fetch webfonts from the imported HTML. Montserrat is a Canva/Google standard
// and resolves. Horizon and Neo Tech are brand fonts and resolve only if they
// exist in this Canva account — if they do not, the importer silently falls back
// and the deck must be corrected in the Canva UI. That is why one deck is
// imported as a pilot before the other three.
const FONT_HEAD  = "'Horizon', 'Montserrat', sans-serif";
const FONT_BODY  = "'Montserrat', sans-serif";
const FONT_LABEL = "'Neo Tech', 'Montserrat', sans-serif";

// ── contrast ────────────────────────────────────────────────────────────────
const luminance = (hex) => {
  const [r, g, b] = hex.replace('#', '').match(/../g).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * The text colour for a ground, chosen rather than configured.
 *
 * This is what makes "check all font colours work, invert as needed" a property
 * of the build instead of a review step: change a ground above and the type
 * inverts itself, or the build fails.
 */
function inkFor(ground) {
  const onWhite = contrast(ground, P.white);
  const onBody = contrast(ground, P.body);
  const pick = onWhite >= onBody ? P.white : P.body;
  const best = Math.max(onWhite, onBody);
  if (best < 7) {
    throw new Error(
      `Ground ${ground} reaches only ${best.toFixed(2)}:1 against its best text colour. `
      + 'This project targets 7:1. Pick a darker or lighter ground.',
    );
  }
  return { ink: pick, ratio: best };
}

/**
 * Muted variant of the ink, returned as a FLAT HEX and never as rgba().
 *
 * Canva's importer drops alpha on text colours and lands the result on #000000
 * (build-canva-style-decks.mjs, trap 8). A first pilot import of this deck proved
 * it again: `rgba(255,255,255,0.86)` on the purple cover came back as
 * `color=#000000`, i.e. 1.74:1 on that ground. So the alpha is composited here,
 * against a ground we know exactly, and only the resulting opaque colour is
 * emitted. That is exact rather than an approximation: alpha over a known opaque
 * ground is precisely the calculation the measured ratio already assumes.
 */
function mutedFor(ground, ink) {
  for (const alpha of [0.86, 0.9, 0.94]) {
    const flat = mix(ink, ground, alpha);
    if (contrast(ground, flat) >= 7) return flat;
  }
  return ink;
}

const mix = (fg, bg, alpha) => {
  const f = fg.replace('#', '').match(/../g).map((h) => parseInt(h, 16));
  const b = bg.replace('#', '').match(/../g).map((h) => parseInt(h, 16));
  return `#${f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha))
    .toString(16).padStart(2, '0')).join('')}`;
};

/** Accent that survives on this ground at the 3:1 non-text floor. */
function accentFor(ground) {
  for (const candidate of [P.purpleLt, P.tealAccent, P.white, P.navy]) {
    if (contrast(ground, candidate) >= 3) return candidate;
  }
  return inkFor(ground).ink;
}

// ── decks ───────────────────────────────────────────────────────────────────
// `label` is the template name without the "Vance Carousel" prefix, set at the
// top of every slide in Neo Tech, per the operator's spec.
const DECKS = [
  { id: 'health-quiz',  label: 'Health Quiz',  grounds: [P.teal,   P.white, P.navy] },
  { id: 'dashboard',    label: 'Dashboard',    grounds: [P.navy,   P.white, P.teal] },
  { id: 'vance-ai',     label: 'Vance-Ai',     grounds: [P.purple, P.teal,  P.white] },
  { id: 'meal-planner', label: 'Meal Planner', grounds: [P.white,  P.navy,  P.purple] },
];

// ── html ────────────────────────────────────────────────────────────────────
const css = (o) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(';');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The mark, in whichever variant survives this ground.
 *
 * Replaces the URL that used to sit here. Canva's importer resolves <img src>
 * over the network, so it must be a real HTTPS URL on the same host as the HTML
 * — a data URI is silently dropped (build-canva-style-decks.mjs, trap 9).
 */
const logo = (ground) => {
  const onDark = contrast(ground, P.white) >= contrast(ground, P.body);
  return `<img src="${ASSET_BASE}/logo-${onDark ? 'light' : 'dark'}.png" alt="Vance" style="${css({
    width: `${LOGO_W}px`, height: `${LOGO_H}px`, 'object-fit': 'contain', display: 'block',
  })}" />`;
};

/**
 * One editable text box.
 *
 * The placeholder text IS the app's field name, matching the house convention in
 * build-canva-style-decks.mjs. Two reasons, and the second is the one that
 * matters: it makes the binding legible when the deck is published as a brand
 * template, and an autofill that fails to fill then shows "point1" on the
 * artwork rather than silently keeping stale designer copy. A loud failure is
 * the one you notice.
 */
const field = (name, type, colour, extra = {}) => `<div style="${css({
  'font-family': type.font,
  'font-size': `${type.fontSize}px`,
  'font-weight': type.fontWeight,
  'line-height': type.lineHeight,
  ...(type.letterSpacing ? { 'letter-spacing': `${type.letterSpacing}px` } : {}),
  color: colour,
  margin: '0',
  ...extra,
})}">${esc(name)}</div>`;

/**
 * A page. Fixed 1080x1350, flex column, mark pinned to the bottom.
 *
 * The generous gap under each field is deliberate and must not be tightened:
 * Canva's import freezes flow layout into absolute positions, so any box sized to
 * its placeholder is overrun by the first real autofill (trap 7). The space is
 * the room the longest realistic copy will need.
 */
function page(deck, index) {
  const ground = deck.grounds[index];
  const { ink } = inkFor(ground);
  const muted = mutedFor(ground, ink);
  const accent = accentFor(ground);

  // TYPE.coverHead is 84px, calibrated in carousel-theme.js against the satori
  // renderer's font. Horizon is considerably wider: measured on the first live
  // import, a 33-character headline set 4 lines in the 936px column, i.e. about
  // 9 characters per line. buildPromoSpec allows hookTitle up to TEN WORDS, which
  // at that width is ~7 lines, and a fixed Canva page never reflows (trap 7) — it
  // would simply overlap the subhead. Sizes are reduced and the reserved heights
  // below widened so the documented maximum fits rather than the typical case.
  const heads = [
    { name: 'headline', type: { ...TYPE.coverHead, fontSize: 72, font: FONT_HEAD } },
    { name: 'point1', type: { ...TYPE.coverHead, fontSize: 60, font: FONT_HEAD } },
    { name: 'update', type: { ...TYPE.coverHead, fontSize: 72, font: FONT_HEAD } },
  ][index];

  const bodies = [
    [{ name: 'subhead', type: { ...TYPE.contextBody, font: FONT_BODY } }],
    [{ name: 'point1body', type: { ...TYPE.body, font: FONT_BODY } }],
    [
      { name: 'note', type: { ...TYPE.contextBody, font: FONT_BODY } },
      { name: 'ctaLink', type: { ...TYPE.ctaLabel, font: FONT_BODY } },
    ],
  ][index];

  return `<section data-document-role="page" data-label="${esc(deck.label)} ${index + 1}" style="${css({
    position: 'relative', width: `${SLIDE_W}px`, height: `${SLIDE_H}px`,
    background: ground, padding: `${PAD}px`, 'box-sizing': 'border-box',
    display: 'flex', 'flex-direction': 'column',
  })}">

  <!-- template name, Neo Tech, top of every slide -->
  <div style="${css({
    'font-family': FONT_LABEL,
    'font-size': `${TYPE.eyebrow.fontSize}px`,
    'font-weight': TYPE.eyebrow.fontWeight,
    'letter-spacing': `${TYPE.eyebrow.letterSpacing}px`,
    'text-transform': 'uppercase',
    color: accent,
    margin: '0 0 12px 0',
  })}">${esc(deck.label)}</div>
  <div style="${css({
    width: '120px', height: '6px', background: accent, margin: '0 0 44px 0',
  })}"></div>

  <div style="${css({ width: `${CONTENT_W}px`, flex: '1 1 auto' })}">
    ${field(heads.name, heads.type, ink, { 'margin-bottom': '40px', 'min-height': '520px' })}
    ${bodies.map((b, i) => field(
      b.name, b.type, i === 0 ? muted : ink,
      { 'margin-bottom': '32px', 'min-height': b.name === 'point1body' ? '300px' : '170px' },
    )).join('\n    ')}
  </div>

  <!-- the mark, replacing the URL that used to sit here -->
  <div style="${css({ 'margin-top': 'auto' })}">${logo(ground)}</div>
</section>`;
}

function buildHtml(deck) {
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<title>Vance Carousel ${esc(deck.label)}</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap" rel="stylesheet" />
<style>body{margin:0;padding:0;background:#ffffff}</style>
</head><body>
${deck.grounds.map((_, i) => page(deck, i)).join('\n\n')}
</body></html>`;
}

// ── emit ────────────────────────────────────────────────────────────────────
const outDir = resolve(process.argv[2] || 'canva-promos');
await mkdir(outDir, { recursive: true });

const b64 = (dataUri) => Buffer.from(String(dataUri).split(',')[1], 'base64');
await writeFile(resolve(outDir, 'logo-dark.png'), b64(LOGO_DARK));
await writeFile(resolve(outDir, 'logo-light.png'), b64(LOGO_LIGHT));
console.log(`wrote logo-dark.png / logo-light.png (${LOGO_W}x${LOGO_H})`);

console.log('\nground / text pairings, all asserted at 7:1:');
for (const deck of DECKS) {
  await writeFile(resolve(outDir, `${deck.id}.html`), buildHtml(deck), 'utf8');
  const rows = deck.grounds.map((g, i) => {
    const { ink, ratio } = inkFor(g);
    return `${['cover ', 'points', 'close '][i]} ${g} + ${ink} = ${ratio.toFixed(2)}:1`;
  });
  console.log(`  ${deck.label.padEnd(13)} ${rows.join('   |   ')}`);
  console.log(`  ${' '.repeat(13)} -> ${deck.id}.html`);
}
console.log('\nFields per deck: headline, subhead, point1, point1body, update, note, ctaLink');

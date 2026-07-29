// lib/social/carousel-theme.js
//
// Design system for the Article Carousel slides. Every value here was chosen
// against measured WCAG contrast ratios and *effective* on-screen size, not
// nominal pixels — see the two notes below, they drive most of the decisions.
//
// ── Note 1: effective size, not nominal ────────────────────────────────────
// A 1080px-wide slide displays at roughly 400 CSS px in an Instagram feed on a
// phone, so every size shrinks ~2.7x. A "34px" caption is ~12.6px to the reader.
// So all *content* text is sized to clear 16px effective (>= 44 slide px), and
// nothing is treated as WCAG "large text" even though the nominal numbers look
// huge. Supplementary furniture (brand handle, slide counter, photo credit,
// disclaimer) sits below that floor by necessity — it is fine print, not
// reading content — and is kept at >= 30px so it stays resolvable.
//
// ── Note 2: #006868 can never be a text ground ─────────────────────────────
// White on --vance-primary #006868 measures 6.60:1 — solid AA, but it cannot
// reach the 7:1 AAA target this content type (health education) should hold, and
// no alpha tint over it reaches 7:1 either. So primary is used for chips, rules
// and accents only; the dark grounds are --vance-dark #1b3355, where white is
// 12.72:1. The evidence slide, originally specced on primary, is on paper for
// the same reason.
//
// Measured ratios for every pairing actually used are recorded inline.

/** Instagram 4:5 portrait — the largest feed footprint, and the aspect already
 *  declared for instagram in lib/social/ava-prompts.js (imageAspect '4:5'). */
export const SLIDE_W = 1080;
export const SLIDE_H = 1350;

/** Instagram's Graph API accepts at most 10 children in a carousel. The default
 *  deck is 8, which leaves headroom; anything above this is a hard error rather
 *  than a silent truncation. */
export const MAX_CAROUSEL_SLIDES = 10;

/** Colour roles. Hexes are the app's existing tokens (index.html :19-40) —
 *  this file assigns them roles, it does not invent new brand colour. */
export const C = {
  ink:     '#1b3355', // --vance-dark: dark grounds, and body text on paper
  primary: '#006868', // --vance-primary: chips + rules ONLY (see Note 2)
  accent:  '#4DBDBD', // --vance-accent: eyebrows + rules on ink grounds only
  paper:   '#EEF7F3', // --bg: light grounds
  body:    '#1a2332', // --text: body copy on paper
  white:   '#ffffff',
};

/** Minimum alpha that still clears 7:1 for muted text, measured per ground.
 *  Anything more transparent than these fails AAA, so they are floors, not
 *  suggestions. */
export const MUTED = {
  onPaper: 'rgba(26,35,50,0.80)',      // 8.35:1 — body @80% on paper
  onInk:   'rgba(255,255,255,0.72)',   // 7.38:1 — white @72% on ink
  // Relatable's reassure/cta slides swap navy for Vance teal (#006868) as
  // their ground. White on #006868 measures 6.60:1 at FULL opacity — that is
  // the ceiling, not a floor: it is lighter than ink, so onInk's 72%-alpha
  // white (which reaches 7.38:1 against navy) only reaches ~4.24:1 here, a
  // real AA-normal-text failure. 95% opacity is the highest that still reads
  // as "muted" against how close it sits to the ceiling, at ~6.13:1 — below
  // this file's usual AAA target, but a deliberate, documented exception for
  // that one ground, not a floor other pairings should be judged against.
  onPrimary: 'rgba(255,255,255,0.95)', // ~6.13:1 — white @95% on primary
  // Breaking News's closing ("update") slide and CTA scrim use BREAKING_BG
  // below, not `C`'s ink/paper/primary — a lighter tint again, so it gets its
  // own calibrated muted value rather than reusing onPaper's.
  onBreakingBg: 'rgba(26,35,50,0.90)', // 8.26:1 — ink @90% on #aedbdb
};

/**
 * Breaking News style's own background colour — a light teal-tint distinct
 * from every other ground in `C`. It exists only for that one style's closing
 * "update" slide and (as a near-opaque photo scrim) its CTA — see
 * breakingUpdateSlide/ctaSlide in carousel-render.js.
 *
 * It is LIGHT (relative luminance 0.648, between paper's 0.91 and primary's
 * 0.11), which flips the usual rule: only dark text works here. Ink measures
 * 8.45:1 — comfortably AAA — but white collapses to 1.5:1. Never put white
 * text on this ground.
 */
export const BREAKING_BG = '#aedbdb';

/**
 * Human labels for the app's content categories, shown as the persistent category
 * tag in each slide's header band. Keys match the content record's `category`.
 * Shared with carousel-spec.js, which uses them as the eyebrow fallback.
 */
export const CATEGORY_LABELS = {
  'industry-news':    'Healthcare news',
  'clinical-reviews': 'Clinical review',
  'op-eds':           'Expert opinion',
  'white-papers':     'White paper',
  'infographics':     'Explainer',
  'ibd-living':       'Living with IBD',
};

/** Fallback when a content record carries an unknown or missing category. */
export const CATEGORY_FALLBACK = 'Health education';

export const categoryLabelFor = (id) => CATEGORY_LABELS[id] || CATEGORY_FALLBACK;

/**
 * Rendered height of the Vance mark in the header band. Width follows from
 * LOGO_ASPECT in ./assets/logo.js (~4:1 after the tight crop), so 84 gives a
 * 335x84 mark.
 *
 * Sized against the ÷2.7 rule in Note 1: at 42 the wordmark landed around 15px on
 * a phone and read as a smudge; 56 held; 84 puts the "VANCE" caps near 20px
 * effective, which is comfortably legible in a feed.
 */
export const LOGO_H = 84;

/** Type scale in slide px. The `eff` comments are the ~400px-phone equivalent. */
export const TYPE = {
  coverHead:  { fontSize: 84, fontWeight: 700, lineHeight: 1.08 }, // eff 31px
  pointHead:  { fontSize: 60, fontWeight: 700, lineHeight: 1.14 }, // eff 22px
  contextBody:{ fontSize: 52, fontWeight: 400, lineHeight: 1.36 }, // eff 19px
  journal:    { fontSize: 50, fontWeight: 700, lineHeight: 1.22 }, // eff 19px
  ctaLabel:   { fontSize: 48, fontWeight: 700, lineHeight: 1.1  }, // eff 18px
  body:       { fontSize: 44, fontWeight: 400, lineHeight: 1.42 }, // eff 16px — content floor
  eyebrow:    { fontSize: 38, fontWeight: 700, lineHeight: 1.2, letterSpacing: 4 }, // eff 14px
  footer:     { fontSize: 34, fontWeight: 400, lineHeight: 1.2 }, // eff 13px — furniture
  // Category tag in the header band. Sized below `eyebrow` on purpose: on the
  // cover it sits above the editorial topic eyebrow, and the two must not compete.
  tag:        { fontSize: 30, fontWeight: 700, lineHeight: 1.2, letterSpacing: 3 }, // eff 11px
  micro:      { fontSize: 30, fontWeight: 400, lineHeight: 1.3 }, // eff 11px — fine print
};

/** 8px base unit, 72px side gutters → a 936px content column. */
export const PAD = 72;
export const CONTENT_W = SLIDE_W - PAD * 2;

/** Corners are square everywhere — the app's global `--radius: 0px` house rule
 *  (index.html :35). Deliberately no borderRadius anywhere in the renderer. */
export const RADIUS = 0;

/**
 * Ground assignment per slide index, which sets the deck's visual rhythm:
 * two dark opening slides → a light run of teaching content → a dark photo
 * close. The flip back to dark on the final slide is what makes the CTA read
 * as an arrival rather than one more point.
 */
export const GROUND = { cover: 'photo', context: 'ink', point: 'paper', evidence: 'paper', cta: 'photo' };

/**
 * Hero-photo scrim gradients as `[position%, opacity]` stops running bottom → top.
 *
 * Tuned against a real stock photo, not guessed. The cover spends its
 * transparency in the top third — where no text sits — and stays near-opaque
 * across the headline band, because a bright highlight in the photo (a lit
 * surgical glove, in testing) will otherwise eat the contrast of white text.
 *
 * The CTA is heavier still and almost flat: that slide is a call to action
 * carrying a button and three lines of copy, so the photo is texture behind it,
 * not the subject. Letting the image compete there cost both legibility and the
 * sense of arrival the final slide needs.
 */
export const SCRIM = {
  cover: [[0, 0.97], [38, 0.93], [72, 0.55], [100, 0.30]],
  cta:   [[0, 0.96], [55, 0.93], [100, 0.88]],
};

/** Fixed copy. Kept here rather than in the LLM prompt so it is guaranteed
 *  present and consistent — the disclaimer in particular must never be left to
 *  a model's discretion. Shared across every EDITORIAL content style: the medical
 *  disclaimer must never vary by tone. Promotional decks are the one exception
 *  and override it via STYLES.promotional.disclaimer — see the note there. */
export const FIXED_COPY = {
  swipe:      'SWIPE TO REVEAL',
  contextLabel:  'WHY IT MATTERS',
  evidenceLabel: 'THE EVIDENCE',
  // Used on slide 7 when the article names no journal/author/year, so the slide
  // leads with the takeaway instead of an almost-empty citation block.
  takeawayLabel: 'WHAT THIS MEANS',
  disclaimer: 'Educational information only. Not medical advice: speak to your clinician about your own care.',
  ctaLabel:   'READ THE FULL ARTICLE',
  ctaNote:    'Save this and share it with someone who needs it',
};

/** The style id promotional decks render under. Deliberately NOT a member of
 *  CAROUSEL_STYLES (lib/social/carousel-spec.js): that list is what an ARTICLE
 *  deck may be built as, and buildCarouselSpec has no prompt builder for this
 *  one — a promo spec comes from lib/social/promo-spec.js instead. Keeping it
 *  out of that enum is what stops the article UI from offering a style that
 *  would fail at generation time. */
export const PROMO_STYLE = 'promotional';

/**
 * Content styles for the carousel. Deliberately narrow: every colour pairing
 * from Notes 1 and 2 above, the type scale, PAD and RADIUS are identical
 * across styles — nothing here introduces a contrast pairing that wasn't
 * already measured and used elsewhere in this file. What varies is which of
 * the two already-verified grounds (ink or paper) opens and closes the deck,
 * and the label microcopy for the slide that ground carries.
 *
 *   education — opens on the dark "why it matters" slide, closes light on the
 *               citation/evidence slide. Mirrors a teaching arc: set up the
 *               problem, then show the receipts.
 *   relatable — opens light and conversational ("if this sounds familiar"),
 *               closes dark and quiet ("you're not alone") — a validating
 *               arrival rather than a citation, since this style never
 *               carries an evidence slide.
 *   breaking-news — opens dark on the bulletin, closes on BREAKING_BG with the
 *               forward look. Previously ABSENT from this map, which meant
 *               themeFor('breaking-news') silently returned education's theme;
 *               harmless only because its two slides hardcoded their own labels.
 *               Now that those labels are read from here, the entry is required.
 *   promotional — the one non-editorial style: no citation, no medical
 *               disclaimer, and a CTA that points at an offer rather than an
 *               article. Built from lib/social/promo-spec.js, never from an
 *               article. Structurally it borrows breaking-news's two slides
 *               (a plain-body open and a light-ground close), so it needs the
 *               same lightCloseGround treatment on the CTA slide.
 *
 * `disclaimer` is per-style rather than a single FIXED_COPY constant because a
 * promotional deck must not carry the medical-education disclaimer — it is not
 * educational content, and stamping "not medical advice" on an offer slide is
 * both wrong and confusing. An empty string omits the block entirely.
 *
 * `lightCloseGround` marks the styles whose closing slide sits on a LIGHT tint
 * (BREAKING_BG) rather than ink or paper. It flips which text colours survive on
 * the CTA slide — white collapses to ~1.5:1 on that tint — so ctaSlide reads it
 * instead of testing for the breaking-news style by name.
 */
export const STYLES = {
  education: {
    feelingGround: 'ink',
    closingGround: 'paper',
    feelingLabel: FIXED_COPY.contextLabel,
    closingLabelWithCitation: FIXED_COPY.evidenceLabel,
    closingLabelPlain: FIXED_COPY.takeawayLabel,
    disclaimer: FIXED_COPY.disclaimer,
  },
  relatable: {
    feelingGround: 'paper',
    closingGround: 'ink',
    feelingLabel: 'IF THIS SOUNDS FAMILIAR',
    closingLabelPlain: 'YOU’RE NOT ALONE',
    disclaimer: FIXED_COPY.disclaimer,
  },
  'breaking-news': {
    feelingGround: 'ink',
    closingGround: 'breaking',
    feelingLabel: 'WHAT WE KNOW',
    closingLabelPlain: 'THE UPDATE',
    disclaimer: FIXED_COPY.disclaimer,
    lightCloseGround: true,
  },
  [PROMO_STYLE]: {
    feelingGround: 'ink',
    closingGround: 'breaking',
    feelingLabel: 'WHAT YOU GET',
    closingLabelPlain: 'READY WHEN YOU ARE',
    // Deliberately empty: see the note above. A promo deck carries no medical
    // disclaimer, and the slide simply omits the block.
    disclaimer: '',
    lightCloseGround: true,
    // Overrides FIXED_COPY.ctaLabel/ctaNote, which point at "the full article".
    // A promo deck has no article behind it. Per-campaign copy can override
    // these again via spec.cta.label / spec.cta.note.
    ctaLabel: 'SHOP THE RANGE',
    ctaNote: 'Tap the link in bio to find out more',
  },
};

export function themeFor(style) {
  return STYLES[style] || STYLES.education;
}

/**
 * The theme a deck actually renders with: its base style, with a design
 * template's overrides layered on top.
 *
 * Design templates (lib/social/design-templates.js) let an operator keep a
 * layout they like while changing its microcopy — the two slide labels, the
 * disclaimer, the CTA wording. Everything else about a style, the grounds and
 * the measured colour pairings above, is deliberately NOT overridable: those
 * were each checked for contrast at effective on-screen scale, and letting a
 * template supply arbitrary colours would quietly undo that work.
 *
 * Keys present but explicitly empty are honoured, not treated as absent — a
 * template setting `disclaimer: ''` means "omit the disclaimer", which is a
 * different instruction from "inherit the base style's". Hence the `in` checks
 * rather than `??`.
 *
 * @param {string} style - base style id
 * @param {object|null} [override] - a template's partial theme
 * @returns {object} a frozen-by-convention theme; callers must not mutate it
 */
export function resolveTheme(style, override = null) {
  const base = themeFor(style);
  if (!override) return base;

  const out = { ...base };
  for (const field of ['feelingLabel', 'closingLabelPlain', 'closingLabelWithCitation', 'disclaimer', 'ctaLabel', 'ctaNote']) {
    if (field in override && override[field] != null) out[field] = override[field];
  }
  return out;
}

// lib/social/design-templates.js
//
// Design templates: the visual recipe a deck renders with.
//
// A template is a base style plus microcopy overrides. The base style decides the
// *layout* — which slide types the deck has and which grounds they sit on — and
// that comes from the four styles in carousel-theme.js, each of whose colour
// pairings was measured for contrast at effective on-screen scale. A template
// cannot change those: it changes the words.
//
// That boundary is the whole design. Letting an operator supply arbitrary colours
// would quietly undo the accessibility work in carousel-theme.js, and letting them
// invent layouts would mean satori element trees in KV. What they actually want to
// vary — "call the second slide THE OFFER, drop the medical disclaimer, make the
// button say BUY NOW" — is all microcopy, and all safe.
//
//   social:design-template:{id}    one custom template
//   social:design-templates:index  newest-first list of custom template ids
//
// The four built-ins are not stored: they are derived from STYLES so there is
// exactly one source of truth for what "Education" means, and so a change to a
// style's labels cannot leave a stale copy behind in KV.

import { kv } from '../kv.js';
import { STYLES, PROMO_STYLE, themeFor } from './carousel-theme.js';

export const TEMPLATE_INDEX = 'social:design-templates:index';
const INDEX_CAP = 100;
export const templateKey = (id) => `social:design-template:${id}`;

/** Base styles a template may build on. Anything outside this list is rejected
 *  rather than defaulted: silently rendering a deck in the wrong layout is the
 *  failure mode themeFor's fallback already caused once. */
export const BASE_STYLES = ['education', 'relatable', 'breaking-news', PROMO_STYLE];

const BUILT_IN_META = {
  education: {
    name: 'Education',
    description: 'Teaching arc. Opens dark on why it matters, closes light on the evidence. Carries the medical disclaimer.',
  },
  relatable: {
    name: 'Relatable',
    description: 'Lived-experience arc. Opens light and conversational, closes on reassurance. No citation slide.',
  },
  'breaking-news': {
    name: 'Breaking News',
    description: 'Newsflash tone. Opens on the bulletin, closes on what happens next.',
  },
  [PROMO_STYLE]: {
    name: 'Promotional',
    description: 'Offer-led. No citation and no medical disclaimer, and the CTA points at a product rather than an article.',
  },
};

/**
 * The four built-in templates, derived from STYLES rather than duplicated.
 *
 * `themeOverride: null` is what marks a built-in: it renders as its base style
 * with nothing layered on, which is exactly what these are.
 */
export function builtInTemplates() {
  return BASE_STYLES.map((style) => {
    const theme = themeFor(style);
    return {
      id: style,
      name: BUILT_IN_META[style].name,
      description: BUILT_IN_META[style].description,
      builtIn: true,
      baseStyle: style,
      themeOverride: null,
      coverImageUrl: null,
      coverCredit: null,
      // Shown in the picker so an operator can see what they are choosing
      // without rendering a preview first.
      preview: {
        briefLabel: theme.feelingLabel || '',
        closeLabel: theme.closingLabelPlain || theme.closingLabelWithCitation || '',
        ctaLabel: theme.ctaLabel || 'READ THE FULL ARTICLE',
        hasDisclaimer: !!theme.disclaimer,
      },
    };
  });
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * Normalise a custom template.
 *
 * Empty-string microcopy is meaningful and preserved: `disclaimer: ''` means
 * "omit the disclaimer", which is not the same instruction as "inherit the base
 * style's". Only genuinely absent fields fall through to the base — see
 * resolveTheme in carousel-theme.js, which applies the same distinction.
 */
export function buildTemplate(data = {}, existing = null) {
  const now = new Date().toISOString();
  const baseStyle = BASE_STYLES.includes(data.baseStyle ?? existing?.baseStyle)
    ? (data.baseStyle ?? existing.baseStyle)
    : PROMO_STYLE;

  const pick = (field, max) => {
    if (field in data) return str(data[field], max);
    if (existing && field in existing) return existing[field];
    return null;
  };

  return {
    id: existing?.id || `tpl_${Date.now()}`,
    name: str(data.name ?? existing?.name ?? '', 80) || 'Untitled template',
    description: str(data.description ?? existing?.description ?? '', 240),
    builtIn: false,
    baseStyle,

    // Microcopy. null means inherit; '' means omit.
    briefLabel: pick('briefLabel', 40),
    closeLabel: pick('closeLabel', 40),
    disclaimer: pick('disclaimer', 300),
    ctaLabel: pick('ctaLabel', 40),
    ctaNote: pick('ctaNote', 120),

    // A cover shipped with the template, so picking it pre-fills the campaign's
    // image. Held as a URL (stock/hosted) or a data URI (upload/generated).
    coverImageUrl: data.coverImageUrl ?? existing?.coverImageUrl ?? null,
    coverCredit: data.coverCredit ?? existing?.coverCredit ?? null,

    createdAt: existing?.createdAt || now,
    updatedAt: now,
    createdBy: existing?.createdBy || str(data.createdBy ?? 'user', 60),
  };
}

/** The partial theme a template contributes, in the shape resolveTheme expects. */
export function themeOverrideFor(template) {
  if (!template || template.builtIn) return null;
  const out = {};
  if (template.briefLabel != null) out.feelingLabel = template.briefLabel;
  if (template.closeLabel != null) out.closingLabelPlain = template.closeLabel;
  if (template.disclaimer != null) out.disclaimer = template.disclaimer;
  if (template.ctaLabel != null) out.ctaLabel = template.ctaLabel;
  if (template.ctaNote != null) out.ctaNote = template.ctaNote;
  return Object.keys(out).length ? out : null;
}

export async function saveTemplate(template, { indexIt = false } = {}) {
  const record = { ...template, updatedAt: new Date().toISOString() };
  await kv.set(templateKey(record.id), record);
  if (indexIt) {
    await kv.lpush(TEMPLATE_INDEX, record.id);
    await kv.ltrim(TEMPLATE_INDEX, 0, INDEX_CAP - 1);
  }
  return record;
}

export async function getTemplate(id) {
  if (!id) return null;
  // Built-in ids are style names, and are never in KV.
  const builtIn = builtInTemplates().find((t) => t.id === id);
  if (builtIn) return builtIn;
  return (await kv.get(templateKey(id))) || null;
}

export async function listCustomTemplates({ limit = 100 } = {}) {
  const ids = await kv.lrange(TEMPLATE_INDEX, 0, Math.max(0, limit - 1));
  if (!ids?.length) return [];
  const records = await Promise.all(ids.map((id) => kv.get(templateKey(id))));
  return records.filter(Boolean);
}

/** Built-ins first, then custom newest-first — the order the picker renders. */
export async function listTemplates({ limit = 100 } = {}) {
  return [...builtInTemplates(), ...(await listCustomTemplates({ limit }))];
}

export async function deleteTemplate(id) {
  if (builtInTemplates().some((t) => t.id === id)) {
    throw new Error('Built-in templates cannot be deleted');
  }
  const existing = await kv.get(templateKey(id));
  if (!existing) return false;
  await kv.del(templateKey(id));
  await kv.lrem(TEMPLATE_INDEX, 0, id);
  return true;
}

/**
 * Everything a deck needs to render in this template.
 *
 * Falls back to the promotional style for a template that has since been deleted,
 * rather than throwing — a campaign whose template was removed should keep
 * producing decks in a sane default, not stop dead on its next slot.
 *
 * @returns {Promise<{style: string, themeOverride: object|null, template: object|null}>}
 */
export async function resolveTemplateForDeck(templateId) {
  const template = await getTemplate(templateId);
  if (!template) {
    return { style: PROMO_STYLE, themeOverride: null, template: null };
  }
  return {
    style: template.baseStyle,
    themeOverride: themeOverrideFor(template),
    template,
  };
}

export { STYLES };

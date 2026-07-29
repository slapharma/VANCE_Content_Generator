// lib/social/carousel-spec.js
//
// Turns a generated article into the slide copy for an Article Carousel.
//
// The deck is fixed-shape by design — cover, context, N key points, evidence,
// CTA — so this asks the model for a JSON object matching that shape rather than
// free prose. Two consequences worth knowing:
//
//   • Word caps are enforced here in code, not merely requested in the prompt.
//     Models routinely overshoot, and an overshoot is not a cosmetic problem: the
//     slide layouts are fixed-height, so long copy would silently overflow the
//     frame. `clampWords` is the backstop.
//   • The medical disclaimer and the CTA label are NOT model-generated. They live
//     in FIXED_COPY in carousel-theme.js so they cannot drift or go missing on a
//     bad generation. For health content that is a correctness requirement, not a
//     style preference.
//
// The tone brief is education-first and explicitly anti-promotional: these
// articles teach, and a carousel that reads like an ad for the brand would both
// underperform and misrepresent the content.

import { callOpenRouter } from './llm.js';
import { BRAND } from './ava-prompts.js';
import { categoryLabelFor } from './carousel-theme.js';
import { sanitiseSlideText, normaliseHashtags } from './carousel-text.js';

/** The deck always carries cover + context + evidence + CTA around the points. */
const FIXED_SLIDES = 4;
export const DEFAULT_SLIDE_COUNT = 8;
const MIN_POINTS = 2;
const MAX_POINTS = 6;

/** Canonical list of content styles — the single source of truth both the rule
 *  schema's enum-whitelist and the carousel handler's validation import,
 *  rather than each keeping its own copy that can drift. Add a new style here
 *  first, then its prompt builder below and its slide layouts in
 *  carousel-render.js. */
export const CAROUSEL_STYLES = ['education', 'relatable', 'breaking-news'];

/** Where the CTA sends readers. The slide prints the domain, not a full URL —
 *  the per-article deep link goes in the caption at posting time, because the
 *  carousel is often built before the article is published. */
const HUB_DOMAIN = process.env.BRAND_HUB_DOMAIN || 'vancehealthhub.co.uk';

// Category labels live in carousel-theme.js — the slides print them as the
// persistent category tag, and they double as the eyebrow fallback here, so there
// is one map rather than two that can drift apart.

// ── text utilities ─────────────────────────────────────────────────────────

/** Strip markdown/HTML down to readable prose for the prompt. */
function toPlainText(raw) {
  return String(raw || '')
    .replace(/<[^>]+>/g, ' ')            // html tags
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → label
    .replace(/[#*_`>|]/g, ' ')           // md punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Trim to a word budget without cutting mid-word, dropping any dangling
 * punctuation the cut leaves behind.
 */
export function clampWords(value, maxWords) {
  const s = sanitiseSlideText(value).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const words = s.split(' ');
  if (words.length <= maxWords) return s;
  return words.slice(0, maxWords).join(' ').replace(/[,;:-]+$/, '').trim();
}

/** First JSON object in a model response, tolerating ```json fences and prose. */
export function extractJson(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON object in model response: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

// normaliseHashtags now lives in carousel-text.js, shared with the promotional
// spec builder — an article caption and a promo caption must not end up with
// differently-shaped tags, and two copies of these rules would eventually drift.
// Re-exported here so existing importers of this module keep working.
export { normaliseHashtags };

// ── prompt ─────────────────────────────────────────────────────────────────

/**
 * The education-style prompt: unchanged from before content styles existed.
 * Teaching arc — hook, why it matters, the points, the citation, the CTA.
 */
function buildEducationPrompt({ title, excerpt, category, pointCount }) {
  const categoryHint = categoryLabelFor(category);
  return `You are writing an educational Instagram carousel for ${BRAND.name}'s health platform, Vance Health Hub — a UK gastroenterology and GI health resource covering IBD (Crohn's, ulcerative colitis), IBS, gastrointestinal nutrition and related conditions.

Your audience is a mix of patients living with these conditions and the clinicians who treat them. They are scrolling on a phone.

THIS IS EDUCATION, NOT PROMOTION. Hard rules:
- Teach something real on every slide. A reader who only sees the carousel and never clicks should still come away better informed.
- Never promote, sell or recommend a product, supplement or brand. Do not mention ${BRAND.name} as a product.
- Never give individual medical advice or tell the reader what to do about their own condition.
- Report what the source says, with its actual numbers where they exist. Do not inflate, and do not manufacture certainty the source does not have.
- Plain English. Expand jargon on first use. No hype, no clickbait, no emoji.
- UK spelling.
- NEVER use em dashes or en dashes. Use a comma, a colon, brackets or a full stop instead.

ARTICLE TITLE: ${title}

ARTICLE CONTENT:
${excerpt}

Return ONLY a JSON object, no commentary, in exactly this shape:

{
  "eyebrow": "2-4 word topic label, e.g. '${categoryHint}'",
  "hookTitle": "The cover headline. MAXIMUM 10 WORDS. Make a curious reader want to swipe — state the substance, do not tease vaguely.",
  "context": {
    "body": "Why this matters, in 1-2 plain sentences. MAXIMUM 35 WORDS. Set up the problem the article addresses."
  },
  "points": [
    {
      "headline": "The single idea of this slide. MAXIMUM 8 WORDS.",
      "body": "Explain it, with the source's numbers if it has them. MAXIMUM 30 WORDS."
    }
  ],
  "takeaway": "What this means in practice, in 1-2 plain sentences. MAXIMUM 30 WORDS. Describe the general implication — never tell the reader what to do about their own condition.",
  "evidence": {
    "journal": "Journal or publication name, or null if the article does not name one",
    "authors": "Lead author et al. in the form 'Sands BE, et al.', or null",
    "year": "Publication year as a string, or null",
    "studyType": "e.g. 'Randomised controlled trial', 'Systematic review', 'Cohort study', or null",
    "sampleSize": "e.g. 'n = 769', or null"
  },
  "caption": "Instagram caption. 2-4 short paragraphs separated by blank lines. Open with the single most interesting finding, summarise what the carousel covers, and close by pointing readers to the full article. MAXIMUM 180 WORDS. No hashtags here.",
  "hashtags": ["5-8 relevant tags, no # prefix, e.g. IBD, Crohns, UlcerativeColitis, GutHealth"]
}

The "points" array must contain EXACTLY ${pointCount} items, each a genuinely different idea — no restating the same finding.

For "evidence": only report what the article actually states. Use null for anything it does not name. Do NOT invent a journal, author, year, study type or sample size.`;
}

/**
 * The relatable-style prompt. Derived from the AVA content-creation
 * methodology's POV/Relatability structure (hook → the felt experience → what
 * actually helps → validation), adapted to a static, no-narrator carousel:
 * second person throughout, spoken English, short sentences, one idea per
 * slide, no citation slide — the deck closes on "you're not alone" rather
 * than a journal reference. The medical-accuracy and no-advice rules are
 * identical to education; only the voice and the closing beat change.
 */
function buildRelatablePrompt({ title, excerpt, category, pointCount }) {
  const categoryHint = categoryLabelFor(category);
  return `You are writing a relatable, human Instagram carousel for ${BRAND.name}'s health platform, Vance Health Hub — a UK gastroenterology and GI health resource covering IBD (Crohn's, ulcerative colitis), IBS, gastrointestinal nutrition and related conditions.

Your audience is people actually living with these conditions, scrolling on a phone. Write to ONE reader, in second person ("you"), the way you'd talk to a friend who gets it. Short sentences. Plain, spoken English, not clinical prose.

THIS IS STILL FACTUAL, JUST HUMAN. Hard rules:
- Open with the lived experience, not the research. Name a specific moment or feeling the reader will recognise from this article's topic.
- Never promote, sell or recommend a product, supplement or brand. Do not mention ${BRAND.name} as a product.
- Never give individual medical advice or tell the reader what to do about their own condition.
- Any fact or number you use must come from the article. Do not invent statistics, and do not cite a study by name — this style never cites, it reassures.
- Warm, honest, slightly vulnerable in tone, but never flippant about a serious condition.
- Plain English. Expand jargon on first use. No hype, no clickbait, no emoji.
- UK spelling.
- NEVER use em dashes or en dashes. Use a comma, a colon, brackets or a full stop instead.

ARTICLE TITLE: ${title}

ARTICLE CONTENT:
${excerpt}

Return ONLY a JSON object, no commentary, in exactly this shape:

{
  "eyebrow": "2-4 word topic label, e.g. '${categoryHint}'",
  "hookTitle": "The cover headline. MAXIMUM 10 WORDS. A POV or direct-address hook that names a specific moment or feeling — e.g. 'POV: you've cancelled plans again' — not a topic summary.",
  "feeling": {
    "body": "Name the experience in 1-2 short sentences, second person. MAXIMUM 35 WORDS. This is the 'if this sounds familiar' beat — make the reader feel seen before you explain anything."
  },
  "points": [
    {
      "headline": "The single idea of this slide, second person. MAXIMUM 8 WORDS.",
      "body": "What actually helps, or what nobody tells you, grounded in the article. MAXIMUM 30 WORDS."
    }
  ],
  "reassure": {
    "body": "The closing validation, second person, 1-2 short sentences. MAXIMUM 30 WORDS. Land on 'you're not alone' or an equivalent, plus the one thing worth remembering. Never a citation, never advice about the reader's own care."
  },
  "caption": "Instagram caption. 2-4 short paragraphs separated by blank lines, second person, warm and direct. Open with the feeling, summarise what the carousel covers, and close by pointing readers to the full article. MAXIMUM 180 WORDS. No hashtags here.",
  "hashtags": ["5-8 relevant tags, no # prefix, e.g. IBD, Crohns, UlcerativeColitis, GutHealth"]
}

The "points" array must contain EXACTLY ${pointCount} items, each a genuinely different idea — no restating the same feeling.`;
}

/**
 * The "Breaking News" style prompt. A news-bulletin voice — short, punchy,
 * present-tense, leads with what's new — layered on top of the same medical
 * accuracy and no-advice rules every style carries. "Breaking" describes the
 * FORMAT (chyron-style headline, bulletin structure), not permission to
 * invent urgency, risk or a timeline the source doesn't support.
 */
function buildBreakingNewsPrompt({ title, excerpt, category, pointCount }) {
  const categoryHint = categoryLabelFor(category);
  return `You are writing a "Breaking News" style Instagram carousel for ${BRAND.name}'s health platform, Vance Health Hub — a UK gastroenterology and GI health resource covering IBD (Crohn's, ulcerative colitis), IBS, gastrointestinal nutrition and related conditions.

Your audience is scrolling on a phone. This carousel should read like a health news bulletin: urgent, immediate, present tense, as if reporting something that just happened — without ever inventing urgency the source doesn't support.

THIS IS A NEWS BULLETIN, NOT HYPE. Hard rules:
- Frame it like breaking news: short, punchy sentences. Lead with what's new. Use present tense where it reads naturally ("New research shows...", "Scientists have found...").
- "Breaking" describes the FORMAT, not licence to exaggerate. Never invent urgency, risk, or a timeline the source does not support.
- Never promote, sell or recommend a product, supplement or brand. Do not mention ${BRAND.name} as a product.
- Never give individual medical advice or tell the reader what to do about their own condition.
- Report what the source says, with its actual numbers where they exist. Do not inflate, and do not manufacture certainty the source does not have.
- Plain English. Expand jargon on first use. No emoji.
- UK spelling.
- NEVER use em dashes or en dashes. Use a comma, a colon, brackets or a full stop instead.

ARTICLE TITLE: ${title}

ARTICLE CONTENT:
${excerpt}

Return ONLY a JSON object, no commentary, in exactly this shape:

{
  "eyebrow": "2-4 word topic label, e.g. '${categoryHint}'",
  "hookTitle": "The cover headline, written like a breaking-news chyron. MAXIMUM 10 WORDS. State the news itself, not a tease — e.g. 'New Drug Cuts IBD Flares By Half'.",
  "brief": {
    "body": "The one-line bulletin: what happened and why it matters right now. MAXIMUM 35 WORDS, present tense, news-report voice."
  },
  "points": [
    {
      "headline": "The single fact of this slide, news-report style. MAXIMUM 8 WORDS.",
      "body": "The detail, with the source's numbers if it has them. MAXIMUM 30 WORDS."
    }
  ],
  "update": {
    "body": "The closing update: what happens next, or what readers should watch for. MAXIMUM 30 WORDS. Never advice about the reader's own care, never a citation."
  },
  "caption": "Instagram caption, news-bulletin voice. 2-4 short paragraphs separated by blank lines. Open with the headline finding, summarise what the carousel covers, and close by pointing readers to the full article. MAXIMUM 180 WORDS. No hashtags here.",
  "hashtags": ["5-8 relevant tags, no # prefix, e.g. IBD, Crohns, UlcerativeColitis, GutHealth, HealthNews"]
}

The "points" array must contain EXACTLY ${pointCount} items, each a genuinely different fact — no restating the same finding.`;
}

function buildPrompt({ style, ...args }) {
  if (style === 'relatable') return buildRelatablePrompt(args);
  if (style === 'breaking-news') return buildBreakingNewsPrompt(args);
  return buildEducationPrompt(args);
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Generate the slide copy for a carousel from a content record.
 *
 * @param {object} args
 * @param {object} args.article - a `content:{id}` record ({ title, body, category, ... })
 * @param {number} [args.slideCount] - total slides including the 4 fixed ones
 * @param {string} [args.style='education'] - one of CAROUSEL_STYLES above; see
 *   buildEducationPrompt/buildRelatablePrompt/buildBreakingNewsPrompt. Changes
 *   the prompt, and which fields the resulting spec carries: education returns
 *   context/evidence, relatable returns feeling/reassure, breaking-news
 *   returns brief/update — none of the three carry another's fields — see
 *   planSlides in carousel-render.js for how each is turned into slides.
 * @returns {Promise<{spec: object, caption: string, hashtags: string[], slideCount: number}>}
 */
export async function buildCarouselSpec({ article, slideCount = DEFAULT_SLIDE_COUNT, style = 'education' }) {
  if (!article?.title) throw new Error('buildCarouselSpec: article.title is required');

  const pointCount = Math.min(MAX_POINTS, Math.max(MIN_POINTS, slideCount - FIXED_SLIDES));
  const title = article.title;
  // 6000 chars is comfortably inside every model in the fallback chain while
  // still covering the substantive part of a long-form article.
  const excerpt = toPlainText(article.body || article.content || article.excerpt).slice(0, 6000);

  const raw = await callOpenRouter(
    buildPrompt({ style, title, excerpt, category: article.category, pointCount }),
    { source: 'social-carousel' },
  );

  const parsed = extractJson(raw);

  // Enforce the caps rather than trusting them. The layouts are fixed-height, so
  // an overshoot here would overflow the slide frame at render time.
  const points = (Array.isArray(parsed.points) ? parsed.points : [])
    .filter((p) => p && (p.headline || p.body))
    .slice(0, pointCount)
    .map((p) => ({
      headline: clampWords(p.headline, 8),
      body: clampWords(p.body, 30),
    }));

  if (points.length < MIN_POINTS) {
    throw new Error(`Carousel spec has only ${points.length} usable point(s); need at least ${MIN_POINTS}`);
  }

  // `null` from the model can arrive as the string "null" — treat both as absent
  // so the evidence slide degrades to the fields it actually has.
  const field = (v) => {
    const s = String(v ?? '').trim();
    return !s || s.toLowerCase() === 'null' || s.toLowerCase() === 'n/a' ? null : s;
  };

  let styleFields;
  if (style === 'relatable') {
    // Relatable never cites a source — see the prompt's hard rules — so
    // there is no evidence object at all, only the closing reassurance.
    styleFields = {
      feeling: { body: clampWords(parsed.feeling?.body ?? parsed.feeling, 35) },
      reassure: { body: clampWords(parsed.reassure?.body ?? parsed.reassure, 30) },
    };
  } else if (style === 'breaking-news') {
    // Breaking News is also citation-free — a bulletin voice reads worse
    // interrupted by a journal reference than it does without one.
    styleFields = {
      brief: { body: clampWords(parsed.brief?.body ?? parsed.brief, 35) },
      update: { body: clampWords(parsed.update?.body ?? parsed.update, 30) },
    };
  } else {
    styleFields = {
      context: { body: clampWords(parsed.context?.body ?? parsed.context, 35) },
      // Always generated, and the reason the pre-CTA slide is never an empty
      // frame: many articles name no journal, author or year, and a
      // citation-only slide with a lone "n = 4,900" chip on it reads as
      // broken rather than minimal.
      takeaway: clampWords(parsed.takeaway, 30),
      evidence: {
        journal: field(parsed.evidence?.journal),
        authors: field(parsed.evidence?.authors),
        year: field(parsed.evidence?.year),
        studyType: field(parsed.evidence?.studyType),
        sampleSize: field(parsed.evidence?.sampleSize),
      },
    };
  }

  const spec = {
    eyebrow: clampWords(parsed.eyebrow, 4) || categoryLabelFor(article.category),
    hookTitle: clampWords(parsed.hookTitle, 10) || clampWords(title, 10),
    points,
    // Label and note come from FIXED_COPY at render time; only the domain is
    // configurable, so the CTA slide cannot be reworded by a generation.
    cta: { domain: HUB_DOMAIN },
    ...styleFields,
  };

  return {
    spec,
    caption: clampWords(parsed.caption, 180),
    hashtags: normaliseHashtags(parsed.hashtags),
    slideCount: points.length + FIXED_SLIDES,
  };
}

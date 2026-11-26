import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  HERO_VISUAL_APPROACHES,
  HERO_LIFESTYLE_APPROACHES,
  HERO_LIFESTYLE_PHOTO_STYLE,
  pickHeroApproach,
  heroStyleFor,
  buildDirectHeroPrompt,
  DEFAULT_HERO_PROMPT_TEMPLATE,
  HERO_NEUTRAL_LEFT,
  HERO_PHOTO_STYLE,
} from './media.js';

const byId = id => HERO_VISUAL_APPROACHES.find(a => a.id === id);
const count = (s, sub) => s.split(sub).length - 1;

test('pickHeroApproach covers every approach across the random range', () => {
  const total = HERO_VISUAL_APPROACHES.reduce((n, a) => n + a.weight, 0);
  const seen = new Set();
  for (let i = 0; i < total * 10; i++) seen.add(pickHeroApproach(() => i / (total * 10)).id);
  assert.deepEqual([...seen].sort(), HERO_VISUAL_APPROACHES.map(a => a.id).sort());
});

test('pickHeroApproach stays in range at the top edge of rand()', () => {
  assert.ok(pickHeroApproach(() => 0.999999999));
});

test('most approaches exclude people', () => {
  const total = HERO_VISUAL_APPROACHES.reduce((n, a) => n + a.weight, 0);
  const noPeople = HERO_VISUAL_APPROACHES.filter(a => /NO people/.test(a.text)).reduce((n, a) => n + a.weight, 0);
  assert.ok(noPeople / total >= 0.5, `only ${noPeople}/${total} of weight excludes people`);
});

test('every approach is tied to the article subject, with no generic metaphor examples', () => {
  for (const a of HERO_VISUAL_APPROACHES) {
    assert.ok(/article subject/.test(a.text), a.id);
    assert.ok(!/mood of the topic|stone stack|calm horizon|a bridge|a key,|water, linen/i.test(a.text), a.id);
  }
});

test('default template fills {approach} in place and does not append it again', () => {
  const p = buildDirectHeroPrompt('Gut health', undefined, byId('symbolic'));
  assert.ok(DEFAULT_HERO_PROMPT_TEMPLATE.includes('{approach}'));
  assert.ok(!p.includes('{approach}'));
  assert.equal(count(p, byId('symbolic').text), 1);
  assert.ok(!/human-environment/.test(p));
});

test('default template has a plain neutral left side, once, and no gradient', () => {
  const p = buildDirectHeroPrompt('Gut health', undefined, byId('abstract'));
  assert.equal(count(p, HERO_NEUTRAL_LEFT), 1);
  assert.ok(!p.includes('{neutralLeft}'));
  assert.ok(!/navy-to-teal gradient/i.test(p));
});

test('default asks for a full-bleed image with no fade of its own (WordPress adds the fade)', () => {
  for (const a of HERO_VISUAL_APPROACHES) {
    const p = buildDirectHeroPrompt('Gut health', undefined, a);
    assert.ok(/edge to edge/i.test(p) && /No fade/.test(p), p);
    assert.ok(!/RIGHT 60%|LEFT 40%|no objects|fades? softly|neutral tones|layered gradients/i.test(p), p);
  }
});

test('a saved template without {approach} gets the neutral left and approach appended', () => {
  const p = buildDirectHeroPrompt('Gut health', 'Hero image about {topic}.', byId('abstract'));
  assert.equal(p, `Hero image about Gut health. ${HERO_NEUTRAL_LEFT} Visual approach: ${byId('abstract').text} ${HERO_PHOTO_STYLE}`);
});

test('a template with no tokens gets neutral left, subject and approach appended', () => {
  const p = buildDirectHeroPrompt('Gut health', 'Calm image.', byId('human'));
  assert.equal(p, `Calm image. ${HERO_NEUTRAL_LEFT} (Subject: Gut health.) Visual approach: ${byId('human').text} ${HERO_PHOTO_STYLE}`);
});

test('an old saved default has only its navy-to-teal gradient clause swapped, not doubled', () => {
  const old = 'Hero about {topic}. Right-weighted composition; LEFT 40% kept clean with a subtle navy-to-teal gradient for text overlay. Style: calm. {approach}';
  const p = buildDirectHeroPrompt('Gut health', old, byId('abstract'));
  assert.equal(p, `Hero about Gut health. Right-weighted composition; ${HERO_NEUTRAL_LEFT} Style: calm. ${byId('abstract').text} ${HERO_PHOTO_STYLE}`);
});

test('the real old default keeps its RIGHT 60% clause when the gradient is swapped', () => {
  // The default shipped before this change, as saved into KV by the settings page.
  const oldDefault =
    'Professional editorial hero image for a clinical medical article about: {topic}. ' +
    'Visual approach: {approach} ' +
    'Right-weighted composition: all visual elements on the RIGHT 60% of the frame; ' +
    'LEFT 40% kept clean with a subtle navy-to-teal gradient for text overlay. ' +
    'Style: clean modern editorial aesthetic, navy (#0a1929) and teal (#00c9a7) brand palette, widescreen 16:9 cinematic.';
  const p = buildDirectHeroPrompt('Gut health', oldDefault, byId('abstract'));
  assert.ok(p.includes(`all visual elements on the RIGHT 60% of the frame; ${HERO_NEUTRAL_LEFT} Style: clean`), p);
  assert.ok(!/navy-to-teal/i.test(p));
  assert.equal(count(p, HERO_NEUTRAL_LEFT), 1);
});

test('a template that already places {neutralLeft} is not given a second copy', () => {
  const p = buildDirectHeroPrompt('Gut health', '{neutralLeft} Hero about {topic}. {approach}', byId('abstract'));
  assert.equal(p, `${HERO_NEUTRAL_LEFT} Hero about Gut health. ${byId('abstract').text} ${HERO_PHOTO_STYLE}`);
});

test('default fills {photoStyle} once, with no illustration, cinematic or brand-palette wash', () => {
  assert.ok(HERO_PHOTO_STYLE.length > 40);
  for (const a of HERO_VISUAL_APPROACHES) {
    const p = buildDirectHeroPrompt('Gut health', undefined, a);
    assert.equal(count(p, HERO_PHOTO_STYLE), 1, p);
    assert.ok(!p.includes('{photoStyle}'), p);
    assert.ok(!/soft illustration|cinematic|brand palette|silhouette|flowing shapes/i.test(p), p);
  }
});

test('legacy style rewrites never touch a user\'s own wording or the topic', () => {
  const own = 'Hero about {topic}. No 3D renders or soft illustrations. {approach} {photoStyle}';
  const p = buildDirectHeroPrompt('Decor or soft illustration trends', own, byId('symbolic'));
  assert.ok(p.includes('No 3D renders or soft illustrations.'), p);
  assert.ok(p.includes('Hero about Decor or soft illustration trends.'), p);
});

test('the saved pre-photoStyle default loses its illustration, cinematic and palette words', () => {
  // The default shipped in #39, as saved into KV by the settings page.
  const saved =
    'Professional editorial hero image for a clinical medical article about: {topic}. ' +
    'Visual approach: {approach} ' +
    'Right-weighted composition: the main subject on the RIGHT of the frame; ' +
    '{neutralLeft} ' +
    'Style: clean modern editorial aesthetic, professional photography or soft illustration, ' +
    'navy (#0a1929) and teal (#00c9a7) brand palette for the visual elements, soft natural lighting, calm authoritative mood, no people’s faces, ' +
    'widescreen 16:9 cinematic.';
  const p = buildDirectHeroPrompt('Gut health', saved, byId('still-life'));
  assert.ok(p.includes('editorial aesthetic, professional photography, navy (#0a1929) and teal (#00c9a7) only as subtle accents on real objects, soft natural'), p);
  assert.ok(!/soft illustration|cinematic|brand palette/i.test(p), p);
  assert.ok(p.includes('widescreen 16:9.'), p);
  assert.ok(p.endsWith(` ${HERO_PHOTO_STYLE}`), p);
  assert.equal(count(p, HERO_PHOTO_STYLE), 1);
});

const CLINICAL_LOOK = 'Clinical look:';
// The saved clinical-reviews template, copied exactly as it is stored in KV.
const SAVED_CLINICAL_TEMPLATE =
  'Professional photo realistic editorial hero image for a wellness article about the living with a gastro condition article: {topic}. ' +
  'Composition: visual elements (medical imagery, abstract scientific elements, soft patterns). ' +
  'Style: clean modern patient friendly clinical aesthetic, photo-realistic, professional photography, calm authoritative mood, widescreen 16:9 cinematic. ' +
  'STRICTLY NO molecules, chemical structures, atoms, hospitals, doctors, DNA helices, ball-and-stick models, animals, or any cliche "science-y" illustrations. ' +
  'Absolutely no text, words, letters, numbers, labels, captions, watermarks, logos, or typography anywhere in the image.';

test('no approach text puts a kitchen, meal, daily task or home in the photo', () => {
  for (const a of HERO_VISUAL_APPROACHES) {
    // Strip the approach's own "never in a home" style exclusions before checking.
    const positive = a.text.replace(/never (in )?a home( or domestic kitchen)?/gi, '');
    assert.ok(!/kitchen|meal|daily task|\bhome\b/i.test(positive), `${a.id}: ${a.text}`);
  }
});

test('human approach places the figure in a clinical setting, not a home', () => {
  const human = byId('human');
  assert.ok(human.text.includes('in a clinical setting'), human.text);
  assert.ok(human.text.includes('in a clinic, ward or laboratory'), human.text);
});

test('saved clinical-reviews template loses its wellness framing', () => {
  const p = buildDirectHeroPrompt('Gut health', SAVED_CLINICAL_TEMPLATE, byId('abstract'));
  assert.ok(p.includes('for a clinical medical article about: Gut health. Composition:'), p);
  assert.ok(!/wellness/i.test(p), p);
});

test('saved clinical-reviews template loses patient friendly wording', () => {
  const p = buildDirectHeroPrompt('Gut health', SAVED_CLINICAL_TEMPLATE, byId('abstract'));
  assert.ok(!/patient[- ]friendly/i.test(p), p);
});

test('saved clinical-reviews template does not double the word clinical', () => {
  const p = buildDirectHeroPrompt('Gut health', SAVED_CLINICAL_TEMPLATE, byId('abstract'));
  assert.ok(!/clinical clinical/i.test(p), p);
});

test('saved clinical-reviews template gets the Clinical look sentence exactly once', () => {
  const p = buildDirectHeroPrompt('Gut health', SAVED_CLINICAL_TEMPLATE, byId('abstract'));
  assert.equal(count(p, CLINICAL_LOOK), 1, p);
});

test('default template contains the Clinical look sentence exactly once', () => {
  const p = buildDirectHeroPrompt('Gut health', undefined, byId('human'));
  assert.equal(count(p, CLINICAL_LOOK), 1, p);
});

test('template with its own {photoStyle} token gets the Clinical look sentence once', () => {
  const own = 'Clinical hero about {topic}. Style: {photoStyle} {approach}';
  const p = buildDirectHeroPrompt('Gut health', own, byId('abstract'));
  assert.equal(p, `Clinical hero about Gut health. Style: ${HERO_PHOTO_STYLE} ${byId('abstract').text} ${HERO_NEUTRAL_LEFT}`);
  assert.equal(count(p, CLINICAL_LOOK), 1, p);
});

const INDEX_HTML = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');

test('index.html mirror contains every approach text that media.js exports', () => {
  for (const a of HERO_VISUAL_APPROACHES) {
    assert.ok(INDEX_HTML.includes(a.text), `index.html is missing the ${a.id} approach text`);
  }
});

test('index.html mirror keeps the Clinical look sentence key phrases', () => {
  assert.ok(INDEX_HTML.includes(CLINICAL_LOOK), 'index.html lost "Clinical look:"');
  assert.ok(INDEX_HTML.includes('Not cosy or domestic'), 'index.html lost "Not cosy or domestic"');
  assert.ok(INDEX_HTML.includes('candles or warm golden light.'), 'index.html lost "candles or warm golden light."');
});

test('media.js exports keep the Clinical look sentence key phrases', () => {
  assert.ok(HERO_PHOTO_STYLE.includes(CLINICAL_LOOK), 'media.js lost "Clinical look:"');
  assert.ok(HERO_PHOTO_STYLE.includes('Not cosy or domestic'), 'media.js lost "Not cosy or domestic"');
  assert.ok(HERO_PHOTO_STYLE.includes('candles or warm golden light.'), 'media.js lost "candles or warm golden light."');
});

test('drift phrases appear in both media.js exports and index.html', () => {
  const exported = HERO_VISUAL_APPROACHES.map(a => a.text).join(' ') + ' ' + HERO_PHOTO_STYLE;
  for (const phrase of ['never in a home', 'never a home or domestic kitchen', 'clean white or pale grey surface', 'Not cosy or domestic']) {
    assert.ok(exported.includes(phrase), `media.js lost "${phrase}"`);
    assert.ok(INDEX_HTML.includes(phrase), `index.html lost "${phrase}"`);
  }
});

test('a comma between patient-friendly and clinical does not double the word', () => {
  const p = buildDirectHeroPrompt('Gut health', 'Style: patient-friendly, clinical aesthetic. {topic}', byId('abstract'));
  assert.ok(!/clinical,\s*clinical/i.test(p), p);
  assert.ok(!/patient[- ]friendly/i.test(p), p);
});

test('the clinical approaches are not contradicted by old bans on hospitals, doctors or lab glassware', () => {
  const saved = 'Hero for: {topic}. STRICTLY NO molecules, chemical structures, atoms, hospitals, doctors, DNA helices, ball-and-stick models.';
  const fromSaved = buildDirectHeroPrompt('Gut health', saved, byId('symbolic'));
  assert.ok(!/hospitals|doctors/i.test(fromSaved.replace(byId('symbolic').text, '')), fromSaved);
  const fromDefault = buildDirectHeroPrompt('Gut health', undefined, byId('symbolic'));
  assert.ok(!/lab-glassware close-ups/i.test(fromDefault), fromDefault);
  assert.ok(/laboratory glassware as the main subject/.test(fromDefault));
});

// ── Per-category style: Gastro Living (ibd-living) is lifestyle, every other category is clinical ──

const lifestyleById = id => HERO_LIFESTYLE_APPROACHES.find(a => a.id === id);
// The saved Gastro Living style template, copied exactly as it is stored in KV.
const GASTRO_LIVING_TEMPLATE =
  'Professional photo realistic editorial hero image for a wellness article about the living with a gastro condition article: {topic}. ' +
  'Composition: visual elements (wellness imagery, abstract positive outcome elements). ' +
  'Style: clean modern health and wellness aesthetic, photo-realistic, vibrant authoritative mood, widescreen 16:9 cinematic. ' +
  'STRICTLY NO molecules, chemical structures, atoms, hospitals, doctors, DNA helices, ball-and-stick models, animals, or any cliche "science-y" illustrations. ' +
  'Absolutely no text, words, letters, numbers, labels, captions, watermarks, logos, or typography anywhere in the image.';

test('heroStyleFor gives ibd-living the lifestyle profile', () => {
  const style = heroStyleFor('ibd-living');
  assert.equal(style.id, 'lifestyle');
  assert.equal(style.approaches, HERO_LIFESTYLE_APPROACHES);
  assert.equal(style.photoStyle, HERO_LIFESTYLE_PHOTO_STYLE);
  assert.equal(style.clinicalRewrites, false);
});

test('heroStyleFor gives clinical-reviews the clinical profile', () => {
  const style = heroStyleFor('clinical-reviews');
  assert.equal(style.id, 'clinical');
  assert.equal(style.approaches, HERO_VISUAL_APPROACHES);
  assert.equal(style.photoStyle, HERO_PHOTO_STYLE);
  assert.equal(style.clinicalRewrites, true);
});

test('heroStyleFor gives industry-news the clinical profile', () => {
  assert.equal(heroStyleFor('industry-news').id, 'clinical');
});

test('heroStyleFor gives op-eds the clinical profile', () => {
  assert.equal(heroStyleFor('op-eds').id, 'clinical');
});

test('heroStyleFor gives white-papers the clinical profile', () => {
  assert.equal(heroStyleFor('white-papers').id, 'clinical');
});

test('heroStyleFor gives infographics the clinical profile', () => {
  assert.equal(heroStyleFor('infographics').id, 'clinical');
});

test('heroStyleFor gives an undefined category the clinical profile', () => {
  assert.equal(heroStyleFor(undefined).id, 'clinical');
});

test('heroStyleFor gives an empty category the clinical profile', () => {
  assert.equal(heroStyleFor('').id, 'clinical');
});

test('ibd-living keeps the wellness article wording of its saved template', () => {
  const p = buildDirectHeroPrompt('Gut health', GASTRO_LIVING_TEMPLATE, byId('abstract'), 'ibd-living');
  assert.ok(p.includes('for a wellness article about the living with a gastro condition article: Gut health.'), p);
});

test('ibd-living keeps the ban on hospitals and doctors', () => {
  const p = buildDirectHeroPrompt('Gut health', GASTRO_LIVING_TEMPLATE, byId('abstract'), 'ibd-living');
  assert.ok(p.includes('atoms, hospitals, doctors, DNA helices'), p);
});

test('ibd-living prompt has no Clinical look sentence', () => {
  const p = buildDirectHeroPrompt('Gut health', GASTRO_LIVING_TEMPLATE, byId('abstract'), 'ibd-living');
  assert.ok(!p.includes('Clinical look'), p);
});

test('ibd-living prompt gets the lifestyle photo style exactly once', () => {
  const p = buildDirectHeroPrompt('Gut health', GASTRO_LIVING_TEMPLATE, byId('abstract'), 'ibd-living');
  assert.equal(count(p, HERO_LIFESTYLE_PHOTO_STYLE), 1, p);
});

test('clinical-reviews template loses its wellness article wording', () => {
  const p = buildDirectHeroPrompt('Gut health', GASTRO_LIVING_TEMPLATE, byId('abstract'), 'clinical-reviews');
  assert.ok(p.includes('for a clinical medical article about: Gut health.'), p);
  assert.ok(!p.includes('wellness article'), p);
});

test('clinical-reviews prompt gets the Clinical look sentence exactly once', () => {
  const p = buildDirectHeroPrompt('Gut health', GASTRO_LIVING_TEMPLATE, byId('abstract'), 'clinical-reviews');
  assert.equal(count(p, CLINICAL_LOOK), 1, p);
});

test('clinical-reviews prompt gets the clinical photo style once and not the lifestyle one', () => {
  const p = buildDirectHeroPrompt('Gut health', GASTRO_LIVING_TEMPLATE, byId('abstract'), 'clinical-reviews');
  assert.equal(count(p, HERO_PHOTO_STYLE), 1, p);
  assert.ok(!p.includes(HERO_LIFESTYLE_PHOTO_STYLE), p);
});

test('an undefined category builds the same prompt as clinical-reviews', () => {
  const none = buildDirectHeroPrompt('Gut health', GASTRO_LIVING_TEMPLATE, byId('abstract'), undefined);
  const clinical = buildDirectHeroPrompt('Gut health', GASTRO_LIVING_TEMPLATE, byId('abstract'), 'clinical-reviews');
  assert.equal(count(none, CLINICAL_LOOK), 1, none);
  assert.equal(none, clinical);
});

test('ibd-living with no approach picks the lifestyle human approach', t => {
  t.mock.method(Math, 'random', () => 0.3);
  const p = buildDirectHeroPrompt('Gut health', GASTRO_LIVING_TEMPLATE, undefined, 'ibd-living');
  assert.ok(p.includes(lifestyleById('human').text), p);
  assert.ok(!p.includes(byId('human').text), p);
});

test('clinical category with no approach picks the clinical abstract approach', t => {
  t.mock.method(Math, 'random', () => 0.3);
  const p = buildDirectHeroPrompt('Gut health', GASTRO_LIVING_TEMPLATE, undefined, 'clinical-reviews');
  assert.ok(p.includes(byId('abstract').text), p);
  assert.ok(!p.includes(lifestyleById('abstract').text), p);
});

test('lifestyle human approach keeps the meal, test, treatment, symptom or daily task wording', () => {
  assert.ok(lifestyleById('human').text.includes('the meal, test, treatment, symptom or daily task'));
});

test('lifestyle symbolic approach keeps the kitchen table for a diet topic setting', () => {
  assert.ok(lifestyleById('symbolic').text.includes('a kitchen table for a diet topic'));
});

test('lifestyle still-life approach keeps natural window light', () => {
  assert.ok(lifestyleById('still-life').text.includes('natural window light'));
});

test('lifestyle photo style keeps the original natural light wording and no Clinical look', () => {
  assert.ok(HERO_LIFESTYLE_PHOTO_STYLE.includes('in natural light'));
  assert.ok(!HERO_LIFESTYLE_PHOTO_STYLE.includes('Clinical look'));
});

test('index.html mirror contains the lifestyle human approach text', () => {
  assert.ok(INDEX_HTML.includes(lifestyleById('human').text), 'index.html is missing the lifestyle human approach text');
});

test('index.html mirror contains the lifestyle abstract approach text', () => {
  assert.ok(INDEX_HTML.includes(lifestyleById('abstract').text), 'index.html is missing the lifestyle abstract approach text');
});

test('index.html mirror contains the lifestyle symbolic approach text', () => {
  assert.ok(INDEX_HTML.includes(lifestyleById('symbolic').text), 'index.html is missing the lifestyle symbolic approach text');
});

test('index.html mirror contains the lifestyle still-life approach text', () => {
  assert.ok(INDEX_HTML.includes(lifestyleById('still-life').text), 'index.html is missing the lifestyle still-life approach text');
});

test('index.html mirror keeps the lifestyle key phrases', () => {
  assert.ok(INDEX_HTML.includes('a kitchen table for a diet topic'), 'index.html lost "a kitchen table for a diet topic"');
  assert.ok(INDEX_HTML.includes('the meal, test, treatment, symptom or daily task'), 'index.html lost the meal, test, treatment wording');
  assert.ok(INDEX_HTML.includes('natural window light'), 'index.html lost "natural window light"');
  assert.ok(INDEX_HTML.includes('lens in natural light, '), 'index.html lost the lifestyle photo style wording');
});

test('index.html selects the style profile with heroStyleFor(catId) at the prompt call site', () => {
  assert.ok(INDEX_HTML.includes('var style = heroStyleFor(catId);'), 'index.html does not call heroStyleFor(catId) in getResolvedHeroPrompt');
});

test('index.html keys the lifestyle profile on catId === ibd-living', () => {
  assert.ok(INDEX_HTML.includes("catId === 'ibd-living'"), 'index.html lost the ibd-living lifestyle check');
});

const RUN_JS = readFileSync(fileURLToPath(new URL('../automation/handlers/run.js', import.meta.url)), 'utf8');

test('run.js passes the rule category to generateImageFast', () => {
  assert.ok(
    RUN_JS.includes("generateImageFast(generated.title, '16:9', heroPromptTemplate, rule.category)"),
    'run.js does not pass rule.category to generateImageFast',
  );
});

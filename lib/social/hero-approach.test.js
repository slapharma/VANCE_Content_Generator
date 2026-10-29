import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HERO_VISUAL_APPROACHES,
  pickHeroApproach,
  buildDirectHeroPrompt,
  DEFAULT_HERO_PROMPT_TEMPLATE,
  HERO_NEUTRAL_LEFT,
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

test('default asks for a soft fade into the left, not a split with an empty panel', () => {
  const p = buildDirectHeroPrompt('Gut health', undefined, byId('human'));
  assert.ok(/no hard edge/i.test(p) && /no vertical seam/i.test(p), p);
  assert.ok(!/RIGHT 60%|LEFT 40%|no objects/i.test(p), p);
});

test('a saved template without {approach} gets the neutral left and approach appended', () => {
  const p = buildDirectHeroPrompt('Gut health', 'Hero image about {topic}.', byId('abstract'));
  assert.equal(p, `Hero image about Gut health. ${HERO_NEUTRAL_LEFT} Visual approach: ${byId('abstract').text}`);
});

test('a template with no tokens gets neutral left, subject and approach appended', () => {
  const p = buildDirectHeroPrompt('Gut health', 'Calm image.', byId('human'));
  assert.equal(p, `Calm image. ${HERO_NEUTRAL_LEFT} (Subject: Gut health.) Visual approach: ${byId('human').text}`);
});

test('an old saved default has only its navy-to-teal gradient clause swapped, not doubled', () => {
  const old = 'Hero about {topic}. Right-weighted composition; LEFT 40% kept clean with a subtle navy-to-teal gradient for text overlay. Style: calm. {approach}';
  const p = buildDirectHeroPrompt('Gut health', old, byId('abstract'));
  assert.equal(p, `Hero about Gut health. Right-weighted composition; ${HERO_NEUTRAL_LEFT} Style: calm. ${byId('abstract').text}`);
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
  assert.equal(p, `${HERO_NEUTRAL_LEFT} Hero about Gut health. ${byId('abstract').text}`);
});

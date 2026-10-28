import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HERO_VISUAL_APPROACHES,
  pickHeroApproach,
  buildDirectHeroPrompt,
  DEFAULT_HERO_PROMPT_TEMPLATE,
} from './media.js';

const byId = id => HERO_VISUAL_APPROACHES.find(a => a.id === id);

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
  assert.equal(p.split(byId('symbolic').text).length - 1, 1);
  assert.ok(!/human-environment/.test(p));
});

test('a saved template without {approach} gets the approach appended', () => {
  const p = buildDirectHeroPrompt('Gut health', 'Hero image about {topic}.', byId('abstract'));
  assert.equal(p, `Hero image about Gut health. Visual approach: ${byId('abstract').text}`);
});

test('a template with no tokens gets subject and approach appended', () => {
  const p = buildDirectHeroPrompt('Gut health', 'Calm image.', byId('human'));
  assert.equal(p, `Calm image. (Subject: Gut health.) Visual approach: ${byId('human').text}`);
});

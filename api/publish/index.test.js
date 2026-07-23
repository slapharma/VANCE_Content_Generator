import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWpPayload } from './index.js';

test('buildWpPayload maps known category', () => {
  const item = { title: 'Test', body: 'Body', excerpt: 'Short', category: 'industry-news' };
  const payload = buildWpPayload(item, [5]);
  assert.equal(payload.title, 'Test');
  assert.deepEqual(payload.categories, [5]);
  assert.equal(payload.status, 'publish');
});

test('buildWpPayload uses empty categories when none resolved', () => {
  const item = { title: 'x', body: 'y', excerpt: '', category: 'unknown' };
  const payload = buildWpPayload(item, []);
  assert.deepEqual(payload.categories, []);
});

test('buildWpPayload wraps the opening paragraph in a blockquote for prose articles', () => {
  const body = [
    '# How diet affects IBD',
    'Your gut responds differently during a flare.',
    '## What is a flare?',
    'A flare is active inflammation.',
  ].join('\n');
  const item = { title: 'How diet affects IBD', body, excerpt: '', category: 'ibd-living' };
  const { content } = buildWpPayload(item, [5]);
  // Opening paragraph becomes a blockquote, matching the manual house style.
  assert.match(content, /<blockquote><p>Your gut responds differently during a flare\.<\/p><\/blockquote>/);
  // Body paragraphs after the first section stay plain <p>.
  assert.match(content, /<p>A flare is active inflammation\.<\/p>/);
  // Exactly one blockquote — only the opening paragraph is wrapped.
  assert.equal((content.match(/<blockquote>/g) || []).length, 1);
});

test('buildWpPayload does not blockquote the clinical-review subheader', () => {
  const body = [
    '# Clinical Review: Drug X in ulcerative colitis',
    'Smith J, et al. Lancet. 2024;403:1.',
    '## Background & Rationale',
    'UC needs better therapies.',
  ].join('\n');
  const item = { title: 'Clinical Review: Drug X', body, excerpt: '', category: 'clinical-reviews' };
  const { content } = buildWpPayload(item, [5]);
  assert.doesNotMatch(content, /<blockquote>/);
  assert.match(content, /<p>Smith J, et al\. Lancet\. 2024;403:1\.<\/p>/);
});

test('buildWpPayload does not blockquote a body paragraph when there is no opening paragraph', () => {
  const body = ['# Title', '## Section', 'First body sentence.'].join('\n');
  const item = { title: 'Title', body, excerpt: '', category: 'op-eds' };
  const { content } = buildWpPayload(item, [5]);
  assert.doesNotMatch(content, /<blockquote>/);
  assert.match(content, /<p>First body sentence\.<\/p>/);
});

test('buildWpPayload collapses a markdown pipe table into the styled fact-box list', () => {
  const body = [
    '# Clinical Review: Drug X in ulcerative colitis',
    'Smith J, et al. Lancet. 2024;403:1.',
    '## Study at a glance',
    '| **Category** | **Details** |',
    '|---|---|',
    '| **Study type** | Consensus statement |',
    '| **Participants** | 82 adults with IBD |',
    '## Why was this study done?',
    'Because it matters.',
  ].join('\n');
  const item = { title: 'Clinical Review: Drug X', body, excerpt: '', category: 'clinical-reviews' };
  const { content } = buildWpPayload(item, [5]);
  // No leaked markdown-table syntax anywhere in the output.
  assert.doesNotMatch(content, /\|/);
  // Collapsed into the same boxed <ul> a bullet list would produce for this heading.
  assert.match(content, /<ul style="list-style:none[^"]*">/);
  assert.match(content, /<li><strong>Study type:<\/strong> Consensus statement<\/li>/);
  assert.match(content, /<li><strong>Participants:<\/strong> 82 adults with IBD<\/li>/);
  // The header/separator rows were dropped, not turned into bogus list items.
  assert.doesNotMatch(content, /Category/);
});

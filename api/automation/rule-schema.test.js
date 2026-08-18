import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRule, validateRule } from './rule-schema.js';

test('buildRule sets defaults', () => {
  const rule = buildRule({
    name: 'Test Rule',
    category: 'clinical-reviews',
    sources: [{ type: 'rss', url: 'https://example.com/feed' }],
    trigger: { type: 'schedule', cron: '0 7 * * 1' },
  });
  assert.match(rule.id, /^rule_/);
  assert.match(rule.id, /^rule_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(rule.enabled, true);
  assert.equal(rule.review.required, true);
  assert.equal(rule.review.timeoutHours, 48);
  // Default is 'urgent_reminder', not 'approve': auto-approving on timeout
  // silently published any article nobody got round to reviewing.
  assert.equal(rule.review.onTimeout, 'urgent_reminder');
  assert.equal(rule.generation.maxArticlesPerRun, 3);
  assert.equal(rule.stats.totalRuns, 0);
  assert.ok(rule.createdAt);
});

test('validateRule throws on missing name', () => {
  assert.throws(
    () => validateRule({ category: 'x', sources: [{}], trigger: { type: 'schedule' } }),
    /name is required/
  );
});

test('validateRule throws on missing category', () => {
  assert.throws(
    () => validateRule({ name: 'x', sources: [{}], trigger: { type: 'schedule' } }),
    /category is required/
  );
});

test('validateRule throws on empty sources', () => {
  assert.throws(
    () => validateRule({ name: 'x', category: 'x', sources: [], trigger: { type: 'schedule' } }),
    /at least one source is required/
  );
});

test('validateRule throws on invalid trigger type', () => {
  assert.throws(
    () => validateRule({ name: 'x', category: 'x', sources: [{}], trigger: { type: 'bad' } }),
    /trigger.type must be schedule, event, or volume/
  );
});

test('validateRule throws on missing cron for schedule trigger', () => {
  assert.throws(
    () => validateRule({ name: 'x', category: 'x', sources: [{}], trigger: { type: 'schedule' } }),
    { message: 'trigger.cron is required for schedule triggers' }
  );
});

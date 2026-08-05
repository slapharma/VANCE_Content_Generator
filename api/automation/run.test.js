import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCron, isRuleDue, mentionsAnimals } from '../../lib/automation/handlers/run.js';

// ── 1-3. evaluateCron ─────────────────────────────────────────────────────────

describe('evaluateCron', () => {
  it('returns true when cron was due since lastRunAt', () => {
    // Daily at midnight UTC. lastRunAt yesterday, now is today 01:00 UTC
    const now       = '2024-06-15T01:00:00.000Z'; // after midnight on Jun 15
    const lastRunAt = '2024-06-14T00:30:00.000Z'; // last ran Jun 14
    const result = evaluateCron('0 0 * * *', lastRunAt, now);
    assert.equal(result, true);
  });

  it('returns false when cron was NOT due since lastRunAt', () => {
    // Daily at midnight UTC. lastRunAt was AFTER midnight today, so no new tick yet
    const now       = '2024-06-15T00:30:00.000Z'; // 30 min after midnight
    const lastRunAt = '2024-06-15T00:10:00.000Z'; // ran 10 min after midnight — after the tick
    const result = evaluateCron('0 0 * * *', lastRunAt, now);
    assert.equal(result, false);
  });

  it('returns false for invalid cron expression', () => {
    const result = evaluateCron('not-a-cron', null, '2024-06-15T01:00:00.000Z');
    assert.equal(result, false);
  });
});

// ── 4-7. isRuleDue ────────────────────────────────────────────────────────────

describe('isRuleDue', () => {
  it('returns true for enabled schedule rule that is due', () => {
    const now = '2024-06-15T01:00:00.000Z';
    const rule = {
      enabled: true,
      trigger: { type: 'schedule', cron: '0 0 * * *' },
      lastRunAt: '2024-06-14T00:30:00.000Z',
    };
    assert.equal(isRuleDue(rule, now), true);
  });

  it('returns false for disabled rule', () => {
    const now = '2024-06-15T01:00:00.000Z';
    const rule = {
      enabled: false,
      trigger: { type: 'schedule', cron: '0 0 * * *' },
      lastRunAt: '2024-06-14T00:30:00.000Z',
    };
    assert.equal(isRuleDue(rule, now), false);
  });

  it('returns true for event-driven rule past minGapHours', () => {
    // lastRunAt 5 hours ago, minGapHours is 4 — should be due
    const now       = '2024-06-15T10:00:00.000Z';
    const lastRunAt = '2024-06-15T05:00:00.000Z'; // 5 hours ago
    const rule = {
      enabled: true,
      trigger: { type: 'event', minGapHours: 4 },
      lastRunAt,
    };
    assert.equal(isRuleDue(rule, now), true);
  });

  it('returns false for event-driven rule within minGapHours', () => {
    // lastRunAt 2 hours ago, minGapHours is 4 — not yet due
    const now       = '2024-06-15T10:00:00.000Z';
    const lastRunAt = '2024-06-15T08:00:00.000Z'; // 2 hours ago
    const rule = {
      enabled: true,
      trigger: { type: 'event', minGapHours: 4 },
      lastRunAt,
    };
    assert.equal(isRuleDue(rule, now), false);
  });
});

// ── mentionsAnimals (Industry News animal-story exclusion) ────────────────────

describe('mentionsAnimals', () => {
  it('flags a title mentioning a lab animal', () => {
    assert.equal(mentionsAnimals({ title: 'New IBD drug shows promise in mice trial' }), true);
  });

  it('flags source body text even when the title is clean', () => {
    assert.equal(mentionsAnimals({
      title: 'Breakthrough therapy for Crohn\'s disease',
      rawText: 'The murine model demonstrated reduced inflammation across all rodent cohorts.',
    }), true);
  });

  it('flags feed description text', () => {
    assert.equal(mentionsAnimals({
      title: 'New findings published',
      feedDescription: 'Researchers studied the effect in a canine model before human trials.',
    }), true);
  });

  it('does not flag ordinary human clinical news', () => {
    assert.equal(mentionsAnimals({
      title: 'Phase 3 trial shows ulcerative colitis remission gains',
      rawText: 'Patients receiving the biologic showed significant improvement over 52 weeks.',
    }), false);
  });

  it('does not false-positive on unrelated substrings', () => {
    // "cats" as a substring of "indicates" should not match with word boundaries
    assert.equal(mentionsAnimals({ title: 'Study indicates biomarker link to flare risk' }), false);
  });
});

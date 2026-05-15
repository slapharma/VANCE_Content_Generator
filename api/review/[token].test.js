import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeNewStatus } from './[token].js';

test('any-approval: first approval sets approved', () => {
  const item = { requireAllApprovals: false, reviewers: ['r1','r2'], approvals: ['r1'], rejections: [] };
  assert.equal(computeNewStatus(item), 'approved');
});

test('all-approval: partial stays in_review', () => {
  const item = { requireAllApprovals: true, reviewers: ['r1','r2'], approvals: ['r1'], rejections: [] };
  assert.equal(computeNewStatus(item), 'in_review');
});

test('all-approval: all approved sets approved', () => {
  const item = { requireAllApprovals: true, reviewers: ['r1','r2'], approvals: ['r1','r2'], rejections: [] };
  assert.equal(computeNewStatus(item), 'approved');
});

test('rejection alone does NOT terminate review — stays in_review until approvals arrive', () => {
  const item = { requireAllApprovals: false, reviewers: ['r1','r2'], approvals: [], rejections: ['r1'] };
  assert.equal(computeNewStatus(item), 'in_review');
});

test('rejection + later approval transitions to approved (any-mode)', () => {
  const item = { requireAllApprovals: false, reviewers: ['r1','r2'], approvals: ['r2'], rejections: ['r1'] };
  assert.equal(computeNewStatus(item), 'approved');
});

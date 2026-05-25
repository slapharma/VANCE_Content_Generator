import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildReviewer, validateReviewer } from './index.js';

test('buildReviewer creates reviewer with id', () => {
  const r = buildReviewer({ name: 'Alice', email: 'alice@vancehealthhub.co.uk' });
  assert.ok(r.id);
  assert.equal(r.email, 'alice@vancehealthhub.co.uk');
});

test('validateReviewer rejects missing email', () => {
  assert.throws(() => validateReviewer({ name: 'Alice' }), /email/i);
});

test('validateReviewer rejects invalid email', () => {
  assert.throws(() => validateReviewer({ name: 'Alice', email: 'notanemail' }), /email/i);
});

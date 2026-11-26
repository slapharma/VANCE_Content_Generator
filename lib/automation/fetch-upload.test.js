import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSources } from './fetch.js';

const noNetwork = () => { throw new Error('no network expected'); };
const titlesOf = r => (Array.isArray(r) ? r : r.items).map(i => i.title);

test('upload source: titles that failed the paper lookup go to the back of the queue', async () => {
  // Arrange
  const source = { type: 'upload', titlesOnly: ['A', 'B', 'C', 'D'], failedTitles: ['A', 'B'] };

  // Act
  const out = await fetchSources([source], null, noNetwork);

  // Assert
  assert.deepEqual(titlesOf(out), ['C', 'D', 'A', 'B']);
});

test('upload source: structured rows with a failed title also go to the back', async () => {
  // Arrange
  const source = { type: 'upload', rows: [{ title: 'A' }, { title: 'B' }, { title: 'C' }], failedTitles: ['A'] };

  // Act
  const out = await fetchSources([source], null, noNetwork);

  // Assert
  assert.deepEqual(titlesOf(out), ['B', 'C', 'A']);
});

test('upload source: with no failed titles the order is unchanged', async () => {
  // Arrange
  const source = { type: 'upload', titlesOnly: ['A', 'B', 'C'] };

  // Act
  const out = await fetchSources([source], null, noNetwork);

  // Assert
  assert.deepEqual(titlesOf(out), ['A', 'B', 'C']);
});

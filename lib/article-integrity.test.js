import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkArticleIntegrity, buildSourceGuard, firstSurname } from './article-integrity.js';

const DOI = '10.1016/j.test.2024.01.002';
const PAPER = { doi: DOI, authors: ['Karłowicz K', 'Smith J'], pmid: '1' };

// A clean article: names the first author, carries the DOI, has no placeholder.
const CLEAN_BODY = `The trial by Karłowicz and colleagues [1] enrolled 120 adults.\n\nReference: Karłowicz K, Smith J. Journal of Test Medicine. 2024;12(4):101-115. doi:${DOI}`;

// ── checkArticleIntegrity: placeholders ─────────────────────────────────────

test('checkArticleIntegrity returns no problems for a clean article with no source paper', () => {
  assert.deepEqual(checkArticleIntegrity('A plain article about gut health.', null), []);
});

test('checkArticleIntegrity returns no problems for a clean bibliography article', () => {
  assert.deepEqual(checkArticleIntegrity(CLEAN_BODY, PAPER), []);
});

test('checkArticleIntegrity catches the bracketed citation placeholder', () => {
  // Arrange
  const body = 'Reference: [Journal name, year, volume, pages as published].';

  // Act
  const problems = checkArticleIntegrity(body, null);

  // Assert
  assert.deepEqual(problems, [
    'placeholder text left in the article: "[Journal name, year, volume, pages as published]"',
  ]);
});

test('checkArticleIntegrity catches an [insert DOI] placeholder', () => {
  // Arrange
  const body = 'doi: [insert DOI]';

  // Act
  const problems = checkArticleIntegrity(body, null);

  // Assert
  assert.deepEqual(problems, ['placeholder text left in the article: "[insert DOI]"']);
});

test('checkArticleIntegrity catches TBC written as a bare word', () => {
  // Arrange
  const body = 'Volume TBC and pages unknown.';

  // Act
  const problems = checkArticleIntegrity(body, null);

  // Assert
  assert.deepEqual(problems, ['placeholder text left in the article: "TBC"']);
});

test('checkArticleIntegrity does not flag a markdown link whose text names a journal', () => {
  // Arrange
  const body = 'Read the original in [Journal of Test Medicine](https://example.com/article).';

  // Act
  const problems = checkArticleIntegrity(body, null);

  // Assert
  assert.deepEqual(problems, []);
});

test('checkArticleIntegrity does not flag a numbered citation marker', () => {
  assert.deepEqual(checkArticleIntegrity('Shown in earlier work [1].', null), []);
});

test('checkArticleIntegrity does not flag the word year outside brackets', () => {
  assert.deepEqual(checkArticleIntegrity('The year 2024 trial ran long.', null), []);
});

// ── checkArticleIntegrity: source paper checks ──────────────────────────────

test('checkArticleIntegrity reports a missing DOI for a bibliography paper', () => {
  // Arrange
  const body = 'Karłowicz K, Smith J. Journal of Test Medicine. 2024;12(4):101-115.';

  // Act
  const problems = checkArticleIntegrity(body, PAPER);

  // Assert
  assert.deepEqual(problems, [`the reference does not carry the source paper's DOI (${DOI})`]);
});

test('checkArticleIntegrity matches the DOI regardless of letter case', () => {
  // Arrange
  const body = 'Karłowicz K. doi: 10.1016/J.TEST.2024.01.002';

  // Act
  const problems = checkArticleIntegrity(body, PAPER);

  // Assert
  assert.deepEqual(problems, []);
});

test('checkArticleIntegrity reports a missing first author for a bibliography paper', () => {
  // Arrange
  const body = `Jones A, et al. doi:${DOI}`;

  // Act
  const problems = checkArticleIntegrity(body, PAPER);

  // Assert
  assert.deepEqual(problems, ["the reference does not name the source paper's first author (Karłowicz)"]);
});

test('checkArticleIntegrity treats Karlowicz in the article as matching Karłowicz in the record', () => {
  // Arrange
  const body = `Karlowicz K. doi:${DOI}`;

  // Act
  const problems = checkArticleIntegrity(body, PAPER);

  // Assert
  assert.deepEqual(problems, []);
});

test('checkArticleIntegrity treats Karłowicz in the article as matching Karlowicz in the record', () => {
  // Arrange
  const body = `Karłowicz K. doi:${DOI}`;
  const paper = { doi: DOI, authors: ['Karlowicz K'], pmid: '1' };

  // Act
  const problems = checkArticleIntegrity(body, paper);

  // Assert
  assert.deepEqual(problems, []);
});

test('checkArticleIntegrity treats Muller in the article as matching Müller in the record', () => {
  // Arrange
  const body = `Muller A. doi:${DOI}`;
  const paper = { doi: DOI, authors: ['Müller A'], pmid: '1' };

  // Act
  const problems = checkArticleIntegrity(body, paper);

  // Assert
  assert.deepEqual(problems, []);
});

test('checkArticleIntegrity reports both a missing DOI and a missing author, in that order', () => {
  // Arrange
  const body = 'A plain article with no citation at all.';

  // Act
  const problems = checkArticleIntegrity(body, PAPER);

  // Assert
  assert.deepEqual(problems, [
    `the reference does not carry the source paper's DOI (${DOI})`,
    "the reference does not name the source paper's first author (Karłowicz)",
  ]);
});

test('checkArticleIntegrity treats a missing body as empty text', () => {
  // Act
  const problems = checkArticleIntegrity(null, PAPER);

  // Assert
  assert.equal(problems.length, 2);
});

test('checkArticleIntegrity does not pass a short surname just because common letters appear in the text', () => {
  // Arrange
  const body = `A clinical trial of 40 adults. doi:${DOI}`;
  const paper = { doi: DOI, authors: ['Li W'], pmid: '1' };

  // Act
  const problems = checkArticleIntegrity(body, paper);

  // Assert
  assert.deepEqual(problems, ["the reference does not name the source paper's first author (Li)"]);
});

// ── firstSurname ────────────────────────────────────────────────────────────

test('firstSurname reads the first surname from a comma-separated author string', () => {
  assert.equal(firstSurname('Karłowicz K, Smith J'), 'Karłowicz');
});

test('firstSurname returns an empty string for no authors', () => {
  assert.equal(firstSurname([]), '');
  assert.equal(firstSurname(undefined), '');
});

// ── buildSourceGuard ────────────────────────────────────────────────────────

test('buildSourceGuard wraps the rules in source-rule markers', () => {
  const guard = buildSourceGuard({ sourceHasFullText: true });
  assert.ok(guard.includes('=== SOURCE RULES'));
  assert.ok(guard.includes('=== END SOURCE RULES ==='));
});

test('buildSourceGuard tells the model to build the reference from the CITATION RECORD only', () => {
  const guard = buildSourceGuard({ sourceHasFullText: true });
  assert.ok(guard.includes('CITATION RECORD'));
  assert.ok(guard.includes('Never write a citation from memory.'));
});

test('buildSourceGuard forbids placeholder text in the output', () => {
  const guard = buildSourceGuard({ sourceHasFullText: true });
  assert.ok(guard.includes('Never leave placeholder text'));
});

test('buildSourceGuard adds the abstract-only limits when the item has no full text', () => {
  const guard = buildSourceGuard({ sourceHasFullText: false });
  assert.ok(guard.includes('Only the abstract was supplied, not the full text.'));
});

test('buildSourceGuard leaves out the abstract-only limits when the full text was supplied', () => {
  const guard = buildSourceGuard({ sourceHasFullText: true });
  assert.ok(!guard.includes('Only the abstract was supplied'));
});

test('buildSourceGuard does not change the item it is given', () => {
  // Arrange
  const item = { sourceHasFullText: false, title: 'A trial', hasSourceText: true };
  const before = JSON.stringify(item);

  // Act
  buildSourceGuard(item);

  // Assert
  assert.equal(JSON.stringify(item), before);
});

test('checkArticleIntegrity does not flag a real bracketed DOI or PMID', () => {
  assert.deepEqual(checkArticleIntegrity('Cited as [DOI: 10.1000/xyz], [PMID 123456] and [Journal 2024; volume 12].', null), []);
});

test('checkArticleIntegrity flags a bare bracketed field name', () => {
  assert.equal(checkArticleIntegrity('See [DOI] for details.', null).length, 1);
});

test('checkArticleIntegrity accepts a manually entered "Given Surname" author when the article cites the surname', () => {
  assert.deepEqual(checkArticleIntegrity('Smith J. A trial. Lancet 2024.', { doi: '', authors: ['Jane Smith'] }), []);
});

test('checkArticleIntegrity does not let an author initial stand in for the surname', () => {
  // "Smith J" must fail when the article names someone else, even though "J" appears in "J Crohns Colitis"
  const problems = checkArticleIntegrity('Jones B. A trial. J Crohns Colitis 2024.', { doi: '', authors: ['Smith J'] });
  assert.equal(problems.length, 1);
});

test('checkArticleIntegrity still accepts a two-letter surname', () => {
  assert.deepEqual(checkArticleIntegrity('Li X. A trial. Gut 2024.', { doi: '', authors: ['Li X'] }), []);
});

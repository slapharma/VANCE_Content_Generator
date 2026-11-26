import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseTitle,
  isClinicalReviewRule,
  pmidFromTitle,
  guardedItemFromTitle,
} from './title-lookup.js';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const TITLE = 'A trial of something';
const PMID = '12345678';
const DOI = '10.1234/abc.2024.001';
const LONG_ABSTRACT = 'Background: Chronic gut inflammation is common and often under-treated. Methods: In this randomised trial, 120 adults received the study product or placebo for twelve weeks. The primary endpoint was the change in faecal calprotectin from baseline. Results: Calprotectin fell by 35 percent in the active arm compared with 4 percent in the placebo arm (p = 0.01). Adverse events were mild and similar between the two arms. Conclusions: The product reduced intestinal inflammatory markers over twelve weeks in this small trial.';
const AUTHORS_XML = `<AuthorList CompleteYN="Y"><Author ValidYN="Y"><LastName>Karlowicz</LastName><ForeName>Kasia</ForeName><Initials>K</Initials></Author><Author ValidYN="Y"><LastName>Smith</LastName><Initials>JA</Initials></Author></AuthorList>`;
const SEARCH_URL = `${EUTILS}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(`"${TITLE}"[Title]`)}&retmode=json`;
const FETCH_URL = `${EUTILS}/efetch.fcgi?db=pubmed&id=${PMID}&retmode=xml`;

function jsonResponse(ok, body) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

function okXml(xml) {
  return { ok: true, status: 200, text: async () => xml };
}

function articleXml(title, abstract) {
  return `<PubmedArticle><MedlineCitation><PMID Version="1">${PMID}</PMID><Article><Journal><JournalIssue><Volume>12</Volume><Issue>4</Issue><PubDate><Year>2024</Year></PubDate></JournalIssue><Title>Journal of Test Medicine</Title></Journal><ArticleTitle>${title}</ArticleTitle><Pagination><MedlinePgn>101-115</MedlinePgn></Pagination><Abstract><AbstractText>${abstract}</AbstractText></Abstract>${AUTHORS_XML}</Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">${DOI}</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`;
}

// Routes the esearch call to onSearch and the efetch call to onFetch, and records every URL.
function routedFetch(calls, onSearch, onFetch) {
  return async (url) => {
    calls.push(String(url));
    return String(url).includes('esearch.fcgi') ? onSearch() : onFetch();
  };
}

const ONE_HIT = async () => jsonResponse(true, { esearchresult: { idlist: [PMID] } });
const NO_HITS = async () => jsonResponse(true, { esearchresult: { idlist: [] } });
const TWO_HITS = async () => jsonResponse(true, { esearchresult: { idlist: [PMID, '99999999'] } });
const NEVER_CALLED = async () => { throw new Error('this fetch should not be reached'); };

function titleOnlyItem() {
  return {
    title: TITLE,
    url: null,
    rawText: '',
    sourceType: 'upload',
    titleOnly: true,
    pubDate: new Date('2026-01-01T00:00:00.000Z'),
    rowNotes: 'Focus on dosing',
    subCategory: 'Clinical Trial Abstracts',
    tags: 'ibd',
  };
}

// ── normaliseTitle ──────────────────────────────────────────────────────────

test('normaliseTitle lower-cases the title and drops spaces and punctuation', () => {
  // Arrange
  const title = 'Study - A Trial.';

  // Act
  const out = normaliseTitle(title);

  // Assert
  assert.equal(out, 'studyatrial');
});

test('normaliseTitle reduces an accented letter to its plain letter', () => {
  // Arrange
  const title = 'Café Crème';

  // Act
  const out = normaliseTitle(title);

  // Assert
  assert.equal(out, 'cafecreme');
});

test('normaliseTitle returns an empty string for null and undefined', () => {
  // Arrange and Act
  const fromNull = normaliseTitle(null);
  const fromUndefined = normaliseTitle(undefined);

  // Assert
  assert.equal(fromNull, '');
  assert.equal(fromUndefined, '');
});

// ── isClinicalReviewRule ────────────────────────────────────────────────────

test('isClinicalReviewRule is true for a rule in the clinical-reviews category', () => {
  // Arrange
  const rule = { category: 'clinical-reviews', generation: {} };

  // Act
  const out = isClinicalReviewRule(rule);

  // Assert
  assert.equal(out, true);
});

test('isClinicalReviewRule is true for a rule whose generation template is clinical-reviews', () => {
  // Arrange
  const rule = { category: 'custom', generation: { template: 'clinical-reviews' } };

  // Act
  const out = isClinicalReviewRule(rule);

  // Assert
  assert.equal(out, true);
});

test('isClinicalReviewRule is false for a Gastro Living rule', () => {
  // Arrange
  const rule = { category: 'ibd-living', generation: { template: 'ibd-living' } };

  // Act
  const out = isClinicalReviewRule(rule);

  // Assert
  assert.equal(out, false);
});

test('isClinicalReviewRule is false for a missing rule without throwing', () => {
  // Arrange and Act
  const out = isClinicalReviewRule(undefined);

  // Assert
  assert.equal(out, false);
});

// ── pmidFromTitle ───────────────────────────────────────────────────────────

test('pmidFromTitle returns the PMID when exactly one record has the exact title', async () => {
  // Arrange
  const calls = [];
  const fetchFn = async (url) => { calls.push(String(url)); return ONE_HIT(); };

  // Act
  const pmid = await pmidFromTitle(TITLE, fetchFn);

  // Assert
  assert.equal(pmid, PMID);
  assert.deepEqual(calls, [SEARCH_URL]);
});

test('pmidFromTitle returns an empty string when no record has the title', async () => {
  // Arrange
  const fetchFn = NO_HITS;

  // Act
  const pmid = await pmidFromTitle(TITLE, fetchFn);

  // Assert
  assert.equal(pmid, '');
});

test('pmidFromTitle returns an empty string when two records share the title', async () => {
  // Arrange
  const fetchFn = TWO_HITS;

  // Act
  const pmid = await pmidFromTitle(TITLE, fetchFn);

  // Assert
  assert.equal(pmid, '');
});

test('pmidFromTitle returns an empty string when the search response is not OK, even with an id in the body', async () => {
  // Arrange
  const fetchFn = async () => jsonResponse(false, { esearchresult: { idlist: [PMID] } });

  // Act
  const pmid = await pmidFromTitle(TITLE, fetchFn);

  // Assert
  assert.equal(pmid, '');
});

test('pmidFromTitle returns an empty string when the search response is not JSON', async () => {
  // Arrange
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });

  // Act
  const pmid = await pmidFromTitle(TITLE, fetchFn);

  // Assert
  assert.equal(pmid, '');
});

test('pmidFromTitle returns an empty string when fetch throws', async () => {
  // Arrange
  const fetchFn = async () => { throw new Error('ENOTFOUND eutils'); };

  // Act
  const pmid = await pmidFromTitle(TITLE, fetchFn);

  // Assert
  assert.equal(pmid, '');
});

test('pmidFromTitle makes no request for a blank title', async () => {
  // Arrange
  const calls = [];
  const fetchFn = async (url) => { calls.push(String(url)); return ONE_HIT(); };

  // Act
  const pmid = await pmidFromTitle('   ', fetchFn);

  // Assert
  assert.equal(pmid, '');
  assert.deepEqual(calls, []);
});

test('pmidFromTitle removes square brackets and double quotes from the title before searching', async () => {
  // Arrange
  const calls = [];
  const fetchFn = async (url) => { calls.push(String(url)); return NO_HITS(); };
  const title = 'Effect of "X" [Abstract]';

  // Act
  await pmidFromTitle(title, fetchFn);

  // Assert
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(encodeURIComponent('"Effect of X Abstract"[Title]')), calls[0]);
});

// ── guardedItemFromTitle: the item it returns ───────────────────────────────

test('guardedItemFromTitle returns a bibliography item carrying the PubMed abstract and citation', async () => {
  // Arrange
  const calls = [];
  const fetchFn = routedFetch(calls, ONE_HIT, async () => okXml(articleXml(TITLE, LONG_ABSTRACT)));

  // Act
  const item = await guardedItemFromTitle(titleOnlyItem(), fetchFn);

  // Assert
  assert.equal(item.sourceType, 'bibliography');
  assert.equal(item.titleOnly, false);
  assert.equal(item.hasSourceText, true);
  assert.equal(item.sourceHasFullText, false);
  assert.equal(item.rawText, `CITATION RECORD:\nTitle: ${TITLE}\nAuthors: Karlowicz K, Smith JA\nJournal: Journal of Test Medicine\nYear: 2024\nVolume: 12\nIssue: 4\nPages: 101-115\nPMID: ${PMID}\nDOI: ${DOI}\n\nABSTRACT:\n${LONG_ABSTRACT}`);
  assert.deepEqual(item.bibPaper, { doi: DOI, authors: ['Karlowicz K', 'Smith JA'], pmid: PMID });
  assert.deepEqual(calls, [SEARCH_URL, FETCH_URL]);
});

test('guardedItemFromTitle keeps the row notes, sub-category and tags of the uploaded row', async () => {
  // Arrange
  const fetchFn = routedFetch([], ONE_HIT, async () => okXml(articleXml(TITLE, LONG_ABSTRACT)));

  // Act
  const item = await guardedItemFromTitle(titleOnlyItem(), fetchFn);

  // Assert
  assert.equal(item.title, TITLE);
  assert.equal(item.rowNotes, 'Focus on dosing');
  assert.equal(item.subCategory, 'Clinical Trial Abstracts');
  assert.equal(item.tags, 'ibd');
});

test('guardedItemFromTitle does not change the item it was given', async () => {
  // Arrange
  const input = titleOnlyItem();
  const fetchFn = routedFetch([], ONE_HIT, async () => okXml(articleXml(TITLE, LONG_ABSTRACT)));

  // Act
  await guardedItemFromTitle(input, fetchFn);

  // Assert
  assert.equal(input.titleOnly, true);
  assert.equal(input.sourceType, 'upload');
  assert.equal(input.rawText, '');
});

test('guardedItemFromTitle accepts a PubMed title that differs only in case, spacing and punctuation', async () => {
  // Arrange
  const input = { ...titleOnlyItem(), title: 'a TRIAL, of something!' };
  const fetchFn = routedFetch([], ONE_HIT, async () => okXml(articleXml(TITLE, LONG_ABSTRACT)));

  // Act
  const item = await guardedItemFromTitle(input, fetchFn);

  // Assert
  assert.equal(item.sourceType, 'bibliography');
  assert.ok(item.rawText.startsWith(`CITATION RECORD:\nTitle: ${TITLE}\n`), item.rawText);
});

// ── guardedItemFromTitle: refusals ──────────────────────────────────────────

test('guardedItemFromTitle refuses when PubMed has no record with the title', async () => {
  // Arrange
  const calls = [];
  const fetchFn = routedFetch(calls, NO_HITS, NEVER_CALLED);

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: new RegExp(`Could not find the published paper for "${TITLE}" \\(PubMed has no single exact title match\\)`) },
  );
  assert.deepEqual(calls, [SEARCH_URL]);
});

test('guardedItemFromTitle refuses when two PubMed records share the title', async () => {
  // Arrange
  const fetchFn = routedFetch([], TWO_HITS, NEVER_CALLED);

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /\(PubMed has no single exact title match\)/ },
  );
});

test('guardedItemFromTitle refuses when the title search throws', async () => {
  // Arrange
  const fetchFn = routedFetch([], async () => { throw new Error('socket hang up'); }, NEVER_CALLED);

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /\(PubMed has no single exact title match\)/ },
  );
});

test('guardedItemFromTitle refuses with a PubMed-unreachable reason when the record fetch returns an error status', async () => {
  // Arrange
  const fetchFn = routedFetch([], ONE_HIT, async () => ({ ok: false, status: 500, text: async () => articleXml(TITLE, LONG_ABSTRACT) }));

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /\(PubMed could not be reached\)/ },
  );
});

test('guardedItemFromTitle refuses with a PubMed-unreachable reason when the record fetch throws', async () => {
  // Arrange
  const fetchFn = routedFetch([], ONE_HIT, async () => { throw new Error('ECONNRESET'); });

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /\(PubMed could not be reached\)/ },
  );
});

test('guardedItemFromTitle refuses with a PubMed-unreachable reason when the record body is not PubMed XML', async () => {
  // Arrange
  const fetchFn = routedFetch([], ONE_HIT, async () => okXml('<html><body>Service unavailable</body></html>'));

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /\(PubMed could not be reached\)/ },
  );
});

test('guardedItemFromTitle refuses when the PubMed title is a different paper', async () => {
  // Arrange
  const fetchFn = routedFetch([], ONE_HIT, async () => okXml(articleXml('A trial of something else', LONG_ABSTRACT)));

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /\(the PubMed title differs\)/ },
  );
});

test('guardedItemFromTitle refuses when the abstract is one character under the minimum length', async () => {
  // Arrange
  const abstract399 = 'a'.repeat(399);
  const fetchFn = routedFetch([], ONE_HIT, async () => okXml(articleXml(TITLE, abstract399)));

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /\(PubMed has no abstract for it\)/ },
  );
});

test('guardedItemFromTitle accepts an abstract of exactly the minimum length', async () => {
  // Arrange
  const abstract400 = 'a'.repeat(400);
  const fetchFn = routedFetch([], ONE_HIT, async () => okXml(articleXml(TITLE, abstract400)));

  // Act
  const item = await guardedItemFromTitle(titleOnlyItem(), fetchFn);

  // Assert
  assert.equal(item.sourceType, 'bibliography');
  assert.ok(item.rawText.endsWith(`ABSTRACT:\n${abstract400}`), item.rawText);
});

test('guardedItemFromTitle refuses when the PubMed record has only a whitespace abstract', async () => {
  // Arrange
  const fetchFn = routedFetch([], ONE_HIT, async () => okXml(articleXml(TITLE, '   ')));

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /\(PubMed has no abstract for it\)/ },
  );
});

test('guardedItemFromTitle names the row title in the refusal message', async () => {
  // Arrange
  const fetchFn = routedFetch([], NO_HITS, NEVER_CALLED);

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: new RegExp(`^Could not find the published paper for "${TITLE}"`) },
  );
});

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { kv } from '../kv.js';
import { fetchBibliographyPapers } from './bibliography.js';

// kv is swapped for an in-memory fake for each test and restored afterwards, the same
// way api/automation/run-lock.test.js does it. PubMed is the injected fetchFn, so no
// test touches the network. Every PubMed call is recorded so a test can assert none was made.

const BIB_ID = 'bib1';
const PAPER_ID = 'paper1';
const PMID = '98765';
const DOI = '10.1234/test.2024.001';
const EFETCH_PREFIX = 'efetch.fcgi';
const ESEARCH_PREFIX = 'esearch.fcgi';

const LONG_ABSTRACT = 'Background: Chronic gut inflammation is common and often under-treated. Methods: In this randomised trial, 120 adults received the study product or placebo for twelve weeks. The primary endpoint was the change in faecal calprotectin from baseline. Results: Calprotectin fell by 35 percent in the active arm compared with 4 percent in the placebo arm (p = 0.01). Adverse events were mild and similar between the two arms. Conclusions: The product reduced intestinal inflammatory markers over twelve weeks in this small trial.';

const PUBMED_XML = `<PubmedArticle><MedlineCitation><PMID Version="1">${PMID}</PMID><Article><Journal><JournalIssue><Volume>12</Volume><Issue>4</Issue><PubDate><Year>2024</Year></PubDate></JournalIssue><Title>Journal of Test Medicine</Title></Journal><ArticleTitle>A trial of something</ArticleTitle><Pagination><MedlinePgn>101-115</MedlinePgn></Pagination><Abstract><AbstractText>${LONG_ABSTRACT}</AbstractText></Abstract></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">${DOI}</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`;

const STORED_PAPER = {
  id: PAPER_ID,
  title: 'A trial of something',
  authors: ['Karłowicz K'],
  journal: 'Journal of Test Medicine',
  year: 2024,
  doi: DOI,
  url: '',
  pmid: '',
  abstract: '',
  source: 'pubmed',
  processed: false,
  addedAt: '2026-01-01T00:00:00.000Z',
};

const REAL_KV = { ...kv };
let state;

function resetState() {
  state = { values: new Map(), lists: new Map(), writes: [] };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const fakeKv = {
  async get(key) {
    return state.values.has(key) ? clone(state.values.get(key)) : null;
  },
  async set(key, value) {
    state.values.set(key, clone(value));
    state.writes.push(key);
    return 'OK';
  },
  async lrange(key) {
    return [...(state.lists.get(key) ?? [])];
  },
};

function storePaper(paper) {
  state.values.set(`bibliography:paper:${PAPER_ID}`, clone(paper));
}

// PubMed answers both the DOI search and the record fetch.
function pubmedOk(calls) {
  return async (url) => {
    calls.push(String(url));
    if (String(url).includes(ESEARCH_PREFIX)) return { ok: true, status: 200, json: async () => ({ esearchresult: { idlist: [PMID] } }) };
    return { ok: true, status: 200, text: async () => PUBMED_XML };
  };
}

// PubMed search answers, but the record fetch fails.
function efetchFails(calls) {
  return async (url) => {
    calls.push(String(url));
    if (String(url).includes(ESEARCH_PREFIX)) return { ok: true, status: 200, json: async () => ({ esearchresult: { idlist: [PMID] } }) };
    return { ok: false, status: 503, text: async () => 'busy' };
  };
}

// PubMed cannot be reached at all.
function unreachable(calls) {
  return async (url) => {
    calls.push(String(url));
    throw new Error('getaddrinfo ENOTFOUND eutils.ncbi.nlm.nih.gov');
  };
}

beforeEach(() => {
  resetState();
  Object.assign(kv, fakeKv);
  state.values.set(`bibliography:${BIB_ID}`, { id: BIB_ID, name: 'Test bibliography' });
  state.lists.set(`bibliography:papers:${BIB_ID}`, [PAPER_ID]);
});

afterEach(() => {
  Object.assign(kv, REAL_KV);
});

const SOURCE = { bibId: BIB_ID, mode: 'daily' };
const ALL_SOURCE = { bibId: BIB_ID, mode: 'all' };

test('fills an empty abstract from PubMed and reports source text as present', async () => {
  // Arrange
  storePaper(STORED_PAPER);
  const calls = [];

  // Act
  const items = await fetchBibliographyPapers(SOURCE, null, { fetchFn: pubmedOk(calls) });

  // Assert
  assert.equal(items.length, 1);
  assert.equal(items[0].hasSourceText, true);
  assert.ok(items[0].rawText.endsWith(`\n\nABSTRACT:\n${LONG_ABSTRACT}`), items[0].rawText);
});

test('builds a CITATION RECORD with the PMID and the PubMed volume, issue, pages and DOI', async () => {
  // Arrange
  storePaper(STORED_PAPER);
  const calls = [];

  // Act
  const items = await fetchBibliographyPapers(SOURCE, null, { fetchFn: pubmedOk(calls) });

  // Assert
  assert.equal(items[0].rawText, [
    'CITATION RECORD:',
    'Title: A trial of something',
    'Authors: Karłowicz K',
    'Journal: Journal of Test Medicine',
    'Year: 2024',
    'Volume: 12',
    'Issue: 4',
    'Pages: 101-115',
    `PMID: ${PMID}`,
    `DOI: ${DOI}`,
    '',
    'ABSTRACT:',
    LONG_ABSTRACT,
  ].join('\n'));
});

test('saves the PubMed abstract and PMID back to the stored paper so the lookup runs once', async () => {
  // Arrange
  storePaper(STORED_PAPER);
  const calls = [];

  // Act
  await fetchBibliographyPapers(SOURCE, null, { fetchFn: pubmedOk(calls) });

  // Assert
  const saved = state.values.get(`bibliography:paper:${PAPER_ID}`);
  assert.equal(saved.pmid, PMID);
  assert.equal(saved.abstract, LONG_ABSTRACT);
});

test('takes the PMID from a stored PubMed URL and fetches the record without a DOI search', async () => {
  // Arrange
  storePaper({ ...STORED_PAPER, url: `https://pubmed.ncbi.nlm.nih.gov/${PMID}/`, doi: '' });
  const calls = [];

  // Act
  await fetchBibliographyPapers(SOURCE, null, { fetchFn: pubmedOk(calls) });

  // Assert
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(EFETCH_PREFIX), calls[0]);
  assert.ok(calls[0].includes(`id=${PMID}`), calls[0]);
});

test('marks hasSourceText false and keeps the stored record when PubMed cannot be reached', async () => {
  // Arrange
  storePaper(STORED_PAPER);
  const calls = [];

  // Act
  const items = await fetchBibliographyPapers(ALL_SOURCE, null, { fetchFn: unreachable(calls) });

  // Assert
  assert.equal(items[0].hasSourceText, false);
  assert.equal(items[0].rawText, [
    'CITATION RECORD:',
    'Title: A trial of something',
    'Authors: Karłowicz K',
    'Journal: Journal of Test Medicine',
    'Year: 2024',
    `DOI: ${DOI}`,
    '',
    'ABSTRACT:',
    '',
  ].join('\n'));
});

test('marks hasSourceText false when the PMID is found but the record fetch fails', async () => {
  // Arrange
  storePaper(STORED_PAPER);
  const calls = [];

  // Act
  const items = await fetchBibliographyPapers(ALL_SOURCE, null, { fetchFn: efetchFails(calls) });

  // Assert
  assert.equal(items[0].hasSourceText, false);
  assert.ok(items[0].rawText.includes(`PMID: ${PMID}`), items[0].rawText);
  assert.ok(items[0].rawText.endsWith('\n\nABSTRACT:\n'), items[0].rawText);
});

test('makes no PubMed call when the stored paper already holds an abstract and PMID', async () => {
  // Arrange
  storePaper({ ...STORED_PAPER, abstract: LONG_ABSTRACT, pmid: PMID });
  const calls = [];

  // Act
  const items = await fetchBibliographyPapers(ALL_SOURCE, null, { fetchFn: unreachable(calls) });

  // Assert
  assert.deepEqual(calls, []);
  assert.equal(items[0].hasSourceText, true);
  assert.ok(items[0].rawText.endsWith(`\n\nABSTRACT:\n${LONG_ABSTRACT}`), items[0].rawText);
});

test('treats a 399 character abstract as too short to use', async () => {
  // Arrange
  storePaper({ ...STORED_PAPER, abstract: 'x'.repeat(399), pmid: PMID });
  const calls = [];

  // Act
  const items = await fetchBibliographyPapers(ALL_SOURCE, null, { fetchFn: unreachable(calls) });

  // Assert
  assert.equal(items[0].hasSourceText, false);
});

test('treats a 400 character abstract as enough, with no PubMed call', async () => {
  // Arrange
  storePaper({ ...STORED_PAPER, abstract: 'x'.repeat(400), pmid: PMID });
  const calls = [];

  // Act
  const items = await fetchBibliographyPapers(SOURCE, null, { fetchFn: unreachable(calls) });

  // Assert
  assert.deepEqual(calls, []);
  assert.equal(items[0].hasSourceText, true);
});

test('uses the full PubMed abstract when the stored abstract is only a short note', async () => {
  // Arrange
  storePaper({ ...STORED_PAPER, abstract: 'Short note.' });
  const calls = [];

  // Act
  const items = await fetchBibliographyPapers(SOURCE, null, { fetchFn: pubmedOk(calls) });

  // Assert
  assert.equal(items[0].hasSourceText, true);
});

test('daily mode throws a clear error when no paper has an abstract', async () => {
  // Arrange
  storePaper(STORED_PAPER);

  // Act + Assert
  await assert.rejects(
    fetchBibliographyPapers(SOURCE, null, { fetchFn: unreachable([]) }),
    /No paper in bibliography .* has an abstract/,
  );
});

test('daily mode skips a paper without an abstract and returns the next one that has one', async () => {
  // Arrange: the first paper has no abstract and no way to get one; the second has a long abstract
  const second = { ...STORED_PAPER, id: 'paper2', title: 'Second trial', doi: '', url: '', abstract: 'y'.repeat(500), pmid: '999' };
  state.values.set('bibliography:paper:paper2', clone(second));
  state.lists.set(`bibliography:papers:${BIB_ID}`, [PAPER_ID, 'paper2']);
  storePaper({ ...STORED_PAPER, doi: '', url: '' });

  // Act
  const items = await fetchBibliographyPapers(SOURCE, null, { fetchFn: unreachable([]) });

  // Assert
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Second trial');
  assert.equal(items[0].hasSourceText, true);
});

test('daily mode tries a paper that already failed after the ones that have not', async () => {
  // Arrange: both have abstracts; the first has a recorded failure
  const long = 'z'.repeat(500);
  storePaper({ ...STORED_PAPER, abstract: long, pmid: PMID, lastFailure: { at: '2026-11-24T00:00:00Z', reason: 'x' } });
  state.values.set('bibliography:paper:paper2', clone({ ...STORED_PAPER, id: 'paper2', title: 'Fresh trial', abstract: long, pmid: '999' }));
  state.lists.set(`bibliography:papers:${BIB_ID}`, [PAPER_ID, 'paper2']);

  // Act
  const items = await fetchBibliographyPapers(SOURCE, null, { fetchFn: unreachable([]) });

  // Assert
  assert.equal(items[0].title, 'Fresh trial');
});

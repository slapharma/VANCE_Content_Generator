import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseTitle,
  isClinicalReviewRule,
  pmidsFromTitle,
  guardedItemFromTitle,
} from './title-lookup.js';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const TITLE = 'A trial of something';
const PMID = '12345678';
const OTHER_PMID = '99999999';
const DOI = '10.1234/abc.2024.001';
const LONG_ABSTRACT = 'Background: Chronic gut inflammation is common and often under-treated. Methods: In this randomised trial, 120 adults received the study product or placebo for twelve weeks. The primary endpoint was the change in faecal calprotectin from baseline. Results: Calprotectin fell by 35 percent in the active arm compared with 4 percent in the placebo arm (p = 0.01). Adverse events were mild and similar between the two arms. Conclusions: The product reduced intestinal inflammatory markers over twelve weeks in this small trial.';
const AUTHORS_XML = `<AuthorList CompleteYN="Y"><Author ValidYN="Y"><LastName>Karlowicz</LastName><ForeName>Kasia</ForeName><Initials>K</Initials></Author><Author ValidYN="Y"><LastName>Smith</LastName><Initials>JA</Initials></Author></AuthorList>`;
const SEARCH_URL = `${EUTILS}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(`${TITLE}[Title]`)}&retmax=5&retmode=json`;
const FETCH_URL = `${EUTILS}/efetch.fcgi?db=pubmed&id=${PMID}&retmode=xml`;

function jsonResponse(ok, body) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

function okXml(xml) {
  return { ok: true, status: 200, text: async () => xml };
}

function articleXml(title, abstract, pmid = PMID) {
  return `<PubmedArticle><MedlineCitation><PMID Version="1">${pmid}</PMID><Article><Journal><JournalIssue><Volume>12</Volume><Issue>4</Issue><PubDate><Year>2024</Year></PubDate></JournalIssue><Title>Journal of Test Medicine</Title></Journal><ArticleTitle>${title}</ArticleTitle><Pagination><MedlinePgn>101-115</MedlinePgn></Pagination><Abstract><AbstractText>${abstract}</AbstractText></Abstract>${AUTHORS_XML}</Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="doi">${DOI}</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`;
}

// Answers esearch the way real PubMed does. A quoted phrase finds nothing. An
// unquoted "<title>[Title]" term finds the ids listed for that title.
function pubmedSearch(url, idsByTitle) {
  const term = new URL(url).searchParams.get('term') ?? '';
  const isUnquotedTitleTerm = term.endsWith('[Title]') && !term.includes('"');
  const title = term.slice(0, -'[Title]'.length);
  return jsonResponse(true, { esearchresult: { idlist: isUnquotedTitleTerm ? (idsByTitle[title] ?? []) : [] } });
}

// Answers efetch with the article for each requested id. An unknown id gives nothing, as in PubMed.
function pubmedEfetch(url, articlesByPmid) {
  const ids = (new URL(url).searchParams.get('id') ?? '').split(',');
  return okXml(ids.map(id => articlesByPmid[id] ?? '').join(''));
}

// One fake PubMed for a test: esearch and efetch answered from the two maps.
// Every URL it is asked for is recorded in calls.
function fakePubMed(calls, idsByTitle, articlesByPmid) {
  return async (url) => {
    calls.push(String(url));
    return String(url).includes('esearch.fcgi')
      ? pubmedSearch(String(url), idsByTitle)
      : pubmedEfetch(String(url), articlesByPmid);
  };
}

// Routes the esearch call to onSearch and the efetch call to onFetch, and records every URL.
function routedFetch(calls, onSearch, onFetch) {
  return async (url) => {
    calls.push(String(url));
    return String(url).includes('esearch.fcgi') ? onSearch(String(url)) : onFetch(String(url));
  };
}

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

// ── pmidsFromTitle ──────────────────────────────────────────────────────────

test('pmidsFromTitle returns the id PubMed finds for the title', async () => {
  // Arrange
  const calls = [];
  const fetchFn = fakePubMed(calls, { [TITLE]: [PMID] }, {});

  // Act
  const pmids = await pmidsFromTitle(TITLE, fetchFn);

  // Assert
  assert.deepEqual(pmids, [PMID]);
  assert.deepEqual(calls, [SEARCH_URL]);
});

test('pmidsFromTitle returns every id PubMed gives, in the order it gives them', async () => {
  // Arrange
  const fetchFn = fakePubMed([], { [TITLE]: [PMID, OTHER_PMID] }, {});

  // Act
  const pmids = await pmidsFromTitle(TITLE, fetchFn);

  // Assert
  assert.deepEqual(pmids, [PMID, OTHER_PMID]);
});

test('pmidsFromTitle returns an empty list when PubMed finds nothing for the title', async () => {
  // Arrange
  const fetchFn = fakePubMed([], {}, {});

  // Act
  const pmids = await pmidsFromTitle(TITLE, fetchFn);

  // Assert
  assert.deepEqual(pmids, []);
});

test('pmidsFromTitle returns the ids as strings when PubMed sends numbers', async () => {
  // Arrange
  const fetchFn = async () => jsonResponse(true, { esearchresult: { idlist: [12345678] } });

  // Act
  const pmids = await pmidsFromTitle(TITLE, fetchFn);

  // Assert
  assert.deepEqual(pmids, [PMID]);
});

test('pmidsFromTitle returns null when the search response has no idlist', async () => {
  // Arrange
  const fetchFn = async () => jsonResponse(true, { esearchresult: { ERROR: 'Invalid query' } });

  // Act
  const pmids = await pmidsFromTitle(TITLE, fetchFn);

  // Assert
  assert.equal(pmids, null);
});

test('pmidsFromTitle returns null when the search response is not OK, even with an id in the body', async () => {
  // Arrange
  const fetchFn = async () => jsonResponse(false, { esearchresult: { idlist: [PMID] } });

  // Act
  const pmids = await pmidsFromTitle(TITLE, fetchFn);

  // Assert
  assert.equal(pmids, null);
});

test('pmidsFromTitle returns null when the search response is not JSON', async () => {
  // Arrange
  const fetchFn = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });

  // Act
  const pmids = await pmidsFromTitle(TITLE, fetchFn);

  // Assert
  assert.equal(pmids, null);
});

test('pmidsFromTitle returns null when fetch throws', async () => {
  // Arrange
  const fetchFn = async () => { throw new Error('ENOTFOUND eutils'); };

  // Act
  const pmids = await pmidsFromTitle(TITLE, fetchFn);

  // Assert
  assert.equal(pmids, null);
});

test('pmidsFromTitle makes no request for a blank title', async () => {
  // Arrange
  const calls = [];
  const fetchFn = fakePubMed(calls, { [TITLE]: [PMID] }, {});

  // Act
  const pmids = await pmidsFromTitle('   ', fetchFn);

  // Assert
  assert.deepEqual(pmids, []);
  assert.deepEqual(calls, []);
});

test('pmidsFromTitle makes no request for a null title', async () => {
  // Arrange
  const calls = [];
  const fetchFn = fakePubMed(calls, {}, {});

  // Act
  const pmids = await pmidsFromTitle(null, fetchFn);

  // Assert
  assert.deepEqual(pmids, []);
  assert.deepEqual(calls, []);
});

test('pmidsFromTitle removes square brackets and double quotes from the title before searching', async () => {
  // Arrange
  const calls = [];
  const fetchFn = fakePubMed(calls, {}, {});
  const title = 'Effect of "X" [Abstract]';

  // Act
  await pmidsFromTitle(title, fetchFn);

  // Assert
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]).searchParams.get('term'), 'Effect of X Abstract[Title]');
});

test('pmidsFromTitle sends accented letters and emoji in the title unchanged', async () => {
  // Arrange
  const calls = [];
  const title = 'Café 🦠 Crohn’s trial';
  const fetchFn = fakePubMed(calls, { [title]: [PMID] }, {});

  // Act
  const pmids = await pmidsFromTitle(title, fetchFn);

  // Assert
  assert.deepEqual(pmids, [PMID]);
  assert.equal(new URL(calls[0]).searchParams.get('term'), `${title}[Title]`);
});

test('pmidsFromTitle sends an ampersand, plus sign and hash in the title intact', async () => {
  // Arrange
  const calls = [];
  const title = 'IBD & colitis + ulcerative #1 trial';
  const fetchFn = fakePubMed(calls, { [title]: [PMID] }, {});

  // Act
  const pmids = await pmidsFromTitle(title, fetchFn);

  // Assert
  assert.deepEqual(pmids, [PMID]);
  assert.equal(new URL(calls[0]).searchParams.get('term'), `${title}[Title]`);
});

test('pmidsFromTitle sends a very long title whole, without cutting it short', async () => {
  // Arrange
  const calls = [];
  const longTitle = 'word '.repeat(100).trim();
  const fetchFn = fakePubMed(calls, {}, {});

  // Act
  await pmidsFromTitle(longTitle, fetchFn);

  // Assert
  assert.equal(new URL(calls[0]).searchParams.get('term'), `${longTitle}[Title]`);
});

test('pmidsFromTitle never quotes the title, because a quoted full title finds no PubMed record', async () => {
  // Arrange
  const calls = [];
  const fetchFn = fakePubMed(calls, { [TITLE]: [PMID] }, {});

  // Act
  const pmids = await pmidsFromTitle(TITLE, fetchFn);

  // Assert
  const url = new URL(calls[0]);
  const term = url.searchParams.get('term');
  assert.deepEqual(pmids, [PMID]);
  assert.equal(term, `${TITLE}[Title]`);
  assert.equal(term.includes('"'), false, term);
  assert.equal(term.endsWith('[Title]'), true, term);
  assert.equal(url.searchParams.get('retmax'), '5');
});

// ── guardedItemFromTitle: the item it returns ───────────────────────────────

test('guardedItemFromTitle returns a bibliography item carrying the PubMed abstract and citation', async () => {
  // Arrange
  const calls = [];
  const fetchFn = fakePubMed(calls, { [TITLE]: [PMID] }, { [PMID]: articleXml(TITLE, LONG_ABSTRACT) });

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
  const fetchFn = fakePubMed([], { [TITLE]: [PMID] }, { [PMID]: articleXml(TITLE, LONG_ABSTRACT) });

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
  const fetchFn = fakePubMed([], { [TITLE]: [PMID] }, { [PMID]: articleXml(TITLE, LONG_ABSTRACT) });

  // Act
  await guardedItemFromTitle(input, fetchFn);

  // Assert
  assert.equal(input.titleOnly, true);
  assert.equal(input.sourceType, 'upload');
  assert.equal(input.rawText, '');
});

test('guardedItemFromTitle accepts a PubMed title that differs only in case, spacing and punctuation', async () => {
  // Arrange
  const row = 'a TRIAL, of something!';
  const input = { ...titleOnlyItem(), title: row };
  const fetchFn = fakePubMed([], { [row]: [PMID] }, { [PMID]: articleXml(TITLE, LONG_ABSTRACT) });

  // Act
  const item = await guardedItemFromTitle(input, fetchFn);

  // Assert
  assert.equal(item.sourceType, 'bibliography');
  assert.ok(item.rawText.startsWith(`CITATION RECORD:\nTitle: ${TITLE}\n`), item.rawText);
});

test('guardedItemFromTitle takes the one candidate whose own title equals the row title, when PubMed gives several', async () => {
  // Arrange
  const calls = [];
  const idsByTitle = { [TITLE]: [OTHER_PMID, PMID] };
  const articles = {
    [OTHER_PMID]: articleXml('A trial of something else', LONG_ABSTRACT, OTHER_PMID),
    [PMID]: articleXml(TITLE, LONG_ABSTRACT),
  };
  const fetchFn = fakePubMed(calls, idsByTitle, articles);

  // Act
  const item = await guardedItemFromTitle(titleOnlyItem(), fetchFn);

  // Assert
  assert.equal(item.bibPaper.pmid, PMID);
  assert.ok(item.rawText.startsWith(`CITATION RECORD:\nTitle: ${TITLE}\n`), item.rawText);
  assert.deepEqual(calls, [SEARCH_URL, `${EUTILS}/efetch.fcgi?db=pubmed&id=${OTHER_PMID},${PMID}&retmode=xml`]);
});

// ── guardedItemFromTitle: refusals ──────────────────────────────────────────

test('guardedItemFromTitle refuses when PubMed has no record for the title words', async () => {
  // Arrange
  const calls = [];
  const fetchFn = fakePubMed(calls, {}, {});

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: new RegExp(`Could not find the published paper for "${TITLE}" \\(PubMed has no record matching the title words\\)`) },
  );
  assert.deepEqual(calls, [SEARCH_URL]);
});

test('guardedItemFromTitle refuses without fetching records when the title search throws', async () => {
  // Arrange
  const calls = [];
  const fetchFn = routedFetch(calls, async () => { throw new Error('socket hang up'); }, NEVER_CALLED);

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /^PubMed could not be searched for "A trial of something"/ },
  );
  assert.deepEqual(calls, [SEARCH_URL]);
});

test('guardedItemFromTitle refuses without fetching records when the title search returns an error status', async () => {
  // Arrange
  const calls = [];
  const fetchFn = routedFetch(calls, async () => jsonResponse(false, { esearchresult: { idlist: [PMID] } }), NEVER_CALLED);

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /^PubMed could not be searched for "A trial of something"/ },
  );
  assert.deepEqual(calls, [SEARCH_URL]);
});

test('guardedItemFromTitle refuses when two PubMed records have exactly the row title', async () => {
  // Arrange
  const idsByTitle = { [TITLE]: [PMID, OTHER_PMID] };
  const articles = {
    [PMID]: articleXml(TITLE, LONG_ABSTRACT, PMID),
    [OTHER_PMID]: articleXml(TITLE, LONG_ABSTRACT, OTHER_PMID),
  };
  const fetchFn = fakePubMed([], idsByTitle, articles);

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /\(more than one PubMed record has this title\)/ },
  );
});

test('guardedItemFromTitle refuses when the one PubMed record has a different title', async () => {
  // Arrange
  const fetchFn = fakePubMed([], { [TITLE]: [PMID] }, { [PMID]: articleXml('A trial of something else', LONG_ABSTRACT) });

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /\(no PubMed record has exactly this title\)/ },
  );
});

test('guardedItemFromTitle refuses when several PubMed records are found and none has exactly the row title', async () => {
  // Arrange
  const idsByTitle = { [TITLE]: [PMID, OTHER_PMID] };
  const articles = {
    [PMID]: articleXml('A trial of something else', LONG_ABSTRACT, PMID),
    [OTHER_PMID]: articleXml('A trial of something entirely different', LONG_ABSTRACT, OTHER_PMID),
  };
  const fetchFn = fakePubMed([], idsByTitle, articles);

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /\(no PubMed record has exactly this title\)/ },
  );
});

test('guardedItemFromTitle refuses with a PubMed-unreachable reason when the record fetch returns an error status', async () => {
  // Arrange
  const fetchFn = routedFetch([], u => pubmedSearch(u, { [TITLE]: [PMID] }), async () => ({ ok: false, status: 500, text: async () => articleXml(TITLE, LONG_ABSTRACT) }));

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /^PubMed could not be searched for "A trial of something"/ },
  );
});

test('guardedItemFromTitle refuses with a PubMed-unreachable reason when the record fetch throws', async () => {
  // Arrange
  const fetchFn = routedFetch([], u => pubmedSearch(u, { [TITLE]: [PMID] }), async () => { throw new Error('ECONNRESET'); });

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /^PubMed could not be searched for "A trial of something"/ },
  );
});

test('guardedItemFromTitle refuses with a PubMed-unreachable reason when the record body is not PubMed XML', async () => {
  // Arrange
  const fetchFn = routedFetch([], u => pubmedSearch(u, { [TITLE]: [PMID] }), async () => okXml('<html><body>Service unavailable</body></html>'));

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /^PubMed could not be searched for "A trial of something"/ },
  );
});

test('guardedItemFromTitle refuses when the abstract is one character under the minimum length', async () => {
  // Arrange
  const abstract399 = 'a'.repeat(399);
  const fetchFn = fakePubMed([], { [TITLE]: [PMID] }, { [PMID]: articleXml(TITLE, abstract399) });

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /\(PubMed has no abstract for it\)/ },
  );
});

test('guardedItemFromTitle accepts an abstract of exactly the minimum length', async () => {
  // Arrange
  const abstract400 = 'a'.repeat(400);
  const fetchFn = fakePubMed([], { [TITLE]: [PMID] }, { [PMID]: articleXml(TITLE, abstract400) });

  // Act
  const item = await guardedItemFromTitle(titleOnlyItem(), fetchFn);

  // Assert
  assert.equal(item.sourceType, 'bibliography');
  assert.ok(item.rawText.endsWith(`ABSTRACT:\n${abstract400}`), item.rawText);
});

test('guardedItemFromTitle refuses when the PubMed record has only a whitespace abstract', async () => {
  // Arrange
  const fetchFn = fakePubMed([], { [TITLE]: [PMID] }, { [PMID]: articleXml(TITLE, ' '.repeat(500)) });

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: /\(PubMed has no abstract for it\)/ },
  );
});

test('guardedItemFromTitle names the row title in the refusal message', async () => {
  // Arrange
  const fetchFn = fakePubMed([], {}, {});

  // Act and Assert
  await assert.rejects(
    guardedItemFromTitle(titleOnlyItem(), fetchFn),
    { message: new RegExp(`^Could not find the published paper for "${TITLE}"`) },
  );
});

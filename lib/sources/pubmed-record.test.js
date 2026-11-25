import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePubmedArticle,
  fetchPubMedRecords,
  pmidFromDoi,
  pmidFromUrl,
} from './pubmed-record.js';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

const ARTICLE_XML = `<PubmedArticle>
  <MedlineCitation Status="MEDLINE">
    <PMID Version="1">12345678</PMID>
    <Article PubModel="Print-Electronic">
      <Journal>
        <ISSN IssnType="Electronic">1878-3562</ISSN>
        <JournalIssue CitedMedium="Internet">
          <Volume>12</Volume>
          <Issue>4</Issue>
          <PubDate><Year>2024</Year><Month>Apr</Month></PubDate>
        </JournalIssue>
        <Title>Journal of Test Medicine</Title>
      </Journal>
      <ArticleTitle>A trial of something.</ArticleTitle>
      <Pagination><MedlinePgn>101-115</MedlinePgn></Pagination>
      <Abstract>
        <AbstractText Label="BACKGROUND" NlmCategory="BACKGROUND">Background text.</AbstractText>
        <AbstractText Label="RESULTS" NlmCategory="RESULTS">Results text.</AbstractText>
      </Abstract>
    </Article>
  </MedlineCitation>
  <PubmedData>
    <ArticleIdList>
      <ArticleId IdType="pubmed">12345678</ArticleId>
      <ArticleId IdType="doi">10.1234/abc.2024.001</ArticleId>
    </ArticleIdList>
  </PubmedData>
</PubmedArticle>`;

const SECOND_ARTICLE_XML = `<PubmedArticle><MedlineCitation><PMID>222</PMID><Article><ArticleTitle>Second</ArticleTitle></Article></MedlineCitation></PubmedArticle>`;

function okXml(xml) {
  return { ok: true, status: 200, text: async () => xml };
}

function jsonResponse(ok, body) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

// ── parsePubmedArticle ──────────────────────────────────────────────────────

test('parsePubmedArticle returns the citation fields of a complete record', () => {
  // Arrange
  const xml = ARTICLE_XML;

  // Act
  const rec = parsePubmedArticle(xml);

  // Assert
  assert.deepEqual(rec, {
    pmid: '12345678',
    title: 'A trial of something.',
    abstract: 'BACKGROUND: Background text.\nRESULTS: Results text.',
    journal: 'Journal of Test Medicine',
    year: 2024,
    volume: '12',
    issue: '4',
    pages: '101-115',
    doi: '10.1234/abc.2024.001',
  });
});

test('parsePubmedArticle puts each labelled abstract section on its own line with its label', () => {
  // Arrange
  const xml = ARTICLE_XML;

  // Act
  const rec = parsePubmedArticle(xml);

  // Assert
  assert.equal(rec.abstract, 'BACKGROUND: Background text.\nRESULTS: Results text.');
});

test('parsePubmedArticle returns the bare text of an unlabelled abstract', () => {
  // Arrange
  const xml = `<PubmedArticle><MedlineCitation><PMID>1</PMID><Article><Abstract><AbstractText>Plain summary only.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>`;

  // Act
  const rec = parsePubmedArticle(xml);

  // Assert
  assert.equal(rec.abstract, 'Plain summary only.');
});

test('parsePubmedArticle returns an empty abstract when the record has no Abstract element', () => {
  // Arrange
  const xml = `<PubmedArticle><MedlineCitation><PMID>1</PMID><Article><ArticleTitle>No abstract here.</ArticleTitle></Article></MedlineCitation></PubmedArticle>`;

  // Act
  const rec = parsePubmedArticle(xml);

  // Assert
  assert.equal(rec.abstract, '');
});

test('parsePubmedArticle skips an AbstractText section whose body is empty', () => {
  // Arrange
  const xml = `<PubmedArticle><MedlineCitation><PMID>1</PMID><Article><Abstract><AbstractText Label="METHODS">   </AbstractText><AbstractText Label="RESULTS">Kept.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>`;

  // Act
  const rec = parsePubmedArticle(xml);

  // Assert
  assert.equal(rec.abstract, 'RESULTS: Kept.');
});

test('parsePubmedArticle strips inline italic tags and keeps the words apart', () => {
  // Arrange
  const xml = `<PubmedArticle><MedlineCitation><PMID>1</PMID><Article><Abstract><AbstractText>Measured <i>in vivo</i> levels.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>`;

  // Act
  const rec = parsePubmedArticle(xml);

  // Assert
  assert.equal(rec.abstract, 'Measured in vivo levels.');
});

test('parsePubmedArticle keeps a superscript digit separate from the number before it', () => {
  // Arrange
  const xml = `<PubmedArticle><MedlineCitation><PMID>1</PMID><Article><Abstract><AbstractText>Serum was 10<sup>9</sup>/L.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>`;

  // Act
  const rec = parsePubmedArticle(xml);

  // Assert
  assert.ok(!rec.abstract.includes('109/L'), `superscript merged into the number: ${rec.abstract}`);
});

test('parsePubmedArticle decodes named entities', () => {
  // Arrange
  const xml = `<PubmedArticle><MedlineCitation><PMID>1</PMID><Article><Abstract><AbstractText>p &lt; 0.05 &amp; &quot;stable&quot;</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>`;

  // Act
  const rec = parsePubmedArticle(xml);

  // Assert
  assert.equal(rec.abstract, 'p < 0.05 & "stable"');
});

test('parsePubmedArticle decodes numeric entities in decimal and hex form', () => {
  // Arrange
  const xml = `<PubmedArticle><MedlineCitation><PMID>1</PMID><Article><Abstract><AbstractText>&#945;-diversity and &#x3B2;-glucan</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>`;

  // Act
  const rec = parsePubmedArticle(xml);

  // Assert
  assert.equal(rec.abstract, 'α-diversity and β-glucan');
});

test('parsePubmedArticle decodes an escaped entity once, so &amp;lt; becomes the text &lt;', () => {
  // Arrange
  const xml = `<PubmedArticle><MedlineCitation><PMID>1</PMID><Article><Abstract><AbstractText>&amp;lt;</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>`;

  // Act
  const rec = parsePubmedArticle(xml);

  // Assert
  assert.equal(rec.abstract, '&lt;');
});

test('parsePubmedArticle keeps non-ASCII letters and symbols in the abstract', () => {
  // Arrange
  const xml = `<PubmedArticle><MedlineCitation><PMID>1</PMID><Article><Abstract><AbstractText>Dose 5 μg/mL ± 2 by Karłowicz.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>`;

  // Act
  const rec = parsePubmedArticle(xml);

  // Assert
  assert.equal(rec.abstract, 'Dose 5 μg/mL ± 2 by Karłowicz.');
});

test('parsePubmedArticle collapses a line break inside an abstract section into one space', () => {
  // Arrange
  const xml = `<PubmedArticle><MedlineCitation><PMID>1</PMID><Article><Abstract><AbstractText>First line\n      second   line.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>`;

  // Act
  const rec = parsePubmedArticle(xml);

  // Assert
  assert.equal(rec.abstract, 'First line second line.');
});

test('parsePubmedArticle returns an empty doi when the record has no doi ArticleId', () => {
  // Arrange
  const xml = `<PubmedArticle><MedlineCitation><PMID>1</PMID></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">1</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`;

  // Act
  const rec = parsePubmedArticle(xml);

  // Assert
  assert.equal(rec.doi, '');
});

test('parsePubmedArticle returns a null year when the record has no JournalIssue', () => {
  // Arrange
  const xml = `<PubmedArticle><MedlineCitation><PMID>1</PMID><Article><ArticleTitle>No journal issue.</ArticleTitle></Article></MedlineCitation></PubmedArticle>`;

  // Act
  const rec = parsePubmedArticle(xml);

  // Assert
  assert.equal(rec.year, null);
});

test('parsePubmedArticle returns an empty pmid when the record has no PMID element', () => {
  // Arrange
  const xml = `<PubmedArticle><MedlineCitation><Article><ArticleTitle>Orphan.</ArticleTitle></Article></MedlineCitation></PubmedArticle>`;

  // Act
  const rec = parsePubmedArticle(xml);

  // Assert
  assert.equal(rec.pmid, '');
});

// ── fetchPubMedRecords ──────────────────────────────────────────────────────

test('fetchPubMedRecords requests every valid id in one efetch call with the PubMed user agent', async () => {
  // Arrange
  const calls = [];
  const fetchFn = async (url, opts) => { calls.push({ url: String(url), opts }); return okXml(''); };

  // Act
  await fetchPubMedRecords(['111', '222'], fetchFn);

  // Assert
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${EUTILS}/efetch.fcgi?db=pubmed&id=111,222&retmode=xml`);
  assert.equal(calls[0].opts.headers['User-Agent'], 'VanceHealthHub/1.0');
});

test('fetchPubMedRecords returns records keyed by PMID', async () => {
  // Arrange
  const fetchFn = async () => okXml(ARTICLE_XML + '\n' + SECOND_ARTICLE_XML);

  // Act
  const out = await fetchPubMedRecords(['12345678', '222'], fetchFn);

  // Assert
  assert.deepEqual(Object.keys(out).sort(), ['12345678', '222']);
  assert.equal(out['12345678'].title, 'A trial of something.');
  assert.equal(out['222'].title, 'Second');
});

test('fetchPubMedRecords drops a record that has no PMID', async () => {
  // Arrange
  const fetchFn = async () => okXml(`<PubmedArticle><MedlineCitation><Article><ArticleTitle>Orphan.</ArticleTitle></Article></MedlineCitation></PubmedArticle>`);

  // Act
  const out = await fetchPubMedRecords(['5'], fetchFn);

  // Assert
  assert.deepEqual(out, {});
});

test('fetchPubMedRecords returns an empty object when the response is not OK, even if the body holds a record', async () => {
  // Arrange
  const fetchFn = async () => ({ ok: false, status: 500, text: async () => ARTICLE_XML });

  // Act
  const out = await fetchPubMedRecords(['12345678'], fetchFn);

  // Assert
  assert.deepEqual(out, {});
});

test('fetchPubMedRecords returns an empty object when fetch throws', async () => {
  // Arrange
  const fetchFn = async () => { throw new Error('socket hang up'); };

  // Act
  const out = await fetchPubMedRecords(['12345678'], fetchFn);

  // Assert
  assert.deepEqual(out, {});
});

test('fetchPubMedRecords returns an empty object when the body is not PubMed XML', async () => {
  // Arrange
  const fetchFn = async () => okXml('<html><body>Service unavailable</body></html>');

  // Act
  const out = await fetchPubMedRecords(['12345678'], fetchFn);

  // Assert
  assert.deepEqual(out, {});
});

test('fetchPubMedRecords returns an empty object when reading the body throws', async () => {
  // Arrange
  const fetchFn = async () => ({ ok: true, status: 200, text: async () => { throw new Error('body stream closed'); } });

  // Act
  const out = await fetchPubMedRecords(['12345678'], fetchFn);

  // Assert
  assert.deepEqual(out, {});
});

test('fetchPubMedRecords ignores ids that are not plain digits', async () => {
  // Arrange
  const calls = [];
  const fetchFn = async (url) => { calls.push(String(url)); return okXml(''); };

  // Act
  await fetchPubMedRecords(['123', 'abc', '12; 99', ''], fetchFn);

  // Assert
  assert.deepEqual(calls, [`${EUTILS}/efetch.fcgi?db=pubmed&id=123&retmode=xml`]);
});

test('fetchPubMedRecords makes no request when no id is valid', async () => {
  // Arrange
  const calls = [];
  const fetchFn = async (url) => { calls.push(String(url)); return okXml(''); };

  // Act
  const out = await fetchPubMedRecords(['abc', '-4'], fetchFn);

  // Assert
  assert.deepEqual(calls, []);
  assert.deepEqual(out, {});
});

test('fetchPubMedRecords makes no request for a missing id list', async () => {
  // Arrange
  const calls = [];
  const fetchFn = async (url) => { calls.push(String(url)); return okXml(''); };

  // Act
  const out = await fetchPubMedRecords(undefined, fetchFn);

  // Assert
  assert.deepEqual(calls, []);
  assert.deepEqual(out, {});
});

test('fetchPubMedRecords requests a numeric id once when it is repeated', async () => {
  // Arrange
  const calls = [];
  const fetchFn = async (url) => { calls.push(String(url)); return okXml(''); };

  // Act
  await fetchPubMedRecords([123, '123'], fetchFn);

  // Assert
  assert.deepEqual(calls, [`${EUTILS}/efetch.fcgi?db=pubmed&id=123&retmode=xml`]);
});

// ── pmidFromDoi ─────────────────────────────────────────────────────────────

test('pmidFromDoi returns the PMID when exactly one record matches', async () => {
  // Arrange
  const fetchFn = async () => jsonResponse(true, { esearchresult: { idlist: ['98765'] } });

  // Act
  const pmid = await pmidFromDoi('10.1234/abc', fetchFn);

  // Assert
  assert.equal(pmid, '98765');
});

test('pmidFromDoi returns an empty string when no record matches', async () => {
  // Arrange
  const fetchFn = async () => jsonResponse(true, { esearchresult: { idlist: [] } });

  // Act
  const pmid = await pmidFromDoi('10.1234/abc', fetchFn);

  // Assert
  assert.equal(pmid, '');
});

test('pmidFromDoi returns an empty string when more than one record matches', async () => {
  // Arrange
  const fetchFn = async () => jsonResponse(true, { esearchresult: { idlist: ['1', '2'] } });

  // Act
  const pmid = await pmidFromDoi('10.1234/abc', fetchFn);

  // Assert
  assert.equal(pmid, '');
});

test('pmidFromDoi searches the DOI in the AID field', async () => {
  // Arrange
  const calls = [];
  const fetchFn = async (url) => { calls.push(String(url)); return jsonResponse(true, { esearchresult: { idlist: [] } }); };

  // Act
  await pmidFromDoi('10.1234/abc', fetchFn);

  // Assert
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith(`${EUTILS}/esearch.fcgi?db=pubmed&term=`), calls[0]);
  assert.ok(calls[0].includes(encodeURIComponent('10.1234/abc[AID]')), calls[0]);
});

test('pmidFromDoi makes no request for an empty doi', async () => {
  // Arrange
  const calls = [];
  const fetchFn = async (url) => { calls.push(String(url)); return jsonResponse(true, { esearchresult: { idlist: ['1'] } }); };

  // Act
  const pmid = await pmidFromDoi('', fetchFn);

  // Assert
  assert.deepEqual(calls, []);
  assert.equal(pmid, '');
});

test('pmidFromDoi returns an empty string when the search response is not OK, even with an id in the body', async () => {
  // Arrange
  const fetchFn = async () => jsonResponse(false, { esearchresult: { idlist: ['98765'] } });

  // Act
  const pmid = await pmidFromDoi('10.1234/abc', fetchFn);

  // Assert
  assert.equal(pmid, '');
});

test('pmidFromDoi returns an empty string when fetch throws', async () => {
  // Arrange
  const fetchFn = async () => { throw new Error('ENOTFOUND eutils'); };

  // Act
  const pmid = await pmidFromDoi('10.1234/abc', fetchFn);

  // Assert
  assert.equal(pmid, '');
});

test('pmidFromDoi returns an empty string when the response has no idlist', async () => {
  // Arrange
  const fetchFn = async () => jsonResponse(true, { unexpected: true });

  // Act
  const pmid = await pmidFromDoi('10.1234/abc', fetchFn);

  // Assert
  assert.equal(pmid, '');
});

// ── pmidFromUrl ─────────────────────────────────────────────────────────────

test('pmidFromUrl reads the PMID from a PubMed URL with a trailing slash', () => {
  assert.equal(pmidFromUrl('https://pubmed.ncbi.nlm.nih.gov/12345678/'), '12345678');
});

test('pmidFromUrl reads the PMID from a PubMed URL without a trailing slash', () => {
  assert.equal(pmidFromUrl('https://pubmed.ncbi.nlm.nih.gov/12345678'), '12345678');
});

test('pmidFromUrl returns an empty string for a DOI URL', () => {
  assert.equal(pmidFromUrl('https://doi.org/10.1234/abc'), '');
});

test('pmidFromUrl returns an empty string for an empty or missing url', () => {
  assert.equal(pmidFromUrl(''), '');
  assert.equal(pmidFromUrl(undefined), '');
  assert.equal(pmidFromUrl(null), '');
});

test('pmidFromUrl returns an empty string for a PubMed search page with no id', () => {
  assert.equal(pmidFromUrl('https://pubmed.ncbi.nlm.nih.gov/?term=gut'), '');
});

test('pmidFromUrl reads only from the PubMed host, not from a lookalike URL', () => {
  assert.equal(pmidFromUrl('https://evil.example/pubmed.ncbi.nlm.nih.gov/999/'), '');
});

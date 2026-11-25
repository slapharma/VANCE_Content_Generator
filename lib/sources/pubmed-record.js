// lib/sources/pubmed-record.js
//
// Fetch the real PubMed record (abstract + citation fields) for a PMID.
// esummary returns no abstract, so a paper added from a PubMed search used to
// reach the generator as a title only. The model then wrote endpoints, sample
// sizes and safety results from memory. This module closes that gap.

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const HEADERS = { 'User-Agent': 'VanceHealthHub/1.0' };

// An abstract shorter than this cannot carry endpoints and results.
export const MIN_ABSTRACT_CHARS = 400;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

// An out-of-range numeric entity must not throw and lose the whole batch.
function fromCode(n) {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => fromCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => fromCode(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, n) => ENTITIES[n]);
}

function text(xml) {
  // Keep exponents and subscripts: "10<sup>9</sup>/L" must not become "109/L".
  const marked = xml
    .replace(/<sup>([\s\S]*?)<\/sup>/g, '^$1')
    .replace(/<sub>([\s\S]*?)<\/sub>/g, '_$1');
  return decode(marked.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function firstTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? text(m[1]) : '';
}

/** Parse one <PubmedArticle> block into a plain record. Pure; exported for tests. */
export function parsePubmedArticle(xml) {
  const pmid = firstTag(xml.match(/<MedlineCitation[\s\S]*?<\/PMID>/)?.[0] ?? '', 'PMID');
  const parts = [];
  // Only the main <Abstract>: <OtherAbstract> holds publisher or translated summaries.
  const abstractXml = xml.match(/<Abstract>([\s\S]*?)<\/Abstract>/)?.[1] ?? '';
  for (const m of abstractXml.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)) {
    const label = m[1].match(/Label="([^"]*)"/)?.[1];
    const body = text(m[2]);
    if (body) parts.push(label ? `${decode(label)}: ${body}` : body);
  }
  // The paper's own DOI sits before the cited papers' <ReferenceList>.
  const own = xml.split('<ReferenceList')[0];
  const doi = text(own.match(/<ArticleId IdType="doi">([\s\S]*?)<\/ArticleId>/)?.[1] ?? '');
  return {
    pmid,
    title: firstTag(xml, 'ArticleTitle'),
    abstract: parts.join('\n'),
    journal: firstTag(xml, 'Title'),
    year: Number(firstTag(xml.match(/<JournalIssue[\s\S]*?<\/JournalIssue>/)?.[0] ?? '', 'Year')) || null,
    volume: firstTag(xml, 'Volume'),
    issue: firstTag(xml, 'Issue'),
    pages: firstTag(xml, 'MedlinePgn'),
    doi,
  };
}

/** Fetch records for PMIDs. Returns { [pmid]: record }. Never throws: a failure returns {}. */
export async function fetchPubMedRecords(pmids, fetchFn = fetch) {
  const ids = [...new Set((pmids || []).map(String).filter(p => /^\d+$/.test(p)))];
  if (!ids.length) return {};
  try {
    const res = await fetchFn(`${EUTILS}/efetch.fcgi?db=pubmed&id=${ids.join(',')}&retmode=xml`, { headers: HEADERS });
    if (!res.ok) return {};
    const xml = await res.text();
    const out = {};
    for (const m of xml.matchAll(/<PubmedArticle>[\s\S]*?<\/PubmedArticle>/g)) {
      const rec = parsePubmedArticle(m[0]);
      if (rec.pmid) out[rec.pmid] = rec;
    }
    return out;
  } catch {
    return {};
  }
}

/** Find the PMID for a DOI. Returns '' when there is no single match. */
export async function pmidFromDoi(doi, fetchFn = fetch) {
  if (!doi) return '';
  try {
    const res = await fetchFn(`${EUTILS}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(`${doi}[AID]`)}&retmode=json`, { headers: HEADERS });
    if (!res.ok) return '';
    const ids = (await res.json()).esearchresult?.idlist ?? [];
    return ids.length === 1 ? String(ids[0]) : '';
  } catch {
    return '';
  }
}

/** Pull a PMID out of a paper's url field (pubmed.ncbi.nlm.nih.gov/<pmid>/). */
export function pmidFromUrl(url) {
  return String(url || '').match(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/)?.[1] ?? '';
}

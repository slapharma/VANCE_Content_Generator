// lib/sources/title-lookup.js
//
// A Clinical Review rule can be fed from a title-only spreadsheet upload. Such a
// row has no abstract, so the generator wrote the whole review from memory:
// wrong references, reversed findings. This module finds the real PubMed record
// for the title, so the same source guards as a bibliography paper can apply.

import { MIN_ABSTRACT_CHARS, fetchPubMedRecords } from './pubmed-record.js';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const HEADERS = { 'User-Agent': 'VanceHealthHub/1.0' };

/**
 * Lower-case letters and digits only, with accents folded, so "Study - A Trial."
 * equals "studyatrial". Letters with no decomposition (such as the Polish l with
 * stroke) are kept, so a title that differs only by one never passes as equal.
 */
export function normaliseTitle(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Start of the error guardedItemFromTitle throws, so the run loop can recognise it. */
export const TITLE_REFUSAL = /^Could not find the published paper for /;

/** True for a rule that writes Clinical Reviews. */
export function isClinicalReviewRule(rule) {
  return rule?.category === 'clinical-reviews' || rule?.generation?.template === 'clinical-reviews';
}

/**
 * Candidate PubMed IDs for a title. The words are matched in the Title field but
 * NOT as a quoted phrase: PubMed's phrase index has no entry for most full titles,
 * so a quoted search returns nothing for a paper that is there. The caller must
 * compare each candidate's real title. Returns [] when PubMed was searched and found
 * nothing, and null when it could not be searched (error, non-OK, no idlist), so an
 * outage is never read as "this paper does not exist".
 */
export async function pmidsFromTitle(title, fetchFn = fetch) {
  const clean = String(title || '').replace(/[\[\]"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  try {
    const term = encodeURIComponent(`${clean}[Title]`);
    const res = await fetchFn(`${EUTILS}/esearch.fcgi?db=pubmed&term=${term}&retmax=5&retmode=json`, { headers: HEADERS });
    if (!res.ok) return null;
    const idlist = (await res.json()).esearchresult?.idlist;
    return Array.isArray(idlist) ? idlist.map(String) : null;
  } catch {
    return null;
  }
}

/**
 * Turn a title-only item into a guarded bibliography-style item, or throw.
 * Never returns an item without a real abstract and a citation record.
 */
export async function guardedItemFromTitle(item, fetchFn = fetch) {
  const fail = why => {
    throw new Error(
      `Could not find the published paper for "${item.title}" (${why}). ` +
      `A Clinical Review is not written from a title alone, because the results would be invented. ` +
      `Add the paper to a Bibliography with its abstract, then re-run.`
    );
  };

  // An outage is not a verdict on the paper. These errors do not match TITLE_REFUSAL,
  // so the run loop does not move the row to the back of the queue for them.
  const unavailable = () => {
    throw new Error(`PubMed could not be searched for "${item.title}". Try the run again later.`);
  };

  const pmids = await pmidsFromTitle(item.title, fetchFn);
  if (pmids === null) unavailable();
  if (!pmids.length) fail('PubMed has no record matching the title words');
  const records = await fetchPubMedRecords(pmids, fetchFn);
  if (!Object.keys(records).length) unavailable();
  // Only a record whose own title equals the row title counts. Exactly one must.
  const same = Object.values(records).filter(r => normaliseTitle(r.title) === normaliseTitle(item.title));
  if (!same.length) fail('no PubMed record has exactly this title');
  if (same.length > 1) fail('more than one PubMed record has this title');
  const rec = same[0];
  const abstract = (rec.abstract || '').trim();
  if (abstract.length < MIN_ABSTRACT_CHARS) fail('PubMed has no abstract for it');

  const citation = [
    `Title: ${rec.title}`,
    rec.authors?.length ? `Authors: ${rec.authors.join(', ')}` : '',
    rec.journal ? `Journal: ${rec.journal}` : '',
    rec.year ? `Year: ${rec.year}` : '',
    rec.volume ? `Volume: ${rec.volume}` : '',
    rec.issue ? `Issue: ${rec.issue}` : '',
    rec.pages ? `Pages: ${rec.pages}` : '',
    `PMID: ${rec.pmid}`,
    rec.doi ? `DOI: ${rec.doi}` : '',
  ].filter(Boolean).join('\n');

  return {
    ...item,
    titleOnly: false,
    sourceType: 'bibliography',
    rawText: `CITATION RECORD:\n${citation}\n\nABSTRACT:\n${abstract}`,
    hasSourceText: true,
    sourceHasFullText: false,
    bibPaper: { doi: rec.doi || '', authors: rec.authors || [], pmid: rec.pmid },
  };
}

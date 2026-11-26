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

/** Find the single PubMed ID whose title is exactly this title. Returns '' otherwise. */
export async function pmidFromTitle(title, fetchFn = fetch) {
  const clean = String(title || '').replace(/[\[\]"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  try {
    const term = encodeURIComponent(`"${clean}"[Title]`);
    const res = await fetchFn(`${EUTILS}/esearch.fcgi?db=pubmed&term=${term}&retmode=json`, { headers: HEADERS });
    if (!res.ok) return '';
    const ids = (await res.json()).esearchresult?.idlist ?? [];
    return ids.length === 1 ? String(ids[0]) : '';
  } catch {
    return '';
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

  const pmid = await pmidFromTitle(item.title, fetchFn);
  if (!pmid) fail('PubMed has no single exact title match');
  const rec = (await fetchPubMedRecords([pmid], fetchFn))[pmid];
  if (!rec) fail('PubMed could not be reached');
  if (normaliseTitle(rec.title) !== normaliseTitle(item.title)) fail('the PubMed title differs');
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

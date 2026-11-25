// lib/sources/bibliography.js
import { kv } from '../kv.js';
import { MIN_ABSTRACT_CHARS, fetchPubMedRecords, pmidFromDoi, pmidFromUrl } from './pubmed-record.js';

/**
 * Fetch papers from a bibliography as automation source items.
 *
 * source.mode:
 *   'all'    — return all unprocessed papers
 *   'daily'  — return the next unprocessed paper (round-robin)
 *   'on_new' — return papers added since lastRunAt
 *
 * Options:
 *   forceAll: bool — bypass the `processed` filter so manual re-runs / re-process
 *                    selected flows can pick up already-generated papers.
 */
export async function fetchBibliographyPapers(source, lastRunAt, opts = {}) {
  const { bibId, mode = 'daily' } = source;
  if (!bibId) throw new Error('Bibliography source requires bibId');

  const bib = await kv.get(`bibliography:${bibId}`);
  if (!bib) throw new Error(`Bibliography ${bibId} not found`);

  const paperIds = await kv.lrange(`bibliography:papers:${bibId}`, 0, -1);
  if (!paperIds.length) {
    throw new Error(`Bibliography "${bib.name}" is empty — add papers to it before running this rule.`);
  }

  const papers = (await Promise.all(paperIds.map(id => kv.get(`bibliography:paper:${id}`)))).filter(Boolean);
  const totalCount = papers.length;
  const processedCount = papers.filter(p => p.processed).length;

  let selected = [];
  // On manual / re-process runs we ignore the processed filter; mode still
  // controls how many papers come back (daily = 1, all = all eligible).
  const eligibleFilter = opts.forceAll ? (() => true) : (p => !p.processed);

  if (mode === 'all') {
    selected = papers.filter(eligibleFilter);
  } else if (mode === 'daily') {
    const eligible = papers.filter(eligibleFilter);
    // Daily-mode normally returns just the next eligible paper. Under
    // forceAll (Re-process selected from the Source modal) we return ALL
    // eligible papers so the downstream forceFiles title-filter in run.js
    // can match the specific paper(s) the user picked — otherwise daily
    // would surface only papers[0] and any other selection would be filtered
    // out by the title allow-list, processing zero items.
    // Not forced: keep the whole ordered list; the loop below picks the first
    // paper that has an abstract. Papers that already failed go to the back.
    const failedLast = [...eligible.filter(p => !p.lastFailure), ...eligible.filter(p => p.lastFailure)];
    selected = opts.forceAll ? eligible : failedLast;
  } else if (mode === 'on_new') {
    if (lastRunAt && !opts.forceAll) {
      const since = new Date(lastRunAt);
      selected = papers.filter(p => new Date(p.addedAt) > since);
    } else {
      selected = papers.filter(eligibleFilter);
    }
  }

  if (!selected.length && processedCount === totalCount && totalCount > 0) {
    throw new Error(
      `Bibliography "${bib.name}" has no unprocessed papers — all ${totalCount} have already been generated from. ` +
      `Mark a paper as unprocessed in the Bibliography editor to re-run it, or add new papers.`
    );
  }

  const buildItem = async stored => {
    const paper = await withPubMedRecord(stored, opts.fetchFn);
    const abstract = (paper.abstract || '').trim();
    const citation = [
      `Title: ${paper.title}`,
      paper.authors?.length ? `Authors: ${paper.authors.join(', ')}` : '',
      paper.journal ? `Journal: ${paper.journal}` : '',
      paper.year ? `Year: ${paper.year}` : '',
      paper.volume ? `Volume: ${paper.volume}` : '',
      paper.issue ? `Issue: ${paper.issue}` : '',
      paper.pages ? `Pages: ${paper.pages}` : '',
      paper.pmid ? `PMID: ${paper.pmid}` : '',
      paper.doi ? `DOI: ${paper.doi}` : '',
    ].filter(Boolean).join('\n');
    return {
      title: paper.title || 'Untitled paper',
      url: paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : ''),
      rawText: `CITATION RECORD:\n${citation}\n\nABSTRACT:\n${abstract}`,
      sourceType: 'bibliography',
      // run.js refuses to generate when this is false: no abstract means the
      // model would write endpoints and results from memory.
      hasSourceText: abstract.length >= minAbstract(paper),
      sourceHasFullText: false,
      bibPaper: { doi: paper.doi || '', authors: paper.authors || [], pmid: paper.pmid || '' },
      pubDate: new Date(paper.addedAt),
      paperId: paper.id,
      _bibMeta: { bibId, bibName: bib.name, paperId: paper.id },
    };
  };

  // Sequential, not parallel: each paper costs up to three NCBI calls and
  // NCBI rate-limits unauthenticated clients.
  if (mode === 'daily' && !opts.forceAll) {
    // Daily mode returns one paper. Skip papers that have no abstract so one
    // bad paper cannot block every later one on every run.
    const skipped = [];
    for (const stored of selected.slice(0, MAX_DAILY_LOOKUPS)) {
      const item = await buildItem(stored);
      if (item.hasSourceText) return [item];
      skipped.push(item.title);
    }
    if (skipped.length) {
      throw new Error(
        `No paper in bibliography "${bib.name}" has an abstract to write from (checked ${skipped.length}: ${skipped.join('; ')}). ` +
        `PubMed returned none, or could not be reached. Paste the abstract into the paper in the Bibliography editor, or try again later.`
      );
    }
    return [];
  }

  const items = [];
  for (const stored of selected) items.push(await buildItem(stored));
  return items;
}

const MAX_DAILY_LOOKUPS = 8;

// A pasted abstract may be a short report or letter, so it gets a lower floor
// than text fetched from PubMed.
function minAbstract(paper) {
  return paper.source === 'manual' ? 150 : MIN_ABSTRACT_CHARS;
}

/**
 * Fill in the abstract and citation fields from PubMed when the stored paper
 * lacks them (every paper added from a PubMed search before this fix did), and
 * save them back so the lookup happens once. Falls back to the stored record
 * when PubMed cannot be reached.
 */
async function withPubMedRecord(paper, fetchFn) {
  if ((paper.abstract || '').trim().length >= minAbstract(paper) && paper.pmid) return paper;
  const pmid = paper.pmid || pmidFromUrl(paper.url) || await pmidFromDoi(paper.doi, fetchFn);
  if (!pmid) return paper;
  const rec = (await fetchPubMedRecords([pmid], fetchFn))[pmid];
  if (!rec) return { ...paper, pmid };
  const merged = {
    ...paper,
    pmid,
    // Keep a stored abstract only if it is long enough to be one; a short note must not block PubMed's.
    abstract: (paper.abstract || '').trim().length >= minAbstract(paper) ? paper.abstract : (rec.abstract || paper.abstract),
    volume: paper.volume || rec.volume,
    issue: paper.issue || rec.issue,
    pages: paper.pages || rec.pages,
    doi: paper.doi || rec.doi,
  };
  // Write back only the enriched fields onto a fresh read, so an edit or a
  // processed flag changed since this run started is not overwritten.
  try {
    const key = `bibliography:paper:${paper.id}`;
    const current = await kv.get(key);
    if (current) {
      await kv.set(key, {
        ...current,
        pmid: current.pmid || merged.pmid,
        abstract: (current.abstract || '').trim().length >= minAbstract(current) ? current.abstract : merged.abstract,
        volume: current.volume || merged.volume,
        issue: current.issue || merged.issue,
        pages: current.pages || merged.pages,
        doi: current.doi || merged.doi,
      });
    }
  } catch { /* non-fatal: next run refetches */ }
  return merged;
}

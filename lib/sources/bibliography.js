// lib/sources/bibliography.js
import { kv } from '../kv.js';

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
    if (opts.forceAll) selected = eligible;
    else if (eligible.length) selected = [eligible[0]];
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

  return selected.map(paper => ({
    title: paper.title || 'Untitled paper',
    url: paper.url || (paper.doi ? `https://doi.org/${paper.doi}` : ''),
    rawText: [
      paper.title,
      paper.authors?.join(', '),
      paper.journal ? `${paper.journal}${paper.year ? ` (${paper.year})` : ''}` : '',
      paper.abstract,
      paper.doi ? `DOI: ${paper.doi}` : '',
      paper.url ? `URL: ${paper.url}` : '',
    ].filter(Boolean).join('\n\n'),
    sourceType: 'bibliography',
    pubDate: new Date(paper.addedAt),
    paperId: paper.id,
    _bibMeta: { bibId, bibName: bib.name, paperId: paper.id },
  }));
}

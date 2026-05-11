// lib/sources/bibliography.js
import { kv } from '../kv.js';

/**
 * Fetch papers from a bibliography as automation source items.
 *
 * source.mode:
 *   'all'    — return all unprocessed papers
 *   'daily'  — return the next unprocessed paper (round-robin)
 *   'on_new' — return papers added since lastRunAt
 */
export async function fetchBibliographyPapers(source, lastRunAt) {
  const { bibId, mode = 'daily' } = source;
  if (!bibId) throw new Error('Bibliography source requires bibId');

  const bib = await kv.get(`bibliography:${bibId}`);
  if (!bib) throw new Error(`Bibliography ${bibId} not found`);

  const paperIds = await kv.lrange(`bibliography:papers:${bibId}`, 0, -1);
  if (!paperIds.length) return [];

  const papers = (await Promise.all(paperIds.map(id => kv.get(`bibliography:paper:${id}`)))).filter(Boolean);

  let selected = [];

  if (mode === 'all') {
    selected = papers.filter(p => !p.processed);
  } else if (mode === 'daily') {
    const unprocessed = papers.filter(p => !p.processed);
    if (unprocessed.length) selected = [unprocessed[0]];
  } else if (mode === 'on_new') {
    if (lastRunAt) {
      const since = new Date(lastRunAt);
      selected = papers.filter(p => new Date(p.addedAt) > since);
    } else {
      selected = papers.filter(p => !p.processed);
    }
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

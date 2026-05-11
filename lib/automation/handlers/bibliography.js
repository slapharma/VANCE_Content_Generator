// lib/automation/handlers/bibliography.js
import { randomUUID } from 'crypto';
import { kv } from '../../kv.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function bibKey(id) { return `bibliography:${id}`; }
function paperKey(id) { return `bibliography:paper:${id}`; }
function papersListKey(bibId) { return `bibliography:papers:${bibId}`; }
const INDEX_KEY = 'bibliography:index';

function buildBibliography(data) {
  if (!data.name) throw new Error('name is required');
  const now = new Date().toISOString();
  return {
    id: `bib_${randomUUID()}`,
    name: data.name,
    description: data.description ?? '',
    indication: data.indication ?? 'IBD',
    bibliographyType: data.bibliographyType ?? 'clinical',
    createdAt: now,
    updatedAt: now,
    paperCount: 0,
    stats: { automationsCreated: 0, articlesGenerated: 0 },
  };
}

function buildPaper(data, bibId) {
  const now = new Date().toISOString();
  return {
    id: `paper_${randomUUID()}`,
    bibId,
    title: data.title ?? '',
    authors: Array.isArray(data.authors) ? data.authors : (data.authors ?? '').split(',').map(a => a.trim()).filter(Boolean),
    journal: data.journal ?? '',
    year: data.year ? Number(data.year) : null,
    doi: data.doi ?? '',
    url: data.url ?? '',
    abstract: data.abstract ?? '',
    source: data.source ?? 'manual',
    addedAt: now,
    processed: false,
    note: data.note ?? '',
  };
}

// ── PubMed search ────────────────────────────────────────────────────────────

async function searchPubMed(query, maxResults = 20) {
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
  const searchUrl = `${base}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${maxResults}&retmode=json`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) throw new Error(`PubMed search failed: ${searchRes.status}`);
  const searchData = await searchRes.json();
  const ids = searchData.esearchresult?.idlist ?? [];
  if (!ids.length) return [];

  const summaryUrl = `${base}/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`;
  const summaryRes = await fetch(summaryUrl);
  if (!summaryRes.ok) throw new Error(`PubMed summary failed: ${summaryRes.status}`);
  const summaryData = await summaryRes.json();
  const result = summaryData.result ?? {};

  return ids.map(pmid => {
    const r = result[pmid];
    if (!r) return null;
    const authors = (r.authors ?? []).map(a => a.name);
    const doi = (r.articleids ?? []).find(a => a.idtype === 'doi')?.value ?? '';
    return {
      pmid,
      title: r.title ?? '',
      authors,
      journal: r.fulljournalname ?? r.source ?? '',
      year: r.pubdate ? parseInt(r.pubdate) : null,
      doi,
      url: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      abstract: '', // esummary doesn't return abstracts; kept empty
      source: 'pubmed',
    };
  }).filter(Boolean);
}

// ── Semantic Scholar search ──────────────────────────────────────────────────

async function searchSemanticScholar(query, maxResults = 20) {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${maxResults}&fields=title,authors,journal,year,externalIds,url,abstract,citationCount`;
  const res = await fetch(url, { headers: { 'User-Agent': 'GastroHealthHub/1.0' } });
  if (!res.ok) throw new Error(`Semantic Scholar search failed: ${res.status}`);
  const data = await res.json();
  return (data.data ?? []).map(paper => {
    const doi = paper.externalIds?.DOI ?? '';
    const pmid = paper.externalIds?.PubMed ?? '';
    return {
      paperId: paper.paperId,
      pmid: pmid || undefined,
      title: paper.title ?? '',
      authors: (paper.authors ?? []).map(a => a.name),
      journal: paper.journal?.name ?? '',
      year: paper.year ?? null,
      doi,
      url: doi ? `https://doi.org/${doi}` : paper.url ?? '',
      abstract: paper.abstract ?? '',
      citationCount: paper.citationCount ?? 0,
      source: 'semantic_scholar',
    };
  });
}

// ── Route dispatcher ─────────────────────────────────────────────────────────

export default async function handler(req, res, slug) {
  // slug = ['bibliography'] or ['bibliography', id] or ['bibliography', id, 'papers'] etc.
  const [, second, third, fourth] = slug;

  // POST /bibliography/search — literature search proxy (PubMed or Semantic Scholar)
  if (second === 'search' && req.method === 'POST') {
    try {
      const { query, maxResults, source } = req.body;
      if (!query) return res.status(400).json({ error: 'query is required' });
      const limit = Math.min(maxResults ?? 20, 50);
      const results = source === 'semantic_scholar'
        ? await searchSemanticScholar(query, limit)
        : await searchPubMed(query, limit);
      return res.status(200).json(results);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // GET /bibliography — list all
  if (!second && req.method === 'GET') {
    const ids = await kv.lrange(INDEX_KEY, 0, -1);
    if (!ids.length) return res.status(200).json([]);
    const bibs = await Promise.all(ids.map(id => kv.get(bibKey(id))));
    return res.status(200).json(bibs.filter(Boolean).reverse());
  }

  // POST /bibliography — create
  if (!second && req.method === 'POST') {
    let bib;
    try { bib = buildBibliography(req.body); }
    catch (err) { return res.status(400).json({ error: err.message }); }

    // If papers included in body, add them
    const papers = req.body.papers ?? [];
    for (const p of papers) {
      const paper = buildPaper(p, bib.id);
      await kv.set(paperKey(paper.id), paper);
      await kv.lpush(papersListKey(bib.id), paper.id);
    }
    bib.paperCount = papers.length;
    await kv.set(bibKey(bib.id), bib);
    await kv.lpush(INDEX_KEY, bib.id);
    return res.status(201).json(bib);
  }

  // Routes with an ID (bib_xxx or _ wildcard for paper-only operations)
  if (second && (second.startsWith('bib_') || second === '_')) {
    const bibId = second;

    // ── Paper sub-routes ─────────────────────────────────────────────────
    if (third === 'papers') {
      // POST /bibliography/{id}/papers — add papers
      if (!fourth && req.method === 'POST') {
        const bib = await kv.get(bibKey(bibId));
        if (!bib) return res.status(404).json({ error: 'Bibliography not found' });
        const papers = req.body.papers ?? [];
        if (!papers.length) return res.status(400).json({ error: 'papers array required' });
        const added = [];
        for (const p of papers) {
          const paper = buildPaper(p, bibId);
          await kv.set(paperKey(paper.id), paper);
          await kv.lpush(papersListKey(bibId), paper.id);
          added.push(paper);
        }
        bib.paperCount = (bib.paperCount ?? 0) + added.length;
        bib.updatedAt = new Date().toISOString();
        await kv.set(bibKey(bibId), bib);
        return res.status(201).json({ added: added.length, papers: added });
      }

      // PATCH /bibliography/{id}/papers/{paperId} — update paper fields (e.g. toggle processed)
      if (fourth && req.method === 'PATCH') {
        const paper = await kv.get(paperKey(fourth));
        if (!paper) return res.status(404).json({ error: 'Paper not found' });
        const allowed = ['processed', 'note'];
        for (const key of allowed) {
          if (req.body[key] !== undefined) paper[key] = req.body[key];
        }
        await kv.set(paperKey(fourth), paper);
        return res.status(200).json(paper);
      }

      // DELETE /bibliography/{id}/papers/{paperId}
      if (fourth && req.method === 'DELETE') {
        const bib = await kv.get(bibKey(bibId));
        if (!bib) return res.status(404).json({ error: 'Bibliography not found' });
        await kv.del(paperKey(fourth));
        await kv.lrem(papersListKey(bibId), 0, fourth);
        bib.paperCount = Math.max((bib.paperCount ?? 1) - 1, 0);
        bib.updatedAt = new Date().toISOString();
        await kv.set(bibKey(bibId), bib);
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    }

    // GET /bibliography/{id} — get with papers
    if (req.method === 'GET') {
      const bib = await kv.get(bibKey(bibId));
      if (!bib) return res.status(404).json({ error: 'Bibliography not found' });
      const paperIds = await kv.lrange(papersListKey(bibId), 0, -1);
      let papers = [];
      if (paperIds.length) {
        papers = (await Promise.all(paperIds.map(id => kv.get(paperKey(id))))).filter(Boolean);
      }
      return res.status(200).json({ ...bib, papers });
    }

    // PATCH /bibliography/{id} — update metadata
    if (req.method === 'PATCH') {
      const bib = await kv.get(bibKey(bibId));
      if (!bib) return res.status(404).json({ error: 'Bibliography not found' });
      const allowed = ['name', 'description', 'indication', 'bibliographyType'];
      for (const key of allowed) {
        if (req.body[key] !== undefined) bib[key] = req.body[key];
      }
      bib.updatedAt = new Date().toISOString();
      await kv.set(bibKey(bibId), bib);
      return res.status(200).json(bib);
    }

    // DELETE /bibliography/{id} — cascade delete
    if (req.method === 'DELETE') {
      const paperIds = await kv.lrange(papersListKey(bibId), 0, -1);
      for (const pid of paperIds) await kv.del(paperKey(pid));
      await kv.del(papersListKey(bibId));
      await kv.del(bibKey(bibId));
      await kv.lrem(INDEX_KEY, 0, bibId);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  }

  return res.status(404).json({ error: 'Bibliography route not found' });
}

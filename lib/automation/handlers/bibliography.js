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
  const headers = { 'User-Agent': 'GastroHealthHub/1.0' };
  // Optional API key for higher rate limits (set SEMANTIC_SCHOLAR_API_KEY in Vercel env vars).
  if (process.env.SEMANTIC_SCHOLAR_API_KEY) headers['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;

  // Semantic Scholar's unauthenticated tier rate-limits ~1 req/sec globally — 429s are common.
  // Retry once after honouring Retry-After (or a 2s default), then surface a helpful error.
  let res = await fetch(url, { headers });
  if (res.status === 429) {
    const retryAfterSec = Number(res.headers.get('retry-after')) || 2;
    await new Promise(r => setTimeout(r, Math.min(retryAfterSec, 5) * 1000));
    res = await fetch(url, { headers });
  }
  if (res.status === 429) {
    throw new Error('Semantic Scholar is rate-limited right now. Try the PubMed database instead, or wait a few seconds and retry.');
  }
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

// ── Title sanity-check (PubMed + CrossRef fallback) ──────────────────────────

// Normalise a title for fuzzy comparison: lowercase, strip punctuation,
// collapse whitespace. Good enough to spot obvious matches without bringing
// in a Levenshtein lib.
function normaliseTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Token-overlap score in [0,1]. 1.0 ≈ identical, ≥0.7 is usually the same paper
// modulo punctuation/whitespace differences in indexing.
function titleSimilarity(a, b) {
  const A = new Set(normaliseTitle(a).split(' ').filter(w => w.length > 2));
  const B = new Set(normaliseTitle(b).split(' ').filter(w => w.length > 2));
  if (!A.size || !B.size) return 0;
  let hits = 0;
  for (const t of A) if (B.has(t)) hits++;
  return hits / Math.max(A.size, B.size);
}

async function pubmedTitleLookup(title) {
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
  const q = encodeURIComponent(`${title}[Title]`);
  const searchRes = await fetch(`${base}/esearch.fcgi?db=pubmed&term=${q}&retmax=3&retmode=json`);
  if (!searchRes.ok) return [];
  const searchData = await searchRes.json();
  const ids = searchData.esearchresult?.idlist ?? [];
  if (!ids.length) return [];
  const sumRes = await fetch(`${base}/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`);
  if (!sumRes.ok) return [];
  const sumData = await sumRes.json();
  const result = sumData.result ?? {};
  return ids.map(pmid => {
    const r = result[pmid];
    if (!r) return null;
    const doi = (r.articleids ?? []).find(a => a.idtype === 'doi')?.value ?? '';
    return {
      source: 'pubmed',
      id: pmid,
      title: r.title ?? '',
      year: r.pubdate ? parseInt(r.pubdate) : null,
      journal: r.fulljournalname ?? r.source ?? '',
      doi,
      url: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    };
  }).filter(Boolean);
}

async function crossrefTitleLookup(title) {
  const url = `https://api.crossref.org/works?query.title=${encodeURIComponent(title)}&rows=3`;
  const res = await fetch(url, { headers: { 'User-Agent': 'VanceContent/1.0 (mailto:cflack@slapharmagroup.com)' } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.message?.items ?? []).map(item => ({
    source: 'crossref',
    id: item.DOI || '',
    title: (item.title || [])[0] ?? '',
    year: item.issued?.['date-parts']?.[0]?.[0] ?? null,
    journal: (item['container-title'] || [])[0] ?? '',
    doi: item.DOI || '',
    url: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : ''),
  }));
}

async function verifyOne(input) {
  const title = String(input.title || '').trim();
  if (!title) return { status: 'skipped', reason: 'no title', matches: [] };

  // Run PubMed and CrossRef in parallel — keeps wall-clock per item to the
  // slower of the two (~1s) instead of summing both (~2s+) under fallback.
  // Each promise is wrapped to swallow errors so a single dead provider does
  // not poison the whole verification.
  const [pm, cr] = await Promise.all([
    pubmedTitleLookup(title).catch(() => []),
    crossrefTitleLookup(title).catch(() => []),
  ]);
  const matches = pm.concat(cr);

  if (!matches.length) return { status: 'not_found', matches: [] };

  // Score each match, sort desc.
  const scored = matches.map(m => ({ ...m, similarity: titleSimilarity(title, m.title) }))
    .sort((a, b) => b.similarity - a.similarity);
  const best = scored[0];
  let status;
  if (best.similarity >= 0.7) status = 'verified';
  else if (best.similarity >= 0.4) status = 'partial';
  else status = 'not_found';
  return { status, bestMatch: best, matches: scored };
}

// ── Route dispatcher ─────────────────────────────────────────────────────────

export default async function handler(req, res, slug) {
  // slug = ['bibliography'] or ['bibliography', id] or ['bibliography', id, 'papers'] etc.
  const [, second, third, fourth] = slug;

  // POST /bibliography/verify — batch title sanity-check against PubMed + CrossRef.
  // Body: { items: [{ title, year? }, ...] }  ⇒  { results: [{ status, bestMatch, matches }] }
  // status ∈ 'verified' | 'partial' | 'not_found' | 'skipped'
  if (second === 'verify' && req.method === 'POST') {
    try {
      const items = Array.isArray(req.body.items) ? req.body.items : [];
      if (!items.length) return res.status(400).json({ error: 'items array required' });
      if (items.length > 50) return res.status(400).json({ error: 'max 50 items per batch' });

      // Bounded concurrency keeps us under PubMed's ~3 req/sec limit. Each
      // verifyOne fans PubMed + CrossRef in parallel, so CONCURRENCY=5 means
      // ~10 outbound requests at a time — safe for the free tier.
      const results = new Array(items.length);
      const CONCURRENCY = 5;
      let cursor = 0;
      async function worker() {
        while (true) {
          const i = cursor++;
          if (i >= items.length) return;
          results[i] = await verifyOne(items[i]);
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      return res.status(200).json({ results });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

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

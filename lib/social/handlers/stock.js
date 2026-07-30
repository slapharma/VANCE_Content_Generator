// lib/social/handlers/stock.js
//
// Server-side stock photo search:
//
//   POST /api/social/stock          { query, provider, orientation, perPage }
//   POST /api/social/stock/track    { downloadLocation }
//
// Why this exists rather than the browser calling the providers directly: the hero
// picker in index.html does exactly that, which puts the Unsplash Access Key in a
// URL visible in dev tools. That gap is recorded in docs/learnings-from-alpha.md
// (2026-07-21) as an open item; every new image picker goes through here instead,
// and the key never leaves the server.
//
// Two Unsplash API guidelines are load-bearing here:
//
//   1. The download endpoint must be pinged when a photo is actually USED, not
//      when it merely appears in a result list. Searching therefore does not ping;
//      `/track` does, and the client calls it at the moment an operator picks an
//      image. Pinging on search would inflate every photographer's download count
//      with images nobody chose.
//   2. Attribution must travel with the photo. Every result carries photographer
//      name, profile URL and photo URL, and callers persist that alongside the
//      image so it can be rendered or stamped onto WP media later.
//
// Results are also filtered against the one-use-only stock ledger
// (lib/social/stock-ledger.js): a photo already used as an article hero or a promo
// cover is never offered again, on either provider. `hiddenUsed` in the response
// reports how many were withheld so the UI can say so rather than looking broken.

import { kv } from '../../kv.js';
import { PEXELS_API_KEY } from '../media.js';
import { filterUnusedStock } from '../stock-ledger.js';

const UTM = 'utm_source=vance_health_hub&utm_medium=referral';

/**
 * Resolve the Unsplash access key.
 *
 * It is set on the LLM Management page and stored in the `vance:hero-prompts` KV
 * record, NOT as an env var — the same place lib/social/media.js and the
 * automation run read it from. An env var still wins when present so a deployment
 * can override the stored value without a UI round-trip.
 */
async function unsplashKey() {
  if (process.env.UNSPLASH_ACCESS_KEY) return process.env.UNSPLASH_ACCESS_KEY;
  try {
    const rec = await kv.get('vance:hero-prompts');
    return rec?.unsplashKey || '';
  } catch {
    return '';
  }
}

/** Unsplash requires UTM parameters on every link back to the site. */
function withUtm(url) {
  if (!url) return null;
  return url + (url.includes('?') ? '&' : '?') + UTM;
}

async function searchUnsplash({ query, orientation, perPage, page }) {
  const accessKey = await unsplashKey();
  if (!accessKey) throw new Error('Unsplash is not set up. Add an access key on the LLM Management page, or use Pexels.');
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}`
    + `&per_page=${perPage}&page=${page}&orientation=${orientation}`
    + `&client_id=${encodeURIComponent(accessKey)}`;

  const resp = await fetch(url);
  if (resp.status === 403) {
    // The demo tier caps at 50 requests/hour across the whole app, and the 403 it
    // returns says nothing useful. Name it, because the alternative is an operator
    // concluding the feature is broken.
    throw new Error('Unsplash rate limit reached (50 requests/hour on the demo tier). Try Pexels, or wait for the hour to roll over.');
  }
  if (!resp.ok) throw new Error(`Unsplash returned ${resp.status}`);

  const data = await resp.json();
  const results = (data.results || []).map((p) => ({
    id: `unsplash_${p.id}`,
    provider: 'unsplash',
    url: p.urls?.regular || p.urls?.full || p.urls?.raw || null,
    thumb: p.urls?.small || p.urls?.thumb || null,
    width: p.width,
    height: p.height,
    alt: p.alt_description || p.description || '',
    photographer: p.user?.name || null,
    // The photographer's PROFILE, not the photo page — the guideline is specific
    // about which one the credit links to.
    photographerUrl: withUtm(p.user?.links?.html),
    sourceUrl: withUtm(p.links?.html),
    // Held so /track can ping it when this photo is actually chosen.
    downloadLocation: p.links?.download_location || null,
  })).filter((p) => p.url);

  return { results, hasMore: (data.total_pages || 0) > page };
}

async function searchPexels({ query, orientation, perPage, page }) {
  if (!PEXELS_API_KEY) throw new Error('Pexels is not set up (PEXELS_API_KEY)');
  const resp = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}`
      + `&per_page=${perPage}&page=${page}&orientation=${orientation}`,
    { headers: { Authorization: PEXELS_API_KEY } },
  );
  if (!resp.ok) throw new Error(`Pexels returned ${resp.status}`);

  const data = await resp.json();
  const results = (data.photos || []).map((p) => ({
    id: `pexels_${p.id}`,
    provider: 'pexels',
    url: p.src?.large2x || p.src?.large || p.src?.original || null,
    thumb: p.src?.medium || p.src?.small || null,
    width: p.width,
    height: p.height,
    alt: p.alt || '',
    photographer: p.photographer || null,
    photographerUrl: p.photographer_url || null,
    sourceUrl: p.url || null,
    downloadLocation: null, // Pexels has no equivalent ping
  })).filter((p) => p.url);

  return { results, hasMore: !!data.next_page };
}

async function search(req, res) {
  const query = String(req.body?.query || '').trim();
  if (!query) return res.status(400).json({ error: 'query is required' });

  const provider = req.body?.provider === 'unsplash' ? 'unsplash' : 'pexels';
  // Carousel covers are 1080x1350, so portrait is the sensible default here —
  // the opposite of the article hero picker, which wants landscape.
  const orientation = ['portrait', 'landscape', 'squarish'].includes(req.body?.orientation)
    ? req.body.orientation
    : 'portrait';
  // Pexels calls it 'square', Unsplash 'squarish'.
  const providerOrientation = (provider === 'pexels' && orientation === 'squarish') ? 'square' : orientation;
  const perPage = Math.min(30, Math.max(1, Number(req.body?.perPage) || 12));
  // 1-based, matching both providers' own convention.
  const startPage = Math.max(1, Number(req.body?.page) || 1);
  // Escape hatch for a caller that genuinely wants the unfiltered provider feed.
  // Nothing in the app sets it; it exists so a diagnostic curl can see everything.
  const includeUsed = req.body?.includeUsed === true;

  try {
    // A photo is offered at most once, ever (lib/social/stock-ledger.js), so a page
    // can come back short — or empty, on a query whose first page is entirely spent.
    // Walk forward until there is something to show or the provider runs out, rather
    // than handing the picker an empty grid for a query that still has fresh photos
    // two pages in. `page` in the response is the page actually reached, which is
    // what the client's "See more" continues from.
    const MAX_PAGES = 4;
    let page = startPage;
    let results = [];
    let hasMore = false;
    let hiddenUsed = 0;
    for (let scanned = 0; scanned < MAX_PAGES; scanned++) {
      const out = provider === 'unsplash'
        ? await searchUnsplash({ query, orientation: providerOrientation, perPage, page })
        : await searchPexels({ query, orientation: providerOrientation, perPage, page });
      hasMore = out.hasMore;
      const fresh = includeUsed ? out.results : await filterUnusedStock(out.results);
      hiddenUsed += out.results.length - fresh.length;
      results = fresh;
      if (fresh.length || !out.hasMore) break;
      page++;
    }
    return res.status(200).json({ provider, query, orientation, page, hasMore, hiddenUsed, results });
  } catch (err) {
    // 502 rather than 500: the failure is upstream, and the client shows the
    // message verbatim so a rate limit reads as a rate limit.
    return res.status(502).json({ error: err.message });
  }
}

/**
 * Ping Unsplash's download endpoint for a photo the operator has just chosen.
 *
 * Fire-and-forget by contract: this is a courtesy to the provider's analytics, and
 * failing it must never stop someone using an image they picked. Always 200.
 */
async function track(req, res) {
  const location = String(req.body?.downloadLocation || '').trim();
  if (!location || !location.startsWith('https://api.unsplash.com/')) {
    return res.status(200).json({ tracked: false });
  }
  try {
    const key = await unsplashKey();
    if (!key) return res.status(200).json({ tracked: false });
    const url = location + (location.includes('?') ? '&' : '?')
      + 'client_id=' + encodeURIComponent(key);
    await fetch(url);
    return res.status(200).json({ tracked: true });
  } catch (err) {
    console.warn('[stock] download tracking failed:', err.message);
    return res.status(200).json({ tracked: false });
  }
}

export default async function handler(req, res, { id } = {}) {
  if (req.method !== 'POST') return res.status(405).end();
  if (id === 'track') return track(req, res);
  return search(req, res);
}

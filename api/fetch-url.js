/**
 * Server-side URL fetcher — avoids all CORS issues that plague public proxies.
 * GET /api/fetch-url?url=https://...
 *
 * Requires a signed-in operator, and vets the URL (and every redirect hop)
 * against private address space. See lib/safe-fetch.js for why both are needed:
 * before this, any caller could make the deployment fetch an arbitrary URL and
 * hand back the body.
 */
import { getCurrentUser } from '../lib/auth.js';
import { safeFetch } from '../lib/safe-fetch.js';

const MAX_BYTES = 5 * 1024 * 1024;

export async function handler(req, res, { currentUser = getCurrentUser } = {}) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const me = await currentUser(req).catch(() => null);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });

  let response, finalUrl;
  try {
    ({ res: response, url: finalUrl } = await safeFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VanceBot/1.0; +https://vancehealthhub.co.uk)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
    }));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!response.ok) {
    return res.status(response.status).json({
      error: `Remote server returned ${response.status} ${response.statusText}`,
    });
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/xhtml')) {
    return res.status(415).json({ error: `Unsupported content type: ${contentType}` });
  }

  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) return res.status(413).json({ error: 'Remote document too large' });

  try {
    const html = await response.text();
    // content-length is advisory; a chunked response can exceed it.
    if (html.length > MAX_BYTES) return res.status(413).json({ error: 'Remote document too large' });
    res.setHeader('Content-Type', 'application/json');
    return res.json({ contents: html, status: response.status, url: finalUrl.href });
  } catch (err) {
    return res.status(502).json({ error: 'Fetch failed: ' + err.message });
  }
}

export default handler;

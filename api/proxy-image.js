/**
 * Server-side image proxy — fetches an external image and pipes it back,
 * avoiding CORS issues when the browser needs to embed images as data URLs.
 * GET /api/proxy-image?url=https://...
 *
 * Requires a signed-in operator, vets the URL and every redirect hop against
 * private address space, and caps the response. Previously this was an
 * unauthenticated open image proxy that also sent
 * `Access-Control-Allow-Origin: *`, so any page anywhere could hotlink through
 * it on this project's bandwidth.
 */
import { getCurrentUser } from '../lib/auth.js';
import { safeFetch } from '../lib/safe-fetch.js';

const MAX_BYTES = 15 * 1024 * 1024;

export async function handler(req, res, { currentUser = getCurrentUser } = {}) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const me = await currentUser(req).catch(() => null);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });

  let response;
  try {
    ({ res: response } = await safeFetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VanceBot/1.0; +https://vancehealthhub.co.uk)',
        'Accept': 'image/*,*/*;q=0.8',
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

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    return res.status(415).json({ error: `Not an image: ${contentType}` });
  }

  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) return res.status(413).json({ error: 'Image too large' });

  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_BYTES) return res.status(413).json({ error: 'Image too large' });
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    // No Access-Control-Allow-Origin: the only caller is this app's own page,
    // which is same-origin. The wildcard made it usable from anywhere.
    return res.send(buffer);
  } catch (err) {
    return res.status(502).json({ error: 'Fetch failed: ' + err.message });
  }
}

export default handler;

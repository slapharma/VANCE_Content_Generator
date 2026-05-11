/**
 * Server-side image proxy — fetches an external image and pipes it back,
 * avoiding CORS issues when the browser needs to embed images as data URLs.
 * GET /api/proxy-image?url=https://...
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });

  let parsed;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Only http/https URLs are supported' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const response = await fetch(parsed.href, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VanceBot/1.0; +https://gastrohealthhub.com)',
        'Accept': 'image/*,*/*;q=0.8',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Remote server returned ${response.status} ${response.statusText}`,
      });
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      return res.status(415).json({ error: `Not an image: ${contentType}` });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(buffer);
  } catch (err) {
    return res.status(500).json({ error: 'Fetch failed: ' + err.message });
  }
}

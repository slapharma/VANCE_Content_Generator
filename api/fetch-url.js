/**
 * Server-side URL fetcher — avoids all CORS issues that plague public proxies.
 * GET /api/fetch-url?url=https://...
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url parameter required' });

  // Basic URL validation
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
        'User-Agent': 'Mozilla/5.0 (compatible; VanceBot/1.0; +https://vancemedicalfoods.com)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Remote server returned ${response.status} ${response.statusText}`,
      });
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/xhtml')) {
      return res.status(415).json({ error: `Unsupported content type: ${contentType}` });
    }

    const html = await response.text();
    res.setHeader('Content-Type', 'application/json');
    return res.json({ contents: html, status: response.status, url: parsed.href });
  } catch (err) {
    return res.status(500).json({ error: 'Fetch failed: ' + err.message });
  }
}

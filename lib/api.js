// lib/api.js — shared API helpers: an error boundary for graceful degradation.
//
// Wrap a Vercel handler's default export with withErrorBoundary() so an
// unexpected throw returns a JSON error instead of crashing into Vercel's
// plain-text "A server error has occurred" page — which clients cannot
// JSON.parse (the source of the cryptic `Unexpected token 'A'` login error).
//
// Storage outages (e.g. Upstash request-cap exhaustion or a connection blip)
// are mapped to 503 so callers can show a clear "try again" message and so the
// status code distinguishes transient infrastructure from a genuine bug (500).

export function isKvUnavailable(err) {
  if (!err) return false;
  const name = String(err.name || '');
  const msg = String(err.message || err);
  if (name === 'UpstashError') return true;
  return /max requests limit|rate ?limit|\bquota\b|too many requests|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang ?up|connection (closed|refused|reset)/i.test(msg);
}

export function withErrorBoundary(handler) {
  return async function boundaryHandler(req, res) {
    try {
      return await handler(req, res);
    } catch (err) {
      // Response already started streaming — nothing safe to rewrite.
      if (res.headersSent) throw err;
      if (isKvUnavailable(err)) {
        console.error('[kv-unavailable]', req.method, req.url, err?.message);
        return res.status(503).json({ error: 'Storage temporarily unavailable. Please try again in a moment.' });
      }
      console.error('[api-error]', req.method, req.url, err?.stack || err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

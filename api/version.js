/**
 * GET /api/version — exposes package.json's version to the client.
 *
 * There is no build step for this static, single-file app, so this is the
 * only way the header's version tag can stay truthfully in sync with
 * package.json rather than a second, hand-maintained copy that silently
 * drifts.
 */
import pkg from '../package.json' with { type: 'json' };

export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.status(200).json({ version: pkg.version });
}

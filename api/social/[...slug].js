// api/social/[...slug].js
// Catch-all handler that routes all /api/social/* requests.
// This is the sole Vercel serverless function for the social module.
// Handler logic lives in lib/social/handlers/ (outside api/) so Vercel
// does not count each handler as a separate function.

import generateHandler from '../../lib/social/handlers/generate.js';
import kitsIndexHandler from '../../lib/social/handlers/kits-index.js';
import kitsIdHandler from '../../lib/social/handlers/kits-id.js';
import deployHandler from '../../lib/social/handlers/deploy.js';
import postHandler from '../../lib/social/handlers/post.js';
import scheduleHandler from '../../lib/social/handlers/schedule.js';
import cronHandler from '../../lib/social/handlers/cron.js';
import imageHandler from '../../lib/social/handlers/image.js';

export default async function handler(req, res) {
  // In non-Next.js Vercel serverless, [...slug].js exposes matched segments as
  // req.query['...slug'] (three dots are part of the key name), not req.query.slug.
  // Single-segment paths arrive as a plain string ('generate').
  // Multi-segment paths arrive as a slash-joined string ('kits/kit_abc').
  // Split on '/' to normalise both cases into an array.
  const rawSlug = req.query['...slug'] || req.query.slug || '';
  const slug = Array.isArray(rawSlug)
    ? rawSlug
    : String(rawSlug).split('/').filter(Boolean);
  const [resource, id] = slug; // e.g. ['kits', 'kit_123'] or ['generate']

  try {
    // POST /social/generate
    if (req.method === 'POST' && resource === 'generate') {
      return await generateHandler(req, res);
    }

    // GET /social/kits
    if (req.method === 'GET' && resource === 'kits' && !id) {
      return await kitsIndexHandler(req, res);
    }

    // GET /social/kits/:id  |  PATCH /social/kits/:id
    if (resource === 'kits' && id) {
      return await kitsIdHandler(req, res, id);
    }

    // POST /social/deploy
    if (req.method === 'POST' && resource === 'deploy') {
      return await deployHandler(req, res);
    }

    // POST /social/post
    if (req.method === 'POST' && resource === 'post') {
      return await postHandler(req, res);
    }

    // GET /social/schedule
    if (req.method === 'GET' && resource === 'schedule') {
      return await scheduleHandler(req, res);
    }

    // POST /social/cron
    if (req.method === 'POST' && resource === 'cron') {
      return await cronHandler(req, res);
    }

    // POST /social/image — hero image generation via OpenRouter
    if (req.method === 'POST' && resource === 'image') {
      return await imageHandler(req, res);
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('[social] unhandled error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

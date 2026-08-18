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
import postedHandler from '../../lib/social/handlers/posted.js';
import cronHandler from '../../lib/social/handlers/cron.js';
import imageHandler from '../../lib/social/handlers/image.js';
import connectionsHandler from '../../lib/social/handlers/connections.js';
import accountsHandler from '../../lib/social/handlers/accounts.js';
import carouselHandler from '../../lib/social/handlers/carousel.js';
import promosHandler from '../../lib/social/handlers/promos.js';
import designTemplatesHandler from '../../lib/social/handlers/design-templates.js';
import stockHandler from '../../lib/social/handlers/stock.js';
import canvaHandler from '../../lib/social/handlers/canva.js';
import { isKvUnavailable } from '../../lib/api.js';
import { getCurrentUser } from '../../lib/auth.js';
import { isCronRequest } from '../../lib/api-auth.js';

// `currentUser` is injected so the guard below can be tested without a real
// session — same deps-object shape as api/content/[id].js. Production passes
// nothing and gets the real one.
export async function handler(req, res, { currentUser = getCurrentUser } = {}) {
  // In non-Next.js Vercel serverless, [...slug].js exposes matched segments as
  // req.query['...slug'] (three dots are part of the key name), not req.query.slug.
  // Single-segment paths arrive as a plain string ('generate').
  // Multi-segment paths arrive as a slash-joined string ('kits/kit_abc').
  // Split on '/' to normalise both cases into an array.
  const rawSlug = req.query['...slug'] || req.query.slug || '';
  const slug = Array.isArray(rawSlug)
    ? rawSlug
    : String(rawSlug).split('/').filter(Boolean);
  const [resource, id, action] = slug; // e.g. ['kits', 'kit_123'] or ['carousels', 'car_1', 'render']

  try {
    // Until 2026-08-18 nothing on this router checked a caller, and the worst
    // of it was POST /social/post: it publishes to the live connected
    // Instagram / LinkedIn / X / TikTok accounts, for anyone who could reach
    // the URL. POST /social/generate and /social/image spent model credit the
    // same way.
    //
    // `cron` is left out because it runs its own CRON_SECRET check and must
    // stay reachable by GET, which is how Vercel invokes scheduled paths.
    // connections/check is the 06:00 cron and is named rather than assumed.
    if (resource !== 'cron') {
      const cronDriven = resource === 'connections' && id === 'check' && isCronRequest(req);
      if (!cronDriven) {
        const me = await currentUser(req).catch(() => null);
        if (!me) return res.status(401).json({ error: 'Not authenticated' });
      }
    }

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

    // GET    /social/schedule                    the queue
    // POST   /social/schedule/:refId/:action     pause | resume | reschedule | post-now
    // DELETE /social/schedule/:refId             take it off the queue
    if (resource === 'schedule') {
      return await scheduleHandler(req, res, { id, action });
    }

    // GET /social/posted                        → the published feed + filter facets
    // GET /social/posted/:carouselId/permalink   → resolve the public post URL
    if (req.method === 'GET' && resource === 'posted') {
      return await postedHandler(req, res, { id, action });
    }

    // POST /social/cron  → manual trigger
    // GET  /social/cron  → Vercel cron. Scheduled paths are invoked with GET, so a
    //                      POST-only route silently 404s on every firing and the
    //                      queue never drains. Auth is enforced in the handler.
    if ((req.method === 'POST' || req.method === 'GET') && resource === 'cron') {
      return await cronHandler(req, res);
    }

    // POST /social/image — hero image generation via OpenRouter
    if (req.method === 'POST' && resource === 'image') {
      return await imageHandler(req, res);
    }

    // POST /social/carousel                        → build an Article Carousel
    // GET  /social/carousels                       → list
    // GET|PATCH /social/carousels/:id              → read / edit copy
    // POST /social/carousels/:id/render|deploy     → re-render / queue
    if (resource === 'carousel' || resource === 'carousels') {
      return await carouselHandler(req, res, { resource, id, action });
    }

    // /social/promos*        → Promotional Carousel campaigns (recurring)
    // /social/promo-prompts* → the saved promo prompt library
    if (resource === 'promos' || resource === 'promo-prompts') {
      return await promosHandler(req, res, { resource, id, action });
    }

    // /social/design-templates* → the deck design template library
    if (resource === 'design-templates') {
      return await designTemplatesHandler(req, res, { id });
    }

    // POST /social/stock        → Unsplash / Pexels search (key stays server-side)
    // POST /social/stock/track  → Unsplash download ping, on selection
    if (resource === 'stock') {
      return await stockHandler(req, res, { id });
    }

    // GET /social/canva            → connection + capability status
    // GET /social/canva/designs    → your Canva designs
    // GET /social/canva/templates  → brand templates with data fields
    if (resource === 'canva') {
      return await canvaHandler(req, res, { id, action });
    }

    // GET /social/connections                 → per-platform env-var status
    // POST /social/connections/test           → live verification call
    if (resource === 'connections') {
      return await connectionsHandler(req, res, id);
    }

    // /social/accounts*                        → multi-account management (Composio)
    if (resource === 'accounts') {
      return await accountsHandler(req, res, slug.slice(1).join('/'));
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    if (res.headersSent) throw err;
    if (isKvUnavailable(err)) {
      console.error('[social] kv-unavailable:', req.method, req.url, err?.message);
      return res.status(503).json({ error: 'Storage temporarily unavailable. Please try again in a moment.' });
    }
    console.error('[social] unhandled error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export default handler;

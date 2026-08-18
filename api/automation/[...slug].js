// api/automation/[...slug].js
// Catch-all handler that routes all /api/automation/* requests.
// This is the sole Vercel serverless function for the automation module.
// Handler logic lives in lib/automation/handlers/ (outside api/) so Vercel
// does not count each handler as a separate function.

import approveHandler from '../../lib/automation/handlers/approve.js';
import runHandler from '../../lib/automation/handlers/run.js';
import telegramHandler from '../../lib/automation/handlers/telegram.js';
import telegramTestHandler from '../../lib/automation/handlers/telegram-test.js';
import rulesIndexHandler from '../../lib/automation/handlers/rules-index.js';
import rulesIdHandler from '../../lib/automation/handlers/rules-id.js';
import jobsIndexHandler from '../../lib/automation/handlers/jobs-index.js';
import jobsIdHandler from '../../lib/automation/handlers/jobs-id.js';
import authHandler from '../../lib/automation/handlers/auth.js';
import logsHandler from '../../lib/automation/handlers/logs.js';
import sourcesListHandler from '../../lib/automation/handlers/sources-list.js';
import bibliographyHandler from '../../lib/automation/handlers/bibliography.js';
import { withErrorBoundary } from '../../lib/api.js';
import { getCurrentUser, requireRole } from '../../lib/auth.js';
import { isCronRequest, isInternalRequest } from '../../lib/api-auth.js';

/**
 * Routes that verify their own caller and must not be gated again here.
 * Gating any of these breaks a path that has no session to offer:
 *
 *   telegram         Telegram's webhook, checked against TELEGRAM_WEBHOOK_SECRET
 *   auth/<svc>/callback   OAuth redirects arriving from Google / Dropbox
 *   approve?token=   a JWT emailed to a reviewer who may hold no account here
 */
function selfGated(slug, req) {
  const [first, , third] = slug;
  if (first === 'telegram') return true;
  if (first === 'auth' && third === 'callback' && req.method === 'GET') return true;
  if (first === 'approve' && req.method === 'GET' && req.query?.token) return true;
  return false;
}

// `currentUser` is injected so the guards below can be tested without a real
// session — same deps-object shape as api/content/[id].js and
// lib/automation/handlers/run.js. Production passes nothing and gets the real one.
export async function handler(req, res, { currentUser = getCurrentUser } = {}) {
  // In non-Next.js Vercel serverless, [...slug].js exposes matched segments as
  // req.query['...slug'] (three dots are part of the key name), not req.query.slug.
  // Single-segment paths arrive as a plain string ('telegram-test').
  // Multi-segment paths arrive as a slash-joined string ('rules/rule_abc').
  // Split on '/' to normalise both cases into an array.
  // When requests come via the vercel.json rewrite (:slug* capture), the
  // segments arrive as req.query.slug instead of req.query['...slug'].
  const rawSlug = req.query['...slug'] || req.query.slug || '';
  const slug = Array.isArray(rawSlug)
    ? rawSlug
    : String(rawSlug).split('/').filter(Boolean);
  const [first, second] = slug;

  // Until 2026-08-18 nothing on this router checked a caller. Every route below
  // was reachable anonymously: GET /rules and GET /jobs returned 84 KB and 90 KB
  // of automation config and run history on an HTTP 200, and POST /run spent
  // OpenRouter credit on demand. An unauthenticated GET of the production alias
  // returns 200, so no platform-level protection was standing in for this.
  //
  // Default closed, with the exceptions named rather than assumed. The routes
  // that verify their own caller are carved out in selfGated() above; the two
  // driven by a machine are named here:
  //
  //   run           the 07:00 Vercel cron, and run.js's own internal calls
  //   approve POST  run.js calling it server-to-server on review timeout
  if (!selfGated(slug, req)) {
    const cronDriven = first === 'run' && isCronRequest(req);
    const internal = (first === 'run' || first === 'approve') && isInternalRequest(req);

    if (!cronDriven && !internal) {
      const me = await currentUser(req).catch(() => null);
      if (!me) return res.status(401).json({ error: 'Not authenticated' });

      // Rules and jobs are stricter than the rest: POST/PATCH/DELETE on a rule
      // changes what this system publishes and where. The role mirrors
      // isContentPlus() in index.html, which already hides these screens from
      // anyone below 'content' — so enforcing it changes nobody's access, it
      // makes a rule that was only ever displayed actually binding.
      if (first === 'rules' || first === 'jobs') {
        const guard = requireRole(me, 'admin', 'content');
        if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
      }
    }
  }

  if (first === 'approve') return approveHandler(req, res);
  if (first === 'run') return runHandler(req, res);
  if (first === 'logs') return logsHandler(req, res);
  if (first === 'sources-list') return sourcesListHandler(req, res);
  if (first === 'telegram-test') return telegramTestHandler(req, res);
  if (first === 'telegram') return telegramHandler(req, res);

  // Cloud storage OAuth + config — slug[0]='auth', slug[1]=service, slug[2]=callback?
  if (first === 'auth') return authHandler(req, res, slug);

  if (first === 'rules' && !second) return rulesIndexHandler(req, res);
  if (first === 'rules' && second) {
    req.query.id = second;
    return rulesIdHandler(req, res);
  }

  if (first === 'jobs' && !second) return jobsIndexHandler(req, res);
  if (first === 'jobs' && second) {
    req.query.id = second;
    return jobsIdHandler(req, res);
  }

  if (first === 'bibliography') return bibliographyHandler(req, res, slug);

  return res.status(404).json({ error: 'Not found' });
}

export default withErrorBoundary(handler);

/**
 * Recognising the callers that are NOT people.
 *
 * Session auth lives in lib/auth.js and is applied inline at each route with
 * getCurrentUser / requireRole, the way api/content/[id].js does it. This module
 * deliberately does not wrap that — it covers the two machine callers that a
 * session check has no answer for, and nothing else:
 *
 *   Vercel Cron          Authorization: Bearer $CRON_SECRET
 *   This app's own API   x-internal-secret
 *
 * The second is why gating /api/publish is delicate rather than mechanical.
 * run.js POSTs to /api/content and /api/automation/approve, and approve.js,
 * run.js and telegram.js all POST to /api/publish — none of them carrying any
 * credential, because until now none was needed. A session-only check on those
 * routes would silently stop every automated article from being created or
 * published, and would do it at 07:00 with the failure buried in a rule's log.
 * Those call sites now send internalHeaders().
 */
import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time compare that treats an unset expectation as "never matches".
 *
 * This is the property the module rests on. With a plain ===, a missing
 * CRON_SECRET would make `req.headers['x-cron'] === ''` true — that is, a
 * request which simply omits the header would authenticate as an internal call
 * on any deployment where the secret was not configured. It has to fail closed.
 */
function secretsMatch(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The shared secret for this app's own server-to-server calls. Defaults to
 * CRON_SECRET, which is already set in production, so this ships without a
 * config change that could be forgotten and break publishing. Set
 * INTERNAL_API_SECRET to separate the two.
 */
export function internalSecret() {
  return process.env.INTERNAL_API_SECRET || process.env.CRON_SECRET || '';
}

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET` on scheduled paths. */
export function isCronRequest(req) {
  const expected = process.env.CRON_SECRET || '';
  if (!expected) return false;
  return secretsMatch(req?.headers?.authorization, `Bearer ${expected}`);
}

/**
 * One of our own handlers calling our own API. `x-cron` is accepted too because
 * api/cron/publish.js already sent it to /api/publish before any of this.
 */
export function isInternalRequest(req) {
  const expected = internalSecret();
  if (!expected) return false;
  const h = req?.headers ?? {};
  return secretsMatch(h['x-internal-secret'], expected) || secretsMatch(h['x-cron'], expected);
}

/** Headers to attach to a server-to-server fetch at one of our own routes. */
export function internalHeaders() {
  const secret = internalSecret();
  return secret ? { 'x-internal-secret': secret } : {};
}

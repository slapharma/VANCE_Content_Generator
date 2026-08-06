/**
 * Report Passport use back to HQ.
 * passport-report.js  v1.0.0
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │  VENDORED FILE — copy this into each consuming app as               │
 * │  lib/passport-report.{js,mjs}. The master lives in V-Net.           │
 * │  Change it there, bump the version, re-copy. Drift is caught by     │
 * │  V-Net/scripts/check-vendored.mjs.                                   │
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * HQ owns the only Google OAuth client, so it sees every sign-in. It does NOT
 * see somebody opening this app an hour later, because the Passport is verified
 * offline with no call back to HQ — the property that keeps these apps working
 * when HQ is down. This is the one-way, best-effort report that fills that gap,
 * so HQ's admin page can show which systems a person actually reaches.
 *
 * ── The contract, in one sentence ────────────────────────────────────────
 *
 *   Call it and ignore it. It is never awaited, never throws, and never
 *   returns a rejecting promise, so it cannot fail a request or admit anybody.
 *
 * If HQ is down, slow, or gone, this does nothing at all and the caller never
 * finds out. That is the entire point: an analytics report must not become the
 * dependency the offline verification was designed to avoid. HQ renders an
 * asset that has never reported as "Not reporting" rather than as zero, so
 * silence here is honest rather than misleading.
 *
 * ── Why it does not fire on every request ────────────────────────────────
 *
 * HQ deduplicates per session, so calling it on every request would be correct
 * but wasteful — an outbound HTTP request per page view. A small in-process
 * memo keeps it to roughly one call per session per warm instance.
 *
 * The memo records a session only once the report has actually SUCCEEDED. That
 * matters more than it looks: `sessionOf()` in the Alerts dashboard is
 * synchronous, so this can only be fired and forgotten, and a serverless
 * invocation may freeze the moment the response ends and drop the request
 * mid-flight. Marking on success means a dropped call is simply retried on the
 * next request rather than being remembered as done and never sent again.
 */

import { createHash } from 'node:crypto';

const HQ_DEFAULT = 'https://hq.vancemedicalfoods.co.uk';
const SSO_COOKIE = 'vance_sso';

/** Short. Nothing waits for this, but a socket held open on a frozen instance
 *  helps nobody either. */
const TIMEOUT_MS = 800;

/** Bounded so a long-lived instance cannot grow these without limit. Cleared
 *  wholesale rather than evicted one by one — the cost of forgetting is one
 *  duplicate report, which HQ deduplicates anyway. */
const MAX_TRACKED = 500;

/** Sessions this instance has successfully reported. */
const done = new Set();
/** Reports currently in flight, so concurrent requests do not pile up. */
const inflight = new Set();

const read = (v) => (typeof v === 'string' ? v.trim() : '') || null;

/** Deliberately not shared with the verifier: this file stays standalone so it
 *  can be dropped into an app whose vendored SSO copy has a different
 *  extension, without editing an import path. */
function cookieValue(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim()) || null;
    }
  }
  return null;
}

/**
 * Tell HQ this app accepted a Passport on this request.
 *
 * @param {object} req   the incoming request, for its cookie header
 * @param {string} asset this app's id in V-Net/lib/estate.js — 'content' | 'cs' | 'alerts'
 * @returns {void} always. Nothing to await, nothing to catch.
 */
export function reportPassportUse(req, asset, env = process.env) {
  let key = null;
  try {
    const token = cookieValue(req?.headers?.cookie, SSO_COOKIE);
    if (!token) return;

    // A hash of the Passport, never the Passport. This is only a memo key, and
    // there is no reason for live session tokens to sit in a module-level Set.
    key = `${createHash('sha256').update(token).digest('base64url').slice(0, 22)}:${asset}`;
    if (done.has(key) || inflight.has(key)) return;
    inflight.add(key);

    const base = (read(env.VNET_URL) || HQ_DEFAULT).replace(/\/+$/, '');

    fetch(`${base}/api/passport/seen`, {
      method: 'POST',
      headers: {
        // The Passport this app just verified IS the credential. No new secret
        // exists anywhere for this, and none should.
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ asset }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then((r) => {
        if (!r.ok) return;
        if (done.size >= MAX_TRACKED) done.clear();
        done.add(key);
      })
      // Every failure is the same failure: HQ did not hear about it, and the
      // next request will try again.
      .catch(() => {})
      .finally(() => inflight.delete(key));
  } catch {
    // Only reachable if the cookie header or crypto misbehaves. Swallowed for
    // the same reason as everything else here.
    if (key) inflight.delete(key);
  }
}

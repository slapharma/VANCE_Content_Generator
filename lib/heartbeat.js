// lib/heartbeat.js
// Reports a scheduled job's completion to the VANCE uptime dashboard.
//
// Why this exists: a cron that stops firing is invisible. Nothing 500s, no page
// goes down, no error is logged — content just quietly stops appearing, and the
// first person to notice is usually a customer. HTTP monitoring cannot see it,
// because there is no HTTP surface to look at. So the job tells us instead: it
// pings on every run, and the dashboard raises the alarm when a ping is overdue.
//
// Usage — one line at each point the handler can return:
//
//   await heartbeat('cg-publish', { status: 'ok', message: '3 published' });
//
// Rules this file obeys, in order of importance:
//   1. It NEVER throws and NEVER rejects. Monitoring that can break the thing it
//      monitors is worse than no monitoring at all.
//   2. It never blocks a job for long — 5s ceiling, then it gives up.
//   3. It no-ops silently when HEARTBEAT_SECRET is unset, so local dev and
//      preview deployments do not spam the production dashboard.
//
// Set in Vercel (production): HEARTBEAT_SECRET — must match the value on the
// dashboard project. UPTIME_URL is optional and only needed if the dashboard
// ever moves off its current hostname.

const DEFAULT_UPTIME_URL = 'https://vancedashboard.vercel.app';
const TIMEOUT_MS = 5000;

/**
 * @param {string} job     job id, must match `job:` in the dashboard's monitors.config.js
 *                         ('cg-publish' | 'cg-social-cron' | 'cg-social-connections')
 * @param {object} [opts]
 * @param {'ok'|'warn'|'fail'} [opts.status] ok   → green: ran, did its job
 *                                           warn → amber: ran, but something in it failed
 *                                           fail → red:   did not do its job
 * @param {string} [opts.message]            short human detail, shown on the dashboard
 */
export async function heartbeat(job, { status = 'ok', message = null } = {}) {
  const secret = process.env.HEARTBEAT_SECRET;
  if (!secret) return;

  const url = new URL('/api/heartbeat', process.env.UPTIME_URL || DEFAULT_UPTIME_URL);
  url.searchParams.set('job', job);
  url.searchParams.set('status', status);
  if (message) url.searchParams.set('message', String(message).slice(0, 300));

  try {
    const res = await fetch(url, {
      method: 'POST',
      // Header, not a query parameter: query strings end up in access logs,
      // referrers and error reports. The secret should not be in any of them.
      headers: { 'x-heartbeat-secret': secret },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Logged, not thrown. A silent catch here would mean a broken heartbeat looks
    // exactly like a healthy one that was never wired — the failure mode this
    // whole mechanism exists to eliminate.
    if (!res.ok) console.warn(`[heartbeat] ${job}: dashboard returned HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[heartbeat] ${job}: ${err?.message || 'request failed'}`);
  }
}

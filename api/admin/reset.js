// api/admin/reset.js
// Admin-only selective KV reset. Backs the Settings → Reset Databases tool.
//   GET  → returns the catalogue of resettable datasets (for the UI checkboxes)
//   POST → { dryRun: boolean, targets: string[] } runs (or previews) the reset
//
// Guarded with the same getCurrentUser + requireRole('admin') pattern as the
// other admin endpoints. New top-level api/admin/ namespace — no catch-all
// conflict, and the Pro plan has lifted the function limit.

import { getCurrentUser, requireRole } from '../../lib/auth.js';
import { resetDatabases, RESET_TARGETS } from '../../lib/admin/reset.js';

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

export default async function handler(req, res) {
  const me = await getCurrentUser(req);
  const guard = requireRole(me, 'admin');
  if (!guard.ok) return res.status(guard.status).json({ error: guard.error });

  if (req.method === 'GET') {
    return res.status(200).json({ targets: RESET_TARGETS });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  const dryRun = body.dryRun !== false; // default to a safe dry run
  const targets = Array.isArray(body.targets) ? body.targets : [];
  if (!targets.length) return res.status(400).json({ error: 'No datasets selected' });

  try {
    const out = await resetDatabases(targets, { dryRun });
    return res.status(200).json({ ok: true, by: me.email, ...out });
  } catch (err) {
    console.error('admin reset failed:', err);
    return res.status(500).json({ error: err.message || 'Reset failed' });
  }
}

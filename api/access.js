/**
 * GET /api/access — who may use the Content Generator, and as what.
 *
 * Answers one question for HQ's "who has access to what" screen. READ ONLY:
 * this app remains the system of record for its own users, and nothing here
 * changes anything. HQ hosts screens; it does not own roles.
 *
 * ── The contract, shared with the other internal systems ─────────────────
 *
 * Every system answers in one of two shapes, so HQ can render them side by side
 * without knowing how any of them works:
 *
 *   { asset, model: 'domain', domain, allowlist }   no user list — a rule
 *   { asset, model: 'list', roles, users: [...] }   an actual list of people
 *
 * This app is the second kind. A valid Passport is not access here: an address
 * with no user record is refused, which is the rule getCurrentUser already
 * applies, and this endpoint reports exactly the records that rule consults.
 *
 * ── What is deliberately not returned ────────────────────────────────────
 *
 * Only the address, the role and whether the record exists. Not the password
 * hash — `safe()` strips it — and not names, tokens or anything else the
 * question does not need. This is a list of who can get in, being sent to
 * another system; it should carry the minimum that answers that.
 */

import { getCurrentUser, requireRole } from '../lib/auth.js';
import { loadUsers, APP_ROLES } from '../lib/users.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const me = await getCurrentUser(req);
  if (!me) {
    return res.status(401).json({ error: 'unauthorized', message: 'Sign in to the Content Generator.' });
  }

  // This app's own admin role, checked against its own KV record — not HQ's
  // idea of an admin. Being able to reach HQ's screen does not make somebody an
  // administrator here, and it must not.
  const guard = requireRole(me, 'admin');
  if (!guard.ok) {
    return res.status(guard.status).json({
      error: 'forbidden',
      message: 'Only a Content Generator admin can see who has access to it.',
    });
  }

  const users = await loadUsers();

  return res.status(200).json({
    asset: 'content',
    model: 'list',
    roles: APP_ROLES,
    users: users.map((u) => ({
      email: String(u.email ?? '').toLowerCase(),
      role: u.appRole ?? 'user',
      active: true,
    })),
  });
}

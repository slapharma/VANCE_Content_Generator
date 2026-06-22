import { kv } from '../../lib/kv.js';
import { getCurrentUser, requireRole } from '../../lib/auth.js';

// Per-category maximum word length, enforced during article generation.
// Single KV record: vance:category-word-limits
//   {
//     categories: { [categoryId]: number },   // word ceiling; 0 = explicitly uncapped
//     updatedAt, updatedBy
//   }
//
// Resolution (in lib/automation/handlers/run.js → maxWordsFor):
//   rule.generation.maxWords override
//     → categories[cat] if present (0 = uncapped)
//     → code default (1000, or uncapped for white-papers / infographics)
// A category absent from the map inherits the code default.

const EMPTY = { categories: {} };
const MAX_LIMIT = 100000;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated' });
    const rec = (await kv.get('vance:category-word-limits')) || { ...EMPTY, updatedAt: null };
    return res.json(rec);
  }

  if (req.method === 'PUT') {
    const me = await getCurrentUser(req);
    const guard = requireRole(me, 'admin', 'content');
    if (!guard.ok) return res.status(guard.status).json({ error: guard.error });

    const body = req.body || {};
    const rec = { categories: {} };
    if (body.categories && typeof body.categories === 'object') {
      for (const [k, v] of Object.entries(body.categories)) {
        const n = Number(v);
        // Keep 0 (explicitly uncapped) and any sane positive ceiling; drop garbage.
        if (Number.isFinite(n) && n >= 0 && n <= MAX_LIMIT) rec.categories[k] = Math.round(n);
      }
    }
    rec.updatedAt = new Date().toISOString();
    rec.updatedBy = me.id;
    await kv.set('vance:category-word-limits', rec);
    return res.json(rec);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

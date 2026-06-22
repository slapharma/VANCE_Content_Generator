import { kv } from '../../lib/kv.js';
import { getCurrentUser, requireRole } from '../../lib/auth.js';

// Shared article-generation prompt library, keyed by category.
// Single KV record: vance:article-prompts
//   {
//     categories: { [categoryId]: [ { name, createdBy, text }, ... ] },  // index 0 = active default
//     updatedAt, updatedBy
//   }
//
// Previously these prompts lived only in each user's browser localStorage
// (vance_prompts_<categoryId>), so they were never shared. This route makes the
// library a single shared record — any authenticated user reads the same copy;
// admin/content roles can edit (matching master-prompt + hero-prompts).

const EMPTY = { categories: {} };

function cleanPromptArray(arr) {
  if (!Array.isArray(arr)) return null;
  return arr
    .filter(p => p && (typeof p === 'object' || typeof p === 'string'))
    .map(p => {
      if (typeof p === 'string') {
        return { name: 'Default Prompt', createdBy: '', text: p };
      }
      return {
        name: String(p.name || 'Untitled prompt').slice(0, 120),
        createdBy: String(p.createdBy || '').slice(0, 120),
        text: String(p.text || ''),
      };
    });
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated' });
    const rec = (await kv.get('vance:article-prompts')) || { ...EMPTY, updatedAt: null };
    return res.json(rec);
  }

  if (req.method === 'PUT') {
    const me = await getCurrentUser(req);
    const guard = requireRole(me, 'admin', 'content');
    if (!guard.ok) return res.status(guard.status).json({ error: guard.error });

    const body = req.body || {};
    const existing = (await kv.get('vance:article-prompts')) || { ...EMPTY };
    const rec = {
      categories: (existing.categories && typeof existing.categories === 'object') ? existing.categories : {},
    };

    // Partial merge: callers send only the category (or categories) they changed,
    // so per-category saves never clobber the rest of the library.
    if (body.categories && typeof body.categories === 'object') {
      for (const [catId, arr] of Object.entries(body.categories)) {
        const cleaned = cleanPromptArray(arr);
        if (cleaned) rec.categories[catId] = cleaned;
      }
    }
    // Convenience single-category form: { catId, prompts: [...] }
    if (typeof body.catId === 'string' && Array.isArray(body.prompts)) {
      const cleaned = cleanPromptArray(body.prompts);
      if (cleaned) rec.categories[body.catId] = cleaned;
    }

    rec.updatedAt = new Date().toISOString();
    rec.updatedBy = me.id;
    await kv.set('vance:article-prompts', rec);
    return res.json(rec);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

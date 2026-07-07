import { kv } from '../../lib/kv.js';
import { getCurrentUser, requireRole } from '../../lib/auth.js';

// Hero image prompt library + per-category overrides.
// Single KV record: vance:hero-prompts
//   {
//     default:    "<template string, may contain {topic} / {title} placeholders>",
//     presets:    [ { id, name, text } ],   // reusable library, for convenience in the UI
//     categories: { [categoryId]: "<template string>" },  // per-category override ('' = use default)
//     sources:    { [categoryId]: "stock" },  // per-category hero source ('ai' is the default, omitted)
//     updatedAt, updatedBy
//   }
//
// Resolution (shared with lib/social/media.js): categories[cat] (non-empty) wins, else default.
// sources[cat] === 'stock' => Pexels stock photo; anything else => AI generation.

const EMPTY = { default: '', presets: [], categories: {}, sources: {} };

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated' });
    const rec = (await kv.get('vance:hero-prompts')) || { ...EMPTY, updatedAt: null };
    return res.json(rec);
  }

  if (req.method === 'PUT') {
    const me = await getCurrentUser(req);
    const guard = requireRole(me, 'admin', 'content');
    if (!guard.ok) return res.status(guard.status).json({ error: guard.error });

    const body = req.body || {};
    // Partial merge so the LLM page (default + presets) and the Categories page
    // (per-category map) can each save their slice without clobbering the other.
    const existing = (await kv.get('vance:hero-prompts')) || { ...EMPTY };
    const rec = {
      default: typeof existing.default === 'string' ? existing.default : '',
      presets: Array.isArray(existing.presets) ? existing.presets : [],
      categories: (existing.categories && typeof existing.categories === 'object') ? existing.categories : {},
      sources: (existing.sources && typeof existing.sources === 'object') ? existing.sources : {},
    };

    if (typeof body.default === 'string') rec.default = body.default;
    if (Array.isArray(body.presets)) {
      rec.presets = body.presets
        .filter(p => p && typeof p === 'object')
        .map(p => ({
          id: String(p.id || ('hp_' + Math.random().toString(36).slice(2, 10))),
          name: String(p.name || 'Untitled prompt').slice(0, 120),
          text: String(p.text || ''),
        }));
    }
    if (body.categories && typeof body.categories === 'object') {
      const clean = {};
      for (const [k, v] of Object.entries(body.categories)) {
        if (typeof v === 'string' && v.trim()) clean[k] = v;
      }
      rec.categories = clean;
    }
    if (body.sources && typeof body.sources === 'object') {
      // Only 'stock' is persisted; 'ai' is the default and stays out of the map.
      const clean = {};
      for (const [k, v] of Object.entries(body.sources)) {
        if (v === 'stock') clean[k] = 'stock';
      }
      rec.sources = clean;
    }

    rec.updatedAt = new Date().toISOString();
    rec.updatedBy = me.id;
    await kv.set('vance:hero-prompts', rec);
    return res.json(rec);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

/**
 * Server-side GitHub sync for the per-category archive, prompt library and
 * custom-category list.
 *
 *   GET /api/gh-sync?path=data/<catId>/reviews.json   → { content, sha }
 *   PUT /api/gh-sync  { path, content, sha, message } → { sha }
 *
 * These reads and writes used to happen straight from the browser, which meant
 * the credential had to be in the browser: index.html carried a classic GitHub
 * PAT, obfuscated with String.fromCharCode and served to every visitor of the
 * production alias. `repo` scope on a classic PAT is not limited to one
 * repository, so it reached everything the issuing account could see. That token
 * was revoked on 2026-08-18; this route replaces it with GITHUB_SYNC_TOKEN, held
 * server-side and never sent to the client.
 *
 * ── Why the path allowlist is the important part ──────────────────────────────
 * The client chooses `path`. Moving the token server-side without constraining
 * that would swap one hole for a worse one: any signed-in user could PUT to
 * .github/workflows/deploy.yml and get arbitrary code execution in CI, or
 * rewrite source files. The token's blast radius is now bounded by this
 * allowlist rather than by the scope GitHub granted it, so the allowlist is the
 * real security boundary and is deliberately literal — three shapes, nothing
 * parameterised beyond a category id.
 */
import { getCurrentUser } from '../lib/auth.js';

const GH_API = 'https://api.github.com';
const REPO = process.env.GITHUB_SYNC_REPO || 'slapharma/SLAHEALTH_ClinicalReview_Generator';
const BRANCH = process.env.GITHUB_SYNC_BRANCH || 'main';

/** Category ids are 'clinical-reviews' style slugs or 'cat_<timestamp>'. */
const CAT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * The complete set of files this route may touch. Anything else is refused
 * before a request leaves the deployment.
 */
export function isAllowedPath(path) {
  if (typeof path !== 'string' || path.length > 200) return false;
  if (path.includes('..') || path.includes('//') || path.startsWith('/')) return false;
  if (path === 'data/config/custom-categories.json') return true;
  const m = /^data\/([^/]+)\/(reviews|prompts)\.json$/.exec(path);
  return !!m && CAT_ID.test(m[1]);
}

function ghHeaders(token) {
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'vance-content-generator',
  };
}

/**
 * Read a JSON array out of the repo. Mirrors what ghGetFile() used to do in the
 * browser, including the >1 MB case where GitHub returns content:"" and a
 * download_url instead — except the base64 decode is a Buffer here, so the
 * decodeURIComponent(escape(atob(...))) dance the client needed for UTF-8 (and
 * the double-decode bug that came with it) is gone.
 */
async function readFile(path, token, fetchFn) {
  const url = `${GH_API}/repos/${REPO}/contents/${encodeURI(path)}?ref=${encodeURIComponent(BRANCH)}`;
  const res = await fetchFn(url, { headers: ghHeaders(token) });

  // A file that does not exist yet is an empty list, not an error — that is how
  // a brand-new category bootstraps.
  if (res.status === 404) return { content: [], sha: null };
  if (!res.ok) throw Object.assign(new Error(`GitHub GET ${path}: ${res.status}`), { status: res.status });

  const data = await res.json();
  let text = '';
  if (data.content && data.content.trim()) {
    text = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
  } else if (data.download_url) {
    const dl = await fetchFn(data.download_url, { headers: ghHeaders(token) });
    if (!dl.ok) throw Object.assign(new Error(`GitHub download ${path}: ${dl.status}`), { status: dl.status });
    text = await dl.text();
  }
  if (!text || !text.trim()) return { content: [], sha: data.sha ?? null };

  let decoded;
  try {
    decoded = JSON.parse(text);
  } catch (e) {
    throw Object.assign(new Error(`Corrupt JSON in ${path}: ${e.message}`), { status: 502 });
  }
  return { content: Array.isArray(decoded) ? decoded : [], sha: data.sha ?? null };
}

async function writeFile(path, content, sha, message, token, fetchFn) {
  const body = {
    message: message || `Update ${path}`,
    content: Buffer.from(JSON.stringify(content, null, 2), 'utf8').toString('base64'),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetchFn(`${GH_API}/repos/${REPO}/contents/${encodeURI(path)}`, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // 409/422 here is the concurrent-edit case the client already retries by
    // re-reading the sha; pass GitHub's own message through so it stays legible.
    throw Object.assign(new Error(err.message || `GitHub PUT ${path} failed: ${res.status}`), { status: res.status });
  }
  const data = await res.json();
  return data.content?.sha ?? null;
}

// `currentUser` and `fetchFn` are injected so the guard and the allowlist can be
// tested without a real session or a live GitHub — same deps-object shape as
// api/content/[id].js. Production passes neither and gets the real ones.
export async function handler(req, res, { currentUser = getCurrentUser, fetchFn = fetch } = {}) {
  const me = await currentUser(req).catch(() => null);
  if (!me) return res.status(401).json({ error: 'Not authenticated' });

  const token = process.env.GITHUB_SYNC_TOKEN;
  if (!token) {
    // Explicit rather than a confusing 401 from GitHub. The client already
    // degrades to its localStorage cache when this route fails.
    return res.status(503).json({ error: 'GitHub sync is not configured (GITHUB_SYNC_TOKEN unset).' });
  }

  const path = req.method === 'GET' ? req.query?.path : req.body?.path;
  if (!isAllowedPath(path)) return res.status(400).json({ error: 'Unsupported sync path' });

  try {
    if (req.method === 'GET') {
      return res.json(await readFile(path, token, fetchFn));
    }
    if (req.method === 'PUT') {
      const { content, sha, message } = req.body ?? {};
      if (!Array.isArray(content)) return res.status(400).json({ error: 'content must be an array' });
      return res.json({ sha: await writeFile(path, content, sha ?? null, message, token, fetchFn) });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
    return res.status(status).json({ error: err.message });
  }
}

export default handler;

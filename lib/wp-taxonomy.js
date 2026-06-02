// lib/wp-taxonomy.js
//
// Shared WordPress taxonomy helpers used by the publish endpoint.
// Resolve-or-create logic for categories (with parent inference) and tags.
//
// All functions take siteUrl + authHeader so they can be unit-tested against
// a stub fetch. Network errors are non-fatal — every resolver returns null on
// failure rather than throwing, so a single missing category/tag doesn't stop
// the rest of the post from publishing.

/**
 * Slugify a human-readable name the same way WP's sanitize_title() does by
 * default. WP simply strips non-alphanumeric characters (including "&"),
 * lowercases, and joins remaining runs with "-". This produces:
 *   "Diagnosis & Treatment"   -> "diagnosis-treatment"   (matches WP)
 *   "Lifestyle & Wellbeing"   -> "lifestyle-wellbeing"   (matches WP)
 *   "Nutrition & Diet"        -> "nutrition-diet"        (matches WP)
 *   "Understanding Your..."   -> "understanding-your..."
 *   "Crohn's Disease"         -> "crohns-disease"
 *
 * Important: do NOT convert "&" to " and " — WP does not, and a mismatch
 * here means we'd fail to look up categories the user pre-created with the
 * standard WP slug.
 */
export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

/**
 * Decode the small set of HTML entities WP routinely returns in REST `name`
 * fields ("Diagnosis &amp; Treatment" -> "Diagnosis & Treatment"). Used so
 * exact-match name comparisons survive WP's entity encoding.
 */
function decodeWpEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;|&apos;/g, "'");
}

// -- Categories --------------------------------------------------------------

/**
 * Look up a category by slug. Returns { id, parent, name, slug } or null.
 */
export async function findWpCategoryBySlug(slug, siteUrl, authHeader, fetchFn = fetch) {
  if (!slug) return null;
  try {
    const resp = await fetchFn(
      `${siteUrl}/wp-json/wp/v2/categories?slug=${encodeURIComponent(slug)}&per_page=1`,
      { headers: { Authorization: authHeader } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data) || !data.length) return null;
    const c = data[0];
    return { id: c.id, parent: c.parent ?? 0, name: c.name, slug: c.slug };
  } catch {
    return null;
  }
}

/**
 * Look up a category by human-readable name. WP's `search` param does a
 * fuzzy match across name + slug, so we re-filter by exact (case-insensitive)
 * name match before returning to avoid picking up "IBD Lifestyle" when the
 * caller asked for "Lifestyle".
 *
 * Returns { id, parent, name, slug } or null.
 */
export async function findWpCategoryByName(name, siteUrl, authHeader, fetchFn = fetch) {
  if (!name) return null;
  try {
    const resp = await fetchFn(
      `${siteUrl}/wp-json/wp/v2/categories?search=${encodeURIComponent(name)}&per_page=20`,
      { headers: { Authorization: authHeader } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data) || !data.length) return null;
    const wanted = name.trim().toLowerCase();
    // Exact name match first (with HTML-entity decoding -- WP returns
    // "Diagnosis &amp; Treatment" for "Diagnosis & Treatment"). Fall back
    // to slug match for safety.
    const exact = data.find(c => decodeWpEntities(c.name || '').trim().toLowerCase() === wanted)
      || data.find(c => (c.slug || '').toLowerCase() === slugify(name));
    const c = exact || null;
    return c ? { id: c.id, parent: c.parent ?? 0, name: c.name, slug: c.slug } : null;
  } catch {
    return null;
  }
}

/**
 * Create a new category. Returns { id, parent, name, slug } on success, null
 * on failure (e.g. permission denied, slug conflict).
 */
export async function createWpCategory({ name, slug, parent = 0 }, siteUrl, authHeader, fetchFn = fetch) {
  if (!name) return null;
  try {
    const resp = await fetchFn(`${siteUrl}/wp-json/wp/v2/categories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify({
        name,
        slug: slug || slugify(name),
        parent: parent || 0,
      }),
    });
    if (!resp.ok) {
      // term_exists (rest_term_exists / code 400) means another writer already
      // created it between our lookup and our create. Re-resolve by slug.
      const errBody = await resp.text();
      if (resp.status === 400 && /term.*exists/i.test(errBody)) {
        return await findWpCategoryBySlug(slug || slugify(name), siteUrl, authHeader, fetchFn);
      }
      console.warn(`[wp-taxonomy] createWpCategory failed ${resp.status}: ${errBody.slice(0, 200)}`);
      return null;
    }
    const c = await resp.json();
    return { id: c.id, parent: c.parent ?? 0, name: c.name, slug: c.slug };
  } catch (err) {
    console.warn(`[wp-taxonomy] createWpCategory error: ${err.message}`);
    return null;
  }
}

/**
 * Resolve a sub-category name (from the spreadsheet) to a WP category ID.
 *   1. Look up by slug (using slugify(name) as the candidate slug).
 *   2. Look up by name (fuzzy + exact-match filter).
 *   3. If still not found and autoCreate is true, create under the inferred
 *      or supplied parent and return the new ID.
 *
 * The parent is inferred via this priority:
 *   a) Caller-supplied parentSlug/parentName (from the rule / app category map).
 *   b) Posted at the top level (parent 0).
 *
 * Returns { id, created, term } where created is true if we made a new term.
 * Returns { id: null, created: false } on total failure.
 */
export async function resolveOrCreateWpCategory(
  name,
  { siteUrl, authHeader, parentSlug = null, parentName = null, autoCreate = true, fetchFn = fetch } = {}
) {
  if (!name) return { id: null, created: false };

  const trySlug = slugify(name);

  // 1. Direct slug lookup
  const bySlug = await findWpCategoryBySlug(trySlug, siteUrl, authHeader, fetchFn);
  if (bySlug) return { id: bySlug.id, created: false, term: bySlug };

  // 2. Name lookup (handles slug drift and HTML-entity-encoded WP names)
  const byName = await findWpCategoryByName(name, siteUrl, authHeader, fetchFn);
  if (byName) return { id: byName.id, created: false, term: byName };

  if (!autoCreate) return { id: null, created: false };

  // 3. Resolve a parent for the new term
  let parentId = 0;
  if (parentSlug) {
    const p = await findWpCategoryBySlug(parentSlug, siteUrl, authHeader, fetchFn);
    if (p) parentId = p.id;
  }
  if (!parentId && parentName) {
    const p = await findWpCategoryByName(parentName, siteUrl, authHeader, fetchFn);
    if (p) parentId = p.id;
  }

  const created = await createWpCategory(
    { name: name.trim(), slug: trySlug, parent: parentId },
    siteUrl, authHeader, fetchFn
  );
  if (!created) return { id: null, created: false };
  return { id: created.id, created: true, term: created };
}

// -- Tags --------------------------------------------------------------------

/**
 * Look up a tag by slug. Returns { id, name, slug } or null.
 */
export async function findWpTagBySlug(slug, siteUrl, authHeader, fetchFn = fetch) {
  if (!slug) return null;
  try {
    const resp = await fetchFn(
      `${siteUrl}/wp-json/wp/v2/tags?slug=${encodeURIComponent(slug)}&per_page=1`,
      { headers: { Authorization: authHeader } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data) || !data.length) return null;
    const t = data[0];
    return { id: t.id, name: t.name, slug: t.slug };
  } catch {
    return null;
  }
}

/**
 * Look up a tag by human-readable name (exact-match filter on the search hits).
 */
export async function findWpTagByName(name, siteUrl, authHeader, fetchFn = fetch) {
  if (!name) return null;
  try {
    const resp = await fetchFn(
      `${siteUrl}/wp-json/wp/v2/tags?search=${encodeURIComponent(name)}&per_page=20`,
      { headers: { Authorization: authHeader } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data) || !data.length) return null;
    const wanted = name.trim().toLowerCase();
    const exact = data.find(t => decodeWpEntities(t.name || '').trim().toLowerCase() === wanted)
      || data.find(t => (t.slug || '').toLowerCase() === slugify(name));
    return exact ? { id: exact.id, name: exact.name, slug: exact.slug } : null;
  } catch {
    return null;
  }
}

/**
 * Create a tag. Returns { id, name, slug } or null.
 */
export async function createWpTag({ name, slug }, siteUrl, authHeader, fetchFn = fetch) {
  if (!name) return null;
  try {
    const resp = await fetchFn(`${siteUrl}/wp-json/wp/v2/tags`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify({ name, slug: slug || slugify(name) }),
    });
    if (!resp.ok) {
      const errBody = await resp.text();
      if (resp.status === 400 && /term.*exists/i.test(errBody)) {
        return await findWpTagBySlug(slug || slugify(name), siteUrl, authHeader, fetchFn);
      }
      console.warn(`[wp-taxonomy] createWpTag failed ${resp.status}: ${errBody.slice(0, 200)}`);
      return null;
    }
    const t = await resp.json();
    return { id: t.id, name: t.name, slug: t.slug };
  } catch (err) {
    console.warn(`[wp-taxonomy] createWpTag error: ${err.message}`);
    return null;
  }
}

/**
 * Resolve a list of tag names to WP tag IDs. Creates missing tags if
 * autoCreate is true. Returns { ids, created, failed } where:
 *   - ids:     numeric WP tag IDs in input order (skipping nulls)
 *   - created: names of tags newly created during this call
 *   - failed:  names we couldn't resolve or create
 *
 * Empty / whitespace input names are silently skipped.
 */
export async function resolveOrCreateWpTags(
  names,
  { siteUrl, authHeader, autoCreate = true, fetchFn = fetch } = {}
) {
  const cleanNames = (Array.isArray(names) ? names : [])
    .map(n => String(n || '').trim())
    .filter(Boolean);
  if (!cleanNames.length) return { ids: [], created: [], failed: [] };

  const ids = [];
  const created = [];
  const failed = [];

  // De-dupe case-insensitively while preserving order
  const seen = new Set();
  const ordered = [];
  for (const n of cleanNames) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    ordered.push(n);
  }

  for (const name of ordered) {
    let found = await findWpTagBySlug(slugify(name), siteUrl, authHeader, fetchFn);
    if (!found) found = await findWpTagByName(name, siteUrl, authHeader, fetchFn);
    if (found) {
      ids.push(found.id);
      continue;
    }
    if (!autoCreate) {
      failed.push(name);
      continue;
    }
    const newTag = await createWpTag({ name, slug: slugify(name) }, siteUrl, authHeader, fetchFn);
    if (newTag) {
      ids.push(newTag.id);
      created.push(name);
    } else {
      failed.push(name);
    }
  }

  return { ids, created, failed };
}


/**
 * Parse a tag string from a spreadsheet cell into a list of names.
 * Accepts comma-separated or semicolon-separated strings; trims whitespace;
 * filters out empties. "IBD, IBS" -> ["IBD", "IBS"].
 */
export function parseTagList(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map(t => String(t || '').trim()).filter(Boolean);
  }
  return String(raw)
    .split(/[,;]/)
    .map(s => s.trim())
    .filter(Boolean);
}

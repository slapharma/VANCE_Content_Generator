import { kv } from '../../lib/kv.js';
import { resolveOrCreateWpCategory, resolveOrCreateWpTags, parseTagList } from '../../lib/wp-taxonomy.js';

// Map app category IDs → WordPress category slugs. Mirrors BUILTIN_CATEGORY_META in index.html.
// Acts as the *parent* category when a content item arrives with a sub-category
// (i.e. a per-row category name like "Lifestyle & Wellbeing" from the bulk-upload
// spreadsheet). The sub-category becomes the assigned category; the entry below
// only tells us which parent to nest a freshly auto-created sub-category under.
const CATEGORY_SLUG_MAP = {
  'industry-news':    'content-healthcare-news',
  'clinical-reviews': 'content-clinical-reviews',
  'op-eds':           'content-expert-opinions',
  'white-papers':     'content-white-papers',
  'infographics':     'content-infographic',
  'ibd-living':       'content-gastro-living',
};

// Resolve a WP category slug to its numeric ID via the REST API.
// Returns the ID on success, or null if not found / on error.
async function resolveWpCategoryId(slug, siteUrl, authHeader) {
  try {
    const resp = await fetch(
      `${siteUrl}/wp-json/wp/v2/categories?slug=${encodeURIComponent(slug)}&per_page=1`,
      { headers: { Authorization: authHeader } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return Array.isArray(data) && data.length > 0 ? data[0].id : null;
  } catch {
    return null;
  }
}

/**
 * Download an external image URL and upload it to the WordPress media library.
 * Returns the WP media object ID, or null on failure.
 */
async function uploadHeroImageToWp(imageUrl, postTitle, siteUrl, authHeader) {
  try {
    // Fetch the image binary from the external URL
    const imgResp = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VanceBot/1.0; +https://gastrohealthhub.com)',
        'Accept': 'image/*',
      },
      redirect: 'follow',
    });
    if (!imgResp.ok) {
      console.warn(`[publish] Hero image fetch failed ${imgResp.status}: ${imageUrl}`);
      return null;
    }

    const contentType = imgResp.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      console.warn(`[publish] Hero image URL returned non-image content-type: ${contentType}`);
      return null;
    }

    const buffer = Buffer.from(await imgResp.arrayBuffer());
    const ext    = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
    const slug   = (postTitle || 'hero').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
    const filename = `${slug}-hero.${ext}`;

    const mediaResp = await fetch(`${siteUrl}/wp-json/wp/v2/media`, {
      method: 'POST',
      headers: {
        'Authorization':        authHeader,
        'Content-Type':         contentType,
        'Content-Disposition':  `attachment; filename="${filename}"`,
      },
      body: buffer,
    });

    if (!mediaResp.ok) {
      const err = await mediaResp.text();
      console.warn(`[publish] WP media upload failed ${mediaResp.status}: ${err}`);
      return null;
    }

    const media = await mediaResp.json();
    return media.id ?? null;
  } catch (err) {
    console.warn(`[publish] Hero image upload error: ${err.message}`);
    return null;
  }
}

// Convert raw markdown/LLM output to clean WordPress HTML
function markdownToWpHtml(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const html = [];
  let subtitleDone = false;
  let listType = null; // 'ul' | 'ol' | null — tracks an open list block

  const closeList = () => { if (listType) { html.push(`</${listType}>`); listType = null; } };

  // Inline markdown → HTML: **bold** and *italic* (italic guarded against word-internal *)
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<em>$1</em>');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { closeList(); html.push(''); continue; }

    // Drop the "Reading Time" meta line — it's an editorial label, not published body.
    // Matches "Reading Time: 6 minutes" with optional ** bold wrappers.
    if (/^\**\s*reading time\b/i.test(trimmed)) continue;

    // List items: "- "/"* "/"• " → <ul>, "1. "/"1) " → <ol>. Consecutive items group
    // into one list; any other line (or blank) closes it.
    const ulMatch = trimmed.match(/^[-*•]\s+(.*)$/);
    const olMatch = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (ulMatch || olMatch) {
      const wantType = ulMatch ? 'ul' : 'ol';
      if (listType && listType !== wantType) closeList();
      if (!listType) { listType = wantType; html.push(`<${wantType}>`); }
      html.push(`<li>${inline((ulMatch ? ulMatch[1] : olMatch[1]).trim())}</li>`);
      continue;
    }
    closeList();

    // Strip ** wrappers from standalone heading lines (e.g. "**Background & Rationale**")
    const boldOnly = trimmed.match(/^\*\*(.+?)\*\*$/);

    // Markdown headings → first body "# " is the subtitle (<h1>); "## " → <h2>; "### " → <h3>
    if (trimmed.startsWith('### '))     { html.push(`<h3>${trimmed.slice(4).replace(/\*\*/g, '')}</h3>`); continue; }
    if (trimmed.startsWith('## '))      { html.push(`<h2>${trimmed.slice(3).replace(/\*\*/g, '')}</h2>`); continue; }
    if (trimmed.startsWith('# '))       {
      const txt = trimmed.slice(2).replace(/\*\*/g, '');
      if (!subtitleDone) { subtitleDone = true; html.push(`<h1>${txt}</h1>`); continue; }
      html.push(`<h2>${txt}</h2>`); continue;
    }

    // Bold-only lines that look like section headers → <h2>
    if (boldOnly) {
      const inner = boldOnly[1].trim();
      const isHeader = /^(Background|Study Design|Patient Population|Key Findings|Discussion|Safety|Authors|Reference|Clinical Relevance|Conclusions|Disclaimer)/i.test(inner);
      if (isHeader) { html.push(`<h2>${inner}</h2>`); continue; }
    }

    html.push(`<p>${inline(trimmed)}</p>`);
  }
  closeList();

  return html.filter(l => l !== '').join('\n');
}

export function buildWpPayload(item, categoryIds, tagIds = [], featuredMediaId = null) {
  return {
    title:      item.title,
    content:    markdownToWpHtml(item.body),
    excerpt:    item.excerpt ?? '',
    status:     'publish',
    categories: Array.isArray(categoryIds) && categoryIds.length > 0 ? categoryIds : [],
    tags:       Array.isArray(tagIds) && tagIds.length > 0 ? tagIds : [],
    ...(featuredMediaId ? { featured_media: featuredMediaId } : {}),
  };
}

async function publishToWordPress(item, { fallbackHeroImageUrl } = {}) {
  const credentials = Buffer.from(
    `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`
  ).toString('base64');
  const authHeader = `Basic ${credentials}`;
  const siteUrl    = (process.env.WP_SITE_URL ?? '').trim().replace(/\/$/, '');

  // ── Category resolution ─────────────────────────────────────────────────
  // Posts are assigned to BOTH the parent app-category (e.g. "Gastro Living")
  // AND the per-row sub-category (e.g. "Understanding Your Condition") when a
  // sub-category is provided. This keeps category-archive pages working at
  // both levels — /category/content-gastro-living/ continues to list every
  // post, while /category/understanding-your-condition/ filters to the slice.
  //
  // Resolution priority:
  //   • Parent: item.wpCategorySlug → CATEGORY_SLUG_MAP[item.category]
  //   • Sub-category: item.subCategory (resolved by name/slug, auto-created
  //                    under the parent if missing)
  //
  // Both IDs land in categoryIds[]. When no sub-category is provided, only
  // the parent is assigned (legacy behaviour).
  const parentAppSlug = CATEGORY_SLUG_MAP[item.category] || null;
  const explicitSlug  = item.wpCategorySlug || parentAppSlug || null;
  const categoryIdsSet = new Set();
  let subCategoryCreated = false;
  let subCategoryResolved = null;

  // Diagnostic: what taxonomy data did the content record carry in?
  console.log(`[publish] item ${item.id} taxonomy input — category="${item.category}" wpCategorySlug="${item.wpCategorySlug || ''}" subCategory="${item.subCategory || ''}" tags=${JSON.stringify(item.tags)}`);

  // Resolve the parent category first so we always have it in the assignment.
  if (explicitSlug) {
    const parentId = await resolveWpCategoryId(explicitSlug, siteUrl, authHeader);
    if (parentId) {
      categoryIdsSet.add(parentId);
    } else {
      console.warn(`[publish] WP parent category slug "${explicitSlug}" not found — proceeding without parent`);
    }
  }

  // Resolve the sub-category and attach it alongside the parent.
  if (item.subCategory && String(item.subCategory).trim()) {
    const resolved = await resolveOrCreateWpCategory(item.subCategory, {
      siteUrl,
      authHeader,
      parentSlug: parentAppSlug,
      autoCreate: true,
    });
    if (resolved.id) {
      categoryIdsSet.add(resolved.id);
      subCategoryCreated = resolved.created === true;
      subCategoryResolved = resolved.term || null;
      if (subCategoryCreated) {
        console.log(`[publish] Auto-created WP sub-category "${item.subCategory}" (id ${resolved.id}) under parent slug "${parentAppSlug || 'top-level'}"`);
      }
    } else {
      console.warn(`[publish] Sub-category "${item.subCategory}" could not be resolved or created — posting under parent only`);
    }
  }

  const categoryIds = Array.from(categoryIdsSet);

  // ── Tag resolution ──────────────────────────────────────────────────────
  // item.tags can be: a comma-separated string ("IBD, IBS"), an array of
  // strings, or null/undefined. parseTagList normalises to a string array.
  let tagIds = [];
  let tagsCreated = [];
  const tagNames = parseTagList(item.tags);
  if (tagNames.length) {
    const tagResult = await resolveOrCreateWpTags(tagNames, {
      siteUrl,
      authHeader,
      autoCreate: true,
    });
    tagIds = tagResult.ids;
    tagsCreated = tagResult.created;
    if (tagsCreated.length) {
      console.log(`[publish] Auto-created WP tags: ${tagsCreated.join(', ')}`);
    }
    if (tagResult.failed?.length) {
      console.warn(`[publish] Failed to resolve/create WP tags: ${tagResult.failed.join(', ')}`);
    }
  }

  // Upload hero image and get media ID (non-fatal if it fails). Falls back to the
  // category-level hero image when the article has none.
  let featuredMediaId = null;
  const heroUrl = item.heroImageUrl || fallbackHeroImageUrl || null;
  if (heroUrl) {
    featuredMediaId = await uploadHeroImageToWp(heroUrl, item.title, siteUrl, authHeader);
    if (featuredMediaId) {
      const source = item.heroImageUrl ? 'article' : 'category fallback';
      console.log(`[publish] Hero image uploaded as WP media ID ${featuredMediaId} (${source})`);
    }
  }

  const response = await fetch(`${siteUrl}/wp-json/wp/v2/posts`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': authHeader,
    },
    body: JSON.stringify(buildWpPayload(item, categoryIds, tagIds, featuredMediaId)),
  });

  if (!response.ok) {
    const err = await response.text();
    // Include which username was attempted to aid debugging
    throw new Error(`WordPress API ${response.status} (user: ${process.env.WP_USERNAME ?? 'not set'}, site: ${process.env.WP_SITE_URL ?? 'not set'}): ${err}`);
  }
  const wpPost = await response.json();
  // Surface taxonomy outcomes so the caller (the cron handler / KV record) can
  // tell whether terms were auto-created — useful for the upload-preview UI to
  // confirm what landed in WP after a batch run.
  return {
    ...wpPost,
    _taxonomy: {
      categoryIds,
      tagIds,
      subCategoryCreated,
      subCategoryResolved,
      tagsCreated,
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { contentId, fallbackHeroImageUrl } = req.body;
  if (!contentId) return res.status(400).json({ error: 'contentId required' });

  const item = await kv.get(`content:${contentId}`);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (!['approved', 'scheduled'].includes(item.status)) {
    return res.status(400).json({ error: 'Content must be approved or scheduled to publish' });
  }

  let wpPost;
  try {
    wpPost = await publishToWordPress(item, { fallbackHeroImageUrl });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  const updated = {
    ...item,
    status: 'published',
    publishedAt: new Date().toISOString(),
    wpPostId: wpPost.id,
    wpPostUrl: wpPost.link,
    // Snapshot taxonomy outcomes onto the content record so the dashboard /
    // logs can show what category + tags landed in WP without an extra fetch.
    wpCategoryIds: wpPost._taxonomy?.categoryIds ?? [],
    wpTagIds:      wpPost._taxonomy?.tagIds ?? [],
    wpAutoCreatedSubCategory: wpPost._taxonomy?.subCategoryCreated ?? false,
    wpAutoCreatedTags:        wpPost._taxonomy?.tagsCreated ?? [],
    updatedAt: new Date().toISOString(),
  };
  await kv.set(`content:${contentId}`, updated);
  return res.json({
    wpPostId: wpPost.id,
    wpPostUrl: wpPost.link,
    taxonomy: wpPost._taxonomy ?? null,
  });
}

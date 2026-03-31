import { kv } from '@vercel/kv';

// Map app category IDs → WordPress category slugs
const CATEGORY_SLUG_MAP = {
  'industry-news':    'content-healthcare-news',
  'clinical-reviews': 'content-clinical-reviews',
  'op-eds':           'content-expert-opinions',
  'white-papers':     'content-white-papers',
  'infographics':     'content-infographic',
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
        'User-Agent': 'Mozilla/5.0 (compatible; IBDHealthHubBot/1.0; +https://ibdhealthhub.com)',
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

export function buildWpPayload(item, categoryIds, featuredMediaId = null) {
  return {
    title:      item.title,
    content:    item.body,
    excerpt:    item.excerpt ?? '',
    status:     'publish',
    categories: Array.isArray(categoryIds) && categoryIds.length > 0 ? categoryIds : [],
    ...(featuredMediaId ? { featured_media: featuredMediaId } : {}),
  };
}

async function publishToWordPress(item) {
  const credentials = Buffer.from(
    `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`
  ).toString('base64');
  const authHeader = `Basic ${credentials}`;
  const siteUrl    = (process.env.WP_SITE_URL ?? '').trim().replace(/\/$/, '');

  // Resolve category slug → numeric ID
  // item.wpCategorySlug takes precedence (set per-item from category config)
  const slug       = item.wpCategorySlug || CATEGORY_SLUG_MAP[item.category] || null;
  const categoryId = slug ? await resolveWpCategoryId(slug, siteUrl, authHeader) : null;
  const categoryIds = categoryId ? [categoryId] : [];

  if (slug && !categoryId) {
    console.warn(`[publish] WP category slug "${slug}" not found — posting without category`);
  }

  // Upload hero image and get media ID (non-fatal if it fails)
  let featuredMediaId = null;
  if (item.heroImageUrl) {
    featuredMediaId = await uploadHeroImageToWp(item.heroImageUrl, item.title, siteUrl, authHeader);
    if (featuredMediaId) {
      console.log(`[publish] Hero image uploaded as WP media ID ${featuredMediaId}`);
    }
  }

  const response = await fetch(`${siteUrl}/wp-json/wp/v2/posts`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': authHeader,
    },
    body: JSON.stringify(buildWpPayload(item, categoryIds, featuredMediaId)),
  });

  if (!response.ok) {
    const err = await response.text();
    // Include which username was attempted to aid debugging
    throw new Error(`WordPress API ${response.status} (user: ${process.env.WP_USERNAME ?? 'not set'}, site: ${process.env.WP_SITE_URL ?? 'not set'}): ${err}`);
  }
  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { contentId } = req.body;
  if (!contentId) return res.status(400).json({ error: 'contentId required' });

  const item = await kv.get(`content:${contentId}`);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (!['approved', 'scheduled'].includes(item.status)) {
    return res.status(400).json({ error: 'Content must be approved or scheduled to publish' });
  }

  let wpPost;
  try {
    wpPost = await publishToWordPress(item);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  const updated = {
    ...item,
    status: 'published',
    publishedAt: new Date().toISOString(),
    wpPostId: wpPost.id,
    wpPostUrl: wpPost.link,
    updatedAt: new Date().toISOString(),
  };
  await kv.set(`content:${contentId}`, updated);
  return res.json({ wpPostId: wpPost.id, wpPostUrl: wpPost.link });
}

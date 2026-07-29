// lib/social/wp-media.js
//
// Uploads image bytes to the WordPress media library.
//
// Extracted from api/publish/index.js's uploadHeroImageToWp when the carousel
// renderer needed the same capability. The WP media library is the natural host
// for rendered carousel slides: Instagram's Graph API needs publicly reachable
// image URLs, WP gives permanent ones on the brand's own domain, and a media
// upload does not require a post to exist — which matters because carousels are
// built before review-path articles are published.
//
// Everything here is non-fatal by contract: callers get `null` rather than an
// exception, because a failed image upload should never take down a publish or an
// article generation.

/** WP credentials + site URL from env, in the shape the REST calls want. */
export function wpAuth() {
  const credentials = Buffer.from(
    `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`,
  ).toString('base64');
  return {
    authHeader: `Basic ${credentials}`,
    siteUrl: (process.env.WP_SITE_URL ?? '').trim().replace(/\/$/, ''),
  };
}

/** `image/png` → `png`, defaulting to `jpg`. */
function extFor(contentType) {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  return 'jpg';
}

/** Title → filename-safe slug. */
export function slugify(value, maxLen = 40) {
  return String(value || 'image').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, maxLen) || 'image';
}

/**
 * Upload a buffer to the WP media library, optionally stamping attribution
 * metadata onto the created media item.
 *
 * The metadata write is a second request because WP's binary upload endpoint
 * takes the file body and nothing else. It is deliberately non-fatal: losing a
 * caption is a far smaller problem than losing the image.
 *
 * @param {Buffer} buffer
 * @param {object} opts
 * @param {string} opts.filename
 * @param {string} [opts.contentType='image/jpeg']
 * @param {string} opts.siteUrl
 * @param {string} opts.authHeader
 * @param {{plain: string, html?: string}} [opts.credit] - attribution to stamp
 * @param {string} [opts.logPrefix='wp-media']
 * @returns {Promise<{id: number, url: string}|null>}
 */
export async function uploadImageBufferToWp(buffer, {
  filename,
  contentType = 'image/jpeg',
  siteUrl,
  authHeader,
  credit = null,
  logPrefix = 'wp-media',
} = {}) {
  try {
    const mediaResp = await fetch(`${siteUrl}/wp-json/wp/v2/media`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
      body: buffer,
    });

    if (!mediaResp.ok) {
      const err = await mediaResp.text();
      console.warn(`[${logPrefix}] WP media upload failed ${mediaResp.status}: ${err}`);
      return null;
    }

    const media = await mediaResp.json();
    if (!media.id) return null;

    if (credit?.plain) {
      try {
        await fetch(`${siteUrl}/wp-json/wp/v2/media/${media.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
          body: JSON.stringify({
            alt_text:    credit.plain,
            caption:     credit.html || credit.plain,
            description: credit.html || credit.plain,
          }),
        });
      } catch (metaErr) {
        console.warn(`[${logPrefix}] credit metadata write failed: ${metaErr.message}`);
      }
    }

    return { id: media.id, url: media.source_url || null };
  } catch (err) {
    console.warn(`[${logPrefix}] upload error: ${err.message}`);
    return null;
  }
}

/**
 * Permanently delete WP media items by id.
 *
 * Needed because WP never overwrites: re-uploading the same filename yields
 * `…-1.jpg`, `…-2.jpg` and so on. Without this, every carousel re-render would
 * orphan its previous slides and the media library would grow by 8 files a go.
 *
 * `force: true` bypasses the trash — a superseded slide has no value in there, and
 * leaving it would just move the clutter. Failures are logged and swallowed:
 * housekeeping must never fail a render that has already succeeded.
 *
 * @param {number[]} ids
 * @returns {Promise<{attempted: number, deleted: number, errors: string[]}>}
 */
export async function deleteWpMedia(ids, { siteUrl, authHeader, logPrefix = 'wp-media' } = {}) {
  const targets = ids.filter(Boolean);
  let deleted = 0;
  const errors = [];
  for (const id of targets) {
    try {
      const res = await fetch(`${siteUrl}/wp-json/wp/v2/media/${id}?force=true`, {
        method: 'DELETE',
        headers: { Authorization: authHeader },
      });
      if (res.ok) { deleted++; continue; }
      // Body carries WP's actual reason (usually a capability error), which the
      // status code alone does not tell you.
      const body = await res.text().catch(() => '');
      const reason = `media ${id}: HTTP ${res.status} ${body.slice(0, 160)}`;
      errors.push(reason);
      console.warn(`[${logPrefix}] could not delete ${reason}`);
    } catch (err) {
      errors.push(`media ${id}: ${err.message}`);
      console.warn(`[${logPrefix}] could not delete media ${id}: ${err.message}`);
    }
  }
  return { attempted: targets.length, deleted, errors };
}

/**
 * Fetch an image from an external URL and upload it to the WP media library.
 *
 * @param {string} imageUrl
 * @param {object} opts - as uploadImageBufferToWp, plus `title` for the filename
 * @returns {Promise<{id: number, url: string}|null>}
 */
export async function uploadImageUrlToWp(imageUrl, {
  title,
  siteUrl,
  authHeader,
  credit = null,
  suffix = 'hero',
  logPrefix = 'wp-media',
} = {}) {
  try {
    const imgResp = await fetch(imageUrl, {
      headers: {
        // Some stock CDNs reject requests without a browser-ish UA.
        'User-Agent': 'Mozilla/5.0 (compatible; VanceBot/1.0; +https://vancehealthhub.co.uk)',
        'Accept': 'image/*',
      },
      redirect: 'follow',
    });
    if (!imgResp.ok) {
      console.warn(`[${logPrefix}] image fetch failed ${imgResp.status}: ${imageUrl}`);
      return null;
    }

    const contentType = imgResp.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      console.warn(`[${logPrefix}] URL returned non-image content-type: ${contentType}`);
      return null;
    }

    const buffer = Buffer.from(await imgResp.arrayBuffer());
    return uploadImageBufferToWp(buffer, {
      filename: `${slugify(title || suffix)}-${suffix}.${extFor(contentType)}`,
      contentType,
      siteUrl,
      authHeader,
      credit,
      logPrefix,
    });
  } catch (err) {
    console.warn(`[${logPrefix}] image upload error: ${err.message}`);
    return null;
  }
}

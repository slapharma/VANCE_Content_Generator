// lib/social/instagram-permalink.js
//
// Turn a recorded Instagram media id into a public post URL.
//
// Posting records `platformPostId`, which is the Graph API's *media id* — not
// the shortcode the public URL is built from. There is no way to derive one from
// the other locally, so the URL has to be asked for.
//
// Two routes, tried in order, because this app can post either way:
//   1. The direct Graph API, when INSTAGRAM_ACCESS_TOKEN is configured. One
//      request, authoritative.
//   2. Composio, when posting runs through a connected account (the live setup).
//      Composio's Instagram toolkit is not guaranteed to expose a media-read
//      tool, so this tries a short list of plausible slugs and gives up quietly.
//
// The outcome is cached on the carousel record either way. A success is cached
// forever (a permalink does not change); a failure is cached only for a day,
// because the usual reason for failing is a missing credential and a permanent
// negative would mean configuring INSTAGRAM_ACCESS_TOKEN silently fixed nothing
// for every post already checked.

const GRAPH_BASE = 'https://graph.facebook.com/v19.0';

/** How long a failed lookup is trusted before the ladder is walked again. */
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

/** Composio slugs that might return media fields. Order is best-guess-first;
 *  every one of them is optional and a miss is not an error. */
const COMPOSIO_MEDIA_SLUGS = [
  'INSTAGRAM_GET_MEDIA',
  'INSTAGRAM_GET_MEDIA_BY_ID',
  'INSTAGRAM_GET_USER_MEDIA',
];

/** Dig a permalink out of whatever envelope a tool happens to return. */
function permalinkFrom(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const direct = payload.permalink || payload.data?.permalink
    || payload.response_data?.permalink || payload.media?.permalink;
  if (typeof direct === 'string' && direct.startsWith('http')) return direct;
  // Some list-shaped tools nest the record in `data.data[]`.
  const list = payload.data?.data || payload.items || payload.data?.items;
  if (Array.isArray(list)) {
    const hit = list.find((m) => typeof m?.permalink === 'string');
    if (hit) return hit.permalink;
  }
  return null;
}

async function viaGraph(mediaId) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) return null;
  const url = `${GRAPH_BASE}/${encodeURIComponent(mediaId)}`
    + `?fields=permalink,timestamp,media_type&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`[ig-permalink] graph lookup failed ${res.status} for ${mediaId}`);
    return null;
  }
  return permalinkFrom(await res.json());
}

async function viaComposio(mediaId, account) {
  if (!account?.connectedAccountId) return null;
  const { isComposioConfigured, executeTool } = await import('./composio.js');
  if (!isComposioConfigured()) return null;

  for (const slug of COMPOSIO_MEDIA_SLUGS) {
    try {
      const out = await executeTool(slug, {
        connectedAccountId: account.connectedAccountId,
        arguments: { media_id: mediaId, id: mediaId, fields: 'permalink,timestamp,media_type' },
      });
      const link = permalinkFrom(out);
      if (link) return link;
    } catch (err) {
      // An unknown slug and a permissions failure look the same from here, and
      // neither is worth surfacing — the caller has a fallback.
      console.log(`[ig-permalink] ${slug} did not resolve: ${err.message.slice(0, 120)}`);
    }
  }
  return null;
}

/**
 * @param {object} carousel - a posted deck record
 * @param {object|null} account - the resolved Instagram account, for Composio
 * @returns {Promise<{permalink: string|null, reason?: string, cached?: boolean}>}
 */
export async function resolveInstagramPermalink(carousel, account) {
  if (carousel.permalink) return { permalink: carousel.permalink, cached: true };

  const checkedAt = Date.parse(carousel.permalinkCheckedAt || '');
  const fresh = Number.isFinite(checkedAt) && Date.now() - checkedAt < NEGATIVE_TTL_MS;
  if (carousel.permalinkUnavailable && fresh) {
    return { permalink: null, reason: carousel.permalinkUnavailable, cached: true };
  }

  const mediaId = carousel.platformPostId;
  if (!mediaId) {
    return { permalink: null, reason: 'No Instagram media id was recorded for this post.' };
  }

  const link = (await viaGraph(mediaId)) || (await viaComposio(mediaId, account));
  if (link) return { permalink: link };

  return {
    permalink: null,
    reason: 'Instagram did not return a public URL for this post. Posting runs through '
      + 'Composio, whose Instagram toolkit does not expose a media-read call, and no direct '
      + 'Graph API token is configured. Open the account profile to find the post.',
  };
}

/** The public profile page for an account, used as the fallback destination. */
export function profileUrlFor(account) {
  const handle = String(account?.label || '').trim().replace(/^@/, '');
  // Labels are free text; only treat one as a handle if it actually looks like one.
  return /^[A-Za-z0-9._]{1,30}$/.test(handle) ? `https://www.instagram.com/${handle}/` : null;
}

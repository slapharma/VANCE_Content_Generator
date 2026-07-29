// lib/social/platforms/composio.js
// Composio-backed posting adapter — one adapter for all five platforms,
// selected per kit by the connected account. Maps a kit's platform slice to
// the right Composio tool slug + arguments and normalises the result to
// { postId }, matching the legacy env-var adapters.
//
// Tool slugs and argument names below were VERIFIED on 2026-07-01 against the
// live Composio toolkit schemas (via c.tools.getRawComposioToolBySlug) using a
// valid API key. Two things still need a live end-to-end post to fully confirm
// and are flagged // VERIFY-LIVE:
//   1. Whether Composio auto-injects Facebook `page_id` / Instagram `ig_user_id`
//      from the connected account, or requires them explicitly (we pass them
//      from account.config when present — see lib/social/accounts.js).
//   2. The exact result field carrying the created post id per tool (we read a
//      set of likely keys and fall back to null).

import { executeTool } from '../composio.js';

// Verified tool slugs per platform action (2026-07-01 live introspection).
const SLUGS = {
  twitter_post:      'TWITTER_CREATION_OF_A_POST',
  linkedin_share:    'LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE',
  facebook_feed:     'FACEBOOK_CREATE_POST',        // text/link post
  facebook_photo:    'FACEBOOK_CREATE_PHOTO_POST',  // post with image url
  instagram_create:  'INSTAGRAM_CREATE_MEDIA_CONTAINER',
  instagram_publish: 'INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH',
  tiktok_publish:    'TIKTOK_PUBLISH_VIDEO',        // publishes from a public video URL
  // Account-discovery trio (see accounts.js discoverInstagramAccounts) — walks
  // Facebook Pages → their linked Instagram Business Account → that account's
  // profile, so every Instagram account reachable from the connected Meta
  // login can be found and offered for registration.
  facebook_list_pages: 'FACEBOOK_LIST_MANAGED_PAGES',
  facebook_page_details: 'FACEBOOK_GET_PAGE_DETAILS',
  instagram_user_info: 'INSTAGRAM_GET_USER_INFO',
};

function fullCaption(data) {
  const tags = Array.isArray(data.hashtags) && data.hashtags.length
    ? '\n\n' + data.hashtags.map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')
    : '';
  return `${data.caption || ''}${tags}`.trim();
}

async function postTwitter(data, acct) {
  // Thread of up to 3 posts, chained as replies via reply_in_reply_to_tweet_id.
  const thread = Array.isArray(data.thread) && data.thread.length
    ? data.thread
    : [fullCaption(data)];
  let firstId = null;
  let prevId = null;
  for (const text of thread) {
    const args = { text };
    if (prevId) args.reply_in_reply_to_tweet_id = prevId;
    const out = await executeTool(SLUGS.twitter_post, {
      connectedAccountId: acct.connectedAccountId,
      arguments: args,
    });
    const id = out?.data?.id || out?.id || out?.tweet_id;
    if (!firstId) firstId = id;
    prevId = id;
  }
  return { postId: firstId };
}

async function postLinkedIn(data, acct) {
  // LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE requires author URN + nested UGC content,
  // and (confirmed live) rejects text-only posts — media must have ≥1 item. So we
  // always post an ARTICLE share carrying a URL, with the caption as commentary.
  // URL priority: kit's own link → configurable brand fallback. data.link is
  // injected at posting time from the article's published wpPostUrl (see
  // lib/social/article-link.js), so each post links to its own article.
  const authorUrn = acct.config?.authorUrn;
  if (!authorUrn) {
    throw new Error('LinkedIn account needs config.authorUrn (urn:li:person:… or urn:li:organization:…). Set it when registering the account.');
  }
  const url = data.link || data.url
    || process.env.SOCIAL_LINKEDIN_SHARE_URL || 'https://vancemedicalfoods.com';
  const caption = fullCaption(data);
  const title = data.linkTitle || (caption.split('\n')[0] || 'Vance Medical Foods').slice(0, 180);
  const description = (data.linkDescription || caption || 'Vance Medical Foods').slice(0, 250);
  const args = {
    author: authorUrn,
    lifecycleState: 'PUBLISHED',
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text: caption },
        shareMediaCategory: 'ARTICLE',
        media: [{ status: 'READY', originalUrl: url, title: { text: title }, description: { text: description } }],
      },
    },
  };
  const out = await executeTool(SLUGS.linkedin_share, {
    connectedAccountId: acct.connectedAccountId,
    arguments: args,
  });
  return { postId: out?.data?.id || out?.id || out?.urn || out?.activity || null };
}

async function postFacebook(data, acct) {
  const message = fullCaption(data);
  // page_id is a required arg on both FB tools. Pass it from account.config when
  // present; if the connected account already scopes to a page, Composio may
  // inject it. // VERIFY-LIVE on first real post.
  const pageId = acct.config?.pageId;
  if (data.image?.url) {
    const args = { url: data.image.url, message };
    if (pageId) args.page_id = pageId;
    const out = await executeTool(SLUGS.facebook_photo, {
      connectedAccountId: acct.connectedAccountId,
      arguments: args,
    });
    return { postId: out?.data?.id || out?.id || out?.post_id || null };
  }
  const args = { message };
  if (pageId) args.page_id = pageId;
  const out = await executeTool(SLUGS.facebook_feed, {
    connectedAccountId: acct.connectedAccountId,
    arguments: args,
  });
  return { postId: out?.data?.id || out?.id || out?.post_id || null };
}

async function postInstagram(data, acct) {
  // Two-step: create a media container, then publish it. Both accept ig_user_id;
  // publish requires it (accepts 'me'), create infers from the connection.
  const igUserId = acct.config?.igUserId || 'me';
  const isReel = Boolean(data.video?.url);
  const createArgs = isReel
    ? { content_type: 'reel', video_url: data.video.url, caption: fullCaption(data), ig_user_id: igUserId }
    : { content_type: 'photo', image_url: data.image?.url, caption: fullCaption(data), ig_user_id: igUserId };
  const created = await executeTool(SLUGS.instagram_create, {
    connectedAccountId: acct.connectedAccountId,
    arguments: createArgs,
  });
  const creationId = created?.data?.id || created?.id || created?.creation_id || created?.container_id;
  if (!creationId) throw new Error('Instagram: no creation/container id returned');
  const published = await executeTool(SLUGS.instagram_publish, {
    connectedAccountId: acct.connectedAccountId,
    arguments: { creation_id: creationId, ig_user_id: igUserId },
  });
  return { postId: published?.data?.id || published?.id || creationId };
}

async function postTikTok(data, acct) {
  if (!data.video?.url) throw new Error('TikTok requires a video — none in kit');
  const out = await executeTool(SLUGS.tiktok_publish, {
    connectedAccountId: acct.connectedAccountId,
    arguments: { video_url: data.video.url, caption: fullCaption(data) },
  });
  return { postId: out?.data?.publish_id || out?.publish_id || out?.data?.id || out?.id || null };
}

const ROUTERS = {
  twitter:   postTwitter,
  linkedin:  postLinkedIn,
  facebook:  postFacebook,
  instagram: postInstagram,
  tiktok:    postTikTok,
};

/**
 * Post a kit's platform slice via the given Composio-connected account.
 * @param {string} platform
 * @param {object} platformData - the kit.platforms[platform] slice
 * @param {object} account - { connectedAccountId, config?, ... }
 * @returns {Promise<{ postId: string|null }>}
 */
/**
 * Discover Instagram Business Accounts reachable from the connected Meta
 * login, by walking Facebook Pages → each Page's linked Instagram Business
 * Account → that account's profile. This is the same shape the app's two
 * Facebook accounts already use (one connectedAccountId, distinguished by
 * `config.pageId`/`config.igUserId`) — Instagram accounts just haven't had a
 * way to be found and registered until now.
 *
 * `facebookConnectedAccountId` is required: FACEBOOK_LIST_MANAGED_PAGES and
 * FACEBOOK_GET_PAGE_DETAILS are Facebook-toolkit tools and need a Facebook
 * connection to run against. `instagramConnectedAccountId` is optional: when
 * present, each candidate's username is resolved via INSTAGRAM_GET_USER_INFO
 * (querying a sibling IG account through an already-connected one works per
 * the tool's own docs); when absent, candidates are still returned with a
 * null username rather than failing outright.
 *
 * @returns {Promise<Array<{igUserId, username, pageId, pageName}>>}
 */
/**
 * Pull the linked Instagram Business Account id out of a Page-details payload.
 *
 * Composio's envelope nesting varies by SDK version — the sibling
 * FACEBOOK_LIST_MANAGED_PAGES call above already needs `data?.data || data`
 * handling, and this call was reading `details.instagram_business_account`
 * directly, so any deeper nesting read as "this Page has no Instagram account".
 * That is silent: the Graph API omits the field on a permission gap rather than
 * erroring, so a shape mismatch and a genuinely unlinked Page look identical.
 *
 * Checks the known nestings first, then falls back to a bounded search so a new
 * envelope shape degrades to "found it anyway" instead of "found nothing".
 */
function pickIgBusinessAccountId(details, depth = 0) {
  if (!details || typeof details !== 'object' || depth > 4) return null;

  const direct = details.instagram_business_account;
  if (direct) return typeof direct === 'string' ? direct : (direct.id || null);
  // Some tools return the id flattened rather than as an object.
  if (details.instagram_business_account_id) return details.instagram_business_account_id;

  for (const nested of [details.data, details.response_data, details.page, details.result]) {
    const hit = pickIgBusinessAccountId(nested, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export async function discoverInstagramAccounts({ facebookConnectedAccountId, instagramConnectedAccountId }) {
  if (!facebookConnectedAccountId) {
    throw new Error('No Facebook account connected — Instagram Business accounts are discovered via their linked Facebook Page, so connect Facebook first.');
  }

  const pagesRes = await executeTool(SLUGS.facebook_list_pages, {
    connectedAccountId: facebookConnectedAccountId,
    arguments: {},
  });
  // Composio's own docs flag this: results can land under `data` or `data.data`
  // depending on SDK version.
  const pages = pagesRes?.data?.data || pagesRes?.data || pagesRes || [];
  if (!Array.isArray(pages) || !pages.length) {
    // Temporary shape diagnostic — FACEBOOK_LIST_MANAGED_PAGES' nesting has
    // varied across SDK versions in this codebase's own experience (see the
    // comment above); log what actually came back so a genuine "no pages"
    // result is distinguishable from an unrecognised shape.
    console.warn('[discoverInstagramAccounts] no pages resolved from FACEBOOK_LIST_MANAGED_PAGES');
    return { candidates: [], pagesSeen: [], unlinkedPages: [] };
  }

  // The Page count is the hard ceiling on discovery: an Instagram Business
  // account is only reachable through the Page it is linked to, so "I have N
  // Instagram accounts but only see M Pages" is a Facebook-permissions answer,
  // not a bug in the walk below.
  console.log(`[discoverInstagramAccounts] ${pages.length} managed Page(s) visible: `
    + pages.map((p) => p?.name || p?.id).join(', '));

  const candidates = [];
  const unlinkedPages = [];
  for (const page of pages) {
    const pageId = page?.id;
    if (!pageId) continue;
    let details;
    try {
      details = await executeTool(SLUGS.facebook_page_details, {
        connectedAccountId: facebookConnectedAccountId,
        arguments: { page_id: pageId, fields: 'id,name,instagram_business_account' },
      });
    } catch (err) {
      // A single unreadable Page (missing field, permission gap) shouldn't
      // sink discovery for every other Page — skip and keep going.
      console.warn(`[discoverInstagramAccounts] page ${pageId} details failed: ${err.message}`);
      continue;
    }
    const igUserId = pickIgBusinessAccountId(details);
    if (!igUserId) {
      // Log the envelope's shape, not just the miss. FACEBOOK_LIST_MANAGED_PAGES
      // above already needs `data?.data || data` handling, so an unrecognised
      // nesting here is at least as likely as a genuine absence — and the two are
      // indistinguishable without seeing what actually came back.
      console.warn(`[discoverInstagramAccounts] page ${pageId} (${page.name || '?'}) has no readable instagram_business_account; `
        + `payload keys: ${details && typeof details === 'object' ? Object.keys(details).join(',') : typeof details}`);
      unlinkedPages.push(page.name || pageId);
      continue;
    }

    let username = null;
    if (instagramConnectedAccountId) {
      try {
        const info = await executeTool(SLUGS.instagram_user_info, {
          connectedAccountId: instagramConnectedAccountId,
          arguments: { ig_user_id: igUserId },
        });
        username = info?.username || info?.data?.username || null;
      } catch (err) {
        console.warn(`[discoverInstagramAccounts] ig user info for ${igUserId} failed: ${err.message}`);
      }
    }

    candidates.push({ igUserId, username, pageId, pageName: page.name || null });
  }
  // Graph API silently omits `instagram_business_account` on a permission gap
  // rather than erroring, so a Page with no candidate found is ambiguous —
  // either it genuinely has no linked Instagram account, or the connected
  // token lacks the scope to see the link. Worth a log line either way, since
  // it's indistinguishable from the caller's side.
  if (unlinkedPages.length) {
    console.warn(`[discoverInstagramAccounts] no Instagram link visible for: ${unlinkedPages.join(', ')} — either genuinely unlinked, or the connected token lacks permission to read it`);
  }
  // The Pages walked are returned alongside the candidates, not just logged.
  // "Found nothing" is the ambiguous outcome here, and the operator is the only
  // one who can tell "that Page really has no Instagram account" from "the
  // Facebook login cannot see all my Pages" — so they need to see the list.
  return { candidates, pagesSeen: pages.map((p) => p?.name || p?.id).filter(Boolean), unlinkedPages };
}

export async function postViaComposio(platform, platformData, account) {
  const router = ROUTERS[platform];
  if (!router) throw new Error(`No Composio router for platform "${platform}"`);
  if (!account?.connectedAccountId) throw new Error(`Account for ${platform} has no connectedAccountId`);
  return router(platformData, account);
}

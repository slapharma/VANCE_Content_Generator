// lib/social/platforms/instagram-carousel.js
//
// Posts an Article Carousel to Instagram.
//
// The Graph API builds a carousel in three steps: one container per slide flagged
// `is_carousel_item`, then a parent CAROUSEL container listing those children,
// then a publish call on the parent. Unlike Reels, image containers are ready
// immediately, so there is no status polling here — that is why this is a
// separate module from instagram.js rather than another branch inside it.
//
// Two hard API constraints shape everything below:
//   • `image_url` must be a publicly reachable JPEG. The slides are hosted in the
//     WP media library for exactly this reason; the Graph API fetches them itself,
//     so nothing here uploads bytes.
//   • A carousel takes 2–10 children. The 8-slide default sits inside that, and
//     carousel-store.js asserts it before anything is queued.

const GRAPH_BASE = 'https://graph.facebook.com/v19.0';
const IG_CAPTION_MAX = 2200;

// ── Transient media-fetch failures ──────────────────────────────────────────
//
// When Meta cannot fetch a slide URL it does not say so plainly — it reports
// "Only photo or video can be accepted as media type" (code 9004, subcode
// 2207052), which reads like the file is the wrong type even when it is a
// perfectly good JPEG. On 2026-08-04 fifteen decks failed this way inside 65
// seconds while decks either side succeeded, and every slide URL served 200
// image/jpeg immediately afterwards. The cause is load, not content: too many
// containers created at once means too many crawler fetches at once.
//
// So this class of error is retried rather than treated as fatal. The delays are
// long on purpose — Meta briefly remembers a failed fetch, so retrying inside a
// second or two just re-reads the same negative result.
const RETRY_DELAYS_MS = [15_000, 40_000];

// Retries stop once this much time has gone on the whole attempt, so a deck can
// never eat the function's 300s budget and take the article's response with it.
const RETRY_BUDGET_MS = 170_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Does this error mean "Meta could not fetch the image", as opposed to a real
 *  configuration or content problem? */
export function isTransientMediaError(err) {
  const msg = String(err?.message || err);
  return /2207052|Only photo or video can be accepted|\(#?9004\)|code:\s*9004|media (url|fetch)/i.test(msg);
}

/**
 * Run `fn`, retrying only the transient media-fetch failures described above.
 *
 * @param {string} label - for the log line
 * @param {Function} fn
 * @returns {Promise<any>}
 */
async function withMediaRetry(label, fn) {
  const startedAt = Date.now();
  let lastErr;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const delay = RETRY_DELAYS_MS[attempt];
      if (!delay || !isTransientMediaError(err)) throw err;
      if (Date.now() - startedAt + delay > RETRY_BUDGET_MS) {
        console.warn(`[carousel] ${label}: out of retry budget after ${attempt + 1} attempt(s)`);
        throw err;
      }
      console.warn(`[carousel] ${label}: Meta could not fetch a slide (${err.message}) — retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function graphPost(endpoint, body, token) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Instagram Graph API error (${res.status}): ${err}`);
  }
  return res.json();
}

/**
 * Assemble the caption: copy, then the article link, then hashtags.
 *
 * The link goes in the caption because Instagram does not linkify it but readers
 * still copy it, and the CTA slide only prints the bare domain — the per-article
 * URL is not known when the slides are rendered. `link` is injected at posting
 * time by lib/social/article-link.js from the article's `wpPostUrl`.
 */
export function buildCarouselCaption(carousel, link = null) {
  const parts = [];
  if (carousel.caption) parts.push(carousel.caption.trim());
  if (link) parts.push(`Read the full article: ${link}`);
  if (carousel.hashtags?.length) {
    parts.push(carousel.hashtags.map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' '));
  }
  const caption = parts.join('\n\n');
  return caption.length > IG_CAPTION_MAX ? caption.slice(0, IG_CAPTION_MAX - 1).trimEnd() : caption;
}

/** Slides in deck order, as public JPEG URLs. */
function slideUrls(carousel) {
  const slides = [...(carousel.slides || [])].sort((a, b) => a.index - b.index);
  const urls = slides.map((s) => s.url).filter(Boolean);
  if (urls.length !== slides.length) {
    throw new Error(`Carousel ${carousel.id} has ${slides.length - urls.length} slide(s) with no hosted URL`);
  }
  return urls;
}

/**
 * Post via the direct Graph API using env-var credentials.
 *
 * @returns {Promise<{postId: string}>}
 */
async function postViaGraph(carousel, caption) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const accountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  if (!token || !accountId) {
    throw new Error('INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_BUSINESS_ACCOUNT_ID not configured');
  }

  const urls = slideUrls(carousel);

  // Step 1 — one child container per slide, in order.
  const childIds = [];
  for (const url of urls) {
    const child = await graphPost(
      `${GRAPH_BASE}/${accountId}/media`,
      { image_url: url, is_carousel_item: true },
      token,
    );
    if (!child?.id) throw new Error(`Instagram returned no container id for slide ${childIds.length + 1}`);
    childIds.push(child.id);
  }

  // Step 2 — the parent carousel container carries the caption.
  const parent = await graphPost(
    `${GRAPH_BASE}/${accountId}/media`,
    { media_type: 'CAROUSEL', children: childIds.join(','), caption },
    token,
  );
  if (!parent?.id) throw new Error('Instagram returned no carousel container id');

  // Step 3 — publish.
  const published = await graphPost(
    `${GRAPH_BASE}/${accountId}/media_publish`,
    { creation_id: parent.id },
    token,
  );
  return { postId: published?.id || parent.id };
}

/** Pull a container/media id out of a Composio result, whose envelope shape
 *  varies by tool. */
const idFrom = (out) =>
  out?.data?.id || out?.id || out?.creation_id || out?.container_id
  || out?.data?.creation_id || out?.data?.container_id || null;

/**
 * Resolve the numeric Instagram Business Account id.
 *
 * `INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH` documents 'me' as acceptable, but
 * `INSTAGRAM_CREATE_CAROUSEL_CONTAINER` does not — it wants the numeric id — so
 * 'me' is not a safe universal default here. When the account record has no
 * configured id we ask Instagram for it rather than guessing.
 */
async function resolveIgUserId(executeTool, account) {
  if (account.config?.igUserId) return account.config.igUserId;
  const info = await executeTool('INSTAGRAM_GET_USER_INFO', {
    connectedAccountId: account.connectedAccountId,
    arguments: { ig_user_id: 'me' },
  });
  const id = info?.data?.id || info?.id;
  if (!id) throw new Error('Could not resolve the Instagram Business Account id (INSTAGRAM_GET_USER_INFO returned none)');
  return id;
}

/**
 * Post via a Composio-connected account.
 *
 * Corrected 2026-07-27 after a live failure. The previous version guessed that
 * Composio mirrored the raw Graph API flow via INSTAGRAM_CREATE_MEDIA_CONTAINER
 * with `content_type: 'carousel'`. It does not — that tool's enum is
 * `photo | video | reel | carousel_item`, so every attempt failed validation and
 * degraded to a cover-only post. Composio has a **dedicated** carousel tool that
 * accepts the slide URLs directly, which collapses the whole thing to two calls.
 *
 * Primary path: one `INSTAGRAM_CREATE_CAROUSEL_CONTAINER` with `child_image_urls`
 * (Composio creates the child containers itself), then publish.
 *
 * Secondary path: build the children explicitly with `content_type:
 * 'carousel_item'` and pass their ids as `children`. Composio's own docs note the
 * carousel tool can return a spurious 500, and the explicit form also isolates a
 * single bad slide — so it is worth having rather than dropping straight to a
 * cover-only post.
 */
async function postViaComposioCarousel(carousel, caption, account) {
  const { executeTool } = await import('../composio.js');
  const urls = slideUrls(carousel);
  const igUserId = await resolveIgUserId(executeTool, account);
  const connectedAccountId = account.connectedAccountId;

  const publish = async (creationId) => {
    const published = await executeTool('INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH', {
      connectedAccountId,
      arguments: { creation_id: creationId, ig_user_id: igUserId },
    });
    return { postId: idFrom(published) || creationId };
  };

  // ── Primary: let Composio build the children from the URLs ────────────────
  // Only this path retries. It is the one that produces a real carousel, and a
  // transient crawler failure here would otherwise cascade straight down to a
  // cover-only post — which is how a load spike turned into fifteen dead decks.
  let primaryErr;
  try {
    return await withMediaRetry('carousel container', async () => {
      const parent = await executeTool('INSTAGRAM_CREATE_CAROUSEL_CONTAINER', {
        connectedAccountId,
        arguments: { ig_user_id: igUserId, caption, child_image_urls: urls },
      });
      const parentId = idFrom(parent);
      if (!parentId) throw new Error('no carousel container id returned');
      return publish(parentId);
    });
  } catch (err) {
    primaryErr = err;
    console.warn(`[carousel] child_image_urls path failed (${err.message}) — retrying with explicit child containers`);
  }

  // ── Secondary: explicit child containers, then the parent ─────────────────
  try {
    const childIds = [];
    for (const [i, url] of urls.entries()) {
      const child = await executeTool('INSTAGRAM_CREATE_MEDIA_CONTAINER', {
        connectedAccountId,
        // 'carousel_item' — NOT 'photo' with is_carousel_item, and NOT 'carousel'.
        // This enum is the whole reason the first live attempt failed.
        arguments: { content_type: 'carousel_item', image_url: url, ig_user_id: igUserId },
      });
      const id = idFrom(child);
      if (!id) throw new Error(`Composio returned no container id for slide ${i + 1}`);
      childIds.push(id);
    }

    const parent = await executeTool('INSTAGRAM_CREATE_CAROUSEL_CONTAINER', {
      connectedAccountId,
      arguments: { ig_user_id: igUserId, caption, children: childIds },
    });
    const parentId = idFrom(parent);
    if (!parentId) throw new Error('Composio returned no carousel container id');
    return publish(parentId);
  } catch (err) {
    // Lead with the PRIMARY failure. The secondary path walks the same slides
    // one at a time, so its error is usually the first slide restating the same
    // problem — which is why every 2026-08-04 log line blamed the cover image
    // and none of them named the carousel call that actually failed first.
    const composed = new Error(`carousel container: ${primaryErr.message} | per-slide fallback: ${err.message}`);
    composed.primaryError = primaryErr;
    composed.transient = isTransientMediaError(primaryErr) || isTransientMediaError(err);
    throw composed;
  }
}

/**
 * Publish a single image rather than a carousel.
 *
 * Two callers, for opposite reasons:
 *   - as a genuine one-slide deck, which Instagram has no carousel concept for
 *     (its carousel endpoint requires 2..10 children), so a single image IS the
 *     correct post rather than a downgrade;
 *   - as a last resort when carousel posting is unavailable, in which case the
 *     caller flags the result `degraded`.
 */
async function postSingleImage(carousel, caption, account) {
  const { dispatch } = await import('./index.js');
  const cover = (carousel.slides || []).find((s) => s.type === 'cover') || carousel.slides?.[0];
  if (!cover?.url) throw new Error('No slide to post');
  return dispatch('instagram', { caption, hashtags: [], image: { url: cover.url } }, account);
}

/**
 * Single image via the direct Graph API — the one-slide equivalent of
 * postViaGraph. Two steps rather than three: no child containers, and the
 * caption rides on the single container instead of a carousel parent.
 */
async function postSingleViaGraph(carousel, caption) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const accountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  if (!token || !accountId) {
    throw new Error('INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_BUSINESS_ACCOUNT_ID not configured');
  }
  const [url] = slideUrls(carousel);
  if (!url) throw new Error('No slide to post');

  const container = await graphPost(
    `${GRAPH_BASE}/${accountId}/media`,
    { image_url: url, caption },
    token,
  );
  if (!container?.id) throw new Error('Instagram returned no media container id');

  const published = await graphPost(
    `${GRAPH_BASE}/${accountId}/media_publish`,
    { creation_id: container.id },
    token,
  );
  return { postId: published?.id || container.id };
}

/**
 * Post a carousel, preferring whichever path is actually configured.
 *
 * The direct Graph API is preferred over Composio because its carousel support is
 * documented and stable, whereas Composio's is unverified (see above).
 *
 * @param {object} carousel - a carousel record with hosted `slides[]`
 * @param {object|null} account - resolved account from lib/social/accounts.js
 * @param {string|null} link - the published article URL, if known
 * @returns {Promise<{postId: string, degraded?: boolean}>}
 */
export async function postInstagramCarousel(carousel, account = null, link = null) {
  const caption = buildCarouselCaption(carousel, link);
  const hasGraphCreds = Boolean(process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID);

  // A one-slide deck is a single image post, not a degraded carousel. Instagram's
  // carousel endpoint requires 2..10 children, so there is no carousel to attempt
  // — and it must NOT be flagged `degraded`, which means "we wanted a carousel and
  // could not manage one". This is exactly what was asked for.
  const single = (carousel.slides || []).length === 1;
  if (single) {
    if (hasGraphCreds) return postSingleViaGraph(carousel, caption);
    if (account?.provider === 'composio' && account.connectedAccountId) {
      return postSingleImage(carousel, caption, account);
    }
    throw new Error('Posting a single-slide deck needs either INSTAGRAM_ACCESS_TOKEN + INSTAGRAM_BUSINESS_ACCOUNT_ID, or a Composio-connected Instagram account');
  }

  if (hasGraphCreds) return withMediaRetry('graph carousel', () => postViaGraph(carousel, caption));

  if (account?.provider === 'composio' && account.connectedAccountId) {
    try {
      return await postViaComposioCarousel(carousel, caption, account);
    } catch (err) {
      // Degrading is the right answer to "Composio cannot build a carousel at
      // all" — it is the wrong answer to "Meta could not fetch the images just
      // now". A transient failure that degrades puts a permanent cover-only post
      // on the feed for a deck that would have posted in full a minute later, so
      // it fails instead and the deck stays retryable.
      if (isTransientMediaError(err)) throw err;
      console.warn(`[carousel] Composio carousel post failed (${err.message}) — falling back to a cover-only single image post`);
      const result = await postSingleImage(carousel, caption, account);
      return { ...result, degraded: true };
    }
  }

  throw new Error('Instagram carousel needs either INSTAGRAM_ACCESS_TOKEN + INSTAGRAM_BUSINESS_ACCOUNT_ID, or a Composio-connected Instagram account');
}

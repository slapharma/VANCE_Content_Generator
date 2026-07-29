import { kv } from '../../lib/kv.js';
import { resolveOrCreateWpCategory, resolveOrCreateWpTags, parseTagList } from '../../lib/wp-taxonomy.js';
import { uploadImageUrlToWp } from '../../lib/social/wp-media.js';
import { carouselOnPublish } from '../../lib/social/carousel-on-publish.js';

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
 *
 * The mechanics now live in lib/social/wp-media.js, shared with the Article
 * Carousel renderer, which uploads its rendered slides the same way. The
 * attribution stamp (alt text + caption + description on the media item, never a
 * visible line in the post body) moved with it unchanged.
 */
async function uploadHeroImageToWp(imageUrl, postTitle, siteUrl, authHeader, credit = null) {
  const media = await uploadImageUrlToWp(imageUrl, {
    title: postTitle || 'hero',
    siteUrl,
    authHeader,
    credit,
    suffix: 'hero',
    logPrefix: 'publish',
  });
  return media?.id ?? null;
}

// Convert raw markdown/LLM output to clean WordPress HTML.
// When `wrapOpening` is true, the opening paragraph — the first prose line
// before any body section heading — is rendered as a <blockquote> lead-in to
// match the editorial house style. Categories that open with a meta subheader
// instead of a prose intro (e.g. clinical reviews) pass wrapOpening: false.
// Category prefixes (e.g. "Gastro Living: ", "Clinical Review: ") are no longer
// wanted on article titles. Strip any known prefix from the WP post title and the
// body's title H1 so legacy/saved items and prompt-emitted prefixes don't leak through.
const CATEGORY_TITLE_PREFIX_RE = /^(clinical review|gastro living|gastro health news|op[-\s]?ed|white paper|infographic)\s*:\s*/i;
function stripCategoryTitlePrefix(s) {
  return s == null ? s : String(s).replace(CATEGORY_TITLE_PREFIX_RE, '').trim();
}

// Inline-style presets for the boxed sections below — WP posts don't load the
// app's stylesheet, so these have to travel as inline styles on the generated
// tags rather than CSS classes.
const WP_META_BLOCK_STYLE = 'font-size:14px;color:#6b7a8d;line-height:1.7;font-style:italic;margin:0 0 20px;padding-bottom:14px;border-bottom:1px solid #dde3ea;';
const WP_LIST_STYLE_MAP = {
  'study at a glance': 'list-style:none;margin:0 0 20px;padding:16px 20px;background:#f7f8fa;border:1px solid #e2e6ec;border-radius:6px;',
  'key takeaways':     'margin:0 0 20px;padding:14px 18px 14px 36px;background:rgba(0,104,104,0.06);border-left:3px solid #006868;border-radius:0 6px 6px 0;',
};

function markdownToWpHtml(text, { wrapOpening = false } = {}) {
  if (!text) return '';
  const lines = text.split('\n');
  const html = [];
  let subtitleDone = false;
  let listType = null; // 'ul' | 'ol' | null — tracks an open list block
  let seenSection = false;    // true once a body section heading has been emitted
  let openingWrapped = false; // true once the opening paragraph has been blockquoted
  let inMeta = false;          // re-opened by an "Article information" heading → merge into one box
  let metaBuffer = [];         // lines collected while inMeta is true
  let pendingListStyle = null; // inline style for the *next* <ul>/<ol> opened
  let inTable = false;         // true while consuming a markdown pipe-table's data rows

  const closeList = () => { if (listType) { html.push(`</${listType}>`); listType = null; } };
  const flushMeta = () => {
    if (metaBuffer.length) html.push(`<p style="${WP_META_BLOCK_STYLE}">${metaBuffer.join('<br>')}</p>`);
    metaBuffer = [];
  };

  // Inline markdown → HTML: **bold** and *italic* (italic guarded against word-internal *)
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<em>$1</em>');

  // Applies the re-open/list-style side effects for a heading's plain text —
  // mirrors index.html's formatArticleHTML so in-app previews and the
  // published WP post render "Article information" / "Study at a glance" /
  // "Key takeaways" the same way regardless of where the prompt puts them.
  const applyHeadingEffects = (headingText) => {
    flushMeta();
    const key = headingText.trim().toLowerCase();
    inMeta = key === 'article information';
    pendingListStyle = WP_LIST_STYLE_MAP[key] || null;
  };

  const isTableRow = (s) => /^\|.*\|$/.test(s);
  const isTableSeparatorRow = (s) => /^\|?[\s:|-]+\|?$/.test(s) && s.includes('-');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) { closeList(); inTable = false; html.push(''); continue; }

    // Drop the "Reading Time" meta line — it's an editorial label, not published body.
    // Matches "Reading Time: 6 minutes" with optional ** bold wrappers.
    if (/^\**\s*reading time\b/i.test(trimmed)) continue;

    // Markdown pipe tables: the LLM sometimes writes a 2-column fact table (e.g. for
    // "Study at a glance") instead of the requested bullet list. There's no <table>
    // rendering in the house style, so collapse it into the same styled <ul> a bullet
    // list would produce — same pendingListStyle/list machinery, just a different
    // source syntax. Header + separator rows are dropped entirely (the bullet-list
    // version has no header row either); only data rows become <li>s.
    if (isTableRow(trimmed)) {
      if (!inTable && isTableSeparatorRow((lines[i + 1] || '').trim())) {
        inTable = true;
        i++; // also consume the separator row
        continue;
      }
      if (inTable) {
        const cells = trimmed.split('|').map(c => c.trim());
        cells.shift(); cells.pop(); // drop the empty segments outside the outer pipes
        if (cells.length >= 2) {
          const label = cells[0].replace(/^\*\*(.+)\*\*$/, '$1');
          const value = cells.slice(1).join(' — ');
          if (listType && listType !== 'ul') closeList();
          if (!listType) {
            listType = 'ul';
            html.push(pendingListStyle ? `<ul style="${pendingListStyle}">` : '<ul>');
            pendingListStyle = null;
          }
          html.push(`<li><strong>${inline(label)}:</strong> ${inline(value)}</li>`);
          continue;
        }
      }
    }
    inTable = false;

    // List items: "- "/"* "/"• " → <ul>, "1. "/"1) " → <ol>. Consecutive items group
    // into one list; any other line (or blank) closes it.
    const ulMatch = trimmed.match(/^[-*•]\s+(.*)$/);
    const olMatch = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (ulMatch || olMatch) {
      const wantType = ulMatch ? 'ul' : 'ol';
      if (listType && listType !== wantType) closeList();
      if (!listType) {
        listType = wantType;
        html.push(pendingListStyle ? `<${wantType} style="${pendingListStyle}">` : `<${wantType}>`);
        pendingListStyle = null;
      }
      html.push(`<li>${inline((ulMatch ? ulMatch[1] : olMatch[1]).trim())}</li>`);
      continue;
    }
    closeList();

    // Strip ** wrappers from standalone heading lines (e.g. "**Background & Rationale**")
    const boldOnly = trimmed.match(/^\*\*(.+?)\*\*$/);

    // Markdown headings → first body "# " is the subtitle (<h1>); "## " → <h2>; "### " → <h3>.
    // Reaching a section heading closes the opening-paragraph window.
    if (trimmed.startsWith('### '))     { seenSection = true; const txt = trimmed.slice(4).replace(/\*\*/g, ''); applyHeadingEffects(txt); html.push(`<h3>${txt}</h3>`); continue; }
    if (trimmed.startsWith('## '))      { seenSection = true; const txt = trimmed.slice(3).replace(/\*\*/g, ''); applyHeadingEffects(txt); html.push(`<h2>${txt}</h2>`); continue; }
    if (trimmed.startsWith('# '))       {
      const txt = stripCategoryTitlePrefix(trimmed.slice(2).replace(/\*\*/g, ''));
      if (!subtitleDone) { subtitleDone = true; html.push(`<h1>${txt}</h1>`); continue; }
      applyHeadingEffects(txt); html.push(`<h2>${txt}</h2>`); continue;
    }

    // Bold-only lines that look like section headers → <h2>
    if (boldOnly) {
      const inner = boldOnly[1].trim();
      const isHeader = /^(Background|Study Design|Patient Population|Key Findings|Discussion|Safety|Authors|Reference|Clinical Relevance|Conclusions|Disclaimer)/i.test(inner);
      if (isHeader) { seenSection = true; applyHeadingEffects(inner); html.push(`<h2>${inner}</h2>`); continue; }
    }

    // Article-information lead-in (authors / journal / DOI) → one merged box
    // instead of a run of disconnected one-line paragraphs.
    if (inMeta) { metaBuffer.push(inline(trimmed)); continue; }

    // Opening paragraph (first prose line before any section) → <blockquote> lead-in.
    if (wrapOpening && !openingWrapped && !seenSection) {
      openingWrapped = true;
      html.push(`<blockquote><p>${inline(trimmed)}</p></blockquote>`);
      continue;
    }

    html.push(`<p>${inline(trimmed)}</p>`);
  }
  closeList();
  flushMeta();

  return html.filter(l => l !== '').join('\n');
}

// Attribution for stock-photo heroes. Deliberately NOT rendered in the post
// body — the credit travels invisibly on the WP media item instead (alt text
// + caption + description, set by uploadHeroImageToWp). html keeps the linked,
// UTM-tagged form the Unsplash API guidelines describe; plain is for alt text.
export function buildHeroCredit(item) {
  const c = item?.heroImageCredit;
  if (!c || !c.photographer) return null;
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const isUnsplash = (c.provider || item.heroImageType) === 'unsplash';
  const svc  = isUnsplash ? 'Unsplash' : 'Pexels';
  const utm  = 'utm_source=vance_health_hub&utm_medium=referral';
  const home = isUnsplash ? `https://unsplash.com/?${utm}` : 'https://www.pexels.com/';
  let pUrl = c.photographerUrl || '';
  if (pUrl && isUnsplash) pUrl += (pUrl.includes('?') ? '&' : '?') + utm;
  const name = pUrl
    ? `<a href="${esc(pUrl)}" target="_blank" rel="noopener nofollow">${esc(c.photographer)}</a>`
    : esc(c.photographer);
  return {
    plain: `Photo by ${c.photographer} on ${svc}`,
    html:  `Photo by ${name} on <a href="${esc(home)}" target="_blank" rel="noopener nofollow">${svc}</a>`,
  };
}

export function buildWpPayload(item, categoryIds, tagIds = [], featuredMediaId = null) {
  // Lead the article with a <blockquote> opening paragraph (editorial house style).
  // Clinical reviews open with an authors/journal/DOI subheader rather than a prose
  // intro, so they keep a plain first paragraph.
  const wrapOpening = item.category !== 'clinical-reviews';
  return {
    title:      stripCategoryTitlePrefix(item.title),
    content:    markdownToWpHtml(item.body, { wrapOpening }),
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
    // Credit only applies when the article's own hero is used — the category
    // fallback image has no per-photo attribution.
    const credit = item.heroImageUrl ? buildHeroCredit(item) : null;
    featuredMediaId = await uploadHeroImageToWp(heroUrl, item.title, siteUrl, authHeader, credit);
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

/**
 * Run background work without making the caller wait for it.
 *
 * The carousel build takes 60-100s. Two of the four callers of this endpoint are
 * humans holding a click — a reviewer following an approval link out of their
 * email, and the "Publish Now" button — and neither should sit on a blank tab
 * while Instagram slides render. `waitUntil` is Vercel's mechanism for exactly
 * this: the response flushes immediately and the invocation stays alive until the
 * promise settles, within the function's maxDuration.
 *
 * Imported dynamically with a blocking fallback so a missing/renamed
 * @vercel/functions can only ever cost us latency, never the carousel.
 */
async function defer(promise) {
  // Swallow first, hand the settled-either-way promise onwards: an unhandled
  // rejection reaching waitUntil would be reported as a function error on a
  // request that actually succeeded.
  const safe = promise.catch((err) => console.error('[publish] deferred work failed:', err?.message));
  try {
    const { waitUntil } = await import('@vercel/functions');
    waitUntil(safe);
  } catch {
    await safe;
  }
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

  // The article is live and its record is committed — the only point at which
  // building an Instagram carousel is safe. The hero image and the copy are now
  // final, and `wpPostUrl` exists for the deck's "read the full article" CTA.
  //
  // Deliberately placed here rather than in the automation run or the approve
  // handler (where it used to live, in two divergent copies): this is the single
  // choke point shared by auto-publish, approve-on-review, the scheduled cron
  // sweep and the manual button, so all four now behave identically. Non-fatal
  // and non-blocking — see carouselOnPublish, which never throws.
  await defer(carouselOnPublish(updated));

  return res.json({
    wpPostId: wpPost.id,
    wpPostUrl: wpPost.link,
    taxonomy: wpPost._taxonomy ?? null,
  });
}

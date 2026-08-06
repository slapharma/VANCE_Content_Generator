// lib/automation/fetch.js
import { fetchGoogleDrive, fetchDropbox } from '../sources/cloud-drives.js';
import { fetchGmailMessages } from '../sources/gmail.js';
import { fetchGoogleSheetRows } from '../sources/google-sheets.js';
import { fetchBibliographyPapers } from '../sources/bibliography.js';

// ── RSS ───────────────────────────────────────────────────────────────────────

export function parseRssItems(xml) {
  // Simple regex-based RSS parser — avoids DOMParser dependency in Node.
  // Accepts RSS 2.0 (bare <item>) and RSS 1.0 / RDF (<item rdf:about="...">) feeds.
  const items = [];
  const itemRegex = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    // Try CDATA title first, then plain title
    const titleMatch = /<title><!\[CDATA\[(.*?)\]\]><\/title>/s.exec(block)
      || /<title>(.*?)<\/title>/s.exec(block);
    const title = (titleMatch?.[1] ?? '').trim();
    const url = (/<link>(.*?)<\/link>/s.exec(block)?.[1] ?? '').trim();
    // RSS 2.0 uses <pubDate>; RSS 1.0 / Atom-flavoured feeds use <dc:date>.
    const pubDateStr = (
      /<pubDate>(.*?)<\/pubDate>/s.exec(block)?.[1]
      ?? /<dc:date>(.*?)<\/dc:date>/s.exec(block)?.[1]
      ?? ''
    ).trim();
    const pubDate = pubDateStr ? new Date(pubDateStr) : new Date();
    // Prefer <content:encoded> (often the full body) over <description> (often a summary).
    const contentRaw = (
      /<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/s.exec(block)?.[1]
      ?? /<content:encoded>([\s\S]*?)<\/content:encoded>/s.exec(block)?.[1]
      ?? /<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/s.exec(block)?.[1]
      ?? /<description>([\s\S]*?)<\/description>/s.exec(block)?.[1]
      ?? ''
    ).trim();
    items.push({ title, url, pubDate, rawText: '', feedDescription: contentRaw });
  }
  return items;
}

export function filterNewItems(items, lastRunAt) {
  if (!lastRunAt) return items;
  const since = new Date(lastRunAt);
  return items.filter(item => item.pubDate > since);
}

async function fetchRss(source, lastRunAt, fetchFn = fetch) {
  const res = await fetchFn(source.url, { headers: { 'User-Agent': 'VanceBot/1.0' } });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status} ${source.url}`);
  const xml = await res.text();
  const items = filterNewItems(parseRssItems(xml), lastRunAt);

  // Fetch each item's linked article so the LLM has actual content to work with.
  // RSS items by themselves only carry title + link, so without this every item
  // would fail generation with "No source text". Cap to bound work per cron run.
  const MAX_RSS_ITEM_FETCHES = 10;
  const toEnrich = items.slice(0, MAX_RSS_ITEM_FETCHES);
  const MIN_USABLE_CHARS = 200;
  const enriched = await Promise.all(toEnrich.map(async (item) => {
    const base = { ...item, sourceType: 'rss' };
    // RSS feed's own <description>/<content:encoded> (cleaned). Often contains the
    // abstract — useful when the linked page is paywalled or bot-blocked.
    const feedText = stripHtmlToText(item.feedDescription || '');
    let urlText = '';
    if (item.url) {
      try {
        const r = await fetchFn(item.url, { headers: { 'User-Agent': 'VanceBot/1.0' }, redirect: 'follow' });
        if (r.ok) urlText = stripHtmlToText(await r.text());
      } catch (_) { /* non-fatal */ }
    }
    // Heuristic: if the URL fetch returned a real page (>= MIN_USABLE_CHARS), use it;
    // otherwise fall back to the feed description (typically the abstract).
    const rawText = urlText.length >= MIN_USABLE_CHARS ? urlText : (feedText || urlText);
    return { ...base, rawText };
  }));
  return enriched;
}

// Strip HTML and decode entities to leave just human-readable text. This is a
// rough but effective reduction — typical article pages drop from 200k+ chars
// of raw HTML to ~10k chars of text content, well within LLM context limits.
function stripHtmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:noscript|svg|head|nav|footer|header|aside|form)[\s\S]*?<\/(?:noscript|svg|head|nav|footer|header|aside|form)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchUrl(source, fetchFn = fetch, lastRunAt) {
  if (isNewsNowUrl(source.url)) return fetchNewsNow(source, lastRunAt, fetchFn);
  const res = await fetchFn(source.url, { headers: { 'User-Agent': 'VanceBot/1.0' } });
  if (!res.ok) throw new Error(`URL fetch failed: ${res.status} ${source.url}`);
  const html = await res.text();
  const rawText = stripHtmlToText(html);
  return [{ title: source.url, url: source.url, rawText, sourceType: 'url', pubDate: new Date() }];
}

// ── NewsNow ───────────────────────────────────────────────────────────────────
// A NewsNow topic page (e.g. .../h/Lifestyle/Health/Gastrointestinal+Diseases)
// isn't a single article — it's a live list of headlines aggregated from many
// publishers. Running it through the generic fetchUrl() path above collapses
// nav chrome and a dozen unrelated headlines into one unusable text blob, so
// this parses each headline out individually (like an RSS item) and follows
// its NewsNow click-tracking redirect (c.newsnow.co.uk) to the real story.

function isNewsNowUrl(url) {
  try { return new URL(url).hostname.endsWith('newsnow.co.uk'); }
  catch { return false; }
}

// Matches NewsNow's per-headline markup:
//   <div class="hl ..." data-id="123"> ... <a class="hll" href="...">Title</a>
//   <span class="src ..." data-pub="X">Publisher<i .../></span>
//   <span class="time" data-time="1785769615">16:06</span>
const NEWSNOW_HEADLINE_REGEX =
  /<div class="hl[^"]*"[^>]*data-id="(\d+)"[\s\S]*?<a class="hll" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<span class="src[^"]*"[^>]*data-pub="[^"]*">([\s\S]*?)<\/span>[\s\S]*?<span class="time"[^>]*data-time="(\d+)"/g;

export function parseNewsNowHeadlines(html) {
  const items = [];
  const seen = new Set();
  let match;
  while ((match = NEWSNOW_HEADLINE_REGEX.exec(html)) !== null) {
    const [, id, redirectUrl, titleHtml, publisherHtml, unixTime] = match;
    if (seen.has(id)) continue; // NewsNow repeats the same headline across "most read" rails
    seen.add(id);
    items.push({
      title: stripHtmlToText(titleHtml),
      url: redirectUrl,
      publisher: stripHtmlToText(publisherHtml),
      pubDate: new Date(Number(unixTime) * 1000),
    });
  }
  return items;
}

// c.newsnow.co.uk doesn't send an HTTP redirect to the publisher — it serves an
// interstitial "Loading story..." page that bounces via client-side JS after a
// delay. fetch()'s redirect:'follow' can't see that, so the real destination has
// to be pulled out of the page: it's embedded both as clickthroughConfig.url (a
// JS var used for the timed auto-redirect) and as the "Article not loading? Try
// clicking here" link. Prefer the former; fall back to the latter.
function extractNewsNowDestination(interstitialHtml) {
  const configMatch = /clickthroughConfig\s*=\s*\{[^}]*?url:\s*'([^']+)'/s.exec(interstitialHtml);
  if (configMatch) return configMatch[1];
  const linkMatch = /Article not loading[\s\S]*?href="([^"]+)"/.exec(interstitialHtml);
  return linkMatch ? linkMatch[1] : null;
}

async function fetchNewsNow(source, lastRunAt, fetchFn = fetch) {
  const res = await fetchFn(source.url, { headers: { 'User-Agent': 'VanceBot/1.0' } });
  if (!res.ok) throw new Error(`NewsNow fetch failed: ${res.status} ${source.url}`);
  const html = await res.text();
  const headlines = filterNewItems(parseNewsNowHeadlines(html), lastRunAt);

  // Cap to bound work per cron run, same rationale as MAX_RSS_ITEM_FETCHES.
  const MAX_NEWSNOW_ITEM_FETCHES = 10;
  const MIN_USABLE_CHARS = 200;
  const toEnrich = headlines.slice(0, MAX_NEWSNOW_ITEM_FETCHES);
  const enriched = await Promise.all(toEnrich.map(async (h) => {
    let rawText = '';
    let finalUrl = h.url;
    try {
      const interstitial = await fetchFn(h.url, { headers: { 'User-Agent': 'VanceBot/1.0' } });
      if (interstitial.ok) {
        const destination = extractNewsNowDestination(await interstitial.text());
        if (destination) {
          const r = await fetchFn(destination, { headers: { 'User-Agent': 'VanceBot/1.0' }, redirect: 'follow' });
          if (r.ok) {
            rawText = stripHtmlToText(await r.text());
            finalUrl = r.url || destination;
          }
        }
      }
    } catch (_) { /* non-fatal — filtered out below if still unusable */ }
    return {
      title: h.title,
      url: finalUrl,
      rawText,
      sourceType: 'newsnow',
      pubDate: h.pubDate,
      publisher: h.publisher,
    };
  }));

  // Unlike RSS, NewsNow's own markup carries no article body or abstract to
  // fall back on — just a ~10-word headline. An item whose linked story fails
  // to fetch (paywall, publisher-side block, dead link) has nothing usable
  // behind it, so it's dropped rather than handed to the LLM as "source text".
  return enriched.filter(item => item.rawText.length >= MIN_USABLE_CHARS);
}

// Upload source: a list of items extracted from an xlsx. Three flavours:
//   - structured rows (multi-column spreadsheet: Title / Notes / Sub-Category / Tag)
//     emitted as title-only items with per-row notes / subCategory / tags attached.
//   - URL cells (hyperlinked Column A) — fetched and stripped to text.
//   - plain-text cells (Column A only) — emitted as title-only items; the LLM
//     researches them using the category prompt (e.g. Gastro Living Blog Master).
async function fetchUploadUrls(source, fetchFn = fetch, opts = {}) {
  const consumedUrls = new Set(Array.isArray(source.consumedUrls) && !opts.forceAll ? source.consumedUrls : []);
  const consumedTitles = new Set(Array.isArray(source.consumedTitles) && !opts.forceAll ? source.consumedTitles : []);

  // Per-row records win if present — supersede the legacy titlesOnly list to
  // avoid the same title being processed twice (rows + titlesOnly both contain it).
  const rowsRaw = Array.isArray(source.rows) ? source.rows.filter(r => r && (r.title || '').trim()) : [];
  const rows = rowsRaw.filter(r => !consumedTitles.has(r.title));

  const urls = (Array.isArray(source.urls) ? source.urls.filter(Boolean) : [])
    .filter(u => !consumedUrls.has(u));

  // Skip titlesOnly entries that are already represented in rows so we don't double-emit.
  const rowTitleSet = new Set(rowsRaw.map(r => r.title));
  const titlesOnly = (Array.isArray(source.titlesOnly) ? source.titlesOnly.filter(Boolean) : [])
    .filter(t => !consumedTitles.has(t) && !rowTitleSet.has(t));

  if (!urls.length && !titlesOnly.length && !rows.length) {
    const fname = source.originalFilename || source.url || '(no file)';
    const isNullShape = source.urls === null || source.titlesOnly === null;
    const totalRows = rowsRaw.length;
    const totalUrls = Array.isArray(source.urls) ? source.urls.filter(Boolean).length : 0;
    const totalTitlesOnly = Array.isArray(source.titlesOnly) ? source.titlesOnly.filter(Boolean).length : 0;
    const allConsumed = (consumedUrls.size + consumedTitles.size) > 0
      && totalUrls === consumedUrls.size
      && Math.max(totalRows, totalTitlesOnly) === consumedTitles.size;
    const hint = isNullShape
      ? 'file was uploaded but not parsed (non-xlsx, or parse failed)'
      : allConsumed
        ? 'every row has already been generated. Edit the rule to clear consumedUrls/consumedTitles, or upload a new file.'
        : 'parsed file had no usable rows';
    throw new Error(`Upload source "${fname}" has no items — ${hint}. Re-open the rule, upload an .xlsx whose first sheet contains a Title column (and optional Notes / Sub-Category / Tag columns), then save.`);
  }

  const results = [];
  const errors = [];

  for (const url of urls) {
    try {
      const res = await fetchFn(url, { headers: { 'User-Agent': 'VanceBot/1.0' } });
      if (!res.ok) { errors.push(`${res.status} ${url}`); continue; }
      const html = await res.text();
      results.push({ title: url, url, rawText: stripHtmlToText(html), sourceType: 'upload', pubDate: new Date() });
    } catch (err) {
      errors.push(`${err.message} (${url})`);
    }
  }

  // Structured rows: title-only items with per-row metadata attached.
  for (const row of rows) {
    results.push({
      title:       row.title,
      url:         null,
      rawText:     '',
      sourceType:  'upload',
      titleOnly:   true,
      pubDate:     new Date(),
      // Per-row metadata (run.js stitches into the prompt + content record).
      rowNotes:    row.notes || '',
      subCategory: row.subCategory || '',
      tags:        Array.isArray(row.tags)
        ? row.tags
        : (row.tags ? String(row.tags) : ''),
    });
  }

  // Legacy Column-A-only entries (no per-row metadata).
  for (const title of titlesOnly) {
    results.push({ title, url: null, rawText: '', sourceType: 'upload', titleOnly: true, pubDate: new Date() });
  }

  if (errors.length && !results.length) {
    throw new Error(`All ${urls.length} URLs failed: ${errors.slice(0, 3).join('; ')}`);
  }
  return results;
}

async function fetchGitHub(source, fetchFn = fetch) {
  const { repo, path = '', branch = 'main' } = source;
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`;
  const res = await fetchFn(apiUrl, {
    headers: {
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub fetch failed: ${res.status} ${apiUrl}`);
  const files = await res.json();
  const mdFiles = Array.isArray(files) ? files.filter(f => f.name.endsWith('.md')) : [];
  const results = [];
  for (const file of mdFiles.slice(0, 5)) {
    const fileRes = await fetchFn(file.download_url);
    if (!fileRes.ok) throw new Error(`GitHub file fetch failed: ${fileRes.status} ${file.download_url}`);
    const rawText = await fileRes.text();
    results.push({
      title: file.name.replace('.md', ''),
      url: file.html_url,
      rawText,
      sourceType: 'github',
      pubDate: new Date(),
    });
  }
  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

// Returns { items, sourceErrors } — sourceErrors lets callers surface fetch failures to users.
// opts.forceAll: bool — bypass consumption/processed filters so manual reruns can pick up
//   already-generated rows (used by manual rule triggers and "Re-process selected").
export async function fetchSources(sources, lastRunAt, fetchFn = fetch, ruleId = null, opts = {}) {
  const items = [];
  const sourceErrors = [];
  for (const source of sources) {
    try {
      switch (source.type) {
        case 'rss':          items.push(...await fetchRss(source, lastRunAt, fetchFn)); break;
        case 'url':          items.push(...await fetchUrl(source, fetchFn, lastRunAt)); break;
        case 'upload':       items.push(...await fetchUploadUrls(source, fetchFn, opts)); break;
        case 'github':       items.push(...await fetchGitHub(source, fetchFn)); break;
        case 'google_drive': items.push(...await fetchGoogleDrive(source, lastRunAt, fetchFn, opts)); break;
        case 'dropbox':      items.push(...await fetchDropbox(source, lastRunAt, fetchFn)); break;
        case 'gmail':         items.push(...await fetchGmailMessages(source, lastRunAt, fetchFn)); break;
        case 'google_sheets': items.push(...await fetchGoogleSheetRows(source, ruleId, fetchFn)); break;
        case 'bibliography':  items.push(...await fetchBibliographyPapers(source, lastRunAt, opts)); break;
        default:             console.warn(`Unsupported source type: ${source.type}`);
      }
    } catch (err) {
      const label = source.type + (
        source.url             ? ` (${source.url})`                       :
        source.folderId        ? ` (${source.folderId})`                  :
        source.folderPath      ? ` (${source.folderPath})`                :
        source.sheetId         ? ` (sheet:${source.sheetId})`             :
        source.bibId           ? ` (bib:${source.bibId})`                 :
        source.from            ? ` (from:${source.from})`                 :
        source.subjectContains ? ` (subject:${source.subjectContains})`   : ''
      );
      console.error(`Source fetch error (${label}):`, err.message);
      sourceErrors.push(`Source error [${label}]: ${err.message}`);
    }
  }
  return { items, sourceErrors };
}

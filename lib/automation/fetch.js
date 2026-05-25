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

async function fetchUrl(source, fetchFn = fetch) {
  const res = await fetchFn(source.url, { headers: { 'User-Agent': 'VanceBot/1.0' } });
  if (!res.ok) throw new Error(`URL fetch failed: ${res.status} ${source.url}`);
  const html = await res.text();
  const rawText = stripHtmlToText(html);
  return [{ title: source.url, url: source.url, rawText, sourceType: 'url', pubDate: new Date() }];
}

// Upload source: a list of items extracted from an xlsx column A. Two flavours:
//   - URL cells (hyperlinked) — fetched and stripped to text
//   - plain-text cells — emitted as title-only items; the LLM "researches" them from its
//     training knowledge using the category prompt (e.g. Vance Living Blog Master prompt).
async function fetchUploadUrls(source, fetchFn = fetch, opts = {}) {
  const consumedUrls = new Set(Array.isArray(source.consumedUrls) && !opts.forceAll ? source.consumedUrls : []);
  const consumedTitles = new Set(Array.isArray(source.consumedTitles) && !opts.forceAll ? source.consumedTitles : []);
  const urls = (Array.isArray(source.urls) ? source.urls.filter(Boolean) : [])
    .filter(u => !consumedUrls.has(u));
  const titlesOnly = (Array.isArray(source.titlesOnly) ? source.titlesOnly.filter(Boolean) : [])
    .filter(t => !consumedTitles.has(t));
  if (!urls.length && !titlesOnly.length) {
    const fname = source.originalFilename || source.url || '(no file)';
    const isNullShape = source.urls === null || source.titlesOnly === null;
    const allConsumed = (consumedUrls.size + consumedTitles.size) > 0
      && (Array.isArray(source.urls) ? source.urls.filter(Boolean).length : 0) === consumedUrls.size
      && (Array.isArray(source.titlesOnly) ? source.titlesOnly.filter(Boolean).length : 0) === consumedTitles.size;
    const hint = isNullShape
      ? 'file was uploaded but not parsed (non-xlsx, or parse failed)'
      : allConsumed
        ? 'every row has already been generated. Edit the rule to clear consumedUrls/consumedTitles, or upload a new file.'
        : 'parsed file had no usable Column A cells';
    throw new Error(`Upload source "${fname}" has no items — ${hint}. Re-open the rule, upload an .xlsx whose Column A contains hyperlinked URLs or plain-text titles, then save.`);
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

  for (const title of titlesOnly) {
    // No URL, no body content — run.js sees titleOnly:true and uses the title as the topic.
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
        case 'url':          items.push(...await fetchUrl(source, fetchFn)); break;
        case 'upload':       items.push(...await fetchUploadUrls(source, fetchFn, opts)); break;
        case 'github':       items.push(...await fetchGitHub(source, fetchFn)); break;
        case 'google_drive': items.push(...await fetchGoogleDrive(source, lastRunAt, fetchFn)); break;
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

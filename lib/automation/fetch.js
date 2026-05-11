// lib/automation/fetch.js
import { fetchGoogleDrive, fetchDropbox } from '../sources/cloud-drives.js';
import { fetchGmailMessages } from '../sources/gmail.js';
import { fetchGoogleSheetRows } from '../sources/google-sheets.js';
import { fetchBibliographyPapers } from '../sources/bibliography.js';

// ── RSS ───────────────────────────────────────────────────────────────────────

export function parseRssItems(xml) {
  // Simple regex-based RSS parser — avoids DOMParser dependency in Node
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    // Try CDATA title first, then plain title
    const titleMatch = /<title><!\[CDATA\[(.*?)\]\]><\/title>/s.exec(block)
      || /<title>(.*?)<\/title>/s.exec(block);
    const title = (titleMatch?.[1] ?? '').trim();
    const url = (/<link>(.*?)<\/link>/s.exec(block)?.[1] ?? '').trim();
    const pubDateStr = (/<pubDate>(.*?)<\/pubDate>/s.exec(block)?.[1] ?? '').trim();
    const pubDate = pubDateStr ? new Date(pubDateStr) : new Date();
    items.push({ title, url, pubDate, rawText: '' });
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
  const items = parseRssItems(xml);
  return filterNewItems(items, lastRunAt).map(i => ({ ...i, sourceType: 'rss' }));
}

async function fetchUrl(source, fetchFn = fetch) {
  const res = await fetchFn(source.url, { headers: { 'User-Agent': 'VanceBot/1.0' } });
  if (!res.ok) throw new Error(`URL fetch failed: ${res.status} ${source.url}`);
  const rawText = await res.text();
  return [{ title: source.url, url: source.url, rawText, sourceType: 'url', pubDate: new Date() }];
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

// Returns { items, sourceErrors } — sourceErrors lets callers surface fetch failures to users
export async function fetchSources(sources, lastRunAt, fetchFn = fetch, ruleId = null) {
  const items = [];
  const sourceErrors = [];
  for (const source of sources) {
    try {
      switch (source.type) {
        case 'rss':          items.push(...await fetchRss(source, lastRunAt, fetchFn)); break;
        case 'url':          items.push(...await fetchUrl(source, fetchFn)); break;
        case 'github':       items.push(...await fetchGitHub(source, fetchFn)); break;
        case 'google_drive': items.push(...await fetchGoogleDrive(source, lastRunAt, fetchFn)); break;
        case 'dropbox':      items.push(...await fetchDropbox(source, lastRunAt, fetchFn)); break;
        case 'gmail':         items.push(...await fetchGmailMessages(source, lastRunAt, fetchFn)); break;
        case 'google_sheets': items.push(...await fetchGoogleSheetRows(source, ruleId, fetchFn)); break;
        case 'bibliography':  items.push(...await fetchBibliographyPapers(source, lastRunAt)); break;
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

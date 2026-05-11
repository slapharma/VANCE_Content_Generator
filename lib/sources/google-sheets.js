// lib/sources/google-sheets.js
// Fetch new rows from a Google Sheet as automation source items, and write
// generation/publish notes back to the originating row.
// Called by lib/automation/fetch.js when source.type === 'google_sheets'.

import { getValidGoogleToken } from '../automation/handlers/auth.js';
import { kv } from '../kv.js';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

// ── Column helpers ────────────────────────────────────────────────────────────

// 0-based index → column letter(s):  0→A, 25→Z, 26→AA
function colIndexToLetter(idx) {
  let letter = '';
  let n = idx + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

// Column letter(s) → 0-based index:  A→0, Z→25, AA→26
function colLetterToIndex(letter) {
  const s = letter.toUpperCase().trim();
  let result = 0;
  for (const ch of s) result = result * 26 + (ch.charCodeAt(0) - 64);
  return result - 1;
}

// Scan the header row and return a map of fieldName → 0-based column index.
// wpLink is checked BEFORE url so "published url" / "live url" headers don't steal the url slot.
function detectColumns(headers) {
  const map = {};
  headers.forEach((h, i) => {
    const low = (h || '').toLowerCase().trim();
    // Output columns first (so they don't get matched as input url)
    if (map.wpLink   === undefined && ['wp link','wordpress','wordpress link','published url','live url','published link','wp url','live link','wordpress url'].some(p => low === p)) map.wpLink = i;
    if (map.notes    === undefined && ['notes','note','status','generated','generation notes','comments','comment'].some(p => low === p))          map.notes  = i;
    // Input columns
    if (map.url      === undefined && ['url','link','source','source url','source link','article url','article link','paper url','paper link','doi','pubmed','pubmed url','web url','webpage','web page','website'].some(p => low === p)) map.url = i;
    if (map.title    === undefined && ['title','article title','paper title','headline'].some(p => low === p))                                     map.title    = i;
    if (map.subtitle === undefined && ['subtitle','sub-title','sub title'].some(p => low === p))                                                   map.subtitle = i;
    if (map.author   === undefined && ['author','authors','author(s)','by'].some(p => low === p))                                                  map.author   = i;
    if (map.date     === undefined && ['date','pub date','published','publication date','published date','pub. date','year'].some(p => low === p))  map.date     = i;
  });
  return map;
}

// ── URL content fetcher ───────────────────────────────────────────────────────

// Fetch the text content of a URL; strip HTML tags; cap at 20 000 chars.
async function fetchUrlText(url, fetchFn) {
  try {
    const res = await fetchFn(url, { headers: { 'User-Agent': 'GastroHealthHub-AutoBot/1.0' } });
    if (!res.ok) return null;
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 20000);
  } catch {
    return null;
  }
}

// ── Main fetch export ─────────────────────────────────────────────────────────

/**
 * Fetch unprocessed rows from a Google Sheet.
 * Returns items in the standard shape expected by lib/automation/fetch.js,
 * each with a _sheetMeta field for writeback.
 *
 * source fields:
 *   sheetId       (required) — spreadsheet ID from the URL
 *   sheetName     (optional, default 'Sheet1') — tab name
 *   urlColumn     (optional, e.g. 'B') — override auto-detected URL column
 *   notesColumn   (optional, e.g. 'F') — where to write generation note
 *   wpLinkColumn  (optional, e.g. 'G') — where to write published WP URL
 */
export async function fetchGoogleSheetRows(source, ruleId, fetchFn = fetch) {
  const accessToken = await getValidGoogleToken();
  const sheetId   = source.sheetId;
  const sheetName = source.sheetName || 'Sheet1';

  // Quote sheet names that contain spaces for A1 notation
  const rangeRef      = sheetName.includes(' ') ? `'${sheetName}'` : sheetName;
  const encodedRange  = encodeURIComponent(`${rangeRef}!A1:ZZ1000`);

  const res = await fetchFn(`${SHEETS_BASE}/${sheetId}/values/${encodedRange}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 403) {
    const body = await res.text();
    if (body.includes('PERMISSION_DENIED') || body.includes('insufficientPermissions') || body.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
      throw new Error(
        'Google account needs reconnection with Sheets access. ' +
        'Go to Settings → Google Connections, disconnect and reconnect.'
      );
    }
    throw new Error(`Sheets API 403: ${body.slice(0, 200)}`);
  }
  if (res.status === 429) throw new Error('Sheets API rate limited (429) — will retry next run');
  if (!res.ok)             throw new Error(`Sheets API failed: HTTP ${res.status}`);

  const data = await res.json();
  const rows = data.values ?? [];

  console.log(`[sheets] ${sheetId}/${sheetName}: fetched ${rows.length} rows (including header)`);

  if (rows.length < 2) {
    console.log(`[sheets] ${sheetId}/${sheetName}: sheet is empty or header-only — nothing to process`);
    return [];
  }

  const headers = rows[0].map(h => String(h ?? ''));
  const colMap  = detectColumns(headers);

  console.log(`[sheets] ${sheetId}/${sheetName}: headers = ${JSON.stringify(headers)}`);
  console.log(`[sheets] ${sheetId}/${sheetName}: detected columns = ${JSON.stringify(Object.fromEntries(Object.entries(colMap).map(([k,v]) => [k, colIndexToLetter(v)])))}`);

  // Source config overrides take precedence over auto-detection
  if (source.urlColumn)    colMap.url    = colLetterToIndex(source.urlColumn);
  if (source.notesColumn)  colMap.notes  = colLetterToIndex(source.notesColumn);
  if (source.wpLinkColumn) colMap.wpLink = colLetterToIndex(source.wpLinkColumn);

  // Defaults: URL → col A; notes/wpLink → append after last header column
  if (colMap.url    === undefined) { colMap.url = 0; console.log(`[sheets] ${sheetId}/${sheetName}: URL column not detected — defaulting to column A`); }
  if (colMap.notes  === undefined) colMap.notes  = headers.length;
  if (colMap.wpLink === undefined) colMap.wpLink = headers.length + 1;

  console.log(`[sheets] ${sheetId}/${sheetName}: using URL column ${colIndexToLetter(colMap.url)}, notes col ${colIndexToLetter(colMap.notes)}, wp col ${colIndexToLetter(colMap.wpLink)}`);

  // Load set of already-processed sheet row numbers from KV
  const kvKey    = `sheets:processed:${ruleId}:${sheetId}:${sheetName}`;
  const processed = new Set((await kv.get(kvKey)) ?? []);

  console.log(`[sheets] ${sheetId}/${sheetName}: ${processed.size} rows already processed: ${JSON.stringify([...processed])}`);

  const items = [];
  let skippedProcessed = 0, skippedNoUrl = 0;
  for (let i = 1; i < rows.length; i++) {
    const sheetRow = i + 1; // 1-based sheet row number (row 1 = header)
    if (processed.has(sheetRow)) { skippedProcessed++; continue; }

    const row      = rows[i];
    const url      = (row[colMap.url]      ?? '').toString().trim();
    if (!url) { skippedNoUrl++; continue; } // skip rows with no URL

    const title    = colMap.title    !== undefined ? (row[colMap.title]    ?? '').toString().trim() : '';
    const subtitle = colMap.subtitle !== undefined ? (row[colMap.subtitle] ?? '').toString().trim() : '';
    const author   = colMap.author   !== undefined ? (row[colMap.author]   ?? '').toString().trim() : '';
    const date     = colMap.date     !== undefined ? (row[colMap.date]     ?? '').toString().trim() : '';

    // Build a metadata preamble to give the LLM full context from the sheet
    const metaParts = [];
    if (title)    metaParts.push(`Title: ${title}`);
    if (subtitle) metaParts.push(`Subtitle: ${subtitle}`);
    if (author)   metaParts.push(`Author: ${author}`);
    if (date)     metaParts.push(`Published: ${date}`);
    metaParts.push(`Source URL: ${url}`);
    const metaBlock = `METADATA FROM SOURCE SHEET:\n${metaParts.join('\n')}\n\n`;

    // Fetch the page the URL points to for the actual article content
    const pageText = await fetchUrlText(url, fetchFn);
    const rawText  = metaBlock + (pageText
      ? `PAGE CONTENT:\n${pageText}`
      : '(Page content unavailable — generate from metadata only)');

    items.push({
      title:      title || url,
      url,
      rawText,
      sourceType: 'google_sheets',
      pubDate:    date ? new Date(date) : new Date(),
      _sheetMeta: { ruleId, sheetId, sheetName, rowNumber: sheetRow, colMap, kvKey },
    });
  }

  console.log(`[sheets] ${sheetId}/${sheetName}: returning ${items.length} items (skipped: ${skippedProcessed} already-processed, ${skippedNoUrl} no-url)`);
  return items;
}

// ── Writeback helpers (called from run.js and approve.js) ─────────────────────

/**
 * Write generation date + content review link to the Notes column of the row.
 * Also marks the row as processed in KV so it won't be picked up again.
 */
export async function writeSheetGenerationNote(sheetMeta, { contentId, appUrl }, fetchFn = fetch) {
  if (!sheetMeta) return;
  try {
    const accessToken = await getValidGoogleToken();
    const { sheetId, sheetName, rowNumber, colMap, kvKey } = sheetMeta;

    const notesLetter = colIndexToLetter(colMap.notes);
    const range       = `${sheetName.includes(' ') ? `'${sheetName}'` : sheetName}!${notesLetter}${rowNumber}`;
    const date        = new Date().toISOString().split('T')[0];
    const note        = `Generated ${date} — Review: ${appUrl}/#automation-jobs`;

    await fetchFn(
      `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      {
        method:  'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ range, majorDimension: 'ROWS', values: [[note]] }),
      }
    );

    // Mark row as processed so it won't be re-fetched on the next run
    const existing = new Set((await kv.get(kvKey)) ?? []);
    existing.add(rowNumber);
    await kv.set(kvKey, [...existing]);
  } catch (err) {
    console.warn(`[sheets] Generation writeback failed (row ${sheetMeta?.rowNumber}): ${err.message}`);
  }
}

/**
 * Write the published WordPress post URL to the WP Link column of the row.
 */
export async function writeSheetPublishNote(sheetMeta, wpPostUrl, fetchFn = fetch) {
  if (!sheetMeta || !wpPostUrl) return;
  try {
    const accessToken = await getValidGoogleToken();
    const { sheetId, sheetName, rowNumber, colMap } = sheetMeta;

    const wpLetter = colIndexToLetter(colMap.wpLink);
    const range    = `${sheetName.includes(' ') ? `'${sheetName}'` : sheetName}!${wpLetter}${rowNumber}`;

    await fetchFn(
      `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      {
        method:  'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ range, majorDimension: 'ROWS', values: [[wpPostUrl]] }),
      }
    );
  } catch (err) {
    console.warn(`[sheets] Publish writeback failed (row ${sheetMeta?.rowNumber}): ${err.message}`);
  }
}

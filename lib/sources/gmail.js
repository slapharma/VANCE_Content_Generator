// lib/sources/gmail.js
// Fetch and decode emails matching a filter from Gmail API v1.
// Called by lib/automation/fetch.js when source.type === 'gmail'.
// Mirrors the pattern established by lib/sources/cloud-drives.js.

import { getValidGoogleToken } from '../automation/handlers/auth.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Build a Gmail search query string from source filter fields.
function buildQuery(source, lastRunAt) {
  const parts = [];
  if (source.from) parts.push(`from:${source.from}`);
  if (source.subjectContains) parts.push(`subject:${source.subjectContains}`);
  if (lastRunAt) {
    parts.push(`after:${Math.floor(new Date(lastRunAt).getTime() / 1000)}`);
  } else {
    // First run: cap to last 7 days to avoid flooding on busy inboxes
    const sevenDaysAgo = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
    parts.push(`after:${sevenDaysAgo}`);
  }
  return parts.join(' ');
}

// Depth-first extraction of the best plain-text body from a Gmail message payload.
// Prefers text/plain over text/html. Falls back to stripping HTML tags.
export function extractBody(payload) {
  if (!payload) return '';

  // Direct plain-text part
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8').trim();
  }

  if (payload.parts?.length) {
    // Prefer a direct text/plain child before recursing into nested multipart
    const plainChild = payload.parts.find(p => p.mimeType === 'text/plain');
    if (plainChild?.body?.data) {
      return Buffer.from(plainChild.body.data, 'base64url').toString('utf-8').trim();
    }
    // Recurse into multipart children (handles multipart/mixed > multipart/alternative)
    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result) return result;
    }
  }

  // Last resort: strip HTML tags from text/html part
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  return '';
}

// Get the value of a named header (case-insensitive) from a Gmail message headers array.
function getHeader(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

// Fetch emails matching source filters. Returns items in the standard shape
// expected by lib/automation/fetch.js / run.js.
export async function fetchGmailMessages(source, lastRunAt, fetchFn = fetch) {
  const accessToken = await getValidGoogleToken();

  const q = buildQuery(source, lastRunAt);
  const labelIds = source.labelIds?.length ? source.labelIds : ['INBOX'];
  const maxResults = Math.min(source.maxResults ?? 5, 20);

  // Step 1: list matching message IDs
  const params = new URLSearchParams({ q, maxResults: String(maxResults) });
  for (const label of labelIds) params.append('labelIds', label);

  const listRes = await fetchFn(`${GMAIL_BASE}/messages?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (listRes.status === 403) {
    const body = await listRes.text();
    if (body.includes('insufficientPermissions') || body.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
      throw new Error(
        'Google account needs reconnection — additional permissions required. ' +
        'Go to Settings → Google Connections and click Connect Google.'
      );
    }
    throw new Error(`Gmail API 403: ${body.slice(0, 200)}`);
  }
  if (listRes.status === 429) {
    throw new Error('Gmail API rate limited (429) — will retry on next scheduled run');
  }
  if (!listRes.ok) {
    throw new Error(`Gmail messages.list failed: HTTP ${listRes.status}`);
  }

  const listData = await listRes.json();
  const messageIds = listData.messages ?? [];
  if (messageIds.length === 0) return [];

  // Step 2: fetch full message for each ID
  const items = [];
  for (const { id } of messageIds) {
    const msgRes = await fetchFn(`${GMAIL_BASE}/messages/${id}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!msgRes.ok) {
      console.warn(`Gmail: skipping message ${id} — fetch failed ${msgRes.status}`);
      continue;
    }
    const msg = await msgRes.json();
    const headers = msg.payload?.headers ?? [];
    const subject = getHeader(headers, 'Subject') || '(no subject)';
    const rawText = extractBody(msg.payload);

    if (!rawText) {
      console.warn(`Gmail: skipping message ${id} (subject: "${subject}") — empty body after decode`);
      continue;
    }

    items.push({
      title: subject,
      url: null,
      rawText,
      sourceType: 'gmail',
      pubDate: new Date(parseInt(msg.internalDate, 10)),
    });
  }

  return items;
}

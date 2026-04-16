// lib/sources/cloud-drives.js
// Fetch new files from a monitored Google Drive or Dropbox folder.
// Called by lib/automation/fetch.js when source.type is 'google_drive' or 'dropbox'.

import { getTokens, saveTokens, getCredentials, refreshGoogleToken, refreshDropboxToken } from '../auth/oauth.js';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm']);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Extract text from a PDF or DOCX via Drive's OCR: copy the file as a Google Doc, export
// as plain text, then delete the temporary copy.
async function extractTextViaDriveOcr(fileId, mimeType, accessToken, fetchFn) {
  // 1. Download the original file bytes.
  const dlRes = await fetchFn(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!dlRes.ok) {
    throw new Error(`Drive download failed ${dlRes.status}: ${(await dlRes.text()).slice(0, 300)}`);
  }
  const fileBytes = new Uint8Array(await dlRes.arrayBuffer());

  // 2. Multipart upload as a new Google Doc with ocrLanguage=en — documented OCR path.
  const boundary = '-------slaocr' + Math.random().toString(16).slice(2);
  const metadata = JSON.stringify({
    name: `__ocr_tmp_${Date.now()}`,
    mimeType: 'application/vnd.google-apps.document',
  });
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType || 'application/pdf'}\r\n\r\n`
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + fileBytes.length + tail.length);
  body.set(head, 0);
  body.set(fileBytes, head.length);
  body.set(tail, head.length + fileBytes.length);

  const upRes = await fetchFn('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&ocrLanguage=en&supportsAllDrives=true', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!upRes.ok) {
    throw new Error(`Drive OCR upload failed ${upRes.status}: ${(await upRes.text()).slice(0, 300)}`);
  }
  const created = await upRes.json();

  // 3. Export the new Google Doc as plain text.
  const exportRes = await fetchFn(
    `https://www.googleapis.com/drive/v3/files/${created.id}/export?mimeType=text/plain`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  let text = '';
  let exportErr = null;
  if (exportRes.ok) {
    text = await exportRes.text();
  } else {
    exportErr = `Drive export failed ${exportRes.status}: ${(await exportRes.text()).slice(0, 300)}`;
  }

  // 4. Always try to delete the temporary Doc (non-fatal).
  try {
    await fetchFn(`https://www.googleapis.com/drive/v3/files/${created.id}?supportsAllDrives=true`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch { /* ignore cleanup failures */ }

  if (exportErr) throw new Error(exportErr);
  return text.trim();
}

// ── Google Drive ──────────────────────────────────────────────────────────────

async function getValidGoogleAccessToken(fetchFn) {
  const tokens = await getTokens('google');
  if (!tokens?.accessToken) throw new Error('Google Drive not connected — connect in Settings > Cloud Integrations');

  // Refresh 5 minutes before expiry
  if (tokens.expiresAt && Date.now() > tokens.expiresAt - 300_000) {
    const creds = await getCredentials('google');
    if (!creds) throw new Error('Google credentials missing');
    const refreshed = await refreshGoogleToken(tokens.refreshToken, creds.clientId, creds.clientSecret, fetchFn);
    const updated = { ...tokens, accessToken: refreshed.access_token, expiresAt: Date.now() + refreshed.expires_in * 1000 };
    await saveTokens('google', updated);
    return updated.accessToken;
  }
  return tokens.accessToken;
}

export async function fetchGoogleDrive(source, lastRunAt, fetchFn = fetch) {
  const accessToken = await getValidGoogleAccessToken(fetchFn);
  const { folderId } = source;
  if (!folderId) throw new Error('Google Drive source missing folderId');

  let q = `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
  if (lastRunAt) q += ` and modifiedTime > '${new Date(lastRunAt).toISOString()}'`;

  const listUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,webViewLink,modifiedTime)&pageSize=20&orderBy=modifiedTime%20desc&includeItemsFromAllDrives=true&supportsAllDrives=true`;
  const listRes = await fetchFn(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const listBody = await listRes.text();
  if (!listRes.ok) throw new Error(`Drive API error ${listRes.status}: ${listBody}`);
  const { files = [] } = JSON.parse(listBody);

  const results = [];
  for (const file of files) {
    let rawText = '';
    const ext = `.${file.name.split('.').pop()}`.toLowerCase();

    if (TEXT_EXTENSIONS.has(ext)) {
      const dlRes = await fetchFn(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (dlRes.ok) rawText = await dlRes.text();
    } else if (file.mimeType === 'application/vnd.google-apps.document') {
      const exportRes = await fetchFn(
        `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (exportRes.ok) rawText = await exportRes.text();
    } else if (ext === '.pdf' || file.mimeType === 'application/pdf' || ext === '.docx' || file.mimeType === DOCX_MIME) {
      // Extract real text via Drive OCR (copy → Google Doc → export as plain text → delete).
      // Without this the LLM has no source content and fabricates an unrelated article.
      try {
        rawText = await extractTextViaDriveOcr(file.id, file.mimeType, accessToken, fetchFn);
      } catch (ocrErr) {
        // Surface the reason in rawText so run.js's empty-check reports it verbatim.
        // Using a sentinel prefix so run.js can detect and pass through the message.
        rawText = `__OCR_ERROR__: ${ocrErr.message}`;
      }
    }

    results.push({
      title: file.name,
      url: file.webViewLink,
      rawText,
      sourceType: 'google_drive',
      pubDate: new Date(file.modifiedTime),
    });
  }
  return results;
}

// ── Dropbox ───────────────────────────────────────────────────────────────────

export async function fetchDropbox(source, lastRunAt, fetchFn = fetch) {
  const tokens = await getTokens('dropbox');
  if (!tokens?.accessToken) throw new Error('Dropbox not connected — connect in Settings > Cloud Integrations');

  // Auto-refresh: Dropbox short-lived tokens expire after ~4h
  let accessToken = tokens.accessToken;
  console.log('[Dropbox] Token state:', JSON.stringify({
    hasAccessToken: !!tokens.accessToken,
    hasRefreshToken: !!tokens.refreshToken,
    tokenKeys: Object.keys(tokens),
  }));

  if (tokens.refreshToken) {
    const creds = await getCredentials('dropbox');
    console.log('[Dropbox] Creds state:', JSON.stringify({ hasClientId: !!creds?.clientId, hasClientSecret: !!creds?.clientSecret }));
    if (creds?.clientId && creds?.clientSecret) {
      try {
        const refreshed = await refreshDropboxToken(tokens.refreshToken, creds.clientId, creds.clientSecret, fetchFn);
        console.log('[Dropbox] Refresh succeeded, new token length:', refreshed.access_token?.length);
        accessToken = refreshed.access_token;
        await saveTokens('dropbox', {
          accessToken: refreshed.access_token,
          refreshToken: tokens.refreshToken,
          expiresAt: Date.now() + (refreshed.expires_in || 14400) * 1000,
        });
      } catch (refreshErr) {
        console.error('[Dropbox] Refresh FAILED:', refreshErr.message);
      }
    }
  } else {
    console.warn('[Dropbox] No refresh token stored — access token will expire and cannot be renewed');
  }

  // Dropbox paths must be '' for root or start with '/'; normalise user input
  let folderPath = (source.folderPath || '').trim();
  if (folderPath && !folderPath.startsWith('/')) folderPath = '/' + folderPath;

  const listRes = await fetchFn('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: folderPath || '', recursive: false }),
  });
  if (!listRes.ok) {
    const errBody = await listRes.text();
    throw new Error(`Dropbox list_folder error ${listRes.status}: ${errBody} [refreshed=${accessToken !== tokens.accessToken}, pathUsed=${JSON.stringify(folderPath || '')}]`);
  }
  const listData = await listRes.json();

  const allEntries = listData.entries || [];
  const sinceDate = lastRunAt ? new Date(lastRunAt) : null;

  // Diagnostic: if no files found, include folder contents in error for debugging
  if (!allEntries.length) {
    throw new Error(`Dropbox folder is empty (path=${JSON.stringify(folderPath || '')}). Ensure files are placed directly in Apps/VanceContentD/${folderPath || ''}`);
  }

  const files = allEntries.filter(e => {
    if (e['.tag'] !== 'file') return false;
    if (sinceDate && new Date(e.server_modified) <= sinceDate) return false;
    return true;
  });

  // If entries exist but all filtered out, report what was found
  if (!files.length && allEntries.length) {
    const names = allEntries.slice(0, 5).map(e => `${e.name} (${e['.tag']}, ${e.server_modified || 'n/a'})`).join(', ');
    throw new Error(`Dropbox: ${allEntries.length} entries found but all filtered out (lastRunAt=${lastRunAt}). Found: ${names}`);
  }

  const results = [];
  for (const file of files.slice(0, 10)) {
    let rawText = '';
    const ext = `.${file.name.split('.').pop()}`.toLowerCase();

    if (TEXT_EXTENSIONS.has(ext)) {
      const dlRes = await fetchFn('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Dropbox-API-Arg': JSON.stringify({ path: file.path_lower }),
        },
      });
      if (dlRes.ok) rawText = await dlRes.text();
    } else if (ext === '.pdf' || ext === '.docx') {
      // Dropbox has no native OCR and we refuse to fabricate from a filename.
      // Skip the file with a clear marker; run.js will treat empty rawText as a hard error.
      rawText = '';
    }

    results.push({
      title: file.name,
      url: `https://www.dropbox.com/home${file.path_display}`,
      rawText,
      sourceType: 'dropbox',
      pubDate: new Date(file.server_modified),
    });
  }
  return results;
}

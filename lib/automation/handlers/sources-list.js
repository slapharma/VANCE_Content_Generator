// lib/automation/handlers/sources-list.js
// POST /api/automation/sources-list  body: { ruleId } | { source }
// Returns the list of files visible in a Google Drive / Dropbox source folder
// without running OCR or generating articles. Used by the UI to show files in
// a "click to view sources" popup with checkboxes for selective re-processing.
import { kv } from '../../kv.js';
import { getTokens, getCredentials, refreshGoogleToken, refreshDropboxToken, saveTokens } from '../../auth/oauth.js';

async function listGoogleDriveFiles(source) {
  let tokens = await getTokens('google');
  if (!tokens?.accessToken) throw new Error('Google Drive not connected');
  if (tokens.expiresAt && Date.now() > tokens.expiresAt - 300_000 && tokens.refreshToken) {
    const creds = await getCredentials('google');
    if (creds) {
      const r = await refreshGoogleToken(tokens.refreshToken, creds.clientId, creds.clientSecret, fetch);
      tokens = { ...tokens, accessToken: r.access_token, expiresAt: Date.now() + r.expires_in * 1000 };
      await saveTokens('google', tokens);
    }
  }
  const q = `'${source.folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,webViewLink,modifiedTime,size)&pageSize=100&orderBy=modifiedTime%20desc&includeItemsFromAllDrives=true&supportsAllDrives=true`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tokens.accessToken}` } });
  if (!r.ok) throw new Error(`Drive API ${r.status}: ${await r.text()}`);
  const { files = [] } = await r.json();
  return files.map(f => ({
    name: f.name,
    id: f.id,
    url: f.webViewLink,
    modified: f.modifiedTime,
    mimeType: f.mimeType,
  }));
}

async function listDropboxFiles(source) {
  const tokens = await getTokens('dropbox');
  if (!tokens?.accessToken) throw new Error('Dropbox not connected');
  let accessToken = tokens.accessToken;
  if (tokens.refreshToken) {
    const creds = await getCredentials('dropbox');
    if (creds?.clientId && creds?.clientSecret) {
      try {
        const r = await refreshDropboxToken(tokens.refreshToken, creds.clientId, creds.clientSecret, fetch);
        accessToken = r.access_token;
        await saveTokens('dropbox', { accessToken: r.access_token, refreshToken: tokens.refreshToken, expiresAt: Date.now() + (r.expires_in || 14400) * 1000 });
      } catch {}
    }
  }
  let folderPath = (source.folderPath || '').trim();
  if (folderPath && !folderPath.startsWith('/')) folderPath = '/' + folderPath;
  const r = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: folderPath || '', recursive: false }),
  });
  if (!r.ok) throw new Error(`Dropbox ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return (data.entries || [])
    .filter(e => e['.tag'] === 'file')
    .map(e => ({
      name: e.name,
      id: e.id || e.path_lower,
      url: `https://www.dropbox.com/home${e.path_display}`,
      modified: e.server_modified,
      mimeType: null,
    }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    let { source, ruleId } = req.body || {};
    if (!source && ruleId) {
      const rule = await kv.get(`automation:rule:${ruleId}`);
      if (!rule) return res.status(404).json({ error: 'Rule not found' });
      // Return files for ALL sources on this rule, grouped
      const groups = [];
      for (const s of (rule.sources || [])) {
        try {
          let files = [];
          if (s.type === 'google_drive') files = await listGoogleDriveFiles(s);
          else if (s.type === 'dropbox')  files = await listDropboxFiles(s);
          else                             files = [];
          groups.push({ source: s, files, error: null });
        } catch (err) {
          groups.push({ source: s, files: [], error: err.message });
        }
      }
      return res.status(200).json({ groups });
    }
    if (!source) return res.status(400).json({ error: 'source or ruleId required' });
    let files = [];
    if (source.type === 'google_drive') files = await listGoogleDriveFiles(source);
    else if (source.type === 'dropbox')  files = await listDropboxFiles(source);
    return res.status(200).json({ files });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

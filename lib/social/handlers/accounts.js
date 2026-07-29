// lib/social/handlers/accounts.js
// Multi-account management API. Mounted at /api/social/accounts*.
//
//   GET    /api/social/accounts                  → list all accounts (+ live Composio status when configured)
//   POST   /api/social/accounts/link             → body { platform } → returns Composio hosted OAuth redirectUrl
//   POST   /api/social/accounts                   → body { platform, label, connectedAccountId, config? } → register a connected account
//   PATCH  /api/social/accounts/:id               → body { isDefault:true } → set platform default
//   DELETE /api/social/accounts/:id               → remove an account
//
// The link → connect → register flow:
//   1. UI calls POST /accounts/link { platform } → opens redirectUrl in a popup.
//   2. User authorises in Composio's hosted page; Composio creates the connection.
//   3. UI calls GET /accounts (which lists live Composio connections) OR
//      POST /accounts with the connectedAccountId to label + save it locally.

import { listAccounts, addAccount, removeAccount, setDefaultAccount } from '../accounts.js';
import { linkAccount, listConnections, isComposioConfigured } from '../composio.js';
import { discoverInstagramAccounts } from '../platforms/composio.js';

export default async function handler(req, res, sub) {
  // sub is the path after 'accounts' (e.g. 'link' or an account id), slash-joined.
  const seg = (sub || '').split('/').filter(Boolean);
  const action = seg[0] || null;

  try {
    // POST /accounts/link  → start hosted OAuth
    if (req.method === 'POST' && action === 'link') {
      const { platform } = req.body || {};
      if (!platform) return res.status(400).json({ error: 'platform required' });
      if (!isComposioConfigured()) return res.status(400).json({ error: 'COMPOSIO_API_KEY not set' });
      const { redirectUrl, connectionId } = await linkAccount(platform);
      return res.status(200).json({ redirectUrl, connectionId });
    }

    // GET /accounts  → local registry, enriched with live Composio status
    if (req.method === 'GET' && !action) {
      const local = await listAccounts();
      let live = [];
      if (isComposioConfigured()) {
        try { live = await listConnections({}); } catch (e) { /* non-fatal */ }
      }
      const liveById = new Map(live.map((c) => [c.id, c]));
      const enriched = local.map((a) => ({
        ...a,
        status: liveById.get(a.connectedAccountId)?.status || a.status,
      }));
      return res.status(200).json({ accounts: enriched, composioConnections: live });
    }

    // POST /accounts/discover  → body { platform:'instagram' } → find IG Business
    // Accounts reachable from the connected Meta login (via their linked
    // Facebook Page), for one-click registration. Read-only: nothing is saved
    // until the caller POSTs one of the candidates to /accounts itself.
    if (req.method === 'POST' && action === 'discover') {
      const { platform } = req.body || {};
      if (platform !== 'instagram') {
        return res.status(400).json({ error: 'Only platform:"instagram" is supported for discovery' });
      }
      if (!isComposioConfigured()) return res.status(400).json({ error: 'COMPOSIO_API_KEY not set' });

      // The connectedAccountId to use is the live Composio connection for each
      // toolkit, not the local registry — a brand-new Meta login has a live
      // Instagram connection before anything is ever registered as an
      // "account" here, and that connection is what every candidate must be
      // registered against (Composio scopes a connectedAccountId to the
      // toolkit it was authorised for, so a Facebook id cannot post Instagram
      // tools). One IG connection already addresses every sibling IG Business
      // Account by id — the same shape the app's two Facebook accounts use.
      const liveConnections = await listConnections({ activeOnly: true });
      const facebookConnectedAccountId = liveConnections.find((c) => c.toolkit === 'facebook')?.id;
      const instagramConnectedAccountId = liveConnections.find((c) => c.toolkit === 'instagram')?.id;

      const found = await discoverInstagramAccounts({ facebookConnectedAccountId, instagramConnectedAccountId });
      const igAccounts = await listAccounts('instagram');
      const registeredIgIds = new Set(igAccounts.map((a) => a.config?.igUserId).filter(Boolean));
      const candidates = found.candidates.map((c) => ({
        ...c,
        connectedAccountId: instagramConnectedAccountId || null,
        alreadyRegistered: registeredIgIds.has(c.igUserId),
      }));
      // pagesSeen/unlinkedPages ride along so an empty result can explain itself.
      // Discovery is Page-based, so the Page list *is* the diagnosis: too few
      // Pages is a Facebook permissions problem, Pages-without-Instagram is a
      // linking or scope problem, and the two need different fixes.
      return res.status(200).json({
        candidates,
        pagesSeen: found.pagesSeen,
        unlinkedPages: found.unlinkedPages,
        facebookConnected: Boolean(facebookConnectedAccountId),
        instagramConnected: Boolean(instagramConnectedAccountId),
      });
    }

    // POST /accounts  → register a connected account into the local registry
    if (req.method === 'POST' && !action) {
      const { platform, label, connectedAccountId, config } = req.body || {};
      if (!platform || !connectedAccountId) {
        return res.status(400).json({ error: 'platform and connectedAccountId required' });
      }
      const account = await addAccount({ platform, label, connectedAccountId, config });
      return res.status(201).json({ account });
    }

    // PATCH /accounts/:id  → set default
    if (req.method === 'PATCH' && action) {
      const { isDefault } = req.body || {};
      if (isDefault) {
        const ok = await setDefaultAccount(action);
        if (!ok) return res.status(404).json({ error: 'account not found' });
      }
      return res.status(200).json({ ok: true });
    }

    // DELETE /accounts/:id
    if (req.method === 'DELETE' && action) {
      const ok = await removeAccount(action);
      return res.status(ok ? 200 : 404).json({ ok });
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('[accounts] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

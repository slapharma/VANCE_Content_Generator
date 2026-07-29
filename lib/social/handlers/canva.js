// lib/social/handlers/canva.js
//
//   GET /api/social/canva                  connection + capability status
//   GET /api/social/canva/designs?q=       your Canva designs
//   GET /api/social/canva/templates?q=     brand templates with data fields
//   GET /api/social/canva/designs/:id      one design's metadata
//
// Read-only. Building a deck from Canva happens in promo-run.js, on the campaign's
// own schedule — nothing here creates or exports anything, so the picker can be
// browsed freely without burning Canva export quota.

import {
  canvaAccountId, canvaSetupState, capabilities, listDesigns, listBrandTemplates,
  designMetadata, MAX_CANVA_PAGES,
} from '../canva.js';

/** The three ways Canva can be unavailable, each with a different fix. */
const SETUP_HELP = {
  'no-composio': 'Composio is not configured for this app. Set COMPOSIO_API_KEY in Vercel.',
  'no-auth-config': 'Canva has no Auth Config in this app\'s Composio project. In the Composio dashboard, create an Auth Config for the Canva toolkit, then set COMPOSIO_AUTHCONFIG_CANVA in Vercel. Connecting Canva to a different Composio project (for example through an AI assistant\'s connector) does not make it visible here.',
  ready: 'Canva is set up but no account is connected yet. Use Connect Canva below.',
};

/**
 * Whether Canva is usable, and for which of the two paths.
 *
 * Reports the two failure modes separately because the fix differs: no
 * connection is something to do in Composio, while no brand templates is
 * something to do in Canva itself (and may not be possible at all on a
 * non-Enterprise plan, where the capability is simply absent).
 */
async function status(req, res) {
  const setup = canvaSetupState();
  const accountId = setup === 'ready'
    ? await canvaAccountId({ refresh: req.query?.refresh === '1' })
    : null;

  if (!accountId) {
    return res.status(200).json({
      connected: false,
      setup,
      // `canLink` gates the Connect button: offering it without an auth config
      // produces a confusing 500 from Composio rather than a useful message.
      canLink: setup === 'ready',
      reason: SETUP_HELP[setup],
      canUseDesigns: false,
      canUseTemplates: false,
    });
  }

  let caps = [];
  let capsError = null;
  try {
    caps = await capabilities();
  } catch (err) {
    capsError = err.message;
  }

  // Ask for one page of each so the UI can say "you have designs but no brand
  // templates" rather than leaving the operator to discover it in a picker.
  let designCount = null;
  let templateCount = null;
  try { designCount = (await listDesigns({})).items.length; } catch { /* non-fatal */ }
  try { templateCount = (await listBrandTemplates({})).items.length; } catch { /* non-fatal */ }

  const hasBrandTemplateCap = caps.includes('brand_template');
  return res.status(200).json({
    connected: true,
    capabilities: caps,
    capabilitiesError: capsError,
    designCount,
    templateCount,
    canUseDesigns: true,
    canUseTemplates: hasBrandTemplateCap && templateCount > 0,
    // The distinction that matters when the templates list comes back empty.
    templateHint: !hasBrandTemplateCap
      ? 'This Canva plan does not expose brand templates. Autofill needs Canva Enterprise.'
      : (templateCount === 0
          ? 'No brand templates with data fields yet. In Canva, publish a design as a brand template and add named text fields to it, then refresh.'
          : null),
    maxPages: MAX_CANVA_PAGES,
  });
}

async function designs(req, res) {
  const out = await listDesigns({
    query: (req.query?.q || '').toString().trim(),
    continuation: req.query?.continuation || null,
  });
  return res.status(200).json(out);
}

async function templates(req, res) {
  const out = await listBrandTemplates({
    query: (req.query?.q || '').toString().trim(),
    continuation: req.query?.continuation || null,
  });
  return res.status(200).json(out);
}

export default async function handler(req, res, { id, action } = {}) {
  if (req.method !== 'GET') return res.status(405).end();

  try {
    if (!id) return await status(req, res);
    if (id === 'designs' && !action) return await designs(req, res);
    if (id === 'templates') return await templates(req, res);
    if (id === 'designs' && action) {
      return res.status(200).json(await designMetadata(action));
    }
    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    // 502: every failure here is upstream (Composio or Canva), and the message is
    // shown verbatim so "no Canva account connected" reads as itself.
    return res.status(502).json({ error: err.message });
  }
}

// lib/social/canva.js
//
// Canva, reached through the same Composio connection the social platforms use.
//
// Two ways a promo campaign can get its slides from Canva:
//
//   'canva-design'   — an existing design you have already built. Its pages are
//                      exported as images and become the deck, verbatim. The
//                      words are whatever you put in Canva; the model only
//                      writes the Instagram caption and hashtags.
//   'canva-template' — a brand template with named data fields. The model writes
//                      the copy, it is autofilled into the template, and the
//                      result is exported. This is the powerful one, and it
//                      needs brand templates to exist in the Canva account
//                      first — see listBrandTemplates.
//
// Everything here is async-job shaped: Canva starts a job and you poll it. The
// polling budget is deliberately modest because this runs inside a serverless
// function that also has to render and upload; a job that has not finished in a
// minute is reported as such rather than held onto.

import { executeTool, listConnections, isComposioConfigured, hasAuthConfig } from './composio.js';

const SLUGS = {
  capabilities:    'CANVA_GET_USERS_ME_CAPABILITIES',
  listDesigns:     'CANVA_LIST_USER_DESIGNS',
  listTemplates:   'CANVA_ACCESS_USER_SPECIFIC_BRAND_TEMPLATES_LIST',
  designMeta:      'CANVA_FETCH_DESIGN_METADATA_AND_ACCESS_INFORMATION',
  exportFormats:   'CANVA_GET_DESIGNS_DESIGNID_EXPORT_FORMATS',
  startExport:     'CANVA_POST_EXPORTS',
  exportResult:    'CANVA_GET_DESIGN_EXPORT_JOB_RESULT',
  startAutofill:   'CANVA_INITIATE_CANVA_DESIGN_AUTOFILL_JOB',
};

/** Instagram's ceiling. A design with more pages is truncated, loudly. */
export const MAX_CANVA_PAGES = 10;

const POLL_INTERVAL_MS = 2500;
const POLL_MAX_MS = 75_000;

let _accountCache = null;

/**
 * The connected Canva account, if there is one.
 *
 * Cached per lambda instance: this is one extra Composio round trip on a path
 * that already makes several, and the answer only changes when someone connects
 * or removes an account.
 *
 * @returns {Promise<string|null>} connectedAccountId
 */
export function canvaSetupState() {
  if (!isComposioConfigured()) return 'no-composio';
  if (!hasAuthConfig('canva')) return 'no-auth-config';
  return 'ready';
}

export async function canvaAccountId({ refresh = false } = {}) {
  if (!isComposioConfigured()) return null;
  if (_accountCache !== null && !refresh) return _accountCache;
  try {
    const conns = await listConnections({ activeOnly: true });
    const hit = conns.find((c) => String(c.toolkit || '').toLowerCase() === 'canva');
    _accountCache = hit?.id || null;
  } catch (err) {
    console.warn('[canva] could not list Composio connections:', err.message);
    _accountCache = null;
  }
  return _accountCache;
}

async function call(slug, args = {}) {
  const connectedAccountId = await canvaAccountId();
  if (!connectedAccountId) {
    throw new Error('No Canva account is connected in Composio. Connect one, then try again.');
  }
  return executeTool(slug, { connectedAccountId, arguments: args });
}

/** Canva nests its payloads inconsistently; unwrap one level when present. */
const body = (out) => out?.data ?? out;

/**
 * What this Canva plan can actually do.
 *
 * Worth checking before offering brand templates in the UI: autofill and brand
 * templates are Canva Enterprise features, and an account without them returns
 * empty lists rather than an error, which reads as "you have no templates"
 * instead of "your plan cannot do this".
 */
export async function capabilities() {
  const out = body(await call(SLUGS.capabilities));
  return Array.isArray(out?.capabilities) ? out.capabilities : [];
}

export async function listDesigns({ query = '', continuation = null } = {}) {
  const args = { ownership: 'any', sort_by: 'modified_descending' };
  if (query) args.query = query;
  if (continuation) args.continuation = continuation;
  const out = body(await call(SLUGS.listDesigns, args));
  return {
    items: (out?.items || []).map((d) => ({
      id: d.id,
      title: d.title || 'Untitled',
      pageCount: d.page_count ?? null,
      thumbnail: d.thumbnail?.url || null,
      updatedAt: d.updated_at ? new Date(d.updated_at * 1000).toISOString() : null,
      editUrl: d.urls?.edit_url || null,
    })),
    continuation: out?.continuation || null,
  };
}

export async function listBrandTemplates({ query = '', continuation = null } = {}) {
  // `non_empty` filters to templates that actually declare data fields — a brand
  // template with no fields cannot be autofilled, so offering it would only
  // produce a confusing failure later.
  const args = { ownership: 'any', dataset: 'non_empty' };
  if (query) args.query = query;
  if (continuation) args.continuation = continuation;
  const out = body(await call(SLUGS.listTemplates, args));
  return {
    items: (out?.items || []).map((t) => ({
      id: t.id,
      title: t.title || 'Untitled',
      thumbnail: t.thumbnail?.url || null,
      updatedAt: t.updated_at ? new Date(t.updated_at * 1000).toISOString() : null,
      // The dataset is what tells us which fields the autofill payload must
      // carry, and of what type.
      fields: Object.entries(t.dataset || {}).map(([name, def]) => ({
        name,
        type: def?.type || 'text',
      })),
    })),
    continuation: out?.continuation || null,
  };
}

export async function designMetadata(designId) {
  const out = body(await call(SLUGS.designMeta, { designId }));
  const d = out?.design || out;
  return {
    id: d?.id || designId,
    title: d?.title || 'Untitled',
    pageCount: d?.page_count ?? null,
    thumbnail: d?.thumbnail?.url || null,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll an async Canva job until it settles.
 *
 * @param {Function} fetchOnce - returns the job object
 * @param {string} label - for the timeout message
 */
async function pollJob(fetchOnce, label) {
  const deadline = Date.now() + POLL_MAX_MS;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const job = await fetchOnce();
    last = job;
    const status = job?.status;
    if (status === 'success') return job;
    if (status === 'failed') {
      throw new Error(`Canva ${label} failed: ${job?.error?.message || job?.error?.code || 'no reason given'}`);
    }
  }
  throw new Error(`Canva ${label} did not finish within ${POLL_MAX_MS / 1000}s (last status: ${last?.status || 'unknown'})`);
}

/**
 * Export a design's pages as images.
 *
 * JPG rather than PNG: Instagram's Graph API requires JPEG for `image_url`, and
 * exporting straight to it avoids a conversion step. Canva rejects PNG for some
 * design types anyway, which is the failure the plan warns about.
 *
 * @param {string} designId
 * @param {object} [opts]
 * @param {number[]} [opts.pages] - 1-indexed subset; omit for every page
 * @returns {Promise<string[]>} download URLs, in page order
 */
export async function exportDesignPages(designId, { pages = null } = {}) {
  const format = { type: 'jpg', quality: 90 };
  if (pages?.length) format.pages = pages;

  const started = body(await call(SLUGS.startExport, { design_id: designId, format }));
  const exportId = started?.job?.id || started?.id;
  if (!exportId) throw new Error('Canva returned no export job id');

  const job = await pollJob(
    async () => body(await call(SLUGS.exportResult, { exportId }))?.job,
    'export',
  );
  const urls = job?.urls || [];
  if (!urls.length) throw new Error('Canva export finished but returned no download URLs');
  return urls;
}

/**
 * Autofill a brand template and return the resulting design id.
 *
 * The autofill job usually returns only a job id, with the design id arriving on
 * a later poll — which is why this polls rather than reading the first response.
 *
 * @param {string} brandTemplateId
 * @param {object} data - `{ fieldName: { type: 'text', text: '…' } }`
 * @param {string} [title]
 */
export async function autofillBrandTemplate(brandTemplateId, data, title = null) {
  const args = { brand_template_id: brandTemplateId, data };
  if (title) args.title = title.slice(0, 255);

  const started = body(await call(SLUGS.startAutofill, args));
  const jobId = started?.job?.id || started?.id;
  const immediate = started?.job?.result?.design?.id;
  if (immediate) return immediate;
  if (!jobId) throw new Error('Canva returned no autofill job id');

  // The autofill job is polled through the same result endpoint shape as export.
  const job = await pollJob(
    async () => body(await call(SLUGS.exportResult, { exportId: jobId }))?.job,
    'autofill',
  );
  const designId = job?.result?.design?.id || job?.design?.id;
  if (!designId) throw new Error('Canva autofill finished but returned no design id');
  return designId;
}

/**
 * Turn a generated spec into an autofill payload for a template's fields.
 *
 * Matching is by name, case-insensitively and ignoring separators, so a template
 * field called "Hook Title", "hook_title" or "hooktitle" all receive the
 * headline. Fields the spec has nothing for are omitted rather than filled with
 * an empty string, which would blank them in the design.
 *
 * @param {object} spec
 * @param {Array<{name: string, type: string}>} fields
 * @returns {object} the `data` object CANVA_INITIATE_CANVA_DESIGN_AUTOFILL_JOB wants
 */
export function buildAutofillData(spec, fields) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  const candidates = {
    eyebrow: spec?.eyebrow,
    hooktitle: spec?.hookTitle,
    title: spec?.hookTitle,
    headline: spec?.hookTitle,
    brief: spec?.brief?.body,
    body: spec?.brief?.body,
    intro: spec?.brief?.body,
    update: spec?.update?.body,
    close: spec?.update?.body,
    closing: spec?.update?.body,
    cta: spec?.cta?.label,
    ctalabel: spec?.cta?.label,
    domain: spec?.cta?.domain,
  };
  // Point slides are addressed positionally: point1 / point1body, point2, …
  (spec?.points || []).forEach((p, i) => {
    candidates[`point${i + 1}`] = p.headline;
    candidates[`point${i + 1}headline`] = p.headline;
    candidates[`point${i + 1}body`] = p.body;
    candidates[`benefit${i + 1}`] = p.headline;
    candidates[`benefit${i + 1}body`] = p.body;
  });

  const data = {};
  for (const field of fields || []) {
    if (field.type !== 'text') continue; // images and charts are not ours to fill
    const value = candidates[norm(field.name)];
    if (value) data[field.name] = { type: 'text', text: String(value) };
  }
  return data;
}

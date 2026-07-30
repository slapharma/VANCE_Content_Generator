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
  // An autofill job lives at /v1/autofills/{id}, NOT /v1/exports/{id}. Polling
  // an autofill job through the export slug returns 403 permission_denied
  // ("Not allowed to access export job") — the ids are not interchangeable even
  // though the two jobs have the same response shape.
  autofillResult:  'CANVA_RETRIEVE_DESIGN_AUTOFILL_JOB_STATUS',
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

/**
 * The naming convention that decides which Canva designs AND brand templates
 * this app will offer.
 *
 * The house decks live in a "Vance-Social Media Kit" folder in Canva, but a
 * folder cannot be the filter here: Canva's folder-items endpoint is not exposed
 * by Composio (only create-folder is), so the app has no way to ask "what is in
 * that folder". Prefixing the titles is the one control that works through the
 * API we actually have, and it has the useful property that renaming a design is
 * enough to publish or retire it — no deploy, no allowlist to maintain.
 *
 * Brand templates are the primary repository: a template only exists because
 * someone deliberately published it, so the list is small and intentional. The
 * prefix filter still applies so an unrelated template someone publishes for
 * another purpose does not appear in the campaign picker.
 */
export const DESIGN_PREFIX = 'Vance Carousel - ';

/**
 * The designs an operator may build a campaign from.
 *
 * Filtered twice on purpose. The prefix goes to Canva as the search term so the
 * paging is done server-side and a page cannot come back empty just because its
 * 50 rows happened to be other people's work; the `startsWith` afterwards is
 * because that search is fuzzy and matches content as well as titles. An
 * explicit `query` from the caller overrides the convention, so the picker can
 * still search everything when someone needs a one-off design.
 */
export async function listDesigns({ query = '', continuation = null } = {}) {
  const searching = Boolean(query);
  const args = searching
    ? { ownership: 'any', query, sort_by: 'relevance' }
    : { ownership: 'any', query: DESIGN_PREFIX.trim(), sort_by: 'relevance' };
  if (continuation) args.continuation = continuation;
  const out = body(await call(SLUGS.listDesigns, args));
  const rows = (out?.items || [])
    .filter((d) => searching || String(d.title || '').startsWith(DESIGN_PREFIX));
  return {
    items: rows.map((d) => ({
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
  // Filtered twice, same reasoning as listDesigns: the prefix goes to Canva as
  // the search term so paging happens server-side, and the `startsWith` re-check
  // covers the search being fuzzy. An explicit `query` overrides the convention.
  //
  // `non_empty` filters to templates that actually declare data fields — a brand
  // template with no fields cannot be autofilled, so offering it would only
  // produce a confusing failure later.
  const searching = Boolean(query);
  const args = {
    ownership: 'any',
    dataset: 'non_empty',
    query: searching ? query : DESIGN_PREFIX.trim(),
  };
  if (continuation) args.continuation = continuation;
  const out = body(await call(SLUGS.listTemplates, args));
  return {
    items: (out?.items || [])
      .filter((t) => searching || String(t.title || '').startsWith(DESIGN_PREFIX))
      .map((t) => ({
      id: t.id,
      title: t.title || 'Untitled',
      thumbnail: t.thumbnail?.url || null,
      updatedAt: t.updated_at ? new Date(t.updated_at * 1000).toISOString() : null,
      // Canva's brand-template LIST endpoint does NOT include the dataset —
      // only id/title/thumbnail/urls come back, whatever the `dataset` filter
      // above selects on — and Composio exposes no equivalent of Canva's
      // /v1/brand-templates/{id}/dataset. So this is very often empty even for
      // a template that declares fields, and callers must read an empty list as
      // "unknown", never as "this template has no fields". buildAutofillData
      // handles that case explicitly.
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

  // Same response shape as an export job, but a different endpoint — see the
  // note on SLUGS.autofillResult.
  const job = await pollJob(
    async () => body(await call(SLUGS.autofillResult, { jobId }))?.job,
    'autofill',
  );
  const designId = job?.result?.design?.id || job?.design?.id;
  if (!designId) throw new Error('Canva autofill finished but returned no design id');
  return designId;
}

/**
 * Turn a generated spec into an autofill payload for a template's fields.
 *
 * Two modes, because we cannot always find out what a template declares:
 *
 *   fields known   — match by name, case-insensitively and ignoring separators,
 *                    so "Hook Title", "hook_title" and "hooktitle" all receive
 *                    the headline. Only 'text' fields are filled; images and
 *                    charts are not ours to supply.
 *   fields unknown — send every name we hold, in its canonical spelling. See
 *                    listBrandTemplates: Canva's list endpoint omits the
 *                    dataset, so an empty `fields` means "could not find out".
 *                    Canva's autofill IGNORES keys the template does not
 *                    declare rather than rejecting the job (verified against a
 *                    live 14-field template by sending a deliberately bogus
 *                    key), so shotgunning is safe and is the only thing that
 *                    makes the picker usable without a dataset endpoint.
 *
 * Either way, a field the spec has nothing for is omitted rather than sent
 * empty, which would blank it in the design.
 *
 * @param {object} spec
 * @param {Array<{name: string, type: string}>} [fields]
 * @returns {object} the `data` object CANVA_INITIATE_CANVA_DESIGN_AUTOFILL_JOB wants
 */
export function buildAutofillData(spec, fields) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // Canonical spelling → value. The aliases are listed in the spelling a
  // hand-built template would plausibly use, because in the unknown-fields case
  // these keys are sent verbatim and Canva matches them exactly.
  const values = new Map();
  const put = (names, value) => {
    if (value == null || value === '') return;
    for (const name of names) values.set(name, String(value));
  };

  put(['eyebrow'], spec?.eyebrow);
  put(['hookTitle', 'title', 'headline'], spec?.hookTitle);
  put(['brief', 'body', 'intro'], spec?.brief?.body);
  put(['update', 'close', 'closing'], spec?.update?.body);
  put(['cta', 'ctaLabel'], spec?.cta?.label);
  put(['domain'], spec?.cta?.domain);
  // Point slides are addressed positionally: point1 / point1body, point2, …
  (spec?.points || []).forEach((p, i) => {
    const n = i + 1;
    put([`point${n}`, `point${n}headline`, `benefit${n}`], p.headline);
    put([`point${n}body`, `benefit${n}body`], p.body);
  });

  const declared = (fields || []).filter((f) => (f?.type || 'text') === 'text');

  if (!declared.length) {
    const data = {};
    for (const [name, text] of values) data[name] = { type: 'text', text };
    return data;
  }

  const byNorm = new Map([...values].map(([name, text]) => [norm(name), text]));
  const data = {};
  for (const field of declared) {
    const value = byNorm.get(norm(field.name));
    if (value) data[field.name] = { type: 'text', text: value };
  }
  return data;
}

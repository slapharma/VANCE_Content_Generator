// lib/social/handlers/promos.js
//
// HTTP surface for Promotional Carousel campaigns:
//
//   GET    /api/social/promos                  newest-first list
//   POST   /api/social/promos                  create
//   GET    /api/social/promos/:id              one campaign, with its occurrences
//   PATCH  /api/social/promos/:id              edit (re-arms the schedule)
//   DELETE /api/social/promos/:id              delete the campaign (decks survive)
//   POST   /api/social/promos/:id/run          mint an occurrence now
//   POST   /api/social/promos/:id/preview      build + render, save nothing
//   POST   /api/social/promos/:id/pause        pause | resume | end
//   POST   /api/social/promos/:id/csv          upload a CSV of messages + CTAs
//   POST   /api/social/promos/hashtags         suggest hashtags for a brief
//
//   GET    /api/social/promo-prompts           the saved prompt library
//   POST   /api/social/promo-prompts           create or update a preset
//   DELETE /api/social/promo-prompts/:id       remove a preset
//
// Preview is the one route that does real work without persisting anything: it
// renders in memory and returns base64 slides, so an operator can iterate on a
// brief without leaving a trail of half-built decks and orphaned WP media.

import {
  buildPromo, savePromo, getPromo, listPromos, deletePromo, refreshNextRun,
  listPromptPresets, savePromptPreset, deletePromptPreset,
} from '../promo-store.js';
import { PROMO_STATUS, parsePromoCsv, nextOccurrence } from '../promo-schema.js';
import { runPromoOccurrence } from '../promo-run.js';
import { suggestHashtags } from '../promo-spec.js';
import { getCarousel } from '../carousel-store.js';

const notFound = (res, id) => res.status(404).json({ error: `No campaign ${id}` });

// ── /api/social/promos ───────────────────────────────────────────────────────

async function indexPromos(req, res) {
  const limit = Math.min(Number(req.query?.limit) || 50, 200);
  return res.status(200).json(await listPromos({ limit }));
}

async function createPromo(req, res) {
  const promo = buildPromo(req.body || {});
  // Arm the clock at creation so a campaign saved straight to `active` fires on
  // its first due slot rather than waiting for an edit to populate nextRunAt.
  const armed = { ...promo, nextRunAt: nextOccurrence(promo) };
  const saved = await savePromo(armed, { indexIt: true });
  return res.status(201).json(saved);
}

async function readPromo(req, res, id) {
  const promo = await getPromo(id);
  if (!promo) return notFound(res, id);

  // Hydrate the occurrence list so the campaign card can show each deck's real
  // status rather than just "one happened at 09:00".
  const occurrences = await Promise.all(
    (promo.occurrences || []).slice(0, 20).map(async (o) => {
      const deck = await getCarousel(o.carouselId);
      return {
        ...o,
        status: deck?.status ?? 'missing',
        slideCount: deck?.slides?.length ?? 0,
        postedAt: deck?.postedAt ?? null,
        error: deck?.error ?? null,
      };
    }),
  );
  return res.status(200).json({ ...promo, occurrences });
}

async function patchPromo(req, res, id) {
  const existing = await getPromo(id);
  if (!existing) return notFound(res, id);
  const updated = buildPromo(req.body || {}, existing);
  // Any edit can move the next slot — a changed time, weekday, or a resume from
  // paused — so the clock is always recomputed rather than trusted.
  const saved = await refreshNextRun(updated);
  return res.status(200).json(saved);
}

async function removePromo(req, res, id) {
  const ok = await deletePromo(id);
  if (!ok) return notFound(res, id);
  // The decks this campaign produced are deliberately left alone: they are
  // published (or publishable) artefacts in their own right, and deleting a
  // campaign should not retract things already posted to Instagram.
  return res.status(200).json({ id, deleted: true, note: 'Existing carousels were kept' });
}

// ── actions ──────────────────────────────────────────────────────────────────

async function runNow(req, res, id) {
  const promo = await getPromo(id);
  if (!promo) return notFound(res, id);
  const result = await runPromoOccurrence(promo);
  if (!result.ok) return res.status(502).json({ error: result.error });
  return res.status(201).json({
    carouselId: result.carousel.id,
    status: result.carousel.status,
    slides: result.carousel.slides?.length ?? 0,
    schedule: result.schedule,
  });
}

async function preview(req, res, id) {
  // Preview accepts an unsaved campaign in the body so the builder can render
  // edits that have not been committed yet. Falls back to the stored record.
  const stored = id ? await getPromo(id) : null;
  if (id && !stored) return notFound(res, id);
  const promo = buildPromo(req.body?.promo || {}, stored);

  const result = await runPromoOccurrence(promo, { dryRun: true });
  if (!result.ok) return res.status(422).json({ error: result.error });
  return res.status(200).json(result.preview);
}

async function setStatus(req, res, id) {
  const promo = await getPromo(id);
  if (!promo) return notFound(res, id);

  const wanted = String(req.body?.status || '').trim();
  if (!Object.values(PROMO_STATUS).includes(wanted)) {
    return res.status(400).json({ error: `status must be one of ${Object.values(PROMO_STATUS).join(', ')}` });
  }
  // Re-arming on resume matters: a campaign paused for three weeks has a
  // nextRunAt three weeks in the past, which would fire immediately and then
  // again on the real slot.
  const saved = await refreshNextRun({ ...promo, status: wanted });
  return res.status(200).json(saved);
}

async function uploadCsv(req, res, id) {
  const promo = await getPromo(id);
  if (!promo) return notFound(res, id);

  const rows = parsePromoCsv(req.body?.csv || '');
  if (!rows.length) {
    return res.status(400).json({
      error: 'No usable rows found. Expected a CSV with a message in the first column and an optional call to action in the second.',
    });
  }
  // Loading a new script restarts it: continuing from row 7 of a file that no
  // longer has those rows is never what an operator means.
  const saved = await savePromo({ ...promo, csvRows: rows, csvCursor: 0, messagingMode: 'csv' });
  return res.status(200).json({ ...saved, rowsLoaded: rows.length });
}

async function hashtags(req, res) {
  const tags = await suggestHashtags({
    prompt: req.body?.prompt || '',
    topic: req.body?.topic || '',
    name: req.body?.name || '',
  });
  return res.status(200).json({ hashtags: tags });
}

// ── prompt library ───────────────────────────────────────────────────────────

async function promptLibrary(req, res, id) {
  if (req.method === 'GET') return res.status(200).json(await listPromptPresets());
  if (req.method === 'POST') return res.status(200).json(await savePromptPreset(req.body || {}));
  if (req.method === 'DELETE') {
    const ok = await deletePromptPreset(id);
    return res.status(ok ? 200 : 404).json(ok ? { id, deleted: true } : { error: `No preset ${id}` });
  }
  return res.status(405).end();
}

// ── router ───────────────────────────────────────────────────────────────────

export default async function handler(req, res, { resource, id, action } = {}) {
  if (resource === 'promo-prompts') return promptLibrary(req, res, id);

  // Collection-level POSTs, matched before the :id routes so they are not read
  // as a campaign whose id happens to be "hashtags" or "preview". Campaign ids
  // are always `promo_<timestamp>`, so there is no real collision.
  if (req.method === 'POST' && id === 'hashtags') return hashtags(req, res);
  // Preview before a campaign has ever been saved — the builder's first render.
  if (req.method === 'POST' && id === 'preview') return preview(req, res, null);

  if (!id) {
    if (req.method === 'GET') return indexPromos(req, res);
    if (req.method === 'POST') return createPromo(req, res);
    return res.status(405).end();
  }

  if (action) {
    if (req.method !== 'POST') return res.status(405).end();
    if (action === 'run')     return runNow(req, res, id);
    if (action === 'preview') return preview(req, res, id);
    if (action === 'status')  return setStatus(req, res, id);
    if (action === 'csv')     return uploadCsv(req, res, id);
    return res.status(404).json({ error: `Unknown action "${action}"` });
  }

  if (req.method === 'GET')    return readPromo(req, res, id);
  if (req.method === 'PATCH')  return patchPromo(req, res, id);
  if (req.method === 'DELETE') return removePromo(req, res, id);
  return res.status(405).end();
}

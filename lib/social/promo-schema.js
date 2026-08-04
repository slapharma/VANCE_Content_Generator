// lib/social/promo-schema.js
//
// Shape, validation and recurrence maths for a Promotional Carousel campaign.
//
// A promo campaign is a *recipe plus a clock*. It is not itself a carousel: each
// time the schedule comes due, the campaign mints one carousel record — an
// "occurrence" — which from that point on is an ordinary deck and travels the
// existing render → host → applyPostMode → social:queue path unchanged.
//
// That separation is deliberate. A carousel is one immutable published artefact
// with one status; a campaign is a long-lived thing you pause, edit and resume.
// Trying to make one record do both would mean a deck whose status went backwards
// from `posted` to `scheduled` every week.
//
// All times are UTC, matching lib/social/scheduler.js. The scheduler's header
// calls its slots "local time" but does the arithmetic in UTC; rather than
// inherit that ambiguity this module says UTC and means it.

import { PROMO_STYLE } from './carousel-theme.js';
import { normaliseHashtags } from './carousel-text.js';

/** Campaign lifecycle. `draft` never fires; `ended` is terminal. */
export const PROMO_STATUS = {
  draft:  'draft',
  active: 'active',
  paused: 'paused',
  ended:  'ended',
};

/** How each occurrence's copy is decided. See lib/social/promo-spec.js. */
export const MESSAGING_MODES = ['repeat', 'csv', 'topic'];

export const FREQUENCIES = ['once', 'daily', 'weekly', 'monthly'];

/** Same four fixed slides as an article deck (cover, brief, close, CTA), so the
 *  6..10 range maps to the same 2..6 points and the UI control is identical. */
export const PROMO_FIXED_SLIDES = 4;
export const DEFAULT_PROMO_SLIDES = 8;

/** Post modes are shared with article carousels — same enum, same meaning. */
export const PROMO_POST_MODES = ['approval', 'immediate', 'delay', 'optimal'];

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

const str = (v, max = 400) => String(v ?? '').trim().slice(0, max);

/** 'HH:MM', 24h, UTC. Anything unparseable falls back to 09:00. */
export function normaliseTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return '09:00';
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const min = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Build a validated campaign record.
 *
 * Every field is normalised rather than rejected where a sane default exists —
 * the same idiom rule-schema.js uses, and for the same reason: a campaign edited
 * by a UI that predates a new field must not become unloadable.
 */
export function buildPromo(data = {}, existing = null) {
  const now = new Date().toISOString();
  const sched = data.schedule || existing?.schedule || {};
  const frequency = FREQUENCIES.includes(sched.frequency) ? sched.frequency : 'weekly';

  return {
    id: existing?.id || `promo_${Date.now()}`,
    name: str(data.name ?? existing?.name ?? '', 120) || 'Untitled campaign',
    status: Object.values(PROMO_STATUS).includes(data.status ?? existing?.status)
      ? (data.status ?? existing.status)
      : PROMO_STATUS.draft,

    // ── content recipe ──────────────────────────────────────────────────
    // Where the slide artwork comes from:
    //   'vance'          — rendered here from a design template (the default)
    //   'canva-design'   — the pages of an existing Canva design, exported as-is
    //   'canva-template' — a Canva brand template, autofilled with generated copy
    // See lib/social/canva.js for what each path needs.
    renderer: ['vance', 'canva-design', 'canva-template'].includes(data.renderer ?? existing?.renderer)
      ? (data.renderer ?? existing.renderer)
      : 'vance',
    canvaDesignId: data.canvaDesignId ?? existing?.canvaDesignId ?? null,
    canvaDesignTitle: str(data.canvaDesignTitle ?? existing?.canvaDesignTitle ?? '', 200),
    canvaBrandTemplateId: data.canvaBrandTemplateId ?? existing?.canvaBrandTemplateId ?? null,
    canvaBrandTemplateTitle: str(data.canvaBrandTemplateTitle ?? existing?.canvaBrandTemplateTitle ?? '', 200),
    // Field descriptors captured when the template was picked, so an autofill can
    // be built without re-listing templates on every occurrence.
    canvaFields: Array.isArray(data.canvaFields) ? data.canvaFields.slice(0, 60)
      : (existing?.canvaFields ?? []),

    // Which design template this campaign's decks render in. A built-in id is a
    // style name ('education', 'promotional', …); a custom one is `tpl_*`.
    // Resolved to a base style + theme override at mint time by
    // resolveTemplateForDeck, not stored resolved — editing a template should
    // affect the campaigns using it from their next occurrence onwards.
    templateId: data.templateId ?? existing?.templateId ?? PROMO_STYLE,
    promptPresetId: data.promptPresetId ?? existing?.promptPresetId ?? null,
    // The resolved prompt text. Stored on the campaign, not looked up from the
    // preset at run time: editing a preset must not silently rewrite the copy of
    // every live campaign that once used it.
    prompt: str(data.prompt ?? existing?.prompt ?? '', 6000),
    style: PROMO_STYLE,
    // 1..10. One slide is a single image post rather than a carousel — Instagram
    // has no one-child carousel — and 2..4 drop the point slides, keeping the
    // cover, the CTA and as much of the arc as fits (see planSlides).
    slideCount: clampInt(data.slideCount ?? existing?.slideCount, 1, 10, DEFAULT_PROMO_SLIDES),
    coverImageUrl: data.coverImageUrl ?? existing?.coverImageUrl ?? null,
    coverSource: data.coverSource ?? existing?.coverSource ?? null,   // 'upload' | 'generated' | 'stock'
    // Attribution for a stock cover, carried onto the deck so it can be stamped
    // onto the uploaded WP media exactly as article heroes are. Null for uploads
    // and AI images, which have no photographer to credit.
    coverCredit: data.coverCredit ?? existing?.coverCredit ?? null,
    coverPrompt: str(data.coverPrompt ?? existing?.coverPrompt ?? '', 1000),
    categoryLabel: str(data.categoryLabel ?? existing?.categoryLabel ?? '', 40) || 'Vance',
    hashtags: normaliseHashtags(data.hashtags ?? existing?.hashtags ?? []),
    ctaLabel: str(data.ctaLabel ?? existing?.ctaLabel ?? '', 40),
    ctaNote: str(data.ctaNote ?? existing?.ctaNote ?? '', 120),
    ctaDomain: str(data.ctaDomain ?? existing?.ctaDomain ?? '', 120),

    // ── per-occurrence variation ────────────────────────────────────────
    messagingMode: MESSAGING_MODES.includes(data.messagingMode ?? existing?.messagingMode)
      ? (data.messagingMode ?? existing.messagingMode)
      : 'repeat',
    topic: str(data.topic ?? existing?.topic ?? '', 500),
    csvRows: Array.isArray(data.csvRows) ? data.csvRows.slice(0, 500)
      : (existing?.csvRows ?? []),
    csvCursor: clampInt(data.csvCursor ?? existing?.csvCursor ?? 0, 0, 100000, 0),
    // When the rows run out: wrap back to row 0, or end the campaign.
    csvWrap: data.csvWrap ?? existing?.csvWrap ?? false,

    // ── posting ─────────────────────────────────────────────────────────
    accountId: data.accountId ?? existing?.accountId ?? null,
    postMode: PROMO_POST_MODES.includes(data.postMode ?? existing?.postMode)
      ? (data.postMode ?? existing.postMode)
      : 'approval',
    delayHours: clampInt(data.delayHours ?? existing?.delayHours, 1, 168, 24),

    // ── schedule ────────────────────────────────────────────────────────
    schedule: {
      frequency,
      // weekly: ISO weekdays 1..7 (Mon..Sun). monthly: days of month 1..28,
      // capped at 28 so a campaign can never skip February.
      days: normaliseDays(sched.days, frequency),
      time: normaliseTime(sched.time),
      startAt: sched.startAt || existing?.schedule?.startAt || now,
      endAt: sched.endAt || null,
      occurrenceLimit: sched.occurrenceLimit ? clampInt(sched.occurrenceLimit, 1, 500, null) : null,
    },

    // ── run state ───────────────────────────────────────────────────────
    lastRunAt: existing?.lastRunAt ?? null,
    nextRunAt: existing?.nextRunAt ?? null,
    occurrenceCount: existing?.occurrenceCount ?? 0,
    // Newest-first, capped: the full history is reconstructable from the
    // carousels themselves via promoId, this is just for the campaign card.
    occurrences: (existing?.occurrences ?? []).slice(0, 50),
    lastError: existing?.lastError ?? null,

    createdAt: existing?.createdAt || now,
    updatedAt: now,
    createdBy: existing?.createdBy || str(data.createdBy ?? 'user', 60),
  };
}

function normaliseDays(days, frequency) {
  const list = Array.isArray(days) ? days.map(Number).filter(Number.isFinite) : [];
  if (frequency === 'weekly') {
    const out = [...new Set(list.filter((d) => d >= 1 && d <= 7))].sort((a, b) => a - b);
    return out.length ? out : [2]; // default Tuesday
  }
  if (frequency === 'monthly') {
    const out = [...new Set(list.filter((d) => d >= 1 && d <= 28))].sort((a, b) => a - b);
    return out.length ? out : [1];
  }
  return [];
}

/** Re-exported so callers of this schema module do not need to know that the
 *  implementation is shared with the article path. */
export { normaliseHashtags as normaliseTagList };

/**
 * When does this campaign next fire, strictly after `after`?
 *
 * Walks forward day by day (max 400 days, which covers a monthly campaign whose
 * only day-of-month has just passed) rather than doing modular arithmetic per
 * frequency — the walk is trivially correct across month lengths and year
 * boundaries, and 400 iterations of a date comparison costs nothing next to the
 * KV round-trip that follows it.
 *
 * @param {object} promo
 * @param {Date} [after] - defaults to now
 * @returns {string|null} ISO timestamp, or null if the campaign is finished
 */
export function nextOccurrence(promo, after = new Date()) {
  const s = promo?.schedule;
  if (!s) return null;
  if (promo.status === PROMO_STATUS.ended) return null;
  if (s.occurrenceLimit && (promo.occurrenceCount || 0) >= s.occurrenceLimit) return null;

  const [hh, mm] = normaliseTime(s.time).split(':').map(Number);
  const start = new Date(s.startAt || Date.now());
  const end = s.endAt ? new Date(s.endAt) : null;
  // Never fire before the campaign starts, and never re-fire a slot already used.
  const floor = new Date(Math.max(after.getTime(), start.getTime()));

  if (s.frequency === 'once') {
    const at = new Date(Date.UTC(
      start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), hh, mm, 0, 0,
    ));
    if (at.getTime() <= after.getTime()) return null;
    if (end && at > end) return null;
    return at.toISOString();
  }

  const cursor = new Date(Date.UTC(
    floor.getUTCFullYear(), floor.getUTCMonth(), floor.getUTCDate(), hh, mm, 0, 0,
  ));

  for (let i = 0; i < 400; i++) {
    if (cursor.getTime() > floor.getTime() || (i === 0 && cursor.getTime() > after.getTime())) {
      if (end && cursor > end) return null;
      if (matchesDay(cursor, s)) return cursor.toISOString();
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return null;
}

function matchesDay(date, schedule) {
  if (schedule.frequency === 'daily') return true;
  if (schedule.frequency === 'weekly') {
    const iso = date.getUTCDay() === 0 ? 7 : date.getUTCDay(); // Sun 0 → 7
    return schedule.days.includes(iso);
  }
  if (schedule.frequency === 'monthly') return schedule.days.includes(date.getUTCDate());
  return false;
}

/** Is this campaign due to mint an occurrence right now? */
export function isDue(promo, now = new Date()) {
  if (promo?.status !== PROMO_STATUS.active) return false;
  if (!promo.nextRunAt) return false;
  if (promo.schedule?.occurrenceLimit
      && (promo.occurrenceCount || 0) >= promo.schedule.occurrenceLimit) return false;
  return new Date(promo.nextRunAt).getTime() <= now.getTime();
}

/** Human summary for the campaign card — "Weekly on Mon, Wed at 09:00 UTC". */
export function describeSchedule(schedule) {
  if (!schedule) return '—';
  const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const at = `at ${normaliseTime(schedule.time)} UTC`;
  if (schedule.frequency === 'once')    return `Once ${at}`;
  if (schedule.frequency === 'daily')   return `Daily ${at}`;
  if (schedule.frequency === 'weekly')  return `Weekly on ${schedule.days.map((d) => DAY[d]).join(', ')} ${at}`;
  if (schedule.frequency === 'monthly') return `Monthly on day ${schedule.days.join(', ')} ${at}`;
  return '—';
}

/**
 * Column names that identify row 1 as a header rather than data.
 *
 * Only the FIRST cell is tested against this list. That keeps the rule something
 * an operator can hold in their head ("start the file with a recognised column
 * name and the header is honoured") instead of a heuristic that guesses, and it
 * preserves the original behaviour for the two-column files that predate headers.
 */
const CSV_HEADERS = [
  'message', 'text', 'copy',
  'headline', 'hooktitle', 'title', 'eyebrow',
  'subhead', 'subheading', 'subtitle', 'brief',
  'cta', 'ctalabel', 'domain',
];

const csvKey = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Parse a pasted/uploaded CSV into `{ message, cta, fields }` rows.
 *
 * Hand-rolled rather than pulled from a dependency because the input is a few
 * columns of prose: the only thing a library would buy us is quoted-field
 * handling, which is ~15 lines. Handles quoted fields containing commas,
 * doubled quotes as an escape, and CRLF.
 *
 * Two shapes, and which one you get is decided by the first cell:
 *
 *   headerless — column 1 the message, column 2 the call to action. The original
 *                contract, untouched, so every CSV already uploaded still parses
 *                to the same rows it did before.
 *   headed     — column names become field names, and `fields` carries them
 *                verbatim. This is what lets a CSV drive a Canva template's own
 *                fields (headline, subhead, domain and anything else the
 *                template declares) rather than only steering the model. See
 *                applyCsvFields in promo-spec.js for where they land.
 *
 * `message` is kept in both shapes because it is what the model is briefed with;
 * under a header it falls back to the headline, that being the next best
 * statement of what the occurrence is about.
 */
export function parsePromoCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  const src = String(text || '').replace(/\r\n?/g, '\n');

  const endField = () => { record.push(field); field = ''; };
  const endRecord = () => {
    endField();
    if (record.some((c) => c.trim())) rows.push(record);
    record = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') endField();
    else if (ch === '\n') endRecord();
    else field += ch;
  }
  if (field || record.length) endRecord();

  if (!rows.length) return [];

  const header = CSV_HEADERS.includes(csvKey(rows[0][0])) ? rows[0] : null;
  const body = header ? rows.slice(1) : rows;

  if (!header) {
    return body
      .map((r) => ({ message: str(r[0], 600), cta: str(r[1], 120), fields: {} }))
      .filter((r) => r.message);
  }

  const names = header.map((h) => str(h, 60));
  // First column whose name matches any of `wanted`, by normalised spelling.
  const column = (row, wanted) => {
    const i = names.findIndex((n) => wanted.includes(csvKey(n)));
    return i === -1 ? '' : str(row[i], 600);
  };

  return body.map((row) => {
    // Names are kept exactly as the operator typed them: matching downstream
    // ignores case and separators anyway, and a template field spelled
    // "Sub Head" should reach Canva looking like the operator's own file.
    const fields = {};
    names.forEach((name, i) => {
      const value = str(row[i], 600);
      if (name && value) fields[name] = value;
    });
    return {
      message: column(row, ['message', 'text', 'copy'])
        || column(row, ['headline', 'hooktitle', 'title']),
      cta: column(row, ['cta', 'ctalabel']).slice(0, 120),
      fields,
    };
    // A row counts as usable if it says anything at all. Under a header the
    // message column is optional: a file of pure field values is a legitimate
    // script when the campaign brief already supplies the context.
  }).filter((r) => r.message || Object.keys(r.fields).length);
}

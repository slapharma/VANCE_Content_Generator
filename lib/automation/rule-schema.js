// lib/automation/rule-schema.js
import { randomUUID } from 'crypto';
// Re-exported so existing importers of CAROUSEL_STYLES from this file keep
// working — lib/social/carousel-spec.js is the canonical source (it's also
// where the per-style prompt builders live, so a new style only needs
// updating there and in carousel-render.js, not here too).
import { CAROUSEL_STYLES } from '../social/carousel-spec.js';
export { CAROUSEL_STYLES };

/** Valid values for generation.carouselPostMode — see the field for semantics. */
export const CAROUSEL_POST_MODES = ['approval', 'immediate', 'delay', 'optimal'];

export function buildRule(data) {
  validateRule(data);
  const now = new Date().toISOString();
  return {
    id: `rule_${randomUUID()}`,
    name: data.name,
    enabled: Boolean(data.enabled ?? true),
    category: data.category,
    wpCategorySlug: data.wpCategorySlug ?? null,

    sources: (data.sources ?? []).map(src => {
      if (src.type === 'bibliography') {
        return {
          ...src,
          bibId: src.bibId ?? '',
          mode:  src.mode ?? 'daily',
        };
      }
      if (src.type === 'google_sheets') {
        return {
          ...src,
          sheetId:       src.sheetId ?? '',
          sheetName:     src.sheetName ?? 'Sheet1',
          urlColumn:     src.urlColumn ?? '',
          notesColumn:   src.notesColumn ?? '',
          wpLinkColumn:  src.wpLinkColumn ?? '',
        };
      }
      if (src.type === 'upload') {
        // Per-row structured records from the multi-column spreadsheet
        // (Title / Notes / Sub-Category / Tag). Each entry shape:
        //   { title, notes, subCategory, tags }
        // Optional — legacy uploads with only Column A populate urls/titlesOnly
        // and leave rows empty. New uploads populate rows AND mirror titles
        // into titlesOnly for backward compat with the old fetch path.
        const rows = Array.isArray(src.rows)
          ? src.rows
              .filter(r => r && typeof r === 'object' && (r.title || '').trim())
              .map(r => ({
                title:       String(r.title || '').trim(),
                notes:       r.notes != null ? String(r.notes).trim() : '',
                subCategory: r.subCategory != null ? String(r.subCategory).trim() : '',
                tags:        Array.isArray(r.tags)
                  ? r.tags.map(t => String(t || '').trim()).filter(Boolean)
                  : (r.tags ? String(r.tags).trim() : ''),
              }))
          : [];

        return {
          ...src,
          urls: Array.isArray(src.urls) ? src.urls.filter(Boolean) : [],
          titlesOnly: Array.isArray(src.titlesOnly) ? src.titlesOnly.filter(Boolean) : [],
          rows,
          // Rows already generated from. fetchUploadUrls skips these on subsequent runs;
          // run.js appends to them after each successful content store. User can clear
          // either array to re-process rows.
          consumedUrls: Array.isArray(src.consumedUrls) ? src.consumedUrls.filter(Boolean) : [],
          consumedTitles: Array.isArray(src.consumedTitles) ? src.consumedTitles.filter(Boolean) : [],
          originalFilename: src.originalFilename ?? src.url ?? '',
        };
      }
      if (src.type === 'google_drive') {
        return {
          ...src,
          folderId: src.folderId ?? '',
          // File ids already generated from. fetchGoogleDrive skips these on
          // subsequent runs; run.js appends to them after each successful content
          // store. Clear this array to re-process a folder's files.
          consumedFileIds: Array.isArray(src.consumedFileIds) ? src.consumedFileIds.filter(Boolean) : [],
        };
      }
      if (src.type === 'gmail') {
        return {
          ...src,
          from: src.from ?? '',
          subjectContains: src.subjectContains ?? '',
          labelIds: src.labelIds?.length ? src.labelIds : ['INBOX'],
          maxResults: Math.min(src.maxResults ?? 5, 20),
        };
      }
      return src;
    }),

    trigger: {
      type: data.trigger?.type ?? 'schedule',
      cron: data.trigger?.cron ?? '0 7 * * 1',
      eventType: data.trigger?.eventType ?? null,
      volumeThreshold: data.trigger?.volumeThreshold ?? null,
      minGapHours: data.trigger?.minGapHours ?? 4,
    },

    generation: {
      // Template is a metadata label only — prompt selection is driven by
      // rule.category in run.js. Force them aligned so the UI never persists
      // a mismatched pair that confuses operators reading the pipeline.
      template: data.category ?? data.generation?.template ?? 'standard',
      maxArticlesPerRun: data.generation?.maxArticlesPerRun ?? 3,
      prompt: data.generation?.prompt ?? '',
      // Name of the selected prompt preset ('' for category default). run.js maps
      // this to a WP sub-category (patient/practitioner) for clinical reviews —
      // but only as a fallback; see subCategory below, which takes priority.
      promptName: data.generation?.promptName ?? '',
      // Explicit WP sub-category override ('' = derive from promptName via the
      // legacy heuristic). Decoupled from the prompt preset's display name so
      // renaming a preset can never silently break WP taxonomy routing again
      // (see docs/learnings-from-alpha.md 2026-06-03 / this fix's incident).
      subCategory: data.generation?.subCategory ?? '',
      combineMode: data.generation?.combineMode ?? 'one-per-item',
      model:       data.generation?.model       ?? null,
      heroImage:   data.generation?.heroImage   ?? true,
      heroImageFallbackUrl: data.generation?.heroImageFallbackUrl ?? null,
      // Auto-build an 8-slide Instagram Article Carousel from each article this
      // rule produces, using its hero image as the cover. Defaults to OFF —
      // unlike heroImage's default-true — so enabling the feature never
      // retroactively starts producing social posts for rules that existed
      // before it.
      //
      // The deck is built when the article reaches WordPress, not when it is
      // generated (lib/social/carousel-on-publish.js, called from api/publish).
      // Two consequences worth knowing: edits made during review are always
      // reflected in the slides, and a rule with publish.wordpress off never
      // produces a carousel at all.
      articleCarousel: data.generation?.articleCarousel ?? false,
      // Total slides including the four fixed ones (cover, why-it-matters,
      // evidence, CTA); the remainder are key points. Instagram's Graph API caps
      // a carousel at 10 children, so the range is clamped to 6..10.
      carouselSlideCount: Math.min(10, Math.max(6, data.generation?.carouselSlideCount ?? 8)),
      // When the finished carousel posts to Instagram:
      //   'approval'  — never automatically; waits for a human in Social ▸ Carousels
      //   'immediate' — as soon as the article is live
      //   'delay'     — carouselDelayHours after the article is live
      //   'optimal'   — the next optimal Instagram slot (autoSchedule: Mon/Wed/Fri
      //                 at 07:00, 12:00 or 19:00 UTC)
      //
      // Every non-'approval' mode is anchored to the article going LIVE, not to
      // generation, so a carousel can never post while its "read the full
      // article" CTA still points at an unpublished post. Since the deck is now
      // built from the WordPress publish itself, that anchor is simply the moment
      // it is built — there is no window in which an unanchored deck exists.
      //
      // Defaults to 'approval' — this publishes publicly, so opting into
      // hands-off posting should be a deliberate choice, not inherited.
      carouselPostMode: CAROUSEL_POST_MODES.includes(data.generation?.carouselPostMode)
        ? data.generation.carouselPostMode
        : 'approval',
      // Only meaningful for 'delay'. Capped at a week; the queue is drained hourly
      // so anything finer than an hour is not honoured.
      carouselDelayHours: Math.min(168, Math.max(1, Math.round(data.generation?.carouselDelayHours ?? 24))),
      // Content style: 'education' (teaching arc, cites the source) or
      // 'relatable' (POV/lived-experience arc, never cites). Defaults to
      // 'education' so existing rules keep producing exactly what they always
      // have. See lib/social/carousel-spec.js's two prompt builders.
      carouselStyle: CAROUSEL_STYLES.includes(data.generation?.carouselStyle)
        ? data.generation.carouselStyle
        : 'education',
      // Which Instagram account this rule's carousels post to. null = the
      // platform default (see lib/social/accounts.js resolveAccount()).
      carouselAccountId: data.generation?.carouselAccountId ?? null,
    },

    review: {
      required: data.review?.required ?? true,
      // 'any' — first approval transitions to approved.
      // 'all' — every reviewer in notifications.email.userIds + externalEmails must approve.
      mode: data.review?.mode ?? 'any',
      timeoutHours: data.review?.timeoutHours ?? 48,
      // Default biased toward "hold for human" instead of silently approving.
      // 'urgent_reminder' fires a chaser email and keeps the job pending.
      // Previous default 'approve' silently auto-published any article past the timeout.
      onTimeout: data.review?.onTimeout ?? 'urgent_reminder',
    },

    notifications: {
      telegram: {
        enabled: data.notifications?.telegram?.enabled ?? false,
        chatId: data.notifications?.telegram?.chatId ?? null,
        allowApproval: data.notifications?.telegram?.allowApproval ?? false,
      },
      email: {
        enabled: data.notifications?.email?.enabled ?? false,
        // New: pick from existing users (resolved to emails at send time)
        userIds: Array.isArray(data.notifications?.email?.userIds) ? data.notifications.email.userIds : [],
        // New: additional external emails (e.g. reviewers who aren't app users)
        externalEmails: Array.isArray(data.notifications?.email?.externalEmails)
          ? data.notifications.email.externalEmails
          : (Array.isArray(data.notifications?.email?.to) ? data.notifications.email.to : []),
        // Legacy `to` kept for back-compat readers; computed from the two lists at runtime
        to: data.notifications?.email?.to ?? [],
        allowApproval: data.notifications?.email?.allowApproval ?? false,
      },
    },

    publish: {
      auto: data.publish?.auto ?? true,
      scheduleTime: data.publish?.scheduleTime ?? null,
      wordpress: data.publish?.wordpress ?? true,
    },

    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    stats: { totalRuns: 0, articlesGenerated: 0, articlesPublished: 0 },
  };
}

export function validateRule(data) {
  if (!data.name) throw new Error('name is required');
  if (!data.category) throw new Error('category is required');
  if (!data.sources || data.sources.length === 0) throw new Error('at least one source is required');
  if (!data.trigger?.type || !['schedule', 'event', 'volume'].includes(data.trigger.type)) {
    throw new Error('trigger.type must be schedule, event, or volume');
  }
  if (data.trigger?.type === 'schedule' && !data.trigger?.cron) {
    throw new Error('trigger.cron is required for schedule triggers');
  }
}
// (schema includes generation.promptName + per-source consumed* dedup arrays)

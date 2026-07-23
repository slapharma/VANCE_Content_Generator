// lib/automation/rule-schema.js
import { randomUUID } from 'crypto';

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

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

    sources: data.sources ?? [],

    trigger: {
      type: data.trigger?.type ?? 'schedule',
      cron: data.trigger?.cron ?? '0 7 * * 1',
      eventType: data.trigger?.eventType ?? null,
      volumeThreshold: data.trigger?.volumeThreshold ?? null,
      minGapHours: data.trigger?.minGapHours ?? 4,
    },

    generation: {
      template: data.generation?.template ?? 'standard',
      maxArticlesPerRun: data.generation?.maxArticlesPerRun ?? 3,
      prompt: data.generation?.prompt ?? '',
      combineMode: data.generation?.combineMode ?? 'one-per-item',
    },

    review: {
      required: data.review?.required ?? true,
      mode: data.review?.mode ?? 'any',
      timeoutHours: data.review?.timeoutHours ?? 48,
      onTimeout: data.review?.onTimeout ?? 'approve',
    },

    notifications: {
      telegram: {
        enabled: data.notifications?.telegram?.enabled ?? false,
        chatId: data.notifications?.telegram?.chatId ?? null,
        allowApproval: data.notifications?.telegram?.allowApproval ?? false,
      },
      email: {
        enabled: data.notifications?.email?.enabled ?? false,
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

// lib/automation/job-schema.js
import { randomUUID } from 'crypto';

// Set of job IDs currently in 'pending_review' — the active subset of
// automation:jobs:index (which holds every job ever created and is never
// trimmed). processTimeouts() scans this instead of the full index so its
// daily cost stays proportional to jobs actually awaiting review, not to
// the app's total lifetime job count. Every handler that moves a job's
// status OFF 'pending_review' must kv.srem() it from here; every handler
// that creates a job already IN 'pending_review' must kv.sadd() it.
export const PENDING_JOBS_KEY = 'automation:jobs:pending';

export function validateJob(data) {
  if (!data.ruleId) throw new Error('ruleId is required');
  if (!data.contentId) throw new Error('contentId is required');
}

export function buildJob(data) {
  validateJob(data);
  const now = new Date().toISOString();
  return {
    id: `job_${randomUUID()}`,
    ruleId: data.ruleId,
    contentId: data.contentId,
    status: data.status ?? 'pending_review',
    notifiedAt: data.notifiedAt ?? null,
    approvedAt: null,
    rejectedAt: null,
    approvedBy: null,   // 'telegram' | 'email' | 'timeout' | 'manual'
    // Reviewer aggregation. Populated by run.js after sendNotifications resolves
    // the recipient list. Used by approve handler when rule.review.mode === 'all'
    // to gate the transition to terminal status.
    reviewerIds: Array.isArray(data.reviewerIds) ? data.reviewerIds : [],
    approvals: [],         // reviewerIds who have approved
    rejections: [],        // reviewerIds who have requested changes
    rejectionComments: [], // { reviewerId, comment, at, channel }
    createdAt: now,
    updatedAt: now,
  };
}

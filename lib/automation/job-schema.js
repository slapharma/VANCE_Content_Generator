// lib/automation/job-schema.js
import { randomUUID } from 'crypto';

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

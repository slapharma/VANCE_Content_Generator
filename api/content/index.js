import { kv } from '../../lib/kv.js';
import { randomUUID } from 'crypto';
import { getCurrentUser, requireRole } from '../../lib/auth.js';
import { countBodyWords } from '../../lib/word-count.js';
import { withErrorBoundary } from '../../lib/api.js';
import { markStockUsed, heroAsStockPhoto } from '../../lib/social/stock-ledger.js';

// ── Pure helpers (exported for testing) ─────────────────────────────────────

export function buildContentItem(data) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: data.title,
    body: data.body ?? '',
    excerpt: data.excerpt ?? '',
    category: data.category ?? 'uncategorised',
    template: data.template ?? 'standard',
    model: data.model ?? null,
    status: 'draft',
    sourceId: data.sourceId ?? null,      // links back to archive item id
    heroImageUrl: data.heroImageUrl ?? null,   // stored for WP featured image upload
    heroImageType: data.heroImageType ?? null, // 'pexels' | 'unsplash' | 'ai' | 'upload'
    // Stock-photo attribution { photographer, photographerUrl, photoUrl, provider } —
    // rendered as a credit line in-app and appended to the published WP post
    // (required by the Unsplash API guidelines). Null for AI/uploaded heroes.
    heroImageCredit: data.heroImageCredit ?? null,
    // Provider photo id ('12345' / 'n7a2OJDSZns') for stock heroes. Kept so the
    // one-use-only stock ledger identifies the photo exactly instead of inferring
    // it from the image URL. Null for AI/uploaded heroes.
    heroImagePhotoId: data.heroImagePhotoId ?? null,
    wpCategorySlug: data.wpCategorySlug ?? null, // per-category WP slug override
    // Per-row sub-category name (from the multi-column bulk-upload spreadsheet,
    // e.g. "Lifestyle & Wellbeing"). When set, the publish endpoint resolves it
    // by name/slug and posts to that sub-category instead of the app category's
    // top-level slug — auto-creating the term under the inferred parent if needed.
    subCategory: data.subCategory ?? null,
    // Per-row WP tag list. Accepts a comma-separated string ("IBD, IBS") OR an
    // array. The publish endpoint resolves each tag by name and auto-creates
    // missing tags before posting.
    tags: Array.isArray(data.tags) ? data.tags : (data.tags ?? null),
    // Author-supplied research / writing-style focus for this article (from the
    // spreadsheet's Notes column). Stitched into the LLM prompt at generation
    // time so each article gets per-row guidance on what to emphasise.
    rowNotes: data.rowNotes ?? null,
    // Automation provenance — snapshotted at creation so the rule name shows
    // on cards/emails/logs without a per-render rule lookup. Null for manual.
    automationRuleId: data.automationRuleId ?? null,
    automationRuleName: data.automationRuleName ?? null,
    promptName: data.promptName ?? null,
    // Source-document provenance — the file / URL / sheet row / email this
    // article was generated from. Surfaced in review emails, the review-token
    // landing page, and the in-app article view so reviewers know what was
    // summarised before they vote. Null for ad-hoc content with no traceable source.
    sourceDocName: data.sourceDocName ?? null,
    sourceDocUrl: data.sourceDocUrl ?? null,
    createdAt: now,
    updatedAt: now,
    reviewers: [],
    approvals: [],
    rejections: [],
    requireAllApprovals: data.requireAllApprovals ?? false,
    scheduledAt: null,
    publishedAt: null,
    wpPostId: null,
  };
}

export function validateContentItem(data) {
  if (!data.title) throw new Error('title is required');
  // body is optional — allow empty articles (title-only drafts)
}

// ── HTTP handler ─────────────────────────────────────────────────────────────

async function handler(req, res) {
  // Admin-only diagnostic endpoints stay piggy-backed here — no client callers,
  // invoked manually via curl/Postman, so splitting them gains nothing.
  const action = req.query.action;

  // ── Dashboard review-tasks — per-user filtered slim payload.
  //   GET /api/content?action=review-tasks
  // Replaces a 38 MB+ client-side filter pass through the full content list
  // (everything ever generated, including bodies and rejectionComments) just
  // to compute three counts and a short "your open tasks" list.
  // Auth required: the response is scoped to the signed-in user.
  if (action === 'review-tasks' && req.method === 'GET') {
    const me = await getCurrentUser(req);
    if (!me) return res.status(401).json({ error: 'Not authenticated' });

    const ids = await kv.lrange('content:index', 0, -1);
    if (!ids.length) {
      return res.json({ stats: { totalReviewRequests: 0, approvedByUser: 0, commentsByUser: 0 }, openTasks: [] });
    }
    const items = (await Promise.all(ids.map(id => kv.get(`content:${id}`)))).filter(Boolean);
    const uid = me.id;

    // Same predicates the client used (kept identical so counts match exactly):
    //   - "review item" = uid present in reviewerIds (new picker) OR legacy reviewers[]
    //   - "i approved"  = uid in approvals[]
    //   - "my comments" = count of rejectionComments + priorRejectionComments where reviewerId === uid
    const isMyReviewItem = (it) => {
      const list = (Array.isArray(it.reviewerIds) && it.reviewerIds.length) ? it.reviewerIds : it.reviewers;
      return Array.isArray(list) && list.includes(uid);
    };
    const iApproved = (it) => Array.isArray(it.approvals) && it.approvals.includes(uid);
    const iRejected = (it) => Array.isArray(it.rejections) && it.rejections.includes(uid);

    let totalReviewRequests = 0, approvedByUser = 0, commentsByUser = 0;
    const openTasksRaw = [];
    const receivedRaw = [], approvedRaw = [], commentedRaw = [];
    for (const it of items) {
      if (isMyReviewItem(it)) {
        totalReviewRequests++;
        receivedRaw.push(it);
      }
      if (iApproved(it)) {
        approvedByUser++;
        approvedRaw.push(it);
      }
      const liveMine = (it.rejectionComments || []).filter(c => c.reviewerId === uid);
      const pastMine = (it.priorRejectionComments || []).filter(c => c.reviewerId === uid);
      const myComments = liveMine.length + pastMine.length;
      commentsByUser += myComments;
      if (myComments > 0) {
        const lastAt = [...liveMine, ...pastMine]
          .map(c => c.at).filter(Boolean)
          .sort().slice(-1)[0] || null;
        commentedRaw.push({ ...it, _myLastCommentAt: lastAt, _myCommentCount: myComments });
      }
      if (it.status === 'in_review' && isMyReviewItem(it) && !iApproved(it) && !iRejected(it)) {
        openTasksRaw.push(it);
      }
    }

    // Slim each open task to only what the UI renders. wordCount is the body-prose
    // count (shared with the generation limit) derived server-side so the response
    // doesn't need to carry the body.
    const openTasks = openTasksRaw
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .map(it => ({
        id:              it.id,
        title:           it.title,
        category:        it.category,
        sentForReviewAt: it.sentForReviewAt || null,
        updatedAt:       it.updatedAt || null,
        createdAt:       it.createdAt || null,
        wordCount:       countBodyWords(it.body),
      }));

    // Slim shape for the dashboard's per-bucket popup. Every row carries
    // enough to render a list line plus drive Approve / Add Review actions:
    // title, category, status, automation-rule name, the relevant timestamp.
    const slimRow = (it, extra = {}) => ({
      id:                 it.id,
      title:              it.title,
      category:           it.category,
      status:             it.status,
      automationRuleName: it.automationRuleName || null,
      sourceDocName:      it.sourceDocName || null,
      sourceDocUrl:       it.sourceDocUrl || null,
      createdAt:          it.createdAt || null,
      updatedAt:          it.updatedAt || null,
      ...extra,
    });
    const byNewest = (a, b) =>
      new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);

    const buckets = {
      received: receivedRaw.slice().sort(byNewest).map(it =>
        slimRow(it, { sentForReviewAt: it.sentForReviewAt || null })),
      approved: approvedRaw.slice().sort(byNewest).map(it =>
        slimRow(it, { approvedAt: it.approvedAt || null })),
      commented: commentedRaw
        .slice()
        .sort((a, b) => new Date(b._myLastCommentAt || b.updatedAt || 0) - new Date(a._myLastCommentAt || a.updatedAt || 0))
        .map(it => slimRow(it, { lastCommentAt: it._myLastCommentAt, myCommentCount: it._myCommentCount })),
    };

    return res.json({
      stats: { totalReviewRequests, approvedByUser, commentsByUser },
      openTasks,
      buckets,
    });
  }

  // ── Dashboard summary — small payload of counts + last-N metadata.
  //   GET /api/content?action=summary[&recent=N]
  // Replaces the previous pattern of pulling every full article body (often
  // 30+ MB once a few hundred articles have accumulated) just to compute four
  // dashboard tiles. Server reads all items, the WIRE format is the aggregate.
  if (action === 'summary' && req.method === 'GET') {
    const ids = await kv.lrange('content:index', 0, -1);
    if (!ids.length) {
      return res.json({ total: 0, autoGen: 0, manualGen: 0, publishedCount: 0, byCategory: {}, recent: [] });
    }
    const items = (await Promise.all(ids.map(id => kv.get(`content:${id}`)))).filter(Boolean);
    const recentLimit = Math.max(1, Math.min(50, parseInt(req.query.recent, 10) || 8));

    let autoGen = 0, manualGen = 0, publishedCount = 0;
    const byCategory = {};
    for (const i of items) {
      if (i.automationRuleId) autoGen++; else manualGen++;
      if (i.status === 'published') publishedCount++;
      const c = i.category || 'uncategorised';
      byCategory[c] = (byCategory[c] || 0) + 1;
    }
    // Slim down recent items to just what the dashboard renders — title,
    // category, status, timestamp, id. Drops body/excerpt/rejectionComments
    // which carry most of the byte weight.
    const recent = items
      .slice()
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .slice(0, recentLimit)
      .map(i => ({
        id: i.id,
        title: i.title,
        category: i.category,
        status: i.status,
        updatedAt: i.updatedAt,
        createdAt: i.createdAt,
      }));
    return res.json({ total: items.length, autoGen, manualGen, publishedCount, byCategory, recent });
  }
  // ── Email diagnostic — admin only. Helps narrow down why review emails stopped sending.
  //   GET  /api/content?action=email-diagnostic → env-var presence + recent email-related log entries
  //   POST /api/content?action=email-diagnostic with { to: "you@example.com" } → fires a test send via Resend
  // The POST response includes Resend's verbatim error so domain/key/rate issues are visible.
  if (action === 'email-diagnostic') {
    const me = await getCurrentUser(req);
    const guard = requireRole(me, 'admin');
    if (!guard.ok) return res.status(guard.status).json({ error: guard.error });

    const env = {
      RESEND_API_KEY:    process.env.RESEND_API_KEY    ? `set (${process.env.RESEND_API_KEY.slice(0, 6)}…${process.env.RESEND_API_KEY.slice(-3)})` : 'UNSET',
      RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL || 'UNSET (using default Vance Content <noreply@slapharmagroup.com>)',
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || 'UNSET',
      JWT_SECRET: process.env.JWT_SECRET ? 'set' : 'UNSET',
    };

    if (req.method === 'GET') {
      // Full server-side diagnosis — gathers everything needed to debug
      // "review emails stopped sending" without round-tripping through the
      // console. Returns: env, log evidence, every rule's resolved recipient
      // set, dead-user IDs, and a verdict-per-rule.
      const { readLogs } = await import('../../lib/automation/log.js');
      const [logs, ruleIds, users] = await Promise.all([
        readLogs(200),
        kv.lrange('automation:rules:index', 0, -1).then(ids => ids || []),
        kv.get('users').then(u => u ?? kv.get('reviewers').then(r => r ?? [])),
      ]);

      // Filter logs to email/notification-relevant ones with FULL messages
      const emailLogs = logs
        .filter(l => /email|resend|notification|sent|recipient|notif/i.test(l.message || ''))
        .slice(0, 40)
        .map(l => ({
          at: l.at,
          level: l.level,
          rule: l.ruleName,
          message: l.message,
          jobId: l.jobId,
          contentId: l.contentId,
        }));

      // Resolve every email-enabled rule's recipient set the same way notify.js does
      const userById = new Map((users || []).map(u => [u.id, u]));
      const rules = await Promise.all(ruleIds.map(id => kv.get(`automation:rule:${id}`)));
      const ruleAudit = rules
        .filter(r => r && r.notifications?.email?.enabled)
        .map(r => {
          const e = r.notifications.email;
          const userIds = Array.isArray(e.userIds) ? e.userIds : [];
          const externalEmails = Array.isArray(e.externalEmails) ? e.externalEmails : [];
          const legacyTo = (!userIds.length && !externalEmails.length && Array.isArray(e.to)) ? e.to : [];

          const resolvedFromUsers = [];
          const deadUserIds = [];
          for (const uid of userIds) {
            const u = userById.get(uid);
            if (u?.email) resolvedFromUsers.push({ userId: uid, name: u.name, email: u.email });
            else deadUserIds.push(uid);
          }
          const allRecipients = [
            ...resolvedFromUsers.map(r => r.email),
            ...externalEmails,
            ...legacyTo,
          ].filter(Boolean);
          const uniqueRecipients = [...new Set(allRecipients.map(s => s.toLowerCase()))];

          let verdict;
          if (!uniqueRecipients.length) {
            verdict = '❌ EMPTY recipient set — emails would be skipped silently. Open the rule\'s Notify step and pick at least one user or add an external email.';
          } else if (deadUserIds.length) {
            verdict = `⚠ ${deadUserIds.length} dead userId(s) reference users that no longer exist. Resolved recipients still work, but clean up the rule.`;
          } else {
            verdict = `✓ ${uniqueRecipients.length} recipient(s) would receive emails.`;
          }

          return {
            ruleId: r.id,
            ruleName: r.name,
            enabled: r.enabled,
            emailEnabled: e.enabled,
            telegramEnabled: r.notifications?.telegram?.enabled || false,
            requireAllApprovals: (r.review?.mode ?? 'any') === 'all',
            configured: { userIds, externalEmails, legacyTo },
            resolved: { fromUsers: resolvedFromUsers, deadUserIds, finalEmails: uniqueRecipients },
            verdict,
          };
        });

      // High-level diagnosis
      const issues = [];
      if (!ruleAudit.length) issues.push('No rules have email notifications enabled.');
      const emptyRules = ruleAudit.filter(r => !r.resolved.finalEmails.length);
      if (emptyRules.length) issues.push(`${emptyRules.length} rule(s) with email enabled have NO recipients: ${emptyRules.map(r => r.ruleName).join(', ')}`);
      const recentErrors = emailLogs.filter(l => l.level === 'error');
      if (recentErrors.length) issues.push(`${recentErrors.length} recent email-error log entries.`);

      return res.json({
        env,
        verdict: issues.length ? issues : ['No obvious config issue — all email-enabled rules have recipients. Check inbox/spam, or run a test send via POST.'],
        ruleAudit,
        recentLogs: emailLogs,
        totalLogsScanned: logs.length,
        userDirectorySize: (users || []).length,
        hint: 'POST with { "to": "your@email" } to send a verification test directly via Resend.',
      });
    }

    if (req.method === 'POST') {
      const to = (req.body?.to || '').toString().trim();
      if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return res.status(400).json({ error: 'Provide { "to": "you@example.com" } to test.' });
      }
      // Use Resend directly — no template, no DB writes, just verify the API path
      try {
        const { Resend } = await import('resend');
        const resend = new Resend(process.env.RESEND_API_KEY || 'test-key');
        const from = process.env.RESEND_FROM_EMAIL || 'Vance Content <noreply@slapharmagroup.com>';
        const result = await resend.emails.send({
          from,
          to,
          subject: 'Vance Content — email diagnostic',
          html: `<p>This is a diagnostic test sent at ${new Date().toISOString()}.</p><p>If you received this, Resend is configured correctly.</p>`,
        });
        return res.json({
          env,
          from,
          to,
          resendResponse: result,            // { data: {id}, error: null } on success
          ok: !result?.error,
          diagnosis: result?.error
            ? 'Resend rejected the send. The error.message field tells you why (domain unverified, API key invalid, rate limit, etc.).'
            : 'Send succeeded. Check inbox + spam. If review emails specifically aren\'t arriving, the failure is downstream of Resend — likely in the rule\'s recipient list or notification toggle.',
        });
      } catch (err) {
        return res.status(500).json({ env, ok: false, error: err.message, stack: err.stack?.split('\n').slice(0, 4) });
      }
    }
    return res.status(405).json({ error: 'GET or POST only' });
  }

  // ── Backfill: heal content items where partial approvals are recorded on
  // the automation:job but never mirrored to the content's status / approvals.
  // Admin-only. Iterates pending_review jobs and patches their content items.
  // POST body { dryRun: true } to preview without writing.
  if (action === 'backfill-review-sync' && req.method === 'POST') {
    const me = await getCurrentUser(req);
    const guard = requireRole(me, 'admin');
    if (!guard.ok) return res.status(guard.status).json({ error: guard.error });

    const dryRun = !!req.body?.dryRun;
    const jobIds = (await kv.lrange('automation:jobs:index', 0, -1)) || [];
    const fixed = [];
    const skipped = [];
    const now = new Date().toISOString();

    for (const jobId of jobIds) {
      const job = await kv.get(`automation:job:${jobId}`);
      if (!job || job.status !== 'pending_review') {
        skipped.push({ jobId, reason: `job status ${job?.status ?? 'missing'}` });
        continue;
      }
      const content = await kv.get(`content:${job.contentId}`);
      if (!content) {
        skipped.push({ jobId, contentId: job.contentId, reason: 'content missing' });
        continue;
      }
      // Only patch items the runner left in 'draft'. Items already in 'in_review' /
      // 'approved' / 'rejected' have already been reconciled by the new sync logic.
      if (content.status !== 'draft' && content.status !== 'in_review') {
        skipped.push({ jobId, contentId: content.id, title: content.title, reason: `content status ${content.status}` });
        continue;
      }
      const rule = await kv.get(`automation:rule:${job.ruleId}`);
      const jobApprovals = Array.isArray(job.approvals) ? job.approvals : [];
      const jobRejections = Array.isArray(job.rejections) ? job.rejections : [];
      const jobReviewerIds = Array.isArray(job.reviewerIds) ? job.reviewerIds : [];

      // Decide whether the content actually needs patching: status mismatch,
      // missing reviewers, or missing approvals all qualify.
      const contentApprovals = Array.isArray(content.approvals) ? content.approvals : [];
      const contentReviewers = Array.isArray(content.reviewers) ? content.reviewers : [];
      const needsStatusFix     = content.status === 'draft';
      const needsReviewersFix  = contentReviewers.length === 0 && jobReviewerIds.length > 0;
      const needsApprovalsFix  = contentApprovals.length < jobApprovals.length;
      if (!needsStatusFix && !needsReviewersFix && !needsApprovalsFix) {
        skipped.push({ jobId, contentId: content.id, title: content.title, reason: 'already in sync' });
        continue;
      }

      const patched = {
        ...content,
        status: needsStatusFix ? 'in_review' : content.status,
        reviewers: needsReviewersFix ? jobReviewerIds : contentReviewers,
        approvals: jobApprovals,    // authoritative — job tracks the canonical vote tally
        rejections: jobRejections,
        requireAllApprovals: content.requireAllApprovals ?? ((rule?.review?.mode ?? 'any') === 'all'),
        sentForReviewAt: content.sentForReviewAt || job.notifiedAt || job.createdAt || now,
        updatedAt: now,
      };
      fixed.push({
        jobId,
        contentId: content.id,
        title: content.title,
        before: { status: content.status, approvals: contentApprovals.length, reviewers: contentReviewers.length },
        after:  { status: patched.status,  approvals: patched.approvals.length, reviewers: patched.reviewers.length },
      });
      if (!dryRun) await kv.set(`content:${content.id}`, patched);
    }
    return res.json({ dryRun, jobsScanned: jobIds.length, fixedCount: fixed.length, skippedCount: skipped.length, fixed, skipped });
  }

  if (req.method === 'GET') {
    const ids = await kv.lrange('content:index', 0, -1);
    if (!ids.length) return res.json([]);
    const items = await Promise.all(ids.map(id => kv.get(`content:${id}`)));
    const filtered = items.filter(Boolean).reverse();
    // ?slim=1 strips only the one byte-heavy field — `body` (full article HTML,
    // which is the bulk of the ~38 MB unslimmed payload) — and substitutes a
    // server-computed `wordCount` so list tabs (Pipeline/Library) never need the
    // body to show their word count. Every other field passes through, so this
    // payload is a universal render source for all list tabs and the in-memory
    // contentCache. Anything that actually needs the body (Pipeline article
    // view, social-post generation, AI revise) lazy-fetches the single item via
    // /api/content/:id, which still carries the full record.
    if (req.query.slim === '1') {
      // Strip data: URIs from heroImageUrl — these are inline base64 PNGs that
      // can run to 1 MB+ each (AI-generated hero images). 43 items × 1 MB ≈
      // the 38 MB payload that was making the dashboard appear to freeze on
      // boot. Regular HTTPS URLs pass through unchanged so externally-hosted
      // hero images still render in Pipeline thumbnails.
      const slimHero = (url) =>
        (url && typeof url === 'string' && !url.startsWith('data:')) ? url : null;
      return res.json(filtered.map(i => ({
        ...i,
        body: undefined,
        // versions[] holds full prior-body snapshots and auditLog[] is an
        // uncapped event log — both are byte-heavy and only the Approval Log's
        // expand view needs them, which lazy-fetches the full record via
        // /api/content/:id. Strip them so the list payload stays small.
        versions: undefined,
        auditLog: undefined,
        wordCount: countBodyWords(i.body),
        heroImageUrl: slimHero(i.heroImageUrl),
      })));
    }
    return res.json(filtered);
  }

  if (req.method === 'POST') {
    try {
      validateContentItem(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const item = buildContentItem(req.body);
    await kv.set(`content:${item.id}`, item);
    await kv.lpush('content:index', item.id);
    // A stock hero is spent the moment it lands on a saved article, so the picker
    // never offers it again. Marking here rather than on click is deliberate:
    // clicking through five thumbnails must not burn the four that were rejected.
    await markStockUsed(heroAsStockPhoto(item));
    return res.status(201).json(item);
  }

  res.status(405).json({ error: 'Method not allowed' });
}

export default withErrorBoundary(handler);

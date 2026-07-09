import { kv } from '../../lib/kv.js';
import { SignJWT, jwtVerify } from 'jose';
import { Resend } from 'resend';
import { renderArticleEmailContent } from '../../lib/email-content.js';

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-secret-replace-in-production');
// Lazy-init so the module can be imported in tests without a real API key
let _resend;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY ?? 'test-key');
  return _resend;
}
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

// ── Token helpers (exported for testing) ────────────────────────────────────

export async function buildApprovalToken({ contentId, reviewerId, action }) {
  return new SignJWT({ contentId, reviewerId, action })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('7d')
    .setIssuedAt()
    .sign(secret);
}

export async function parseApprovalToken(token) {
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload;
  } catch {
    throw new Error('invalid or expired approval token');
  }
}

// ── Email builder ─────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function buildApprovalEmail({ reviewer, content, approveUrl, rejectUrl, urgent = false }) {
  const subjectBase = `[Review Required] ${content.title}`;
  const sourceLine = content.sourceDocName
    ? `<p style="font-size:12px;color:#6b7a8d;margin:6px 0 0;">
         <span style="text-transform:uppercase;letter-spacing:1px;font-size:10px;color:#9aa5b4;">Source: </span>
         ${content.sourceDocUrl
           ? `<a href="${escHtml(content.sourceDocUrl)}" style="color:#006868;text-decoration:underline;">${escHtml(content.sourceDocName)}</a>`
           : escHtml(content.sourceDocName)}
       </p>`
    : '';
  const promptLine = content.promptName
    ? `<p style="font-size:12px;color:#6b7a8d;margin:6px 0 0;">
         <span style="text-transform:uppercase;letter-spacing:1px;font-size:10px;color:#9aa5b4;">Prompt: </span>
         ${escHtml(content.promptName)}
       </p>`
    : '';
  return {
    from: process.env.RESEND_FROM_EMAIL ?? 'Vance Content <noreply@slapharmagroup.com>',
    to: reviewer.email,
    subject: urgent ? `[URGENT] ${subjectBase}` : subjectBase,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;">
        <div style="background:#1e2d40;padding:20px 24px;border-bottom:3px solid #006868;">
          <span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:1px;">Vance Health Hub</span>
          <span style="color:#006868;font-size:20px;font-weight:800;"> ■</span>
        </div>
        <div style="padding:28px 24px;">
          <h2 style="color:#1e2d40;font-size:18px;margin:0 0 12px;">${urgent ? '⚠ URGENT — Reminder: Content Review Request' : 'Content Review Request'}</h2>
          <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 16px;">Hi ${reviewer.name},</p>
          <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 20px;">
            ${urgent
              ? 'This is a reminder — the following content is still awaiting your approval and is now overdue:'
              : 'The following content has been submitted for your review:'}
          </p>
          <table cellpadding="12" cellspacing="0" border="0" width="100%"
                 style="background:#f0f2f5;border-radius:8px;border-left:3px solid #006868;margin-bottom:24px;">
            <tr>
              <td>
                <p style="font-size:11px;color:#6b7a8d;text-transform:uppercase;letter-spacing:1px;margin:0 0 4px;">Article for Review</p>
                <p style="font-size:16px;font-weight:bold;color:#1e2d40;margin:0 0 8px;">${content.title}</p>
                <p style="font-size:13px;color:#6b7a8d;margin:0;">${content.category ?? ''}</p>
                ${sourceLine}
                ${promptLine}
              </td>
            </tr>
          </table>
          ${renderArticleEmailContent({
            title: content.title,
            body: content.body,
            excerpt: content.excerpt,
            heroImageUrl: content.heroImageUrl,
            category: content.category,
          })}
          <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
            <tr>
              <td style="padding-right:12px;">
                <table cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" bgcolor="#006868" style="border-radius:6px;">
                      <a href="${approveUrl}" style="display:inline-block;padding:13px 28px;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;">✓ Approve</a>
                    </td>
                  </tr>
                </table>
              </td>
              <td>
                <table cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" bgcolor="#f0f2f5" style="border-radius:6px;border:1px solid #dde3ea;">
                      <a href="${rejectUrl}" style="display:inline-block;padding:13px 28px;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:#1e2d40;text-decoration:none;border-radius:6px;">↩ Request Changes</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
          <p style="color:#9aa5b4;font-size:12px;">This link expires in 7 days.</p>
        </div>
        <div style="background:#f0f2f5;padding:16px 24px;border-top:1px solid #dde3ea;">
          <p style="color:#9aa5b4;font-size:12px;margin:0;">Vance Health Hub Content Platform — vancehealthhub.co.uk</p>
        </div>
      </div>
    `,
  };
}

// ── HTTP handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { contentId, requireAllApprovals = false, urgent = false, reviewerIds = null } = req.body;
  if (!contentId) return res.status(400).json({ error: 'contentId required' });

  const [content, allReviewers] = await Promise.all([
    kv.get(`content:${contentId}`),
    kv.get('reviewers'),
  ]);

  if (!content) return res.status(404).json({ error: 'Content not found' });
  if (!allReviewers?.length) return res.status(400).json({ error: 'No reviewers configured. Add users in Settings.' });

  // Filter reviewers by selection: request body > content's saved reviewerIds > all
  const selectedIds = Array.isArray(reviewerIds) && reviewerIds.length
    ? reviewerIds
    : (Array.isArray(content.reviewerIds) && content.reviewerIds.length ? content.reviewerIds : null);
  const reviewers = selectedIds
    ? allReviewers.filter(r => selectedIds.includes(r.id))
    : allReviewers;
  if (!reviewers.length) return res.status(400).json({ error: 'None of the selected reviewers exist' });

  const results = await Promise.allSettled(reviewers.map(async reviewer => {
    const [approveToken, rejectToken] = await Promise.all([
      buildApprovalToken({ contentId, reviewerId: reviewer.id, action: 'approve' }),
      buildApprovalToken({ contentId, reviewerId: reviewer.id, action: 'reject' }),
    ]);
    const approveUrl = `${APP_URL}/api/review/${approveToken}`;
    const rejectUrl  = `${APP_URL}/api/review/${rejectToken}`;
    const result = await getResend().emails.send(
      buildApprovalEmail({ reviewer, content, approveUrl, rejectUrl, urgent })
    );
    if (result.error) throw new Error(`Resend error for ${reviewer.email}: ${result.error.message}`);
    return { reviewer: reviewer.email, id: result.data?.id };
  }));

  const failures = results.filter(r => r.status === 'rejected').map(r => r.reason?.message);
  const sent     = results.filter(r => r.status === 'fulfilled').length;

  if (sent === 0) {
    return res.status(500).json({
      error: `All emails failed to send. First error: ${failures[0] ?? 'unknown'}`,
      details: failures,
    });
  }

  const nowIso = new Date().toISOString();
  const updated = {
    ...content,
    status: 'in_review',
    requireAllApprovals,
    reviewers: reviewers.map(r => r.id),
    reviewerIds: selectedIds ?? reviewers.map(r => r.id),
    // Preserve approvals/rejections on URGENT resend; reset on initial send
    approvals: urgent ? (content.approvals ?? []) : [],
    rejections: urgent ? (content.rejections ?? []) : [],
    sentForReviewAt: content.sentForReviewAt ?? nowIso,
    ...(urgent && { lastReminderAt: nowIso, reminderCount: (content.reminderCount ?? 0) + 1 }),
    updatedAt: nowIso,
  };
  await kv.set(`content:${contentId}`, updated);

  return res.json({
    sent,
    failed: failures.length,
    status: 'in_review',
    urgent,
    ...(failures.length && { warnings: failures }),
  });
}

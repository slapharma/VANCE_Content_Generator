// lib/automation/notify.js
import { Resend } from 'resend';
import { SignJWT } from 'jose';
import { kv } from '../kv.js';
import { renderArticleEmailContent } from '../email-content.js';

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-secret-replace-in-production');
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

let _resend;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY ?? 'test-key');
  return _resend;
}

async function buildApprovalToken(jobId, action, expiryHours, reviewerId = null) {
  const payload = { jobId, action };
  if (reviewerId) payload.reviewerId = reviewerId;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(`${expiryHours}h`)
    .setIssuedAt()
    .sign(secret);
}

export function buildTelegramPayload({ chatId, jobId, title, category }) {
  return {
    chat_id: chatId,
    text: `📋 *New automation article requires review*\n\n*${title}*\n_${category}_\n\nPlease review and approve or reject:`,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${jobId}` },
        { text: '❌ Reject',  callback_data: `reject:${jobId}` },
      ]],
    },
  };
}

export function buildApprovalEmailHtml({ title, category, body, excerpt, heroImageUrl, approveUrl, rejectUrl, urgent = false, recipientName = '', ruleName = '' }) {
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Full rich article rendering — hero image + formatted markdown body, matching the live article view
  const fullArticleBlock = renderArticleEmailContent({ title, body, excerpt, heroImageUrl, category });
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;">
      <div style="background:#1e2d40;padding:20px 24px;border-bottom:3px solid #006868;">
        <span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:1px;">Vance Content</span>
        <span style="color:#006868;font-size:20px;font-weight:800;"> ■</span>
      </div>
      <div style="padding:28px 24px;">
        <h2 style="color:#1e2d40;font-size:18px;margin:0 0 12px;">${urgent ? '⚠ URGENT — Reminder: Automation Review Required' : 'Automation Review Required'}</h2>
        ${recipientName && recipientName.indexOf('@') === -1 ? `<p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 8px;">Hi ${esc(recipientName)},</p>` : ''}
        <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 20px;">${urgent
          ? 'This is a reminder — the following automation-generated article is still awaiting your approval and is now overdue:'
          : 'A new article has been generated and requires your approval:'}</p>
        <table cellpadding="12" style="background:#f0f2f5;border-radius:8px;border-left:3px solid #006868;width:100%;margin-bottom:24px;">
          <tr><td>
            <p style="font-size:11px;color:#6b7a8d;text-transform:uppercase;margin:0 0 4px;">Article</p>
            <p style="font-size:16px;font-weight:bold;color:#1e2d40;margin:0 0 4px;">${title}</p>
            <p style="font-size:13px;color:#6b7a8d;margin:0;">${category}${ruleName ? ` &middot; <span style="color:#1e2d40;">From rule: <strong>${ruleName}</strong></span>` : ''}</p>
          </td></tr>
        </table>
        ${fullArticleBlock}
        <table width="100%"><tr>
          <td width="48%">
            <a href="${approveUrl}" style="display:block;text-align:center;background:#006868;color:#fff;padding:14px;border-radius:6px;text-decoration:none;font-weight:bold;">✅ Approve &amp; Publish</a>
          </td>
          <td width="4%"></td>
          <td width="48%">
            <a href="${rejectUrl}" style="display:block;text-align:center;background:#f0f2f5;color:#1e2d40;padding:14px;border-radius:6px;text-decoration:none;font-weight:bold;border:1px solid #dde3ea;">↩ Request Changes</a>
          </td>
        </tr></table>
        <p style="color:#9aa5b4;font-size:12px;margin-top:24px;">These links expire after the rule's review timeout window. Log in to the Vance Content dashboard to review manually.</p>
      </div>
      <div style="background:#f0f2f5;padding:16px 24px;border-top:1px solid #dde3ea;">
        <p style="color:#9aa5b4;font-size:12px;margin:0;">Vance Medical Foods — vancemedicalfoods.com</p>
      </div>
    </div>`;
}

export async function sendNotifications({ rule, job, content, fetchFn = fetch, resendClient = null, urgent = false }) {
  const { notifications, review } = rule;
  const errors = [];

  // Telegram
  if (notifications.telegram?.enabled && (process.env.TELEGRAM_BOT_TOKEN || fetchFn !== fetch)) {
    try {
      const payload = buildTelegramPayload({
        chatId: notifications.telegram.chatId,
        jobId: job.id,
        title: content.title,
        category: content.category,
      });
      const res = await fetchFn(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) errors.push(`Telegram: HTTP ${res.status}`);
    } catch (err) {
      errors.push(`Telegram: ${err.message}`);
    }
  }

  // Email — build per-recipient objects so each gets a personalised token
  // (enables proper attribution of "Request Changes" comments on submit).
  let recipients = [];
  if (notifications.email?.enabled) {
    const userIds = Array.isArray(notifications.email.userIds) ? notifications.email.userIds : [];
    const externalEmails = Array.isArray(notifications.email.externalEmails) ? notifications.email.externalEmails : [];
    // Back-compat fallback: legacy rules only have `to: string[]`
    const legacyTo = (!userIds.length && !externalEmails.length && Array.isArray(notifications.email.to)) ? notifications.email.to : [];

    if (userIds.length) {
      const users = (await kv.get('users')) ?? (await kv.get('reviewers')) ?? [];
      const byId = new Map(users.map(u => [u.id, u]));
      for (const id of userIds) {
        const u = byId.get(id);
        if (u?.email) recipients.push({ email: u.email, reviewerId: u.id, name: u.name || u.email });
      }
    }
    for (const e of [...externalEmails, ...legacyTo]) {
      if (!e) continue;
      const lower = e.toLowerCase();
      if (recipients.find(r => r.email.toLowerCase() === lower)) continue; // already added via user
      // External recipients use their email as a stable id — attribution shows the email
      recipients.push({ email: e, reviewerId: e, name: e });
    }
  }

  if (notifications.email?.enabled && !recipients.length) {
    errors.push('Email: no recipients configured (no users selected and no external emails). Edit the rule to fix.');
  }

  if (notifications.email?.enabled && recipients.length) {
    // JWT outlives the rule's timeout window so a reviewer who clicks shortly
    // after auto-timeout sees the "already approved by timeout" page rather
    // than a JWT that's coincidentally still-valid right at the cliff.
    const timeoutHours = review.timeoutHours ?? 48;
    const expiryHours = timeoutHours + 168; // +7 days buffer
    const subjectBase = `[Review Required] ${content.title}`;
    const client = resendClient ?? getResend();
    const from = process.env.RESEND_FROM_EMAIL ?? 'Vance Content <noreply@slapharmagroup.com>';

    // One email per recipient with its own approve/reject tokens carrying reviewerId
    const sends = await Promise.allSettled(recipients.map(async (rec) => {
      const [approveToken, rejectToken] = await Promise.all([
        buildApprovalToken(job.id, 'approve', expiryHours, rec.reviewerId),
        buildApprovalToken(job.id, 'reject',  expiryHours, rec.reviewerId),
      ]);
      const approveUrl = `${APP_URL}/api/automation/approve?token=${approveToken}`;
      const rejectUrl  = `${APP_URL}/api/automation/approve?token=${rejectToken}`;
      const html = buildApprovalEmailHtml({
        title: content.title,
        category: content.category,
        body: content.body,
        excerpt: content.excerpt,
        heroImageUrl: content.heroImageUrl,
        approveUrl,
        rejectUrl,
        urgent,
        recipientName: rec.name,
        ruleName: rule.name,
      });
      return client.emails.send({
        from,
        to: rec.email,
        subject: urgent ? `[URGENT] ${subjectBase}` : subjectBase,
        html,
      });
    }));

    const failures = sends
      .map((s, i) => s.status === 'rejected' ? `${recipients[i].email}: ${s.reason?.message || s.reason}` : null)
      .filter(Boolean);
    if (failures.length) errors.push(`Email: ${failures.length}/${recipients.length} send(s) failed — ${failures[0]}`);
  }

  return { errors, reviewerIds: recipients.map(r => r.reviewerId) };
}

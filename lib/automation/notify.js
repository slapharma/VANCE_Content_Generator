// lib/automation/notify.js
import { Resend } from 'resend';
import { SignJWT } from 'jose';

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-secret-replace-in-production');
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

let _resend;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY ?? 'test-key');
  return _resend;
}

async function buildApprovalToken(jobId, action, expiryHours) {
  return new SignJWT({ jobId, action })
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

export function buildApprovalEmailHtml({ title, category, approveUrl, rejectUrl }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;">
      <div style="background:#1e2d40;padding:20px 24px;border-bottom:3px solid #006868;">
        <span style="color:#fff;font-size:20px;font-weight:800;">Vance Medical Foods</span>
        <span style="color:#006868;font-size:20px;font-weight:800;"> ■</span>
      </div>
      <div style="padding:28px 24px;">
        <h2 style="color:#1e2d40;">Automation Review Required</h2>
        <p style="color:#555;">A new article has been generated and requires your approval:</p>
        <table cellpadding="12" style="background:#f0f2f5;border-radius:8px;border-left:3px solid #006868;width:100%;margin-bottom:24px;">
          <tr><td>
            <p style="font-size:11px;color:#6b7a8d;text-transform:uppercase;margin:0 0 4px;">Article</p>
            <p style="font-size:16px;font-weight:bold;color:#1e2d40;margin:0 0 4px;">${title}</p>
            <p style="font-size:13px;color:#6b7a8d;margin:0;">${category}</p>
          </td></tr>
        </table>
        <table width="100%"><tr>
          <td width="48%">
            <a href="${approveUrl}" style="display:block;text-align:center;background:#006868;color:#fff;padding:14px;border-radius:6px;text-decoration:none;font-weight:bold;">✅ Approve &amp; Publish</a>
          </td>
          <td width="4%"></td>
          <td width="48%">
            <a href="${rejectUrl}" style="display:block;text-align:center;background:#e53e3e;color:#fff;padding:14px;border-radius:6px;text-decoration:none;font-weight:bold;">❌ Reject</a>
          </td>
        </tr></table>
        <p style="color:#999;font-size:12px;margin-top:24px;">These links expire after 48h. Log in to the Vance Medical Foods dashboard to review manually.</p>
      </div>
    </div>`;
}

export async function sendNotifications({ rule, job, content, fetchFn = fetch, resendClient = null }) {
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

  // Email
  if (notifications.email?.enabled && notifications.email.to?.length) {
    try {
      const expiryHours = review.timeoutHours ?? 48;
      const approveToken = await buildApprovalToken(job.id, 'approve', expiryHours);
      const rejectToken  = await buildApprovalToken(job.id, 'reject',  expiryHours);
      const approveUrl = `${APP_URL}/api/automation/approve?token=${approveToken}`;
      // Both links use the same endpoint; the JWT action claim ('reject') drives the behaviour
      const rejectUrl  = `${APP_URL}/api/automation/approve?token=${rejectToken}`;
      const html = buildApprovalEmailHtml({ title: content.title, category: content.category, approveUrl, rejectUrl });

      const client = resendClient ?? getResend();
      await client.emails.send({
        from: process.env.RESEND_FROM_EMAIL ?? 'noreply@mail.vancemedicalfoods.com',
        to: notifications.email.to,
        subject: `[Review Required] ${content.title}`,
        html,
      });
    } catch (err) {
      errors.push(`Email: ${err.message}`);
    }
  }

  return errors;
}

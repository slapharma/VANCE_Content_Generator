import { kv } from '@vercel/kv';
import { SignJWT, jwtVerify } from 'jose';
import { Resend } from 'resend';

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

function buildApprovalEmail({ reviewer, content, approveUrl, rejectUrl }) {
  return {
    from: process.env.RESEND_FROM_EMAIL ?? 'noreply@mail.ibdhealthhub.com',
    to: reviewer.email,
    subject: `Review requested: ${content.title}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;">
        <div style="background:#1e2d40;padding:20px 24px;border-bottom:3px solid #F47920;">
          <span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:1px;">IBD Health Hub</span>
          <span style="color:#F47920;font-size:20px;font-weight:800;"> ■</span>
        </div>
        <div style="padding:28px 24px;">
          <h2 style="color:#1e2d40;font-size:18px;margin:0 0 12px;">Content Review Request</h2>
          <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 16px;">Hi ${reviewer.name},</p>
          <p style="color:#555;font-size:14px;line-height:1.6;margin:0 0 20px;">
            The following content has been submitted for your review:
          </p>
          <table cellpadding="12" cellspacing="0" border="0" width="100%"
                 style="background:#f0f2f5;border-radius:8px;border-left:3px solid #F47920;margin-bottom:24px;">
            <tr>
              <td>
                <p style="font-size:11px;color:#6b7a8d;text-transform:uppercase;letter-spacing:1px;margin:0 0 4px;">Article for Review</p>
                <p style="font-size:16px;font-weight:bold;color:#1e2d40;margin:0 0 8px;">${content.title}</p>
                <p style="font-size:13px;color:#6b7a8d;margin:0;">${content.category ?? ''}</p>
              </td>
            </tr>
          </table>
          ${(() => {
            const plain = (content.body || content.excerpt || '')
              .replace(/<[^>]+>/g, '').replace(/#{1,6}\s*/g, '').trim();
            const preview = plain.slice(0, 4000) + (plain.length > 4000 ? '\n\n[…article continues]' : '');
            const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
            return preview ? `
          <div style="margin:0 0 24px;">
            <p style="font-size:11px;color:#6b7a8d;text-transform:uppercase;letter-spacing:1px;margin:0 0 8px;font-family:Arial,sans-serif;">Full Article</p>
            <div style="background:#fafbfc;border:1px solid #dde3ea;border-radius:6px;padding:16px 18px;
                        font-size:13px;color:#333;line-height:1.75;white-space:pre-wrap;font-family:Georgia,serif;">
              ${esc(preview)}
            </div>
          </div>` : '';
          })()}
          <table cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
            <tr>
              <td style="padding-right:12px;">
                <table cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" bgcolor="#F47920" style="border-radius:6px;">
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
          <p style="color:#9aa5b4;font-size:12px;margin:0;">IBD Health Hub Content Platform — ibdhealthhub.com</p>
        </div>
      </div>
    `,
  };
}

// ── HTTP handler ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { contentId, requireAllApprovals = false } = req.body;
  if (!contentId) return res.status(400).json({ error: 'contentId required' });

  const [content, reviewers] = await Promise.all([
    kv.get(`content:${contentId}`),
    kv.get('reviewers'),
  ]);

  if (!content) return res.status(404).json({ error: 'Content not found' });
  if (!reviewers?.length) return res.status(400).json({ error: 'No reviewers configured. Add reviewers in Settings.' });

  const results = await Promise.allSettled(reviewers.map(async reviewer => {
    const [approveToken, rejectToken] = await Promise.all([
      buildApprovalToken({ contentId, reviewerId: reviewer.id, action: 'approve' }),
      buildApprovalToken({ contentId, reviewerId: reviewer.id, action: 'reject' }),
    ]);
    const approveUrl = `${APP_URL}/api/review/${approveToken}`;
    const rejectUrl  = `${APP_URL}/api/review/${rejectToken}`;
    const result = await getResend().emails.send(
      buildApprovalEmail({ reviewer, content, approveUrl, rejectUrl })
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

  const updated = {
    ...content,
    status: 'in_review',
    requireAllApprovals,
    reviewers: reviewers.map(r => r.id),
    approvals: [],
    rejections: [],
    updatedAt: new Date().toISOString(),
  };
  await kv.set(`content:${contentId}`, updated);

  return res.json({
    sent,
    failed: failures.length,
    status: 'in_review',
    ...(failures.length && { warnings: failures }),
  });
}

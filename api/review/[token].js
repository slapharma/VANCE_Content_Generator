import { kv } from '../../lib/kv.js';
import { parseApprovalToken } from '../review/send.js';

export function computeNewStatus(item) {
  if (item.rejections.length > 0) return 'rejected';
  if (item.requireAllApprovals) {
    return item.approvals.length >= item.reviewers.length ? 'approved' : 'in_review';
  }
  return item.approvals.length > 0 ? 'approved' : 'in_review';
}

// ── Shared HTML shell ────────────────────────────────────────────────────────
const shell = (title, body) => `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Gastro Health Hub</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:Arial,sans-serif;background:#f0f2f5;min-height:100vh;padding:24px 16px;}
  .brand{display:flex;align-items:center;gap:8px;margin-bottom:24px;justify-content:center;}
  .brand-name{color:#1e2d40;font-weight:800;font-size:18px;letter-spacing:1px;}
  .brand-name span{color:#006868;}
  .card{max-width:640px;margin:0 auto;background:#fff;border-radius:12px;
        box-shadow:0 2px 20px rgba(30,45,64,.1);overflow:hidden;}
  .card-head{background:#1e2d40;border-bottom:3px solid #006868;padding:20px 24px;}
  .card-head h1{color:#fff;font-size:1.1rem;line-height:1.4;}
  .card-head .cat{color:rgba(255,255,255,0.55);font-size:0.75rem;margin-top:4px;}
  .card-body{padding:24px;}
  .excerpt{background:#f8f9fa;border-left:3px solid #dde3ea;padding:14px 16px;
           border-radius:0 6px 6px 0;font-size:0.875rem;color:#555;
           line-height:1.7;margin-bottom:20px;max-height:200px;overflow-y:auto;}
  label{display:block;font-size:0.8rem;font-weight:700;color:#1e2d40;margin-bottom:6px;}
  textarea{width:100%;padding:12px;border:1px solid #dde3ea;border-radius:8px;
           font-family:Arial,sans-serif;font-size:0.875rem;resize:vertical;
           min-height:120px;color:#333;line-height:1.6;}
  textarea:focus{outline:none;border-color:#006868;box-shadow:0 0 0 3px rgba(244,121,32,.12);}
  .hint{font-size:0.72rem;color:#9aa5b4;margin-top:4px;}
  .actions{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap;}
  .btn-submit{background:#006868;color:#fff;border:none;padding:12px 28px;
              border-radius:8px;font-size:0.875rem;font-weight:700;cursor:pointer;}
  .btn-submit:hover{background:#d96a18;}
  .btn-approve{background:#f0f2f5;color:#1e2d40;border:1px solid #dde3ea;
               padding:12px 20px;border-radius:8px;font-size:0.875rem;
               font-weight:700;cursor:pointer;text-decoration:none;display:inline-block;}
  .icon{font-size:2.5rem;text-align:center;margin-bottom:12px;}
  .confirm-msg{text-align:center;padding:32px 24px;}
  .confirm-msg h2{color:#1e2d40;font-size:1.2rem;margin:8px 0 12px;}
  .confirm-msg p{color:#555;line-height:1.6;margin-bottom:16px;}
  .back{color:#006868;font-weight:bold;text-decoration:none;font-size:0.875rem;}
</style></head><body>
<div class="brand"><span class="brand-name"><span>Gastro Health Hub</span> ■</span></span></div>
${body}
</body></html>`;

// ── Feedback form page (shown for reject action) ─────────────────────────────
function feedbackPage(token, item) {
  const fullBody = (item.body || item.excerpt || '')
    .replace(/<[^>]+>/g, '')
    .replace(/#{1,6}\s*/g, '')
    .trim();

  return shell('Request Changes — ' + item.title, `
<div class="card">
  <div class="card-head">
    <h1>${escHtml(item.title)}</h1>
    ${item.category ? `<div class="cat">${escHtml(item.category)}</div>` : ''}
  </div>
  <div class="card-body">
    ${fullBody ? `
    <details open style="margin-bottom:20px;">
      <summary style="font-size:0.8rem;font-weight:700;color:#1e2d40;cursor:pointer;padding:8px 0;
                      list-style:none;display:flex;align-items:center;gap:6px;border-bottom:1px solid #dde3ea;padding-bottom:10px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
             style="width:13px;height:13px;flex-shrink:0;"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        Full Article — ${escHtml(item.title)}
      </summary>
      <div style="background:#f8f9fa;border:1px solid #dde3ea;border-top:none;border-radius:0 0 6px 6px;
                  padding:16px 18px;font-family:Georgia,serif;font-size:0.875rem;
                  line-height:1.8;color:#333;white-space:pre-wrap;
                  max-height:480px;overflow-y:auto;margin-bottom:8px;">${escHtml(fullBody)}</div>
    </details>` : ''}
    <form method="POST" action="/api/review/${escHtml(token)}">
      <label for="comment">Your feedback <span style="color:#9aa5b4;font-weight:400;">(required)</span></label>
      <textarea id="comment" name="comment" placeholder="Describe the changes needed — be as specific as possible…" required></textarea>
      <p class="hint">Your comment will be stored with the article and visible to the content team.</p>
      <div class="actions">
        <button type="submit" class="btn-submit">↩ Submit Changes Request</button>
      </div>
    </form>
  </div>
</div>`);
}

// ── Confirmation page ────────────────────────────────────────────────────────
function confirmPage(emoji, title, message) {
  return shell(title, `
<div class="card">
  <div class="confirm-msg">
    <div class="icon">${emoji}</div>
    <h2>${title}</h2>
    <p>${message}</p>
    <a class="back" href="/#pipeline">Return to app →</a>
  </div>
</div>`);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── HTTP handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const { token } = req.query;

  let payload;
  try {
    payload = await parseApprovalToken(token);
  } catch {
    res.setHeader('Content-Type', 'text/html');
    return res.status(400).send(confirmPage('⚠️', 'Link expired',
      'This review link has expired or is invalid. Please ask for a new review request.'));
  }

  const { contentId, reviewerId, action } = payload;
  const item = await kv.get(`content:${contentId}`);

  if (!item) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(404).send(confirmPage('🔍', 'Not found',
      'This content item no longer exists.'));
  }

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const alreadyVoted = item.approvals.includes(reviewerId) || item.rejections.includes(reviewerId);
    if (alreadyVoted) {
      res.setHeader('Content-Type', 'text/html');
      return res.send(confirmPage('✓', 'Already recorded',
        'Your response has already been recorded. Thank you!'));
    }

    if (action === 'reject') {
      // Show feedback form — don't process yet
      res.setHeader('Content-Type', 'text/html');
      return res.send(feedbackPage(token, item));
    }

    // action === 'approve' — process immediately
    item.approvals.push(reviewerId);
    item.status = computeNewStatus(item);
    item.updatedAt = new Date().toISOString();
    if (!item.approvedAt && item.status === 'approved') item.approvedAt = item.updatedAt;
    await kv.set(`content:${contentId}`, item);

    res.setHeader('Content-Type', 'text/html');
    return res.send(confirmPage('✅', 'Approved!',
      `You approved <strong>${escHtml(item.title)}</strong>. ${
        item.status === 'approved'
          ? 'It is now approved and ready to schedule.'
          : 'Waiting for remaining reviewers.'
      }`));
  }

  // ── POST (reject with comment) ────────────────────────────────────────────
  if (req.method === 'POST') {
    const alreadyVoted = item.approvals.includes(reviewerId) || item.rejections.includes(reviewerId);
    if (alreadyVoted) {
      res.setHeader('Content-Type', 'text/html');
      return res.send(confirmPage('✓', 'Already recorded',
        'Your response has already been recorded. Thank you!'));
    }

    // Parse form body (Vercel parses application/x-www-form-urlencoded into req.body)
    const comment = (req.body?.comment || '').toString().trim();
    if (!comment) {
      // Re-render form with error if comment is empty
      res.setHeader('Content-Type', 'text/html');
      return res.status(400).send(feedbackPage(token, item));
    }

    const now = new Date().toISOString();
    item.rejections.push(reviewerId);
    item.rejectionComments = [
      ...(item.rejectionComments || []),
      { reviewerId, comment, at: now },
    ];
    item.status = computeNewStatus(item);
    item.updatedAt = now;
    await kv.set(`content:${contentId}`, item);

    res.setHeader('Content-Type', 'text/html');
    return res.send(confirmPage('↩️', 'Changes Requested',
      `Thank you. Your feedback on <strong>${escHtml(item.title)}</strong> has been recorded. The content team will review your comments.`));
  }

  res.status(405).end();
}

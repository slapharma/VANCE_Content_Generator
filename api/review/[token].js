import { kv } from '../../lib/kv.js';
import { parseApprovalToken } from '../review/send.js';
import { renderArticleEmailContent } from '../../lib/email-content.js';
import { logEvent } from '../../lib/article-history.js';

// Render the full article inline using the same rich renderer the review
// email uses — hero image + formatted markdown body. Wrapped in a scrollable
// container so the form stays visible for long articles.
function fullArticleBlockHtml(item, { selectable = false } = {}) {
  const rendered = renderArticleEmailContent({
    title:        item?.title,
    body:         item?.body,
    excerpt:      item?.excerpt,
    heroImageUrl: item?.heroImageUrl,
    category:     item?.category,
  });
  if (!rendered) return '';
  const cls = selectable ? ' class="article-block"' : '';
  return `<div${cls} style="max-height:560px;overflow-y:auto;margin-bottom:22px;border:1px solid #dde3ea;border-radius:8px;">${rendered}</div>`;
}

// Inline-comment widget — same widget the automation feedback page uses. See
// lib/automation/handlers/approve.js HIGHLIGHT_SCRIPT for the canonical copy.
// Kept duplicated here so this endpoint stays standalone (no shared client-asset bundling).
const HIGHLIGHT_SCRIPT = `
(function(){
  var article = document.querySelector('.article-block');
  var notesList = document.getElementById('inlineNotesList');
  var hiddenField = document.getElementById('highlightsField');
  var commentEl = document.getElementById('comment');
  var form = commentEl ? commentEl.closest('form') : null;
  if (!article || !notesList || !hiddenField || !commentEl || !form) return;

  var highlights = [];
  var nextId = 1;
  var pendingSelection = null;
  var pill = null, popover = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function clearPill() { if (pill) { pill.remove(); pill = null; } }
  function clearPopover() { if (popover) { popover.remove(); popover = null; } pendingSelection = null; }

  article.addEventListener('mouseup', function(){
    setTimeout(function(){
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) { clearPill(); return; }
      var text = sel.toString().trim();
      if (!text || !article.contains(sel.anchorNode) || !article.contains(sel.focusNode)) { clearPill(); return; }
      var range = sel.getRangeAt(0);
      var rect = range.getBoundingClientRect();
      pendingSelection = { range: range.cloneRange(), quote: text };
      clearPill();
      pill = document.createElement('button');
      pill.type = 'button';
      pill.textContent = '💬 Add comment';
      pill.style.cssText = 'position:fixed;background:#1e2d40;color:#fff;border:none;padding:6px 12px;font-size:0.7rem;font-weight:700;cursor:pointer;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.25);border-radius:4px;font-family:Arial,sans-serif;';
      pill.style.left = Math.max(8, Math.min(window.innerWidth - 140, rect.left + rect.width/2 - 60)) + 'px';
      pill.style.top  = Math.max(8, rect.top - 38) + 'px';
      pill.addEventListener('click', openPopover);
      document.body.appendChild(pill);
    }, 10);
  });

  document.addEventListener('mousedown', function(e){
    if (pill && !pill.contains(e.target)) clearPill();
    if (popover && !popover.contains(e.target) && (!pill || !pill.contains(e.target))) {
      if (e.target !== pill) clearPopover();
    }
  });

  function openPopover() {
    if (!pendingSelection) return;
    var sel = pendingSelection;
    clearPill();
    clearPopover();
    pendingSelection = sel;
    popover = document.createElement('div');
    popover.style.cssText = 'position:fixed;background:#fff;border:1px solid #006868;padding:14px;width:340px;max-width:92vw;z-index:10000;box-shadow:0 12px 32px rgba(0,0,0,0.22);border-radius:6px;font-family:Arial,sans-serif;';
    popover.innerHTML =
      '<div style="font-size:0.66rem;color:#6b7a8d;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:6px;">Quoting</div>' +
      '<div style="font-size:0.8rem;color:#1e2d40;font-style:italic;background:#fff3cd;padding:6px 8px;margin-bottom:10px;max-height:90px;overflow-y:auto;border-left:3px solid #f0ad4e;">' + escapeHtml(sel.quote) + '</div>' +
      '<textarea id="__hlComment" placeholder="Your comment on this passage…" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #dde3ea;font-family:Arial,sans-serif;font-size:0.8rem;min-height:80px;resize:vertical;border-radius:4px;"></textarea>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">' +
        '<button type="button" data-action="cancel" style="padding:6px 14px;background:#f0f2f5;color:#1e2d40;border:1px solid #dde3ea;font-size:0.72rem;cursor:pointer;border-radius:4px;font-family:inherit;">Cancel</button>' +
        '<button type="button" data-action="save" style="padding:6px 14px;background:#006868;color:#fff;border:none;font-size:0.72rem;cursor:pointer;font-weight:700;border-radius:4px;font-family:inherit;">Save note</button>' +
      '</div>';
    var rect = sel.range.getBoundingClientRect();
    var top = rect.bottom + 12;
    if (top + 220 > window.innerHeight) top = Math.max(8, rect.top - 230);
    popover.style.left = Math.max(8, Math.min(window.innerWidth - 360, rect.left)) + 'px';
    popover.style.top  = top + 'px';
    document.body.appendChild(popover);
    var ta = popover.querySelector('#__hlComment');
    setTimeout(function(){ ta.focus(); }, 0);
    popover.querySelector('[data-action=cancel]').addEventListener('click', function(){ clearPopover(); });
    popover.querySelector('[data-action=save]').addEventListener('click', function(){
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      var id = nextId++;
      try {
        var mark = document.createElement('mark');
        mark.style.cssText = 'background:#fff3cd;padding:1px 2px;border-bottom:1px solid #f0ad4e;border-radius:2px;';
        mark.setAttribute('data-note-id', String(id));
        mark.title = text;
        sel.range.surroundContents(mark);
      } catch (e) {}
      highlights.push({ id: id, quote: sel.quote, comment: text });
      renderNotes();
      clearPopover();
    });
  }

  function renderNotes() {
    if (!highlights.length) {
      notesList.style.display = 'none';
      hiddenField.value = '[]';
      return;
    }
    notesList.style.display = '';
    var rows = highlights.map(function(h){
      var qShort = h.quote.length > 120 ? h.quote.slice(0,120) + '…' : h.quote;
      return '<div style="background:#fffbf0;border-left:3px solid #f0ad4e;padding:8px 10px;margin-bottom:6px;border-radius:0 4px 4px 0;font-size:0.74rem;font-family:Arial,sans-serif;">' +
        '<div style="font-style:italic;color:#6b7a8d;margin-bottom:4px;">"' + escapeHtml(qShort) + '"</div>' +
        '<div style="color:#1e2d40;white-space:pre-wrap;">' + escapeHtml(h.comment) + '</div>' +
        '<button type="button" data-remove="' + h.id + '" style="background:none;border:none;color:#c0392b;font-size:0.66rem;cursor:pointer;padding:2px 0;margin-top:4px;font-family:inherit;">Remove</button>' +
      '</div>';
    }).join('');
    notesList.innerHTML =
      '<div style="font-size:0.7rem;font-weight:800;color:#1e2d40;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.6px;font-family:Arial,sans-serif;">Inline notes (' + highlights.length + ')</div>' + rows;
    notesList.querySelectorAll('[data-remove]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = Number(btn.getAttribute('data-remove'));
        var idx = -1;
        for (var i = 0; i < highlights.length; i++) { if (highlights[i].id === id) { idx = i; break; } }
        if (idx === -1) return;
        highlights.splice(idx, 1);
        var mark = article.querySelector('mark[data-note-id="' + id + '"]');
        if (mark && mark.parentNode) {
          var parent = mark.parentNode;
          while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
          parent.removeChild(mark);
        }
        renderNotes();
      });
    });
    hiddenField.value = JSON.stringify(highlights.map(function(h){ return { quote: h.quote, comment: h.comment }; }));
  }

  form.addEventListener('submit', function(){
    // Preserve the reviewer's raw overall feedback separately from the merged
    // comment, so view-article can surface it on its own (above the inline notes).
    var overallField = document.getElementById('overallField');
    if (overallField) overallField.value = (commentEl.value || '').trim();
    if (!highlights.length) return;
    var preamble = highlights.map(function(h){
      return '> "' + h.quote.replace(/\\s+/g,' ').trim() + '"\\n↳ ' + h.comment;
    }).join('\\n\\n');
    var existing = (commentEl.value || '').trim();
    commentEl.value = preamble + (existing ? '\\n\\n' + existing : '');
  });
})();
`;

export function computeNewStatus(item) {
  // "Request changes" is feedback, not a veto. Comments are stored in
  // item.rejections / item.rejectionComments but no longer terminate the review.
  // The article stays in_review until enough APPROVALS arrive to meet the threshold.
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

// ── Approve confirmation page (shown for approve action) ─────────────────────
// Email link-scanners (Outlook Safe Links, Gmail prefetch, antivirus crawlers)
// HEAD/GET every link in an email — so a bare GET on approve gets clicked by
// the scanner before the human ever sees the email. Render a form instead and
// only process the approval on the explicit POST from this page.
function approveConfirmPage(token, item) {
  return shell('Confirm Approval — ' + item.title, `
<div class="card">
  <div class="card-head">
    <h1>${escHtml(item.title)}</h1>
    ${item.category ? `<div class="cat">${escHtml(item.category)}</div>` : ''}
    ${item.sourceDocName ? `<div class="cat" style="margin-top:6px;"><span style="opacity:0.75;">Source:</span> ${
      item.sourceDocUrl
        ? `<a href="${escHtml(item.sourceDocUrl)}" style="color:#7dd3fc;text-decoration:underline;">${escHtml(item.sourceDocName)}</a>`
        : escHtml(item.sourceDocName)
    }</div>` : ''}
  </div>
  <div class="card-body">
    ${fullArticleBlockHtml(item)}
    <p style="font-size:0.875rem;color:#555;margin:0 0 16px;line-height:1.5;">
      Click <strong>Confirm Approval</strong> to record your approval of this article. This extra step prevents email link-scanners (Outlook Safe Links, Gmail) from voting on your behalf.
    </p>
    <form method="POST" action="/api/review/${escHtml(token)}">
      <input type="hidden" name="action" value="approve">
      <button type="submit" class="btn-submit">✅ Confirm Approval</button>
    </form>
  </div>
</div>`);
}

// ── Feedback form page (shown for reject action) ─────────────────────────────
function feedbackPage(token, item) {
  return shell('Request Changes — ' + item.title, `
<div class="card">
  <div class="card-head">
    <h1>${escHtml(item.title)}</h1>
    ${item.category ? `<div class="cat">${escHtml(item.category)}</div>` : ''}
    ${item.sourceDocName ? `<div class="cat" style="margin-top:6px;"><span style="opacity:0.75;">Source:</span> ${
      item.sourceDocUrl
        ? `<a href="${escHtml(item.sourceDocUrl)}" style="color:#7dd3fc;text-decoration:underline;">${escHtml(item.sourceDocName)}</a>`
        : escHtml(item.sourceDocName)
    }</div>` : ''}
  </div>
  <div class="card-body">
    <p style="font-size:0.78rem;color:#006868;background:#f0fafa;border-left:3px solid #006868;padding:8px 10px;margin:0 0 14px;border-radius:0 4px 4px 0;">💡 <strong>Tip:</strong> highlight any passage in the article to leave an inline comment on that specific text, in addition to your overall feedback below.</p>
    ${fullArticleBlockHtml(item, { selectable: true })}
    <div id="inlineNotesList" style="display:none;margin-bottom:18px;"></div>
    <form method="POST" action="/api/review/${escHtml(token)}">
      <input type="hidden" name="highlights" id="highlightsField" value="[]" />
      <input type="hidden" name="overallComment" id="overallField" value="" />
      <label for="comment">Overall feedback <span style="color:#9aa5b4;font-weight:400;">(optional)</span></label>
      <textarea id="comment" name="comment" placeholder="Add any overall feedback — or leave blank if your inline notes say it all…"></textarea>
      <p class="hint">Leave inline notes by highlighting passages above, add overall feedback here, or both. At least one is required.</p>
      <div class="actions">
        <button type="submit" class="btn-submit">↩ Submit Changes Request</button>
      </div>
    </form>
  </div>
</div>
<script>${HIGHLIGHT_SCRIPT}</script>`);
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

  // ── GET — render only, never mutate ──────────────────────────────────────
  // Email link-scanners (Outlook Safe Links, Gmail prefetch) GET every URL in
  // an inbound email before the user sees it. Any state change on GET will be
  // executed by the scanner, not the human. So both approve and reject GETs
  // render a confirmation form and wait for an explicit POST.
  if (req.method === 'GET') {
    const alreadyVoted = item.approvals.includes(reviewerId) || item.rejections.includes(reviewerId);
    if (alreadyVoted) {
      res.setHeader('Content-Type', 'text/html');
      return res.send(confirmPage('✓', 'Already recorded',
        'Your response has already been recorded. Thank you!'));
    }

    if (action === 'reject') {
      res.setHeader('Content-Type', 'text/html');
      return res.send(feedbackPage(token, item));
    }
    // action === 'approve'
    res.setHeader('Content-Type', 'text/html');
    return res.send(approveConfirmPage(token, item));
  }

  // ── POST — actual vote, both approve and reject ──────────────────────────
  if (req.method === 'POST') {
    const alreadyVoted = item.approvals.includes(reviewerId) || item.rejections.includes(reviewerId);
    if (alreadyVoted) {
      res.setHeader('Content-Type', 'text/html');
      return res.send(confirmPage('✓', 'Already recorded',
        'Your response has already been recorded. Thank you!'));
    }

    const now = new Date().toISOString();

    if (action === 'approve') {
      item.approvals.push(reviewerId);
      item.status = computeNewStatus(item);
      item.updatedAt = now;
      if (!item.approvedAt && item.status === 'approved') item.approvedAt = now;
      logEvent(item, { type: 'approve', actor: reviewerId, at: now });
      await kv.set(`content:${contentId}`, item);

      res.setHeader('Content-Type', 'text/html');
      return res.send(confirmPage('✅', 'Approved!',
        `You approved <strong>${escHtml(item.title)}</strong>. ${
          item.status === 'approved'
            ? 'It is now approved and ready to schedule.'
            : 'Waiting for remaining reviewers.'
        }`));
    }

    // Request changes — overall feedback is now OPTIONAL, but the reviewer must
    // leave SOMETHING: either overall feedback or at least one inline note.
    const comment = (req.body?.comment || '').toString().trim();
    // The raw overall feedback, captured separately from the merged `comment`
    // (which also carries the inline-note preamble) so view-article can show it
    // on its own. Falls back to `comment` for older clients that don't send it.
    const overall = (req.body?.overallComment != null ? req.body.overallComment : req.body?.comment || '')
      .toString().trim();

    // Inline highlights from the Google-Docs-style commenting widget. The
    // widget also prepends them to `comment` client-side, so legacy views see
    // them; we additionally store the structured form for future surfaces.
    let highlights = [];
    if (typeof req.body?.highlights === 'string') {
      try {
        const parsed = JSON.parse(req.body.highlights);
        if (Array.isArray(parsed)) {
          highlights = parsed
            .filter(h => h && typeof h.quote === 'string' && typeof h.comment === 'string')
            .map(h => ({ quote: h.quote.slice(0, 1000), comment: h.comment.slice(0, 2000) }));
        }
      } catch (_) { /* ignore malformed payload */ }
    }

    if (!comment && !highlights.length) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(400).send(feedbackPage(token, item));
    }

    item.rejections.push(reviewerId);
    item.rejectionComments = [
      ...(item.rejectionComments || []),
      { reviewerId, comment, overall, at: now, highlights },
    ];
    item.status = computeNewStatus(item);
    item.updatedAt = now;
    logEvent(item, {
      type: 'change_request', actor: reviewerId, at: now,
      detail: { hasOverall: !!overall, inlineNotes: highlights.length },
    });
    await kv.set(`content:${contentId}`, item);

    res.setHeader('Content-Type', 'text/html');
    return res.send(confirmPage('↩️', 'Changes Requested',
      `Thank you. Your feedback on <strong>${escHtml(item.title)}</strong> has been recorded. The content team will review your comments.`));
  }

  res.status(405).end();
}

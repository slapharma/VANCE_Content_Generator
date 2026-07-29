// lib/automation/handlers/approve.js
import { kv } from '../../kv.js';
import { jwtVerify } from 'jose';
import { writeLog } from '../log.js';
import { renderArticleEmailContent } from '../../email-content.js';

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-secret-replace-in-production');
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

const TERMINAL_STATUSES = ['approved', 'rejected', 'published', 'timed_out', 'auto_published'];

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Minimal page shell matching /api/review/[token] styling for visual continuity.
function pageShell(title, inner) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)} — Vance Content</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:Arial,sans-serif;background:#f0f2f5;min-height:100vh;padding:24px 16px;}
.brand{display:flex;align-items:center;gap:8px;margin-bottom:24px;justify-content:center;}
.brand-name{color:#1e2d40;font-weight:800;font-size:18px;letter-spacing:1px;}
.brand-name span{color:#006868;}
.card{max-width:640px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 2px 20px rgba(30,45,64,.1);overflow:hidden;}
.card-head{background:#1e2d40;border-bottom:3px solid #006868;padding:20px 24px;}
.card-head h1{color:#fff;font-size:1.1rem;line-height:1.4;}
.card-head .cat{color:rgba(255,255,255,0.55);font-size:0.75rem;margin-top:4px;}
.card-body{padding:24px;}
label{display:block;font-size:0.8rem;font-weight:700;color:#1e2d40;margin-bottom:6px;}
input,textarea{width:100%;padding:10px 12px;border:1px solid #dde3ea;border-radius:8px;font-family:Arial,sans-serif;font-size:0.875rem;color:#333;line-height:1.6;}
textarea{min-height:120px;resize:vertical;}
input:focus,textarea:focus{outline:none;border-color:#006868;box-shadow:0 0 0 3px rgba(0,104,104,.12);}
.hint{font-size:0.72rem;color:#9aa5b4;margin:4px 0 14px;}
.btn-submit{background:#006868;color:#fff;border:none;padding:12px 28px;border-radius:8px;font-size:0.875rem;font-weight:700;cursor:pointer;}
.icon{font-size:2.5rem;text-align:center;margin-bottom:12px;}
.confirm{text-align:center;padding:32px 24px;}
.confirm h2{color:#1e2d40;font-size:1.2rem;margin:8px 0 12px;}
.confirm p{color:#555;line-height:1.6;margin-bottom:16px;}
.back{color:#006868;font-weight:bold;text-decoration:none;font-size:0.875rem;}
</style></head><body>
<div class="brand"><span class="brand-name"><span>Vance Content</span> ■</span></div>
${inner}
</body></html>`;
}

function confirmPage(emoji, title, message) {
  return pageShell(title, `<div class="card"><div class="confirm"><div class="icon">${emoji}</div><h2>${escHtml(title)}</h2><p>${message}</p><a class="back" href="${APP_URL}">Return to app →</a></div></div>`);
}

// Render the full article inline using the same rich renderer the review
// email uses — hero image on top, markdown headings/paragraphs/lists. Lets
// the reviewer see exactly what will publish, instead of a stripped plain-text
// preview. Wrapped in a scrollable container so long articles don't push the
// form off-screen.
function fullArticleBlockHtml(content, { selectable = false } = {}) {
  const rendered = renderArticleEmailContent({
    title:        content?.title,
    body:         content?.body,
    excerpt:      content?.excerpt,
    heroImageUrl: content?.heroImageUrl,
    category:     content?.category,
  });
  if (!rendered) return '';
  // `selectable` adds a hook the inline-commenting JS uses to scope mouseup
  // listeners and DOM ranges to article content only (so toolbars/forms can't
  // be accidentally annotated).
  const cls = selectable ? ' class="article-block"' : '';
  return `<div${cls} style="max-height:560px;overflow-y:auto;margin-bottom:22px;border:1px solid #dde3ea;border-radius:8px;">${rendered}</div>`;
}

// Inline-comment widget script. Injected into the feedback page so reviewers
// can highlight text in the rendered article and attach a comment to that
// passage, Google-Docs / Word style. Highlights are serialised into a hidden
// form field and also prepended to the main comment textarea on submit so
// every downstream view (Review Requests card, pipeline) surfaces them.
const HIGHLIGHT_SCRIPT = `
(function(){
  var article = document.querySelector('.article-block');
  var notesList = document.getElementById('inlineNotesList');
  var hiddenField = document.getElementById('highlightsField');
  var commentEl = document.getElementById('comment');
  var form = commentEl ? commentEl.closest('form') : null;
  if (!article || !notesList || !hiddenField || !commentEl || !form) return;

  var highlights = []; // { id, quote, comment }
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
      // close popover only on a click outside, not on its own clicks
      if (e.target !== pill) clearPopover();
    }
  });

  function openPopover() {
    if (!pendingSelection) return;
    var sel = pendingSelection;
    clearPill();
    clearPopover();
    pendingSelection = sel; // keep for the save handler
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
      } catch (e) { /* range spans element boundaries — leave unmarked */ }
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
    // Surface inline notes inside the main comment so legacy renders show them.
    if (!highlights.length) return;
    var preamble = highlights.map(function(h){
      return '> "' + h.quote.replace(/\\s+/g,' ').trim() + '"\\n↳ ' + h.comment;
    }).join('\\n\\n');
    var existing = (commentEl.value || '').trim();
    commentEl.value = preamble + (existing ? '\\n\\n' + existing : '');
  });
})();
`;

function approveConfirmPage(token, content, reviewerName = '') {
  const knownReviewer = reviewerName && reviewerName.indexOf('@') === -1;
  const reviewerLine = knownReviewer
    ? `<p style="font-size:0.78rem;color:#1e2d40;margin:0 0 14px;">Signed in via email as <strong>${escHtml(reviewerName)}</strong></p>`
    : '';
  return pageShell('Confirm Approval', `
<div class="card">
  <div class="card-head">
    <h1>${escHtml(content?.title || 'Article')}</h1>
    ${content?.category ? `<div class="cat">${escHtml(content.category)}</div>` : ''}
  </div>
  <div class="card-body">
    ${fullArticleBlockHtml(content)}
    ${reviewerLine}
    <p style="font-size:0.875rem;color:#555;margin:0 0 16px;line-height:1.5;">
      Click <strong>Confirm Approval</strong> to record your approval of this article. This extra step prevents email link-scanners (Outlook Safe Links, Gmail) from voting on your behalf.
    </p>
    <form method="POST" action="/api/automation/approve?token=${escHtml(token)}">
      <button type="submit" class="btn-submit" style="background:#006868;">✅ Confirm Approval</button>
    </form>
  </div>
</div>`);
}

function feedbackPage(token, content, reviewerName = '') {
  // If we know who the reviewer is (token had reviewerId that resolved to a user),
  // show their name and skip the input — comment will be attributed automatically.
  const knownReviewer = reviewerName && reviewerName.indexOf('@') === -1;
  const reviewerField = knownReviewer
    ? `<p style="font-size:0.78rem;color:#1e2d40;margin:0 0 14px;">Signed in via email as <strong>${escHtml(reviewerName)}</strong></p>`
    : `<label for="reviewer">Your name <span style="color:#9aa5b4;font-weight:400;">${reviewerName ? '(confirm)' : '(optional)'}</span></label>
       <input id="reviewer" name="reviewer" value="${escHtml(reviewerName)}" placeholder="e.g. Mia Yaniv"/>
       <div style="height:14px;"></div>`;
  return pageShell('Request Changes', `
<div class="card">
  <div class="card-head">
    <h1>${escHtml(content?.title || 'Article')}</h1>
    ${content?.category ? `<div class="cat">${escHtml(content.category)}</div>` : ''}
  </div>
  <div class="card-body">
    <p style="font-size:0.78rem;color:#006868;background:#f0fafa;border-left:3px solid #006868;padding:8px 10px;margin:0 0 14px;border-radius:0 4px 4px 0;">💡 <strong>Tip:</strong> highlight any passage in the article to leave an inline comment on that specific text, in addition to your overall feedback below.</p>
    ${fullArticleBlockHtml(content, { selectable: true })}
    <div id="inlineNotesList" style="display:none;margin-bottom:18px;"></div>
    <form method="POST" action="/api/automation/approve?token=${escHtml(token)}">
      <input type="hidden" name="highlights" id="highlightsField" value="[]" />
      ${reviewerField}
      <label for="comment">Overall feedback <span style="color:#9aa5b4;font-weight:400;">(required)</span></label>
      <textarea id="comment" name="comment" placeholder="Describe the changes needed — be as specific as possible…" required></textarea>
      <p class="hint">Your feedback (including inline notes) will be stored with the article and visible to the content team.</p>
      <button type="submit" class="btn-submit">↩ Submit change request</button>
    </form>
  </div>
</div>
<script>${HIGHLIGHT_SCRIPT}</script>`);
}

// GET /api/automation/approve?token=<jwt> — email link click
// POST /api/automation/approve — Telegram webhook / manual / timeout / feedback-form submit
// Resolve a reviewerId (either a user.id UUID or a raw email) to a display name.
async function resolveReviewerName(reviewerId) {
  if (!reviewerId) return '';
  if (reviewerId.includes('@')) return reviewerId; // external email — just show it
  const users = (await kv.get('users')) ?? (await kv.get('reviewers')) ?? [];
  const u = users.find(x => x.id === reviewerId);
  return u ? (u.name || u.email || '') : '';
}

export default async function handler(req, res) {
  let jobId, action, channel, reviewerId;
  let token = req.query?.token;

  if (req.method === 'GET') {
    // Email link: /api/automation/approve?token=<jwt>
    try {
      const { payload } = await jwtVerify(token, secret);
      jobId = payload.jobId;
      action = payload.action;
      reviewerId = payload.reviewerId || null;
      channel = 'email';
    } catch {
      res.setHeader('Content-Type', 'text/html');
      return res.status(400).send(confirmPage('⚠️', 'Link expired', 'This review link has expired or is invalid. Please ask for a new review request.'));
    }

    // Email link GETs never mutate — both approve and reject just render a
    // confirmation page so email link-scanners (Outlook Safe Links, Gmail's
    // prefetch, antivirus crawlers) can't cast a vote on the reviewer's behalf.
    if (action === 'approve' || action === 'reject') {
      const job = await kv.get(`automation:job:${jobId}`);
      if (!job) {
        res.setHeader('Content-Type', 'text/html');
        return res.status(404).send(confirmPage('🔍', 'Not found', 'This job no longer exists.'));
      }
      if (TERMINAL_STATUSES.includes(job.status)) {
        // Tell the reviewer exactly how this ended up terminal so they're not left
        // wondering whether their click did anything. Common case: cron auto-approved
        // it on timeout before they clicked.
        const when = job.approvedAt || job.rejectedAt || job.updatedAt || job.createdAt;
        const whenStr = when ? new Date(when).toUTCString() : '';
        const byRaw = job.approvedBy || '';
        const byHuman = byRaw === 'timeout'
          ? 'an automatic timeout (no reviewer responded within the rule\'s review window)'
          : byRaw === 'auto'
            ? 'auto-publish (this rule does not require review)'
            : byRaw === 'email'
              ? 'an email reviewer'
              : byRaw === 'telegram'
                ? 'a Telegram reviewer'
                : byRaw || 'an unknown channel';
        const msg = `This article was already <strong>${escHtml(job.status)}</strong>${whenStr ? ` on ${escHtml(whenStr)}` : ''} by ${escHtml(byHuman)}.<br><br>If this isn't what you intended, open the dashboard to reverse the action or to flag the article for re-review.`;
        res.setHeader('Content-Type', 'text/html');
        return res.status(409).send(confirmPage('✓', 'Already recorded', msg));
      }
      const content = await kv.get(`content:${job.contentId}`);
      const reviewerName = await resolveReviewerName(reviewerId);
      res.setHeader('Content-Type', 'text/html');
      return res.send(
        action === 'approve'
          ? approveConfirmPage(token, content, reviewerName)
          : feedbackPage(token, content, reviewerName)
      );
    }
  } else if (req.method === 'POST') {
    // Two POST flavours:
    //   (a) feedback-form submit — has ?token=...&comment=...
    //   (b) internal/Telegram — JSON body with {jobId, action, channel}
    if (token) {
      try {
        const { payload } = await jwtVerify(token, secret);
        jobId = payload.jobId;
        action = payload.action;
        reviewerId = payload.reviewerId || null;
        channel = 'email';
      } catch {
        res.setHeader('Content-Type', 'text/html');
        return res.status(400).send(confirmPage('⚠️', 'Link expired', 'This review link has expired or is invalid.'));
      }
    } else {
      ({ jobId, action, channel } = req.body);
      if (!jobId || !action) return res.status(400).json({ error: 'jobId and action required' });
    }
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const job = await kv.get(`automation:job:${jobId}`);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const isHtmlContext = req.method === 'GET' || (req.method === 'POST' && token);

  if (TERMINAL_STATUSES.includes(job.status)) {
    if (isHtmlContext) {
      const when = job.approvedAt || job.rejectedAt || job.updatedAt || job.createdAt;
      const whenStr = when ? new Date(when).toUTCString() : '';
      const byRaw = job.approvedBy || '';
      const byHuman = byRaw === 'timeout'
        ? 'an automatic timeout (no reviewer responded within the rule\'s review window)'
        : byRaw === 'auto' ? 'auto-publish (this rule does not require review)'
        : byRaw === 'email' ? 'an email reviewer'
        : byRaw === 'telegram' ? 'a Telegram reviewer'
        : byRaw || 'an unknown channel';
      const msg = `This article was already <strong>${escHtml(job.status)}</strong>${whenStr ? ` on ${escHtml(whenStr)}` : ''} by ${escHtml(byHuman)}.<br><br>Open the dashboard to reverse or re-review.`;
      res.setHeader('Content-Type', 'text/html');
      return res.status(409).send(confirmPage('✓', 'Already recorded', msg));
    }
    return res.status(409).json({ error: `Job already ${job.status}` });
  }

  const now = new Date().toISOString();
  const rule = await kv.get(`automation:rule:${job.ruleId}`);
  const voterId = reviewerId || channel || 'anonymous';
  const priorApprovals = Array.isArray(job.approvals) ? job.approvals : [];
  const priorRejections = Array.isArray(job.rejections) ? job.rejections : [];
  const reviewerIds = Array.isArray(job.reviewerIds) ? job.reviewerIds : [];
  const mode = rule?.review?.mode ?? 'any';

  if (action === 'approve') {
    if (priorApprovals.includes(voterId) || priorRejections.includes(voterId)) {
      if (isHtmlContext) {
        res.setHeader('Content-Type', 'text/html');
        return res.status(409).send(confirmPage('✓', 'Already recorded', 'You have already responded to this review. Thank you.'));
      }
      return res.status(409).json({ error: 'reviewer already voted', jobId });
    }

    const newApprovals = [...priorApprovals, voterId];
    // mode === 'all' requires every known reviewer to approve. Fall back to "any"
    // when reviewerIds is empty (legacy jobs created before tracking landed).
    const needsAll = mode === 'all' && reviewerIds.length > 0;
    const threshold = needsAll ? reviewerIds.length : 1;
    const reachedThreshold = newApprovals.length >= threshold;

    if (!reachedThreshold) {
      await kv.set(`automation:job:${jobId}`, {
        ...job, approvals: newApprovals, updatedAt: now,
      });

      // Mirror the partial approval onto the content item so the Pipeline kanban
      // card shows the progress bar advancing (e.g. "1 / 6 approved"). We sync
      // the FULL approval set from the job (newApprovals) rather than just
      // appending voterId — this self-heals legacy items where prior votes were
      // recorded on the job but never mirrored to the content.
      const contentItem = await kv.get(`content:${job.contentId}`);
      if (contentItem && contentItem.status !== 'published' && contentItem.status !== 'approved') {
        await kv.set(`content:${job.contentId}`, {
          ...contentItem,
          // Promote 'draft' to 'in_review' on first vote — covers legacy items
          // generated before run.js gained the up-front in_review sync.
          status: contentItem.status === 'draft' ? 'in_review' : contentItem.status,
          approvals: newApprovals, // full set from job — heals any prior missing mirrors
          // Backfill reviewers from the job if the content doesn't have them yet
          reviewers: Array.isArray(contentItem.reviewers) && contentItem.reviewers.length
            ? contentItem.reviewers
            : reviewerIds,
          requireAllApprovals: contentItem.requireAllApprovals ?? (mode === 'all'),
          updatedAt: now,
        });
      }

      const remaining = threshold - newApprovals.length;
      await writeLog({ ruleId: job.ruleId, ruleName: rule?.name, level: 'info', message: `Approval ${newApprovals.length}/${threshold} via ${channel} by ${(await resolveReviewerName(reviewerId)) || voterId}`, jobId, contentId: job.contentId });
      if (isHtmlContext) {
        const name = (await resolveReviewerName(reviewerId)) || 'reviewer';
        res.setHeader('Content-Type', 'text/html');
        return res.send(confirmPage('✓', 'Approval recorded', `Thank you, ${escHtml(name)}. Waiting for ${remaining} more reviewer${remaining === 1 ? '' : 's'} to approve before this article is published.`));
      }
      return res.status(200).json({ status: 'pending_review', approvals: newApprovals.length, threshold });
    }

    // Threshold met — transition to approved, sync content, then attempt publish.
    const updated = {
      ...job, approvals: newApprovals, status: 'approved',
      approvedAt: now, approvedBy: channel, updatedAt: now,
    };
    await kv.set(`automation:job:${jobId}`, updated);

    // Sync content.status so the dashboard reflects approval even when publish is disabled / fails.
    const contentItem = await kv.get(`content:${job.contentId}`);
    if (contentItem && contentItem.status !== 'published') {
      await kv.set(`content:${job.contentId}`, {
        ...contentItem,
        status: 'approved',
        approvals: Array.from(new Set([...(contentItem.approvals || []), ...newApprovals])),
        approvedAt: contentItem.approvedAt || now,
        updatedAt: now,
      });
    }

    if (rule?.publish?.wordpress) {
      try {
        const publishRes = await fetch(`${APP_URL}/api/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentId: job.contentId }),
        });
        if (publishRes.ok) {
          await kv.set(`automation:job:${jobId}`, { ...updated, status: 'published' });
          // Bump rule.articlesPublished + log
          if (rule) {
            await kv.set(`automation:rule:${rule.id}`, {
              ...rule,
              updatedAt: now,
              stats: {
                ...(rule.stats || {}),
                articlesPublished: ((rule.stats && rule.stats.articlesPublished) || 0) + 1,
              },
            });
          }
          await writeLog({ ruleId: job.ruleId, ruleName: rule?.name, level: 'success', message: `Published after ${channel} approval`, jobId, contentId: job.contentId });
        } else {
          console.error('Publish after approval failed: HTTP', publishRes.status);
          await writeLog({ ruleId: job.ruleId, ruleName: rule?.name, level: 'error', message: `Publish failed (HTTP ${publishRes.status})`, jobId, contentId: job.contentId });
        }
      } catch (err) {
        // Publish failed — job stays 'approved', not 'published'
        console.error('Publish after approval failed:', err.message);
        await writeLog({ ruleId: job.ruleId, ruleName: rule?.name, level: 'error', message: `Publish failed: ${err.message}`, jobId, contentId: job.contentId });
      }
    }

    // The Instagram carousel used to be actioned here, after the publish attempt.
    // It is now driven from api/publish itself (lib/social/carousel-on-publish.js),
    // which is both a superset of this — it builds the deck as well as actioning
    // it, and covers the cron and manual publish paths too — and a fix for the
    // bug this block had: it ran whether or not the publish above had actually
    // succeeded, so a WordPress failure still let the deck post to Instagram with
    // a caption whose "read the full article" link resolved to nothing.

    if (req.method === 'GET') return res.redirect(302, `${APP_URL}?approved=1`);
    return res.status(200).json({ status: 'approved', jobId });
  }

  if (action === 'reject') {
    const fromForm = req.method === 'POST' && token; // came from feedback form
    const rawComment = fromForm ? (req.body?.comment || '').toString().trim() : '';
    const reviewerName = fromForm ? (req.body?.reviewer || '').toString().trim() : '';

    if (fromForm && !rawComment) {
      // Re-render the form requiring a comment
      const content = await kv.get(`content:${job.contentId}`);
      const reviewerNameForForm = reviewerName || await resolveReviewerName(reviewerId);
      res.setHeader('Content-Type', 'text/html');
      return res.status(400).send(feedbackPage(token, content, reviewerNameForForm));
    }

    // Prefer the token's reviewerId for attribution; fall back to the form name.
    // The frontend's reviewerName(id) helper looks the user up in the directory, so
    // storing the user.id here makes the pipeline card say "Mia Yaniv requested changes".
    const attributedId = reviewerId || reviewerName || 'email-reviewer';
    const displayName = (await resolveReviewerName(reviewerId)) || reviewerName || 'email reviewer';

    // Inline highlight notes — JSON array of { quote, comment } pairs from the
    // Google-Docs-style commenting widget in feedbackPage. The widget also
    // prepends them to rawComment client-side, so legacy views still display
    // them; we additionally store the structured form for future surfaces.
    let highlights = [];
    if (fromForm && typeof req.body?.highlights === 'string') {
      try {
        const parsed = JSON.parse(req.body.highlights);
        if (Array.isArray(parsed)) {
          highlights = parsed
            .filter(h => h && typeof h.quote === 'string' && typeof h.comment === 'string')
            .map(h => ({ quote: h.quote.slice(0, 1000), comment: h.comment.slice(0, 2000) }));
        }
      } catch (_) { /* ignore malformed payload */ }
    }

    // "Request changes" is feedback, not a veto. We record the reviewer's vote and
    // any comment for audit/UI, but DO NOT terminate the review — the article stays
    // in_review until enough approvals arrive (or admin manually intervenes).
    const newRejections = priorRejections.includes(attributedId)
      ? priorRejections
      : [...priorRejections, attributedId];
    const newRejectionComments = rawComment
      ? [...(Array.isArray(job.rejectionComments) ? job.rejectionComments : []),
         { reviewerId: attributedId, comment: rawComment, at: now, channel, highlights }]
      : (Array.isArray(job.rejectionComments) ? job.rejectionComments : []);

    // Keep job.status untouched (still 'pending_review'). Only record the vote +
    // comment metadata so the dashboard can show "X requested changes (Y, Z pending)".
    await kv.set(`automation:job:${jobId}`, {
      ...job,
      rejections: newRejections,
      rejectionComments: newRejectionComments,
      updatedAt: now,
    });

    // Mirror onto the content item unconditionally so the reviewers-status modal
    // can show the vote even if the reviewer skipped the comment field.
    if (job.contentId) {
      const item = await kv.get(`content:${job.contentId}`);
      if (item) {
        const next = {
          ...item,
          rejections: item.rejections?.includes(attributedId)
            ? item.rejections
            : [...(item.rejections || []), attributedId],
          ...(rawComment && {
            rejectionComments: [
              ...(item.rejectionComments || []),
              { reviewerId: attributedId, comment: rawComment, at: now, channel: 'automation-email', highlights },
            ],
          }),
          updatedAt: now,
        };
        await kv.set(`content:${job.contentId}`, next);
      }
    }

    await writeLog({ ruleId: job.ruleId, ruleName: rule?.name, level: 'info', message: `Changes requested via ${channel} by ${displayName} (review remains open)`, jobId, contentId: job.contentId });

    if (fromForm) {
      res.setHeader('Content-Type', 'text/html');
      return res.send(confirmPage('💬', 'Feedback recorded', `Thank you${displayName && displayName !== 'email reviewer' ? `, ${escHtml(displayName)}` : ''}. Your feedback has been recorded. The article remains under review and the content team can apply your suggestions before publication.`));
    }
    if (req.method === 'GET') return res.redirect(302, `${APP_URL}?feedback=1`);
    return res.status(200).json({ status: 'feedback_recorded', jobId });
  }

  return res.status(400).json({ error: 'action must be approve or reject' });
}

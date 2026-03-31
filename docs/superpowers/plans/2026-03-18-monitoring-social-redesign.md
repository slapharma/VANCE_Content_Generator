# Monitoring + Social Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Monitoring tab into a unified pipeline tracker with publication channel tags, and rebuild the Social tab with per-article hierarchy, fixed multi-post counts per platform, and WordPress→social scheduling.

**Architecture:** All changes are CSS + JS + HTML within `index.html` (single-file app). Social post data is stored in KV via `api/content/[id].js` using a new `socialPosts` and `socialSchedule` field on each content item. The Monitoring page reads exclusively from `publishingQueue` (same source as Pipeline). WordPress publish triggers an optional social schedule that spreads N posts evenly over 5 days from publish date.

**Tech Stack:** Vanilla JS, CSS custom properties, Vercel KV (via existing `contentApi`), OpenRouter API (existing `callOpenRouter` helper), existing `publishNow()` flow.

---

## Chunk 1: Rename + Monitoring Redesign

### Task 1: Rename "Distribute" → "Social" everywhere

**Files:**
- Modify: `index.html` (nav HTML, TAB_TITLES JS object, topbar title mapping)

- [ ] **Step 1: Update nav item label in sidebar HTML**

Find `<span>Distribute</span>` (inside `id="tab-distribution"` button) → change to `<span>Social</span>`

- [ ] **Step 2: Update TAB_TITLES mapping in JS**

```javascript
// Change:
distribution: 'Social Distribution',
// To:
distribution: 'Social',
```

- [ ] **Step 3: Verify topbar shows "Social" when tab clicked**

Open app → click Social in sidebar → topbar should read "Social"

---

### Task 2: Monitoring — new data model using Pipeline source only

**Files:**
- Modify: `index.html` — `loadMonitoring()` function

**Context:** The old `loadMonitoring()` mixed `ghData` (GitHub archive) + `publishingQueue` (KV). The redesign uses **only** `publishingQueue` to match Pipeline exactly. `publishingQueue` already contains all statuses: `draft`, `in_review`, `rejected`, `approved`, `scheduled`, `published`.

- [ ] **Step 1: Replace `loadMonitoring()` function body**

```javascript
function loadMonitoring() {
  const items = publishingQueue || [];
  const container = document.getElementById('monitoringCards');
  if (!container) return;

  if (!items.length) {
    container.innerHTML = '<div class="mon-table-empty">No content in pipeline yet. Generate and queue an article to get started.</div>';
    return;
  }

  // Sort: most recently updated first
  const sorted = [...items].sort(function(a, b) {
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });

  container.innerHTML = '<table class="mon-table">' +
    '<thead><tr>' +
    '<th>Article</th>' +
    '<th>Category</th>' +
    '<th>Status</th>' +
    '<th>Published On</th>' +
    '<th>Last Updated</th>' +
    '</tr></thead>' +
    '<tbody>' +
    sorted.map(function(item) {
      return renderMonRow(item);
    }).join('') +
    '</tbody></table>';
}
```

- [ ] **Step 2: Add `renderMonRow(item)` helper**

```javascript
const MON_STATUS_META = {
  draft:     { label: 'Draft',             cls: 'ms-draft',     },
  in_review: { label: 'In Review',         cls: 'ms-review',    },
  rejected:  { label: 'Changes Requested', cls: 'ms-rejected',  },
  approved:  { label: 'Approved',          cls: 'ms-approved',  },
  scheduled: { label: 'Scheduled',         cls: 'ms-scheduled', },
  published: { label: 'Published',         cls: 'ms-published', },
};

function renderMonRow(item) {
  const title = escapeHtml((item.title || 'Untitled').slice(0, 80));
  const cat   = escapeHtml(item.category || item._cat || '—');
  const sm    = MON_STATUS_META[item.status] || { label: item.status, cls: 'ms-draft' };
  const updAt = item.updatedAt ? fmtDate(item.updatedAt) : '—';

  // Channel tags (publishedChannels array on the item)
  const channels = item.publishedChannels || [];
  const channelTags = channels.length
    ? channels.map(function(ch) {
        return '<span class="mon-channel-tag mon-ch-' + ch + '">' + escapeHtml(ch) + '</span>';
      }).join('')
    : '<span class="mon-channel-none">—</span>';

  return '<tr class="mon-row" onclick="openMonDrawer(\'' + (item.id||'') + '\',\'pipeline\')">' +
    '<td class="mon-row-title">' + title + '</td>' +
    '<td class="mon-row-cat">' + cat + '</td>' +
    '<td><span class="mon-status-badge ' + sm.cls + '">' + sm.label + '</span></td>' +
    '<td class="mon-row-channels">' + channelTags + '</td>' +
    '<td class="mon-row-date">' + updAt + '</td>' +
    '</tr>';
}
```

- [ ] **Step 3: Add channel tag CSS**

Add after the existing `.monitoring-view` CSS block:

```css
/* ── Monitoring Table ── */
.mon-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
.mon-table thead tr { background: var(--sla-navy); color: #fff; }
.mon-table th { padding: 10px 14px; font-size: 0.65rem; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; text-align: left; white-space: nowrap; }
.mon-table tbody tr.mon-row { border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.1s; }
.mon-table tbody tr.mon-row:hover { background: rgba(0,201,167,0.05); }
.mon-row-title { font-weight: 600; color: var(--sla-navy); padding: 11px 14px; max-width: 340px; }
.mon-row-cat { color: var(--text-muted); padding: 11px 14px; white-space: nowrap; font-size: 0.75rem; }
.mon-row-date { color: var(--text-muted); padding: 11px 14px; white-space: nowrap; font-size: 0.75rem; }
.mon-row-channels { padding: 11px 14px; }
.mon-table-empty { padding: 48px; text-align: center; color: var(--text-muted); font-size: 0.82rem; }

/* Status badges */
.mon-status-badge { display: inline-flex; padding: 3px 9px; font-size: 0.62rem; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; border-radius: 0; white-space: nowrap; }
.ms-draft     { background: rgba(107,122,141,0.12); color: var(--text-muted); }
.ms-review    { background: rgba(244,121,32,0.12);  color: var(--sla-orange); }
.ms-rejected  { background: rgba(231,76,60,0.12);   color: var(--error); }
.ms-approved  { background: rgba(0,201,167,0.12);   color: #009e85; }
.ms-scheduled { background: rgba(30,45,64,0.08);    color: var(--sla-navy); }
.ms-published { background: rgba(0,201,167,0.2);    color: #007a66; font-weight: 800; }

/* Channel tags */
.mon-channel-tag { display: inline-flex; align-items: center; padding: 2px 8px; font-size: 0.6rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-right: 4px; border-radius: 0; border: 1.5px solid; }
.mon-ch-wordpress { color: #21759b; border-color: #21759b; background: rgba(33,117,155,0.08); }
.mon-ch-substack  { color: #FF6719; border-color: #FF6719; background: rgba(255,103,25,0.08); }
.mon-ch-instagram { color: #c13584; border-color: #c13584; background: rgba(193,53,132,0.08); }
.mon-ch-facebook  { color: #1877F2; border-color: #1877F2; background: rgba(24,119,242,0.08); }
.mon-ch-twitter   { color: #000;    border-color: #000;    background: rgba(0,0,0,0.06); }
.mon-ch-tiktok    { color: #010101; border-color: #aaa;    background: rgba(0,0,0,0.05); }
.mon-ch-linkedin  { color: #0077B5; border-color: #0077B5; background: rgba(0,119,181,0.08); }
.mon-channel-none { color: var(--text-muted); font-size: 0.72rem; }
```

- [ ] **Step 4: Replace Monitoring tab HTML with table-based layout**

Replace the entire `<div class="tab-view" id="view-monitoring">...</div>` block:

```html
<div class="tab-view" id="view-monitoring">
<div class="monitoring-view">
  <div class="monitoring-header">
    <div>
      <h1 style="font-size:1.1rem;font-weight:800;color:var(--sla-navy);margin:0 0 3px;">Content Monitoring</h1>
      <p style="font-size:0.75rem;color:var(--text-muted);margin:0;">Live status of every article across the pipeline</p>
    </div>
    <button class="btn btn-outline btn-sm" onclick="loadMonitoring()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
      Refresh
    </button>
  </div>
  <div class="mon-table-wrap" id="monitoringCards">
    <div class="mon-table-empty">Loading…</div>
  </div>
</div>
</div>
```

- [ ] **Step 5: Update `openMonDrawer` to handle pipeline-only items**

The existing `openMonDrawer(itemId, source)` already handles `'pipeline'` source — just ensure the call passes `'pipeline'` (already correct in `renderMonRow` above).

- [ ] **Step 6: Add `mon-table-wrap` CSS**

```css
.mon-table-wrap { overflow-x: auto; }
```

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: monitoring redesign — table layout, pipeline-only data, channel tags"
```

---

## Chunk 2: Social Tab — Hierarchy + Multi-Post Generation

### Task 3: Update SOCIAL_PLATFORMS with fixed post counts

**Files:**
- Modify: `index.html` — `SOCIAL_PLATFORMS` constant

- [ ] **Step 1: Update `SOCIAL_PLATFORMS` array with `postCount`**

```javascript
const SOCIAL_PLATFORMS = [
  { id: 'twitter',   label: 'X / Twitter', postCount: 5, maxChars: 280,  tone: 'concise, punchy, use 1-2 relevant hashtags' },
  { id: 'linkedin',  label: 'LinkedIn',    postCount: 2, maxChars: 1300, tone: 'professional, insight-led, include a call to action' },
  { id: 'facebook',  label: 'Facebook',    postCount: 2, maxChars: 2000, tone: 'conversational, shareable, include a question to drive comments' },
  { id: 'substack',  label: 'Substack',    postCount: 1, maxChars: 600,  tone: 'newsletter teaser, compelling summary, end with a read-more CTA' },
  { id: 'tiktok',    label: 'TikTok',      postCount: 5, maxChars: 300,  tone: 'hook-first, casual, 3-5 trending hashtags' },
  { id: 'instagram', label: 'Instagram',   postCount: 2, maxChars: 2200, tone: 'engaging caption with emojis and 5-8 hashtags' },
];
```

---

### Task 4: Rebuild Social tab HTML — article list with hierarchy

**Files:**
- Modify: `index.html` — `<div id="view-distribution">` block

- [ ] **Step 1: Replace the Social tab HTML entirely**

```html
<div class="tab-view" id="view-distribution">
<div class="social-view">
  <div class="social-header">
    <div>
      <h1 style="font-size:1.1rem;font-weight:800;color:var(--sla-navy);margin:0 0 3px;">Social Distribution</h1>
      <p style="font-size:0.75rem;color:var(--text-muted);margin:0;">Generate platform-optimised posts for each article · X×5 · LinkedIn×2 · Facebook×2 · TikTok×5 · Instagram×2 · Substack×1</p>
    </div>
    <button class="btn btn-orange btn-sm" id="socialGenerateAllBtn" onclick="socialGenerateSelected()" style="display:none;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:13px;height:13px;"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
      Generate Posts
    </button>
  </div>

  <!-- Article list (populated by loadDistribution) -->
  <div class="social-article-list" id="socialArticleList">
    <div class="social-empty">Loading library…</div>
  </div>
</div>
</div>
```

---

### Task 5: Add Social tab CSS

**Files:**
- Modify: `index.html` — CSS block (after `.dist-*` rules)

- [ ] **Step 1: Add social CSS block**

Replace the existing `.dist-*` CSS block with:

```css
/* ══════════════════════════════════════════════════
   SOCIAL TAB
══════════════════════════════════════════════════ */
.social-view { padding: 1.5rem; max-width: 1200px; margin: 0 auto; }
.social-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 1.25rem; gap: 12px; flex-wrap: wrap; }

/* Article accordion rows */
.social-article-list { display: flex; flex-direction: column; gap: 1px; }
.social-empty { padding: 48px; text-align: center; color: var(--text-muted); font-size: 0.82rem; }

.social-article-row { background: var(--card); border: 1px solid var(--border); }
.social-article-head {
  display: flex; align-items: center; gap: 12px; padding: 12px 16px;
  cursor: pointer; transition: background 0.12s; user-select: none;
}
.social-article-head:hover { background: rgba(0,201,167,0.04); }
.social-article-chevron { flex-shrink: 0; color: var(--text-muted); transition: transform 0.2s; }
.social-article-row.open .social-article-chevron { transform: rotate(90deg); }
.social-article-name { flex: 1; font-size: 0.82rem; font-weight: 700; color: var(--sla-navy); }
.social-article-cat  { font-size: 0.68rem; color: var(--text-muted); white-space: nowrap; }
.social-article-status { font-size: 0.65rem; font-weight: 700; padding: 2px 8px; background: rgba(0,201,167,0.1); color: #009e85; }
.social-article-gen-btn { flex-shrink: 0; }

/* Platform accordion body */
.social-article-body { display: none; border-top: 1px solid var(--border); }
.social-article-row.open .social-article-body { display: block; }

.social-plat-section { border-bottom: 1px solid var(--border); }
.social-plat-section:last-child { border-bottom: none; }
.social-plat-head {
  display: flex; align-items: center; gap: 10px; padding: 10px 16px 10px 28px;
  background: rgba(30,45,64,0.02); font-size: 0.72rem; font-weight: 700; color: var(--sla-navy);
}
.social-plat-icon { width: 22px; height: 22px; border-radius: 0; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 800; color: #fff; flex-shrink: 0; }
.social-plat-label { flex: 1; }
.social-plat-count { font-size: 0.6rem; color: var(--text-muted); font-weight: 600; }

.social-posts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1px; padding: 0 0 0 28px; background: var(--border); }
.social-post-card { background: var(--card); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; min-height: 120px; }
.social-post-num { font-size: 0.58rem; font-weight: 800; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.8px; }
.social-post-text { flex: 1; font-size: 0.78rem; line-height: 1.6; color: var(--text); white-space: pre-wrap; }
.social-post-text.generating { color: var(--text-muted); font-style: italic; }
.social-post-actions { display: flex; gap: 6px; }
.social-post-sched { font-size: 0.62rem; color: var(--sla-teal); font-weight: 700; margin-top: 2px; }

/* Schedule toggle on publish */
.social-sched-toggle { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: rgba(0,201,167,0.06); border: 1px solid rgba(0,201,167,0.2); margin-top: 10px; }
.social-sched-toggle label { font-size: 0.72rem; font-weight: 600; color: var(--sla-navy); cursor: pointer; }
```

---

### Task 6: Rewrite `loadDistribution()` for article-list hierarchy

**Files:**
- Modify: `index.html` — `loadDistribution()` function

- [ ] **Step 1: Rewrite `loadDistribution()`**

```javascript
// In-memory cache: articleId → { twitter: ['post1',...], linkedin: [...], ... }
const socialPostCache = {};

function loadDistribution() {
  const listEl = document.getElementById('socialArticleList');
  if (!listEl) return;

  // Use publishingQueue (same as Pipeline) so it matches pipeline data
  const items = publishingQueue || [];

  if (!items.length) {
    listEl.innerHTML = '<div class="social-empty">No content in pipeline yet. Generate and queue an article first.</div>';
    return;
  }

  const sorted = [...items].sort(function(a, b) {
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });

  listEl.innerHTML = sorted.map(function(item) {
    return renderSocialArticleRow(item);
  }).join('');

  // Restore cached posts into DOM
  sorted.forEach(function(item) {
    if (socialPostCache[item.id]) {
      renderSocialPosts(item.id, socialPostCache[item.id]);
    }
    // Also restore from item.socialPosts if saved to KV
    if (item.socialPosts && !socialPostCache[item.id]) {
      socialPostCache[item.id] = item.socialPosts;
      renderSocialPosts(item.id, item.socialPosts);
    }
  });
}

function renderSocialArticleRow(item) {
  const title = escapeHtml((item.title || 'Untitled').slice(0, 90));
  const cat   = escapeHtml(item.category || '—');
  const hasPosts = !!(item.socialPosts || socialPostCache[item.id]);
  const statusHtml = hasPosts
    ? '<span class="social-article-status">Posts ready</span>'
    : '';

  // Platform sections (all platforms, all counts)
  const platSections = SOCIAL_PLATFORMS.map(function(plat) {
    const slots = Array.from({ length: plat.postCount }, function(_, i) {
      return renderSocialPostSlot(item.id, plat.id, i);
    }).join('');

    const iconBg = { twitter:'#000', linkedin:'#0077B5', facebook:'#1877F2',
                     substack:'#FF6719', tiktok:'#010101', instagram:'linear-gradient(135deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)' }[plat.id] || '#666';
    const iconChar = { twitter:'𝕏', linkedin:'in', facebook:'f', substack:'S', tiktok:'♪', instagram:'📷' }[plat.id] || '●';

    return '<div class="social-plat-section" id="social-plat-' + item.id + '-' + plat.id + '">' +
      '<div class="social-plat-head">' +
        '<div class="social-plat-icon" style="background:' + iconBg + ';">' + iconChar + '</div>' +
        '<span class="social-plat-label">' + plat.label + '</span>' +
        '<span class="social-plat-count">' + plat.postCount + ' posts · max ' + plat.maxChars + ' chars</span>' +
      '</div>' +
      '<div class="social-posts-grid">' + slots + '</div>' +
    '</div>';
  }).join('');

  return '<div class="social-article-row" id="social-row-' + item.id + '">' +
    '<div class="social-article-head" onclick="toggleSocialRow(\'' + item.id + '\')">' +
      '<svg class="social-article-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:14px;height:14px;"><polyline points="9 18 15 12 9 6"/></svg>' +
      '<div class="social-article-name">' + title + '</div>' +
      '<span class="social-article-cat">' + cat + '</span>' +
      statusHtml +
      '<button class="btn btn-orange btn-sm social-article-gen-btn" onclick="event.stopPropagation();generateSocialForArticle(\'' + item.id + '\')">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:11px;height:11px;"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>' +
        'Generate' +
      '</button>' +
    '</div>' +
    '<div class="social-article-body">' + platSections + '</div>' +
  '</div>';
}

function renderSocialPostSlot(articleId, platId, idx) {
  return '<div class="social-post-card" id="social-slot-' + articleId + '-' + platId + '-' + idx + '">' +
    '<div class="social-post-num">Post ' + (idx + 1) + '</div>' +
    '<div class="social-post-text generating">Not yet generated</div>' +
    '<div class="social-post-actions" style="display:none;">' +
      '<button class="btn btn-outline btn-xs" onclick="navigator.clipboard.writeText(this.closest(\'.social-post-card\').querySelector(\'.social-post-text\').textContent)">Copy</button>' +
    '</div>' +
  '</div>';
}

function toggleSocialRow(articleId) {
  const row = document.getElementById('social-row-' + articleId);
  if (row) row.classList.toggle('open');
}
```

---

### Task 7: `generateSocialForArticle()` — generate N posts per platform in parallel

**Files:**
- Modify: `index.html` — add new function

- [ ] **Step 1: Add the generation function**

```javascript
async function generateSocialForArticle(articleId) {
  const item = (publishingQueue || []).find(function(i) { return i.id === articleId; });
  if (!item) { alert('Article not found in pipeline.'); return; }

  // Open the accordion
  const row = document.getElementById('social-row-' + articleId);
  if (row && !row.classList.contains('open')) row.classList.add('open');

  const excerpt = (item.body || item.content || item.excerpt || '')
    .replace(/<[^>]+>/g, '').trim().slice(0, 1500);

  const btn = row && row.querySelector('.social-article-gen-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }

  // Set all slots to "Generating…"
  SOCIAL_PLATFORMS.forEach(function(plat) {
    for (let i = 0; i < plat.postCount; i++) {
      const slot = document.getElementById('social-slot-' + articleId + '-' + plat.id + '-' + i);
      if (slot) {
        slot.querySelector('.social-post-text').textContent = 'Generating…';
        slot.querySelector('.social-post-text').className = 'social-post-text generating';
        slot.querySelector('.social-post-actions').style.display = 'none';
      }
    }
  });

  const result = {}; // platId → [post1, post2, ...]

  await Promise.allSettled(SOCIAL_PLATFORMS.map(async function(plat) {
    const posts = [];
    // Generate each post sequentially within a platform (avoid rate limit)
    for (let i = 0; i < plat.postCount; i++) {
      const anglePrompts = [
        'Highlight the key clinical finding.',
        'Focus on the patient impact.',
        'Lead with a surprising statistic.',
        'Ask a thought-provoking question.',
        'Summarise in one striking sentence then expand.',
      ];
      const angle = anglePrompts[i] || anglePrompts[0];
      const prompt = `You are a social media copywriter for IBD Health Hub, a UK medical content platform.
Write post ${i + 1} of ${plat.postCount} for ${plat.label}.
Tone: ${plat.tone}
Maximum characters: ${plat.maxChars}
Angle for this post: ${angle}
Article title: ${item.title}
Article excerpt: ${excerpt}

Write ONLY the post text. No preamble, no "Post X:", no explanation.`;

      try {
        const text = await callOpenRouter(prompt, getApiKey());
        posts.push(text.trim());
        // Update slot immediately as each arrives
        const slot = document.getElementById('social-slot-' + articleId + '-' + plat.id + '-' + i);
        if (slot) {
          const textEl = slot.querySelector('.social-post-text');
          textEl.textContent = text.trim();
          textEl.className = 'social-post-text';
          slot.querySelector('.social-post-actions').style.display = '';
        }
      } catch(e) {
        posts.push('Error: ' + e.message);
        const slot = document.getElementById('social-slot-' + articleId + '-' + plat.id + '-' + i);
        if (slot) {
          slot.querySelector('.social-post-text').textContent = 'Error: ' + e.message;
          slot.querySelector('.social-post-text').className = 'social-post-text';
        }
      }
    }
    result[plat.id] = posts;
  }));

  // Cache locally
  socialPostCache[articleId] = result;

  // Save to KV via contentApi so posts persist
  await contentApi.update(articleId, { socialPosts: result });

  if (btn) { btn.disabled = false; btn.textContent = 'Regenerate'; }

  // Update status badge
  const nameEl = row && row.querySelector('.social-article-name');
  if (nameEl && nameEl.nextSibling) {
    // Insert or update "Posts ready" badge
    let badge = row.querySelector('.social-article-status');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'social-article-status';
      row.querySelector('.social-article-head').insertBefore(badge, btn);
    }
    badge.textContent = 'Posts ready';
  }
}

function renderSocialPosts(articleId, postsMap) {
  SOCIAL_PLATFORMS.forEach(function(plat) {
    const posts = postsMap[plat.id] || [];
    posts.forEach(function(text, i) {
      const slot = document.getElementById('social-slot-' + articleId + '-' + plat.id + '-' + i);
      if (slot && text) {
        const textEl = slot.querySelector('.social-post-text');
        textEl.textContent = text;
        textEl.className = 'social-post-text';
        slot.querySelector('.social-post-actions').style.display = '';
      }
    });
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat: social tab hierarchy — per-article accordion, N posts per platform, KV persistence"
```

---

## Chunk 3: WordPress → Social Schedule Integration

### Task 8: Social scheduling data model + schedule calculation

**Files:**
- Modify: `index.html` — add `scheduleSocialPosts()` helper

**Context:** When a WordPress publish succeeds AND the user has opted in, we spread posts evenly over 5 days starting from the publish date. With X=5 posts → 1/day, LinkedIn=2 → days 1,4, Facebook=2 → days 1,4, Substack=1 → day 1, TikTok=5 → 1/day, Instagram=2 → days 1,4.

- [ ] **Step 1: Add `computeSocialSchedule(publishDate, postsMap)` function**

```javascript
function computeSocialSchedule(publishDate, postsMap) {
  const base = new Date(publishDate);
  const schedule = {};
  Object.keys(postsMap).forEach(function(platId) {
    const count = postsMap[platId].length;
    if (!count) return;
    const dates = [];
    for (let i = 0; i < count; i++) {
      // Spread evenly: day 0, then every (5/(count)) days, capped at day 4
      const dayOffset = count === 1 ? 0 : Math.round(i * (4 / (count - 1)));
      const d = new Date(base);
      d.setDate(d.getDate() + dayOffset);
      dates.push(d.toISOString().slice(0, 10));
    }
    schedule[platId] = dates;
  });
  return schedule;
}
```

- [ ] **Step 2: Update `publishNow()` to check for social posts and show scheduling option**

Replace the existing `publishNow()` function:

```javascript
async function publishNow(contentId) {
  const item = (publishingQueue || []).find(function(i) { return i.id === contentId; });
  const hasSocial = item && (item.socialPosts || socialPostCache[contentId]);

  let scheduleSocial = false;
  if (hasSocial) {
    scheduleSocial = confirm(
      'Publish to WordPress now?\n\n' +
      'Click OK to publish AND schedule social posts (spread over 5 days).\n' +
      'Click Cancel to publish to WordPress only.'
    );
    // If user dismissed entirely, check if they want to publish at all
    if (!confirm('Confirm: publish this article to WordPress?')) return;
  } else {
    if (!confirm('Publish this article to WordPress now?')) return;
  }

  try {
    const r = await fetch('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentId }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);

    const publishedAt = new Date().toISOString();

    // Record WordPress as a published channel
    const existingChannels = (item && item.publishedChannels) || [];
    const channels = existingChannels.includes('wordpress')
      ? existingChannels
      : [...existingChannels, 'wordpress'];

    const updates = { publishedChannels: channels };

    // Compute and store social schedule if opted in
    if (scheduleSocial && hasSocial) {
      const postsMap = item.socialPosts || socialPostCache[contentId] || {};
      const schedule = computeSocialSchedule(publishedAt, postsMap);
      updates.socialSchedule = schedule;
    }

    // Save channel + schedule back to KV
    await contentApi.update(contentId, updates);

    showAlert('generateAlert',
      '✓ Published to WordPress!' +
      (scheduleSocial ? ' Social posts scheduled over 5 days.' : '') +
      ' <a href="' + data.wpPostUrl + '" target="_blank" style="color:inherit;text-decoration:underline;">View post →</a>',
      'success'
    );
    setTimeout(function() { loadPipeline(); }, 800);
  } catch (err) {
    alert('Publish failed: ' + err.message);
  }
}
```

---

### Task 9: Show schedule dates in Social tab post slots

**Files:**
- Modify: `index.html` — `renderSocialPosts()` function

- [ ] **Step 1: Update `renderSocialPosts()` to show schedule dates**

```javascript
function renderSocialPosts(articleId, postsMap, scheduleMap) {
  SOCIAL_PLATFORMS.forEach(function(plat) {
    const posts = postsMap[plat.id] || [];
    const dates = (scheduleMap && scheduleMap[plat.id]) || [];
    posts.forEach(function(text, i) {
      const slot = document.getElementById('social-slot-' + articleId + '-' + plat.id + '-' + i);
      if (slot && text) {
        const textEl = slot.querySelector('.social-post-text');
        textEl.textContent = text;
        textEl.className = 'social-post-text';
        slot.querySelector('.social-post-actions').style.display = '';
        // Show schedule date if available
        let schedEl = slot.querySelector('.social-post-sched');
        if (dates[i]) {
          if (!schedEl) {
            schedEl = document.createElement('div');
            schedEl.className = 'social-post-sched';
            slot.appendChild(schedEl);
          }
          schedEl.textContent = '📅 Scheduled: ' + fmtDate(dates[i]);
        }
      }
    });
  });
}
```

- [ ] **Step 2: Update `loadDistribution()` to pass scheduleMap to `renderSocialPosts()`**

```javascript
// In loadDistribution(), update the cache restore section:
sorted.forEach(function(item) {
  const posts  = socialPostCache[item.id] || item.socialPosts;
  const sched  = item.socialSchedule;
  if (posts) {
    socialPostCache[item.id] = posts;
    renderSocialPosts(item.id, posts, sched);
  }
});
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: WordPress publish triggers social schedule, spread over 5 days"
```

---

### Task 10: Deploy + smoke test

- [ ] **Step 1: Deploy**

```bash
npx vercel --prod
```

- [ ] **Step 2: Smoke test Monitoring tab**
  - Navigate to Monitoring tab
  - Verify table renders with Status, Category, Published On, Last Updated columns
  - Verify channel tags appear for any published items (may need a published item in pipeline)
  - Verify clicking a row opens the detail drawer

- [ ] **Step 3: Smoke test Social tab**
  - Navigate to Social tab
  - Verify article list shows all pipeline items as accordion rows
  - Click chevron to expand an article → 6 platform sections visible
  - Click "Generate" on one article → posts stream in per slot
  - Verify post counts: X=5, LinkedIn=2, Facebook=2, Substack=1, TikTok=5, Instagram=2

- [ ] **Step 4: Smoke test WordPress→social scheduling**
  - On a Pipeline article with social posts generated, click Publish
  - Confirm first dialog (schedule social = OK)
  - Confirm second dialog (publish = OK)
  - Verify Monitoring tab shows `wordpress` channel tag on that item
  - Verify Social tab shows schedule dates on post slots

- [ ] **Step 5: Final commit**

```bash
git add index.html
git commit -m "chore: verify monitoring + social distribution end-to-end"
```

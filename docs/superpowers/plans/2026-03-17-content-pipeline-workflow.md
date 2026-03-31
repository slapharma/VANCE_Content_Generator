# SLAHealth Content Pipeline Workflow — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the SLAHealth Content Generator from a single-browser localStorage app into a full cloud-backed pipeline: Content Generation → Multi-Reviewer Approval → Pipeline Management → Scheduled Posting → WordPress Auto-Publish, with Google Calendar sync.

**Architecture:** The existing `index.html` static app remains on Vercel but gains a `/api/` layer of Vercel serverless functions backed by Vercel KV (Redis). Content moves through states (`draft → in_review → approved → scheduled → published`) tracked in KV. Resend.com delivers approval emails containing signed JWT links; clicking approve/reject calls the API and advances state. Vercel Cron checks every 5 minutes for posts due to publish and fires the WordPress REST API.

**Tech Stack:**
- **Vercel KV** (managed Redis) — state store, zero additional infrastructure
- **Resend.com** — transactional email (approval requests, status notifications)
- **JSON Web Tokens (jose library)** — stateless signed approval tokens in email links
- **Google Calendar API** — OAuth 2.0 sync of scheduled posts as calendar events
- **WordPress REST API** — authenticated post creation on ibdhealthhub.com
- **Vercel Cron** — scheduled publishing (every 5 min, defined in vercel.json)
- **Node.js 18** — runtime for all serverless functions

---

## Environment Variables Required

Add these in Vercel Dashboard → Project Settings → Environment Variables:

```
# Vercel KV (auto-populated when you add KV store in Vercel dashboard)
KV_REST_API_URL=
KV_REST_API_TOKEN=

# Resend
RESEND_API_KEY=
RESEND_FROM_EMAIL=noreply@ibdhealthhub.com

# JWT signing secret (generate with: openssl rand -hex 32)
JWT_SECRET=

# Google Calendar OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://ibdhealthhub-content-generator.vercel.app/api/calendar/callback

# WordPress
WP_SITE_URL=https://ibdhealthhub.com
WP_USERNAME=
WP_APP_PASSWORD=

# App
NEXT_PUBLIC_APP_URL=https://ibdhealthhub-content-generator.vercel.app
```

---

## File Map

```
IBD Health Hub_ClinicalReview_Generator/
├── index.html                          # MODIFY: add Pipeline & Schedule tabs, migrate state to API
├── logo.png
├── vercel.json                         # MODIFY: add cron job config
├── package.json                        # CREATE: list jose, @vercel/kv dependencies
│
├── api/
│   ├── content/
│   │   ├── index.js                    # CREATE: GET all content items, POST new item
│   │   └── [id].js                     # CREATE: GET/PUT/DELETE single content item
│   │
│   ├── review/
│   │   ├── send.js                     # CREATE: POST — send review emails to all reviewers
│   │   └── [token].js                  # CREATE: GET — handle approve/reject click from email
│   │
│   ├── reviewers/
│   │   └── index.js                    # CREATE: GET/POST/DELETE reviewer list
│   │
│   ├── schedule/
│   │   └── index.js                    # CREATE: POST — set publish date/time for a content item
│   │
│   ├── calendar/
│   │   ├── auth.js                     # CREATE: GET — redirect to Google OAuth
│   │   ├── callback.js                 # CREATE: GET — handle OAuth callback, store tokens
│   │   └── sync.js                     # CREATE: POST — create/update GCal event for content item
│   │
│   ├── publish/
│   │   └── index.js                    # CREATE: POST — publish one content item to WordPress
│   │
│   └── cron/
│       └── publish.js                  # CREATE: GET — Vercel cron handler, publishes due items
│
└── docs/
    └── superpowers/
        └── plans/
            └── 2026-03-17-content-pipeline-workflow.md  # this file
```

---

## Chunk 1: Backend Foundation + Content State API

**What this delivers:** Content stored in Vercel KV instead of localStorage. Survives page refreshes, accessible from any browser, shareable across team. The existing generation UI works exactly the same — only storage layer changes.

### Task 1: Set up Vercel KV + package.json

**Files:**
- Create: `package.json`
- Modify: `vercel.json`

- [ ] **Step 1.1: Create Vercel KV store**

  In Vercel Dashboard:
  1. Go to your project → **Storage** tab
  2. Click **Create Database** → select **KV (Redis)**
  3. Name it `slahealth-content-kv`
  4. Click **Connect to Project** — this auto-populates `KV_REST_API_URL` and `KV_REST_API_TOKEN` env vars

- [ ] **Step 1.2: Create package.json**

  ```json
  {
    "name": "slahealth-content-generator",
    "version": "1.0.0",
    "private": true,
    "dependencies": {
      "@vercel/kv": "^1.0.0",
      "jose": "^5.2.0"
    },
    "engines": {
      "node": "18.x"
    }
  }
  ```

- [ ] **Step 1.3: Install dependencies locally**

  ```bash
  cd IBD Health Hub_ClinicalReview_Generator
  npm install
  ```
  Expected: `node_modules/` created, `package-lock.json` generated.

- [ ] **Step 1.4: Add .gitignore**

  ```
  node_modules/
  .env.local
  .vercel/
  ```

- [ ] **Step 1.5: Commit**

  ```bash
  git add package.json package-lock.json .gitignore
  git commit -m "feat: add package.json with @vercel/kv and jose dependencies"
  ```

---

### Task 2: Content API — list and create

**Files:**
- Create: `api/content/index.js`

**Data model for a content item (stored as JSON in KV):**
```json
{
  "id": "uuid-v4",
  "title": "Post title",
  "body": "Full content HTML",
  "excerpt": "Short summary",
  "category": "clinical-review",
  "template": "standard",
  "status": "draft",
  "createdAt": "2026-03-17T12:00:00Z",
  "updatedAt": "2026-03-17T12:00:00Z",
  "reviewers": [],
  "approvals": [],
  "rejections": [],
  "requireAllApprovals": false,
  "scheduledAt": null,
  "publishedAt": null,
  "wpPostId": null
}
```

KV key pattern: `content:{id}` for individual items, `content:index` for sorted set of all IDs.

- [ ] **Step 2.1: Write the failing test**

  Create `api/content/index.test.js`:
  ```javascript
  // Run with: node --test api/content/index.test.js
  import assert from 'node:assert/strict';
  import { test } from 'node:test';

  // Test the pure data-shaping logic (no KV needed)
  import { buildContentItem, validateContentItem } from './index.js';

  test('buildContentItem creates item with correct defaults', () => {
    const item = buildContentItem({ title: 'Test', body: '<p>Hello</p>', category: 'news' });
    assert.equal(item.status, 'draft');
    assert.equal(item.title, 'Test');
    assert.ok(item.id);
    assert.ok(item.createdAt);
    assert.deepEqual(item.approvals, []);
  });

  test('validateContentItem rejects missing title', () => {
    assert.throws(() => validateContentItem({ body: 'x' }), /title/i);
  });

  test('validateContentItem rejects missing body', () => {
    assert.throws(() => validateContentItem({ title: 'x' }), /body/i);
  });
  ```

- [ ] **Step 2.2: Run test to verify it fails**

  ```bash
  node --test api/content/index.test.js
  ```
  Expected: FAIL — `Cannot find module './index.js'`

- [ ] **Step 2.3: Implement api/content/index.js**

  ```javascript
  import { kv } from '@vercel/kv';
  import { randomUUID } from 'crypto';

  // ── Pure helpers (exported for testing) ─────────────────────────────────────

  export function buildContentItem(data) {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      title: data.title,
      body: data.body,
      excerpt: data.excerpt ?? '',
      category: data.category ?? 'uncategorised',
      template: data.template ?? 'standard',
      status: 'draft',
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
    if (!data.body) throw new Error('body is required');
  }

  // ── HTTP handler ─────────────────────────────────────────────────────────────

  export default async function handler(req, res) {
    if (req.method === 'GET') {
      // Return all content items, newest first
      const ids = await kv.lrange('content:index', 0, -1);
      if (!ids.length) return res.json([]);
      const items = await Promise.all(ids.map(id => kv.get(`content:${id}`)));
      return res.json(items.filter(Boolean).reverse());
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
      return res.status(201).json(item);
    }

    res.status(405).json({ error: 'Method not allowed' });
  }
  ```

- [ ] **Step 2.4: Run test to verify it passes**

  ```bash
  node --test api/content/index.test.js
  ```
  Expected: PASS (3 tests)

- [ ] **Step 2.5: Commit**

  ```bash
  git add api/content/index.js api/content/index.test.js
  git commit -m "feat: add content list/create API with Vercel KV storage"
  ```

---

### Task 3: Content API — get, update, delete single item

**Files:**
- Create: `api/content/[id].js`

- [ ] **Step 3.1: Write the failing test**

  Create `api/content/[id].test.js`:
  ```javascript
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import { applyStatusTransition } from './[id].js';

  test('draft -> in_review is valid', () => {
    assert.equal(applyStatusTransition('draft', 'in_review'), 'in_review');
  });

  test('draft -> published is invalid', () => {
    assert.throws(() => applyStatusTransition('draft', 'published'), /invalid/i);
  });

  test('approved -> scheduled is valid', () => {
    assert.equal(applyStatusTransition('approved', 'scheduled'), 'scheduled');
  });
  ```

- [ ] **Step 3.2: Run test to verify it fails**

  ```bash
  node --test api/content/[id].test.js
  ```
  Expected: FAIL — `Cannot find module`

- [ ] **Step 3.3: Implement api/content/[id].js**

  ```javascript
  import { kv } from '@vercel/kv';

  const VALID_TRANSITIONS = {
    draft: ['in_review', 'draft'],
    in_review: ['approved', 'rejected', 'draft'],
    rejected: ['draft'],
    approved: ['scheduled', 'published'],
    scheduled: ['published', 'approved'],
    published: [],
  };

  export function applyStatusTransition(current, next) {
    if (!VALID_TRANSITIONS[current]?.includes(next)) {
      throw new Error(`invalid status transition: ${current} -> ${next}`);
    }
    return next;
  }

  export default async function handler(req, res) {
    const { id } = req.query;
    const item = await kv.get(`content:${id}`);
    if (!item) return res.status(404).json({ error: 'Not found' });

    if (req.method === 'GET') {
      return res.json(item);
    }

    if (req.method === 'PUT') {
      const updates = { ...req.body };

      // Validate status transitions
      if (updates.status && updates.status !== item.status) {
        try {
          applyStatusTransition(item.status, updates.status);
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
      }

      const updated = { ...item, ...updates, updatedAt: new Date().toISOString() };
      await kv.set(`content:${id}`, updated);
      return res.json(updated);
    }

    if (req.method === 'DELETE') {
      await kv.del(`content:${id}`);
      const ids = await kv.lrange('content:index', 0, -1);
      // Rebuild index without this id
      await kv.del('content:index');
      const remaining = ids.filter(i => i !== id);
      if (remaining.length) await kv.rpush('content:index', ...remaining);
      return res.status(204).end();
    }

    res.status(405).json({ error: 'Method not allowed' });
  }
  ```

- [ ] **Step 3.4: Run test to verify it passes**

  ```bash
  node --test api/content/[id].test.js
  ```
  Expected: PASS (3 tests)

- [ ] **Step 3.5: Commit**

  ```bash
  git add api/content/[id].js api/content/[id].test.js
  git commit -m "feat: add content get/update/delete API with status transition guard"
  ```

---

### Task 4: Migrate frontend from localStorage to API

**Files:**
- Modify: `index.html`

The existing app reads/writes content via `localStorage`. Replace all localStorage calls with `fetch()` calls to the new `/api/content` endpoints. The UI structure stays identical.

- [ ] **Step 4.1: Locate all localStorage usage in index.html**

  ```bash
  grep -n "localStorage" index.html
  ```
  Note every line number. These are the only lines that change.

- [ ] **Step 4.2: Add a thin API client near the top of the `<script>` block**

  Find the opening `<script>` tag and add immediately after:
  ```javascript
  // ── API client — replaces localStorage ──────────────────────────────────────
  const api = {
    async getAll()       { const r = await fetch('/api/content'); return r.json(); },
    async create(data)   { const r = await fetch('/api/content', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) }); return r.json(); },
    async update(id, d)  { const r = await fetch(`/api/content/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(d) }); return r.json(); },
    async remove(id)     { await fetch(`/api/content/${id}`, { method:'DELETE' }); },
  };
  ```

- [ ] **Step 4.3: Replace localStorage.setItem / getItem / removeItem calls**

  For each localStorage call found in Step 4.1:
  - `localStorage.setItem(key, JSON.stringify(item))` → `await api.create(item)` (for new) or `await api.update(item.id, item)` (for updates)
  - `JSON.parse(localStorage.getItem(key))` → `await api.getAll()`
  - `localStorage.removeItem(key)` → `await api.remove(id)`

  Ensure calling functions are marked `async` and use `await`.

- [ ] **Step 4.4: Test manually**

  ```bash
  # Install Vercel CLI if not present
  npm i -g vercel

  # Pull env vars from Vercel (requires login)
  vercel env pull .env.local

  # Run dev server
  vercel dev
  ```

  Open http://localhost:3000. Generate a piece of content. Verify:
  - [ ] Content appears in the list after generation
  - [ ] Refreshing the page still shows the content (it came from KV, not localStorage)
  - [ ] Deleting an item removes it permanently

- [ ] **Step 4.5: Commit**

  ```bash
  git add index.html
  git commit -m "feat: migrate content storage from localStorage to Vercel KV API"
  ```

- [ ] **Step 4.6: Deploy and verify on Vercel**

  ```bash
  git push new-origin main
  ```
  Check Vercel dashboard for successful deploy. Verify live site functions as expected.

---

## Chunk 2: Multi-Reviewer Approval Workflow

**What this delivers:** A "Send for Review" button emails all configured reviewers. Each email contains an Approve/Request Changes link. Clicking it calls the API, records the response, and when approval threshold is met, content automatically advances to `approved`.

**Approval logic:**
- `requireAllApprovals: false` → first approval from any reviewer sets status to `approved`
- `requireAllApprovals: true` → every reviewer in the list must approve before status advances

---

### Task 5: Reviewer management API

**Files:**
- Create: `api/reviewers/index.js`

Reviewers are stored as a list in KV under key `reviewers`. Each reviewer: `{ id, name, email }`.

- [ ] **Step 5.1: Write the failing test**

  Create `api/reviewers/index.test.js`:
  ```javascript
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import { buildReviewer, validateReviewer } from './index.js';

  test('buildReviewer creates reviewer with id', () => {
    const r = buildReviewer({ name: 'Alice', email: 'alice@ibdhealthhub.com' });
    assert.ok(r.id);
    assert.equal(r.email, 'alice@ibdhealthhub.com');
  });

  test('validateReviewer rejects missing email', () => {
    assert.throws(() => validateReviewer({ name: 'Alice' }), /email/i);
  });

  test('validateReviewer rejects invalid email', () => {
    assert.throws(() => validateReviewer({ name: 'Alice', email: 'notanemail' }), /email/i);
  });
  ```

- [ ] **Step 5.2: Run test to verify it fails**

  ```bash
  node --test api/reviewers/index.test.js
  ```

- [ ] **Step 5.3: Implement api/reviewers/index.js**

  ```javascript
  import { kv } from '@vercel/kv';
  import { randomUUID } from 'crypto';

  export function validateReviewer(data) {
    if (!data.email) throw new Error('email is required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw new Error('email is invalid');
  }

  export function buildReviewer(data) {
    return { id: randomUUID(), name: data.name ?? data.email, email: data.email };
  }

  export default async function handler(req, res) {
    if (req.method === 'GET') {
      const reviewers = await kv.get('reviewers') ?? [];
      return res.json(reviewers);
    }
    if (req.method === 'POST') {
      try { validateReviewer(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
      const reviewer = buildReviewer(req.body);
      const reviewers = await kv.get('reviewers') ?? [];
      reviewers.push(reviewer);
      await kv.set('reviewers', reviewers);
      return res.status(201).json(reviewer);
    }
    if (req.method === 'DELETE') {
      const { id } = req.query;
      const reviewers = (await kv.get('reviewers') ?? []).filter(r => r.id !== id);
      await kv.set('reviewers', reviewers);
      return res.status(204).end();
    }
    res.status(405).json({ error: 'Method not allowed' });
  }
  ```

- [ ] **Step 5.4: Run test to verify it passes**

  ```bash
  node --test api/reviewers/index.test.js
  ```

- [ ] **Step 5.5: Commit**

  ```bash
  git add api/reviewers/index.js api/reviewers/index.test.js
  git commit -m "feat: add reviewers CRUD API"
  ```

---

### Task 6: Send review emails via Resend

**Files:**
- Create: `api/review/send.js`

**How it works:**
1. POST `/api/review/send` with `{ contentId, requireAllApprovals }`
2. Load the content item + all configured reviewers
3. For each reviewer, mint a signed JWT: `{ contentId, reviewerId, action: 'approve'|'reject', exp: 7days }`
4. Send an email via Resend with two links: Approve and Request Changes
5. Update content status to `in_review`, store reviewer list on the item

- [ ] **Step 6.1: Set up Resend**

  1. Sign up at https://resend.com
  2. Add your domain `ibdhealthhub.com` → verify DNS records
  3. Generate an API key → add to Vercel env vars as `RESEND_API_KEY`

- [ ] **Step 6.2: Write the failing test**

  Create `api/review/send.test.js`:
  ```javascript
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import { buildApprovalToken, parseApprovalToken } from './send.js';

  // Use a test secret
  process.env.JWT_SECRET = 'test-secret-32-chars-at-minimum!!';

  test('buildApprovalToken creates verifiable token', async () => {
    const token = await buildApprovalToken({ contentId: 'abc', reviewerId: 'r1', action: 'approve' });
    assert.ok(typeof token === 'string');
    assert.ok(token.split('.').length === 3); // JWT has 3 parts
  });

  test('parseApprovalToken round-trips correctly', async () => {
    const token = await buildApprovalToken({ contentId: 'abc', reviewerId: 'r1', action: 'approve' });
    const payload = await parseApprovalToken(token);
    assert.equal(payload.contentId, 'abc');
    assert.equal(payload.action, 'approve');
  });

  test('parseApprovalToken rejects tampered token', async () => {
    const token = await buildApprovalToken({ contentId: 'abc', reviewerId: 'r1', action: 'approve' });
    const tampered = token.slice(0, -5) + 'XXXXX';
    await assert.rejects(() => parseApprovalToken(tampered), /invalid/i);
  });
  ```

- [ ] **Step 6.3: Run test to verify it fails**

  ```bash
  node --test api/review/send.test.js
  ```

- [ ] **Step 6.4: Implement api/review/send.js**

  ```javascript
  import { kv } from '@vercel/kv';
  import { SignJWT, jwtVerify } from 'jose';
  import { Resend } from 'resend';

  const secret = new TextEncoder().encode(process.env.JWT_SECRET);
  const resend = new Resend(process.env.RESEND_API_KEY);
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
      from: process.env.RESEND_FROM_EMAIL,
      to: reviewer.email,
      subject: `Review requested: ${content.title}`,
      html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <img src="${APP_URL}/logo.png" alt="IBD Health Hub" style="height:48px;margin-bottom:24px" />
          <h2 style="color:#E05C00">Content Review Request</h2>
          <p>Hi ${reviewer.name},</p>
          <p><strong>${content.title}</strong> has been submitted for your review.</p>
          <blockquote style="border-left:4px solid #E05C00;padding-left:12px;color:#555">
            ${content.excerpt || content.body.substring(0, 200) + '…'}
          </blockquote>
          <div style="margin:32px 0">
            <a href="${approveUrl}"
               style="background:#E05C00;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;margin-right:12px">
              ✓ Approve
            </a>
            <a href="${rejectUrl}"
               style="background:#f0f0f0;color:#333;padding:12px 24px;border-radius:6px;text-decoration:none">
              ✗ Request Changes
            </a>
          </div>
          <p style="color:#888;font-size:12px">This link expires in 7 days.</p>
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
    if (!reviewers?.length) return res.status(400).json({ error: 'No reviewers configured' });

    // Mint tokens + send emails
    const emailPromises = reviewers.map(async reviewer => {
      const [approveToken, rejectToken] = await Promise.all([
        buildApprovalToken({ contentId, reviewerId: reviewer.id, action: 'approve' }),
        buildApprovalToken({ contentId, reviewerId: reviewer.id, action: 'reject' }),
      ]);
      const approveUrl = `${APP_URL}/api/review/${approveToken}`;
      const rejectUrl  = `${APP_URL}/api/review/${rejectToken}`;
      return resend.emails.send(buildApprovalEmail({ reviewer, content, approveUrl, rejectUrl }));
    });

    await Promise.all(emailPromises);

    // Update content item
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

    return res.json({ sent: reviewers.length, status: 'in_review' });
  }
  ```

- [ ] **Step 6.5: Add resend to package.json**

  ```bash
  npm install resend
  ```

- [ ] **Step 6.6: Run test to verify it passes**

  ```bash
  node --test api/review/send.test.js
  ```

- [ ] **Step 6.7: Commit**

  ```bash
  git add api/review/send.js api/review/send.test.js package.json package-lock.json
  git commit -m "feat: add review email sender with JWT approval tokens via Resend"
  ```

---

### Task 7: Handle approval/rejection clicks

**Files:**
- Create: `api/review/[token].js`

When a reviewer clicks the link in the email, this function:
1. Decodes and verifies the JWT
2. Loads the content item
3. Records the approval/rejection
4. If threshold met → advances status to `approved` or `rejected`
5. Returns a confirmation HTML page (no login required)

- [ ] **Step 7.1: Write the failing test**

  Create `api/review/[token].test.js`:
  ```javascript
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import { computeNewStatus } from './[token].js';

  test('any-approval: first approval advances to approved', () => {
    const item = { requireAllApprovals: false, reviewers: ['r1','r2'], approvals: ['r1'], rejections: [] };
    assert.equal(computeNewStatus(item), 'approved');
  });

  test('all-approval: partial approval stays in_review', () => {
    const item = { requireAllApprovals: true, reviewers: ['r1','r2'], approvals: ['r1'], rejections: [] };
    assert.equal(computeNewStatus(item), 'in_review');
  });

  test('all-approval: all approved advances to approved', () => {
    const item = { requireAllApprovals: true, reviewers: ['r1','r2'], approvals: ['r1','r2'], rejections: [] };
    assert.equal(computeNewStatus(item), 'approved');
  });

  test('any rejection sets to rejected', () => {
    const item = { requireAllApprovals: false, reviewers: ['r1','r2'], approvals: [], rejections: ['r1'] };
    assert.equal(computeNewStatus(item), 'rejected');
  });
  ```

- [ ] **Step 7.2: Run test to verify it fails**

  ```bash
  node --test api/review/[token].test.js
  ```

- [ ] **Step 7.3: Implement api/review/[token].js**

  ```javascript
  import { kv } from '@vercel/kv';
  import { parseApprovalToken } from '../review/send.js';

  // ── Pure logic (exported for testing) ───────────────────────────────────────

  export function computeNewStatus(item) {
    if (item.rejections.length > 0) return 'rejected';
    if (item.requireAllApprovals) {
      return item.approvals.length >= item.reviewers.length ? 'approved' : 'in_review';
    }
    return item.approvals.length > 0 ? 'approved' : 'in_review';
  }

  // ── HTML response pages ───────────────────────────────────────────────────────

  const page = (emoji, title, message) => `
    <!DOCTYPE html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title} — IBD Health Hub</title>
    <style>
      body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
           min-height:100vh;margin:0;background:#fafafa}
      .card{max-width:420px;text-align:center;padding:40px;background:#fff;
            border-radius:12px;box-shadow:0 2px 20px rgba(0,0,0,.08)}
      h1{color:#E05C00;font-size:2rem;margin:8px 0 4px}
      p{color:#555;line-height:1.6}
    </style></head><body>
    <div class="card">
      <div style="font-size:3rem">${emoji}</div>
      <h1>${title}</h1>
      <p>${message}</p>
      <p><a href="/" style="color:#E05C00">Return to app →</a></p>
    </div></body></html>
  `;

  // ── HTTP handler ─────────────────────────────────────────────────────────────

  export default async function handler(req, res) {
    const { token } = req.query;

    let payload;
    try {
      payload = await parseApprovalToken(token);
    } catch {
      res.setHeader('Content-Type', 'text/html');
      return res.status(400).send(page('⚠️', 'Link expired', 'This approval link has expired or is invalid. Please ask for a new review request.'));
    }

    const { contentId, reviewerId, action } = payload;
    const item = await kv.get(`content:${contentId}`);

    if (!item) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(404).send(page('🔍', 'Not found', 'This content item no longer exists.'));
    }

    // Prevent duplicate votes
    const alreadyVoted = item.approvals.includes(reviewerId) || item.rejections.includes(reviewerId);
    if (alreadyVoted) {
      res.setHeader('Content-Type', 'text/html');
      return res.send(page('✓', 'Already recorded', 'Your response has already been recorded. Thank you!'));
    }

    // Record vote
    if (action === 'approve') item.approvals.push(reviewerId);
    else item.rejections.push(reviewerId);

    item.status = computeNewStatus(item);
    item.updatedAt = new Date().toISOString();
    await kv.set(`content:${contentId}`, item);

    const isApprove = action === 'approve';
    res.setHeader('Content-Type', 'text/html');
    return res.send(page(
      isApprove ? '✅' : '↩️',
      isApprove ? 'Approved!' : 'Changes Requested',
      isApprove
        ? `You approved "<strong>${item.title}</strong>". ${item.status === 'approved' ? 'It is now approved and ready to schedule.' : 'Waiting for remaining reviewers.'}`
        : `You requested changes to "<strong>${item.title}</strong>". The author will be notified.`
    ));
  }
  ```

- [ ] **Step 7.4: Run test to verify it passes**

  ```bash
  node --test api/review/[token].test.js
  ```
  Expected: PASS (4 tests)

- [ ] **Step 7.5: Commit**

  ```bash
  git add api/review/[token].js api/review/[token].test.js
  git commit -m "feat: add approval click handler with multi-reviewer logic"
  ```

---

### Task 8: Add "Send for Review" UI to index.html

**Files:**
- Modify: `index.html`

- [ ] **Step 8.1: Add reviewer management panel**

  In the Settings tab (or create one if it doesn't exist), add:
  - List of current reviewers (name + email)
  - "Add Reviewer" form (name + email fields + Add button)
  - Remove button per reviewer
  - Toggle: "Require all reviewers to approve" (checkbox)

  Wire to `GET/POST/DELETE /api/reviewers`.

- [ ] **Step 8.2: Add "Send for Review" button to each content card**

  On each content item in `draft` status, show a **"Send for Review"** button.
  On click: `POST /api/review/send` with `{ contentId: item.id, requireAllApprovals }`.
  Show success toast: "Review request sent to N reviewers."
  Visually update the card to show status badge: **In Review**.

- [ ] **Step 8.3: Show approval status on content cards in review**

  For items in `in_review` state, display:
  - Progress: "1 of 3 approved" or "Changes requested by Alice"
  - Reviewer names with ✓/✗/⏳ per reviewer

- [ ] **Step 8.4: Manual end-to-end test**

  1. Add yourself as a reviewer in Settings
  2. Generate a content item
  3. Click "Send for Review"
  4. Check your inbox — you should receive the approval email
  5. Click "Approve" — browser opens the confirmation page
  6. Return to the app — content card shows "Approved" status

- [ ] **Step 8.5: Commit**

  ```bash
  git add index.html
  git commit -m "feat: add reviewer management UI and send-for-review workflow"
  ```

- [ ] **Step 8.6: Deploy**

  ```bash
  git push new-origin main
  ```

---

## Chunk 3: Pipeline UI + Scheduling + Google Calendar + WordPress Publisher

**What this delivers:** A Kanban-style pipeline view, date/time scheduling, Google Calendar sync so scheduled posts appear as calendar events, and a Vercel Cron job that auto-publishes to WordPress at the scheduled time.

---

### Task 9: Pipeline view in index.html

**Files:**
- Modify: `index.html`

The Pipeline tab shows content in columns by status: **Draft | In Review | Approved | Scheduled | Published**

- [ ] **Step 9.1: Add Pipeline tab**

  Add a new **"Pipeline"** tab button to the nav. When active, render a horizontal Kanban board:
  ```
  [Draft]   [In Review]   [Approved]   [Scheduled]   [Published]
   card         card         card          card           card
   card                                    card
  ```

- [ ] **Step 9.2: Implement pipeline data fetch**

  ```javascript
  async function loadPipeline() {
    const all = await api.getAll();
    const columns = { draft: [], in_review: [], approved: [], scheduled: [], published: [] };
    all.forEach(item => (columns[item.status] ?? []).push(item));
    renderPipeline(columns);
  }
  ```

- [ ] **Step 9.3: Add action buttons per card based on status**

  | Status | Available actions |
  |--------|------------------|
  | draft | Send for Review |
  | approved | Schedule Post |
  | scheduled | Publish Now, Reschedule |
  | published | View on WordPress |

- [ ] **Step 9.4: Commit**

  ```bash
  git add index.html
  git commit -m "feat: add pipeline kanban view"
  ```

---

### Task 10: Scheduling API + date picker UI

**Files:**
- Create: `api/schedule/index.js`
- Modify: `index.html`

- [ ] **Step 10.1: Write the failing test**

  Create `api/schedule/index.test.js`:
  ```javascript
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import { validateScheduleDate } from './index.js';

  test('accepts future date', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    assert.doesNotThrow(() => validateScheduleDate(future));
  });

  test('rejects past date', () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    assert.throws(() => validateScheduleDate(past), /future/i);
  });

  test('rejects invalid date string', () => {
    assert.throws(() => validateScheduleDate('not-a-date'), /invalid/i);
  });
  ```

- [ ] **Step 10.2: Implement api/schedule/index.js**

  ```javascript
  import { kv } from '@vercel/kv';

  export function validateScheduleDate(dateStr) {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) throw new Error('invalid date');
    if (d <= new Date()) throw new Error('scheduled date must be in the future');
  }

  export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { contentId, scheduledAt } = req.body;
    try { validateScheduleDate(scheduledAt); } catch (e) { return res.status(400).json({ error: e.message }); }

    const item = await kv.get(`content:${contentId}`);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (!['approved', 'scheduled'].includes(item.status)) {
      return res.status(400).json({ error: 'Content must be approved before scheduling' });
    }

    const updated = { ...item, status: 'scheduled', scheduledAt, updatedAt: new Date().toISOString() };
    await kv.set(`content:${contentId}`, updated);
    return res.json(updated);
  }
  ```

- [ ] **Step 10.3: Run tests**

  ```bash
  node --test api/schedule/index.test.js
  ```

- [ ] **Step 10.4: Add "Schedule Post" modal to index.html**

  When user clicks "Schedule Post" on an approved card:
  - Show a modal with a `<input type="datetime-local">` picker
  - "Schedule" button calls `POST /api/schedule` with `{ contentId, scheduledAt }`
  - On success, card moves to Scheduled column, shows the formatted date

- [ ] **Step 10.5: Commit**

  ```bash
  git add api/schedule/index.js api/schedule/index.test.js index.html
  git commit -m "feat: add scheduling API and date-picker UI"
  ```

---

### Task 11: Google Calendar sync

**Files:**
- Create: `api/calendar/auth.js`
- Create: `api/calendar/callback.js`
- Create: `api/calendar/sync.js`

**Flow:** User clicks "Connect Google Calendar" → OAuth redirect → callback stores tokens in KV → when content is scheduled, call `/api/calendar/sync` to create/update calendar event.

**Prerequisites:** Create a Google Cloud project, enable Calendar API, create OAuth 2.0 credentials (Web application type), add `GOOGLE_REDIRECT_URI` as an authorised redirect URI.

- [ ] **Step 11.1: Set up Google Cloud credentials**

  1. Go to https://console.cloud.google.com
  2. Create project → Enable **Google Calendar API**
  3. **Credentials** → Create OAuth 2.0 Client ID (Web application)
  4. Add authorised redirect URI: `https://ibdhealthhub-content-generator.vercel.app/api/calendar/callback`
  5. Copy Client ID + Secret → add to Vercel env vars

- [ ] **Step 11.2: Install googleapis**

  ```bash
  npm install googleapis
  ```

- [ ] **Step 11.3: Implement api/calendar/auth.js**

  ```javascript
  import { google } from 'googleapis';

  export function getOAuthClient() {
    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
  }

  export default function handler(req, res) {
    const oauth2Client = getOAuthClient();
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://www.googleapis.com/auth/calendar.events'],
      prompt: 'consent',
    });
    res.redirect(url);
  }
  ```

- [ ] **Step 11.4: Implement api/calendar/callback.js**

  ```javascript
  import { kv } from '@vercel/kv';
  import { getOAuthClient } from './auth.js';

  export default async function handler(req, res) {
    const { code, error } = req.query;
    if (error) return res.status(400).send(`<p>Google auth error: ${error}</p>`);

    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    await kv.set('google:calendar:tokens', tokens);

    res.send(`<script>window.opener?.postMessage('calendar-connected','*');window.close();</script>
              <p>Google Calendar connected! You can close this tab.</p>`);
  }
  ```

- [ ] **Step 11.5: Implement api/calendar/sync.js**

  ```javascript
  import { kv } from '@vercel/kv';
  import { google } from 'googleapis';
  import { getOAuthClient } from './auth.js';

  export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const { contentId } = req.body;
    const [item, tokens] = await Promise.all([
      kv.get(`content:${contentId}`),
      kv.get('google:calendar:tokens'),
    ]);

    if (!item) return res.status(404).json({ error: 'Not found' });
    if (!tokens) return res.status(400).json({ error: 'Google Calendar not connected' });
    if (!item.scheduledAt) return res.status(400).json({ error: 'Content not yet scheduled' });

    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(tokens);
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const start = new Date(item.scheduledAt);
    const end = new Date(start.getTime() + 30 * 60 * 1000); // 30-min block

    const event = {
      summary: `📝 Post: ${item.title}`,
      description: `Category: ${item.category}\n\nExcerpt: ${item.excerpt}\n\nManage: ${process.env.NEXT_PUBLIC_APP_URL}`,
      start: { dateTime: start.toISOString() },
      end:   { dateTime: end.toISOString() },
      colorId: '6', // Tangerine — matches IBD Health Hub orange
    };

    let result;
    if (item.gcalEventId) {
      result = await calendar.events.update({ calendarId: 'primary', eventId: item.gcalEventId, resource: event });
    } else {
      result = await calendar.events.insert({ calendarId: 'primary', resource: event });
    }

    const updated = { ...item, gcalEventId: result.data.id, updatedAt: new Date().toISOString() };
    await kv.set(`content:${contentId}`, updated);

    // Refresh tokens if rotated
    if (oauth2Client.credentials.access_token !== tokens.access_token) {
      await kv.set('google:calendar:tokens', oauth2Client.credentials);
    }

    return res.json({ gcalEventId: result.data.id });
  }
  ```

- [ ] **Step 11.6: Add "Connect Google Calendar" button to Settings tab**

  ```javascript
  function connectGoogleCalendar() {
    const popup = window.open('/api/calendar/auth', 'gcal', 'width=500,height=600');
    window.addEventListener('message', async e => {
      if (e.data === 'calendar-connected') {
        popup.close();
        showToast('Google Calendar connected!');
        updateCalendarStatus(true);
      }
    }, { once: true });
  }
  ```

- [ ] **Step 11.7: Call sync after scheduling**

  In the schedule success handler in index.html, after `POST /api/schedule` succeeds, also call:
  ```javascript
  await fetch('/api/calendar/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contentId })
  });
  ```

- [ ] **Step 11.8: Commit**

  ```bash
  git add api/calendar/ index.html package.json package-lock.json
  git commit -m "feat: add Google Calendar OAuth + sync scheduled posts as calendar events"
  ```

---

### Task 12: WordPress publisher API

**Files:**
- Create: `api/publish/index.js`

The WordPress REST API is used with **Application Passwords** (no OAuth needed — simpler and perfectly secure for server-to-server).

**Prerequisites:**
1. In WordPress Admin → Users → Your Profile → scroll to **Application Passwords**
2. Enter name "SLA Content Generator" → Click **Add New**
3. Copy the generated password (format: `xxxx xxxx xxxx xxxx xxxx xxxx`)
4. Add to Vercel env vars: `WP_USERNAME`, `WP_APP_PASSWORD`, `WP_SITE_URL`

- [ ] **Step 12.1: Write the failing test**

  Create `api/publish/index.test.js`:
  ```javascript
  import assert from 'node:assert/strict';
  import { test } from 'node:test';
  import { buildWpPayload } from './index.js';

  test('buildWpPayload maps category correctly', () => {
    const item = { title: 'Test Post', body: '<p>Hello</p>', excerpt: 'Short', category: 'clinical-review', template: 'standard' };
    const payload = buildWpPayload(item, { 'clinical-review': 5 });
    assert.equal(payload.title, 'Test Post');
    assert.deepEqual(payload.categories, [5]);
    assert.equal(payload.status, 'publish');
  });

  test('buildWpPayload uses uncategorised if category not mapped', () => {
    const item = { title: 'x', body: 'y', excerpt: '', category: 'unknown' };
    const payload = buildWpPayload(item, {});
    assert.deepEqual(payload.categories, []);
  });
  ```

- [ ] **Step 12.2: Implement api/publish/index.js**

  ```javascript
  import { kv } from '@vercel/kv';

  // Map app category slugs to WordPress category IDs
  // Update these IDs to match your WordPress installation
  const CATEGORY_MAP = {
    'clinical-review':  5,
    'news':             1,
    'drug-information': 8,
    'patient-info':     12,
  };

  export function buildWpPayload(item, categoryMap) {
    return {
      title:      item.title,
      content:    item.body,
      excerpt:    item.excerpt,
      status:     'publish',
      categories: categoryMap[item.category] ? [categoryMap[item.category]] : [],
    };
  }

  async function publishToWordPress(item) {
    const credentials = Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString('base64');
    const url = `${process.env.WP_SITE_URL}/wp-json/wp/v2/posts`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Basic ${credentials}`,
      },
      body: JSON.stringify(buildWpPayload(item, CATEGORY_MAP)),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`WordPress API error ${response.status}: ${err}`);
    }

    return response.json();
  }

  export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const { contentId } = req.body;
    if (!contentId) return res.status(400).json({ error: 'contentId required' });

    const item = await kv.get(`content:${contentId}`);
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (!['approved', 'scheduled'].includes(item.status)) {
      return res.status(400).json({ error: 'Content must be approved or scheduled to publish' });
    }

    let wpPost;
    try {
      wpPost = await publishToWordPress(item);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }

    const updated = {
      ...item,
      status: 'published',
      publishedAt: new Date().toISOString(),
      wpPostId: wpPost.id,
      wpPostUrl: wpPost.link,
      updatedAt: new Date().toISOString(),
    };
    await kv.set(`content:${contentId}`, updated);
    return res.json({ wpPostId: wpPost.id, wpPostUrl: wpPost.link });
  }
  ```

- [ ] **Step 12.3: Run tests**

  ```bash
  node --test api/publish/index.test.js
  ```

- [ ] **Step 12.4: Commit**

  ```bash
  git add api/publish/index.js api/publish/index.test.js
  git commit -m "feat: add WordPress REST API publisher"
  ```

---

### Task 13: Vercel Cron — auto-publish scheduled posts

**Files:**
- Create: `api/cron/publish.js`
- Modify: `vercel.json`

The cron job runs every 5 minutes. It scans all content items for those with `status: 'scheduled'` and `scheduledAt <= now`, then publishes each one.

- [ ] **Step 13.1: Implement api/cron/publish.js**

  ```javascript
  import { kv } from '@vercel/kv';

  export default async function handler(req, res) {
    // Vercel cron sends a GET request; validate the cron secret header
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const ids = await kv.lrange('content:index', 0, -1);
    const items = await Promise.all(ids.map(id => kv.get(`content:${id}`)));

    const now = new Date();
    const due = items.filter(item =>
      item?.status === 'scheduled' &&
      item.scheduledAt &&
      new Date(item.scheduledAt) <= now
    );

    const results = await Promise.allSettled(
      due.map(item =>
        fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/publish`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.CRON_SECRET}`,
          },
          body: JSON.stringify({ contentId: item.id }),
        })
      )
    );

    const published = results.filter(r => r.status === 'fulfilled').length;
    const failed    = results.filter(r => r.status === 'rejected').length;

    console.log(`Cron: ${published} published, ${failed} failed out of ${due.length} due`);
    return res.json({ published, failed, total: due.length });
  }
  ```

- [ ] **Step 13.2: Add CRON_SECRET to Vercel env vars**

  ```bash
  # Generate a random secret
  openssl rand -hex 32
  ```
  Add the output as `CRON_SECRET` in Vercel dashboard.

- [ ] **Step 13.3: Update vercel.json with cron config**

  Current `vercel.json` (or create if it doesn't exist):
  ```json
  {
    "crons": [
      {
        "path": "/api/cron/publish",
        "schedule": "*/5 * * * *"
      }
    ]
  }
  ```
  Note: Vercel Cron requires a **Pro plan**. On the free Hobby plan, use the "Publish Now" button in the Pipeline view instead — it calls `POST /api/publish` directly from the browser.

- [ ] **Step 13.4: Add "Publish Now" button for manual override**

  In the Pipeline view, Scheduled cards show a **"Publish Now"** button:
  ```javascript
  async function publishNow(contentId) {
    const r = await fetch('/api/publish', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ contentId })
    });
    const data = await r.json();
    if (data.wpPostUrl) showToast(`Published! <a href="${data.wpPostUrl}" target="_blank">View on site →</a>`);
    await loadPipeline();
  }
  ```

- [ ] **Step 13.5: Commit**

  ```bash
  git add api/cron/publish.js vercel.json index.html
  git commit -m "feat: add Vercel cron auto-publisher and manual publish-now button"
  ```

---

### Task 14: Final deploy + end-to-end verification

- [ ] **Step 14.1: Push all changes**

  ```bash
  git push new-origin main
  ```

- [ ] **Step 14.2: Verify full workflow**

  Walk through each stage manually on the live Vercel URL:

  | Step | Action | Expected result |
  |------|--------|----------------|
  | 1 | Generate content | Content appears in Pipeline → Draft column |
  | 2 | Click "Send for Review" | Reviewers receive email within 30 seconds |
  | 3 | Reviewer clicks Approve | Browser shows confirmation page, card moves to Approved |
  | 4 | Click "Schedule Post", pick future date | Card moves to Scheduled, Google Calendar event created |
  | 5 | Click "Publish Now" | Card moves to Published, post appears on ibdhealthhub.com |
  | 6 | Click "View on WordPress" | Opens correct post on live site |

- [ ] **Step 14.3: Verify cron works (Pro plan only)**

  In Vercel dashboard → **Cron Jobs** tab, manually trigger the cron. Check logs for output like: `Cron: 1 published, 0 failed out of 1 due`.

- [ ] **Step 14.4: Tag release**

  ```bash
  git tag v1.0.0
  git push new-origin v1.0.0
  ```

---

## Tool & Service Summary

| Service | Purpose | Free tier? | Approx cost |
|---------|---------|-----------|-------------|
| **Vercel KV** | Content state storage (Redis) | 30MB / 30K req/mo | Free for this usage |
| **Resend.com** | Approval emails | 3,000 emails/mo free | Free |
| **Google Calendar API** | Calendar sync | Unlimited | Free |
| **WordPress REST API** | Publish posts | N/A (self-hosted) | Free |
| **Vercel Cron** | Auto-scheduling | Pro plan only ($20/mo) | $20/mo or manual publish |

**Total additional cost to run this workflow: £0 – £16/mo** depending on whether you need automatic scheduling.

---

## Implementation Order (recommended)

```
Chunk 1 (3–4 hrs) → Deploy → Verify storage working
Chunk 2 (3–4 hrs) → Deploy → Verify approval emails working
Chunk 3 (4–5 hrs) → Deploy → Full end-to-end test
```

Each chunk is independently deployable and testable. Don't start Chunk 2 until Chunk 1 is on the live site and confirmed working.

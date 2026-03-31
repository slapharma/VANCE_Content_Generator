# Automation Module Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Rule Engine + Job Queue automation layer that generates, reviews, notifies, and publishes content automatically based on configurable rules — without touching any existing pipeline, review, or publish logic.

**Architecture:** New `api/automation/` API layer stores rules and jobs in Vercel KV. A 15-minute Vercel cron evaluates which rules are due, fetches from sources (RSS/URL/GitHub), delegates generation to the existing `/api/content` endpoint, then either auto-publishes or holds the job in an Automation Inbox awaiting approval via Telegram inline buttons or email JWT links. UI additions to `index.html` add an "Automation" nav item with Rules and Inbox sub-views plus a 5-step creation wizard.

**Tech Stack:** Vercel KV, Vercel Cron, jose (JWT — already installed), Resend (already installed), Telegram Bot API (new webhook), node-cron-parser (new), RSS parsing via native fetch + DOMParser in node, existing `api/content/index.js` for generation, existing `api/review/send.js` JWT pattern for email approval tokens.

**Scope note — OAuth sources deferred:** Google Drive and Dropbox sources require OAuth2 redirect flows. These are stubbed in the wizard UI with "Coming soon" placeholders and excluded from the backend fetch logic. RSS, URL, and GitHub sources are fully implemented.

---

## Chunk 1: Rule CRUD API

### Task 1: Rule schema helpers

**Files:**
- Create: `api/automation/rule-schema.js`
- Create: `api/automation/rule-schema.test.js`

- [ ] **Step 1: Write failing tests**

```js
// api/automation/rule-schema.test.js
import { buildRule, validateRule } from './rule-schema.js';

test('buildRule sets defaults', () => {
  const rule = buildRule({
    name: 'Test Rule',
    category: 'clinical-reviews',
    sources: [{ type: 'rss', url: 'https://example.com/feed' }],
    trigger: { type: 'schedule', cron: '0 7 * * 1' },
  });
  expect(rule.id).toMatch(/^rule_/);
  expect(rule.enabled).toBe(true);
  expect(rule.review.required).toBe(true);
  expect(rule.review.timeoutHours).toBe(48);
  expect(rule.review.onTimeout).toBe('approve');
  expect(rule.generation.maxArticlesPerRun).toBe(3);
  expect(rule.stats.totalRuns).toBe(0);
  expect(rule.createdAt).toBeTruthy();
});

test('validateRule throws on missing name', () => {
  expect(() => validateRule({ category: 'x', sources: [{}], trigger: { type: 'schedule' } }))
    .toThrow('name is required');
});

test('validateRule throws on missing category', () => {
  expect(() => validateRule({ name: 'x', sources: [{}], trigger: { type: 'schedule' } }))
    .toThrow('category is required');
});

test('validateRule throws on empty sources', () => {
  expect(() => validateRule({ name: 'x', category: 'x', sources: [], trigger: { type: 'schedule' } }))
    .toThrow('at least one source is required');
});

test('validateRule throws on invalid trigger type', () => {
  expect(() => validateRule({ name: 'x', category: 'x', sources: [{}], trigger: { type: 'bad' } }))
    .toThrow('trigger.type must be schedule, event, or volume');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd "C:/Users/clift/.Claude/projects/C--Users-clift--Claude-SLA-Content Generator/IBD Health Hub_ClinicalReview_Generator"
npx jest api/automation/rule-schema.test.js --no-coverage
```
Expected: FAIL — "Cannot find module './rule-schema.js'"

- [ ] **Step 3: Implement rule-schema.js**

```js
// api/automation/rule-schema.js
import { randomUUID } from 'crypto';

export function buildRule(data) {
  const now = new Date().toISOString();
  return {
    id: `rule_${randomUUID()}`,
    name: data.name,
    enabled: data.enabled ?? true,
    category: data.category,
    wpCategorySlug: data.wpCategorySlug ?? null,

    sources: data.sources ?? [],

    trigger: {
      type: data.trigger?.type ?? 'schedule',
      cron: data.trigger?.cron ?? '0 7 * * 1',
      eventType: data.trigger?.eventType ?? null,
      volumeThreshold: data.trigger?.volumeThreshold ?? null,
      minGapHours: data.trigger?.minGapHours ?? 4,
    },

    generation: {
      template: data.generation?.template ?? 'standard',
      maxArticlesPerRun: data.generation?.maxArticlesPerRun ?? 3,
      prompt: data.generation?.prompt ?? '',
      combineMode: data.generation?.combineMode ?? 'one-per-item',
    },

    review: {
      required: data.review?.required ?? true,
      mode: data.review?.mode ?? 'any',
      timeoutHours: data.review?.timeoutHours ?? 48,
      onTimeout: data.review?.onTimeout ?? 'approve',
    },

    notifications: {
      telegram: {
        enabled: data.notifications?.telegram?.enabled ?? false,
        chatId: data.notifications?.telegram?.chatId ?? null,
        allowApproval: data.notifications?.telegram?.allowApproval ?? false,
      },
      email: {
        enabled: data.notifications?.email?.enabled ?? false,
        to: data.notifications?.email?.to ?? [],
        allowApproval: data.notifications?.email?.allowApproval ?? false,
      },
    },

    publish: {
      auto: data.publish?.auto ?? true,
      scheduleTime: data.publish?.scheduleTime ?? null,
      wordpress: data.publish?.wordpress ?? true,
    },

    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    stats: { totalRuns: 0, articlesGenerated: 0, articlesPublished: 0 },
  };
}

export function validateRule(data) {
  if (!data.name) throw new Error('name is required');
  if (!data.category) throw new Error('category is required');
  if (!data.sources || data.sources.length === 0) throw new Error('at least one source is required');
  if (!data.trigger?.type || !['schedule', 'event', 'volume'].includes(data.trigger.type)) {
    throw new Error('trigger.type must be schedule, event, or volume');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest api/automation/rule-schema.test.js --no-coverage
```
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add api/automation/rule-schema.js api/automation/rule-schema.test.js
git commit -m "feat(automation): add rule schema builder and validator"
```

---

### Task 2: Rule CRUD API — list and create

**Files:**
- Create: `api/automation/rules/index.js`
- Create: `api/automation/rules/index.test.js`

KV keys used:
- `automation:rules:index` — list of rule IDs (lpush)
- `automation:rule:<id>` — individual rule object

- [ ] **Step 1: Write failing tests**

```js
// api/automation/rules/index.test.js
import { jest } from '@jest/globals';
import { createMocks } from 'node-mocks-http';

// Mock KV
const kvStore = {};
jest.unstable_mockModule('@vercel/kv', () => ({
  kv: {
    get: jest.fn(async (k) => kvStore[k] ?? null),
    set: jest.fn(async (k, v) => { kvStore[k] = v; }),
    lpush: jest.fn(async (k, v) => { kvStore[k] = [v, ...(kvStore[k] ?? [])]; }),
    lrange: jest.fn(async (k) => kvStore[k] ?? []),
  },
}));

const { default: handler } = await import('./index.js');

beforeEach(() => { Object.keys(kvStore).forEach(k => delete kvStore[k]); });

test('GET returns empty array when no rules', async () => {
  const { req, res } = createMocks({ method: 'GET' });
  await handler(req, res);
  expect(res._getStatusCode()).toBe(200);
  expect(JSON.parse(res._getData())).toEqual([]);
});

test('POST creates a rule and returns it', async () => {
  const { req, res } = createMocks({
    method: 'POST',
    body: {
      name: 'Test Rule',
      category: 'clinical-reviews',
      sources: [{ type: 'rss', url: 'https://example.com/feed' }],
      trigger: { type: 'schedule', cron: '0 7 * * 1' },
    },
  });
  await handler(req, res);
  expect(res._getStatusCode()).toBe(201);
  const body = JSON.parse(res._getData());
  expect(body.id).toMatch(/^rule_/);
  expect(body.name).toBe('Test Rule');
});

test('POST returns 400 on validation error', async () => {
  const { req, res } = createMocks({ method: 'POST', body: { name: 'No category' } });
  await handler(req, res);
  expect(res._getStatusCode()).toBe(400);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest api/automation/rules/index.test.js --no-coverage
```
Expected: FAIL — "Cannot find module './index.js'"

- [ ] **Step 3: Implement rules/index.js**

```js
// api/automation/rules/index.js
import { kv } from '@vercel/kv';
import { buildRule, validateRule } from '../rule-schema.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const ids = await kv.lrange('automation:rules:index', 0, -1);
    if (!ids.length) return res.status(200).json([]);
    const rules = await Promise.all(ids.map(id => kv.get(`automation:rule:${id}`)));
    return res.status(200).json(rules.filter(Boolean));
  }

  if (req.method === 'POST') {
    try {
      validateRule(req.body);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const rule = buildRule(req.body);
    await kv.set(`automation:rule:${rule.id}`, rule);
    await kv.lpush('automation:rules:index', rule.id);
    return res.status(201).json(rule);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest api/automation/rules/index.test.js --no-coverage
```
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add api/automation/rules/index.js api/automation/rules/index.test.js
git commit -m "feat(automation): add rule list and create endpoint"
```

---

### Task 3: Rule CRUD API — get, update, delete

**Files:**
- Create: `api/automation/rules/[id].js`
- Create: `api/automation/rules/[id].test.js`

- [ ] **Step 1: Write failing tests**

```js
// api/automation/rules/[id].test.js
import { jest } from '@jest/globals';
import { createMocks } from 'node-mocks-http';

const kvStore = {};
jest.unstable_mockModule('@vercel/kv', () => ({
  kv: {
    get: jest.fn(async (k) => kvStore[k] ?? null),
    set: jest.fn(async (k, v) => { kvStore[k] = v; }),
    del: jest.fn(async (k) => { delete kvStore[k]; }),
    lrange: jest.fn(async (k) => kvStore[k] ?? []),
    lrem: jest.fn(async (k, _, v) => {
      kvStore[k] = (kvStore[k] ?? []).filter(x => x !== v);
    }),
  },
}));

const { default: handler } = await import('./[id].js');

const RULE = {
  id: 'rule_abc123',
  name: 'My Rule',
  enabled: true,
  category: 'clinical-reviews',
  sources: [],
  trigger: { type: 'schedule', cron: '0 7 * * 1' },
  review: { required: true, timeoutHours: 48, onTimeout: 'approve' },
  notifications: { telegram: { enabled: false }, email: { enabled: false, to: [] } },
  stats: { totalRuns: 0, articlesGenerated: 0, articlesPublished: 0 },
};

beforeEach(() => {
  Object.keys(kvStore).forEach(k => delete kvStore[k]);
  kvStore['automation:rule:rule_abc123'] = { ...RULE };
  kvStore['automation:rules:index'] = ['rule_abc123'];
});

test('GET returns rule by id', async () => {
  const { req, res } = createMocks({ method: 'GET', query: { id: 'rule_abc123' } });
  await handler(req, res);
  expect(res._getStatusCode()).toBe(200);
  expect(JSON.parse(res._getData()).name).toBe('My Rule');
});

test('GET returns 404 for unknown id', async () => {
  const { req, res } = createMocks({ method: 'GET', query: { id: 'rule_nope' } });
  await handler(req, res);
  expect(res._getStatusCode()).toBe(404);
});

test('PATCH updates rule fields', async () => {
  const { req, res } = createMocks({
    method: 'PATCH',
    query: { id: 'rule_abc123' },
    body: { enabled: false },
  });
  await handler(req, res);
  expect(res._getStatusCode()).toBe(200);
  expect(JSON.parse(res._getData()).enabled).toBe(false);
});

test('DELETE removes rule', async () => {
  const { req, res } = createMocks({ method: 'DELETE', query: { id: 'rule_abc123' } });
  await handler(req, res);
  expect(res._getStatusCode()).toBe(200);
  expect(kvStore['automation:rule:rule_abc123']).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest "api/automation/rules/\[id\].test.js" --no-coverage
```
Expected: FAIL — "Cannot find module"

- [ ] **Step 3: Implement [id].js**

```js
// api/automation/rules/[id].js
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const { id } = req.query;

  if (req.method === 'GET') {
    const rule = await kv.get(`automation:rule:${id}`);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    return res.status(200).json(rule);
  }

  if (req.method === 'PATCH') {
    const rule = await kv.get(`automation:rule:${id}`);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    const updated = { ...rule, ...req.body, id, updatedAt: new Date().toISOString() };
    await kv.set(`automation:rule:${id}`, updated);
    return res.status(200).json(updated);
  }

  if (req.method === 'DELETE') {
    await kv.del(`automation:rule:${id}`);
    await kv.lrem('automation:rules:index', 0, id);
    return res.status(200).json({ deleted: id });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest "api/automation/rules/\[id\].test.js" --no-coverage
```
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add "api/automation/rules/[id].js" "api/automation/rules/[id].test.js"
git commit -m "feat(automation): add rule get/update/delete endpoint"
```

---

### Task 4: Job schema helpers

**Files:**
- Create: `api/automation/job-schema.js`
- Create: `api/automation/job-schema.test.js`

KV keys:
- `automation:jobs:index` — all job IDs
- `automation:jobs:pending` — IDs of jobs with status `pending_review`
- `automation:job:<id>` — individual job object

- [ ] **Step 1: Write failing tests**

```js
// api/automation/job-schema.test.js
import { buildJob } from './job-schema.js';

test('buildJob sets defaults', () => {
  const job = buildJob({ ruleId: 'rule_abc', contentId: 'content_xyz' });
  expect(job.id).toMatch(/^job_/);
  expect(job.status).toBe('pending_review');
  expect(job.approvedBy).toBeNull();
  expect(job.createdAt).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest api/automation/job-schema.test.js --no-coverage
```
Expected: FAIL

- [ ] **Step 3: Implement job-schema.js**

```js
// api/automation/job-schema.js
import { randomUUID } from 'crypto';

export function buildJob(data) {
  const now = new Date().toISOString();
  return {
    id: `job_${randomUUID()}`,
    ruleId: data.ruleId,
    contentId: data.contentId,
    status: data.status ?? 'pending_review',
    // status values: pending_review | approved | rejected | published | timed_out | auto_published
    notifiedAt: data.notifiedAt ?? null,
    approvedAt: null,
    rejectedAt: null,
    approvedBy: null,   // 'telegram' | 'email' | 'timeout' | 'manual'
    createdAt: now,
    updatedAt: now,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest api/automation/job-schema.test.js --no-coverage
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/automation/job-schema.js api/automation/job-schema.test.js
git commit -m "feat(automation): add job schema builder"
```

---

## Chunk 2: Approval & Notification API

### Task 5: Automation Inbox jobs endpoint

**Files:**
- Create: `api/automation/jobs/index.js`
- Create: `api/automation/jobs/index.test.js`

- [ ] **Step 1: Write failing tests**

```js
// api/automation/jobs/index.test.js
import { jest } from '@jest/globals';
import { createMocks } from 'node-mocks-http';

const JOB = { id: 'job_1', ruleId: 'rule_abc', contentId: 'content_xyz', status: 'pending_review', createdAt: '2026-03-20T10:00:00Z', updatedAt: '2026-03-20T10:00:00Z' };
const kvStore = { 'automation:jobs:index': ['job_1'], 'automation:job:job_1': JOB };

jest.unstable_mockModule('@vercel/kv', () => ({
  kv: {
    lrange: jest.fn(async (k) => kvStore[k] ?? []),
    get: jest.fn(async (k) => kvStore[k] ?? null),
  },
}));

const { default: handler } = await import('./index.js');

test('GET returns all jobs', async () => {
  const { req, res } = createMocks({ method: 'GET' });
  await handler(req, res);
  expect(res._getStatusCode()).toBe(200);
  expect(JSON.parse(res._getData())).toHaveLength(1);
});

test('GET ?status=pending_review filters jobs', async () => {
  const { req, res } = createMocks({ method: 'GET', query: { status: 'pending_review' } });
  await handler(req, res);
  const body = JSON.parse(res._getData());
  expect(body.every(j => j.status === 'pending_review')).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest api/automation/jobs/index.test.js --no-coverage
```
Expected: FAIL

- [ ] **Step 3: Implement jobs/index.js**

```js
// api/automation/jobs/index.js
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const ids = await kv.lrange('automation:jobs:index', 0, -1);
    if (!ids.length) return res.status(200).json([]);
    const jobs = await Promise.all(ids.map(id => kv.get(`automation:job:${id}`)));
    const valid = jobs.filter(Boolean);
    const { status, ruleId } = req.query;
    const filtered = valid.filter(j => {
      if (status && j.status !== status) return false;
      if (ruleId && j.ruleId !== ruleId) return false;
      return true;
    });
    return res.status(200).json(filtered);
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest api/automation/jobs/index.test.js --no-coverage
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add api/automation/jobs/index.js api/automation/jobs/index.test.js
git commit -m "feat(automation): add automation jobs list endpoint"
```

---

### Task 6: Approval handler (all channels)

**Files:**
- Create: `api/automation/approve.js`
- Create: `api/automation/approve.test.js`

This is the single convergence point for Telegram, email, and timeout approvals. It:
1. Validates the incoming request (JWT for email, plain object for Telegram/internal)
2. Updates the job status in KV
3. Updates the content item status (calls existing content patch)
4. If approved: triggers publish via existing `/api/publish`

Note: Use `APP_URL` env var for internal calls to `/api/publish`.

- [ ] **Step 1: Write failing tests**

```js
// api/automation/approve.test.js
import { jest } from '@jest/globals';
import { createMocks } from 'node-mocks-http';

const JOB = { id: 'job_1', ruleId: 'rule_r1', contentId: 'content_c1', status: 'pending_review', createdAt: '2026-03-20T10:00:00Z', updatedAt: '2026-03-20T10:00:00Z' };
const RULE = { id: 'rule_r1', review: { required: true }, publish: { wordpress: true } };

const kvStore = {
  'automation:job:job_1': { ...JOB },
  'automation:rule:rule_r1': { ...RULE },
};

jest.unstable_mockModule('@vercel/kv', () => ({
  kv: {
    get: jest.fn(async (k) => kvStore[k] ?? null),
    set: jest.fn(async (k, v) => { kvStore[k] = v; }),
  },
}));

// Mock fetch for publish call
global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) }));

const { default: handler } = await import('./approve.js');

beforeEach(() => {
  kvStore['automation:job:job_1'] = { ...JOB };
  global.fetch.mockClear();
});

test('approve via internal channel updates job status', async () => {
  const { req, res } = createMocks({
    method: 'POST',
    body: { jobId: 'job_1', action: 'approve', channel: 'manual' },
  });
  await handler(req, res);
  expect(res._getStatusCode()).toBe(200);
  expect(kvStore['automation:job:job_1'].status).toBe('approved');
  expect(kvStore['automation:job:job_1'].approvedBy).toBe('manual');
});

test('reject via internal channel updates job status', async () => {
  const { req, res } = createMocks({
    method: 'POST',
    body: { jobId: 'job_1', action: 'reject', channel: 'manual' },
  });
  await handler(req, res);
  expect(res._getStatusCode()).toBe(200);
  expect(kvStore['automation:job:job_1'].status).toBe('rejected');
});

test('returns 404 for unknown job', async () => {
  const { req, res } = createMocks({
    method: 'POST',
    body: { jobId: 'job_nope', action: 'approve', channel: 'manual' },
  });
  await handler(req, res);
  expect(res._getStatusCode()).toBe(404);
});

test('returns 409 if job already actioned', async () => {
  kvStore['automation:job:job_1'] = { ...JOB, status: 'approved' };
  const { req, res } = createMocks({
    method: 'POST',
    body: { jobId: 'job_1', action: 'approve', channel: 'manual' },
  });
  await handler(req, res);
  expect(res._getStatusCode()).toBe(409);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest api/automation/approve.test.js --no-coverage
```
Expected: FAIL

- [ ] **Step 3: Implement approve.js**

```js
// api/automation/approve.js
import { kv } from '@vercel/kv';
import { jwtVerify } from 'jose';

const secret = new TextEncoder().encode(process.env.JWT_SECRET ?? 'dev-secret-replace-in-production');
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

const TERMINAL_STATUSES = ['approved', 'rejected', 'published', 'timed_out'];

// GET /api/automation/approve/[token] — email link click
// POST /api/automation/approve — Telegram webhook / manual / timeout
export default async function handler(req, res) {
  let jobId, action, channel;

  if (req.method === 'GET') {
    // Email link: /api/automation/approve?token=<jwt>
    try {
      const { payload } = await jwtVerify(req.query.token, secret);
      jobId = payload.jobId;
      action = payload.action;
      channel = 'email';
    } catch {
      return res.status(400).send('<h2>Invalid or expired approval link.</h2>');
    }
  } else if (req.method === 'POST') {
    ({ jobId, action, channel } = req.body);
    if (!jobId || !action) return res.status(400).json({ error: 'jobId and action required' });
  } else {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const job = await kv.get(`automation:job:${jobId}`);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (TERMINAL_STATUSES.includes(job.status)) {
    return res.status(409).json({ error: `Job already ${job.status}` });
  }

  const now = new Date().toISOString();

  if (action === 'approve') {
    const updated = { ...job, status: 'approved', approvedAt: now, approvedBy: channel, updatedAt: now };
    await kv.set(`automation:job:${jobId}`, updated);

    // Trigger publish via existing endpoint
    const rule = await kv.get(`automation:rule:${job.ruleId}`);
    if (rule?.publish?.wordpress) {
      await fetch(`${APP_URL}/api/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.contentId }),
      });
      await kv.set(`automation:job:${jobId}`, { ...updated, status: 'published' });
    }

    if (req.method === 'GET') return res.redirect(302, `${APP_URL}?approved=1`);
    return res.status(200).json({ status: 'approved', jobId });
  }

  if (action === 'reject') {
    await kv.set(`automation:job:${jobId}`, {
      ...job, status: 'rejected', rejectedAt: now, approvedBy: channel, updatedAt: now,
    });
    if (req.method === 'GET') return res.redirect(302, `${APP_URL}?rejected=1`);
    return res.status(200).json({ status: 'rejected', jobId });
  }

  return res.status(400).json({ error: 'action must be approve or reject' });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest api/automation/approve.test.js --no-coverage
```
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add api/automation/approve.js api/automation/approve.test.js
git commit -m "feat(automation): add unified approval handler (email/telegram/manual)"
```

---

### Task 7: Telegram webhook handler

**Files:**
- Create: `api/automation/telegram.js`
- Create: `api/automation/telegram.test.js`

Telegram sends a POST to this webhook when a user taps an inline button. The payload includes `callback_query.data` which we set to `approve:job_1` or `reject:job_1`.

The handler:
1. Verifies the request is from Telegram (checks `X-Telegram-Bot-Api-Secret-Token` header)
2. Parses `callback_query.data` → `{ action, jobId }`
3. Calls the approve handler logic (imported, not HTTP)
4. Answers the callback query (clears the spinner in Telegram)

- [ ] **Step 1: Write failing tests**

```js
// api/automation/telegram.test.js
import { jest } from '@jest/globals';
import { createMocks } from 'node-mocks-http';

const kvStore = {
  'automation:job:job_1': { id: 'job_1', ruleId: 'rule_r1', contentId: 'c1', status: 'pending_review', createdAt: '', updatedAt: '' },
  'automation:rule:rule_r1': { id: 'rule_r1', review: { required: true }, publish: { wordpress: false } },
};
jest.unstable_mockModule('@vercel/kv', () => ({
  kv: {
    get: jest.fn(async (k) => kvStore[k] ?? null),
    set: jest.fn(async (k, v) => { kvStore[k] = v; }),
  },
}));
global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({}) }));

process.env.TELEGRAM_WEBHOOK_SECRET = 'test-secret';
process.env.TELEGRAM_BOT_TOKEN = 'bot-token';

const { default: handler } = await import('./telegram.js');

test('rejects requests without correct secret header', async () => {
  const { req, res } = createMocks({
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
    body: {},
  });
  await handler(req, res);
  expect(res._getStatusCode()).toBe(401);
});

test('handles approve callback_query', async () => {
  const { req, res } = createMocks({
    method: 'POST',
    headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
    body: {
      callback_query: {
        id: 'cq_1',
        data: 'approve:job_1',
        message: { chat: { id: '-100123' }, message_id: 42 },
      },
    },
  });
  await handler(req, res);
  expect(res._getStatusCode()).toBe(200);
  expect(kvStore['automation:job:job_1'].status).toBe('approved');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest api/automation/telegram.test.js --no-coverage
```
Expected: FAIL

- [ ] **Step 3: Implement telegram.js**

```js
// api/automation/telegram.js
import { kv } from '@vercel/kv';

const TERMINAL_STATUSES = ['approved', 'rejected', 'published', 'timed_out'];
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

async function answerCallbackQuery(callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const { callback_query } = req.body;
  if (!callback_query) return res.status(200).json({ ok: true }); // non-button update, ignore

  const [action, jobId] = (callback_query.data ?? '').split(':');
  if (!jobId || !['approve', 'reject'].includes(action)) {
    await answerCallbackQuery(callback_query.id, 'Unknown action');
    return res.status(200).json({ ok: true });
  }

  const job = await kv.get(`automation:job:${jobId}`);
  if (!job) {
    await answerCallbackQuery(callback_query.id, 'Job not found');
    return res.status(200).json({ ok: true });
  }
  if (TERMINAL_STATUSES.includes(job.status)) {
    await answerCallbackQuery(callback_query.id, `Already ${job.status}`);
    return res.status(200).json({ ok: true });
  }

  const now = new Date().toISOString();

  if (action === 'approve') {
    const updated = { ...job, status: 'approved', approvedAt: now, approvedBy: 'telegram', updatedAt: now };
    await kv.set(`automation:job:${jobId}`, updated);

    const rule = await kv.get(`automation:rule:${job.ruleId}`);
    if (rule?.publish?.wordpress) {
      await fetch(`${APP_URL}/api/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.contentId }),
      });
      await kv.set(`automation:job:${jobId}`, { ...updated, status: 'published' });
    }
    await answerCallbackQuery(callback_query.id, '✅ Approved — publishing now');
  } else {
    await kv.set(`automation:job:${jobId}`, { ...job, status: 'rejected', rejectedAt: now, approvedBy: 'telegram', updatedAt: now });
    await answerCallbackQuery(callback_query.id, '❌ Rejected');
  }

  return res.status(200).json({ ok: true });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest api/automation/telegram.test.js --no-coverage
```
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add api/automation/telegram.js api/automation/telegram.test.js
git commit -m "feat(automation): add Telegram webhook handler for inline approvals"
```

---

## Chunk 3: Cron Runner & Source Fetcher

### Task 8: Source fetcher (RSS, URL, GitHub)

**Files:**
- Create: `api/automation/fetch.js`
- Create: `api/automation/fetch.test.js`

This module exports `fetchSources(sources, lastRunAt)` — given an array of source configs and a timestamp, returns an array of `{ title, url, rawText, sourceType }` items newer than `lastRunAt`.

Supported types this plan: `rss`, `url`, `github`.

- [ ] **Step 1: Write failing tests**

```js
// api/automation/fetch.test.js
import { jest } from '@jest/globals';
import { parseRssItems, filterNewItems } from './fetch.js';

test('parseRssItems extracts title and link from RSS XML', () => {
  const xml = `<?xml version="1.0"?>
    <rss><channel>
      <item><title>Article One</title><link>https://example.com/1</link><pubDate>Mon, 20 Mar 2026 10:00:00 +0000</pubDate></item>
      <item><title>Article Two</title><link>https://example.com/2</link><pubDate>Mon, 20 Mar 2026 09:00:00 +0000</pubDate></item>
    </channel></rss>`;
  const items = parseRssItems(xml);
  expect(items).toHaveLength(2);
  expect(items[0].title).toBe('Article One');
  expect(items[0].url).toBe('https://example.com/1');
  expect(items[0].pubDate).toBeTruthy();
});

test('filterNewItems filters by lastRunAt', () => {
  const items = [
    { title: 'New', url: 'https://a.com/1', pubDate: new Date('2026-03-20T10:00:00Z') },
    { title: 'Old', url: 'https://a.com/2', pubDate: new Date('2026-03-15T10:00:00Z') },
  ];
  const result = filterNewItems(items, '2026-03-18T00:00:00Z');
  expect(result).toHaveLength(1);
  expect(result[0].title).toBe('New');
});

test('filterNewItems returns all items if no lastRunAt', () => {
  const items = [
    { title: 'A', url: 'https://a.com/1', pubDate: new Date('2026-03-20T10:00:00Z') },
  ];
  expect(filterNewItems(items, null)).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest api/automation/fetch.test.js --no-coverage
```
Expected: FAIL

- [ ] **Step 3: Implement fetch.js**

```js
// api/automation/fetch.js

// ── RSS ───────────────────────────────────────────────────────────────────────

export function parseRssItems(xml) {
  // Simple regex-based RSS parser — avoids DOMParser dependency in Node
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/s.exec(block) ?? [])[1] ?? (/<title>(.*?)<\/title>/s.exec(block) ?? [])[1] ?? '';
    const url = (/<link>(.*?)<\/link>/s.exec(block) ?? [])[1]?.trim() ?? '';
    const pubDateStr = (/<pubDate>(.*?)<\/pubDate>/s.exec(block) ?? [])[1]?.trim() ?? null;
    const pubDate = pubDateStr ? new Date(pubDateStr) : new Date();
    items.push({ title: title.trim(), url, pubDate, rawText: '' });
  }
  return items;
}

export function filterNewItems(items, lastRunAt) {
  if (!lastRunAt) return items;
  const since = new Date(lastRunAt);
  return items.filter(item => item.pubDate > since);
}

async function fetchRss(source, lastRunAt) {
  const res = await fetch(source.url, { headers: { 'User-Agent': 'SLAHealth-AutoBot/1.0' } });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status} ${source.url}`);
  const xml = await res.text();
  const items = parseRssItems(xml);
  return filterNewItems(items, lastRunAt).map(i => ({ ...i, sourceType: 'rss' }));
}

async function fetchUrl(source) {
  // Fetches raw HTML; content generation prompt will summarise it
  const res = await fetch(source.url, { headers: { 'User-Agent': 'SLAHealth-AutoBot/1.0' } });
  if (!res.ok) throw new Error(`URL fetch failed: ${res.status} ${source.url}`);
  const rawText = await res.text();
  return [{ title: source.url, url: source.url, rawText, sourceType: 'url', pubDate: new Date() }];
}

async function fetchGitHub(source) {
  const { repo, path = '', branch = 'main' } = source;
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`;
  const res = await fetch(apiUrl, {
    headers: {
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub fetch failed: ${res.status} ${apiUrl}`);
  const files = await res.json();
  const mdFiles = Array.isArray(files) ? files.filter(f => f.name.endsWith('.md')) : [];
  const results = [];
  for (const file of mdFiles.slice(0, 5)) { // max 5 files per run
    const fileRes = await fetch(file.download_url);
    const rawText = await fileRes.text();
    results.push({ title: file.name.replace('.md', ''), url: file.html_url, rawText, sourceType: 'github', pubDate: new Date() });
  }
  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function fetchSources(sources, lastRunAt) {
  const results = [];
  for (const source of sources) {
    try {
      switch (source.type) {
        case 'rss':    results.push(...await fetchRss(source, lastRunAt)); break;
        case 'url':    results.push(...await fetchUrl(source)); break;
        case 'github': results.push(...await fetchGitHub(source)); break;
        default:       console.warn(`Unsupported source type: ${source.type}`);
      }
    } catch (err) {
      console.error(`Source fetch error (${source.type} ${source.url ?? source.repo}):`, err.message);
      // Non-fatal: skip failed sources, continue with others
    }
  }
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest api/automation/fetch.test.js --no-coverage
```
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add api/automation/fetch.js api/automation/fetch.test.js
git commit -m "feat(automation): add source fetcher for RSS, URL, and GitHub sources"
```

---

### Task 9: Notification sender

**Files:**
- Create: `api/automation/notify.js`
- Create: `api/automation/notify.test.js`

Sends Telegram message (with inline approve/reject buttons) and/or email (with JWT approve/reject links) when a new automation job is created and review is required.

- [ ] **Step 1: Write failing tests**

```js
// api/automation/notify.test.js
import { jest } from '@jest/globals';
import { buildTelegramPayload, buildApprovalEmailHtml } from './notify.js';

test('buildTelegramPayload includes inline keyboard with approve/reject', () => {
  const payload = buildTelegramPayload({
    chatId: '-100123',
    jobId: 'job_1',
    title: 'Test Article',
    category: 'Clinical Reviews',
    ruleId: 'rule_r1',
  });
  expect(payload.chat_id).toBe('-100123');
  expect(payload.reply_markup.inline_keyboard[0]).toHaveLength(2);
  expect(payload.reply_markup.inline_keyboard[0][0].callback_data).toBe('approve:job_1');
  expect(payload.reply_markup.inline_keyboard[0][1].callback_data).toBe('reject:job_1');
});

test('buildApprovalEmailHtml contains approve and reject URLs', () => {
  const html = buildApprovalEmailHtml({
    title: 'Test Article',
    category: 'Clinical Reviews',
    approveUrl: 'https://app.sla.co.uk/api/automation/approve?token=abc',
    rejectUrl: 'https://app.sla.co.uk/api/automation/approve?token=xyz',
  });
  expect(html).toContain('approve?token=abc');
  expect(html).toContain('approve?token=xyz');
  expect(html).toContain('Test Article');
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx jest api/automation/notify.test.js --no-coverage
```
Expected: FAIL

- [ ] **Step 3: Implement notify.js**

```js
// api/automation/notify.js
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
      <div style="background:#1e2d40;padding:20px 24px;border-bottom:3px solid #F47920;">
        <span style="color:#fff;font-size:20px;font-weight:800;">IBD Health Hub</span>
        <span style="color:#F47920;font-size:20px;font-weight:800;"> ■</span>
      </div>
      <div style="padding:28px 24px;">
        <h2 style="color:#1e2d40;">Automation Review Required</h2>
        <p style="color:#555;">A new article has been generated and requires your approval:</p>
        <table cellpadding="12" style="background:#f0f2f5;border-radius:8px;border-left:3px solid #F47920;width:100%;margin-bottom:24px;">
          <tr><td>
            <p style="font-size:11px;color:#6b7a8d;text-transform:uppercase;margin:0 0 4px;">Article</p>
            <p style="font-size:16px;font-weight:bold;color:#1e2d40;margin:0 0 4px;">${title}</p>
            <p style="font-size:13px;color:#6b7a8d;margin:0;">${category}</p>
          </td></tr>
        </table>
        <table width="100%"><tr>
          <td width="48%">
            <a href="${approveUrl}" style="display:block;text-align:center;background:#F47920;color:#fff;padding:14px;border-radius:6px;text-decoration:none;font-weight:bold;">✅ Approve & Publish</a>
          </td>
          <td width="4%"></td>
          <td width="48%">
            <a href="${rejectUrl}" style="display:block;text-align:center;background:#e53e3e;color:#fff;padding:14px;border-radius:6px;text-decoration:none;font-weight:bold;">❌ Reject</a>
          </td>
        </tr></table>
        <p style="color:#999;font-size:12px;margin-top:24px;">These links expire after ${48}h. Log in to the IBD Health Hub dashboard to review manually.</p>
      </div>
    </div>`;
}

export async function sendNotifications({ rule, job, content }) {
  const { notifications, review } = rule;
  const errors = [];

  // Telegram
  if (notifications.telegram?.enabled && process.env.TELEGRAM_BOT_TOKEN) {
    try {
      const payload = buildTelegramPayload({
        chatId: notifications.telegram.chatId,
        jobId: job.id,
        title: content.title,
        category: content.category,
      });
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
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
      const rejectUrl  = `${APP_URL}/api/automation/approve?token=${rejectToken}`;
      const html = buildApprovalEmailHtml({ title: content.title, category: content.category, approveUrl, rejectUrl });

      await getResend().emails.send({
        from: process.env.RESEND_FROM_EMAIL ?? 'noreply@mail.ibdhealthhub.com',
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx jest api/automation/notify.test.js --no-coverage
```
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add api/automation/notify.js api/automation/notify.test.js
git commit -m "feat(automation): add notification sender for Telegram and email"
```

---

### Task 10: Cron runner + vercel.json update

**Files:**
- Create: `api/automation/run.js`
- Create: `api/automation/run.test.js`
- Modify: `vercel.json`

The cron runner is the orchestrator: it loads enabled rules, decides which are due, fetches sources, calls the existing content creation API, creates jobs, sends notifications, and handles timeouts.

- [ ] **Step 1: Update vercel.json to add the cron**

```json
{
  "github": { "enabled": false, "silent": true },
  "crons": [
    { "path": "/api/cron/publish",     "schedule": "0 8 * * *"  },
    { "path": "/api/automation/run",   "schedule": "*/15 * * * *" }
  ]
}
```

- [ ] **Step 2: Write failing tests for rule evaluation logic**

```js
// api/automation/run.test.js
import { jest } from '@jest/globals';
import { isRuleDue, evaluateCron } from './run.js';

test('evaluateCron returns true when cron was due since lastRunAt', () => {
  // Rule: every Monday 07:00. lastRunAt was Sunday. Now is Monday 08:00.
  const isDue = evaluateCron('0 7 * * 1', '2026-03-15T08:00:00Z', '2026-03-16T08:00:00Z');
  expect(isDue).toBe(true);
});

test('evaluateCron returns false when cron was not due since lastRunAt', () => {
  // Rule: every Monday 07:00. lastRunAt was Monday 06:00, now is Monday 06:30
  const isDue = evaluateCron('0 7 * * 1', '2026-03-16T06:00:00Z', '2026-03-16T06:30:00Z');
  expect(isDue).toBe(false);
});

test('isRuleDue returns true for schedule rule that is due', () => {
  const rule = {
    enabled: true,
    trigger: { type: 'schedule', cron: '0 7 * * 1' },
    lastRunAt: '2026-03-15T08:00:00Z',
  };
  expect(isRuleDue(rule, '2026-03-16T08:00:00Z')).toBe(true);
});

test('isRuleDue returns false for disabled rule', () => {
  const rule = {
    enabled: false,
    trigger: { type: 'schedule', cron: '0 7 * * 1' },
    lastRunAt: null,
  };
  expect(isRuleDue(rule, '2026-03-16T08:00:00Z')).toBe(false);
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx jest api/automation/run.test.js --no-coverage
```
Expected: FAIL

- [ ] **Step 4: Install cron-parser**

```bash
npm install cron-parser
```

- [ ] **Step 5: Implement run.js**

```js
// api/automation/run.js
import { kv } from '@vercel/kv';
import cronParser from 'cron-parser';
import { fetchSources } from './fetch.js';
import { buildJob } from './job-schema.js';
import { sendNotifications } from './notify.js';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
const TERMINAL_STATUSES = ['approved', 'rejected', 'published', 'timed_out'];

// ── Cron evaluation helpers (exported for testing) ────────────────────────────

export function evaluateCron(cronExpression, lastRunAt, now) {
  try {
    const interval = cronParser.parseExpression(cronExpression, {
      currentDate: new Date(now),
      iterator: true,
    });
    const prev = interval.prev();
    const prevDate = prev.value.toDate();
    const sinceDate = lastRunAt ? new Date(lastRunAt) : new Date(0);
    return prevDate > sinceDate;
  } catch {
    return false;
  }
}

export function isRuleDue(rule, now) {
  if (!rule.enabled) return false;
  const { trigger, lastRunAt } = rule;

  if (trigger.type === 'schedule') {
    return evaluateCron(trigger.cron, lastRunAt, now);
  }
  if (trigger.type === 'event') {
    // Event-driven: check on every cron tick, enforcing minGapHours
    if (!lastRunAt) return true;
    const gap = (new Date(now) - new Date(lastRunAt)) / (1000 * 60 * 60);
    return gap >= (trigger.minGapHours ?? 4);
  }
  // volume: handled separately via source cache (deferred — returns false for now)
  return false;
}

// ── Timeout processor ─────────────────────────────────────────────────────────

async function processTimeouts(now) {
  const ids = await kv.lrange('automation:jobs:index', 0, -1);
  for (const id of ids) {
    const job = await kv.get(`automation:job:${id}`);
    if (!job || job.status !== 'pending_review') continue;
    const rule = await kv.get(`automation:rule:${job.ruleId}`);
    if (!rule) continue;
    const ageHours = (new Date(now) - new Date(job.createdAt)) / (1000 * 60 * 60);
    if (ageHours < rule.review.timeoutHours) continue;

    const onTimeout = rule.review.onTimeout ?? 'approve';
    if (onTimeout === 'approve') {
      await fetch(`${APP_URL}/api/automation/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, action: 'approve', channel: 'timeout' }),
      });
    } else if (onTimeout === 'reject') {
      await fetch(`${APP_URL}/api/automation/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, action: 'reject', channel: 'timeout' }),
      });
    } else {
      // 'skip' — mark as timed out without actioning
      await kv.set(`automation:job:${id}`, { ...job, status: 'timed_out', updatedAt: now });
    }
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Allow Vercel cron (GET) or manual trigger (POST)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const now = new Date().toISOString();
  const results = { processed: 0, errors: [] };

  // 1. Process timeouts first
  await processTimeouts(now);

  // 2. Load all enabled rules
  const ids = await kv.lrange('automation:rules:index', 0, -1);
  if (!ids.length) return res.status(200).json({ ...results, message: 'No rules configured' });

  const rules = (await Promise.all(ids.map(id => kv.get(`automation:rule:${id}`)))).filter(Boolean);
  const dueRules = rules.filter(r => isRuleDue(r, now));

  for (const rule of dueRules) {
    try {
      // 3. Fetch sources
      const sourceItems = await fetchSources(rule.sources, rule.lastRunAt);
      if (!sourceItems.length) continue;

      // 4. Generate content (up to maxArticlesPerRun)
      const toProcess = sourceItems.slice(0, rule.generation.maxArticlesPerRun);
      for (const item of toProcess) {
        // Call existing content creation endpoint
        const genRes = await fetch(`${APP_URL}/api/content`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: item.title,
            body: item.rawText ?? '',
            category: rule.category,
            wpCategorySlug: rule.wpCategorySlug ?? null,
            template: rule.generation.template,
            automationRuleId: rule.id,
          }),
        });
        if (!genRes.ok) { results.errors.push(`Content gen failed: ${item.title}`); continue; }
        const content = await genRes.json();

        if (rule.review.required) {
          // 5a. Create job and notify
          const job = buildJob({ ruleId: rule.id, contentId: content.id });
          await kv.set(`automation:job:${job.id}`, job);
          await kv.lpush('automation:jobs:index', job.id);

          const notifyErrors = await sendNotifications({ rule, job, content });
          if (notifyErrors.length) results.errors.push(...notifyErrors);

          // Mark job as notified
          await kv.set(`automation:job:${job.id}`, { ...job, notifiedAt: now });
        } else {
          // 5b. Auto-publish immediately
          await fetch(`${APP_URL}/api/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: content.id }),
          });
          // Create a completed job for audit trail
          const job = buildJob({ ruleId: rule.id, contentId: content.id, status: 'auto_published' });
          await kv.set(`automation:job:${job.id}`, { ...job, approvedBy: 'auto', approvedAt: now });
          await kv.lpush('automation:jobs:index', job.id);
        }
        results.processed++;
      }

      // 6. Update rule.lastRunAt and stats
      await kv.set(`automation:rule:${rule.id}`, {
        ...rule,
        lastRunAt: now,
        updatedAt: now,
        stats: {
          ...rule.stats,
          totalRuns: (rule.stats.totalRuns ?? 0) + 1,
          articlesGenerated: (rule.stats.articlesGenerated ?? 0) + toProcess.length,
        },
      });
    } catch (err) {
      results.errors.push(`Rule ${rule.id}: ${err.message}`);
    }
  }

  return res.status(200).json(results);
}
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
npx jest api/automation/run.test.js --no-coverage
```
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add api/automation/run.js api/automation/run.test.js vercel.json
git commit -m "feat(automation): add cron runner with rule evaluation and timeout processing"
```

---

## Chunk 4: UI — Automation Tab & Inbox

### Task 11: Automation nav item and tab scaffolding

**Files:**
- Modify: `index.html` (nav + tab containers + CSS)

- [ ] **Step 1: Add "Automation" nav item**

In `index.html`, find the nav items section (the list of `<li>` items with tab IDs). Add after the Reviews nav item:

```html
<li><a href="#" onclick="switchTab('automation'); return false;" id="nav-automation" data-tab="automation">
  <span class="nav-icon">⚙️</span>
  <span class="nav-label">Automation</span>
  <span id="automationInboxBadge" class="nav-badge" style="display:none">0</span>
</a></li>
```

Add the `.nav-badge` CSS:
```css
.nav-badge {
  display: inline-block; background: var(--sla-orange); color: #fff;
  font-size: 0.6rem; font-weight: 700; border-radius: 10px;
  padding: 1px 5px; margin-left: 4px; vertical-align: middle;
}
```

- [ ] **Step 2: Add automation tab container**

After the archive tab `<div>`, add:

```html
<!-- ═══════════════════ AUTOMATION TAB ═══════════════════ -->
<div id="tab-automation" class="tab-content" style="display:none">
  <div class="page-header">
    <h1>Automation</h1>
    <div class="page-header-actions">
      <button class="btn-sub-tab active" id="subTabRules" onclick="switchAutoSubTab('rules')">📋 Rules</button>
      <button class="btn-sub-tab" id="subTabInbox" onclick="switchAutoSubTab('inbox')">
        📥 Inbox
        <span id="inboxBadgeHeader" class="nav-badge" style="display:none">0</span>
      </button>
    </div>
  </div>

  <!-- Rules sub-view -->
  <div id="autoSubRules">
    <div class="auto-rules-header">
      <button class="btn-primary" onclick="openRuleWizard()">+ New Rule</button>
    </div>
    <div id="autoRulesList" class="auto-rules-list">
      <p class="empty-state">No automation rules yet. Create your first rule to get started.</p>
    </div>
  </div>

  <!-- Inbox sub-view -->
  <div id="autoSubInbox" style="display:none">
    <div class="pipeline-layout">
      <div class="pipeline-left" id="autoInboxList"></div>
      <div class="pipeline-right" id="autoInboxDetail">
        <div class="empty-state-panel">Select an item from the inbox to review</div>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Add sub-tab CSS**

```css
.btn-sub-tab {
  padding: 6px 14px; border-radius: 20px; border: 1px solid var(--border);
  background: transparent; color: var(--text-muted); font-size: 0.8rem;
  font-weight: 600; cursor: pointer; transition: all 0.15s;
}
.btn-sub-tab.active {
  background: var(--sla-orange); border-color: var(--sla-orange); color: #fff;
}
.auto-rules-header { display: flex; justify-content: flex-end; margin-bottom: 16px; }
.auto-rules-list { display: flex; flex-direction: column; gap: 12px; }
.auto-rule-card {
  background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px;
  padding: 16px 20px; display: flex; align-items: center; gap: 16px;
}
.auto-rule-status { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.auto-rule-status.enabled  { background: #22c55e; }
.auto-rule-status.disabled { background: #ef4444; }
.auto-rule-info { flex: 1; }
.auto-rule-name { font-weight: 700; font-size: 0.95rem; color: var(--text); margin-bottom: 2px; }
.auto-rule-meta { font-size: 0.75rem; color: var(--text-muted); }
.auto-rule-actions { display: flex; gap: 8px; }
```

- [ ] **Step 4: Add JS scaffolding**

```js
// Sub-tab switcher
function switchAutoSubTab(tab) {
  document.getElementById('autoSubRules').style.display = tab === 'rules' ? '' : 'none';
  document.getElementById('autoSubInbox').style.display = tab === 'inbox' ? '' : 'none';
  document.getElementById('subTabRules').classList.toggle('active', tab === 'rules');
  document.getElementById('subTabInbox').classList.toggle('active', tab === 'inbox');
  if (tab === 'inbox') loadAutoInbox();
}

// Called when switching to automation tab
function loadAutomation() {
  switchAutoSubTab('rules');
  loadAutoRules();
  updateInboxBadge();
}
```

Ensure `switchTab` calls `loadAutomation()` when `tabName === 'automation'`.

- [ ] **Step 5: Verify tab appears in browser**

Open the app locally (`npm run dev`), click Automation nav item, confirm the tab appears with empty state messages.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat(automation): add automation tab scaffold with rules/inbox sub-views"
```

---

### Task 12: Rules list rendering

**Files:**
- Modify: `index.html` (JS — `loadAutoRules`, rule card renderer, toggle/delete/clone)

- [ ] **Step 1: Implement loadAutoRules()**

```js
async function loadAutoRules() {
  const list = document.getElementById('autoRulesList');
  list.innerHTML = '<p class="text-muted">Loading rules...</p>';
  try {
    const rules = await apiFetch('/api/automation/rules');
    if (!rules.length) {
      list.innerHTML = '<p class="empty-state">No automation rules yet. Create your first rule to get started.</p>';
      return;
    }
    list.innerHTML = rules.map(r => renderRuleCard(r)).join('');
  } catch (err) {
    list.innerHTML = `<p class="error-state">Failed to load rules: ${err.message}</p>`;
  }
}

function renderRuleCard(rule) {
  const triggerLabel = rule.trigger.type === 'schedule'
    ? `Cron: ${rule.trigger.cron}`
    : rule.trigger.type === 'event' ? 'Event-driven' : 'Volume-based';
  const reviewLabel = rule.review.required ? 'Requires review' : 'Auto-publish';
  const notifParts = [];
  if (rule.notifications.telegram.enabled) notifParts.push('Telegram');
  if (rule.notifications.email.enabled) notifParts.push('Email');
  const notifLabel = notifParts.length ? notifParts.join('+') : 'No notifications';
  const lastRun = rule.lastRunAt ? `Last run: ${timeAgo(rule.lastRunAt)}` : 'Never run';

  return `<div class="auto-rule-card" id="ruleCard-${rule.id}">
    <div class="auto-rule-status ${rule.enabled ? 'enabled' : 'disabled'}"></div>
    <div class="auto-rule-info">
      <div class="auto-rule-name">${escHtml(rule.name)}</div>
      <div class="auto-rule-meta">${escHtml(rule.category)} · ${triggerLabel} · ${rule.sources.length} source${rule.sources.length !== 1 ? 's' : ''} · ${reviewLabel} · ${notifLabel}</div>
      <div class="auto-rule-meta">${lastRun} · ${rule.stats.articlesGenerated} generated · ${rule.stats.articlesPublished} published</div>
    </div>
    <div class="auto-rule-actions">
      <button class="btn-icon" title="${rule.enabled ? 'Pause' : 'Resume'}" onclick="toggleRule('${rule.id}', ${!rule.enabled})">${rule.enabled ? '⏸' : '▶️'}</button>
      <button class="btn-icon" title="Clone" onclick="cloneRule('${rule.id}')">⧉</button>
      <button class="btn-icon" title="Edit" onclick="openRuleWizard('${rule.id}')">✏️</button>
      <button class="btn-icon btn-icon-danger" title="Delete" onclick="deleteRuleConfirm('${rule.id}', '${escHtml(rule.name)}')">🗑</button>
    </div>
  </div>`;
}

async function toggleRule(id, enabled) {
  await apiFetch(`/api/automation/rules/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
  loadAutoRules();
}

async function cloneRule(id) {
  const rules = await apiFetch('/api/automation/rules');
  const source = rules.find(r => r.id === id);
  if (!source) return;
  const clone = { ...source, name: source.name + ' (copy)', id: undefined };
  await apiFetch('/api/automation/rules', { method: 'POST', body: JSON.stringify(clone) });
  loadAutoRules();
  showToast('Rule cloned');
}

function deleteRuleConfirm(id, name) {
  if (!confirm(`Delete rule "${name}"? This cannot be undone.`)) return;
  apiFetch(`/api/automation/rules/${id}`, { method: 'DELETE' })
    .then(() => { loadAutoRules(); showToast('Rule deleted'); });
}
```

- [ ] **Step 2: Verify rule cards render correctly**

Create a test rule via the browser console:
```js
apiFetch('/api/automation/rules', {
  method: 'POST',
  body: JSON.stringify({
    name: 'Test Rule',
    category: 'clinical-reviews',
    sources: [{ type: 'rss', url: 'https://feeds.bmj.com/bmj/recent' }],
    trigger: { type: 'schedule', cron: '0 7 * * 1' },
  })
});
```
Reload the Automation tab — confirm the rule card appears with correct metadata.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(automation): add rules list rendering with toggle/clone/delete actions"
```

---

### Task 13: Automation Inbox rendering

**Files:**
- Modify: `index.html` (JS — `loadAutoInbox`, inbox card renderer, detail panel)

- [ ] **Step 1: Implement loadAutoInbox() and inbox badge**

```js
async function loadAutoInbox() {
  const list = document.getElementById('autoInboxList');
  list.innerHTML = '<p class="text-muted" style="padding:16px">Loading...</p>';
  try {
    const jobs = await apiFetch('/api/automation/jobs?status=pending_review');
    if (!jobs.length) {
      list.innerHTML = '<p class="empty-state" style="padding:16px">No items pending review.</p>';
      return;
    }
    list.innerHTML = jobs.map(j => renderInboxCard(j)).join('');
  } catch (err) {
    list.innerHTML = `<p class="error-state" style="padding:16px">${err.message}</p>`;
  }
}

async function updateInboxBadge() {
  try {
    const jobs = await apiFetch('/api/automation/jobs?status=pending_review');
    const count = jobs.length;
    const badge = document.getElementById('automationInboxBadge');
    const headerBadge = document.getElementById('inboxBadgeHeader');
    [badge, headerBadge].forEach(b => {
      if (!b) return;
      b.textContent = count;
      b.style.display = count > 0 ? '' : 'none';
    });
  } catch { /* non-fatal */ }
}

function renderInboxCard(job) {
  const age = timeAgo(job.createdAt);
  return `<div class="pipeline-item" onclick="openInboxJob('${job.id}')" id="inboxCard-${job.id}">
    <div class="pipeline-item-title">🕐 Pending Review</div>
    <div class="pipeline-item-meta">${escHtml(job.contentId)}</div>
    <div class="pipeline-item-time">${age}</div>
  </div>`;
}

async function openInboxJob(jobId) {
  const detail = document.getElementById('autoInboxDetail');
  detail.innerHTML = '<p class="text-muted" style="padding:24px">Loading...</p>';
  try {
    const job = await apiFetch(`/api/automation/jobs/${jobId}`);
    const content = await apiFetch(`/api/content/${job.contentId}`);
    const rule = await apiFetch(`/api/automation/rules/${job.ruleId}`);
    detail.innerHTML = renderInboxDetail(job, content, rule);
  } catch (err) {
    detail.innerHTML = `<p class="error-state" style="padding:24px">${err.message}</p>`;
  }
}

function renderInboxDetail(job, content, rule) {
  return `<div class="inbox-detail">
    <div class="inbox-detail-header">
      <h2>${escHtml(content.title)}</h2>
      <div class="text-muted" style="font-size:0.8rem">Rule: ${escHtml(rule.name)} · Source: ${content.category}</div>
    </div>
    <div class="inbox-detail-body">${content.body ?? ''}</div>
    <div class="inbox-detail-actions">
      <button class="btn-primary" onclick="approveInboxJob('${job.id}')">✅ Approve & Publish</button>
      <button class="btn-danger"  onclick="rejectInboxJob('${job.id}')">❌ Reject</button>
    </div>
  </div>`;
}

async function approveInboxJob(jobId) {
  await apiFetch('/api/automation/approve', {
    method: 'POST',
    body: JSON.stringify({ jobId, action: 'approve', channel: 'manual' }),
  });
  showToast('Approved and published');
  loadAutoInbox();
  document.getElementById('autoInboxDetail').innerHTML = '<div class="empty-state-panel">Select an item from the inbox to review</div>';
  updateInboxBadge();
}

async function rejectInboxJob(jobId) {
  await apiFetch('/api/automation/approve', {
    method: 'POST',
    body: JSON.stringify({ jobId, action: 'reject', channel: 'manual' }),
  });
  showToast('Rejected');
  loadAutoInbox();
  document.getElementById('autoInboxDetail').innerHTML = '<div class="empty-state-panel">Select an item from the inbox to review</div>';
  updateInboxBadge();
}
```

- [ ] **Step 2: Add jobs/[id] endpoint**

Create `api/automation/jobs/[id].js`:

```js
// api/automation/jobs/[id].js
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const { id } = req.query;
  if (req.method === 'GET') {
    const job = await kv.get(`automation:job:${id}`);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.status(200).json(job);
  }
  return res.status(405).json({ error: 'Method not allowed' });
}
```

- [ ] **Step 3: Verify inbox renders correctly**

Manually create a job via KV or by triggering a rule, switch to Inbox sub-tab, confirm cards appear and detail loads on click.

- [ ] **Step 4: Commit**

```bash
git add index.html "api/automation/jobs/[id].js"
git commit -m "feat(automation): add automation inbox with approve/reject actions"
```

---

## Chunk 5: Rule Creation Wizard

### Task 14: Wizard modal scaffold (Steps 1–3)

**Files:**
- Modify: `index.html` (wizard modal HTML + CSS + JS)

The wizard is a fullscreen modal with 5 steps. This task builds Steps 1–3 and the step navigation.

- [ ] **Step 1: Add wizard modal HTML**

```html
<!-- ═══════════════════ RULE WIZARD MODAL ═══════════════════ -->
<div id="ruleWizardModal" class="modal-overlay" style="display:none" onclick="if(event.target===this)closeRuleWizard()">
  <div class="modal-panel modal-panel-wide">
    <div class="modal-header">
      <h2 id="ruleWizardTitle">New Automation Rule</h2>
      <button class="modal-close" onclick="closeRuleWizard()">✕</button>
    </div>

    <!-- Step indicator -->
    <div class="wizard-steps">
      <div class="wizard-step active" id="wStep1">① Sources</div>
      <div class="wizard-step" id="wStep2">② Trigger</div>
      <div class="wizard-step" id="wStep3">③ Generation</div>
      <div class="wizard-step" id="wStep4">④ Review</div>
      <div class="wizard-step" id="wStep5">⑤ Notify</div>
    </div>

    <!-- Step containers -->
    <div id="wPanel1" class="wizard-panel">
      <h3>Step 1: Sources</h3>
      <div class="form-row">
        <label>Rule Name</label>
        <input id="wRuleName" type="text" class="form-input" placeholder="e.g. NHS Clinical Weekly Digest" maxlength="60">
      </div>
      <div class="form-row">
        <label>Category</label>
        <select id="wRuleCategory" class="form-input"></select>
      </div>
      <div id="wSourcesList" class="sources-list"></div>
      <div class="source-add-buttons">
        <button class="btn-add-source" onclick="addSource('rss')">+ RSS Feed</button>
        <button class="btn-add-source" onclick="addSource('url')">+ URL</button>
        <button class="btn-add-source" onclick="addSource('github')">+ GitHub</button>
        <button class="btn-add-source btn-add-source-dim" disabled title="Coming soon">+ Google Drive</button>
        <button class="btn-add-source btn-add-source-dim" disabled title="Coming soon">+ Dropbox</button>
      </div>
    </div>

    <div id="wPanel2" class="wizard-panel" style="display:none">
      <h3>Step 2: Trigger</h3>
      <div class="form-row">
        <label>When should this rule run?</label>
        <div class="radio-group">
          <label><input type="radio" name="wTriggerType" value="schedule" checked onchange="updateTriggerUI()"> Schedule</label>
          <label><input type="radio" name="wTriggerType" value="event" onchange="updateTriggerUI()"> Event-driven</label>
          <label><input type="radio" name="wTriggerType" value="volume" onchange="updateTriggerUI()"> Volume-based</label>
        </div>
      </div>
      <div id="wTriggerSchedule">
        <div class="form-row">
          <label>Preset</label>
          <select id="wCronPreset" class="form-input" onchange="updateCronFromPreset()">
            <option value="0 7 * * 1">Weekly (Mondays 07:00)</option>
            <option value="0 7 * * *">Daily (07:00)</option>
            <option value="0 7 1,15 * *">Bi-weekly (1st & 15th)</option>
            <option value="0 7 1 * *">Monthly (1st)</option>
            <option value="custom">Custom cron expression</option>
          </select>
        </div>
        <div id="wCustomCronRow" class="form-row" style="display:none">
          <label>Cron Expression</label>
          <input id="wCronExpr" type="text" class="form-input" placeholder="0 7 * * 1">
          <div id="wCronPreview" class="form-hint text-muted"></div>
        </div>
      </div>
      <div id="wTriggerEvent" style="display:none">
        <div class="form-row">
          <label>Minimum gap between runs (hours)</label>
          <input id="wMinGapHours" type="number" class="form-input" value="4" min="1" max="168">
        </div>
      </div>
      <div class="form-row">
        <label>Max articles per run</label>
        <input id="wMaxArticles" type="number" class="form-input" value="3" min="1" max="10">
      </div>
    </div>

    <div id="wPanel3" class="wizard-panel" style="display:none">
      <h3>Step 3: Generation</h3>
      <div class="form-row">
        <label>Template</label>
        <select id="wTemplate" class="form-input"></select>
      </div>
      <div class="form-row">
        <label>Custom prompt override <span class="text-muted">(optional)</span></label>
        <textarea id="wPrompt" class="form-input" rows="4" maxlength="2000"
          placeholder="Leave blank to use the standard template for this category"></textarea>
        <div id="wPromptCount" class="form-hint text-muted">0 / 2000</div>
      </div>
      <div class="form-row">
        <label>Source handling</label>
        <div class="radio-group">
          <label><input type="radio" name="wCombineMode" value="one-per-item" checked> One article per source item</label>
          <label><input type="radio" name="wCombineMode" value="combine"> Summarise all into one article</label>
        </div>
      </div>
    </div>

    <div id="wPanel4" class="wizard-panel" style="display:none">
      <h3>Step 4: Review</h3>
      <div class="form-row">
        <label>Does this content require human review?</label>
        <div class="radio-group">
          <label><input type="radio" name="wReviewRequired" value="yes" checked onchange="updateReviewUI()"> Yes — hold in Automation Inbox</label>
          <label><input type="radio" name="wReviewRequired" value="no"  onchange="updateReviewUI()"> No — publish automatically</label>
        </div>
      </div>
      <div id="wReviewOptions">
        <div class="form-row">
          <label>Auto-approve after <input id="wTimeoutHours" type="number" class="form-input-inline" value="48" min="1"> hours if no response</label>
        </div>
        <div class="form-row">
          <label>On timeout:</label>
          <select id="wOnTimeout" class="form-input">
            <option value="approve">Approve automatically</option>
            <option value="reject">Reject</option>
            <option value="skip">Skip (hold indefinitely)</option>
          </select>
        </div>
      </div>
    </div>

    <div id="wPanel5" class="wizard-panel" style="display:none">
      <h3>Step 5: Notifications</h3>
      <div class="wizard-notif-section">
        <label class="checkbox-label"><input type="checkbox" id="wTgEnabled" onchange="updateNotifUI()"> Enable Telegram</label>
        <div id="wTgOptions" style="display:none">
          <div class="form-row"><label>Chat ID</label><input id="wTgChatId" type="text" class="form-input" placeholder="-1001234567890"></div>
          <label class="checkbox-label"><input type="checkbox" id="wTgAllowApproval" checked> Allow approval via Telegram inline buttons</label>
          <button class="btn-secondary" onclick="testTelegramNotif()">Send test message</button>
        </div>
      </div>
      <div class="wizard-notif-section">
        <label class="checkbox-label"><input type="checkbox" id="wEmailEnabled" onchange="updateNotifUI()"> Enable Email</label>
        <div id="wEmailOptions" style="display:none">
          <div id="wEmailRecipients" class="email-recipients"></div>
          <div class="form-row">
            <input id="wEmailNew" type="email" class="form-input" placeholder="editor@ibdhealthhub.com">
            <button class="btn-secondary" onclick="addEmailRecipient()">+ Add</button>
          </div>
          <label class="checkbox-label"><input type="checkbox" id="wEmailAllowApproval" checked> Allow approval via email link</label>
        </div>
      </div>

      <!-- Summary card -->
      <div id="wSummaryCard" class="wizard-summary" style="display:none"></div>
    </div>

    <!-- Wizard navigation -->
    <div class="wizard-footer">
      <button class="btn-secondary" id="wBtnBack" onclick="wizardBack()" style="display:none">← Back</button>
      <button class="btn-primary"   id="wBtnNext" onclick="wizardNext()">Next →</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add wizard CSS**

```css
.modal-panel-wide { max-width: 700px; width: 95vw; }
.wizard-steps { display: flex; gap: 4px; margin-bottom: 24px; }
.wizard-step {
  flex: 1; text-align: center; padding: 6px 4px; border-radius: 6px;
  font-size: 0.72rem; font-weight: 600; background: var(--bg);
  border: 1px solid var(--border); color: var(--text-muted);
}
.wizard-step.active { background: var(--sla-orange); color: #fff; border-color: var(--sla-orange); }
.wizard-step.done   { background: var(--sla-navy);   color: #fff; border-color: var(--sla-navy); }
.wizard-panel { padding: 4px 0; }
.wizard-footer { display: flex; justify-content: space-between; margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border); }
.sources-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.source-row { display: flex; gap: 8px; align-items: center; }
.source-row .form-input { flex: 1; }
.source-add-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
.btn-add-source { padding: 5px 12px; border-radius: 6px; border: 1px dashed var(--border); background: transparent; color: var(--text-muted); font-size: 0.78rem; cursor: pointer; }
.btn-add-source:hover { border-color: var(--sla-orange); color: var(--sla-orange); }
.btn-add-source-dim { opacity: 0.4; cursor: not-allowed !important; }
.wizard-notif-section { padding: 16px 0; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
.wizard-summary { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-top: 20px; font-size: 0.85rem; line-height: 1.8; }
.wizard-summary strong { color: var(--text); }
.email-recipients { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.email-chip { background: var(--sla-navy); color: #fff; border-radius: 12px; padding: 3px 10px; font-size: 0.75rem; display: flex; align-items: center; gap: 6px; }
.email-chip button { background: none; border: none; color: #fff; cursor: pointer; padding: 0; font-size: 0.9rem; line-height: 1; }
```

- [ ] **Step 3: Implement wizard JS**

```js
let _wizardStep = 1;
let _wizardEditId = null;
let _wSources = [];
let _wEmailRecipients = [];

function openRuleWizard(editId = null) {
  _wizardStep = 1;
  _wizardEditId = editId;
  _wSources = [];
  _wEmailRecipients = [];

  document.getElementById('ruleWizardTitle').textContent = editId ? 'Edit Rule' : 'New Automation Rule';
  document.getElementById('wRuleName').value = '';
  document.getElementById('wSourcesList').innerHTML = '';
  renderWizardStep(1);

  // Populate category dropdown
  const catSel = document.getElementById('wRuleCategory');
  catSel.innerHTML = CATEGORIES.map(c => `<option value="${c.id}">${c.label}</option>`).join('');

  // Populate template dropdown
  const tplSel = document.getElementById('wTemplate');
  tplSel.innerHTML = CATEGORIES.map(c => `<option value="${c.id}">${c.label}</option>`).join('');

  if (editId) prefillWizardFromRule(editId);

  document.getElementById('ruleWizardModal').style.display = 'flex';
}

function closeRuleWizard() {
  document.getElementById('ruleWizardModal').style.display = 'none';
}

function renderWizardStep(step) {
  _wizardStep = step;
  for (let i = 1; i <= 5; i++) {
    document.getElementById(`wPanel${i}`).style.display = i === step ? '' : 'none';
    const stepEl = document.getElementById(`wStep${i}`);
    stepEl.classList.toggle('active', i === step);
    stepEl.classList.toggle('done', i < step);
  }
  document.getElementById('wBtnBack').style.display = step > 1 ? '' : 'none';
  document.getElementById('wBtnNext').textContent = step === 5 ? 'Create Rule' : 'Next →';
  if (step === 5) buildWizardSummary();
}

function wizardBack() { if (_wizardStep > 1) renderWizardStep(_wizardStep - 1); }

function wizardNext() {
  if (!validateWizardStep(_wizardStep)) return;
  if (_wizardStep < 5) {
    renderWizardStep(_wizardStep + 1);
  } else {
    submitRule();
  }
}

function validateWizardStep(step) {
  if (step === 1) {
    if (!document.getElementById('wRuleName').value.trim()) {
      alert('Please enter a rule name.'); return false;
    }
    if (_wSources.length === 0) {
      alert('Please add at least one source.'); return false;
    }
  }
  return true;
}

function addSource(type) {
  const id = `src_${Date.now()}`;
  _wSources.push({ id, type, url: '', repo: '', path: '', branch: 'main' });
  renderSourcesList();
}

function removeSource(id) {
  _wSources = _wSources.filter(s => s.id !== id);
  renderSourcesList();
}

function renderSourcesList() {
  const list = document.getElementById('wSourcesList');
  list.innerHTML = _wSources.map(s => {
    if (s.type === 'github') {
      return `<div class="source-row">
        <span style="min-width:56px;font-size:0.75rem;color:var(--text-muted)">GitHub</span>
        <input class="form-input" placeholder="owner/repo" oninput="_wSources.find(x=>x.id==='${s.id}').repo=this.value" value="${escHtml(s.repo)}">
        <input class="form-input" placeholder="path (optional)" oninput="_wSources.find(x=>x.id==='${s.id}').path=this.value" value="${escHtml(s.path)}">
        <button class="btn-icon btn-icon-danger" onclick="removeSource('${s.id}')">✕</button>
      </div>`;
    }
    const label = s.type === 'rss' ? 'RSS' : 'URL';
    const ph = s.type === 'rss' ? 'https://feeds.bmj.com/bmj/recent' : 'https://www.nice.org.uk/news';
    return `<div class="source-row">
      <span style="min-width:56px;font-size:0.75rem;color:var(--text-muted)">${label}</span>
      <input class="form-input" type="url" placeholder="${ph}" oninput="_wSources.find(x=>x.id==='${s.id}').url=this.value" value="${escHtml(s.url)}">
      <button class="btn-icon btn-icon-danger" onclick="removeSource('${s.id}')">✕</button>
    </div>`;
  }).join('');
}

function updateTriggerUI() {
  const type = document.querySelector('input[name="wTriggerType"]:checked').value;
  document.getElementById('wTriggerSchedule').style.display = type === 'schedule' ? '' : 'none';
  document.getElementById('wTriggerEvent').style.display    = type === 'event'    ? '' : 'none';
}

function updateCronFromPreset() {
  const val = document.getElementById('wCronPreset').value;
  document.getElementById('wCustomCronRow').style.display = val === 'custom' ? '' : 'none';
}

function updateReviewUI() {
  const req = document.querySelector('input[name="wReviewRequired"]:checked').value === 'yes';
  document.getElementById('wReviewOptions').style.display = req ? '' : 'none';
}

function updateNotifUI() {
  document.getElementById('wTgOptions').style.display    = document.getElementById('wTgEnabled').checked    ? '' : 'none';
  document.getElementById('wEmailOptions').style.display = document.getElementById('wEmailEnabled').checked ? '' : 'none';
}

function addEmailRecipient() {
  const input = document.getElementById('wEmailNew');
  const email = input.value.trim();
  if (!email || !email.includes('@')) return;
  if (_wEmailRecipients.includes(email)) { input.value = ''; return; }
  _wEmailRecipients.push(email);
  input.value = '';
  renderEmailChips();
}

function removeEmailRecipient(email) {
  _wEmailRecipients = _wEmailRecipients.filter(e => e !== email);
  renderEmailChips();
}

function renderEmailChips() {
  document.getElementById('wEmailRecipients').innerHTML = _wEmailRecipients.map(e =>
    `<div class="email-chip">${escHtml(e)} <button onclick="removeEmailRecipient('${escHtml(e)}')">×</button></div>`
  ).join('');
}

function buildWizardSummary() {
  const triggerType = document.querySelector('input[name="wTriggerType"]:checked').value;
  const cronPreset  = document.getElementById('wCronPreset').value;
  const cronExpr    = cronPreset === 'custom' ? document.getElementById('wCronExpr').value : cronPreset;
  const reviewReq   = document.querySelector('input[name="wReviewRequired"]:checked').value === 'yes';
  const notifParts  = [];
  if (document.getElementById('wTgEnabled').checked)    notifParts.push('Telegram');
  if (document.getElementById('wEmailEnabled').checked) notifParts.push('Email');

  document.getElementById('wSummaryCard').style.display = '';
  document.getElementById('wSummaryCard').innerHTML = `
    <strong>Summary</strong><br>
    Name: ${escHtml(document.getElementById('wRuleName').value)}<br>
    Category: ${escHtml(document.getElementById('wRuleCategory').value)}<br>
    Sources: ${_wSources.length}<br>
    Trigger: ${triggerType === 'schedule' ? cronExpr : triggerType}<br>
    Review: ${reviewReq ? `Required · Auto-${document.getElementById('wOnTimeout').value} after ${document.getElementById('wTimeoutHours').value}h` : 'Auto-publish'}<br>
    Notifications: ${notifParts.length ? notifParts.join(' + ') : 'None'}
  `;
}

async function submitRule() {
  const triggerType = document.querySelector('input[name="wTriggerType"]:checked').value;
  const cronPreset  = document.getElementById('wCronPreset').value;
  const cronExpr    = cronPreset === 'custom' ? document.getElementById('wCronExpr').value : cronPreset;
  const reviewReq   = document.querySelector('input[name="wReviewRequired"]:checked').value === 'yes';

  const payload = {
    name:     document.getElementById('wRuleName').value.trim(),
    category: document.getElementById('wRuleCategory').value,
    sources:  _wSources.map(({ id: _id, ...s }) => s),
    trigger: {
      type:            triggerType,
      cron:            triggerType === 'schedule' ? cronExpr : null,
      minGapHours:     triggerType === 'event' ? parseInt(document.getElementById('wMinGapHours').value) : null,
    },
    generation: {
      template:          document.getElementById('wTemplate').value,
      maxArticlesPerRun: parseInt(document.getElementById('wMaxArticles').value),
      prompt:            document.getElementById('wPrompt').value.trim(),
      combineMode:       document.querySelector('input[name="wCombineMode"]:checked').value,
    },
    review: {
      required:     reviewReq,
      timeoutHours: reviewReq ? parseInt(document.getElementById('wTimeoutHours').value) : 48,
      onTimeout:    reviewReq ? document.getElementById('wOnTimeout').value : 'approve',
    },
    notifications: {
      telegram: {
        enabled:       document.getElementById('wTgEnabled').checked,
        chatId:        document.getElementById('wTgChatId').value.trim(),
        allowApproval: document.getElementById('wTgAllowApproval').checked,
      },
      email: {
        enabled:       document.getElementById('wEmailEnabled').checked,
        to:            [..._wEmailRecipients],
        allowApproval: document.getElementById('wEmailAllowApproval').checked,
      },
    },
  };

  try {
    if (_wizardEditId) {
      await apiFetch(`/api/automation/rules/${_wizardEditId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      showToast('Rule updated');
    } else {
      await apiFetch('/api/automation/rules', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Rule created');
    }
    closeRuleWizard();
    loadAutoRules();
  } catch (err) {
    alert(`Failed to save rule: ${err.message}`);
  }
}

async function testTelegramNotif() {
  const chatId = document.getElementById('wTgChatId').value.trim();
  if (!chatId) { alert('Enter a Chat ID first.'); return; }
  try {
    await apiFetch('/api/automation/telegram-test', {
      method: 'POST',
      body: JSON.stringify({ chatId }),
    });
    showToast('Test message sent');
  } catch (err) {
    alert(`Failed: ${err.message}`);
  }
}
```

- [ ] **Step 4: Add Telegram test endpoint**

Create `api/automation/telegram-test.js`:

```js
// api/automation/telegram-test.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: '✅ IBD Health Hub Automation is connected! Your Telegram notifications are working.',
    }),
  });
  if (!r.ok) return res.status(502).json({ error: 'Telegram API error' });
  return res.status(200).json({ ok: true });
}
```

- [ ] **Step 5: Full end-to-end wizard smoke test**

1. Open Automation tab → click "+ New Rule"
2. Step 1: Enter name, pick category, add an RSS source
3. Step 2: Select "Weekly" schedule
4. Step 3: Pick template
5. Step 4: Enable review, set 48h timeout
6. Step 5: Enable email, add recipient, confirm summary shows correctly
7. Click "Create Rule" → rule card appears in Rules list

- [ ] **Step 6: Commit**

```bash
git add index.html api/automation/telegram-test.js
git commit -m "feat(automation): add 5-step rule creation wizard with full form state"
```

---

## Chunk 6: Environment Variables & Deployment

### Task 15: Register Telegram webhook and update env vars

**Files:**
- Reference: `vercel.json` (already updated in Task 10)
- No code changes — configuration steps

- [ ] **Step 1: Add env vars in Vercel dashboard**

Go to Vercel → Project → Settings → Environment Variables. Add:

| Variable | Value |
|----------|-------|
| `TELEGRAM_BOT_TOKEN` | From BotFather (`bot<token>`) |
| `TELEGRAM_WEBHOOK_SECRET` | Random 32-char string (e.g. `openssl rand -hex 16`) |

These join the existing: `GITHUB_TOKEN`, `JWT_SECRET`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `NEXT_PUBLIC_APP_URL`, `KV_*`.

- [ ] **Step 2: Register Telegram webhook**

After deploying, run once (in browser or curl):

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://your-app.vercel.app/api/automation/telegram" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Expected response: `{"ok":true,"result":true,"description":"Webhook was set"}`

- [ ] **Step 3: Verify webhook is set**

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

Expected: `"url": "https://your-app.vercel.app/api/automation/telegram"`, `"pending_update_count": 0`

- [ ] **Step 4: Commit env var documentation**

```bash
git add .env.example  # if it exists, add the new vars
git commit -m "docs(automation): document new env vars for Telegram integration"
```

---

### Task 16: Full integration test

- [ ] **Step 1: Run all automation tests**

```bash
npx jest api/automation/ --no-coverage
```

Expected: All tests PASS. Note exact count for verification.

- [ ] **Step 2: Deploy to Vercel**

```bash
git push origin main
```

Monitor Vercel build — confirm successful deployment.

- [ ] **Step 3: Manual end-to-end test**

1. Create a rule with an RSS source (BMJ or similar) via the wizard
2. Manually trigger the cron: `POST https://your-app.vercel.app/api/automation/run`
3. If review required: check Automation Inbox — job should appear with pending status
4. Click Approve — confirm article moves to pipeline as published
5. If Telegram configured: check bot sent message with approve/reject buttons
6. If Email configured: check inbox for approval email with working links

- [ ] **Step 4: Verify inbox badge updates**

After creating a pending job, navigate away and return to Automation tab — orange badge on nav item should show pending count.

---

## Environment Variables Summary

New vars required (add to Vercel project settings):

```
TELEGRAM_BOT_TOKEN=bot<your-token-from-botfather>
TELEGRAM_WEBHOOK_SECRET=<random-32-char-string>
```

Existing vars used (no changes needed):
```
JWT_SECRET
RESEND_API_KEY
RESEND_FROM_EMAIL
NEXT_PUBLIC_APP_URL
GITHUB_TOKEN
KV_REST_API_URL
KV_REST_API_TOKEN
```

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `api/automation/rule-schema.js` | Create | Rule builder + validator (pure functions) |
| `api/automation/job-schema.js` | Create | Job builder (pure function) |
| `api/automation/rules/index.js` | Create | GET list / POST create rules |
| `api/automation/rules/[id].js` | Create | GET / PATCH / DELETE rule |
| `api/automation/jobs/index.js` | Create | GET list jobs (with status filter) |
| `api/automation/jobs/[id].js` | Create | GET single job |
| `api/automation/approve.js` | Create | Unified approval handler (email JWT + manual) |
| `api/automation/telegram.js` | Create | Telegram webhook (callback_query handler) |
| `api/automation/telegram-test.js` | Create | Send test Telegram message |
| `api/automation/fetch.js` | Create | Source fetcher (RSS, URL, GitHub) |
| `api/automation/notify.js` | Create | Notification sender (Telegram + Email) |
| `api/automation/run.js` | Create | Cron evaluator + orchestrator |
| `vercel.json` | Modify | Add `*/15 * * * *` cron for automation/run |
| `index.html` | Modify | Automation tab, rules list, inbox, wizard |

---

## Deferred (Future Plan)

- **Google Drive source** — OAuth2 redirect flow, refresh token storage, Drive API files.list
- **Dropbox source** — OAuth2 redirect flow, refresh token storage, /list_folder API
- **Volume-based trigger** — requires source item cache to count unprocessed items
- **Multi-reviewer approval** (`review.mode: 'all'`) — requires tracking per-reviewer responses
- **Approval activity log** — timeline of who approved/rejected and when

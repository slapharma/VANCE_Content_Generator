import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../lib/automation/handlers/run.js';
import { kv } from '../../lib/kv.js';

// The handler's migrations and processTimeouts() are not exported, so these
// tests drive them through the default export. The boundary is kv: the methods
// on the shared kv object are swapped for an in-memory fake for the duration of
// each test and restored afterwards. fetchFn is injected per test.

const PENDING = 'automation:jobs:pending';
const BACKFILL_FLAG = 'migration:backfill-pending-jobs:v1';
const JOBS_INDEX = 'automation:jobs:index';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

const REAL_KV = { ...kv };

let state;

function resetState() {
  state = {
    values: new Map(),
    lists: new Map(),
    sets: new Map(),
    writes: [],
    failures: new Map(),
  };
}

function failOn(op, key, message) {
  state.failures.set(`${op} ${key}`, new Error(message));
}

function maybeFail(op, key) {
  const err = state.failures.get(`${op} ${key}`);
  if (err) throw err;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const fakeKv = {
  async get(key) {
    maybeFail('get', key);
    return state.values.has(key) ? clone(state.values.get(key)) : null;
  },
  async set(key, value, opts) {
    maybeFail('set', key);
    if (opts?.nx && state.values.has(key)) return null;
    state.values.set(key, clone(value));
    state.writes.push(['set', key]);
    return 'OK';
  },
  async del(key) {
    maybeFail('del', key);
    state.values.delete(key);
    state.lists.delete(key);
    state.sets.delete(key);
    state.writes.push(['del', key]);
    return 1;
  },
  async lrange(key) {
    maybeFail('lrange', key);
    return [...(state.lists.get(key) ?? [])];
  },
  async lpush(key, ...values) {
    maybeFail('lpush', key);
    const list = state.lists.get(key) ?? [];
    list.unshift(...values);
    state.lists.set(key, list);
    state.writes.push(['lpush', key, ...values]);
    return list.length;
  },
  async ltrim(key, start, stop) {
    maybeFail('ltrim', key);
    const list = state.lists.get(key) ?? [];
    state.lists.set(key, list.slice(start, stop + 1));
    return 'OK';
  },
  async sadd(key, ...members) {
    maybeFail('sadd', key);
    const set = state.sets.get(key) ?? new Set();
    for (const m of members) set.add(m);
    state.sets.set(key, set);
    state.writes.push(['sadd', key, ...members]);
    return members.length;
  },
  async srem(key, ...members) {
    maybeFail('srem', key);
    const set = state.sets.get(key) ?? new Set();
    for (const m of members) set.delete(m);
    state.sets.set(key, set);
    state.writes.push(['srem', key, ...members]);
    return members.length;
  },
  async smembers(key) {
    maybeFail('smembers', key);
    return [...(state.sets.get(key) ?? [])];
  },
};

function fakeRes() {
  const res = { statusCode: null, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

// Any fetch the test did not expect throws, so an unexpected call fails loudly.
function noFetch() {
  return async (url) => { throw new Error(`unexpected fetch: ${url}`); };
}

beforeEach(() => {
  resetState();
  Object.assign(kv, fakeKv);
});

afterEach(() => {
  Object.assign(kv, REAL_KV);
});

// ── 1. migrateBackfillPendingJobsOnce (reached via the GET handler) ─────────

describe('pending-jobs backfill migration', () => {
  it('skips the index scan when the backfill flag is already set', async () => {
    // Arrange
    state.values.set(BACKFILL_FLAG, { at: '2026-01-01T00:00:00.000Z', added: 0, scanned: 0 });
    state.lists.set(JOBS_INDEX, ['job_1']);
    state.values.set('automation:job:job_1', { id: 'job_1', ruleId: 'rule_1', status: 'pending_review', createdAt: new Date().toISOString() });
    const res = fakeRes();

    // Act
    await handler({ method: 'GET' }, res, { fetchFn: noFetch() });

    // Assert
    assert.equal(res.statusCode, 200);
    assert.equal(state.sets.has(PENDING), false);
  });

  it('adds only pending_review jobs from the index to the pending set', async () => {
    // Arrange
    state.lists.set(JOBS_INDEX, ['job_1', 'job_2', 'job_3', 'job_4']);
    state.values.set('automation:job:job_1', { id: 'job_1', ruleId: 'rule_1', status: 'pending_review' });
    state.values.set('automation:job:job_2', { id: 'job_2', ruleId: 'rule_1', status: 'approved' });
    state.values.set('automation:job:job_3', { id: 'job_3', ruleId: 'rule_1', status: 'pending_review' });
    // job_4 is in the index but its record is gone
    const res = fakeRes();

    // Act
    // A forced run (POST with a ruleId) skips processTimeouts(), so the set is
    // exactly what the migration wrote. A GET would let the sweep remove a
    // wrongly added job and hide the bug. The 404 is expected: the rule is not seeded.
    await handler({ method: 'POST', body: { ruleId: 'not-seeded' } }, res, { fetchFn: noFetch() });

    // Assert
    assert.deepEqual([...state.sets.get(PENDING)].sort(), ['job_1', 'job_3']);
  });

  it('records how many jobs were added and scanned in the flag', async () => {
    // Arrange
    state.lists.set(JOBS_INDEX, ['job_1', 'job_2', 'job_3', 'job_4']);
    state.values.set('automation:job:job_1', { id: 'job_1', ruleId: 'rule_1', status: 'pending_review' });
    state.values.set('automation:job:job_2', { id: 'job_2', ruleId: 'rule_1', status: 'approved' });
    state.values.set('automation:job:job_3', { id: 'job_3', ruleId: 'rule_1', status: 'pending_review' });
    const res = fakeRes();

    // Act
    await handler({ method: 'GET' }, res, { fetchFn: noFetch() });

    // Assert
    const flag = state.values.get(BACKFILL_FLAG);
    assert.equal(flag.added, 2);
    assert.equal(flag.scanned, 4);
  });

  it('reports no backfill error when the scan succeeds', async () => {
    // Arrange
    state.lists.set(JOBS_INDEX, ['job_1']);
    state.values.set('automation:job:job_1', { id: 'job_1', ruleId: 'rule_1', status: 'pending_review' });
    const res = fakeRes();

    // Act
    await handler({ method: 'GET' }, res, { fetchFn: noFetch() });

    // Assert
    assert.deepEqual(res.body.errors, []);
  });

  it('reports a read failure in the response and does not set the flag', async (t) => {
    // Arrange
    t.mock.method(console, 'error', () => {});
    failOn('lrange', JOBS_INDEX, 'upstash unreachable');
    const res = fakeRes();

    // Act
    await handler({ method: 'GET' }, res, { fetchFn: noFetch() });

    // Assert
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.errors, [
      'Pending-jobs backfill failed (will retry next run): upstash unreachable',
    ]);
    assert.equal(state.values.has(BACKFILL_FLAG), false);
  });

  it('reports a write failure and does not set the flag when the pending-set write fails', async (t) => {
    // Arrange
    t.mock.method(console, 'error', () => {});
    state.lists.set(JOBS_INDEX, ['job_1']);
    state.values.set('automation:job:job_1', { id: 'job_1', ruleId: 'rule_1', status: 'pending_review' });
    failOn('sadd', PENDING, 'write timeout');
    const res = fakeRes();

    // Act
    await handler({ method: 'GET' }, res, { fetchFn: noFetch() });

    // Assert
    assert.deepEqual(res.body.errors, [
      'Pending-jobs backfill failed (will retry next run): write timeout',
    ]);
    assert.equal(state.values.has(BACKFILL_FLAG), false);
  });
});

// ── 2. processTimeouts (reached via the GET handler, before rules load) ─────

describe('processTimeouts pending-set sweep', () => {
  // Flag preset so the backfill does not touch the set under test.
  beforeEach(() => {
    state.values.set(BACKFILL_FLAG, { at: '2026-01-01T00:00:00.000Z', added: 0, scanned: 0 });
  });

  it('removes a pending-set id whose job record is missing', async () => {
    // Arrange
    state.sets.set(PENDING, new Set(['job_gone']));
    const res = fakeRes();

    // Act
    await handler({ method: 'GET' }, res, { fetchFn: noFetch() });

    // Assert
    assert.deepEqual([...state.sets.get(PENDING)], []);
  });

  it('removes a pending-set id whose job is no longer pending_review', async () => {
    // Arrange
    state.sets.set(PENDING, new Set(['job_done']));
    state.values.set('automation:job:job_done', { id: 'job_done', ruleId: 'rule_1', status: 'approved' });
    const res = fakeRes();

    // Act
    await handler({ method: 'GET' }, res, { fetchFn: noFetch() });

    // Assert
    assert.deepEqual([...state.sets.get(PENDING)], []);
  });

  it('keeps a pending-set id whose job is still pending_review and within its timeout', async () => {
    // Arrange
    state.sets.set(PENDING, new Set(['job_live']));
    state.values.set('automation:job:job_live', {
      id: 'job_live', ruleId: 'rule_1', status: 'pending_review', createdAt: new Date().toISOString(),
    });
    state.values.set('automation:rule:rule_1', {
      id: 'rule_1', name: 'Live rule', review: { required: true, timeoutHours: 48, onTimeout: 'approve' },
    });
    const calls = [];
    const fetchFn = async (url) => { calls.push(url); return { ok: true, status: 200 }; };
    const res = fakeRes();

    // Act
    await handler({ method: 'GET' }, res, { fetchFn });

    // Assert
    assert.deepEqual([...state.sets.get(PENDING)], ['job_live']);
    assert.deepEqual(calls, []);
  });
});

// ── 3. Job creation in the rule-run path ───────────────────────────────────

describe('rule run creates pending jobs', () => {
  const SOURCE_URL = 'https://news.example.com/story';
  const ARTICLE_TITLE = 'Biologic improves remission';

  function ruleFixture({ reviewRequired }) {
    return {
      id: 'rule_1',
      name: 'Test rule',
      category: 'ibd-living',
      enabled: true,
      trigger: { type: 'schedule', cron: '0 0 * * *' },
      lastRunAt: null,
      sources: [{ type: 'url', url: SOURCE_URL }],
      generation: { maxArticlesPerRun: 1, heroImage: false, template: 'standard' },
      notifications: {},
      review: { required: reviewRequired, mode: 'any', timeoutHours: 48, onTimeout: 'approve' },
      stats: {},
    };
  }

  // Routes each outbound call the run makes; anything else throws.
  function runFetch() {
    return async (url) => {
      if (url === SOURCE_URL) {
        return { ok: true, status: 200, text: async () => '<html><body><p>Patients improved on the new biologic.</p></body></html>' };
      }
      if (url === 'https://openrouter.ai/api/v1/chat/completions') {
        return { ok: true, status: 200, json: async () => ({
          choices: [{ message: { content: `# ${ARTICLE_TITLE}\n\nPatients improved on the new biologic in the trial.` } }],
        }) };
      }
      if (url === `${APP_URL}/api/content`) {
        return { ok: true, status: 200, json: async () => ({ id: 'content_1', title: ARTICLE_TITLE, status: 'draft' }) };
      }
      if (url === `${APP_URL}/api/publish`) {
        return { ok: true, status: 200, json: async () => ({ wpPostUrl: 'https://example.com/?p=1' }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
  }

  let savedApiKey;
  beforeEach(() => {
    savedApiKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-key';
    // Flag preset so the backfill does not add to the set under test.
    state.values.set(BACKFILL_FLAG, { at: '2026-01-01T00:00:00.000Z', added: 0, scanned: 0 });
  });

  afterEach(() => {
    if (savedApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedApiKey;
  });

  it('adds the new job to the pending set when review is required', async () => {
    // Arrange
    state.values.set('automation:rule:rule_1', ruleFixture({ reviewRequired: true }));
    const res = fakeRes();

    // Act
    await handler({ method: 'POST', body: { ruleId: 'rule_1' } }, res, { fetchFn: runFetch() });

    // Assert
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.errors, []);
    assert.equal(res.body.processed, 1);
    assert.equal(state.sets.get(PENDING).size, 1);
    const [jobId] = [...state.sets.get(PENDING)];
    const job = state.values.get(`automation:job:${jobId}`);
    assert.equal(job.status, 'pending_review');
    assert.equal(job.ruleId, 'rule_1');
    assert.equal(job.contentId, 'content_1');
  });

  it('adds the job id to the pending set before the job record is written', async () => {
    // Arrange
    state.values.set('automation:rule:rule_1', ruleFixture({ reviewRequired: true }));
    const res = fakeRes();

    // Act
    await handler({ method: 'POST', body: { ruleId: 'rule_1' } }, res, { fetchFn: runFetch() });

    // Assert
    const jobWrites = state.writes.filter(w =>
      (w[0] === 'sadd' && w[1] === PENDING) || (w[0] === 'set' && w[1].startsWith('automation:job:')));
    const [first, second] = jobWrites;
    assert.equal(first[0], 'sadd');
    assert.equal(second[0], 'set');
    assert.equal(second[1], `automation:job:${first[2]}`);
  });

  it('does not add an auto-published job to the pending set', async () => {
    // Arrange
    state.values.set('automation:rule:rule_1', ruleFixture({ reviewRequired: false }));
    const res = fakeRes();

    // Act
    await handler({ method: 'POST', body: { ruleId: 'rule_1' } }, res, { fetchFn: runFetch() });

    // Assert
    assert.equal(res.body.processed, 1);
    assert.equal(state.sets.has(PENDING), false);
    const [jobId] = state.lists.get(JOBS_INDEX);
    assert.equal(state.values.get(`automation:job:${jobId}`).status, 'auto_published');
  });
});

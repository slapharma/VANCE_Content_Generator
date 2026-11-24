import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../lib/automation/handlers/run.js';
import { kv } from '../../lib/kv.js';

// The run handler takes a per-rule concurrency lock with
// kv.set(lockKey, now, { nx: true, ex: 310 }). When the lock is held, the rule is
// skipped and the response must say so, so the UI does not report "no new items".
// These tests drive the forced (manual) run through the default export. The boundary
// is kv: its methods are swapped for an in-memory fake for each test and restored
// afterwards, the same way run-pending-jobs.test.js does it. Source fetches and LLM
// calls are recorded, so a call that should not happen shows up as a count.

const RULE_ID = 'rule_1';
const RULE_NAME = 'Test rule';
const RULE_KEY = `automation:rule:${RULE_ID}`;
const LOCK_KEY = `automation:rule:${RULE_ID}:run-lock`;
const CLEAR_PROMPTS_FLAG = 'migration:clear-rule-prompts:v1';
const BACKFILL_FLAG = 'migration:backfill-pending-jobs:v1';

const REAL_KV = { ...kv };

let state;

function resetState() {
  state = {
    values: new Map(),
    lists: new Map(),
    writes: [],
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const fakeKv = {
  async get(key) {
    return state.values.has(key) ? clone(state.values.get(key)) : null;
  },
  // Redis SET NX: refuses when the key already exists, and returns null in that case.
  async set(key, value, opts) {
    if (opts?.nx && state.values.has(key)) return null;
    state.values.set(key, clone(value));
    state.writes.push(['set', key]);
    return 'OK';
  },
  async del(key) {
    state.values.delete(key);
    state.writes.push(['del', key]);
    return 1;
  },
  async lrange(key) {
    return [...(state.lists.get(key) ?? [])];
  },
  async lpush(key, ...values) {
    const list = state.lists.get(key) ?? [];
    list.unshift(...values);
    state.lists.set(key, list);
    return list.length;
  },
  async ltrim(key, start, stop) {
    const list = state.lists.get(key) ?? [];
    state.lists.set(key, list.slice(start, stop + 1));
    return 'OK';
  },
};

function ruleFixture() {
  // No sources, so a run that gets the lock finishes without any network call.
  return {
    id: RULE_ID,
    name: RULE_NAME,
    enabled: true,
    sources: [],
    generation: { maxArticlesPerRun: 1 },
    stats: {},
  };
}

function fakeRes() {
  const res = { statusCode: null, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

beforeEach(() => {
  resetState();
  Object.assign(kv, fakeKv);
  // Both one-shot migrations are marked done, so they write nothing during these runs.
  state.values.set(CLEAR_PROMPTS_FLAG, { at: '2026-01-01T00:00:00.000Z', cleared: 0 });
  state.values.set(BACKFILL_FLAG, { at: '2026-01-01T00:00:00.000Z', added: 0, scanned: 0 });
});

afterEach(() => {
  Object.assign(kv, REAL_KV);
});

describe('forced run when the per-rule run lock is already held', () => {
  it('reports the rule in skipped with reason run-lock and no errors', async () => {
    // Arrange
    state.values.set(RULE_KEY, ruleFixture());
    state.values.set(LOCK_KEY, '2026-01-01T00:00:00.000Z'); // another run holds the lock
    const res = fakeRes();

    // Act
    await handler({ method: 'POST', body: { ruleId: RULE_ID } }, res, { fetchFn: async () => { throw new Error('unexpected source fetch'); } });

    // Assert
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      processed: 0,
      errors: [],
      skipped: [{ ruleId: RULE_ID, ruleName: RULE_NAME, reason: 'run-lock' }],
    });
  });

  it('does not fetch sources, call the LLM, or rewrite the rule', async (t) => {
    // Arrange
    state.values.set(RULE_KEY, ruleFixture());
    state.values.set(LOCK_KEY, '2026-01-01T00:00:00.000Z');
    const sourceFetchUrls = [];
    const fetchFn = async (url) => { sourceFetchUrls.push(url); throw new Error(`unexpected source fetch: ${url}`); };
    const globalFetchUrls = [];
    t.mock.method(globalThis, 'fetch', async (url) => { globalFetchUrls.push(String(url)); throw new Error(`unexpected fetch: ${url}`); });
    const res = fakeRes();

    // Act
    await handler({ method: 'POST', body: { ruleId: RULE_ID } }, res, { fetchFn });

    // Assert
    assert.deepEqual(sourceFetchUrls, []);
    assert.deepEqual(globalFetchUrls, []);
    assert.deepEqual(state.values.get(RULE_KEY), ruleFixture());
  });
});

describe('forced run when the per-rule run lock is free', () => {
  it('leaves skipped empty when the run acquires the lock', async () => {
    // Arrange
    state.values.set(RULE_KEY, ruleFixture());
    const res = fakeRes();

    // Act
    await handler({ method: 'POST', body: { ruleId: RULE_ID } }, res, { fetchFn: async () => { throw new Error('unexpected source fetch'); } });

    // Assert
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.skipped, []);
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyStatusTransition, handler } from './[id].js';

test('draft -> in_review is valid', () => {
  assert.equal(applyStatusTransition('draft', 'in_review'), 'in_review');
});

test('draft -> published is invalid', () => {
  assert.throws(() => applyStatusTransition('draft', 'published'), /invalid/i);
});

test('approved -> scheduled is valid', () => {
  assert.equal(applyStatusTransition('approved', 'scheduled'), 'scheduled');
});

// ── Auth guards on the write methods ─────────────────────────────────────────
//
// Until 2026-08-18 PUT and DELETE on this route had no auth at all: getCurrentUser
// was called only to label the audit entry, falling back to 'Content team' when
// there was no session. An anonymous caller could retitle, rewrite or trash any
// article, including a published one.
//
// These assert the SIDE EFFECT never happens, not just the status code — a 401
// that still wrote to KV would pass a status-only check. The last two cases are
// controls: they fail if the guards are too broad, which is the other way to get
// this wrong.

function mockRes() {
  const out = { code: null, body: null, ended: false };
  const res = {
    status(c) { out.code = c; return res; },
    json(b)   { out.body = b; return res; },
    end()     { out.ended = true; return res; },
  };
  return { res, out };
}

// Records every write so a test can assert none happened.
function mockStore(item) {
  const writes = [];
  return {
    writes,
    get: async () => item,
    set: async (...a) => { writes.push(['set', ...a]); },
    del: async (...a) => { writes.push(['del', ...a]); },
    lrange: async () => [],
    rpush: async (...a) => { writes.push(['rpush', ...a]); },
  };
}

const ITEM = { id: 'c1', status: 'published', title: 'Live article', body: 'x' };
const anon  = async () => null;
const editor = async () => ({ id: 'u1', name: 'Editor', appRole: 'content' });
const admin  = async () => ({ id: 'u2', name: 'Admin',  appRole: 'admin'   });

test('PUT without a session is refused and writes nothing', async () => {
  const store = mockStore(ITEM);
  const { res, out } = mockRes();
  await handler({ method: 'PUT', query: { id: 'c1' }, headers: {}, body: { status: 'trash' } },
                res, { store, currentUser: anon });
  assert.equal(out.code, 401);
  assert.deepEqual(store.writes, [], 'anonymous PUT must not reach kv.set');
});

test('DELETE without a session is refused and writes nothing', async () => {
  const store = mockStore(ITEM);
  const { res, out } = mockRes();
  await handler({ method: 'DELETE', query: { id: 'c1' }, headers: {} }, res, { store, currentUser: anon });
  assert.equal(out.code, 401);
  assert.deepEqual(store.writes, [], 'anonymous DELETE must not reach kv.del');
});

test('DELETE as a non-admin is refused and writes nothing', async () => {
  const store = mockStore(ITEM);
  const { res, out } = mockRes();
  await handler({ method: 'DELETE', query: { id: 'c1' }, headers: {} }, res, { store, currentUser: editor });
  assert.equal(out.code, 403);
  assert.deepEqual(store.writes, [], 'a content-role DELETE must not reach kv.del');
});

// Controls — these fail if the guards are too broad rather than too narrow.
test('control: a signed-in editor can still PUT', async () => {
  const store = mockStore(ITEM);
  const { res, out } = mockRes();
  await handler({ method: 'PUT', query: { id: 'c1' }, headers: {}, body: { status: 'trash' } },
                res, { store, currentUser: editor });
  assert.notEqual(out.code, 401);
  assert.equal(store.writes.filter(w => w[0] === 'set').length, 1, 'a legitimate edit must still be written');
});

test('control: GET is not gated', async () => {
  const store = mockStore(ITEM);
  const { res, out } = mockRes();
  await handler({ method: 'GET', query: { id: 'c1' }, headers: {} }, res, { store, currentUser: anon });
  assert.equal(out.body.title, 'Live article');
});

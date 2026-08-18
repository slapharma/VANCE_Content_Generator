/**
 * Drives the two catch-all routers directly and asserts the gate is actually in
 * the request path.
 *
 * The unit tests in lib/api-auth.test.js prove the guard decides correctly; they
 * would all still pass if the guard were never called. This file is the half
 * that proves it is called, for every route on both routers — which is the
 * failure that would otherwise ship silently, because a route that skips the
 * gate looks exactly like a route that passes it.
 *
 * A refused request never reaches KV: the guard answers 401 before any handler
 * runs. The few cases that are supposed to get through do reach a handler and
 * then fail on the missing KV env, which is what allowed() below accounts for.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.CRON_SECRET ||= 'test-cron-secret';
process.env.TELEGRAM_WEBHOOK_SECRET ||= 'test-telegram-secret';

const { handler: automationRouter } = await import('./automation/[...slug].js');
const { handler: socialRouter } = await import('./social/[...slug].js');

// The session is injected rather than inferred from the absence of a cookie, so
// these keep their meaning if getCurrentUser's internals change.
const NO_SESSION = { currentUser: async () => null };
const ADMIN = { currentUser: async () => ({ id: 'u1', email: 'a@b.c', appRole: 'admin' }) };

function mockReq({ method = 'GET', slug = '', headers = {}, query = {}, body = {} } = {}) {
  return { method, headers, body, query: { ...query, '...slug': slug } };
}

function mockRes() {
  const out = { code: 200, body: null, ended: false };
  out.status = (c) => { out.code = c; return out; };
  out.json = (b) => { out.body = b; out.ended = true; return out; };
  out.send = (b) => { out.body = b; out.ended = true; return out; };
  out.end = () => { out.ended = true; return out; };
  out.setHeader = () => out;
  return out;
}

const anon = async (router, opts) => {
  const res = mockRes();
  await router(mockReq(opts), res, NO_SESSION);
  return res;
};

/**
 * Did the guard let this caller through? These tests import the bare handler
 * rather than the error-boundary-wrapped default export, so a route that gets
 * past the guard then throws on the missing KV env — reaching the handler at
 * all IS the thing being asserted, so a throw counts as "allowed". Only an
 * explicit 401/403 counts as refused.
 */
async function allowed(router, opts, deps) {
  const res = mockRes();
  try {
    await router(mockReq(opts), res, deps);
  } catch {
    return true; // reached the handler, which then failed downstream
  }
  return res.code !== 401 && res.code !== 403;
}

// Every route reachable on the automation router, and what an anonymous caller
// must get. 'self' means the handler does its own check and answers 401 itself.
const AUTOMATION = [
  ['run', 'POST'], ['logs', 'GET'], ['sources-list', 'GET'], ['telegram-test', 'GET'],
  ['rules', 'GET'], ['rules', 'POST'], ['rules/rule_x', 'GET'], ['rules/rule_x', 'PATCH'],
  ['rules/rule_x', 'DELETE'], ['jobs', 'GET'], ['jobs/job_x', 'GET'],
  ['bibliography', 'GET'], ['approve', 'POST'], ['auth/google', 'POST'],
];

for (const [slug, method] of AUTOMATION) {
  test(`automation: anonymous ${method} /${slug} is refused`, async () => {
    const res = await anon(automationRouter, { slug, method });
    assert.equal(res.code, 401, `${method} /api/automation/${slug} answered ${res.code}`);
  });
}

const SOCIAL = [
  ['generate', 'POST'], ['post', 'POST'], ['deploy', 'POST'], ['kits', 'GET'],
  ['kits/kit_x', 'GET'], ['schedule', 'GET'], ['posted', 'GET'], ['image', 'POST'],
  ['carousels', 'GET'], ['carousel', 'POST'], ['promos', 'GET'], ['promo-prompts', 'GET'],
  ['design-templates', 'GET'], ['stock', 'POST'], ['canva', 'GET'],
  ['connections', 'GET'], ['accounts', 'GET'],
];

for (const [slug, method] of SOCIAL) {
  test(`social: anonymous ${method} /${slug} is refused`, async () => {
    const res = await anon(socialRouter, { slug, method });
    assert.equal(res.code, 401, `${method} /api/social/${slug} answered ${res.code}`);
  });
}

test('posting to a live social account is refused anonymously', async () => {
  // The single worst case: this publishes to the connected Instagram /
  // LinkedIn / X / TikTok accounts.
  const res = await anon(socialRouter, { slug: 'post', method: 'POST' });
  assert.equal(res.code, 401);
});

test('the Telegram webhook still gates itself, not via the session', async () => {
  // Carved out of the router gate — Telegram has no session to offer. It must
  // refuse a wrong secret and it must not answer 401 for lack of a cookie.
  const bad = mockRes();
  await automationRouter(mockReq({ slug: 'telegram', method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'wrong' } }), bad, NO_SESSION);
  assert.equal(bad.code, 401);
  assert.equal(bad.body?.error, 'Unauthorized', 'should be the webhook check, not the session gate');
});

test('cron still reaches the two scheduled routes', async () => {
  const headers = { authorization: `Bearer ${process.env.CRON_SECRET}` };

  assert.ok(await allowed(automationRouter, { slug: 'run', method: 'POST', headers }, NO_SESSION),
    'the 07:00 Vercel cron must still be able to drive /api/automation/run');
  assert.ok(await allowed(socialRouter, { slug: 'connections/check', method: 'GET', headers }, NO_SESSION),
    'the 06:00 connections cron must still run');

  // ...and the bearer token is what does it, not the route being exempt.
  assert.equal(await allowed(automationRouter, { slug: 'run', method: 'POST' }, NO_SESSION), false);
  assert.equal(await allowed(automationRouter,
    { slug: 'run', method: 'POST', headers: { authorization: 'Bearer wrong' } }, NO_SESSION), false);
});

test('an internal server-to-server call reaches approve, a wrong secret does not', async () => {
  // run.js calls this on review timeout with no session to offer.
  const opts = {
    slug: 'approve', method: 'POST',
    body: { jobId: 'job_x', action: 'approve', channel: 'timeout' },
  };
  assert.ok(await allowed(automationRouter,
    { ...opts, headers: { 'x-internal-secret': process.env.CRON_SECRET } }, NO_SESSION),
    'run.js must still be able to auto-approve on timeout');

  assert.equal(await allowed(automationRouter,
    { ...opts, headers: { 'x-internal-secret': 'wrong' } }, NO_SESSION), false);
});

test('an unknown route is refused before it 404s', async () => {
  // A 404 would leak which routes exist to an anonymous caller.
  const res = await anon(automationRouter, { slug: 'no-such-route', method: 'GET' });
  assert.equal(res.code, 401);
});

test('a signed-in user below the required role is refused on rules and jobs', async () => {
  // The role half of the check, which a plain "is there a session" test cannot see.
  const viewer = { currentUser: async () => ({ id: 'u2', email: 'v@b.c', appRole: 'viewer' }) };
  for (const slug of ['rules', 'jobs']) {
    const res = mockRes();
    await automationRouter(mockReq({ slug, method: 'GET' }), res, viewer);
    assert.equal(res.code, 403, `GET /api/automation/${slug} let a viewer through`);
  }
});

test('an admin reaches rules and jobs', async () => {
  // The guard has to let the right people through, not just keep everyone out.
  for (const slug of ['rules', 'jobs']) {
    assert.ok(await allowed(automationRouter, { slug, method: 'GET' }, ADMIN),
      `admin was refused on /api/automation/${slug}`);
  }
});

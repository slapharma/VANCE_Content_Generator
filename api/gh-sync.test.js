import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isAllowedPath, handler } from './gh-sync.js';

const NO_SESSION = { currentUser: async () => null };
const signedIn = (fetchFn) => ({ currentUser: async () => ({ id: 'u1', appRole: 'admin' }), fetchFn });

function mockRes() {
  const out = { code: 200, body: null };
  out.status = (c) => { out.code = c; return out; };
  out.json = (b) => { out.body = b; return out; };
  return out;
}

const ghRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');

// ── The allowlist ────────────────────────────────────────────────────────────
// This is the security boundary. The client picks `path`, and the server holds a
// token that can write to the repo, so anything reachable here is writable by
// any signed-in user.

test('the three real sync paths are allowed', () => {
  for (const p of [
    'data/config/custom-categories.json',
    'data/clinical-reviews/reviews.json',
    'data/clinical-reviews/prompts.json',
    'data/cat_1755500000000/reviews.json',
    'data/op-eds/prompts.json',
  ]) {
    assert.equal(isAllowedPath(p), true, `${p} should be allowed`);
  }
});

test('a workflow file is refused — this is the one that would be RCE', () => {
  // A PUT here executes arbitrary code in CI on the next push.
  for (const p of [
    '.github/workflows/deploy.yml',
    'data/../.github/workflows/deploy.yml',
    'data/x/../../.github/workflows/deploy.yml',
    'index.html',
    'package.json',
    'api/gh-sync.js',
  ]) {
    assert.equal(isAllowedPath(p), false, `${p} must be refused`);
  }
});

test('traversal, absolute paths and odd shapes are refused', () => {
  for (const p of [
    '/data/x/reviews.json',
    'data//reviews.json',
    'data/x/reviews.json/../../evil',
    'data/x/y/reviews.json',
    'data/x/reviews.txt',
    'data/x/settings.json',
    'data/config/other.json',
    'data/' + 'a'.repeat(300) + '/reviews.json',
    '',
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(isAllowedPath(p), false, `${JSON.stringify(p)} must be refused`);
  }
});

// ── The route ────────────────────────────────────────────────────────────────

test('an anonymous caller is refused before the token is read', async () => {
  const res = mockRes();
  await handler({ method: 'GET', query: { path: 'data/x/reviews.json' } }, res, NO_SESSION);
  assert.equal(res.code, 401);
});

test('a disallowed path is refused even for a signed-in user', async () => {
  process.env.GITHUB_SYNC_TOKEN = 'tok';
  let called = false;
  const res = mockRes();
  await handler(
    { method: 'PUT', body: { path: '.github/workflows/deploy.yml', content: [] } },
    res,
    signedIn(async () => { called = true; return ghRes(200, {}); }),
  );
  assert.equal(res.code, 400);
  assert.equal(called, false, 'no request should reach GitHub');
});

test('GET decodes a file and returns { content, sha }', async () => {
  process.env.GITHUB_SYNC_TOKEN = 'tok';
  const res = mockRes();
  await handler(
    { method: 'GET', query: { path: 'data/clinical-reviews/reviews.json' } },
    res,
    signedIn(async () => ghRes(200, { content: b64([{ id: 'a' }]), sha: 'sha1' })),
  );
  assert.deepEqual(res.body, { content: [{ id: 'a' }], sha: 'sha1' });
});

test('UTF-8 survives the base64 round trip', async () => {
  // The browser version needed decodeURIComponent(escape(atob(x))) for this and
  // double-decoded on the >1MB path. Buffer handles it directly.
  process.env.GITHUB_SYNC_TOKEN = 'tok';
  const rich = [{ title: 'Crohn’s — “remission”, café, 日本語' }];
  const res = mockRes();
  await handler(
    { method: 'GET', query: { path: 'data/x/reviews.json' } },
    res,
    signedIn(async () => ghRes(200, { content: b64(rich), sha: 's' })),
  );
  assert.deepEqual(res.body.content, rich);
});

test('a missing file reads as an empty list, so a new category bootstraps', async () => {
  process.env.GITHUB_SYNC_TOKEN = 'tok';
  const res = mockRes();
  await handler(
    { method: 'GET', query: { path: 'data/brand-new/reviews.json' } },
    res,
    signedIn(async () => ghRes(404, {})),
  );
  assert.deepEqual(res.body, { content: [], sha: null });
});

test('the >1MB download_url fallback is followed', async () => {
  process.env.GITHUB_SYNC_TOKEN = 'tok';
  const big = [{ id: 'big' }];
  const res = mockRes();
  await handler(
    { method: 'GET', query: { path: 'data/x/reviews.json' } },
    res,
    signedIn(async (url) => (url.includes('raw')
      ? ghRes(200, JSON.stringify(big))
      : ghRes(200, { content: '', download_url: 'https://raw.example/x', sha: 's' }))),
  );
  assert.deepEqual(res.body, { content: big, sha: 's' });
});

test('PUT sends base64 on the configured branch and returns the new sha', async () => {
  process.env.GITHUB_SYNC_TOKEN = 'tok';
  let sent;
  const res = mockRes();
  await handler(
    { method: 'PUT', body: { path: 'data/x/prompts.json', content: [{ n: 1 }], sha: 'old', message: 'msg' } },
    res,
    signedIn(async (url, opts) => { sent = { url, opts }; return ghRes(200, { content: { sha: 'new' } }); }),
  );
  assert.equal(res.body.sha, 'new');
  const body = JSON.parse(sent.opts.body);
  assert.equal(body.sha, 'old');
  assert.equal(body.message, 'msg');
  assert.deepEqual(JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')), [{ n: 1 }]);
  assert.ok(sent.opts.headers.Authorization.includes('tok'));
});

test('PUT refuses a non-array body', async () => {
  process.env.GITHUB_SYNC_TOKEN = 'tok';
  const res = mockRes();
  await handler(
    { method: 'PUT', body: { path: 'data/x/prompts.json', content: { not: 'an array' } } },
    res,
    signedIn(async () => ghRes(200, {})),
  );
  assert.equal(res.code, 400);
});

test('an unconfigured token answers 503, not a confusing GitHub 401', async () => {
  const saved = process.env.GITHUB_SYNC_TOKEN;
  delete process.env.GITHUB_SYNC_TOKEN;
  try {
    const res = mockRes();
    await handler({ method: 'GET', query: { path: 'data/x/reviews.json' } }, res, signedIn(async () => ghRes(200, {})));
    assert.equal(res.code, 503);
  } finally {
    if (saved !== undefined) process.env.GITHUB_SYNC_TOKEN = saved;
  }
});

// ── The client half ──────────────────────────────────────────────────────────

test('index.html carries no GitHub credential or repo coordinates', () => {
  // The PAT was revoked on 2026-08-18. This asserts the shape that made it
  // exposed in the first place cannot come back: nothing in the page should
  // name the repo, the API host, or hold a token.
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
  for (const needle of ['GH_TOKEN', 'api.github.com', 'SLAHEALTH_ClinicalReview_Generator', 'ghp_']) {
    assert.ok(!html.includes(needle), `index.html still contains ${needle}`);
  }
  assert.ok(!/String\.fromCharCode\(\s*103\s*,\s*104\s*,\s*112/.test(html), 'the obfuscated token literal is back');
  assert.ok(html.includes("fetch('/api/gh-sync'"), 'the client should sync via the server route');
});

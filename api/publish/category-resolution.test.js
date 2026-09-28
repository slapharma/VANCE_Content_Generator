import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kv } from '../../lib/kv.js';
import handler from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

// ── (a) CATEGORY_SLUG_MAP vs BUILTIN_CATEGORY_META consistency ──────────────
//
// api/publish/index.js and index.html each carry an independent copy of the
// app-category → WP-category-slug mapping (documented as "mirrors" in a
// comment, not enforced by any shared import). This is exactly how the
// industry-news slug drifted: one file was updated when the live WP term was
// renamed, the other wasn't. Neither map is exported, so we parse the literal
// source text — the same approach used for BUILTIN_CATEGORY_META here.

function parseCategorySlugMap() {
  const src = fs.readFileSync(path.join(repoRoot, 'api/publish/index.js'), 'utf8');
  const match = src.match(/const CATEGORY_SLUG_MAP = \{([\s\S]*?)\};/);
  assert.ok(match, 'CATEGORY_SLUG_MAP block not found in api/publish/index.js — source shape changed');
  const body = match[1];
  const map = {};
  for (const entryMatch of body.matchAll(/'([^']+)':\s*'([^']+)'/g)) {
    map[entryMatch[1]] = entryMatch[2];
  }
  return map;
}

function parseBuiltinCategoryMeta() {
  const src = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const match = src.match(/const BUILTIN_CATEGORY_META = \{([\s\S]*?)\n\};/);
  assert.ok(match, 'BUILTIN_CATEGORY_META block not found in index.html — source shape changed');
  const body = match[1];
  const map = {};
  // Each entry is a single line: 'id': { ... wpCategorySlug: 'slug', ... }
  for (const lineMatch of body.matchAll(/'([^']+)':\s*\{[^}]*wpCategorySlug:\s*'([^']+)'[^}]*\}/g)) {
    map[lineMatch[1]] = lineMatch[2];
  }
  return map;
}

test('every CATEGORY_SLUG_MAP entry matches the wpCategorySlug in BUILTIN_CATEGORY_META', () => {
  const slugMap = parseCategorySlugMap();
  const metaMap = parseBuiltinCategoryMeta();

  // Sanity: both parses actually found entries, so a regex drift doesn't
  // silently pass this test with two empty objects.
  assert.ok(Object.keys(slugMap).length > 0, 'parsed zero entries from CATEGORY_SLUG_MAP');
  assert.ok(Object.keys(metaMap).length > 0, 'parsed zero entries from BUILTIN_CATEGORY_META');

  for (const [categoryId, slug] of Object.entries(slugMap)) {
    assert.equal(
      metaMap[categoryId],
      slug,
      `CATEGORY_SLUG_MAP['${categoryId}'] = '${slug}' but BUILTIN_CATEGORY_META['${categoryId}'].wpCategorySlug = '${metaMap[categoryId]}'`
    );
  }
});

test('the industry-news slug specifically points at the live WP term', () => {
  // Regression test for the bug itself: the map previously said
  // 'content-healthcare-news', which does not exist on the live site.
  const slugMap = parseCategorySlugMap();
  assert.equal(slugMap['industry-news'], 'content-health-news');
});

// ── (b) Handler-level fallback behaviour ────────────────────────────────────
//
// Drives the real exported handler with a mocked KV store and mocked WP REST
// fetch calls. Covers:
//   - a stale stored override (item.wpCategorySlug) that no longer resolves on
//     WP falls back to the CATEGORY_SLUG_MAP default and still publishes with
//     a category attached, instead of publishing uncategorised.
//   - an item with no override resolves the default slug directly.

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    end() { return this; },
  };
  return res;
}

function installEnv() {
  process.env.WP_USERNAME = 'test-user';
  process.env.WP_APP_PASSWORD = 'test-pass';
  process.env.WP_SITE_URL = 'https://example.test';
}

test('falls back to the default category slug when a stored override no longer resolves on WP', async () => {
  installEnv();

  const item = {
    id: 'content_1',
    status: 'approved',
    title: 'Some Industry News',
    body: 'Body text.',
    excerpt: '',
    category: 'industry-news',
    wpCategorySlug: 'stale-slug',
  };

  kv.get = async (key) => (key === 'content:content_1' ? item : null);
  const kvSetCalls = [];
  kv.set = async (key, value) => { kvSetCalls.push({ key, value }); };

  const postCalls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/wp-json/wp/v2/categories?slug=stale-slug')) {
      return { ok: true, json: async () => [] };
    }
    if (u.includes('/wp-json/wp/v2/categories?slug=content-health-news')) {
      return { ok: true, json: async () => [{ id: 15 }] };
    }
    if (u.endsWith('/wp-json/wp/v2/posts') && opts?.method === 'POST') {
      postCalls.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ id: 999, link: 'https://example.test/?p=999' }) };
    }
    throw new Error(`unexpected fetch call in test: ${u}`);
  };

  const req = { method: 'POST', body: { contentId: 'content_1' } };
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(postCalls.length, 1, 'expected exactly one POST to /wp-json/wp/v2/posts');
  assert.deepEqual(postCalls[0].categories, [15], 'post should carry the fallback-resolved category id');
  assert.equal(res.body.taxonomy.categoryIds.length, 1);
  assert.equal(res.body.taxonomy.categoryIds[0], 15);

  // The content record write-back should also record the resolved category.
  assert.equal(kvSetCalls.length, 1);
  assert.deepEqual(kvSetCalls[0].value.wpCategoryIds, [15]);
});

test('resolves the default category slug directly when no override is stored', async () => {
  installEnv();

  const item = {
    id: 'content_2',
    status: 'approved',
    title: 'Some Other News',
    body: 'Body text.',
    excerpt: '',
    category: 'industry-news',
    // no wpCategorySlug override
  };

  kv.get = async (key) => (key === 'content:content_2' ? item : null);
  kv.set = async () => {};

  const categoryLookupUrls = [];
  const postCalls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/wp-json/wp/v2/categories?slug=')) {
      categoryLookupUrls.push(u);
      if (u.includes('slug=content-health-news')) {
        return { ok: true, json: async () => [{ id: 15 }] };
      }
      return { ok: true, json: async () => [] };
    }
    if (u.endsWith('/wp-json/wp/v2/posts') && opts?.method === 'POST') {
      postCalls.push(JSON.parse(opts.body));
      return { ok: true, json: async () => ({ id: 1000, link: 'https://example.test/?p=1000' }) };
    }
    throw new Error(`unexpected fetch call in test: ${u}`);
  };

  const req = { method: 'POST', body: { contentId: 'content_2' } };
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  // Only one category lookup needed — no stale override to retry past.
  assert.equal(categoryLookupUrls.length, 1);
  assert.deepEqual(postCalls[0].categories, [15]);
});

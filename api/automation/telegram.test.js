import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../lib/automation/handlers/telegram.js';

test('Telegram webhook handler', async (t) => {
  // Set environment variables
  process.env.TELEGRAM_WEBHOOK_SECRET = 'test-secret';
  process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
  process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';

  await t.test('returns 405 for non-POST requests', async () => {
    let fetchCalls = [];
    const kvMock = {};
    const fetchMock = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: true, json: async () => ({}) };
    };

    global.fetch = fetchMock;

    const req = { method: 'GET', headers: {} };
    const res = {
      status: (code) => ({
        json: (data) => {
          assert.equal(code, 405);
          assert.deepEqual(data, { error: 'Method not allowed' });
          return res;
        },
      }),
    };

    const handler = createHandler(kvMock);
    await handler(req, res);
  });

  await t.test('returns 401 for wrong secret', async () => {
    let fetchCalls = [];
    const kvMock = {};
    const fetchMock = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: true, json: async () => ({}) };
    };

    global.fetch = fetchMock;

    const req = {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
      body: { callback_query: { data: 'approve:job_1', id: 'cq_1' } },
    };

    const res = {
      status: (code) => ({
        json: (data) => {
          assert.equal(code, 401);
          assert.deepEqual(data, { error: 'Unauthorized' });
          return res;
        },
      }),
    };

    const handler = createHandler(kvMock);
    await handler(req, res);
  });

  await t.test('returns 200 for non-button updates (no callback_query)', async () => {
    let fetchCalls = [];
    const kvMock = {};
    const fetchMock = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: true, json: async () => ({}) };
    };

    global.fetch = fetchMock;

    const req = {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
      body: { message: { text: 'hello' } }, // No callback_query
    };

    let responseData;
    const res = {
      status: (code) => ({
        json: (data) => {
          assert.equal(code, 200);
          responseData = data;
          return res;
        },
      }),
    };

    const handler = createHandler(kvMock);
    await handler(req, res);
    assert.deepEqual(responseData, { ok: true });
  });

  await t.test('approves job and updates status', async () => {
    let fetchCalls = [];

    // Pre-populate KV with a job
    const jobId = 'job_test_1';
    let job = {
      id: jobId,
      ruleId: 'rule_1',
      contentId: 'content_1',
      status: 'pending',
      createdAt: '2026-03-20T10:00:00Z',
    };

    // Simulate KV store
    const kvMock = {
      get: async (key) => {
        if (key === `automation:job:${jobId}`) return job;
        if (key === 'automation:rule:rule_1') {
          return { id: 'rule_1', publish: { wordpress: true } };
        }
        return null;
      },
      set: async (key, value) => {
        if (key === `automation:job:${jobId}`) {
          job = value;
        }
      },
    };

    // Mock fetch for Telegram and publish
    const fetchMock = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: true, json: async () => ({}) };
    };

    global.fetch = fetchMock;

    const req = {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
      body: { callback_query: { data: 'approve:job_test_1', id: 'cq_1' } },
    };

    let responseData;
    const res = {
      status: (code) => ({
        json: (data) => {
          assert.equal(code, 200);
          responseData = data;
          return res;
        },
      }),
    };

    const handler = createHandler(kvMock);
    await handler(req, res);

    assert.deepEqual(responseData, { ok: true });
    assert.equal(job.status, 'published'); // Should be published after /api/publish call
    assert.equal(job.approvedBy, 'telegram');
    assert.ok(job.approvedAt);

    // Verify Telegram API was called
    const telegramCall = fetchCalls.find((c) => c.url.includes('answerCallbackQuery'));
    assert.ok(telegramCall, 'answerCallbackQuery should be called');

    // Verify publish API was called
    const publishCall = fetchCalls.find((c) => c.url.includes('/api/publish'));
    assert.ok(publishCall, 'publish API should be called');
    assert.deepEqual(JSON.parse(publishCall.opts.body), { id: 'content_1' });
  });

  await t.test('rejects job and updates status', async () => {
    let fetchCalls = [];

    const jobId = 'job_test_2';
    let job = {
      id: jobId,
      ruleId: 'rule_2',
      contentId: 'content_2',
      status: 'pending',
      createdAt: '2026-03-20T10:00:00Z',
    };

    const kvMock = {
      get: async (key) => {
        if (key === `automation:job:${jobId}`) return job;
        return null;
      },
      set: async (key, value) => {
        if (key === `automation:job:${jobId}`) {
          job = value;
        }
      },
    };

    const fetchMock = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: true, json: async () => ({}) };
    };

    global.fetch = fetchMock;

    const req = {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
      body: { callback_query: { data: 'reject:job_test_2', id: 'cq_2' } },
    };

    let responseData;
    const res = {
      status: (code) => ({
        json: (data) => {
          responseData = data;
          return res;
        },
      }),
    };

    const handler = createHandler(kvMock);
    await handler(req, res);

    assert.deepEqual(responseData, { ok: true });
    // "Request changes" via Telegram is feedback, not a veto — job stays open so
    // other reviewers can still vote. Only the rejections array gains the entry.
    assert.notEqual(job.status, 'rejected');
    assert.ok(Array.isArray(job.rejections) && job.rejections.includes('telegram'));

    // Verify only answerCallbackQuery was called, not publish
    const telegramCall = fetchCalls.find((c) => c.url.includes('answerCallbackQuery'));
    assert.ok(telegramCall, 'answerCallbackQuery should be called');
    const publishCall = fetchCalls.find((c) => c.url.includes('/api/publish'));
    assert.ok(!publishCall, 'publish API should NOT be called for change requests');
  });

  await t.test('ignores callback for non-existent job', async () => {
    let fetchCalls = [];

    const kvMock = {
      get: async (key) => null, // Job doesn't exist
      set: async () => {},
    };

    const fetchMock = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: true, json: async () => ({}) };
    };

    global.fetch = fetchMock;

    const req = {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
      body: { callback_query: { data: 'approve:job_nonexistent', id: 'cq_3' } },
    };

    let responseData;
    const res = {
      status: (code) => ({
        json: (data) => {
          responseData = data;
          return res;
        },
      }),
    };

    const handler = createHandler(kvMock);
    await handler(req, res);

    assert.deepEqual(responseData, { ok: true });

    // Verify answerCallbackQuery was called with "not found" message
    const telegramCall = fetchCalls.find((c) => c.url.includes('answerCallbackQuery'));
    assert.ok(telegramCall, 'answerCallbackQuery should be called');
    const body = JSON.parse(telegramCall.opts.body);
    assert.ok(body.text.includes('not found') || body.text.includes('Job not found'));
  });

  await t.test('ignores callback for terminal status jobs', async () => {
    let fetchCalls = [];

    const jobId = 'job_terminal';
    const job = {
      id: jobId,
      status: 'published', // Terminal status
      createdAt: '2026-03-20T10:00:00Z',
    };

    const kvMock = {
      get: async (key) => {
        if (key === `automation:job:${jobId}`) return job;
        return null;
      },
      set: async () => {},
    };

    const fetchMock = async (url, opts) => {
      fetchCalls.push({ url, opts });
      return { ok: true, json: async () => ({}) };
    };

    global.fetch = fetchMock;

    const req = {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'test-secret' },
      body: { callback_query: { data: 'approve:job_terminal', id: 'cq_4' } },
    };

    let responseData;
    const res = {
      status: (code) => ({
        json: (data) => {
          responseData = data;
          return res;
        },
      }),
    };

    const handler = createHandler(kvMock);
    await handler(req, res);

    assert.deepEqual(responseData, { ok: true });

    // Verify answerCallbackQuery was called with "already published" message
    const telegramCall = fetchCalls.find((c) => c.url.includes('answerCallbackQuery'));
    assert.ok(telegramCall, 'answerCallbackQuery should be called');
    const body = JSON.parse(telegramCall.opts.body);
    assert.ok(body.text.includes('Already'));
  });
});

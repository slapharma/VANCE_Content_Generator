import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildTelegramPayload, buildApprovalEmailHtml, sendNotifications } from './notify.js';

// ── 1. buildTelegramPayload ───────────────────────────────────────────────────

describe('buildTelegramPayload', () => {
  it('returns object with correct chat_id', () => {
    const payload = buildTelegramPayload({ chatId: '12345', jobId: 'job-1', title: 'Test Title', category: 'Cardiology' });
    assert.equal(payload.chat_id, '12345');
    assert.equal(payload.parse_mode, 'Markdown');
  });

  it('includes title and category in text', () => {
    const payload = buildTelegramPayload({ chatId: '12345', jobId: 'job-1', title: 'Test Title', category: 'Cardiology' });
    assert.ok(payload.text.includes('Test Title'), 'text should include title');
    assert.ok(payload.text.includes('Cardiology'), 'text should include category');
  });

  it('has inline keyboard with approve and reject callback_data', () => {
    const payload = buildTelegramPayload({ chatId: '99', jobId: 'job-42', title: 'Article', category: 'Oncology' });
    const buttons = payload.reply_markup.inline_keyboard[0];
    const approveBtn = buttons.find(b => b.callback_data === 'approve:job-42');
    const rejectBtn  = buttons.find(b => b.callback_data === 'reject:job-42');
    assert.ok(approveBtn, 'should have approve button with correct callback_data');
    assert.ok(rejectBtn,  'should have reject button with correct callback_data');
  });
});

// ── 2. buildApprovalEmailHtml ─────────────────────────────────────────────────

describe('buildApprovalEmailHtml', () => {
  it('contains approveUrl in output', () => {
    const html = buildApprovalEmailHtml({
      title: 'My Article',
      category: 'Neurology',
      approveUrl: 'https://example.com/approve?token=aaa',
      rejectUrl:  'https://example.com/reject?token=bbb',
    });
    assert.ok(html.includes('https://example.com/approve?token=aaa'), 'should contain approveUrl');
  });

  it('contains rejectUrl in output', () => {
    const html = buildApprovalEmailHtml({
      title: 'My Article',
      category: 'Neurology',
      approveUrl: 'https://example.com/approve?token=aaa',
      rejectUrl:  'https://example.com/reject?token=bbb',
    });
    assert.ok(html.includes('https://example.com/reject?token=bbb'), 'should contain rejectUrl');
  });

  it('contains article title in output', () => {
    const html = buildApprovalEmailHtml({
      title: 'My Article',
      category: 'Neurology',
      approveUrl: 'https://example.com/approve?token=aaa',
      rejectUrl:  'https://example.com/reject?token=bbb',
    });
    assert.ok(html.includes('My Article'), 'should contain article title');
  });
});

// ── 3. sendNotifications — Telegram ──────────────────────────────────────────

describe('sendNotifications — Telegram', () => {
  it('calls fetchFn with Telegram API URL when telegram enabled', async () => {
    let calledUrl = null;
    const mockFetch = async (url, opts) => {
      calledUrl = url;
      return { ok: true };
    };

    const rule = {
      notifications: {
        telegram: { enabled: true, chatId: 'chat-123' },
        email: { enabled: false },
      },
      review: { timeoutHours: 48 },
    };
    const job = { id: 'job-99' };
    const content = { title: 'Test', category: 'Cardio' };

    process.env.TELEGRAM_BOT_TOKEN = 'fake-bot-token';
    const { errors } = await sendNotifications({ rule, job, content, fetchFn: mockFetch });

    assert.ok(calledUrl, 'fetchFn should have been called');
    assert.ok(calledUrl.includes('api.telegram.org'), 'URL should be Telegram API');
    assert.ok(calledUrl.includes('fake-bot-token'), 'URL should include bot token');
    assert.equal(errors.length, 0, 'no errors expected on success');
    delete process.env.TELEGRAM_BOT_TOKEN;
  });
});

// ── 4. sendNotifications — Email ──────────────────────────────────────────────

describe('sendNotifications — Email', () => {
  it('calls resend client when email enabled', async () => {
    let sentPayload = null;
    const mockResend = {
      emails: {
        send: async (payload) => {
          sentPayload = payload;
          return {};
        },
      },
    };

    const rule = {
      notifications: {
        telegram: { enabled: false },
        email: { enabled: true, to: ['reviewer@example.com'] },
      },
      review: { timeoutHours: 24 },
    };
    const job = { id: 'job-email-1' };
    const content = { title: 'Email Article', category: 'Oncology' };

    const { errors } = await sendNotifications({ rule, job, content, resendClient: mockResend });

    assert.ok(sentPayload, 'resend client should have been called');
    // Per-recipient send: `to` is now a single email per call, not an array
    assert.equal(sentPayload.to, 'reviewer@example.com');
    assert.ok(sentPayload.subject.includes('Email Article'), 'subject should include title');
    assert.equal(errors.length, 0, 'no errors expected on success');
  });
});

// ── 5. sendNotifications — non-fatal error handling ──────────────────────────

describe('sendNotifications — error handling', () => {
  it('returns error in array when fetch fails (non-fatal)', async () => {
    const failFetch = async () => ({ ok: false, status: 500 });

    const rule = {
      notifications: {
        telegram: { enabled: true, chatId: 'chat-err' },
        email: { enabled: false },
      },
      review: { timeoutHours: 48 },
    };
    const job = { id: 'job-fail' };
    const content = { title: 'Fail Article', category: 'Test' };

    process.env.TELEGRAM_BOT_TOKEN = 'any-token';
    const { errors } = await sendNotifications({ rule, job, content, fetchFn: failFetch });
    delete process.env.TELEGRAM_BOT_TOKEN;

    assert.equal(errors.length, 1, 'should have one error');
    assert.ok(errors[0].includes('Telegram'), 'error should mention Telegram');
  });

  it('returns error in array when fetch throws (non-fatal)', async () => {
    const throwFetch = async () => { throw new Error('Network timeout'); };

    const rule = {
      notifications: {
        telegram: { enabled: true, chatId: 'chat-throw' },
        email: { enabled: false },
      },
      review: { timeoutHours: 48 },
    };
    const job = { id: 'job-throw' };
    const content = { title: 'Throw Article', category: 'Test' };

    process.env.TELEGRAM_BOT_TOKEN = 'any-token';
    const { errors } = await sendNotifications({ rule, job, content, fetchFn: throwFetch });
    delete process.env.TELEGRAM_BOT_TOKEN;

    assert.equal(errors.length, 1, 'should have one error');
    assert.ok(errors[0].includes('Network timeout'), 'error should include original message');
  });
});

// lib/automation/handlers/telegram.js
import { kv as defaultKv } from '../../kv.js';

const TERMINAL_STATUSES = ['approved', 'rejected', 'published', 'timed_out', 'auto_published'];
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

async function answerCallbackQuery(callbackQueryId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
    });
  } catch (err) {
    console.error('answerCallbackQuery failed:', err.message);
  }
}

export function createHandler(kvInstance = defaultKv) {
  return async function handler(req, res) {
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

    const job = await kvInstance.get(`automation:job:${jobId}`);
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
      await kvInstance.set(`automation:job:${jobId}`, updated);

      const rule = await kvInstance.get(`automation:rule:${job.ruleId}`);
      // Sync content.status='approved' before publish — endpoint rejects drafts/in_review.
      const contentItem = await kvInstance.get(`content:${job.contentId}`);
      if (contentItem && contentItem.status !== 'published') {
        await kvInstance.set(`content:${job.contentId}`, {
          ...contentItem, status: 'approved', approvedAt: contentItem.approvedAt || now, updatedAt: now,
        });
      }
      if (rule?.publish?.wordpress) {
        try {
          const publishRes = await fetch(`${APP_URL}/api/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contentId: job.contentId }),
          });
          if (publishRes.ok) {
            await kvInstance.set(`automation:job:${jobId}`, { ...updated, status: 'published' });
          } else {
            console.error('Publish after Telegram approval failed: HTTP', publishRes.status);
          }
        } catch (err) {
          console.error('Publish after Telegram approval failed:', err.message);
        }
      }
      await answerCallbackQuery(callback_query.id, '✅ Approved — publishing now');
    } else {
      // "Request changes" no longer terminates the review — record the vote +
      // surface the request, but leave job.status open so other reviewers can still vote.
      const priorRejections = Array.isArray(job.rejections) ? job.rejections : [];
      await kvInstance.set(`automation:job:${jobId}`, {
        ...job,
        rejections: priorRejections.includes('telegram') ? priorRejections : [...priorRejections, 'telegram'],
        updatedAt: now,
      });
      await answerCallbackQuery(callback_query.id, '💬 Feedback noted — review still open');
    }

    return res.status(200).json({ ok: true });
  };
}

export default createHandler();

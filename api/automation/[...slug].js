// api/automation/[...slug].js
// Catch-all handler that routes all /api/automation/* requests.
// This is the sole Vercel serverless function for the automation module.
// Handler logic lives in lib/automation/handlers/ (outside api/) so Vercel
// does not count each handler as a separate function.

import approveHandler from '../../lib/automation/handlers/approve.js';
import runHandler from '../../lib/automation/handlers/run.js';
import telegramHandler from '../../lib/automation/handlers/telegram.js';
import telegramTestHandler from '../../lib/automation/handlers/telegram-test.js';
import rulesIndexHandler from '../../lib/automation/handlers/rules-index.js';
import rulesIdHandler from '../../lib/automation/handlers/rules-id.js';
import jobsIndexHandler from '../../lib/automation/handlers/jobs-index.js';
import jobsIdHandler from '../../lib/automation/handlers/jobs-id.js';
import authHandler from '../../lib/automation/handlers/auth.js';
import logsHandler from '../../lib/automation/handlers/logs.js';
import sourcesListHandler from '../../lib/automation/handlers/sources-list.js';

export default async function handler(req, res) {
  // In non-Next.js Vercel serverless, [...slug].js exposes matched segments as
  // req.query['...slug'] (three dots are part of the key name), not req.query.slug.
  // Single-segment paths arrive as a plain string ('telegram-test').
  // Multi-segment paths arrive as a slash-joined string ('rules/rule_abc').
  // Split on '/' to normalise both cases into an array.
  // When requests come via the vercel.json rewrite (:slug* capture), the
  // segments arrive as req.query.slug instead of req.query['...slug'].
  const rawSlug = req.query['...slug'] || req.query.slug || '';
  const slug = Array.isArray(rawSlug)
    ? rawSlug
    : String(rawSlug).split('/').filter(Boolean);
  const [first, second] = slug;

  if (first === 'approve') return approveHandler(req, res);
  if (first === 'run') return runHandler(req, res);
  if (first === 'logs') return logsHandler(req, res);
  if (first === 'sources-list') return sourcesListHandler(req, res);
  if (first === 'telegram-test') return telegramTestHandler(req, res);
  if (first === 'telegram') return telegramHandler(req, res);

  // Cloud storage OAuth + config — slug[0]='auth', slug[1]=service, slug[2]=callback?
  if (first === 'auth') return authHandler(req, res, slug);

  if (first === 'rules' && !second) return rulesIndexHandler(req, res);
  if (first === 'rules' && second) {
    req.query.id = second;
    return rulesIdHandler(req, res);
  }

  if (first === 'jobs' && !second) return jobsIndexHandler(req, res);
  if (first === 'jobs' && second) {
    req.query.id = second;
    return jobsIdHandler(req, res);
  }

  return res.status(404).json({ error: 'Not found' });
}

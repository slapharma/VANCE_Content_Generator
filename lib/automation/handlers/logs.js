// lib/automation/handlers/logs.js
// GET    /api/automation/logs       — return recent logs
// DELETE /api/automation/logs       — clear all logs
// POST   /api/automation/logs       — append a single client-side log entry
import { readLogs, clearLogs, writeLog } from '../log.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const limit = parseInt(req.query.limit, 10) || 100;
      const logs  = await readLogs(limit);
      return res.status(200).json(logs);
    }
    if (req.method === 'DELETE') {
      await clearLogs();
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'POST') {
      const rec = await writeLog(req.body || {});
      return res.status(200).json(rec || { ok: false });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

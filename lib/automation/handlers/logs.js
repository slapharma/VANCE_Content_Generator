// lib/automation/handlers/logs.js
// GET    /api/automation/logs       — return recent logs        (unauthenticated, see below)
// DELETE /api/automation/logs       — clear all logs            (admin)
// POST   /api/automation/logs       — append a client-side entry (signed in)
//
// Why GET is still open while the writes are not
// ----------------------------------------------
// This feed is the only externally observable evidence that the 07:00 automation
// run happened. Two monitors on the uptime dashboard read it, both marked
// critical: `cg-api-automation-logs` fetches it directly, and
// `cg-cron-automation-run` derives the job's last-run time from the newest
// timestamp in it. Every other Content Generator cron reports via heartbeat;
// this one does not, so closing GET blinds the only check that can tell anyone
// the research job has stopped.
//
// That is a real exposure and it is not being pretended otherwise — the feed
// carries operational detail about what ran and when. It is left open because
// the alternative available today is worse: an unmonitored cron that dies
// quietly is the failure this whole dashboard exists to catch. Closing it needs
// either a shared secret the dashboard can send, or `cg-cron-automation-run`
// converted to a heartbeat like its three siblings. Until one of those lands,
// disclosure is the lesser cost.
//
// The writes have no such excuse. DELETE wipes the history the monitors read —
// which would also blank the evidence trail — and POST can forge entries into
// it, which is worse than losing them: a fabricated recent timestamp makes a
// dead cron look alive. Neither has any monitoring value, so both are gated on
// the session the UI already carries.
import { readLogs, clearLogs, writeLog } from '../log.js';
import { getCurrentUser, requireRole } from '../../auth.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const limit = parseInt(req.query.limit, 10) || 100;
      const logs  = await readLogs(limit);
      return res.status(200).json(logs);
    }
    if (req.method === 'DELETE') {
      // Admin only: this destroys the evidence trail two critical monitors read,
      // so it is a heavier action than the button in the UI suggests.
      const guard = requireRole(await getCurrentUser(req), 'admin');
      if (!guard.ok) return res.status(guard.status).json({ error: guard.error });
      await clearLogs();
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'POST') {
      // Any signed-in user: the UI writes its own client-side notices here.
      const me = await getCurrentUser(req);
      if (!me) return res.status(401).json({ error: 'Not authenticated' });
      const rec = await writeLog(req.body || {});
      return res.status(200).json(rec || { ok: false });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

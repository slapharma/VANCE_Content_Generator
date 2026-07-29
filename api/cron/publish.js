import { kv } from '../../lib/kv.js';
import { heartbeat } from '../../lib/heartbeat.js';

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const ids = await kv.lrange('content:index', 0, -1);
    if (!ids.length) {
      await heartbeat('cg-publish', { message: 'nothing queued' });
      return res.json({ published: 0, failed: 0, total: 0 });
    }

    const items = await Promise.all(ids.map(id => kv.get(`content:${id}`)));
    const now = new Date();
    const due = items.filter(item =>
      item?.status === 'scheduled' &&
      item.scheduledAt &&
      new Date(item.scheduledAt) <= now
    );

    const results = await Promise.allSettled(
      due.map(item =>
        fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-cron': process.env.CRON_SECRET ?? '' },
          body: JSON.stringify({ contentId: item.id }),
        })
      )
    );

    // A fulfilled fetch only means the request completed — /api/publish can still
    // have answered 500. Counting those as published would make both this log line
    // and the dashboard report success through a total publishing failure.
    const published = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
    const failed    = results.length - published;

    console.log(`Cron: ${published} published, ${failed} failed, ${due.length} due`);

    // Partial failure is amber, not red: one article that would not publish is
    // worth surfacing but is not an outage. Nothing getting through is.
    await heartbeat('cg-publish', {
      status: failed === 0 ? 'ok' : published === 0 ? 'fail' : 'warn',
      message: `${published} published, ${failed} failed of ${due.length} due`,
    });

    return res.json({ published, failed, total: due.length });
  } catch (err) {
    console.error('Cron: publish run failed:', err);
    await heartbeat('cg-publish', { status: 'fail', message: err?.message || 'run threw' });
    return res.status(500).json({ error: err?.message || 'Publish cron failed' });
  }
}

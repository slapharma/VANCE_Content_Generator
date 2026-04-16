import { kv } from '../../lib/kv.js';

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ids = await kv.lrange('content:index', 0, -1);
  if (!ids.length) return res.json({ published: 0, failed: 0, total: 0 });

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

  const published = results.filter(r => r.status === 'fulfilled').length;
  const failed    = results.filter(r => r.status === 'rejected').length;
  console.log(`Cron: ${published} published, ${failed} failed, ${due.length} due`);
  return res.json({ published, failed, total: due.length });
}

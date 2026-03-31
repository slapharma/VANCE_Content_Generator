// lib/automation/handlers/telegram-test.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: '✅ IBD Health Hub Automation is connected! Your Telegram notifications are working.',
    }),
  });
  if (!r.ok) return res.status(502).json({ error: 'Telegram API error' });
  return res.status(200).json({ ok: true });
}

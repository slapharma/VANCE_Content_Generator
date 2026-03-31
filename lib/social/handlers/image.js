// lib/social/handlers/image.js
// POST /api/social/image — generate a hero image via OpenRouter using the same
// models available in the Social Kit (gemini-2.5-flash-image / riverflow-v2-fast).

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';

const ALLOWED_MODELS = new Set([
  'google/gemini-2.5-flash-image',
  'sourceful/riverflow-v2-fast',
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, model } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const safeModel = ALLOWED_MODELS.has(model) ? model : 'google/gemini-2.5-flash-image';

  let resp;
  try {
    resp = await fetch(OPENROUTER_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://ibdhealthhub-content-generator.vercel.app',
        'X-Title': 'IBD Health Hub Content Generator',
      },
      body: JSON.stringify({
        model: safeModel,
        messages: [{ role: 'user', content: prompt }],
        modalities: ['image'],
        image_config: { aspect_ratio: '16:9' },
      }),
    });
  } catch (err) {
    return res.status(502).json({ error: `OpenRouter fetch failed: ${err.message}` });
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => resp.status);
    return res.status(502).json({ error: `OpenRouter error ${resp.status}: ${errText}` });
  }

  const data = await resp.json();
  const imageBase64 = data.choices?.[0]?.message?.images?.[0];
  if (!imageBase64) {
    return res.status(502).json({ error: 'No image in OpenRouter response' });
  }

  // Return as a usable data URL if OpenRouter doesn't already prefix it
  const url = imageBase64.startsWith('data:')
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`;

  return res.status(200).json({ url, model: safeModel });
}

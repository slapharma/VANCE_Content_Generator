// lib/social/handlers/image.js
// POST /api/social/image — generate a hero image via OpenRouter.
// Handles Gemini vs non-Gemini modalities and all 3 response formats.

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';

// IMPORTANT: OpenRouter slug for Gemini 2.5 Flash Image is `google/gemini-2.5-flash-image-preview`
const ALLOWED_MODELS = new Set([
  'google/gemini-3.1-flash-image-preview-20260226',
  'sourceful/riverflow-v2-fast',
  'sourceful/riverflow-v2-pro',
  'bytedance-seed/seedream-4.5',
]);

// Gemini models require ['image', 'text']; all others require ['image'] only
function getModalities(model) {
  return model.startsWith('google/') ? ['image', 'text'] : ['image'];
}

// Parse all 3 image response formats from OpenRouter
function extractImageUrl(data) {
  // Format 1: images[] array (dedicated image models)
  const imgObj = data.choices?.[0]?.message?.images?.[0];
  if (imgObj?.image_url?.url) return imgObj.image_url.url;
  if (typeof imgObj === 'string') return imgObj;

  // Format 2: base64 data URI in content string
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.startsWith('data:')) return content;

  // Format 3: content as array of parts (Gemini native)
  if (Array.isArray(content)) {
    const imgPart = content.find(p => p.type === 'image_url');
    if (imgPart?.image_url?.url) return imgPart.image_url.url;
  }

  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { prompt, model } = req.body || {};
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const safeModel = ALLOWED_MODELS.has(model) ? model : 'google/gemini-3.1-flash-image-preview-20260226';

  let resp;
  try {
    resp = await fetch(OPENROUTER_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://vance-content-generator.vercel.app',
        'X-Title': 'Gastro Health Hub Content Generator',
      },
      body: JSON.stringify({
        model: safeModel,
        messages: [{ role: 'user', content: prompt }],
        modalities: getModalities(safeModel),
        image_config: { aspect_ratio: '16:9' },
      }),
    });
  } catch (err) {
    return res.status(502).json({ error: `OpenRouter fetch failed: ${err.message}` });
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => String(resp.status));
    return res.status(502).json({ error: `OpenRouter error ${resp.status}: ${errText}` });
  }

  const data = await resp.json();
  const imageRaw = extractImageUrl(data);
  if (!imageRaw) {
    return res.status(502).json({ error: 'No image in OpenRouter response', debug: JSON.stringify(data).slice(0, 500) });
  }

  // Ensure it's a usable data URL
  const url = imageRaw.startsWith('data:')
    ? imageRaw
    : `data:image/jpeg;base64,${imageRaw}`;

  return res.status(200).json({ url, model: safeModel });
}

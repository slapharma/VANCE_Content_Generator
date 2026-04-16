const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';
const FAL_BASE = 'https://fal.run/fal-ai/kling-video/v2.1/standard/text-to-video';
const FAL_STATUS_BASE = 'https://fal.run/fal-ai/kling-video/v2.1/standard/text-to-video/requests';

const OR_HEADERS = {
  'Content-Type': 'application/json',
  'HTTP-Referer': 'https://vance-content-generator.vercel.app',
  'X-Title': 'Vance Content Generator',
};

// ── Image model config ───────────────────────────────────────────────────────
// Gemini models require ['image', 'text']; all others require ['image'] only.
// IMPORTANT: OpenRouter slug for Gemini 2.5 Flash Image is `google/gemini-2.5-flash-image-preview`
// (the `-preview` suffix is required) — not `google/gemini-2.5-flash-image`.
const IMAGE_MODELS = {
  'google/gemini-3.1-flash-image-preview-20260226': { modalities: ['image', 'text'] },
  'sourceful/riverflow-v2-fast':                    { modalities: ['image'] },
  'sourceful/riverflow-v2-pro':                     { modalities: ['image'] },
  'bytedance-seed/seedream-4.5':                    { modalities: ['image'] },
};
const DEFAULT_IMAGE_MODEL = 'google/gemini-3.1-flash-image-preview-20260226';

function getModalities(model) {
  return IMAGE_MODELS[model]?.modalities || (model.startsWith('google/') ? ['image', 'text'] : ['image']);
}

// ── Response parsing — three formats per SLAVATOOL handover ──────────────────
function extractImageUrl(data) {
  // Format 1: images[] array with image_url.url (dedicated image models)
  const imgObj = data.choices?.[0]?.message?.images?.[0];
  if (imgObj?.image_url?.url) return imgObj.image_url.url;
  // Also handle bare string in images array
  if (typeof imgObj === 'string' && imgObj.startsWith('data:')) return imgObj;

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

// ── Prompt building (step 1 — uses free/cheap text model) ────────────────────
async function craftImagePrompt(articleTitle, articleExcerpt, platform) {
  const instruction = `You are an expert at writing image generation prompts for medical/clinical content.

Content topic: ${articleTitle}
Context: ${articleExcerpt.slice(0, 400)}
Image type: ${platform} hero image
Base style: professional clinical review hero image, medical/scientific aesthetic

CRITICAL COMPOSITION RULE: All visual elements, objects, and focal points MUST be positioned on the RIGHT SIDE of the image. The LEFT SIDE must be clean, minimal, or softly blurred — this area will have text overlaid on top of it. Think of it as a 60/40 split: left 40% is empty/subtle gradient, right 60% has the visual content.

CRITICAL NO-TEXT RULE: The generated image must contain ABSOLUTELY NO text, words, letters, numbers, labels, captions, watermarks, logos, or any form of written characters. This is non-negotiable. The prompt you write must explicitly state "no text" and must not describe any text elements.

Write a single, detailed image generation prompt (max 80 words).
Include: visual style, right-weighted composition, colours (navy and teal brand palette), mood, lighting.
End the prompt with: "Absolutely no text, words, letters, or typography anywhere in the image."
Return ONLY the prompt, nothing else.`;

  const res = await fetch(OPENROUTER_BASE, {
    method: 'POST',
    headers: {
      ...OR_HEADERS,
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-3.3-70b-instruct:free',
      messages: [{ role: 'user', content: instruction }],
    }),
  });
  if (!res.ok) {
    // Non-fatal: fall back to a simple prompt
    return `Professional clinical medical illustration about ${articleTitle}, visual elements positioned on right side of image, left side clean minimal gradient, navy and teal colour palette, modern composition`;
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim()
    || `Professional clinical medical illustration about ${articleTitle}, visual elements positioned on right side of image, left side clean minimal gradient, navy and teal colour palette, modern composition`;
}

// ── Image generation (step 2 — paid model) ───────────────────────────────────

/**
 * Build a hero image prompt directly from the article title — no LLM call.
 * Used by the automation runner where every second counts against the 60s timeout.
 */
function buildDirectHeroPrompt(articleTitle) {
  const topic = (articleTitle || 'clinical research').replace(/^Clinical Review:?\s*/i, '').slice(0, 120);
  return `Professional editorial hero image for a clinical medical article about: ${topic}. ` +
    `Right-weighted composition: all visual elements (medical imagery, abstract scientific elements, soft patterns) on the RIGHT 60% of the frame; ` +
    `LEFT 40% kept clean with a subtle navy-to-teal gradient for text overlay. ` +
    `Style: clean modern medical/scientific aesthetic, professional photography or soft medical illustration, ` +
    `navy (#0a1929) and teal (#00c9a7) brand palette, soft natural lighting, calm authoritative mood, no people's faces, ` +
    `widescreen 16:9 cinematic. Absolutely no text, words, letters, numbers, labels, captions, watermarks, logos, or typography anywhere in the image.`;
}

/**
 * Fast-path image generation with NO prompt-building LLM call.
 * Use this in automation/cron contexts where the 60s function timeout is tight.
 */
export async function generateImageFast(articleTitle, aspectRatio = '16:9') {
  const prompt = buildDirectHeroPrompt(articleTitle);
  const model = DEFAULT_IMAGE_MODEL;

  const res = await fetch(OPENROUTER_BASE, {
    method: 'POST',
    headers: { ...OR_HEADERS, 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      modalities: getModalities(model),
      image_config: { aspect_ratio: aspectRatio },
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || '';
    if (res.status === 429) throw new Error(`Image rate limit: ${msg}`);
    if (res.status === 401 || res.status === 403) throw new Error('Image API key invalid');
    if (res.status === 402) throw new Error('OpenRouter credits exhausted');
    throw new Error(`Image generation error ${res.status}: ${msg}`);
  }

  const data = await res.json();
  const imageUrl = extractImageUrl(data);
  if (!imageUrl) {
    // Surface the message structure so we can see exactly what came back
    const msgDump = JSON.stringify(data?.choices?.[0]?.message ?? data).slice(0, 600);
    const finishReason = data?.choices?.[0]?.finish_reason || 'unknown';
    throw new Error(`No image in response (model=${model}, finish=${finishReason}): ${msgDump}`);
  }

  return { url: imageUrl, model, prompt, aspectRatio };
}

/**
 * Generate a static image for a platform or hero use (two-step pipeline with prompt crafting).
 * @param {string} articleTitle
 * @param {string} articleExcerpt
 * @param {string} platform - 'instagram'|'tiktok'|'linkedin'|'facebook'|'hero'
 * @param {string} aspectRatio - '4:5'|'1:1'|'16:9'|'9:16'
 * @returns {{ url: string, model: string, prompt: string, aspectRatio: string }}
 */
export async function generateImage(articleTitle, articleExcerpt, platform, aspectRatio) {
  const rawPrompt = await craftImagePrompt(articleTitle, articleExcerpt, platform);
  // Enforce no-text rule directly on the image model prompt as a hard suffix
  const prompt = rawPrompt.replace(/\.?\s*$/, '') + '. Absolutely no text, words, letters, numbers, or typography anywhere in the image.';

  // Choose model: Gemini for general use, Riverflow for text-heavy professional platforms
  const model = ['linkedin', 'facebook'].includes(platform)
    ? 'sourceful/riverflow-v2-fast'
    : DEFAULT_IMAGE_MODEL;

  const res = await fetch(OPENROUTER_BASE, {
    method: 'POST',
    headers: {
      ...OR_HEADERS,
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      modalities: getModalities(model),
      image_config: { aspect_ratio: aspectRatio },
    }),
  });

  // Handle API errors explicitly
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || '';
    if (res.status === 429) throw new Error(`Image rate limit: ${msg}`);
    if (res.status === 401 || res.status === 403) throw new Error('Image API key invalid');
    if (res.status === 402) throw new Error('OpenRouter credits exhausted — add credits at openrouter.ai');
    throw new Error(`Image generation error ${res.status}: ${msg}`);
  }

  const data = await res.json();
  const imageUrl = extractImageUrl(data);
  if (!imageUrl) throw new Error(`No image in response (model=${model}, platform=${platform}): ${JSON.stringify(data).slice(0, 300)}`);

  return { url: imageUrl, model, prompt, aspectRatio };
}

/**
 * Start a FAL.ai video generation job. Returns the request_id for polling.
 * Caller is responsible for polling getVideoStatus().
 */
export async function startVideoGeneration(reelScript, articleTitle) {
  const instruction = `Write a visual scene description (max 100 words) for a 10-second social media video based on this script:
HOOK: ${reelScript.hook}
BODY: ${reelScript.body}
CTA: ${reelScript.cta}
Topic: ${articleTitle}
Style: professional, clean, medical/health aesthetic, navy and teal colour palette.
Output ONLY the scene description.`;

  const promptRes = await fetch(OPENROUTER_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://vance-content-generator.vercel.app',
      'X-Title': 'Vance Content Generator',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-chat-v3-0324:free',
      messages: [{ role: 'user', content: instruction }],
    }),
  });
  const promptData = await promptRes.json();
  const videoPrompt = promptData.choices?.[0]?.message?.content?.trim() || `Professional medical video about ${articleTitle}`;

  const res = await fetch(FAL_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Key ${process.env.FAL_KEY}`,
    },
    body: JSON.stringify({
      prompt: videoPrompt,
      duration: '10',
      aspect_ratio: '9:16',
    }),
  });

  const data = await res.json();
  if (!data.request_id) throw new Error(`FAL.ai job start failed: ${JSON.stringify(data)}`);

  return { requestId: data.request_id, prompt: videoPrompt };
}

/**
 * Poll FAL.ai for a video job result.
 * @returns {{ status: 'COMPLETED'|'IN_PROGRESS'|'FAILED', url?: string }}
 */
export async function getVideoStatus(requestId) {
  const res = await fetch(`${FAL_STATUS_BASE}/${requestId}`, {
    headers: { 'Authorization': `Key ${process.env.FAL_KEY}` },
  });
  const data = await res.json();

  if (data.status === 'COMPLETED') {
    return { status: 'COMPLETED', url: data.output?.video?.url };
  }
  if (data.status === 'FAILED') {
    return { status: 'FAILED', error: data.error };
  }
  return { status: 'IN_PROGRESS' };
}

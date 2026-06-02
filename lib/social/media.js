const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';
const FAL_BASE = 'https://fal.run/fal-ai/kling-video/v2.1/standard/text-to-video';
const FAL_STATUS_BASE = 'https://fal.run/fal-ai/kling-video/v2.1/standard/text-to-video/requests';

const OR_HEADERS = {
  'Content-Type': 'application/json',
  'HTTP-Referer': 'https://vance-content-generator.vercel.app',
  'X-Title': 'Vance Content Generator',
};

// ── Image model config ───────────────────────────────────────────────────────
// Models are env-driven so brand forks can swap without code edits.
//   SOCIAL_IMAGE_MODELS = comma-separated slugs, primary first, fallbacks after.
// Defaults verified against OpenRouter /api/v1/models on 2026-05-15.
// Gemini requires ['image','text']; everything else gets ['image'] inferred.
const IMAGE_MODEL_CHAIN = (process.env.SOCIAL_IMAGE_MODELS
  || 'google/gemini-3.1-flash-image-preview,openai/gpt-5.4-image-2'
).split(',').map(s => s.trim()).filter(Boolean);

const DEFAULT_IMAGE_MODEL  = IMAGE_MODEL_CHAIN[0];
const FALLBACK_IMAGE_MODEL = IMAGE_MODEL_CHAIN[1] || IMAGE_MODEL_CHAIN[0];

function getModalities(model) {
  return model.startsWith('google/') ? ['image', 'text'] : ['image'];
}

// ── Image generation with primary → fallback chain ──────────────────────────
async function callImageModel(model, prompt, aspectRatio) {
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
    const e = new Error(`Image error ${res.status}: ${msg}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  const imageUrl = extractImageUrl(data);
  if (!imageUrl) {
    const finishReason = data?.choices?.[0]?.finish_reason || 'unknown';
    const e = new Error(`No image in response (model=${model}, finish=${finishReason})`);
    e.status = 502;
    throw e;
  }
  return imageUrl;
}

async function generateWithFallback(prompt, aspectRatio) {
  let lastErr;
  for (const model of IMAGE_MODEL_CHAIN) {
    try {
      const url = await callImageModel(model, prompt, aspectRatio);
      return { url, model };
    } catch (err) {
      lastErr = err;
      // Don't fall through on auth/credit errors — those affect both models
      if (err.status === 401 || err.status === 403) throw new Error('Image API key invalid');
      if (err.status === 402) throw new Error('OpenRouter credits exhausted — add credits at openrouter.ai');
    }
  }
  throw lastErr || new Error('All image models failed');
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

CRITICAL NO-MOLECULE RULE: The image must contain NO molecular structures, chemical diagrams, atoms, molecules, DNA double-helices, ball-and-stick models, periodic-table elements, or any "science cliché" molecule imagery. Do NOT describe molecules in the prompt. Use real clinical, anatomical, patient-environment, or abstract editorial imagery instead.

Write a single, detailed image generation prompt (max 80 words).
Include: visual style, right-weighted composition, colours (navy and teal brand palette), mood, lighting.
End the prompt with: "Absolutely no text, words, letters, or typography anywhere in the image. No molecules or chemical structures."
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
    return `Professional clinical medical illustration about ${articleTitle}, visual elements positioned on right side of image, left side clean minimal gradient, navy and teal colour palette, modern composition, no molecules or chemical structures, no text`;
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim()
    || `Professional clinical medical illustration about ${articleTitle}, visual elements positioned on right side of image, left side clean minimal gradient, navy and teal colour palette, modern composition, no molecules or chemical structures, no text`;
}

// ── Image generation (step 2 — paid model) ───────────────────────────────────

/**
 * Build a hero image prompt directly from the article title — no LLM call.
 * Used by the automation runner to skip the prompt-building round-trip
 * when a generic, deterministic prompt is sufficient.
 */
function buildDirectHeroPrompt(articleTitle) {
  const topic = (articleTitle || 'clinical research').replace(/^Clinical Review:?\s*/i, '').slice(0, 120);
  return `Professional editorial hero image for a clinical medical article about: ${topic}. ` +
    `Right-weighted composition: all visual elements (medical imagery, abstract scientific elements, soft patterns) on the RIGHT 60% of the frame; ` +
    `LEFT 40% kept clean with a subtle navy-to-teal gradient for text overlay. ` +
    `Style: clean modern medical/scientific aesthetic, professional photography or soft medical illustration, ` +
    `navy (#0a1929) and teal (#00c9a7) brand palette, soft natural lighting, calm authoritative mood, no people's faces, ` +
    `widescreen 16:9 cinematic. ` +
    `STRICTLY NO molecular imagery, chemical structures, atoms, molecules, DNA helices, ball-and-stick models, lab-glassware close-ups, or any cliché "science-y" molecule illustrations — use real clinical, anatomical, or human-environment imagery instead. ` +
    `Absolutely no text, words, letters, numbers, labels, captions, watermarks, logos, or typography anywhere in the image.`;
}

/**
 * Fast-path image generation with NO prompt-building LLM call.
 * Use this in automation/cron contexts where a deterministic prompt is fine
 * and the LLM round-trip would be wasted.
 */
export async function generateImageFast(articleTitle, aspectRatio = '16:9') {
  const prompt = buildDirectHeroPrompt(articleTitle);
  const { url, model } = await generateWithFallback(prompt, aspectRatio);
  return { url, model, prompt, aspectRatio };
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
  // Enforce no-text + no-molecule rules directly on the image model prompt as a hard suffix
  const prompt = rawPrompt.replace(/\.?\s*$/, '') + '. Absolutely no text, words, letters, numbers, or typography anywhere in the image. STRICTLY no molecular structures, atoms, molecules, DNA helices, ball-and-stick models, or chemistry imagery — use clinical, anatomical, or human-environment imagery instead.';

  const { url, model } = await generateWithFallback(prompt, aspectRatio);
  return { url, model, prompt, aspectRatio };
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

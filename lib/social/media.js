const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';

// ── Video model config ───────────────────────────────────────────────────────
// The fal.ai text-to-video model is env-driven so cheaper models can be A/B'd
// without a code edit (mirrors SOCIAL_IMAGE_MODELS for images). Default is the
// long-standing Kling v2.1 standard endpoint — leaving SOCIAL_VIDEO_MODEL unset
// keeps behaviour byte-identical to before this was parameterised.
//
// Cheaper fal alternatives to try via SOCIAL_VIDEO_MODEL (verify each model's
// param schema on first run — duration/aspect handling differs per model):
//   fal-ai/minimax/hailuo-02/standard/text-to-video   (budget; duration '6'|'10')
//   fal-ai/veo3/fast                                   (Google Veo 3 fast; ~8s, with audio)
//   fal-ai/wan/v2.2-5b/text-to-video                   (mid-tier)
// Per-model param quirks live in VIDEO_PARAMS below; unknown models fall back to
// the Kling-style { duration:'10', aspect_ratio:'9:16' } shape.
const DEFAULT_VIDEO_MODEL = 'fal-ai/kling-video/v2.1/standard/text-to-video';
const VIDEO_MODEL = (process.env.SOCIAL_VIDEO_MODEL || DEFAULT_VIDEO_MODEL).replace(/^\/+|\/+$/g, '');
const FAL_BASE = `https://fal.run/${VIDEO_MODEL}`;
const FAL_STATUS_BASE = `https://fal.run/${VIDEO_MODEL}/requests`;

// Per-model request params. Default (and any unlisted model) uses Kling's shape.
const VIDEO_PARAMS = {
  'fal-ai/kling-video/v2.1/standard/text-to-video': { duration: '10', aspect_ratio: '9:16' },
  'fal-ai/minimax/hailuo-02/standard/text-to-video': { duration: '10' }, // Hailuo-02 has no aspect_ratio param
  'fal-ai/veo3/fast': { aspect_ratio: '9:16' },                          // Veo 3 fast is fixed ~8s, no duration param
};
function videoParamsFor(model) {
  return VIDEO_PARAMS[model] || { duration: '10', aspect_ratio: '9:16' };
}

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
 * The Vance-shipped default hero image prompt template. The `{topic}` token is
 * replaced with the article subject at generation time. Editable per-category
 * via the LLM page / category editor (KV: vance:hero-prompts) — this is only the
 * fallback used when nothing is configured.
 */
export const DEFAULT_HERO_PROMPT_TEMPLATE =
  `Professional editorial hero image for a clinical medical article about: {topic}. ` +
  `Right-weighted composition: all visual elements (medical imagery, abstract scientific elements, soft patterns) on the RIGHT 60% of the frame; ` +
  `LEFT 40% kept clean with a subtle navy-to-teal gradient for text overlay. ` +
  `Style: clean modern medical/scientific aesthetic, professional photography or soft medical illustration, ` +
  `navy (#0a1929) and teal (#00c9a7) brand palette, soft natural lighting, calm authoritative mood, no people's faces, ` +
  `widescreen 16:9 cinematic. ` +
  `STRICTLY NO molecular imagery, chemical structures, atoms, molecules, DNA helices, ball-and-stick models, lab-glassware close-ups, or any cliché "science-y" molecule illustrations — use real clinical, anatomical, or human-environment imagery instead. ` +
  `Absolutely no text, words, letters, numbers, labels, captions, watermarks, logos, or typography anywhere in the image.`;

/**
 * Build a hero image prompt directly from the article title — no LLM call.
 * Used by the automation runner to skip the prompt-building round-trip.
 * An optional `template` (the category's configured prompt) overrides the
 * default; `{topic}` / `{title}` tokens are substituted, and if the template
 * carries no token the article subject is appended so the image still tracks
 * the content.
 */
function buildDirectHeroPrompt(articleTitle, template) {
  const topic = (articleTitle || 'clinical research').replace(/^Clinical Review:?\s*/i, '').slice(0, 120);
  const chosen = (typeof template === 'string' && template.trim()) ? template.trim() : DEFAULT_HERO_PROMPT_TEMPLATE;
  const hasToken = /\{topic\}|\{title\}/i.test(chosen);
  const filled = chosen
    .replace(/\{topic\}/gi, topic)
    .replace(/\{title\}/gi, (articleTitle || topic));
  return hasToken ? filled : `${filled} (Subject: ${topic}.)`;
}

/**
 * Fast-path image generation with NO prompt-building LLM call.
 * Use this in automation/cron contexts where a deterministic prompt is fine
 * and the LLM round-trip would be wasted. Pass `template` to apply a
 * category-specific hero prompt.
 */
export async function generateImageFast(articleTitle, aspectRatio = '16:9', template) {
  const prompt = buildDirectHeroPrompt(articleTitle, template);
  const { url, model } = await generateWithFallback(prompt, aspectRatio);
  return { url, model, prompt, aspectRatio };
}

// ── Stock photo hero (Pexels) ────────────────────────────────────────────────
// Used when a category's hero source is set to "Stock Photo" instead of AI.
// Mirrors the manual generator's Auto-Search behaviour on the server. The client
// uses this same key inline; the server prefers a PEXELS_API_KEY env override.
// Exported so handlers/stock.js resolves the same key rather than carrying a
// second copy of it — a duplicated credential is one that gets rotated in one
// place and quietly keeps working in the other until it does not.
export const PEXELS_API_KEY = process.env.PEXELS_API_KEY || '61644jNcCg5JfspIckM3rGG4lDwaNuUVmbIXCjbxYZDeqGiaNBftxKdJ';

const HERO_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'have', 'been', 'will', 'are',
  'was', 'were', 'their', 'its', 'not', 'but', 'more', 'also', 'such', 'each', 'than',
  'into', 'over', 'about', 'after', 'before', 'between', 'through', 'during', 'which',
  'when', 'where', 'would', 'could', 'should', 'study', 'review', 'clinical', 'using',
  'used', 'based', 'patients', 'patient', 'treatment', 'analysis', 'data', 'versus',
  'effect', 'effects', 'role',
]);

// Category / section prefixes that shouldn't appear in an image search.
const HERO_TITLE_PREFIX_RE = /^\s*(clinical review|case study|white ?paper|op-?ed|opinion|editorial|review|infographic|report)\s*[:\-–—]\s*/i;

// Clean an article title into a Pexels-friendly search phrase: drop the category
// prefix, strip quotes/punctuation that hurt matching, collapse whitespace.
function cleanTitleForSearch(articleTitle) {
  return (articleTitle || '')
    .replace(HERO_TITLE_PREFIX_RE, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// Ordered list of Pexels queries for a title. The article title itself is the
// primary query; each subsequent entry broadens it so automation never ends up
// with no hero image (long/niche titles can return zero Pexels results).
function heroStockQueries(articleTitle) {
  const title = cleanTitleForSearch(articleTitle);
  const words = title.split(' ').filter(Boolean);
  const queries = [];
  if (title) queries.push(title);                                    // 1. full article title
  if (words.length > 6) queries.push(words.slice(0, 6).join(' '));   // 2. first 6 words of title
  const kws = words.filter(w => w.length > 4 && !HERO_STOPWORDS.has(w.toLowerCase())).slice(0, 4);
  if (kws.length) queries.push(kws.join(' '));                       // 3. significant keywords
  queries.push('healthcare medicine clinical');                      // 4. generic safety net
  const seen = new Set();
  return queries.filter(q => { const k = q.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Unsplash access key (used when the configured stock provider is Unsplash).
// Prefer a per-request key (from KV settings) passed by the caller; fall back
// to an env var so automation works without the UI round-trip.
const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY || '';

// One Pexels search → the top landscape photo (normalised) or null.
async function pexelsSearchTop(query) {
  const resp = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=9&orientation=landscape`,
    { headers: { Authorization: PEXELS_API_KEY } }
  );
  if (!resp.ok) throw new Error(`Pexels ${resp.status}`);
  const data = await resp.json();
  const photo = data && Array.isArray(data.photos) ? data.photos[0] : null;
  if (!photo) return null;
  const url = photo.src && (photo.src.large2x || photo.src.large || photo.src.original);
  return url ? { url, photographer: photo.photographer || null, photographerUrl: photo.photographer_url || null, sourceUrl: photo.url || null } : null;
}

// One Unsplash search → the top landscape photo (normalised) or null. Honours
// the Unsplash API guideline of pinging the download endpoint on use.
async function unsplashSearchTop(query, key) {
  const accessKey = key || UNSPLASH_ACCESS_KEY;
  if (!accessKey) throw new Error('Unsplash access key not configured');
  const resp = await fetch(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=9&orientation=landscape&client_id=${encodeURIComponent(accessKey)}`
  );
  if (!resp.ok) throw new Error(`Unsplash ${resp.status}`);
  const data = await resp.json();
  const photo = data && Array.isArray(data.results) ? data.results[0] : null;
  if (!photo) return null;
  const url = photo.urls && (photo.urls.regular || photo.urls.full || photo.urls.raw);
  if (!url) return null;
  const dl = photo.links && photo.links.download_location;
  if (dl) {
    fetch(dl + (dl.includes('?') ? '&' : '?') + 'client_id=' + encodeURIComponent(accessKey)).catch(() => {});
  }
  return {
    url,
    photographer: (photo.user && photo.user.name) || null,
    photographerUrl: (photo.user && photo.user.links && photo.user.links.html) || null,
    sourceUrl: (photo.links && photo.links.html) || null,
  };
}

/**
 * Fetch a landscape stock photo for the article hero — no AI, no LLM round-trip.
 * Searches by the article title first, broadening only if a query returns
 * nothing. `opts.provider` selects 'pexels' (default) or 'unsplash';
 * `opts.unsplashKey` supplies the Unsplash access key when relevant.
 * If Unsplash exhausts every query (e.g. the 50 req/hr demo-tier cap, or a
 * bad key), falls back to Pexels rather than leaving the article with no
 * hero image — Pexels uses its own built-in key so it's unaffected by the
 * shared Unsplash budget.
 * Returns { url, photographer, sourceUrl, query, provider } or throws.
 */
export async function generateHeroStockImage(articleTitle, opts = {}) {
  const provider = opts.provider === 'unsplash' ? 'unsplash' : 'pexels';
  const queries = heroStockQueries(articleTitle);
  let lastErr = null;
  for (const query of queries) {
    try {
      const hit = provider === 'unsplash'
        ? await unsplashSearchTop(query, opts.unsplashKey)
        : await pexelsSearchTop(query);
      if (hit && hit.url) return { ...hit, query, provider };
      lastErr = new Error(`no ${provider} results for "${query}"`);
    } catch (e) { lastErr = e; }
  }
  if (provider === 'unsplash') {
    for (const query of queries) {
      try {
        const hit = await pexelsSearchTop(query);
        if (hit && hit.url) return { ...hit, query, provider: 'pexels', fallbackFrom: 'unsplash' };
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr || new Error(`${provider} search failed`);
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
      ...videoParamsFor(VIDEO_MODEL),
    }),
  });

  const data = await res.json();
  if (!data.request_id) throw new Error(`FAL.ai job start failed (model=${VIDEO_MODEL}): ${JSON.stringify(data)}`);

  return { requestId: data.request_id, prompt: videoPrompt, model: VIDEO_MODEL };
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

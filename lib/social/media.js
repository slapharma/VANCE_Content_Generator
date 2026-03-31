const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';
const FAL_BASE = 'https://fal.run/fal-ai/kling-video/v2.1/standard/text-to-video';
const FAL_STATUS_BASE = 'https://fal.run/fal-ai/kling-video/v2.1/standard/text-to-video/requests';

// Use free model to write a good visual prompt before calling the paid image model
async function craftImagePrompt(articleTitle, articleExcerpt, platform) {
  const instruction = `Write a detailed image generation prompt (max 120 words) for a ${platform} social post about: "${articleTitle}".
Context: ${articleExcerpt.slice(0, 400)}
Style: clean, modern, medical/clinical aesthetic, IBD Health Hub brand (navy and teal), professional photography or medical illustration style.
Output ONLY the image prompt — no preamble, no explanation.`;

  const res = await fetch(OPENROUTER_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://ibdhealthhub-content-generator.vercel.app',
      'X-Title': 'IBD Health Hub Content Generator',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-chat-v3-0324:free',
      messages: [{ role: 'user', content: instruction }],
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || `Clinical medical illustration for ${articleTitle}`;
}

/**
 * Generate a static image for a platform.
 * @param {string} articleTitle
 * @param {string} articleExcerpt
 * @param {string} platform - 'instagram'|'tiktok'|'linkedin'|'facebook'
 * @param {string} aspectRatio - '4:5'|'1:1'
 * @returns {{ url: string, model: string, prompt: string, aspectRatio: string }}
 */
export async function generateImage(articleTitle, articleExcerpt, platform, aspectRatio) {
  const prompt = await craftImagePrompt(articleTitle, articleExcerpt, platform);

  // Choose model by platform
  const model = ['linkedin', 'facebook'].includes(platform)
    ? 'sourceful/riverflow-v2-fast'   // better text rendering for professional platforms
    : 'google/gemini-2.5-flash-image'; // fast, good for social

  const res = await fetch(OPENROUTER_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://ibdhealthhub-content-generator.vercel.app',
      'X-Title': 'IBD Health Hub Content Generator',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      modalities: ['image'],
      image_config: { aspect_ratio: aspectRatio },
    }),
  });

  const data = await res.json();
  const imageBase64 = data.choices?.[0]?.message?.images?.[0];
  if (!imageBase64) throw new Error(`Image generation failed for ${platform}: ${JSON.stringify(data)}`);

  return { url: imageBase64, model, prompt, aspectRatio };
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
      'HTTP-Referer': 'https://ibdhealthhub-content-generator.vercel.app',
      'X-Title': 'IBD Health Hub Content Generator',
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

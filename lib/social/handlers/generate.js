// lib/social/handlers/generate.js
import { kv } from '../../kv.js';
import { buildPlatformPrompt, pickArchetype, PLATFORM_CONFIGS } from '../ava-prompts.js';
import { generateImage, startVideoGeneration } from '../media.js';
import { autoSchedule } from '../scheduler.js';

// callLLM with fallback: try free model first, fall back to paid on 429
const PAID_FALLBACKS = [
  'google/gemma-3-27b-it',
  'google/gemma-3-12b-it',
  'meta-llama/llama-3.3-70b-instruct',
];

function isRateLimited(data) {
  const code = data.error?.code;
  const msg = (data.error?.message || '').toLowerCase();
  return code === 429 || msg.includes('rate-limit') || msg.includes('rate limit');
}

async function callOpenRouter(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const primaryModel = process.env.DEFAULT_LLM_MODEL || 'google/gemma-3-27b-it:free';

  // Build fallback chain: primary → paid equivalent → paid fallbacks
  const chain = [primaryModel];
  if (primaryModel.endsWith(':free')) chain.push(primaryModel.replace(/:free$/, ''));
  for (const m of PAID_FALLBACKS) { if (!chain.includes(m)) chain.push(m); }

  let lastError = null;
  for (const model of chain) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://vance-content-generator.vercel.app',
        'X-Title': 'Vance Content Generator',
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (text) return text.trim();

    if (isRateLimited(data)) { lastError = `${model}: rate-limited`; continue; }
    throw new Error(`LLM call failed: ${JSON.stringify(data).slice(0, 300)}`);
  }
  throw new Error(`All models rate-limited: ${lastError}`);
}

// Parse the dual-output format for Instagram/TikTok: caption ---SCRIPT--- reelScript
function parseCaptionAndScript(raw) {
  const [captionPart, scriptPart] = raw.split('---SCRIPT---');
  const caption = captionPart ? captionPart.trim() : raw;

  let reelScript = null;
  if (scriptPart) {
    const hookMatch = scriptPart.match(/HOOK:\s*(.+?)(?=\nBODY:|$)/s);
    const bodyMatch = scriptPart.match(/BODY:\s*(.+?)(?=\nCTA:|$)/s);
    const ctaMatch = scriptPart.match(/CTA:\s*(.+?)(?=\nDURATION:|$)/s);
    const durMatch = scriptPart.match(/DURATION:\s*(.+)/);
    reelScript = {
      hook: hookMatch?.[1]?.trim() || '',
      body: bodyMatch?.[1]?.trim() || '',
      cta: ctaMatch?.[1]?.trim() || '',
      durationEst: parseInt(durMatch?.[1]) || 30,
    };
  }

  // Extract hashtags from caption
  const hashtags = (caption.match(/#\w+/g) || []);
  const captionWithoutHashtags = caption.replace(/#\w+/g, '').trim();

  return { caption: captionWithoutHashtags, hashtags, reelScript };
}

// Parse Twitter thread format: TWEET 1: ... TWEET 2: ... TWEET 3: ...
function parseTwitterThread(raw) {
  const tweets = [];
  const lines = raw.split('\n');
  let current = '';
  for (const line of lines) {
    if (/^TWEET \d+:/i.test(line)) {
      if (current.trim()) tweets.push(current.trim());
      current = line.replace(/^TWEET \d+:\s*/i, '');
    } else {
      current += ' ' + line;
    }
  }
  if (current.trim()) tweets.push(current.trim());
  return tweets.slice(0, 3); // max 3
}

const PLATFORM_ORDER = ['instagram', 'tiktok', 'linkedin', 'twitter', 'facebook', 'substack'];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { articleId, pillar, ctaGoal, mediaOnly, kitId: existingKitId, mediaPlatform, mediaType } = req.body || {};

  // ── Media-only regeneration path ──────────────────────────────────────────
  // Called by regenKitMedia() on the frontend when user clicks "Regen" on a media tile.
  // Skips LLM entirely — loads existing kit and regenerates only the specified media.
  if (mediaOnly && existingKitId && mediaPlatform && mediaType) {
    try {
      const kit = await kv.get(`social:kit:${existingKitId}`);
      if (!kit) return res.status(404).json({ error: 'Kit not found' });

      const article = await kv.get(`content:${kit.articleId}`);
      const articleTitle = article?.title || kit.articleTitle || 'Clinical Update';
      const articleExcerpt = (article?.body || article?.content || '')
        .replace(/<[^>]+>/g, '').slice(0, 1500);

      const cfg = PLATFORM_CONFIGS[mediaPlatform] || {};
      let mediaPatch = {};

      if (mediaType === 'image' && cfg.imageAspect) {
        const imageData = await generateImage(articleTitle, articleExcerpt, mediaPlatform, cfg.imageAspect);
        mediaPatch = { image: imageData };
      } else if (mediaType === 'video') {
        const reelScript = kit.platforms[mediaPlatform]?.reelScript;
        if (!reelScript) return res.status(400).json({ error: 'No reel script to base video on' });
        const { requestId, prompt } = await startVideoGeneration(reelScript, articleTitle);
        mediaPatch = { video: { requestId, prompt, url: null, model: 'kling-v2.1', durationSec: 10 } };
      } else {
        return res.status(400).json({ error: `Cannot regenerate ${mediaType} for ${mediaPlatform}` });
      }

      kit.platforms[mediaPlatform] = { ...kit.platforms[mediaPlatform], ...mediaPatch };
      kit.updatedAt = new Date().toISOString();
      await kv.set(`social:kit:${existingKitId}`, kit);
      return res.status(200).json(kit);
    } catch (err) {
      console.error('[generate:mediaOnly] error:', err);
      return res.status(500).json({ error: err.message });
    }
  }
  // ── End media-only path ───────────────────────────────────────────────────

  if (!articleId || !pillar || !ctaGoal) {
    return res.status(400).json({ error: 'articleId, pillar, and ctaGoal are required' });
  }

  try {
    // 1. Fetch article from KV
    const article = await kv.get(`content:${articleId}`);
    if (!article) return res.status(404).json({ error: 'Article not found' });

    const articleTitle = article.title || 'Clinical Update';
    const articleExcerpt = (article.body || article.content || article.excerpt || '')
      .replace(/<[^>]+>/g, '').trim().slice(0, 1500);

    // 2. Assign hook archetypes — each platform gets a different one
    const archetypes = PLATFORM_ORDER.reduce((acc, platform, idx) => {
      acc[platform] = pickArchetype(idx);
      return acc;
    }, {});

    // 3. Generate all platform posts in parallel
    const kitId = `kit_${Date.now()}`;
    const platformResults = await Promise.allSettled(
      PLATFORM_ORDER.map(async (platform) => {
        const archetype = archetypes[platform];
        const prompt = buildPlatformPrompt(platform, pillar, ctaGoal, archetype, articleTitle, articleExcerpt);
        const raw = await callOpenRouter(prompt);

        if (platform === 'twitter') {
          return { platform, thread: parseTwitterThread(raw), hookArchetype: archetype.id };
        } else if (['instagram', 'tiktok'].includes(platform)) {
          const { caption, hashtags, reelScript } = parseCaptionAndScript(raw);
          return { platform, caption, hashtags, reelScript, hookArchetype: archetype.id };
        } else if (platform === 'substack') {
          return { platform, teaser: raw };
        } else {
          // linkedin, facebook
          const hashtags = (raw.match(/#\w+/g) || []);
          const caption = raw.replace(/#\w+/g, '').trim();
          return { platform, caption, hashtags, hookArchetype: archetype.id };
        }
      })
    );

    // Build platforms object from settled results
    const platforms = {};
    for (const result of platformResults) {
      if (result.status === 'fulfilled') {
        const { platform, ...data } = result.value;
        platforms[platform] = {
          ...data,
          approved: false,
          scheduledAt: null,
          postedAt: null,
          platformPostId: null,
          image: null,
          video: null,
        };
      }
    }

    // 4. Auto-schedule
    const scheduleMap = autoSchedule(PLATFORM_ORDER);
    for (const [platform, scheduledAt] of Object.entries(scheduleMap)) {
      if (platforms[platform]) platforms[platform].scheduledAt = scheduledAt;
    }

    // 5. Store initial kit (without media — media is generated below)
    const kit = {
      id: kitId,
      articleId,
      articleTitle,
      pillar,
      ctaGoal,
      status: 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      platforms,
    };

    await kv.set(`social:kit:${kitId}`, kit);
    await kv.set(`social:kits:by-article:${articleId}`, kitId);
    await kv.lpush('social:kits:index', kitId);

    // 6. Return kit immediately (media generation continues async-ish)
    res.status(200).json(kit);

    // 7. Generate images in parallel (fast — ~1-3s each)
    // NOTE: After res.json() the function continues but Vercel may freeze it.
    // Images are fast enough to usually complete. Video requestId is stored so
    // client can poll. If frozen before patching KV, client uses "Regen" button.
    const mediaPromises = [];
    const platformsNeedingImages = ['instagram', 'tiktok', 'linkedin', 'facebook'];
    for (const platform of platformsNeedingImages) {
      if (!platforms[platform]) continue;
      const cfg = PLATFORM_CONFIGS[platform];
      if (!cfg.imageAspect) continue;
      mediaPromises.push(
        generateImage(articleTitle, articleExcerpt, platform, cfg.imageAspect)
          .then(imageData => ({ type: 'image', platform, data: imageData }))
          .catch(err => ({ type: 'error', platform, err }))
      );
    }

    // Start video jobs for instagram and tiktok
    for (const platform of ['instagram', 'tiktok']) {
      if (!platforms[platform]?.reelScript) continue;
      mediaPromises.push(
        startVideoGeneration(platforms[platform].reelScript, articleTitle)
          .then(({ requestId, prompt }) => ({ type: 'video-started', platform, requestId, prompt }))
          .catch(err => ({ type: 'error', platform, err }))
      );
    }

    // Resolve images, update kit
    const mediaResults = await Promise.allSettled(mediaPromises);
    const platformPatch = {};
    for (const result of mediaResults) {
      if (result.status !== 'fulfilled') continue;
      const r = result.value;
      if (r.type === 'image') {
        platformPatch[r.platform] = { ...(platformPatch[r.platform] || {}), image: r.data };
      } else if (r.type === 'video-started') {
        // Store requestId in kit so client can poll for it
        platformPatch[r.platform] = {
          ...(platformPatch[r.platform] || {}),
          video: { requestId: r.requestId, prompt: r.prompt, url: null, model: 'kling-v2.1', durationSec: 10 },
        };
      }
    }

    if (Object.keys(platformPatch).length) {
      const updatedKit = await kv.get(`social:kit:${kitId}`);
      if (updatedKit) {
        for (const [platform, patch] of Object.entries(platformPatch)) {
          updatedKit.platforms[platform] = { ...updatedKit.platforms[platform], ...patch };
        }
        updatedKit.updatedAt = new Date().toISOString();
        await kv.set(`social:kit:${kitId}`, updatedKit);
      }
    }
  } catch (err) {
    console.error('[generate] error:', err);
    // Response already sent — can only log at this point
  }
}

// lib/social/handlers/generate.js
import { kv } from '../../kv.js';
import { buildPlatformPrompt, pickArchetype, PLATFORM_CONFIGS } from '../ava-prompts.js';
import { generateImage, startVideoGeneration } from '../media.js';
import { autoSchedule } from '../scheduler.js';
// A/B pick + free→paid fallback chain + usage accounting now live in ../llm.js,
// shared with the carousel generator.
import { callOpenRouter } from '../llm.js';

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

  const { articleId, pillar, ctaGoal, mediaOnly, kitId: existingKitId, mediaPlatform, mediaType, platforms: requestedPlatforms } = req.body || {};

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

    // 2. Assign hook archetypes — each platform gets a different one. Computed
    // over the full PLATFORM_ORDER (not the selection) so a given platform's
    // archetype doesn't shift depending on what else was picked.
    const archetypes = PLATFORM_ORDER.reduce((acc, platform, idx) => {
      acc[platform] = pickArchetype(idx);
      return acc;
    }, {});

    // 2b. Which platforms to actually generate. Intersect the request against
    // PLATFORM_ORDER so unknown values can't sneak through; fall back to all
    // six when the field is absent/empty so automation and older callers keep
    // their existing behaviour.
    const selectedSet = new Set(Array.isArray(requestedPlatforms) ? requestedPlatforms : []);
    const activePlatforms = selectedSet.size
      ? PLATFORM_ORDER.filter((p) => selectedSet.has(p))
      : PLATFORM_ORDER;

    // 3. Generate selected platform posts in parallel
    const kitId = `kit_${Date.now()}`;
    const platformResults = await Promise.allSettled(
      activePlatforms.map(async (platform) => {
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

    // 4. Auto-schedule — only over the platforms actually generated, so an
    // unselected platform doesn't reserve/skip a time slot for no reason.
    const scheduleMap = autoSchedule(activePlatforms);
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
    await kv.ltrim('social:kits:index', 0, 199); // cap like carousels' INDEX_CAP

    // 6. Generate images + start video jobs in parallel. We await everything
    // before responding so the client receives a complete kit (images embedded,
    // video requestIds ready for polling). The 300s function budget absorbs
    // the ~1-3s/image fan-out comfortably.
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

    for (const platform of ['instagram', 'tiktok']) {
      if (!platforms[platform]?.reelScript) continue;
      mediaPromises.push(
        startVideoGeneration(platforms[platform].reelScript, articleTitle)
          .then(({ requestId, prompt }) => ({ type: 'video-started', platform, requestId, prompt }))
          .catch(err => ({ type: 'error', platform, err }))
      );
    }

    const mediaResults = await Promise.allSettled(mediaPromises);
    const platformPatch = {};
    for (const result of mediaResults) {
      if (result.status !== 'fulfilled') continue;
      const r = result.value;
      if (r.type === 'image') {
        platformPatch[r.platform] = { ...(platformPatch[r.platform] || {}), image: r.data };
      } else if (r.type === 'video-started') {
        platformPatch[r.platform] = {
          ...(platformPatch[r.platform] || {}),
          video: { requestId: r.requestId, prompt: r.prompt, url: null, model: 'kling-v2.1', durationSec: 10 },
        };
      }
    }

    if (Object.keys(platformPatch).length) {
      for (const [platform, patch] of Object.entries(platformPatch)) {
        kit.platforms[platform] = { ...kit.platforms[platform], ...patch };
      }
      kit.updatedAt = new Date().toISOString();
      await kv.set(`social:kit:${kitId}`, kit);
    }

    return res.status(200).json(kit);
  } catch (err) {
    console.error('[generate] error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message || 'generation failed' });
    }
  }
}

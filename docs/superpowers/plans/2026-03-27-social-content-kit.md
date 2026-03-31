# Social Content Kit Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the IBD Health Hub Social Distribution tab using Ava's personal-brand-launch methodology — one article generates a full Content Kit (all 6 platforms, HOOK/BODY/CTA scripts, AI images via OpenRouter, 10s video via FAL.ai), reviewed and approved in the UI, then auto-scheduled and posted via real platform APIs.

**Architecture:** Single Vercel catch-all `api/social/[...slug].js` routes to handlers in `lib/social/handlers/`. Platform adapters in `lib/social/platforms/` each wrap one posting API. The UI in `index.html` replaces the existing social pane with a Kit Builder accordion + Queue + Posted sub-tabs. A 5-minute cron drains the KV sorted-set queue.

**Tech Stack:** Vercel KV (Redis), OpenRouter API (image gen), FAL.ai (video gen), Instagram Graph API, TikTok Content Posting API, LinkedIn Posts API, Twitter v2 API, Facebook Graph API. No build step — `index.html` is deployed directly via `vercel --prod --yes`.

**Spec:** `docs/superpowers/specs/2026-03-27-social-content-kit-design.md`

---

## Chunk 1: Foundation — Router, KV Schema, Ava Prompts, Scheduler, Kit CRUD

### Task 1: Create `lib/social/ava-prompts.js`

**Files:**
- Create: `lib/social/ava-prompts.js`

This module exports the Ava methodology building blocks used by `generate.js`. No external dependencies.

- [ ] **Step 1: Create the file with hook archetypes, CTA templates, pillar prompts, and platform tone configs**

```js
// lib/social/ava-prompts.js

export const HOOK_ARCHETYPES = [
  {
    id: 'curiosity_gap',
    label: 'Curiosity Gap',
    template: (topic) => `The one thing ${topic} isn't telling you…`,
  },
  {
    id: 'bold_claim',
    label: 'Bold Claim',
    template: (topic) => `You don't need [common assumption] to [desired result] — here's what actually works`,
  },
  {
    id: 'list_number',
    label: 'List/Number',
    template: (topic) => `3 things most clinicians miss about ${topic}`,
  },
  {
    id: 'relatability',
    label: 'Relatability',
    template: (topic) => `POV: You've just reviewed 40 patients and none hit their targets`,
  },
  {
    id: 'direct_callout',
    label: 'Direct Call-Out',
    template: (topic) => `If you're a clinician not sharing ${topic} updates, you're invisible online`,
  },
];

// Returns archetype for platform slot — cycles through 5 archetypes so each platform gets a different one
export function pickArchetype(platformIndex) {
  return HOOK_ARCHETYPES[platformIndex % HOOK_ARCHETYPES.length];
}

export const CTA_TEMPLATES = {
  grow:    'Follow @ibdhealthhub for weekly clinical insights',
  engage:  'Comment YES below if this changed how you think about this',
  convert: 'DM us or click the link in bio to learn more',
  save:    'Save this for later and share with a colleague who needs it',
};

export const PILLAR_INSTRUCTIONS = {
  educate:   'This content should build clinical authority. Lead with a surprising fact, data point, or insight that genuinely teaches something. Tone: expert but accessible.',
  entertain: 'This content should be relatable and human. Show the real experience of clinicians and patients. Tone: warm, honest, slightly vulnerable.',
  sell:      'This content should convert interest to action. Lead with a result or testimonial. Make the offer clear. Tone: confident, specific, outcome-focused.',
};

export const PLATFORM_CONFIGS = {
  instagram: {
    maxChars: 2200,
    hashtagCount: '5-8',
    tone: 'engaging, emojis welcome, hook must stop the scroll in under 3 seconds',
    generateReelScript: true,
    imageAspect: '4:5',
    videoAspect: '9:16',
  },
  tiktok: {
    maxChars: 300,
    hashtagCount: '3-5',
    tone: 'hook-first, casual, punchy — written for 18-35 year olds who care about health',
    generateReelScript: true,
    videoAspect: '9:16',
  },
  linkedin: {
    maxChars: 1300,
    hashtagCount: '3-5',
    tone: 'professional, data-backed insight lead, business outcome CTA — no emojis',
    generateReelScript: false,
    imageAspect: '1:1',
  },
  twitter: {
    maxChars: 280,
    hashtagCount: '1-2 per tweet',
    tone: 'concise, punchy, each tweet must stand alone AND chain as a thread',
    generateReelScript: false,
    threadLength: 3,
  },
  facebook: {
    maxChars: 2000,
    hashtagCount: '3-5',
    tone: 'conversational, shareable — end with a question to drive comments',
    generateReelScript: false,
    imageAspect: '1:1',
  },
  substack: {
    maxChars: 600,
    tone: 'newsletter teaser — compelling summary that makes readers want to click through',
    generateReelScript: false,
  },
};

// Build the full system prompt for a given platform + pillar + CTA + archetype
export function buildPlatformPrompt(platform, pillar, ctaGoal, archetype, articleTitle, articleExcerpt) {
  const cfg = PLATFORM_CONFIGS[platform];
  const pillarInstruction = PILLAR_INSTRUCTIONS[pillar];
  const ctaText = CTA_TEMPLATES[ctaGoal];
  const hookTemplate = archetype.template(articleTitle);

  const isThread = platform === 'twitter';
  const hasReelScript = cfg.generateReelScript;

  let prompt = `You are a social media expert applying the Ava personal brand methodology for IBD Health Hub, a UK clinical intelligence platform.

CONTENT PILLAR: ${pillar.toUpperCase()}
${pillarInstruction}

HOOK ARCHETYPE: ${archetype.label}
Hook inspiration (adapt, don't copy literally): "${hookTemplate}"

PLATFORM: ${platform} — Tone: ${cfg.tone}
Character limit: ${cfg.maxChars} chars${isThread ? ' per tweet' : ''}
Hashtags: ${cfg.hashtagCount} (clinical/medical niche — e.g. #IBD #Gastro #ClinicalUpdate)
CTA to use (adapt naturally): "${ctaText}"

ARTICLE TITLE: ${articleTitle}
ARTICLE EXCERPT:
${articleExcerpt}

`;

  if (isThread) {
    prompt += `OUTPUT FORMAT — write a thread of exactly 3 tweets. Format:
TWEET 1: [text — the hook, grabs attention]
TWEET 2: [text — the value, delivers the insight]
TWEET 3: [text — the CTA, one clear action]

Each tweet must be self-contained AND flow as a thread. No "1/3" numbering. Write only the tweet text — no labels, no preamble.`;
  } else if (hasReelScript) {
    prompt += `OUTPUT FORMAT — write two things separated by ---SCRIPT---:

1. CAPTION: The Instagram/TikTok caption with hashtags. Start with the hook. End with CTA. Max ${cfg.maxChars} chars.

---SCRIPT---

2. REEL SCRIPT: A short-form video script for filming. Format:
HOOK: [First 1-3 seconds. One punchy sentence that stops the scroll. Written to be spoken on camera.]
BODY: [20-25 seconds of value. Short sentences, max 10 words each. Stage directions in [brackets]. Numbered points work well. Conversational English — write how people talk, not how they write.]
CTA: [5 seconds. Single clear action. Spoken directly to camera.]
DURATION: [estimated seconds, e.g. "28s"]

Write ONLY the output in this format. No preamble, no "Here is your caption:".`;
  } else {
    prompt += `Write ONLY the post caption with hashtags. Start with the hook. End with the CTA naturally woven in. No preamble, no labels.`;
  }

  return prompt;
}
```

- [ ] **Step 2: Verify the file is syntactically valid (no build step — check manually)**

Open the file and confirm: no unclosed brackets, all exports are named, `buildPlatformPrompt` returns a string. Quick sanity check: the `pickArchetype(0)` call would return `curiosity_gap`, `pickArchetype(1)` returns `bold_claim`, etc.

- [ ] **Step 3: Commit**

```bash
git add lib/social/ava-prompts.js
git commit -m "feat(social): add ava-prompts — hook archetypes, CTA templates, platform configs"
```

---

### Task 2: Create `lib/social/scheduler.js`

**Files:**
- Create: `lib/social/scheduler.js`

Assigns `scheduledAt` times per platform based on Ava's optimal windows, distributed across the next 7 days avoiding already-used slots.

- [ ] **Step 1: Create the scheduler**

```js
// lib/social/scheduler.js

// Ava's optimal posting windows per platform (local time, expressed as UTC offsets are caller's responsibility)
// Times are in 24h format, 'HH:MM'
const OPTIMAL_SLOTS = {
  instagram: { days: [1, 3, 5], times: ['07:00', '12:00', '19:00'] },  // Mon, Wed, Fri
  tiktok:    { days: [2, 4, 6], times: ['07:00', '12:00', '19:00'] },  // Tue, Thu, Sat
  linkedin:  { days: [2, 3, 4], times: ['09:00', '12:00'] },           // Tue, Wed, Thu
  twitter:   { days: [1, 2, 3, 4, 5], times: ['08:00', '12:00', '17:00'] }, // Mon-Fri
  facebook:  { days: [1, 3, 5], times: ['09:00', '13:00'] },           // Mon, Wed, Fri
  substack:  null,                                                       // copy-only
};

/**
 * Given a list of platforms, assign the next available optimal slot for each,
 * starting from `fromDate` (defaults to now), looking up to 7 days ahead.
 * Returns a map of { platform: ISO8601 scheduledAt }.
 */
export function autoSchedule(platforms, fromDate = new Date()) {
  const result = {};
  const usedSlots = new Set(); // prevent two platforms from landing on exact same time

  for (const platform of platforms) {
    const config = OPTIMAL_SLOTS[platform];
    if (!config) {
      // No schedule for this platform (e.g. substack)
      result[platform] = null;
      continue;
    }

    const slot = findNextSlot(config, fromDate, usedSlots);
    if (slot) {
      result[platform] = slot.toISOString();
      usedSlots.add(slot.toISOString());
    } else {
      // Fallback: schedule 24h from now if no optimal slot found in window
      const fallback = new Date(fromDate.getTime() + 24 * 60 * 60 * 1000);
      result[platform] = fallback.toISOString();
    }
  }

  return result;
}

function findNextSlot(config, fromDate, usedSlots) {
  const { days, times } = config;

  // Look through the next 14 days (wider window to find non-conflicting slots)
  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const candidate = new Date(fromDate);
    candidate.setUTCDate(candidate.getUTCDate() + dayOffset);
    candidate.setUTCHours(0, 0, 0, 0);

    // getUTCDay(): 0=Sun, 1=Mon, ..., 6=Sat
    const dayOfWeek = candidate.getUTCDay() === 0 ? 7 : candidate.getUTCDay(); // convert Sun=0 to 7

    if (!days.includes(dayOfWeek)) continue;

    for (const time of times) {
      const [h, m] = time.split(':').map(Number);
      const slotDate = new Date(candidate);
      slotDate.setUTCHours(h, m, 0, 0);

      // Must be in the future
      if (slotDate <= fromDate) continue;

      // Must not conflict with already-scheduled slot
      if (usedSlots.has(slotDate.toISOString())) continue;

      return slotDate;
    }
  }

  return null;
}
```

- [ ] **Step 2: Trace through manually to verify correctness**

Mentally run: if `fromDate` is a Monday at 10:00 UTC, `instagram` (Mon/Wed/Fri) should get `Monday 12:00 UTC` (the next slot after 10:00 that day). `tiktok` (Tue/Thu/Sat) should get `Tuesday 07:00 UTC`. `linkedin` (Tue/Wed/Thu) should get `Tuesday 09:00 UTC`.

- [ ] **Step 3: Commit**

```bash
git add lib/social/scheduler.js
git commit -m "feat(social): add auto-scheduler — Ava optimal posting times across 7-day window"
```

---

### Task 3: Create `api/social/[...slug].js` — the catch-all router

**Files:**
- Create: `api/social/[...slug].js`

Follows the exact same pattern as `api/automation/[...slug].js`. The slug arrives as a slash-joined string (e.g. `'kits/abc123'`). Route table maps `method + path` to handler modules.

- [ ] **Step 1: Read the automation catch-all to confirm the routing pattern**

Use the Read tool:
```
Read: api/automation/[...slug].js  (first 40 lines)
```

Expected: you'll see `req.query['...slug']` and a `split('/')` call.

> **Note:** The router created in this task imports all 7 handler modules. The handlers for `generate`, `deploy`, `post`, `schedule`, and `cron` are not created until Chunks 2–3. The router is not fully functional until those chunks are complete — but it won't break at deploy time since Vercel only evaluates imports lazily in ES modules. Complete all tasks in order.

- [ ] **Step 2: Create the social catch-all router**

```js
// api/social/[...slug].js
import generateHandler from '../../lib/social/handlers/generate.js';
import kitsIndexHandler from '../../lib/social/handlers/kits-index.js';
import kitsIdHandler from '../../lib/social/handlers/kits-id.js';
import deployHandler from '../../lib/social/handlers/deploy.js';
import postHandler from '../../lib/social/handlers/post.js';
import scheduleHandler from '../../lib/social/handlers/schedule.js';
import cronHandler from '../../lib/social/handlers/cron.js';

export default async function handler(req, res) {
  const slugRaw = req.query['...slug'] || '';
  const parts = slugRaw.split('/').filter(Boolean);
  const [resource, id] = parts; // e.g. ['kits', 'kit_123'] or ['generate']

  try {
    // POST /social/generate
    if (req.method === 'POST' && resource === 'generate') {
      return await generateHandler(req, res);
    }

    // GET /social/kits
    if (req.method === 'GET' && resource === 'kits' && !id) {
      return await kitsIndexHandler(req, res);
    }

    // GET /social/kits/:id  |  PATCH /social/kits/:id
    if (resource === 'kits' && id) {
      return await kitsIdHandler(req, res, id);
    }

    // POST /social/deploy
    if (req.method === 'POST' && resource === 'deploy') {
      return await deployHandler(req, res);
    }

    // POST /social/post
    if (req.method === 'POST' && resource === 'post') {
      return await postHandler(req, res);
    }

    // GET /social/schedule
    if (req.method === 'GET' && resource === 'schedule') {
      return await scheduleHandler(req, res);
    }

    // POST /social/cron
    if (req.method === 'POST' && resource === 'cron') {
      return await cronHandler(req, res);
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (err) {
    console.error('[social] unhandled error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add "api/social/[...slug].js"
git commit -m "feat(social): add catch-all router — routes all /social/* paths to handlers"
```

---

### Task 4: Create kit CRUD handlers — `kits-index.js`, `kits-id.js`, and `schedule.js`

**Files:**
- Create: `lib/social/handlers/kits-index.js`
- Create: `lib/social/handlers/kits-id.js`
- Create: `lib/social/handlers/schedule.js`

- [ ] **Step 1: Create `lib/social/handlers/kits-index.js`**

```js
// lib/social/handlers/kits-index.js
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const kitIds = await kv.lrange('social:kits:index', 0, 49); // newest 50
    if (!kitIds || !kitIds.length) return res.status(200).json([]);

    const kits = await Promise.all(kitIds.map(id => kv.get(`social:kit:${id}`)));
    return res.status(200).json(kits.filter(Boolean));
  } catch (err) {
    console.error('[kits-index] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
```

- [ ] **Step 2: Create `lib/social/handlers/kits-id.js`**

```js
// lib/social/handlers/kits-id.js
import { kv } from '@vercel/kv';

export default async function handler(req, res, kitId) {
  try {
    if (req.method === 'GET') {
      const kit = await kv.get(`social:kit:${kitId}`);
      if (!kit) return res.status(404).json({ error: 'Kit not found' });
      return res.status(200).json(kit);
    }

    if (req.method === 'PATCH') {
      const kit = await kv.get(`social:kit:${kitId}`);
      if (!kit) return res.status(404).json({ error: 'Kit not found' });

      // Deep merge platforms if provided, shallow merge top-level fields
      const body = req.body || {};
      const updated = {
        ...kit,
        ...body,
        id: kitId,
        updatedAt: new Date().toISOString(),
        platforms: body.platforms
          ? mergePlatforms(kit.platforms, body.platforms)
          : kit.platforms,
      };

      await kv.set(`social:kit:${kitId}`, updated);
      return res.status(200).json(updated);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[kits-id] error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Deep merge platform data so a PATCH of one platform doesn't wipe others
function mergePlatforms(existing, incoming) {
  const result = { ...existing };
  for (const [platform, data] of Object.entries(incoming)) {
    result[platform] = { ...(existing[platform] || {}), ...data };
  }
  return result;
}
```

- [ ] **Step 3: Create `lib/social/handlers/schedule.js`**

```js
// lib/social/handlers/schedule.js
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Fetch all postRefs sorted by scheduledAt (score = epoch ms)
    const postRefIds = await kv.zrange('social:queue', 0, -1); // ascending by score (scheduledAt epoch ms) — default, no withScores needed
    if (!postRefIds || !postRefIds.length) return res.status(200).json([]);

    const postRefs = await Promise.all(postRefIds.map(id => kv.get(`social:postref:${id}`)));
    return res.status(200).json(postRefs.filter(Boolean));
  } catch (err) {
    console.error('[schedule] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
```

- [ ] **Step 4: Verify handlers manually**

Trace through each handler:
- `kits-index.js`: `kv.lrange('social:kits:index', 0, 49)` returns an array of kit IDs; `Promise.all` fetches each; `filter(Boolean)` removes any nulls (deleted kits). ✓
- `kits-id.js` PATCH: `mergePlatforms` loops `Object.entries(incoming)` and spreads each platform over the existing — a PATCH of `{ platforms: { instagram: { approved: true } } }` should not wipe `tiktok`. Trace through: `result = { ...existing }`, then `result.instagram = { ...existing.instagram, approved: true }`. TikTok untouched. ✓
- `schedule.js`: `kv.zrange('social:queue', 0, -1)` returns members ascending by score (scheduledAt epoch ms). Sorted correctly. ✓

- [ ] **Step 5: Commit**

```bash
git add lib/social/handlers/kits-index.js lib/social/handlers/kits-id.js lib/social/handlers/schedule.js
git commit -m "feat(social): add kit CRUD handlers and schedule endpoint"
```

---

## Chunk 2: Generation, Media, Deploy, Post, and Cron Handlers

### Task 5: Create `lib/social/media.js` — OpenRouter images + FAL.ai video

**Files:**
- Create: `lib/social/media.js`

- [ ] **Step 1: Create the media generation module**

```js
// lib/social/media.js

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
```

- [ ] **Step 2: Commit**

```bash
git add lib/social/media.js
git commit -m "feat(social): add media.js — OpenRouter image gen + FAL.ai video gen"
```

---

### Task 6: Create `lib/social/handlers/generate.js`

**Files:**
- Create: `lib/social/handlers/generate.js`

The most complex handler. Generates all 6 platform posts in parallel using Ava prompts, kicks off media generation (images sync, video async), assigns schedule, stores kit in KV.

- [ ] **Step 1: Create generate handler**

```js
// lib/social/handlers/generate.js
import { kv } from '@vercel/kv';
import { buildPlatformPrompt, pickArchetype, PLATFORM_CONFIGS } from '../ava-prompts.js';
import { generateImage, startVideoGeneration } from '../media.js';
import { autoSchedule } from '../scheduler.js';

// callLLM is a global in index.html but on the server we call OpenRouter directly
async function callOpenRouter(prompt) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://ibdhealthhub-content-generator.vercel.app',
      'X-Title': 'IBD Health Hub Content Generator',
    },
    body: JSON.stringify({
      model: process.env.DEFAULT_LLM_MODEL || 'google/gemma-3-27b-it:free',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`LLM call failed: ${JSON.stringify(data)}`);
  return text.trim();
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
      const articleExcerpt = ((article?.body || article?.content || '') as string)
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
```

- [ ] **Step 2: Verify the async-tail pattern**

After `res.status(200).json(kit)` the handler continues running to generate images and patch KV. Vercel serverless functions may be frozen immediately after the response is sent, so this tail work is best-effort. Images are fast (~1–3s) so they usually complete. Videos are started (FAL.ai job kicked off) and the `requestId` is stored so the client can poll. If the function is frozen before images patch KV, the client will see null image tiles — the "Regen" button handles this gracefully via the `mediaOnly` path added above.

- [ ] **Step 3: Commit**

```bash
git add lib/social/handlers/generate.js
git commit -m "feat(social): add generate handler — parallel LLM generation + media kickoff + mediaOnly regen path"
```

---

### Task 7: Create `lib/social/handlers/deploy.js` and `lib/social/handlers/post.js`

**Files:**
- Create: `lib/social/handlers/deploy.js`
- Create: `lib/social/handlers/post.js`

- [ ] **Step 1: Create `lib/social/handlers/deploy.js`**

Reads all approved platforms from the kit, writes each as a postRef to the sorted queue. Honors existing `scheduledAt` values (does NOT re-compute schedule).

```js
// lib/social/handlers/deploy.js
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { kitId } = req.body || {};
  if (!kitId) return res.status(400).json({ error: 'kitId is required' });

  try {
    const kit = await kv.get(`social:kit:${kitId}`);
    if (!kit) return res.status(404).json({ error: 'Kit not found' });

    const queued = [];
    const substack = 'substack'; // never queued

    for (const [platform, data] of Object.entries(kit.platforms)) {
      if (platform === substack) continue;
      if (!data.approved) continue;
      if (!data.scheduledAt) continue;

      const postRefId = `postref_${kitId}_${platform}`;
      const score = new Date(data.scheduledAt).getTime(); // epoch ms for sorted set

      const postRef = {
        id: postRefId,
        kitId,
        platform,
        scheduledAt: data.scheduledAt,
        status: 'queued',
        createdAt: new Date().toISOString(),
      };

      await kv.set(`social:postref:${postRefId}`, postRef);
      await kv.zadd('social:queue', { score, member: postRefId });
      queued.push(postRefId);
    }

    // Update kit status
    const updatedKit = { ...kit, status: 'scheduled', updatedAt: new Date().toISOString() };
    await kv.set(`social:kit:${kitId}`, updatedKit);

    return res.status(200).json({ queued, count: queued.length });
  } catch (err) {
    console.error('[deploy] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
```

- [ ] **Step 2: Create `lib/social/handlers/post.js`**

Fires one platform post immediately (used by cron and potentially manual "Post Now"). Reads credentials from `process.env`.

```js
// lib/social/handlers/post.js
import { kv } from '@vercel/kv';
import { dispatch } from '../platforms/index.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { kitId, platform } = req.body || {};
  if (!kitId || !platform) return res.status(400).json({ error: 'kitId and platform are required' });

  try {
    const kit = await kv.get(`social:kit:${kitId}`);
    if (!kit) return res.status(404).json({ error: 'Kit not found' });

    const platformData = kit.platforms[platform];
    if (!platformData) return res.status(400).json({ error: `Platform ${platform} not in kit` });

    const result = await dispatch(platform, platformData);

    // Mark posted on kit
    const updatedKit = { ...kit, updatedAt: new Date().toISOString() };
    updatedKit.platforms[platform] = {
      ...platformData,
      postedAt: new Date().toISOString(),
      platformPostId: result.postId || null,
    };
    await kv.set(`social:kit:${kitId}`, updatedKit);

    // Prepend to posted history
    const postRefId = `postref_${kitId}_${platform}`;
    await kv.lpush('social:posted:index', postRefId);

    return res.status(200).json({ success: true, postId: result.postId });
  } catch (err) {
    console.error('[post] error:', err);
    return res.status(500).json({ error: err.message });
  }
}
```

- [ ] **Step 3: Create `lib/social/handlers/cron.js`**

Drains the queue every 5 minutes. Protected by `CRON_SECRET`.

```js
// lib/social/handlers/cron.js
import { kv } from '@vercel/kv';
import { dispatch } from '../platforms/index.js';

function isAuthorised(req) {
  const cronHeader = req.headers['x-vercel-cron'];
  const authHeader = req.headers['authorization'];
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  return cronHeader === '1' || authHeader === expectedAuth;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorised(req)) return res.status(401).json({ error: 'Unauthorised' });

  const nowMs = Date.now();

  try {
    // Fetch all postRef IDs due now (score <= nowMs)
    const dueIds = await kv.zrangebyscore('social:queue', 0, nowMs);
    if (!dueIds || !dueIds.length) return res.status(200).json({ processed: 0 });

    const results = [];

    for (const postRefId of dueIds) {
      // Atomically remove from queue before processing (prevents double-fire on concurrent crons)
      const removed = await kv.zrem('social:queue', postRefId);
      if (!removed) continue; // another cron already took it

      const postRef = await kv.get(`social:postref:${postRefId}`);
      if (!postRef) continue;

      const kit = await kv.get(`social:kit:${postRef.kitId}`);
      if (!kit) continue;

      const platformData = kit.platforms[postRef.platform];
      if (!platformData) continue;

      try {
        const result = await dispatch(postRef.platform, platformData);

        // Update kit with posted info
        kit.platforms[postRef.platform] = {
          ...platformData,
          postedAt: new Date().toISOString(),
          platformPostId: result.postId || null,
        };
        kit.updatedAt = new Date().toISOString();
        await kv.set(`social:kit:${kit.id}`, kit);

        // Update postRef status
        await kv.set(`social:postref:${postRefId}`, { ...postRef, status: 'posted', postedAt: new Date().toISOString() });
        await kv.lpush('social:posted:index', postRefId);

        results.push({ postRefId, status: 'posted', platform: postRef.platform });
      } catch (err) {
        console.error(`[cron] failed to post ${postRefId}:`, err.message);

        // Re-enqueue with 30-minute retry
        const retryMs = nowMs + 30 * 60 * 1000;
        await kv.zadd('social:queue', { score: retryMs, member: postRefId });
        await kv.set(`social:postref:${postRefId}`, { ...postRef, status: 'retry', lastError: err.message });

        results.push({ postRefId, status: 'retry', error: err.message });
      }
    }

    return res.status(200).json({ processed: results.length, results });
  } catch (err) {
    console.error('[cron] fatal error:', err);
    return res.status(500).json({ error: err.message });
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add lib/social/handlers/deploy.js lib/social/handlers/post.js lib/social/handlers/cron.js
git commit -m "feat(social): add deploy, post, and cron handlers"
```

---

### Task 8: Add cron entry to `vercel.json`

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Read current vercel.json**

Use the Read tool: `Read: vercel.json`

- [ ] **Step 2: Add the social cron entry to the `crons` array**

Open `vercel.json` and add to the existing `crons` array (or create it if absent):

```json
{ "path": "/api/social/cron", "schedule": "*/5 * * * *" }
```

Result should look like:
```json
{
  "github": { "enabled": false },
  "crons": [
    { "path": "/api/social/cron", "schedule": "*/5 * * * *" }
  ]
}
```

(Merge with any existing cron entries — do not replace them.)

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "feat(social): add 5-minute cron for social queue drain"
```

---

## Chunk 3: Platform Adapters

### Task 9: Create `lib/social/platforms/index.js` — dispatcher

**Files:**
- Create: `lib/social/platforms/index.js`

- [ ] **Step 1: Create the dispatcher**

```js
// lib/social/platforms/index.js
import { postInstagram } from './instagram.js';
import { postTikTok } from './tiktok.js';
import { postLinkedIn } from './linkedin.js';
import { postTwitter } from './twitter.js';
import { postFacebook } from './facebook.js';

const adapters = {
  instagram: postInstagram,
  tiktok:    postTikTok,
  linkedin:  postLinkedIn,
  twitter:   postTwitter,
  facebook:  postFacebook,
};

/**
 * Post content to a platform using server-side env var credentials.
 * @param {string} platform
 * @param {object} platformData - The platform slice from a ContentKit
 * @returns {{ postId: string }}
 */
export async function dispatch(platform, platformData) {
  const adapter = adapters[platform];
  if (!adapter) throw new Error(`No adapter for platform: ${platform}`);
  return adapter(platformData);
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/social/platforms/index.js
git commit -m "feat(social): add platform dispatcher"
```

---

### Task 10: Create LinkedIn and X/Twitter adapters

**Files:**
- Create: `lib/social/platforms/linkedin.js`
- Create: `lib/social/platforms/twitter.js`

These are the two most reliable APIs to start with (stable, well-documented).

- [ ] **Step 1: Create `lib/social/platforms/linkedin.js`**

```js
// lib/social/platforms/linkedin.js

const API_BASE = 'https://api.linkedin.com/v2';

export async function postLinkedIn(platformData) {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const authorUrn = `urn:li:person:${process.env.LINKEDIN_PERSON_ID}`;

  if (!token) throw new Error('LINKEDIN_ACCESS_TOKEN not configured');

  // Build the post text with hashtags appended
  const text = platformData.hashtags?.length
    ? `${platformData.caption}\n\n${platformData.hashtags.join(' ')}`
    : platformData.caption;

  // UGC Post payload
  const body = {
    author: authorUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: platformData.image?.url ? 'IMAGE' : 'NONE',
        ...(platformData.image?.url ? {
          media: [{
            status: 'READY',
            originalUrl: platformData.image.url,
          }],
        } : {}),
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };

  const res = await fetch(`${API_BASE}/ugcPosts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LinkedIn post failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  // LinkedIn returns the URN in the id field: urn:li:ugcPost:123456
  const postId = data.id || data['id'] || null;
  return { postId };
}
```

- [ ] **Step 2: Create `lib/social/platforms/twitter.js`**

Posts a thread of 3 tweets chained by `reply.in_reply_to_tweet_id`.

```js
// lib/social/platforms/twitter.js
import OAuth from 'oauth-1.0a';
import crypto from 'crypto';

const API_BASE = 'https://api.twitter.com/2/tweets';

function getOAuthHeaders(url, method) {
  const oauth = new OAuth({
    consumer: {
      key: process.env.TWITTER_API_KEY,
      secret: process.env.TWITTER_API_SECRET,
    },
    signature_method: 'HMAC-SHA1',
    hash_function: (base, key) => crypto.createHmac('sha1', key).update(base).digest('base64'),
  });

  const token = {
    key: process.env.TWITTER_ACCESS_TOKEN,
    secret: process.env.TWITTER_ACCESS_SECRET,
  };

  return oauth.toHeader(oauth.authorize({ url, method }, token));
}

async function postTweet(text, replyToId = null) {
  const body = { text };
  if (replyToId) body.reply = { in_reply_to_tweet_id: replyToId };

  const oauthHeaders = getOAuthHeaders(API_BASE, 'POST');

  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...oauthHeaders,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Twitter post failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  return data.data?.id;
}

export async function postTwitter(platformData) {
  const thread = platformData.thread || [];
  if (!thread.length) throw new Error('Twitter thread is empty');

  if (!process.env.TWITTER_API_KEY) throw new Error('TWITTER_API_KEY not configured');

  let previousTweetId = null;
  let firstTweetId = null;

  for (const tweetText of thread) {
    const tweetId = await postTweet(tweetText, previousTweetId);
    if (!firstTweetId) firstTweetId = tweetId;
    previousTweetId = tweetId;
  }

  return { postId: firstTweetId }; // store first tweet ID as platformPostId
}
```

Note: `oauth-1.0a` is a lightweight npm package needed for Twitter OAuth 1.0a signing.

- [ ] **Step 3: Install `oauth-1.0a` and commit**

```bash
npm install oauth-1.0a
git add lib/social/platforms/linkedin.js lib/social/platforms/twitter.js package.json package-lock.json
git commit -m "feat(social): add LinkedIn and Twitter platform adapters + oauth-1.0a dependency"
```

---

### Task 11: Create Facebook and Instagram adapters

**Files:**
- Create: `lib/social/platforms/facebook.js`
- Create: `lib/social/platforms/instagram.js`

Both use the Meta Graph API but different endpoints.

- [ ] **Step 1: Create `lib/social/platforms/facebook.js`**

```js
// lib/social/platforms/facebook.js

const GRAPH_BASE = 'https://graph.facebook.com/v19.0';

export async function postFacebook(platformData) {
  const token = process.env.FACEBOOK_ACCESS_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;

  if (!token || !pageId) throw new Error('FACEBOOK_ACCESS_TOKEN or FACEBOOK_PAGE_ID not configured');

  const text = platformData.hashtags?.length
    ? `${platformData.caption}\n\n${platformData.hashtags.join(' ')}`
    : platformData.caption;

  let endpoint, body;

  if (platformData.image?.url) {
    // Post with photo
    endpoint = `${GRAPH_BASE}/${pageId}/photos`;
    body = {
      message: text,
      url: platformData.image.url,
      access_token: token,
    };
  } else {
    // Text-only post
    endpoint = `${GRAPH_BASE}/${pageId}/feed`;
    body = {
      message: text,
      access_token: token,
    };
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Facebook post failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  return { postId: data.id || data.post_id || null };
}
```

- [ ] **Step 2: Create `lib/social/platforms/instagram.js`**

Instagram Graph API requires: (1) create media container, (2) publish it.

```js
// lib/social/platforms/instagram.js

const GRAPH_BASE = 'https://graph.facebook.com/v19.0';

async function graphPost(endpoint, body, token) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Instagram Graph API error (${res.status}): ${err}`);
  }
  return res.json();
}

export async function postInstagram(platformData) {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  const accountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;

  if (!token || !accountId) throw new Error('INSTAGRAM_ACCESS_TOKEN or INSTAGRAM_BUSINESS_ACCOUNT_ID not configured');

  const caption = platformData.hashtags?.length
    ? `${platformData.caption}\n\n${platformData.hashtags.join(' ')}`
    : platformData.caption;

  // Prefer video (Reel) if available and uploaded, otherwise fall back to image
  if (platformData.video?.url) {
    // Create Reel container
    const container = await graphPost(
      `${GRAPH_BASE}/${accountId}/media`,
      {
        media_type: 'REELS',
        video_url: platformData.video.url,
        caption,
        share_to_feed: true,
      },
      token
    );

    // Wait for container to be ready (poll up to 30s)
    const containerId = container.id;
    let containerReady = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const status = await fetch(
        `${GRAPH_BASE}/${containerId}?fields=status_code&access_token=${token}`
      ).then(r => r.json());
      if (status.status_code === 'FINISHED') { containerReady = true; break; }
      if (status.status_code === 'ERROR') throw new Error('Instagram Reel container failed');
    }
    if (!containerReady) throw new Error('Instagram Reel container timed out (30s) — video may still be processing');

    // Publish
    const publish = await graphPost(`${GRAPH_BASE}/${accountId}/media_publish`, { creation_id: containerId }, token);
    return { postId: publish.id };
  }

  if (platformData.image?.url) {
    // Static image post
    const container = await graphPost(
      `${GRAPH_BASE}/${accountId}/media`,
      { image_url: platformData.image.url, caption },
      token
    );
    const publish = await graphPost(
      `${GRAPH_BASE}/${accountId}/media_publish`,
      { creation_id: container.id },
      token
    );
    return { postId: publish.id };
  }

  throw new Error('Instagram requires image or video URL');
}
```

- [ ] **Step 3: Create `lib/social/platforms/tiktok.js`**

```js
// lib/social/platforms/tiktok.js

const API_BASE = 'https://open.tiktokapis.com/v2/post/publish/video/init/';

export async function postTikTok(platformData) {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!token) throw new Error('TIKTOK_ACCESS_TOKEN not configured');

  const caption = platformData.hashtags?.length
    ? `${platformData.caption} ${platformData.hashtags.join(' ')}`
    : platformData.caption;

  if (!platformData.video?.url) throw new Error('TikTok requires a video URL');

  // TikTok Content Posting API — PULL_FROM_URL method
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      post_info: {
        title: caption.slice(0, 150), // TikTok title field
        privacy_level: 'PUBLIC_TO_EVERYONE',
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: 'PULL_FROM_URL',
        video_url: platformData.video.url,
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`TikTok post failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  return { postId: data.data?.publish_id || null };
}
```

- [ ] **Step 4: Commit**

```bash
git add lib/social/platforms/facebook.js lib/social/platforms/instagram.js lib/social/platforms/tiktok.js
git commit -m "feat(social): add Facebook, Instagram, TikTok platform adapters"
```

---

## Chunk 4: Frontend — Rebuild Social Tab in `index.html`

### Task 12: Add Social sub-tab structure and CSS

**Files:**
- Modify: `index.html` (social tab section — search for `id="view-social"` or `social-tabs-bar`)

The existing social pane has two sub-tabs: Generate and Prompt Library. We're replacing the Generate pane with the Kit Builder, and adding Queue and Posted sub-tabs.

- [ ] **Step 1: Locate the social tab in index.html**

```bash
grep -n "social-tabs-bar\|socialPane-generate\|SOCIAL TAB\|view-social" index.html | head -20
```

Note the line numbers. The social tab HTML is between `<!-- TAB: SOCIAL -->` and `<!-- TAB: CALENDAR -->`.

- [ ] **Step 2: Replace the social sub-tab bar**

Find the existing:
```html
<div class="social-tabs-bar">
  <button class="social-tab-btn active" id="socialTabBtn-generate" onclick="switchSocialTab('generate')">
    ...Generate Posts...
  </button>
  <button class="social-tab-btn" id="socialTabBtn-prompts" onclick="switchSocialTab('prompts')">
    ...Prompt Library...
  </button>
</div>
```

Replace with:
```html
<div class="social-tabs-bar">
  <button class="social-tab-btn active" id="socialTabBtn-kit" onclick="switchSocialTab('kit')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
    Kit Builder
  </button>
  <button class="social-tab-btn" id="socialTabBtn-queue" onclick="switchSocialTab('queue')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
    Queue
    <span id="socialQueueBadge" style="background:var(--sla-navy);color:#fff;font-size:0.55rem;font-weight:800;padding:1px 6px;border-radius:20px;margin-left:2px;display:none;">0</span>
  </button>
  <button class="social-tab-btn" id="socialTabBtn-posted" onclick="switchSocialTab('posted')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;"><polyline points="20 6 9 17 4 12"/></svg>
    Posted
  </button>
  <button class="social-tab-btn" id="socialTabBtn-prompts" onclick="switchSocialTab('prompts')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
    Prompt Library
    <span id="socialPromptsTotalBadge" style="background:var(--sla-teal);color:#fff;font-size:0.55rem;font-weight:800;padding:1px 6px;border-radius:20px;margin-left:2px;">—</span>
  </button>
  <button class="social-tab-btn" id="socialTabBtn-connections" onclick="switchSocialTab('connections')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
    Connections
  </button>
</div>
```

- [ ] **Step 3: Add CSS for Kit Builder components** (add before `</style>` tag)

```css
/* ── Social Kit Builder ── */
.kit-configure-bar { background:#fff; border:1px solid var(--border); border-left:4px solid var(--sla-teal); padding:1.25rem 1.5rem; margin-bottom:1rem; }
.kit-configure-grid { display:grid; grid-template-columns:2fr 1fr 1fr auto; gap:12px; align-items:end; }
@media(max-width:700px){ .kit-configure-grid { grid-template-columns:1fr; } }
.kit-section-label { font-size:0.58rem; font-weight:800; text-transform:uppercase; letter-spacing:0.8px; color:var(--sla-navy); margin-bottom:8px; }
.kit-accordion-row { background:#fff; border:1px solid var(--border); margin-bottom:6px; }
.kit-accordion-head { display:flex; align-items:center; gap:10px; padding:10px 14px; cursor:pointer; }
.kit-accordion-head.open { border-bottom:1px solid var(--border); }
.kit-plat-icon { width:32px; height:32px; background:var(--bg); border:1px solid var(--border); display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.kit-plat-name { font-weight:700; font-size:0.78rem; flex:1; color:var(--sla-navy); }
.kit-badge { font-size:0.6rem; font-weight:700; padding:2px 8px; white-space:nowrap; }
.kit-badge.gen { background:rgba(0,201,167,0.12); color:#009e85; }
.kit-badge.gen-pending { background:rgba(224,123,0,0.12); color:#e07b00; }
.kit-badge.gen-error { background:rgba(239,68,68,0.1); color:#ef4444; }
.kit-badge.hook { background:var(--bg); border:1px solid var(--border); color:var(--text-muted); }
.kit-badge.media { background:rgba(27,63,48,0.07); color:var(--sla-navy); }
.btn-kit-approve { padding:4px 12px; font-size:0.62rem; font-weight:800; border:1px solid var(--border); background:var(--bg); color:var(--sla-navy); cursor:pointer; white-space:nowrap; }
.btn-kit-approve.approved { background:var(--sla-teal); color:#fff; border-color:var(--sla-teal); }
.kit-sched-time { font-size:0.6rem; color:var(--text-muted); white-space:nowrap; cursor:pointer; }
.kit-sched-time:hover { color:var(--sla-navy); text-decoration:underline; }
.kit-accordion-body { padding:14px; display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; }
@media(max-width:900px){ .kit-accordion-body { grid-template-columns:1fr; } }
.kit-col-label { font-size:0.55rem; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-muted); margin-bottom:5px; }
.kit-text-area { width:100%; box-sizing:border-box; padding:8px 10px; border:1px solid var(--border); background:var(--bg); color:var(--text); font-family:'Montserrat',sans-serif; font-size:0.72rem; line-height:1.55; resize:vertical; min-height:90px; }
.kit-script-box { border:1px solid var(--border); padding:10px; background:#fffbf0; font-size:0.68rem; line-height:1.6; }
.kit-script-label { font-weight:800; font-size:0.58rem; text-transform:uppercase; letter-spacing:0.4px; margin-bottom:3px; display:block; }
.kit-script-label.hook { color:#e07b00; }
.kit-script-label.body { color:var(--sla-navy); }
.kit-script-label.cta  { color:var(--sla-teal); }
.kit-media-tile { border:1px solid var(--border); padding:10px; text-align:center; background:var(--bg); margin-bottom:8px; }
.kit-media-tile.ready { border-color:var(--sla-teal); background:rgba(0,201,167,0.04); }
.kit-media-tile-icon { font-size:1.4rem; margin-bottom:4px; }
.kit-media-tile-title { font-weight:700; font-size:0.65rem; color:var(--sla-navy); }
.kit-media-tile-sub { font-size:0.58rem; color:var(--text-muted); }
.kit-media-actions { display:flex; gap:5px; justify-content:center; margin-top:6px; }
.kit-deploy-bar { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:#fff; border:1px solid var(--border); margin-top:6px; }
.kit-deploy-status { font-size:0.72rem; color:var(--text-muted); }

/* Queue + Posted panes */
.social-queue-list { display:flex; flex-direction:column; gap:6px; }
.social-queue-card { background:#fff; border:1px solid var(--border); padding:12px 16px; display:flex; align-items:center; gap:12px; }
.social-queue-time { font-size:0.65rem; font-weight:700; color:var(--sla-navy); min-width:80px; }
.social-queue-plat { width:26px; height:26px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.social-queue-title { flex:1; font-size:0.75rem; font-weight:600; color:var(--text); }
.social-queue-cat { font-size:0.62rem; color:var(--text-muted); }
```

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(social): add Kit Builder sub-tab structure and CSS"
```

---

### Task 13: Add Kit Builder HTML pane

**Files:**
- Modify: `index.html` (replace `socialPane-generate` content)

- [ ] **Step 1: Replace the existing `socialPane-generate` div content**

Find:
```html
<div class="social-pane active" id="socialPane-generate">
```

Replace the entire inner content of that div (everything up to `</div><!-- /socialPane-generate -->`) with:

```html
<div class="social-pane active" id="socialPane-kit">

  <!-- ① Configure Kit -->
  <div class="kit-configure-bar">
    <div class="kit-section-label" style="margin-bottom:10px;">① Configure Kit</div>
    <div class="kit-configure-grid">
      <div>
        <div style="font-size:0.58rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">Article</div>
        <div style="position:relative;">
          <select id="kitArticleSelect" onchange="onKitArticleChange(this.value)" style="width:100%;padding:8px 32px 8px 10px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:'Montserrat',sans-serif;font-size:0.78rem;font-weight:600;appearance:none;">
            <option value="">— Choose a published article —</option>
          </select>
          <svg style="position:absolute;right:10px;top:50%;transform:translateY(-50%);pointer-events:none;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="13" height="13"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      <div>
        <div style="font-size:0.58rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">Content Pillar</div>
        <select id="kitPillar" style="width:100%;padding:8px 10px;border:2px solid var(--sla-teal);background:rgba(0,201,167,0.04);color:var(--sla-navy);font-family:'Montserrat',sans-serif;font-size:0.78rem;font-weight:700;">
          <option value="educate">Educate</option>
          <option value="entertain">Entertain / Relate</option>
          <option value="sell">Sell</option>
        </select>
      </div>
      <div>
        <div style="font-size:0.58rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">CTA Goal</div>
        <select id="kitCtaGoal" style="width:100%;padding:8px 10px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-family:'Montserrat',sans-serif;font-size:0.78rem;font-weight:600;">
          <option value="grow">Grow — gain followers</option>
          <option value="engage">Engage — comments</option>
          <option value="convert">Convert — DMs / bookings</option>
          <option value="save">Save — share content</option>
        </select>
      </div>
      <div>
        <button class="btn btn-orange" id="kitGenerateBtn" onclick="generateKit()" disabled
          style="padding:9px 20px;font-size:0.75rem;font-weight:800;white-space:nowrap;">
          ⚡ Generate Kit
        </button>
      </div>
    </div>
  </div>

  <!-- Kit status banner (hidden until kit generated) -->
  <div id="kitStatusBanner" style="display:none;"></div>

  <!-- ② Review & Edit Kit -->
  <div class="kit-section-label" id="kitReviewLabel" style="display:none;">② Review &amp; Edit Kit</div>
  <div id="kitAccordion" style="margin-bottom:6px;"></div>

  <!-- Deploy bar (hidden until kit generated) -->
  <div class="kit-deploy-bar" id="kitDeployBar" style="display:none;">
    <div class="kit-deploy-status" id="kitDeployStatus">0 of 6 approved</div>
    <div style="display:flex;gap:8px;">
      <button class="btn" onclick="approveAllKit()" style="padding:8px 16px;font-size:0.72rem;font-weight:700;">Approve All</button>
      <button class="btn btn-orange" id="kitDeployBtn" onclick="deployKit()" disabled
        style="padding:9px 22px;font-size:0.74rem;font-weight:800;">🚀 Deploy Kit</button>
    </div>
  </div>

</div><!-- /socialPane-kit -->

<!-- Queue pane -->
<div class="social-pane" id="socialPane-queue">
  <div id="socialQueueList" style="margin-top:4px;">
    <div class="social-empty">No posts queued yet.</div>
  </div>
</div>

<!-- Posted pane -->
<div class="social-pane" id="socialPane-posted">
  <div id="socialPostedList" style="margin-top:4px;">
    <div class="social-empty">No posts sent yet.</div>
  </div>
</div>
```

Also ensure the Connections pane exists with the correct ID. Run:
```bash
grep -n "socialPane-connections\|renderSocialConnections\|social-pane.*connections" index.html | head -10
```

If `id="socialPane-connections"` already exists, no change needed. If the connections UI lives inside `id="socialPane-generate"` (the old pane), extract it into its own pane div:

```html
<!-- Add this as a sibling to socialPane-kit/queue/posted -->
<div class="social-pane" id="socialPane-connections">
  <!-- move existing connections content here -->
</div>
```

The `switchSocialTab('connections')` already calls `renderSocialConnections()`, which renders dynamically into the pane — so the wrapper just needs to exist with the correct ID.

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat(social): add Kit Builder, Queue, Posted HTML panes"
```

---

### Task 14: Add Kit Builder JavaScript

**Files:**
- Modify: `index.html` (add JS functions — find the `/* ─── Social ───` JS section around line 8700)

- [ ] **Step 1: Update `switchSocialTab` to handle new tab IDs**

Find the existing `function switchSocialTab(tab)` and replace it with:

```js
function switchSocialTab(tab) {
  var tabs = ['kit', 'queue', 'posted', 'prompts', 'connections'];
  tabs.forEach(function(t) {
    var btn = document.getElementById('socialTabBtn-' + t);
    var pane = document.getElementById('socialPane-' + t);
    if (btn) btn.classList.toggle('active', t === tab);
    if (pane) pane.classList.toggle('active', t === tab);
  });
  if (tab === 'kit') loadKitArticleSelect();
  if (tab === 'queue') loadSocialQueue();
  if (tab === 'posted') loadSocialPosted();
  if (tab === 'prompts') loadSocialPromptsTab();
  if (tab === 'connections') renderSocialConnections();
}
```

- [ ] **Step 2: Locate the global article array used by existing social code**

Before writing `loadKitArticleSelect`, run:
```bash
grep -n "allSocialItems\|allKvItems\|socialItems\|contentItems\|allItems" index.html | grep -i "var \|const \|let " | head -20
```

Find the global that holds published/approved articles (likely `allSocialItems`, `allContentItems`, or similar). Use that exact variable name in the next step.

- [ ] **Step 3: Add kit state variables and article select loader**

Add near the other social globals (around `const socialPostCache = {}`). **Replace `allSocialItems` and `allKvItems` below with the actual global variable names found in Step 2.**

```js
// Kit Builder state
var _currentKit = null;
var _currentKitArticleId = null;
var _kitPollInterval = null;

function loadKitArticleSelect() {
  var sel = document.getElementById('kitArticleSelect');
  if (!sel) return;
  // Populate from pipeline (published + approved articles)
  // NOTE: Replace allSocialItems / allKvItems with the actual globals found via grep above
  var items = (allSocialItems || []).concat(
    typeof allKvItems !== 'undefined' ? allKvItems : []
  ).filter(function(i) { return i && i.id && i.title; });

  // Deduplicate by id
  var seen = new Set();
  var unique = items.filter(function(i) { if (seen.has(i.id)) return false; seen.add(i.id); return true; });

  sel.innerHTML = '<option value="">— Choose a published article —</option>' +
    unique.map(function(i) {
      return '<option value="' + escHtml(i.id) + '">' + escHtml(i.title || i.id) + '</option>';
    }).join('');
}

function onKitArticleChange(articleId) {
  var btn = document.getElementById('kitGenerateBtn');
  if (btn) btn.disabled = !articleId;
  _currentKitArticleId = articleId || null;
}
```

- [ ] **Step 3: Add `generateKit()` function**

```js
async function generateKit() {
  var articleId = _currentKitArticleId;
  var pillar = document.getElementById('kitPillar').value;
  var ctaGoal = document.getElementById('kitCtaGoal').value;
  if (!articleId) { showToast('Choose an article first'); return; }

  var btn = document.getElementById('kitGenerateBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }

  var banner = document.getElementById('kitStatusBanner');
  if (banner) { banner.style.display = ''; banner.innerHTML = '<div style="padding:10px 14px;background:rgba(0,201,167,0.08);border:1px solid var(--sla-teal);font-size:0.78rem;color:var(--sla-navy);margin-bottom:8px;">⚡ Generating content kit — this takes 20–40 seconds…</div>'; }

  try {
    var kit = await apiFetch('/api/social/generate', {
      method: 'POST',
      body: JSON.stringify({ articleId, pillar, ctaGoal }),
    });
    _currentKit = kit;
    renderKitAccordion(kit);
    pollKitMedia(kit.id);
    showToast('Kit generated — review and approve each platform');
  } catch (err) {
    showToast('Generation failed: ' + err.message);
    if (banner) banner.innerHTML = '<div style="padding:10px 14px;background:rgba(239,68,68,0.06);border:1px solid #ef4444;font-size:0.78rem;color:#ef4444;margin-bottom:8px;">Generation failed: ' + escHtml(err.message) + '</div>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Generate Kit'; }
  }
}
```

- [ ] **Step 4: Add `renderKitAccordion()` and platform-specific row renderers**

```js
var SOCIAL_PLAT_ORDER = ['instagram', 'tiktok', 'linkedin', 'twitter', 'facebook', 'substack'];

var SOCIAL_PLAT_LABELS = {
  instagram: 'Instagram', tiktok: 'TikTok', linkedin: 'LinkedIn',
  twitter: 'X / Twitter', facebook: 'Facebook', substack: 'Substack',
};

function renderKitAccordion(kit) {
  var accordion = document.getElementById('kitAccordion');
  var label = document.getElementById('kitReviewLabel');
  var deployBar = document.getElementById('kitDeployBar');
  if (!accordion) return;
  if (label) label.style.display = '';
  if (deployBar) deployBar.style.display = '';

  accordion.innerHTML = SOCIAL_PLAT_ORDER.map(function(platform) {
    return renderKitRow(kit, platform, false);
  }).join('');
  updateKitDeployBar();
}

function renderKitRow(kit, platform, expanded) {
  var data = (kit.platforms || {})[platform] || {};
  var label = SOCIAL_PLAT_LABELS[platform] || platform;
  var isSubstack = platform === 'substack';
  var hasImage = !!(data.image && data.image.url);
  var hasVideo = !!(data.video && data.video.url);
  var videoLoading = !!(data.video && data.video.requestId && !data.video.url);
  var approved = !!data.approved;
  var hookLabel = data.hookArchetype ? data.hookArchetype.replace(/_/g, ' ') : '';

  return '<div class="kit-accordion-row" id="kit-row-' + platform + '">' +
    '<div class="kit-accordion-head' + (expanded ? ' open' : '') + '" onclick="toggleKitRow(\'' + platform + '\')">' +
      '<div class="kit-plat-icon">' + getPlatSvg(platform) + '</div>' +
      '<div class="kit-plat-name">' + escHtml(label) + '</div>' +
      '<span class="kit-badge gen">Generated ✓</span>' +
      (hookLabel ? '<span class="kit-badge hook">' + escHtml(hookLabel) + ' hook</span>' : '') +
      (hasImage ? '<span class="kit-badge media">Image ✓</span>' : '') +
      (hasVideo ? '<span class="kit-badge media">Video ✓</span>' : '') +
      (videoLoading ? '<span class="kit-badge gen-pending">Video generating…</span>' : '') +
      (isSubstack
        ? '<button class="btn-kit-approve" onclick="copySubstackTeaser(event)"  style="margin-left:auto;">📋 Copy Teaser</button>'
        : '<button class="btn-kit-approve' + (approved ? ' approved' : '') + '" id="kit-approve-' + platform + '" onclick="toggleKitApprove(event,\'' + platform + '\')">' + (approved ? 'APPROVED ✓' : 'Approve') + '</button>'
      ) +
      (!isSubstack && data.scheduledAt ? '<span class="kit-sched-time" onclick="editKitSchedule(event,\'' + platform + '\')">' + formatKitTime(data.scheduledAt) + '</span>' : '') +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;flex-shrink:0;margin-left:4px;"><polyline points="6 9 12 15 18 9"/></svg>' +
    '</div>' +
    (expanded ? renderKitRowBody(platform, data) : '') +
  '</div>';
}

function renderKitRowBody(platform, data) {
  var isThreadPlatform = platform === 'twitter';
  var hasScript = ['instagram', 'tiktok'].includes(platform);
  var hasMedia = ['instagram', 'tiktok', 'linkedin', 'facebook'].includes(platform);
  var isSubstack = platform === 'substack';

  var col1 = '<div>' +
    '<div class="kit-col-label">' + (isThreadPlatform ? 'Thread (3 tweets)' : isSubstack ? 'Teaser' : 'Caption') + '</div>' +
    (isThreadPlatform
      ? (data.thread || []).map(function(t, i) {
          return '<div class="kit-col-label" style="margin-top:8px;">Tweet ' + (i+1) + '</div><textarea class="kit-text-area" oninput="onKitTextChange(\'' + platform + '\',\'thread\',' + i + ',this.value)">' + escHtml(t) + '</textarea>';
        }).join('')
      : '<textarea class="kit-text-area" oninput="onKitTextChange(\'' + platform + '\',\'caption\',null,this.value)">' + escHtml(data.caption || data.teaser || '') + '</textarea>'
    ) +
    (!isThreadPlatform && !isSubstack && data.hashtags && data.hashtags.length
      ? '<div style="margin-top:6px;font-size:0.65rem;color:var(--text-muted);">' + escHtml(data.hashtags.join(' ')) + '</div>'
      : '') +
  '</div>';

  var col2 = hasScript && data.reelScript
    ? '<div>' +
        '<div class="kit-col-label">Reel Script</div>' +
        '<div class="kit-script-box">' +
          '<span class="kit-script-label hook">HOOK</span><div style="margin-bottom:8px;">' + escHtml(data.reelScript.hook || '') + '</div>' +
          '<span class="kit-script-label body">BODY</span><div style="margin-bottom:8px;">' + escHtml(data.reelScript.body || '') + '</div>' +
          '<span class="kit-script-label cta">CTA</span><div>' + escHtml(data.reelScript.cta || '') + '</div>' +
          '<div style="font-size:0.58rem;color:var(--text-muted);margin-top:6px;">Est. ' + (data.reelScript.durationEst || '—') + 's</div>' +
        '</div>' +
      '</div>'
    : '<div></div>';

  var col3 = hasMedia
    ? '<div>' +
        '<div class="kit-col-label">Media</div>' +
        renderKitMediaTile(platform, 'image', data.image) +
        (['instagram', 'tiktok'].includes(platform) ? renderKitMediaTile(platform, 'video', data.video) : '') +
      '</div>'
    : '<div></div>';

  return '<div class="kit-accordion-body">' + col1 + col2 + col3 + '</div>';
}

function renderKitMediaTile(platform, type, mediaData) {
  var ready = !!(mediaData && mediaData.url);
  var loading = !!(mediaData && mediaData.requestId && !mediaData.url);
  var icon = type === 'video' ? '🎬' : '🖼';
  var label = type === 'video' ? 'Video 9:16 · 10s' : (platform === 'instagram' || platform === 'tiktok' ? 'Image 4:5' : 'Image 1:1');
  var model = mediaData && mediaData.model ? mediaData.model : '—';

  return '<div class="kit-media-tile' + (ready ? ' ready' : '') + '">' +
    '<div class="kit-media-tile-icon">' + icon + '</div>' +
    '<div class="kit-media-tile-title">' + label + '</div>' +
    '<div class="kit-media-tile-sub">' + (loading ? 'Generating…' : ready ? escHtml(model) : 'Not generated') + '</div>' +
    '<div class="kit-media-actions">' +
      (ready ? '<button class="btn btn-sm" onclick="viewKitMedia(\'' + platform + '\',\'' + type + '\')">View</button>' : '') +
      '<button class="btn btn-sm" onclick="regenKitMedia(\'' + platform + '\',\'' + type + '\')">' + (ready ? 'Regen' : loading ? '…' : 'Generate') + '</button>' +
    '</div>' +
  '</div>';
}

function getPlatSvg(platform) {
  return PLAT_SVG[platform] || '<svg viewBox="0 0 24 24" width="20" height="20"></svg>';
}

function formatKitTime(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return days[d.getUTCDay()] + ' ' + String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0');
}
```

- [ ] **Step 5: Add approve, deploy, and utility functions**

```js
function toggleKitRow(platform) {
  var row = document.getElementById('kit-row-' + platform);
  if (!row || !_currentKit) return;
  var head = row.querySelector('.kit-accordion-head');
  var isOpen = head.classList.contains('open');
  head.classList.toggle('open', !isOpen);
  var existing = row.querySelector('.kit-accordion-body');
  if (existing) { existing.remove(); }
  if (!isOpen) {
    row.insertAdjacentHTML('beforeend', renderKitRowBody(platform, (_currentKit.platforms || {})[platform] || {}));
  }
}

function toggleKitApprove(event, platform) {
  event.stopPropagation();
  if (!_currentKit) return;
  var data = _currentKit.platforms[platform] || {};
  data.approved = !data.approved;
  _currentKit.platforms[platform] = data;
  var btn = document.getElementById('kit-approve-' + platform);
  if (btn) {
    btn.textContent = data.approved ? 'APPROVED ✓' : 'Approve';
    btn.classList.toggle('approved', data.approved);
  }
  updateKitDeployBar();
  // Persist to API
  apiFetch('/api/social/kits/' + _currentKit.id, {
    method: 'PATCH',
    body: JSON.stringify({ platforms: { [platform]: { approved: data.approved } } }),
  }).catch(function(e) { console.warn('kit patch failed:', e); });
}

function approveAllKit() {
  if (!_currentKit) return;
  SOCIAL_PLAT_ORDER.forEach(function(platform) {
    if (platform === 'substack') return;
    if (_currentKit.platforms[platform]) {
      _currentKit.platforms[platform].approved = true;
      var btn = document.getElementById('kit-approve-' + platform);
      if (btn) { btn.textContent = 'APPROVED ✓'; btn.classList.add('approved'); }
    }
  });
  updateKitDeployBar();
  apiFetch('/api/social/kits/' + _currentKit.id, {
    method: 'PATCH',
    body: JSON.stringify({ platforms: Object.fromEntries(
      SOCIAL_PLAT_ORDER.filter(function(p) { return p !== 'substack'; }).map(function(p) { return [p, { approved: true }]; })
    )}),
  }).catch(function(e) { console.warn('kit patch failed:', e); });
}

function updateKitDeployBar() {
  if (!_currentKit) return;
  var approved = SOCIAL_PLAT_ORDER.filter(function(p) {
    return p !== 'substack' && _currentKit.platforms[p] && _currentKit.platforms[p].approved;
  }).length;
  var total = SOCIAL_PLAT_ORDER.filter(function(p) { return p !== 'substack'; }).length;
  var status = document.getElementById('kitDeployStatus');
  var btn = document.getElementById('kitDeployBtn');
  if (status) status.textContent = approved + ' of ' + total + ' approved · will auto-schedule across next 7 days';
  if (btn) btn.disabled = approved === 0;
}

async function deployKit() {
  if (!_currentKit) return;
  var btn = document.getElementById('kitDeployBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Deploying…'; }
  try {
    var result = await apiFetch('/api/social/deploy', {
      method: 'POST',
      body: JSON.stringify({ kitId: _currentKit.id }),
    });
    showToast(result.count + ' posts scheduled successfully');
    switchSocialTab('queue');
  } catch (err) {
    showToast('Deploy failed: ' + err.message);
    if (btn) { btn.disabled = false; btn.textContent = '🚀 Deploy Kit'; }
  }
}

function copySubstackTeaser(event) {
  event.stopPropagation();
  if (!_currentKit || !_currentKit.platforms.substack) return;
  var teaser = _currentKit.platforms.substack.teaser || '';
  navigator.clipboard.writeText(teaser).then(function() {
    showToast('Substack teaser copied to clipboard');
  });
}

function onKitTextChange(platform, field, index, value) {
  if (!_currentKit || !_currentKit.platforms[platform]) return;
  if (field === 'thread' && index !== null) {
    _currentKit.platforms[platform].thread[index] = value;
  } else {
    _currentKit.platforms[platform][field] = value;
  }
}

// Poll for video generation completion
function pollKitMedia(kitId) {
  if (_kitPollInterval) clearInterval(_kitPollInterval);
  var attempts = 0;
  _kitPollInterval = setInterval(async function() {
    attempts++;
    if (attempts > 20) { clearInterval(_kitPollInterval); return; } // 100s max
    try {
      var kit = await apiFetch('/api/social/kits/' + kitId);
      var allVideosReady = ['instagram', 'tiktok'].every(function(p) {
        var v = kit.platforms[p] && kit.platforms[p].video;
        return !v || v.url; // either no video field or url is present
      });
      if (allVideosReady) {
        clearInterval(_kitPollInterval);
        _currentKit = kit;
        renderKitAccordion(kit);
      }
    } catch (e) { /* ignore poll errors */ }
  }, 5000);
}

// Queue and Posted loaders
async function loadSocialQueue() {
  var list = document.getElementById('socialQueueList');
  if (!list) return;
  list.innerHTML = '<div class="social-empty">Loading…</div>';
  try {
    var items = await apiFetch('/api/social/schedule');
    if (!items || !items.length) { list.innerHTML = '<div class="social-empty">No posts queued.</div>'; return; }
    var badge = document.getElementById('socialQueueBadge');
    if (badge) { badge.textContent = items.length; badge.style.display = ''; }
    list.innerHTML = '<div class="social-queue-list">' +
      items.map(function(ref) {
        return '<div class="social-queue-card">' +
          '<div class="social-queue-time">' + formatKitTime(ref.scheduledAt) + '</div>' +
          '<div class="social-queue-plat">' + getPlatSvg(ref.platform) + '</div>' +
          '<div>' +
            '<div class="social-queue-title">' + escHtml(ref.kitId) + '</div>' +
            '<div class="social-queue-cat">' + escHtml(ref.platform) + ' · ' + escHtml(ref.status) + '</div>' +
          '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  } catch (err) {
    list.innerHTML = '<div class="social-empty" style="color:#ef4444;">Failed to load queue: ' + escHtml(err.message) + '</div>';
  }
}

async function loadSocialPosted() {
  var list = document.getElementById('socialPostedList');
  if (!list) return;
  list.innerHTML = '<div class="social-empty">Loading…</div>';
  // For now just show a message — full posted history can be a v2 feature
  list.innerHTML = '<div class="social-empty">Posted history coming soon.</div>';
}

function viewKitMedia(platform, type) {
  if (!_currentKit) return;
  var data = (_currentKit.platforms[platform] || {})[type];
  if (!data || !data.url) { showToast('Media not ready yet'); return; }
  window.open(data.url, '_blank');
}

async function regenKitMedia(platform, type) {
  if (!_currentKit) return;
  showToast('Regenerating ' + type + ' for ' + platform + '…');
  // Trigger a media-only regen via generate endpoint with mediaOnly flag
  try {
    var kit = await apiFetch('/api/social/generate', {
      method: 'POST',
      body: JSON.stringify({
        articleId: _currentKit.articleId,
        pillar: _currentKit.pillar,
        ctaGoal: _currentKit.ctaGoal,
        kitId: _currentKit.id,
        mediaOnly: true,
        mediaPlatform: platform,
        mediaType: type,
      }),
    });
    _currentKit = kit;
    renderKitAccordion(kit);
    showToast('Media regenerated');
  } catch (err) {
    showToast('Regen failed: ' + err.message);
  }
}

function editKitSchedule(event, platform) {
  event.stopPropagation();
  if (!_currentKit) return;
  var data = _currentKit.platforms[platform] || {};
  var current = data.scheduledAt ? new Date(data.scheduledAt).toISOString().slice(0,16) : '';
  var newVal = prompt('Set scheduled time (UTC) for ' + SOCIAL_PLAT_LABELS[platform] + ':', current);
  if (!newVal) return;
  var newDate = new Date(newVal);
  if (isNaN(newDate.getTime())) { showToast('Invalid date'); return; }
  _currentKit.platforms[platform].scheduledAt = newDate.toISOString();
  apiFetch('/api/social/kits/' + _currentKit.id, {
    method: 'PATCH',
    body: JSON.stringify({ platforms: { [platform]: { scheduledAt: newDate.toISOString() } } }),
  }).then(function() {
    renderKitAccordion(_currentKit);
    showToast('Schedule updated');
  }).catch(function(e) { showToast('Update failed: ' + e.message); });
}
```

- [ ] **Step 6: Update `switchTab()` to call `loadKitArticleSelect()` when social tab opens**

Find the existing `switchTab` function. In the `if (tab === 'social')` branch (or wherever social is loaded), add:

```js
if (tab === 'social') {
  switchSocialTab('kit');
}
```

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat(social): add Kit Builder JS — generate, render, approve, deploy, poll"
```

---

### Task 15: Deploy, smoke-test, fix

**Files:**
- No new files — deploy and verify

- [ ] **Step 1: Deploy to production**

```bash
vercel --prod --yes
```

- [ ] **Step 1b: Verify no stale `switchSocialTab('generate')` callsites**

```bash
grep -n "switchSocialTab" index.html
```

Replace any `switchSocialTab('generate')` call with `switchSocialTab('kit')` — the old 'generate' tab ID no longer exists.

- [ ] **Step 2: Add required environment variables in Vercel dashboard**

Go to Vercel Dashboard → Project → Settings → Environment Variables. Add:

```
OPENROUTER_API_KEY=<your key>
FAL_KEY=<your key>
CRON_SECRET=<run: openssl rand -hex 32>
LINKEDIN_ACCESS_TOKEN=
LINKEDIN_PERSON_ID=         # LinkedIn person/organization URN (without urn:li:person: prefix)
TWITTER_API_KEY=
TWITTER_API_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_SECRET=
INSTAGRAM_ACCESS_TOKEN=
INSTAGRAM_BUSINESS_ACCOUNT_ID=
TIKTOK_ACCESS_TOKEN=
FACEBOOK_ACCESS_TOKEN=
FACEBOOK_PAGE_ID=
```

> **Note:** `LINKEDIN_PERSON_ID` was added during planning (required by the LinkedIn UGC Posts API to set the `author` URN). Obtain it from `GET https://api.linkedin.com/v2/me` after authenticating. The spec's env vars section did not list it — treat this plan as authoritative.

(Platform tokens can be blank initially — generation will work; posting will fail gracefully with "not configured" error.)

- [ ] **Step 3: Smoke test — Kit Builder generation**

1. Open https://ibdhealthhub-content-generator.vercel.app
2. Navigate to Social → Kit Builder
3. Select a published article, choose Educate pillar, Grow CTA
4. Click "⚡ Generate Kit"
5. Verify: all 6 platform rows appear with "Generated ✓" badge within 30–60s
6. Verify: Instagram and TikTok show Reel Script column
7. Verify: image tiles appear (video tiles may still show "Video generating…")

- [ ] **Step 4: Smoke test — Approve and Deploy**

1. Click "Approve All"
2. Click "🚀 Deploy Kit"
3. Navigate to Queue tab — verify scheduled posts appear

- [ ] **Step 5: Smoke test — API directly**

```bash
# Check kits list
curl https://ibdhealthhub-content-generator.vercel.app/api/social/kits

# Check schedule queue
curl https://ibdhealthhub-content-generator.vercel.app/api/social/schedule
```

- [ ] **Step 6: Fix any issues found during smoke test, commit**

```bash
git add -A
git commit -m "fix(social): address smoke test issues"
```

---

## Review Section

After implementation, verify:

- [ ] Content Kit generates for all 6 platforms in one batch
- [ ] Instagram + TikTok produce both a caption AND a Reel script (HOOK/BODY/CTA)
- [ ] Images generate via OpenRouter (not placeholder URLs)
- [ ] Videos kick off via FAL.ai and poll status correctly
- [ ] Approve + Deploy writes posts to `social:queue` KV sorted set
- [ ] Queue tab shows scheduled posts
- [ ] Cron endpoint returns 401 without `CRON_SECRET`
- [ ] Vercel function count ≤ 12 (check Vercel dashboard)
- [ ] No regression on existing social Prompt Library or Connections tabs

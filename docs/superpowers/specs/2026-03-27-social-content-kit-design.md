# Social Content Kit — Design Spec
**Date:** 2026-03-27
**Status:** Approved
**Methodology:** Ava Yuergens / @personalbrandlaunch

---

## Overview

Rebuild the IBD Health Hub Social Distribution tab to apply Ava's personal brand methodology end-to-end: structured generation using HOOK/BODY/CTA, content pillar tagging, Ava's hook archetypes and CTA system, AI-generated images and video, and real API posting to all six platforms with auto-scheduling across the week.

**Core concept — Content Kit:** One article generates one "Content Kit" in a single batch — all platform captions, Reel scripts, images, and videos. The kit is reviewed, approved platform-by-platform, then deployed. On deploy, all approved posts are written to a schedule queue and auto-distributed across the next 7 days at Ava's optimal posting times. A 5-minute cron fires each post when its scheduled time arrives.

---

## Goals

1. Apply Ava's HOOK/BODY/CTA generation structure for every post
2. Tag each kit with a content pillar (Educate/Entertain/Sell) and CTA goal (Grow/Engage/Convert/Save)
3. Generate platform-appropriate media: static images via OpenRouter, 9:16 videos via FAL.ai
4. Wire real posting APIs for Instagram, TikTok, LinkedIn, X/Twitter, Facebook
5. Auto-schedule approved posts using Ava's optimal per-platform posting windows
6. Remain within Vercel Hobby's 12-function limit

---

## Ava's Framework — Applied

### Content Pillars (user selects at kit creation)
| Pillar | Purpose | Target share |
|---|---|---|
| **Educate** | Clinical authority, attract followers | combined 70% |
| **Entertain/Relate** | Trust, personality, human story | combined 70% |
| **Sell** | Testimonials, results, offer reveals | 30% |

Ava's ratio: **70% Educate + Entertain combined, 30% Sell**. The Queue tab shows a warning badge if > 30% of currently queued posts are tagged Sell.

### Hook Archetypes (auto-selected per platform, varies across kit)
- `curiosity_gap` — "The one thing IBD patients aren't being told…"
- `bold_claim` — "You don't need paid ads to get referrals — here's what we do"
- `list_number` — "3 things clinicians miss about biologic switching"
- `relatability` — "POV: You've just reviewed 40 patients and none hit targets"
- `direct_callout` — "If you're a gastro not posting clinical updates, you're invisible"

### CTA System (one per post, matched to goal)
| Goal | CTA Template |
|---|---|
| **Grow** | "Follow @ibdhealthhub for weekly clinical insights" |
| **Engage** | "Comment [word] below if this helped" |
| **Convert** | "DM us or link in bio" |
| **Save** | "Save this for later / share with a colleague" |

### Optimal Posting Times (auto-schedule)
| Platform | Days | Times |
|---|---|---|
| Instagram | Mon, Wed, Fri | 7:00am, 12:00pm, 7:00pm |
| TikTok | Tue, Thu, Sat | 7:00am, 12:00pm, 7:00pm |
| LinkedIn | Tue, Wed, Thu | 9:00am, 12:00pm |
| X / Twitter | Mon–Fri | 8:00am, 12:00pm, 5:00pm |
| Facebook | Mon, Wed, Fri | 9:00am, 1:00pm |
| Substack | — | Copy-only, no schedule |

---

## Platform Output Specifications

### Instagram
- Caption: ≤2200 chars + 5–8 hashtags
- Hook archetype applied to first line
- One CTA matched to goal
- Reel Script: HOOK (3s) / BODY (20–25s) / CTA (5s), written for on-camera delivery
  - Short sentences ≤10 words, stage directions in brackets, conversational English
- Static image: 4:5 ratio via OpenRouter `google/gemini-2.5-flash-image` (~$0.003)
- Video: 9:16, 10s via FAL.ai `fal-ai/kling-video/v2.1` (~$0.44)
- API: Instagram Graph API — image post + Reel upload

### TikTok
- Caption: ≤300 chars + 3–5 hashtags
- Hook-first, casual tone
- Reel Script: same HOOK/BODY/CTA format as Instagram
- Video: 9:16, 10s via FAL.ai Kling (~$0.44)
- API: TikTok Content Posting API — video upload

### LinkedIn
- Post: ≤1300 chars, professional tone, data-backed insight lead, business outcome CTA
- 3–5 hashtags (professional, industry-specific)
- Static image: 1:1 via OpenRouter `sourceful/riverflow-v2-fast` (~$0.02)
- API: LinkedIn Posts API (UGC Post) — text + image

### X / Twitter
- Thread: 3 posts × ≤280 chars each, chained replies
- Concise, punchy, 1–2 hashtags per post
- No image required (optional)
- API: Twitter v2 API — post thread
- `platformPostId` stores the **first tweet's ID** in the chain (the thread root)

### Facebook
- Post: ≤2000 chars, conversational, ends with a question to drive comments
- Static image: 1:1 via OpenRouter `google/gemini-2.5-flash-image` (~$0.003)
- API: Facebook Graph API — Page post with photo

### Substack
- Teaser: ≤600 chars, compelling summary, "read more" CTA
- No posting API — copy-to-clipboard only

---

## Data Schema

### ContentKit (stored in Vercel KV)

```js
{
  id: "kit_{timestamp}",
  articleId: string,
  articleTitle: string,
  pillar: "educate" | "entertain" | "sell",
  ctaGoal: "grow" | "engage" | "convert" | "save",
  status: "draft" | "approved" | "scheduled" | "posted",
  createdAt: ISO8601,
  platforms: {
    instagram: {
      caption: string,
      hashtags: string[],
      hookArchetype: string,
      reelScript: { hook: string, body: string, cta: string, durationEst: number },
      image: { url: string, model: string, prompt: string, aspectRatio: "4:5" },
      video: { url: string, model: string, prompt: string, durationSec: 10 },
      approved: boolean,
      scheduledAt: ISO8601 | null,
      postedAt: ISO8601 | null,
      platformPostId: string | null
    },
    tiktok: {
      caption: string,
      hashtags: string[],
      hookArchetype: string,
      reelScript: { hook: string, body: string, cta: string, durationEst: number },
      video: { url: string, model: string, prompt: string, durationSec: 10 },
      approved: boolean,
      scheduledAt: ISO8601 | null,
      postedAt: ISO8601 | null,
      platformPostId: string | null
    },
    linkedin: {
      caption: string,
      hashtags: string[],           // 3–5 professional hashtags
      hookArchetype: string,
      image: { url: string, model: string, prompt: string, aspectRatio: "1:1" },
      approved: boolean,
      scheduledAt: ISO8601 | null,
      postedAt: ISO8601 | null,
      platformPostId: string | null
    },
    twitter: {
      thread: string[],           // array of 3 posts
      hookArchetype: string,
      approved: boolean,
      scheduledAt: ISO8601 | null,
      postedAt: ISO8601 | null,
      platformPostId: string | null
    },
    facebook: {
      caption: string,
      hookArchetype: string,
      image: { url: string, model: string, prompt: string, aspectRatio: "1:1" },
      approved: boolean,
      scheduledAt: ISO8601 | null,
      postedAt: ISO8601 | null,
      platformPostId: string | null
    },
    substack: {
      teaser: string              // copy-only, no posting fields
    }
  }
}
```

### KV Key Layout

```
social:kit:{kitId}              → ContentKit object  (key uses kit.id, not articleId)
social:kits:index               → list [ kitId, ... ] newest-first
social:kits:by-article:{articleId} → kitId  (one active kit per article)
social:queue                    → sorted set, score=scheduledAtEpochMs, member=postRefId
social:postref:{id}             → { kitId, platform, scheduledAt, status }
social:posted:index             → list [ postRefId, ... ] newest-first
```

**Regeneration behaviour:** Generating a new kit for an article that already has one overwrites `social:kits:by-article:{articleId}` with the new kitId. The old kit object remains in KV but is no longer reachable from the index and is not shown in the UI.

**Platform credentials:** Stored as Vercel environment variables (see Environment Variables section). The existing `sla_social_conn_{platform}` localStorage keys are used only for the Connections UI to display connection status and the user's chosen account label. Access tokens used by the cron job and post handler are read from `process.env`.

---

## API — `api/social/[...slug].js`

Single Vercel catch-all function routing to handlers in `lib/social/handlers/`.

| Method | Path | Handler | Purpose |
|---|---|---|---|
| POST | `/social/generate` | `generate.js` | Generate full kit: LLM all platforms + images + video in parallel, store in KV |
| GET | `/social/kits` | `kits-index.js` | List all kits (newest first) |
| GET | `/social/kits/:id` | `kits-id.js` | Fetch single kit |
| PATCH | `/social/kits/:id` | `kits-id.js` | Edit text, toggle approved, set scheduledAt |
| POST | `/social/deploy` | `deploy.js` | Write all approved platforms to schedule queue using their current `scheduledAt` values (honours any manual edits made via PATCH before deploy) |
| POST | `/social/post` | `post.js` | Fire one platform post immediately (called by cron or manual) |
| GET | `/social/schedule` | `schedule.js` | Return pending queue sorted by scheduledAt |
| POST | `/social/cron` | `cron.js` | Cron entry — drain due posts from queue |

---

## File Map

```
api/
└── social/
    └── [...slug].js             ← catch-all router

lib/social/
├── handlers/
│   ├── generate.js              ← LLM generation + media kickoff
│   ├── kits-index.js            ← GET /kits
│   ├── kits-id.js               ← GET/PATCH /kits/:id
│   ├── deploy.js                ← POST /deploy → write queue
│   ├── post.js                  ← POST /post → fire one post
│   ├── schedule.js              ← GET /schedule
│   └── cron.js                  ← POST /cron → drain queue
├── platforms/
│   ├── index.js                 ← post(platform, kitPlatformData, credentials) dispatcher
│   ├── instagram.js             ← Graph API image + Reel
│   ├── tiktok.js                ← Content Posting API video
│   ├── linkedin.js              ← Posts API (UGC Post)
│   ├── twitter.js               ← v2 API tweet thread
│   └── facebook.js              ← Graph API Page post
├── media.js                     ← OpenRouter image gen + FAL.ai video gen
├── ava-prompts.js               ← Hook archetypes, CTA templates, pillar system prompts
└── scheduler.js                 ← auto-schedule logic (next 7 days, optimal slots)
```

---

## Generation Pipeline (`generate.js`)

```
POST /social/generate { articleId, pillar, ctaGoal }
│
├─ 1. Fetch article from KV (contentApi)
├─ 2. Pick hook archetype per platform (rotate through 5 archetypes)
├─ 3. Parallel LLM calls (all 6 platforms via callLLM + ava-prompts.js)
│      Instagram: caption + hashtags + Reel script
│      TikTok:    caption + hashtags + Reel script
│      LinkedIn:  post text
│      Twitter:   3-post thread
│      Facebook:  post text
│      Substack:  teaser
├─ 4. Parallel media generation (non-blocking — updates kit when ready)
│      Image: free LLM → craft visual prompt → OpenRouter image model
│      Video: free LLM → craft video prompt → FAL.ai Kling (async poll)
├─ 5. auto-schedule: scheduler.js assigns scheduledAt per platform
├─ 6. Store ContentKit in KV (social:kit:{articleId})
└─ 7. Return kit to client
```

Media generation (step 4) runs concurrently but does not block the kit response. The API returns the kit immediately with `image: null` / `video: null`. Once media generation resolves within the same serverless invocation (images are fast; ~1–3s), the handler issues a self-PATCH to update the kit in KV before returning. If a video is still pending at response time (FAL.ai can take 30–60s), the client polls `GET /social/kits/:id` every 5 seconds (max 20 attempts / 100s) until `video.url` is populated. If polling times out, the video tile shows a "Retry" button that triggers a fresh `POST /social/generate` for media only.

---

## Media Generation (`media.js`)

### Images
1. Call free LLM (`deepseek/deepseek-chat-v3-0324:free`) to write a detailed visual prompt from the article + platform context
2. Call OpenRouter image model:
   - Instagram/TikTok cover: `google/gemini-2.5-flash-image`, 4:5
   - LinkedIn/Facebook: `sourceful/riverflow-v2-fast`, 1:1
3. Receive base64 data URL; store URL in kit

### Video
1. Call free LLM to write a visual scene description from the Reel script (≤200 words)
2. POST to `https://fal.run/fal-ai/kling-video/v2.1/standard/text-to-video`
   - `duration: "10"` (10-second clip, ~$0.29; sufficient for a social Reel)
   - `aspect_ratio: "9:16"`
3. Poll FAL.ai job status URL (returned in initial response) every 3s until `status === "COMPLETED"`
4. Store `output.video.url` in `kit.platforms.{platform}.video.url` via PATCH to `/social/kits/:id`

---

## Cron Job

```jsonc
// vercel.json addition
{
  "crons": [
    { "path": "/api/social/cron", "schedule": "*/5 * * * *" }
  ]
}
```

The cron route (`POST /api/social/cron`) is protected by a shared secret. Vercel passes cron requests with the header `x-vercel-cron: 1`; the handler additionally checks `Authorization: Bearer {CRON_SECRET}` (set in Vercel env vars) to prevent unauthorised triggering. Requests missing this header receive 401.

The cron handler:
1. Verify `x-vercel-cron: 1` header OR `Authorization: Bearer {CRON_SECRET}` — reject with 401 otherwise
2. `ZRANGEBYSCORE social:queue 0 {nowEpochMs}` — fetch all due postRef IDs
3. For each postRef: `ZREM social:queue {postRefId}` atomically before posting (prevents double-fire)
4. Load kit from KV, call `platforms/index.js` dispatcher — credentials read from `process.env`
5. On success: PATCH kit to set `platforms.{platform}.postedAt` and `platformPostId`; prepend ID to `social:posted:index`
6. On failure: re-enqueue postRef with `score = nowEpochMs + 1800000` (30-minute retry); log error to console (visible in Vercel function logs)

---

## UI Changes (`index.html`)

### Social tab sub-tabs (replaces current Generate / Prompt Library split)
1. **Kit Builder** — article selector → pillar → CTA → Generate Kit → accordion review per platform → Deploy Kit
2. **Queue** — timeline of scheduled posts; click to edit/cancel
3. **Posted** — history of sent posts with platform post ID
4. **Prompt Library** — existing, enhanced with Ava's default templates
5. **Connections** — existing social credentials panel

### Kit Builder accordion — per platform row
- Platform logo (monotone SVG, official)
- Generated / Generating / Error badge
- Hook archetype label
- Media badges (Image ✓ / Video ✓)
- Approve / Approved toggle
- Scheduled time picker (editable)
- Expand → three-column body: Caption | Reel Script | Media tiles

### Reel Script format (Instagram + TikTok only)
```
HOOK  (first 1–3s — stops the scroll)
BODY  (value delivery — numbered or flowing, ≤25s)
CTA   (single action, 5s)
Duration estimate in seconds
```

---

## Environment Variables Required

```
OPENROUTER_API_KEY=        ← image generation (OpenRouter)
FAL_KEY=                   ← video generation (FAL.ai)
CRON_SECRET=               ← shared secret for /social/cron auth (generate: openssl rand -hex 32)

# Platform posting APIs (added to existing set)
INSTAGRAM_ACCESS_TOKEN=
INSTAGRAM_BUSINESS_ACCOUNT_ID=
TIKTOK_ACCESS_TOKEN=
LINKEDIN_ACCESS_TOKEN=
TWITTER_BEARER_TOKEN=
TWITTER_API_KEY=
TWITTER_API_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_SECRET=
FACEBOOK_ACCESS_TOKEN=
FACEBOOK_PAGE_ID=
```

---

## Vercel Function Budget

Current known functions (pre-build):

| # | Function |
|---|---|
| 1 | `api/content/[id].js` |
| 2 | `api/content/index.js` |
| 3 | `api/automation/[...slug].js` |
| 4 | `api/calendar/[...slug].js` |
| 5 | `api/github/[...slug].js` |
| 6 | `api/publish.js` |
| 7–8 | `api/cron/*.js` (existing) |
| **9** | **`api/social/[...slug].js`** ← new (handles ALL social routes including `/social/cron`) |

The `/api/social/cron` cron path is handled by `api/social/[...slug].js` — the slug value is the string `"cron"`. No separate `api/social/cron.js` file is created (that would intercept the catch-all and violate CLAUDE.md routing rules).

Remaining headroom: **3 of 12**. Acceptable.

---

## Out of Scope (future)

- Engagement analytics (likes, comments, reach) — requires webhook subscriptions per platform
- Instagram Stories — separate Graph API endpoint; add in v2
- Canva-style in-app image editor
- Multi-account posting (multiple Instagram/LinkedIn accounts)
- Substack posting API (does not currently exist)

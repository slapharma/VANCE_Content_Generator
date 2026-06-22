# Learnings from alpha (vancecontent → Beta)

Append-only log of project-specific learnings, fixes, gotchas, and architectural notes from working on **vancecontent** (alpha) that should reach **Beta** (CliftonAi-Content, project `SCF-Multi-Agency`) and downstream brand iterations.

## How this works

This file rides the ship pipeline. Every time alpha's `main` is merged into Beta's `main`, this file flows with it. Beta-side sessions reading their own project root will find this file in `docs/learnings-from-alpha.md` and pick up everything that landed since the last ship.

**Scope**: project-specific learnings only. Universal learnings (Windows path quirks, tool gotchas) go to `~/.claude/lessons.md` which is global. The split rule:

- Specific to vancecontent's architecture, schema, prompts, deploy, KV layout, or Vance-the-brand → here.
- Applies to *any* project I open → `~/.claude/lessons.md`.

When in doubt: prefer this file. False positives here are cheap (Beta gets a slightly off-topic note). False negatives in the global file are expensive (the same mistake gets re-made on another project).

## Format

```
### YYYY-MM-DD — Short title
- **Context**: what I was doing / what changed
- **Finding**: what I learned / what surprised me
- **Implication for Beta**: how this affects the multi-tenant / agency code
- **Tag**: #kv / #auth / #routing / #prompts / #deploy / #brand-identity / #ship-pipeline / #wizard / #ui
```

The "Implication for Beta" field is the key one — it forces the entry to be useful at the destination, not just a memo to self.

---

## 2026-05-15 — `lib/kv.js` `KV_PREFIX` wrapper is the load-bearing tenancy primitive

- **Context**: Auditing vancecontent for the multi-tenant retrofit (the SCF-Multi-Agency plan).
- **Finding**: Every KV call routes through `p(key) = ${PREFIX}${key}`. A static env var (`KV_PREFIX=vance`) silently namespaces the entire database. This pattern was added as a Hobby-tier cost hack (share Upstash across projects) and is the single most important file for the multi-tenant pivot.
- **Implication for Beta**: Refactoring `p(key)` to read from AsyncLocalStorage instead of a static env var is a one-file change that unlocks request-scoped tenancy for every handler downstream. **Do not** refactor handlers to pass tenant context — just refactor `lib/kv.js`. Phase 1 of the plan.
- **Tag**: #kv

## 2026-05-15 — Vercel catch-all uses `req.query['...slug']` (three literal dots), and subdir handlers hijack it

- **Context**: Reading `api/automation/[...slug].js` for the agency-tenancy wrapping point.
- **Finding**: Two non-obvious things: (1) the query key is the literal string `'...slug'` with three dots, not `'slug'`; (2) any file at `api/automation/rules/index.js` (or similar subdirectory) routes there *instead of* the catch-all, **even if listed in `.vercelignore`**.
- **Implication for Beta**: The catch-all is exactly the right place to add `withTenant()` AsyncLocalStorage wrapping — single entry point for ~25 sub-handlers under `lib/automation/handlers/`. Beta inherits this. **Never** create subdir handler files; keep new handlers inside `lib/automation/handlers/` and import them into the catch-all.
- **Tag**: #routing #ship-pipeline

## 2026-05-15 — Wizard pattern (`wizPanel1`–`5` + `openRuleWizard`) is reusable, but element IDs must be distinct per wizard

- **Context**: Designing the brand-provisioning wizard for Beta's super-admin console.
- **Finding**: Vancecontent has a 5-panel wizard pattern at `index.html:7507` (`openRuleWizard`). Pattern works because only one wizard is in the DOM at a time. But element IDs (`wizName`, etc.) are bare — reusing them in a second wizard would collide.
- **Implication for Beta**: Mirror the pattern exactly but prefix all new IDs with `brandWiz` (`brandWizName`, `brandWizSlug`, `brandWizPanel1`, etc.). Worth extracting `makePanelNavigator(prefix, total)` into a tiny helper so both wizards share the show/next/back logic.
- **Tag**: #wizard #ui

## 2026-05-15 — 38 files reference "Vance" / "vancemedicalfoods" — brand string refactor target

- **Context**: `grep -ri 'vance\|vancemedicalfoods\|vance-content'` across vancecontent.
- **Finding**: 38 files. ~21 are real refactor targets (UI copy, prompts, email templates, fallbacks). The rest are scripts, data files, or comments that can stay. Full inventory in `SCF-Multi-Agency/docs/brand-string-inventory.md`.
- **Implication for Beta**: Phase 3 strips brand strings out and replaces with `getBrand()` / `renderBrandString()` calls. Re-run the grep before Phase 3 to catch any drift in the file count.
- **Tag**: #brand-identity

## Template for new entries (copy-paste below)

```
### YYYY-MM-DD — Short title
- **Context**:
- **Finding**:
- **Implication for Beta**:
- **Tag**: #
```

## 2026-06-02 — Hero image prompts are now KV-backed and per-category

- **Context**: Added a hero image prompt manager — global default + reusable presets on the LLM page, and a per-category override in the category editor.
- **Finding**: Hero prompts now live in a single KV record `vance:hero-prompts` = `{ default, presets[], categories{} }`, served by `api/content/hero-prompts.js` (GET any auth, PUT admin/content, **partial-merge** so the LLM page and Categories page can each save their slice without clobbering). Resolution is shared in three places and must stay in sync: `lib/social/media.js` (`buildDirectHeroPrompt(title, template)` + exported `DEFAULT_HERO_PROMPT_TEMPLATE`), `lib/automation/handlers/run.js` (loads the record once per run, resolves `categories[rule.category] || default`, passes into `generateImageFast(title, '16:9', template)`), and `index.html` (`getResolvedHeroPrompt(catId, topic)` for the manual generator). `{topic}`/`{title}` tokens are substituted; templates with no token get the subject appended.
- **Implication for Beta**: This is per-brand config — the `vance:hero-prompts` key must become tenant-scoped via the same `lib/kv.js` `p(key)` prefix primitive (Phase 1). The 3-way resolution duplication is a maintenance hazard; if Beta refactors, consider extracting a single shared resolver. The category editor writes the override to KV separately from the GitHub-backed custom-categories file, so per-category hero prompts do NOT travel with the custom-categories JSON — they're keyed by category id in the KV record instead.
- **Tag**: #kv #prompts #brand-identity

## 2026-06-03 — Prompt-name → WP sub-category routing ("by prompt") for single-source categories

- **Context**: Replicating the Gastro Living sub-category behaviour for Clinical Review. Gastro Living gets its sub-category from the bulk-upload xlsx `Sub-Category` column — but Clinical Review is a single-source category (one paper → one article, generated in-browser), so there is no spreadsheet row to carry a sub-category.
- **Finding**: The publish path (`api/publish/index.js` + `lib/wp-taxonomy.js`) is already category-agnostic: any content record carrying `subCategory` is resolved by slug-then-name and attached as a child term alongside the parent. The only gap for single-source content was *attaching* a `subCategory`. Solution: route by the active prompt preset name. Added `PROMPT_SUBCATEGORY_MAP` + `getActivePromptName()` + `subCategoryForActivePrompt()` in `index.html`, and stamped `subCategory` onto all three in-browser create paths (`queueCurrentForPublishing`, `toggleApproved`, `toggleQueueItem`) plus the archive entry in `saveReviewToArchive` so the review→queue path carries it. Mapping for clinical-reviews: "Clinical Abstract Patient" → `Patients Overview` (patients-overview), "Clinical Abstract Practitioner" → `Practitioners Overview` (practitioners-overview). `slugify()` confirms the display names produce the exact WP slugs the user pre-created, so publish resolves the existing terms instead of auto-creating duplicates. A patient/practitioner substring heuristic makes preset-name variants forgiving.
- **Implication for Beta**: This is the generic pattern for routing single-source content into sub-categories without a spreadsheet. For the multi-tenant layer, `PROMPT_SUBCATEGORY_MAP` should become per-tenant config (each agency/brand defines its own prompt→sub-category routing) rather than a hardcoded const. Note: automation rules store prompt *text*, not the preset *name*, so cron-driven generation can't use this name-based routing — automation still needs the xlsx `Sub-Category` column (or a `subCategory` field added to the rule schema).
- **Tag**: #prompts #ui #brand-identity

## 2026-06-03 — Google Drive sources had NO per-file dedup — relied solely on the modifiedTime window

- **Context**: Operator reported Drive-sourced generations re-using docs that were already generated from earlier the same day.
- **Finding**: Of the file-based sources, only `upload` (consumedUrls/consumedTitles) and `bibliography` (paper.processed) had per-item "already generated" tracking. `google_drive` had none — dedup depended entirely on `modifiedTime > lastRunAt` in `fetchGoogleDrive`. That window silently fails to exclude already-processed docs in three common cases, all of which re-generate: (1) manual "Run now" passes `lastRunAt=null` so the window is dropped and the whole folder comes back; (2) a file re-saved in Drive gets its modifiedTime bumped past lastRunAt; (3) a run that errored before line ~1077 never advances lastRunAt. Fix: added `source.consumedFileIds` (filtered in `fetchGoogleDrive`, bypassed by `forceAll`), attached `fileId`/`sourceFolderId` to Drive items, append to consumedFileIds after each successful content store in run.js, and normalised the field in rule-schema. Same shape/lifecycle as the upload consumed* arrays.
- **Implication for Beta**: Beta inherits the same `cloud-drives.js` / `fetch.js` / `run.js` / `rule-schema.js`. Carry this forward. When the agency layer clears/edits rules, treat `consumedFileIds` exactly like `consumedUrls`/`consumedTitles` (preserve on round-trip; expose a "clear to re-process" affordance). The modifiedTime window is a coarse pre-filter only — never the authoritative dedup.
- **Tag**: #automation #kv #wizard

## 2026-06-03 — Patient/practitioner WP sub-category routing existed only in the browser, not in cron

- **Context**: Operator reported clinical-review patient/practitioner sub-categories not reaching WordPress for automation-generated articles.
- **Finding**: `subCategoryForActivePrompt()` (index.html) maps the active prompt preset NAME → WP sub-category ("Patients Overview"/"Practitioners Overview") via `PROMPT_SUBCATEGORY_MAP`, and the in-browser generator sends `subCategory` on the /api/content POST. The cron path (run.js) had no equivalent — it only set `subCategory` from upload-spreadsheet rows — so Drive/bibliography-sourced clinical reviews published under the parent category only. Compounding it, the rule persisted only the prompt TEXT (`generation.prompt`), never the prompt NAME, so run.js had no signal to map. Fix: wizard now also saves `generation.promptName` (`_wizGetSelectedPromptName()`), rule-schema persists it, and run.js has a server-side mirror `subCategoryForRulePrompt(rule)` (same map + patient/practitioner substring heuristic) whose result is passed as `subCategory` (per-row upload subCategory still wins). NOTE: the earlier `migrateClearRulePromptsOnce` migration blanked `generation.prompt` on existing rules; existing clinical-review rules therefore have no promptName until re-saved in the wizard — they'll keep publishing parent-only until re-saved with a named patient/practitioner preset.
- **Implication for Beta**: Beta shares index.html + run.js + rule-schema. Keep the browser map (`PROMPT_SUBCATEGORY_MAP`) and the run.js mirror in sync — they are duplicated by necessity (one client, one server). If the agency layer adds per-tenant sub-category taxonomies, both copies need the tenant-aware map. Any new generation entry point (besides browser + cron) must also derive subCategory or it silently regresses.
- **Tag**: #prompts #wizard #brand-identity

## 2026-06-04 — Kit Builder article selector: dead `loadDistribution` refresh path + over-restrictive status filter

- **Context**: Social page "Article" selector (`kitArticleSelect`) stopped showing recent articles.
- **Finding**: Two compounding bugs. (1) `loadKitArticleSelect` filtered out `status === 'published'` while the placeholder said "Choose a published article" — recently published articles silently vanished. (2) Its cache (`allSocialItems`) was only refreshed by `loadDistribution()`, which early-returns on `if (!listEl) return` because `socialArticleList` was removed when the Kit Builder UI replaced the old distribution list — making the refresh path dead code. Result: the stale-cache early-return served an old list for the whole session. Fix: filter now only excludes `trash`, and the function paints from cache then always re-fetches via `contentApi.getAll()` (preserving the current selection).
- **Implication for Beta**: If Beta inherited the Kit Builder, check its `loadKitArticleSelect`/`loadDistribution` pair for the same dead refresh path. General pattern: when a UI section is removed, grep for functions that early-return on its element IDs — they may be the only refresh trigger for shared state used elsewhere.
- **Tag**: #ui

## 2026-06-16 — Reviewer subheading highlights silently failed to anchor (Chromium uppercases `Selection.toString()`)

- **Context**: Email-link review page (`api/review/[token].js`) lets reviewers highlight passages; the structured `{quote, comment}` pairs are re-anchored on the in-app article view by `_ahWrapMatch` in `index.html` (wraps the matching text in a `<mark>` so "Reviewer notes" can scroll to it).
- **Finding**: Highlights on **section subheadings** never produced a `<mark>` (the note showed but clicking it scrolled nowhere). Root cause: the review email styles section headers as `<h2 ... text-transform:uppercase>` (see `lib/email-content.js` `S.h2`). Chromium/WebKit return the **CSS-transformed (uppercase)** text from `Selection.toString()`, so the stored quote is uppercase while the article body renders mixed-case. `_ahWrapMatch` built a **case-sensitive** `RegExp`, so the match silently failed only for headings. Fix: build the regex case-insensitively (`new RegExp(pattern, 'i')`).
- **Implication for Beta**: Any feature that round-trips selected text from a CSS-`text-transform`ed surface back to a raw-text match must normalise case (and ideally whitespace). If Beta reuses the review widget / `_ahWrapMatch`, it inherits both the fix and the gotcha. More broadly: treat `Selection.toString()` as the *rendered* string, not the source string.
- **Tag**: #ui

## 2026-06-16 — Per-article history layer: `lib/article-history.js` (auditLog + capped body snapshots)

- **Context**: Added an Approval Log tab + before/after document diff. Needed a who/when/what trail and version snapshots for diffing (pre/post compress, pre/post edit, pre/post AI-revise).
- **Finding**: Introduced `lib/article-history.js` with `logEvent(item, …)` (append-only `item.auditLog[]`) and `snapshotBody(item, …)` (push current body to `item.versions[]`, capped at `MAX_VERSIONS=10`). Wired at every body-mutation choke point: `api/content/[id].js` PUT (actor = `getCurrentUser(req)`), `api/review/[token].js` POST (actor = reviewerId), `api/content/[id]/apply-revision.js`, and `lib/automation/handlers/run.js` `enforceWordLimit`. The approval-log timeline pairs a snapshot to its event by **matching identical ISO `at` timestamps**, so any call site must pass one shared `at` to both `snapshotBody` and `logEvent` (the compress path originally let them default to two near-but-unequal timestamps — bug).
- **Implication for Beta**: This data rides on the content item in KV, so Beta inherits it automatically. If Beta adds new body-mutation paths, call both helpers with a shared `at`. The capped `versions[]` bounds KV growth; don't remove the cap without re-checking the boot-fetch size budget (full `/api/content` is already ~38MB — the Approval Log deliberately uses `?slim=1` for the list and lazy-fetches full records per card on expand).
- **Tag**: #kv #ui

## 2026-06-16 — `ghGetFile` double-decoded the >1MB download_url path ("URI malformed")

- **Context**: Saving a generated hero image triggered "Saved locally but GitHub sync failed: Corrupt JSON in data/ibd-living/reviews.json: URI malformed". Only large categories hit it.
- **Finding**: `ghGetFile` reads a GitHub file two ways. Inline base64 (files ≤1MB) → `atob()` yields a Latin-1 binary string that must be revived with `decodeURIComponent(escape(...))`. But GitHub returns `content:""` for files >1MB, and the fallback `await dlRes.text()` is ALREADY UTF-8-decoded. The old code ran BOTH paths through `decodeURIComponent(escape(...))`, so once `reviews.json` grew past 1MB any non-ASCII char (em dash, curly quote, accent) made `decodeURIComponent` throw "URI malformed". Fix: branch on `data.content` — base64 path does the escape dance, download_url path takes `text()` verbatim.
- **Implication for Beta**: This is latent in any category until its JSON crosses 1MB, then it breaks silently on the next sync. Beta shares this exact `ghGetFile`; ensure the fix ships. General rule: `Response.text()` is decoded; `atob()` output is not — never mix the two decode strategies.
- **Tag**: #deploy

## 2026-06-16 — Dedicated view-article page via relocating the shared `#articlePanel`

- **Context**: #7 wanted a sidebar-less view-article page separate from the Generate tab, but the article display + toolbar + edit/highlight/diff logic all hang off one DOM block (`.article-panel`) that the generator also streams into.
- **Finding**: Rather than duplicate ~500 lines of edit/comment/highlight wiring, the panel is a single shared component relocated at runtime: `switchTab('article')` → `appendChild` it into the bare `#articleViewMount`; `switchTab('generator')` → move it back into `#genLayout` (it's the 2nd grid child, so order is preserved). View-only toolbar controls (edit-title, comment, view-changes, source/prompt badges) are shown on view and hidden when the panel returns to the generator. App-user comments post to `api/content/[id]/comment.js` and share the reviewer `rejectionComments` stream (tagged `viaApp`, `authorName`).
- **Implication for Beta**: If Beta diverges the generator layout, keep the two mount points (`#genLayout`, `#articleViewMount`) and the single `#articlePanel`. Moving a DOM node preserves its listeners, so this is safe — but anything that caches element references across the move must re-query by id, not hold the node from the old parent.
- **Tag**: #ui

## 2026-06-16 — Two article stores: Library tab = KV, but "Save to Library" wrote to the GitHub archive

- **Context**: Auditing why in-app comments/edits needed a `currentContentId`. Found a deeper mismatch: the Library tab (`loadLibrary`) reads ONLY KV `/api/content`, but the "Save to Library" / "Save as New" button (`saveReviewToArchive`) wrote to the GitHub `ghData[cat].reviews` store — so saved items never appeared in the Library the button is named after.
- **Finding**: There are two parallel stores. KV `/api/content` backs the Library tab, Pipeline, Monitoring, Approval Log, and `viewArticleFromPipeline`. The GitHub `data/<cat>/reviews.json` (`ghData`) now only powers dashboard/category **counts** and the **AI Comparison** item pool — its article grid (`renderArchiveLegacy`) and the archive-based item loader (`loadArchiveItem`) were already dead code (removed this session). Fix: `saveReviewToArchive` now also `contentApi.create`s a KV draft (so it shows in Library + sets `currentContentId`), while keeping the ghData write so counts/comparison stay intact.
- **Implication for Beta**: If Beta inherited the unified KV Library, audit every "save"/"archive" affordance to confirm it writes to KV, not ghData. The cleaner long-term fix is to migrate counts + the Comparison pool to read KV and retire the per-category `reviews.json` entirely — until then, manual saves dual-write. Note the editor escape gotcha: large blocks in `index.html` mix literal `…`/`✓` escapes with real chars, so string-match edits fail — splice by line with a guarded Node script instead.
- **Tag**: #kv #ui

## 2026-06-16 — Automation rule had no concurrency lock → duplicate articles per title

- **Context**: A content audit found two articles for one approved title ("Pregnancy and IBD", created 5s apart; also a "Fighting Fatigue with IBD" pair). The daily cron fires once at 07:00, but these were created mid-morning — i.e. from repeated manual "Run now" clicks.
- **Finding**: `runHandler` had no lock. Two overlapping invocations both read the rule, both saw the same `source.consumedTitles` snapshot, both picked the same next unconsumed title, and both generated it. Compounding it: `consumedTitles` lives *inside* the rule object that's rewritten wholesale after each article (`kv.set('automation:rule:<id>')`), so even sequential-but-overlapping runs lose each other's consumed writes (run A marks X consumed; run B, which never saw X, overwrites the rule and erases it). Fix: a per-rule lock at the top of the `for (const rule of dueRules)` loop — `kv.set('automation:rule:<id>:run-lock', now, { nx: true, ex: 310 })`; skip the rule if not acquired; `kv.del` in a `finally`. NX makes it atomic; TTL (just over the 300s `maxDuration`) is a crash backstop. `@vercel/kv`'s `set` already supports `{nx,ex}` — no kv-wrapper change needed.
- **Implication for Beta**: Beta shares this exact `run.js` and is multi-tenant, so concurrent runs are *more* likely (multiple agencies, more triggers). Ship this lock. Better long-term: move `consumedTitles`/`consumedUrls` out of the rule blob into an atomic Redis SET (`sadd` returns newly-added count = a free claim primitive) so per-title claims are race-proof AND survive the lost-write problem without serializing the whole rule. The lock is the minimal fix; the SET is the principled one.
- **Tag**: #kv #deploy

## 2026-06-16 — UI tab navigation was slow because every tab re-fetched the full 38 MB `/api/content`

- **Context**: User reported moving between screens was slow. Each list tab (Pipeline, Distribution, Monitoring, Trash, Library) independently called `contentApi.getAll()` → unslimmed `/api/content` (every article `body`, plus `versions[]` body snapshots), causing a multi-second network + `JSON.parse` main-thread freeze on *every* navigation. No shared client cache.
- **Finding**: The only render-time need for bodies was a word count. Fix in three parts: (1) **`?slim=1` now strips only the heavy fields** — `body`, `versions` (full prior-body snapshots, the sneaky one — `{...i}` spread leaks them), `auditLog` — and adds a server-computed `wordCount` via `lib/word-count.js` `countBodyWords`. Result: 38 MB → ~46 KB for 42 items. (2) A shared `contentCache` (stale-while-revalidate, `sig` = `count:maxUpdatedAt` change-detection) feeds every list tab via a `withContent(render)` helper; `contentApi.getAll()` itself now delegates to `contentCache.refresh()` (all remaining callers are metadata-only). Body-dependent *actions* (social-post gen, article view) lazy-fetch the single record via `/api/content/:id` — and `viewArticleFromPipeline`/`viewTrashedArticle` were fixed to fetch by id instead of `getAll().find()`. (3) History-API routing (`#tab` hashes + `popstate`) so Back/Refresh keep the current tab, and a ~15s active-tab poll (paused when hidden) for near-instant cross-user sync — both reuse the same tiny slim payload.
- **Implication for Beta**: Beta shares `index.html` + `api/content/index.js`, so it has the same slow-navigation problem and the same fix applies wholesale. **Critical for the multi-tenant build**: the slim payload MUST strip `versions`/`auditLog`, not just `body` — a naive `{...i, body:undefined}` re-leaks the version body snapshots and undoes the win. The ~15s poll is the cheap path to the "agencies see each other's changes live" expectation; true push (Pusher/Ably/Supabase Realtime) is the upgrade if instant is required, but KV has no native push channel.
- **Tag**: #ui #routing #kv #deploy

### 2026-06-22 — Article heading hierarchy + bullets need both a prompt rule AND a converter that supports them
- **Context**: Generated articles ran lists of named items (e.g. specific genes under "Key genes involved in IBD") together as paragraphs instead of sub-headers; bullet usage was inconsistent across articles.
- **Finding**: Two independent gaps. (1) The master prompt (`vance:master-prompt` in KV; code default `MASTER_PROMPT_DEFAULT` in index.html) only defined `#`/`##` and had a vague "Use bullet points and sub-headlines where appropriate" line — too weak to be deterministic. (2) `markdownToWpHtml` in `api/publish/index.js` flattened `### ` to `<h2>` and had **no list handling at all**, so `- item` became literal `<p>- item</p>`. Fixing only the prompt would have produced markdown the converter then destroyed.
- **Fix**: Added an explicit `[STRUCTURE & FORMATTING]` block to the master prompt (one `### ` sub-heading per enumerated item; bullets for parallel/scannable lists, prose for narrative; Practical Takeaways must be bulleted) and changed OUTPUT FORMAT to permit `### `. Rewrote `markdownToWpHtml` to emit `<h3>` for `### ` and group consecutive `-`/`*`/`•` into `<ul>` and `1.`/`1)` into `<ol>`.
- **Implication for Beta**: Beta inherits the same converter and (per-tenant) master prompts. The converter fix flows via ship pipeline automatically. For prompts, Beta stores master prompts per tenant under the `KV_PREFIX` wrapper — the structure rules must be seeded into each tenant's master-prompt default, not just one global key. The live prompt is canonical in KV; editing the index.html code default alone does nothing if KV is populated.
- **Tag**: #prompts #publish #kv #brand-identity

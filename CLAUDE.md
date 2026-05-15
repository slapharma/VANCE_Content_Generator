# VANCE Content Generator — Claude Context

## Related projects (added 2026-05-15)

- **Beta / agency platform**: `C:\Users\clift\.claudeprojects\SCF-Multi-Agency` (a.k.a. CliftonAi-Content). Beta is a clone-and-extend of this project that adds the multi-tenant agency layer + serves as public showcase. Changes here (alpha) flow downstream to Beta via the ship pipeline — see `SCF-Multi-Agency/docs/topology.md`. **Don't touch SCF-Multi-Agency from this folder** — Beta lives on the `cliftonflack` GitHub account, this project may be on a different one.
- **Stale brand iterations**: `merlows.vercel.app` (merlowscontent), `ibdhealthhub.vercel.app` (ibdhealthcontent) — to be re-onboarded onto Beta in Phase 7 of `SCF-Multi-Agency/docs/plan.md`.

## Propagating learnings to Beta

Any project-specific learning, fix, gotcha, or architectural note discovered while working here that should also reach Beta (and downstream brand iterations) → **append to `docs/learnings-from-alpha.md`** using the format defined at the top of that file. The ship pipeline merges that file forward automatically alongside code. Universal learnings (Windows quirks, tool gotchas not specific to this project) still go to `~/.claude/lessons.md`. When in doubt, prefer `docs/learnings-from-alpha.md` — false positives are cheap, false negatives are expensive.

## Architecture
- **Single-file app**: entire UI lives in `index.html` (inline JS/CSS). No build step.
- **No local dev server**: verify by deploying — `vercel --prod --yes`. Never run preview_start for this project.
- **ES Modules**: `"type": "module"` in package.json; all imports must use `.js` extension.
- **KV persistence**: `@vercel/kv` for all data. Env vars: `KV_REST_API_URL`, `KV_REST_API_TOKEN`.

## Branding
- This project is **Vance Medical Foods** (vancemedicalfoods.com)
- Production URL: `https://vance-content.vercel.app` (Vercel project: `vance-content-generator`)
- All prompts, emails, headers, and UI must reference "Vance Medical Foods" / "vancemedicalfoods.com".

## Deployment
- GitHub auto-deploy is **disabled** (`"github": {"enabled": false}` in vercel.json).
- Deploy: `vercel --prod --yes` from the repo directory (re-link Vercel project to `vance-content-generator` first if needed).
- **Vercel Pro** (upgraded 2026-05-14): unlimited functions, `maxDuration: 300` on both catch-alls, up to 40 cron jobs. Hobby workarounds lifted — see `.claude/vercel-pro-audit-20260514.md` for full list.

## Vercel Routing (Critical)
- All automation routes handled by `api/automation/[...slug].js` (single catch-all).
- In non-Next.js Vercel: slug key is `req.query['...slug']` (three literal dots), NOT `req.query.slug`.
- Multi-segment paths arrive as a **slash-joined string** (e.g. `'rules/abc'`), not an array — always `split('/')`.
- **Never create** subdirectory handler files (`api/automation/rules/index.js` etc.) — they intercept the catch-all even if listed in `.vercelignore`.
- Handler logic lives in `lib/automation/handlers/` (doesn't count toward function limit).

## UI Patterns
- Tab switching: `switchTab('tab-name')` — tab views are `<div id="view-tab-name">`.
- All tabs registered in `allTabs` array inside `switchTab()` — add new tabs there.
- Wizard: 5-step rule wizard uses shared element IDs (`wizName`, `wizPanel1`–`5` etc.) — only one instance in DOM at a time.
- `openRuleWizard(editId?)` navigates to `view-automation-new`; `closeRuleWizard()` returns to `automation-rules`.
- CSS variable `--radius: 0px` globally — all corners square by design.
- Category SVG icons: `getCatSvgIcon(catId)` — used on both dashboard and categories page. Add new categories here.

## API Patterns
- All handlers export a named function + default Vercel handler.
- Reviewer data shape: `{ id, name, email, role }` — role is `'must_approve'` | `'reference'`.
- `api/reviewers/index.js` supports GET, POST, PATCH (role update), DELETE.
- **Auth endpoints** live under `/api/auth/*` (login, logout, me, change-password) — split out from reviewers in the Pro upgrade.
- **Content sub-routes**: `/api/content/master-prompt`, `/api/content/ab-config`, `/api/content/usage-record`, `/api/content/usage-summary`, `/api/content/[id]/ai-revise`, `/api/content/[id]/apply-revision`.
- Two admin-only diagnostic endpoints stay piggy-backed on `/api/content?action=`: `email-diagnostic` and `backfill-review-sync` (no client callers, invoked via curl).
- Shared user CRUD helpers (`loadUsers`, `saveUsers`, `buildUser`, `safe`, `validUser`) live in `lib/users.js`. Revision-LLM helpers (`callRevisionLLM`, `buildRevisionPrompt`) live in `lib/revise.js`.

## OpenRouter Models
- Free models use `:free` suffix (e.g. `google/gemma-3-27b-it:free`).
- MiniMax exception: `minimax/minimax-m1:extended` (free tier, extended context variant).
- Fallback chains: `FALLBACK_MODELS` (general) and `INFOGRAPHIC_MODELS` (structured content).

## Telegram Bot
- Token and chat ID stored as Vercel env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- Webhook secret: `TELEGRAM_WEBHOOK_SECRET`. Verified via `x-telegram-bot-api-secret-token` header.
- Test endpoint: `GET /api/automation/telegram-test`.

## Stop Hook
- The `[Preview Required]` stop hook from plugins does not apply to this project — there is no local dev server. Ignore or disable it.

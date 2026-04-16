# VANCE Content Generator — Claude Context

## Architecture
- **Single-file app**: entire UI lives in `index.html` (inline JS/CSS). No build step.
- **No local dev server**: verify by deploying — `vercel --prod --yes`. Never run preview_start for this project.
- **ES Modules**: `"type": "module"` in package.json; all imports must use `.js` extension.
- **KV persistence**: `@vercel/kv` for all data. Env vars: `KV_REST_API_URL`, `KV_REST_API_TOKEN`.

## Branding
- This project is **Vance Medical Foods** (vancemedicalfoods.com)
- Production URL: `https://vance-content-generator.vercel.app`
- All prompts, emails, headers, and UI must reference "Vance Medical Foods" / "vancemedicalfoods.com".

## Deployment
- GitHub auto-deploy is **disabled** (`"github": {"enabled": false}` in vercel.json).
- Deploy: `vercel --prod --yes` from the repo directory (re-link Vercel project to `vance-content-generator` first if needed).
- Vercel Hobby plan: **12 serverless function limit** — do not add new files under `api/`.

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

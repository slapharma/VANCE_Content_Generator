# Handover: hero-image-prompts feature + automation 500

**To:** the session/terminal that holds `.git/index.lock` on `VANCE-Content-Generator`
**From:** Cowork session (read-only git access; could not take the lock)
**Date:** 2026-06-02
**Repo:** `C:\Users\clift\.claudeprojects\VANCE-Content-Generator`

---

## TL;DR

The hero-image-prompt feature (your PR #18) was deployed straight from branch
`feature/hero-image-prompts`, it crashed `POST /api/automation/run` (HTTP 500),
and the remote branch was then deleted — which rolled production back to the
last `main` build and **fixed automation**. The feature commits now live **only
in this local clone** and are unbacked-up. There are also redundant uncommitted
edits in the working tree from a parallel Cowork session that must be discarded.

Nothing below can proceed until this session **releases `.git/index.lock`**
(a stale lock file is currently present — see step 0).

---

## Current repo state (verified)

- **HEAD / current branch:** `feature/hero-image-prompts`
  - `946f629` Update stale Gastro Health Hub identity strings to Vance branding
  - `a955e6b` Add configurable hero image prompt library + multi-column xlsx parsing
  - parent: `86c4c11` (tip of `main`)
- **`origin/main`:** still at `86c4c11` — the feature was **never merged to main**.
- **`origin/feature/hero-image-prompts`:** **DELETED** (was `git push origin --delete`).
  → `946f629` and `a955e6b` exist **only** in this local clone. No remote backup.
- **Production (Vercel):** rolled back to the `main` build `86c4c11` after the branch
  delete. Automation `run` works again on this build.
- **Uncommitted working-tree edits (parallel Cowork session — REDUNDANT):**
  - `M index.html`
  - `M lib/automation/handlers/run.js`
  - `M lib/social/media.js`
  - (a Cowork `Write` also re-created `api/content/hero-prompts.js`, which already
    existed in `a955e6b` — treat the committed version as canonical.)
  These re-implement the same feature `a955e6b` already contains. **Discard them.**
- **Stale lock:** `.git/index.lock` (0 bytes, dated 09:12). If no git process is
  actually running, it is safe to delete.

---

## Why automation broke and then "fixed itself"

- The crash logged as `POST /api/automation/run` with no status code = the function
  threw at runtime. All touched files parse cleanly (`node --check` passes), so it
  is a **runtime fault introduced by the feature build** (`a955e6b`/`946f629`), not a
  syntax/module-load error.
- Deleting the remote branch made Vercel revert the production alias to the previous
  `main` deployment (`86c4c11`), which predates the feature → no more 500.
- **Conclusion:** the bug lives in `a955e6b` (or `946f629`). Do **not** re-deploy that
  build as-is.

### Diagnosis not yet pinned — likely areas

The new run-path code in `a955e6b` is mostly inside the per-rule `try/catch` in
`lib/automation/handlers/run.js` (those would be caught and returned as `200` with
`results.errors`, not a platform 500). A platform 500 implies an **unguarded throw**
outside that try, or a timeout. Start here:

1. Code that runs **before/outside** the per-rule `try` in the `run` handler:
   `migrateClearRulePromptsOnce()`, `processTimeouts()`, and the top-level
   `kv.get` / `kv.lrange` rule loads.
2. `lib/automation/rule-schema.js` (+20 lines in `a955e6b`) — check whether new
   required fields cause validation to throw on **pre-existing** rules.
3. `lib/automation/fetch.js` multi-column xlsx parsing — new `source.rows` handling;
   check behaviour on legacy rules that have no `rows`.
4. `api/publish/index.js` + new `lib/wp-taxonomy.js` if the failing rule has
   auto-publish enabled.
5. A 300s function timeout (Pro `maxDuration`) if the rule generates many articles
   (LLM + up to 90s hero image each).

The real stack trace is the fastest path: open the failing `POST /api/automation/run`
request in **Vercel → the feature deployment → Logs/Observability** (deployment
`dpl_4ssAAi1HzFzob6Zcco3GkobUgdbb`, project `vance-content-generator`,
team `team_wfWc4ILtXQU6jPvk2dgfnApj`). The MCP log API truncated function-level
messages; the dashboard shows the full trace.

---

## Recommended next steps (in order)

### 0. Release the lock
```bash
# Make sure NO git/editor process is mid-write first, then:
rm -f .git/index.lock
git status        # confirm sane
```

### 1. Preserve the feature commits BEFORE anything else (no remote backup exists)
```bash
git branch backup/hero-image-prompts-20260602 feature/hero-image-prompts
git push origin backup/hero-image-prompts-20260602
# (or re-push the original name if you prefer:)
# git push origin feature/hero-image-prompts
```
Do not delete the local `feature/hero-image-prompts` branch until this push succeeds.

### 2. Discard the redundant Cowork working-tree edits
These duplicate `a955e6b` and only add confusion:
```bash
git restore index.html lib/automation/handlers/run.js lib/social/media.js
git checkout -- api/content/hero-prompts.js   # restore the committed a955e6b version
git status --short                            # expect: clean (aside from pre-existing noise)
```
> Note: the working tree also shows unrelated pre-existing dirty files
> (`.superpowers/**`, `.env.example`, many `api/**`) that are NOT from this work —
> leave those to your own judgement; they predate the Cowork session.

### 3. Fix the 500 on the feature branch (do NOT re-deploy until green)
- Get the stack trace (see Diagnosis above), patch the offending file on
  `feature/hero-image-prompts`.
- Re-test the automation run. Deploy is via `vercel --prod --yes` (GitHub
  auto-deploy is disabled for this project per `CLAUDE.md`).
- Verify `POST /api/automation/run` returns `200` and a real article is produced
  with a hero image before promoting.

### 4. Only then re-open / re-merge
- Re-create the PR from the restored branch, or merge into `main` once the run is
  verified green.

---

## Guardrails

- **Do not** re-push/re-deploy `946f629` as the production build until the run 500 is
  fixed — it will break automation again.
- **Do not** drop the local `feature/hero-image-prompts` branch until step 1 confirms
  a remote backup exists. It is currently the only copy.
- The Cowork session will **not** make git writes; all git actions above are yours.

---

## Quick reference

| Item | Value |
|---|---|
| Feature commits (local only) | `a955e6b`, `946f629` |
| Base | `86c4c11` (tip of `main`) |
| `origin/main` | `86c4c11` (no feature) |
| `origin/feature/hero-image-prompts` | deleted |
| Vercel project | `vance-content-generator` (`prj_TwMIwfqWRpygsMkQzbzUfAt5AimU`) |
| Vercel team | `team_wfWc4ILtXQU6jPvk2dgfnApj` |
| Crashing build | `dpl_4ssAAi1HzFzob6Zcco3GkobUgdbb` (feature branch) |
| Working main build | `86c4c11` |
| Redundant uncommitted files | `index.html`, `lib/automation/handlers/run.js`, `lib/social/media.js`, `api/content/hero-prompts.js` |

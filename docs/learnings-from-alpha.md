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

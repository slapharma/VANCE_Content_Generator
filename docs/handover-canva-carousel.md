# Handover: Canva carousel integration

Written 2026-07-29. Self-contained: everything a fresh session needs to continue without
re-deriving anything. Companion reading is `tasks/todo.md` (the two 2026-07-29 sections) and
`docs/learnings-from-alpha.md` (the two 2026-07-29 entries).

---

## 1. Where things stand

**As of 2026-07-30 the live artifacts are the three published brand templates in section 6.** Their
source designs were consumed by publishing (trap 6) and no longer exist, so there is nothing to
edit by hand: to change a template, either edit it via the cycle in trap 10, or regenerate and
reimport from `scripts/build-canva-style-decks.mjs` (section 4) — the latter is cheap and is what
the 2026-07-30 rebuild did.

Folder: Vance-Social Media Kit — `FAHQyMs34l4` — https://www.canva.com/folder/FAHQyMs34l4

Each deck is 8 pages at 1080x1350, FIXED pages, real editable text, carrying the real two-tone
Vance mark, with 14 autofill placeholders whose text is the app's own field name. The published
templates inherit all of that.

### Stale objects to delete (no delete API — do it in the Canva UI)

Updated 2026-07-30 after the rebuild. Most of the earlier list is already gone — the operator's
cleanup pass removed nine templates, and the mistaken publishes consumed the logo-less duplicate
designs. What remains:

**Brand templates to delete (3), all pre-rebuild leftovers:**

- `EAHQxC4zKec` (Education) and `EAHQxHHuL0w` (Breaking News) — the flat v1s. Both are tagged, so
  they DO appear in the app's picker alongside the real ones. Deleting them is what makes the
  picker show exactly three.
- `EAHQyMgJHYY` (Breaking News) — the accidental untagged publish. Hidden from the picker by the
  `dataset=non_empty` filter (trap 12), so harmless, but delete it: its navy cover reads as
  Education at a glance, which is what caused the wrong-template confusion in the first place.

Keep only `EAHQ2VHRuUU`, `EAHQ2RZD31o`, `EAHQ2cILWCE` (section 6).

**Designs to delete:** the smoke-test decks minted by preview runs, titled `check-education-template`
and `ZZ …- safe to delete`. Each `canva-template` preview mints a real design; that is expected and
is the cost of the smoke test.

---

## 2. The two open pieces of work

**Both resolved 2026-07-29.** 2a: done — option 1 below was implemented; `listBrandTemplates` now
applies the `DESIGN_PREFIX` convention (sent as the Canva search term, re-checked with
`startsWith`), so brand templates are the intentional repository and the folder stays human
organisation only. 2b: DROPPED by operator decision — Canva is for one-off or planned promotion
campaigns and series, not the general educational automation content, so satori remains the only
automation renderer and no `renderer` field is added to automation rules. The blockers listed under
2b are kept below as the record of why full replacement was rejected.

### 2a. Make brand templates (or the folder) the repository the app offers — DONE

Today `lib/social/canva.js` filters **designs** by title prefix:

```js
export const DESIGN_PREFIX = 'Vance Carousel - ';
```

sent to Canva as the search term and re-checked with `startsWith` (the search is fuzzy and matches
body content, so both passes are needed). That took the picker from 25 designs to 3.

The operator wants the **folder** to be the source of truth, ideally, or the brand template list.

**Hard constraint, already investigated — do not re-litigate:** Canva's folder-items endpoint is
**not exposed by Composio**. Probing `COMPOSIO_GET_TOOL_SCHEMAS` for `CANVA_LIST_FOLDER_ITEMS` /
`CANVA_GET_FOLDER_ITEMS` / `CANVA_LIST_ITEMS_IN_FOLDER` returns not-found with only
`CANVA_POST_FOLDERS` (create-folder) suggested. The app therefore **cannot ask what is in a
folder** through the connection it actually uses. The Canva MCP connector *can* (`list-folder-items`),
but that is an interactive assistant connector, not something a Vercel function can call.

So the realistic options are:

1. **Brand template list as the repository** (recommended). `listBrandTemplates()` already exists
   and returns only deliberately published templates — a much smaller, more intentional set than
   designs. Apply the same `DESIGN_PREFIX` filter to it for consistency. This is probably what the
   operator actually wants, since a template is a publish decision.
2. Keep the design prefix filter as-is and treat the folder as human organisation only.
3. Add a Composio custom tool / direct Canva REST call for folder items. Only worth it if the
   folder specifically must be the control surface. Would need a Canva token the app can use,
   which it does not currently have (everything goes through Composio).

### 2b. Renderer selectable on automation rules — DROPPED (see above)

Agreed design: **satori stays the default and the fallback.** The `renderer` field
(`vance` | `canva-design` | `canva-template`) already exists on promo campaigns in
`lib/social/promo-schema.js`. Extend it to automation rules so article carousels can opt into Canva.

Touch points: `api/automation/rule-schema.js` (add the field, default `vance`), the automation run
path that calls `renderAndHost`, and the rule wizard in `index.html`.

Blockers this design routes around rather than solves — they are why full replacement was rejected:

- **Slide count.** Decks are 1-10 slides and `planSlides` drops slides for short ones. A brand
  template has a FIXED page count, so an 8-page template only ever makes 8-slide decks.
  **Fall back to satori below 8** rather than maintaining a template per count per style (~40).
- **Hero photos.** Article decks put the article image on cover and CTA. Needs image fields tagged
  in the template plus a Canva asset upload and poll per deck. Current templates have none.
- **Education's citation.** Journal, authors, study type and sample size have no autofill fields,
  so the evidence slide degrades to takeaway-only on the Canva path.
- **Promotional style has no template yet** — it is the fourth style (`PROMO_STYLE`).
- **Latency.** Autofill job + poll, export job + poll, then re-hosting 8 images on WordPress,
  against a 300s function limit the daily cron shares across many decks.

---

## 3. API traps that cost real time — do not rediscover these

1. **`publish-brand-template` reports failure on success.** It creates the template, then errors
   reading it back: `Not allowed to access brand template with id 'EA…'`. **Always** check that id
   with `get-brand-template-dataset` before retrying, or you publish duplicates.
2. **Autofill jobs are not export jobs.** `/v1/autofills/{id}`, not `/v1/exports/{id}`. The slug is
   `CANVA_RETRIEVE_DESIGN_AUTOFILL_JOB_STATUS`. Using the export slug returns 403
   `permission_denied`. Already fixed in `lib/social/canva.js`; do not "tidy" it back.
3. **The brand-template LIST endpoint does not return the dataset.** Only id/title/thumbnail/urls,
   whatever the `dataset=non_empty` filter suggests. So `fields` is normally `[]`.
   `buildAutofillData` treats an empty list as *unknown* and sends every candidate name — safe
   because **Canva's autofill ignores keys the template does not declare** (verified by autofilling
   a live 14-field template with a deliberately bogus key and getting a clean 8-page design).
4. **Composio's semantic tool search is not a reliable index of its own toolkit.** The autofill
   status slug was never returned by any phrasing. It was found by guessing a name and reading the
   "did you mean" suggestion from `COMPOSIO_GET_TOOL_SCHEMAS`. **Probe with guessed slugs before
   concluding a tool does not exist.**
5. **`POST /api/social/promos/preview` needs the campaign nested as `{"promo": {...}}`.** A flat
   body silently builds a default campaign and fails with "needs a campaign brief, a CSV message or
   a topic". A preview persists nothing to KV or WP — but it *does* mint a real Canva design,
   because that is what autofill does.
6. **Publishing consumes the design.** After publishing, the source design disappears from the
   designs list.
7. **Fixed pages never reflow siblings.** Canva's import freezes flow layout into absolute
   positions, so any box sized to its placeholder is overrun by the first real autofill. The
   generator reserves the height each field's longest realistic copy needs — that is what the
   visible whitespace under placeholders is for. Do not "tighten" it.
8. **The importer drops alpha on text colours** and lands on `#000000`. The generator flattens every
   `MUTED.*` value against its known ground first (`#BFC6CF` on ink, etc). This is exact, not an
   approximation: alpha over a known opaque ground is the calculation the measured contrast ratios
   already assume.
9. **The importer will not resolve data URIs for images.** The Vance mark is a base64 PNG in
   `lib/social/assets/logo.js`; the generator decodes both variants to files served next to the HTML
   and references them by HTTPS URL.
10. **`create-brand-template-draft` is permission-denied on EVERY template** — including ones this
   connector itself published ("User does not have permission to access brand template with id
   'EA…'", the draft-side sibling of trap 1). The edit cycle that actually works:
   `create-design-from-brand-template` (the copy RETAINS the autofill tags, visible as
   `dataFieldLabel` on elements) → `edit-design` → commit → `publish-brand-template`. This mints a
   **NEW template id every time** — the old template survives unchanged and must be deleted in the
   UI, and anything storing the old id must be repointed.
11. **Never "find" a design by title as a stand-in for a template's draft.** Two chip-fix runs did
   exactly that, grabbed the stale logo-less duplicates (same titles as the keepers), and published
   them — producing the junk templates `EAHQyCMzQEo` (0 fields) and `EAHQyAYHmBE` (2 fields). The
   only safe source for editing a published template is `create-design-from-brand-template` on that
   template's id.
12. **The picker's `dataset=non_empty` filter DOES work server-side** (verified 2026-07-29 against
   the live account): fully-untagged templates are excluded from the list even though the list
   still never returns the dataset itself (trap 3). Partially-tagged junk (e.g. 2 of 14 fields)
   still shows.

---

## 4. How the decks are produced

`scripts/build-canva-style-decks.mjs` emits one self-contained HTML deck per style, reading every
colour, size and gutter from `lib/social/carousel-theme.js` and mirroring the layout functions in
`lib/social/carousel-render.js`.

```bash
cd C:\Users\clift\Ai-Projects\VANCE-Content-Generator
node scripts/build-canva-style-decks.mjs
```

Then: deploy (the files are served at `/canva-styles/*`), import each via
`import-design-from-url`, and **delete the files and redeploy** — they exist only to be fetched once.

**Never export the app's renderer to get an editable file.** Satori outlines every glyph to paths,
so anything that pipeline produces is flat artwork with no text.

**The three styles are genuinely different** — this was got wrong once by reading `STYLES` in
`carousel-theme.js` and stopping. `STYLES` holds only grounds and labels. The real variation is in
`carousel-render.js`: **nine layout functions plus a `POINT_STYLE` table**.

| | Cover | Inner slides | Close |
|---|---|---|---|
| Education | scrimmed photo, bottom-anchored, outlined swipe box | paper, ink chip, thin primary rule | evidence: citation block on paper |
| Relatable | unscrimmed photo between two solid white cards | **white**, primary chip, thick rule, rotated tinted backdrop | **Vance teal #006868**, white eyebrow |
| Breaking News | ink alert strip + BREAKING_BG headline band | **navy, white chip, white headline**, accent rule | BREAKING_BG, ink throughout |

Education's cover carries **no logo** by design (`educationCoverSlide`: "Category tag only"), so it
has 7 marks to the others' 8. That is correct, not a bug.

---

## 5. Autofill field names

14 per deck, matching `buildAutofillData` in `lib/social/canva.js`. Matching is case-insensitive and
ignores separators, so `Hook Title` / `hook_title` / `hookTitle` are equivalent.

`eyebrow`, `hookTitle`, `brief`, `point1`–`point4`, `point1body`–`point4body`, `update`, `cta`,
`domain`.

`update` is the closing slide on every style (it maps to `spec.update.body`). Only `text` fields are
filled; fields with no matching value are left alone rather than blanked.

---

## 6. Publish status

Tagging applies `update_autofill_field` to each of the 14 placeholders (8 `edit-design` calls per
deck, one per page, since all operations in a call must target the same page), then a commit, then
`publish-brand-template`.

**STATUS: REBUILT 2026-07-30. These are the LIVE template ids:**

| Style | Live brand template | Source design |
|---|---|---|
| Education | `EAHQ2VHRuUU` | `DAHQ2RnK7pQ` (consumed) |
| Relatable | `EAHQ2RZD31o` | `DAHQ2ZKaLdY` (consumed) |
| Breaking News | `EAHQ2cILWCE` | `DAHQ2QWxqS8` (consumed) |

Each dataset was confirmed via `get-brand-template-dataset`: all 14 canonical field names, all
`{"type":"text"}`. Field distribution landed exactly as expected (page 1: eyebrow + hookTitle;
2: brief; 3-6: pointN + pointNbody; 7: update; 8: cta + domain). Education's page 7 static citation
placeholders (journal, authors, study type, sample size) were left untagged deliberately — they
have no autofill fields, per section 2b's blocker list. The CTA chip is the widened one (the fix
is now in the generator, so every future import has it).

**Why a rebuild.** The first generation (2026-07-29) published fine, but the account then held ten
same-titled templates with near-identical navy thumbnails and no visible ids in the Canva UI. A
cleanup pass deleted the three good ones and kept three wrong ones. Rebuilding from
`scripts/build-canva-style-decks.mjs` cost about fifteen minutes, which is the real lesson: **the
decks are cheap to regenerate and the ids are disposable, so never hand-reconcile a pile of
same-titled templates — delete broadly and rebuild.** To make that recoverable rather than
alarming, avoid letting duplicates accumulate: delete the superseded template immediately after
every republish, while you still know which id is which.

**Template ids are NOT stable across edits — see traps 10-11.** Every edit-and-republish mints a
new EA id; whatever stores a template id (campaigns store `canvaBrandTemplateId`) must be repointed
after any template revision, and the superseded template deleted in the UI.

End-to-end verified against `EAHQ2VHRuUU` on 2026-07-30: 8 slides, one per page, every field
filled, CTA chip holding "SHOP THE RANGE" (the themed default now applied by `promo-run.js` when a
campaign sets no `ctaLabel` — autofill has no draw time, so satori's draw-time fallback chain is
resolved before the payload is built).

The runbook below is kept for tagging fresh imports (e.g. the future Promotional style). For
EDITING an existing published template, do NOT use this runbook — see trap 10's cycle instead.

The run, per deck:

1. `read-design` with `open_transaction: true` and `filter.fields: ["design_content"]` to get the
   locator ids. Element ids are not predictable, so this read is unavoidable.
2. Eight `edit-design` calls, one per page — all operations in a call must target the same page.
   Pages 1, 3, 4, 5, 6 and 8 carry two fields each; pages 2 and 7 carry one.
   Op shape: `{type: 'update_autofill_field', element_id: '<locator>', autofill_field_label: '<name>'}`.
   The locator id from `read-design` IS the `element_id`.
3. `edit-design` with `finalize: "commit"` and empty operations.
4. `publish-brand-template` with the design id — **expect the false error in trap 1 above.**
5. Confirm with `get-brand-template-dataset` on the id from the response.

Budget roughly 11 calls per deck, ~33 total. Each `edit-design` response is large (full page
document plus a thumbnail image), so this is best run in a session that starts fresh with little
else in context. Record the resulting `EA…` template ids back into this section when done.

Then end-to-end:

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"promo":{"name":"check","renderer":"canva-template","canvaBrandTemplateId":"<ID>","canvaFields":[],"messagingMode":"topic","topic":"A medical food for people with IBD.","slideCount":8,"ctaDomain":"vancemedicalfoods.com"}}' \
  https://vance-content.vercel.app/api/social/promos/preview
```

Expect 8 slides, one per template page, each a Canva export URL. It persists nothing to KV or WP.

---

## 7. How the two renderers stay in sync (operator question, answered 2026-07-29)

The operator asked whether the satori templates could be updated periodically FROM Canva. They
cannot, and it is worth recording why so the idea is not re-litigated: satori's layouts are code
(nine layout functions in `carousel-render.js` reading constants from `carousel-theme.js`), while a
Canva edit is freeform absolute-positioned artwork. Canva can only export images of a design, not
structured styles, so there is nothing machine-readable to sync back. The division of labour is:

- **Canva template edits flow to Canva decks automatically.** Autofill reads the live template, so
  an operator improving a published template (via `create-brand-template-draft` → edit → republish)
  changes every future `canva-template` deck with no app change.
- **Satori changes are made in `carousel-theme.js` / `carousel-render.js`**, and flow FORWARD to
  Canva by re-running `scripts/build-canva-style-decks.mjs` and re-importing — regenerate from
  tokens, never sync from artwork.
- Satori remains the default and the only automation renderer; Canva is the promo-campaign surface.

## 8. Project conventions

- No local dev server. Verify by deploying: `npx vercel --prod --yes` from the repo root.
- `tasks/` is gitignored, so `tasks/todo.md` never shows in `git status`.
- Project learnings go in `docs/learnings-from-alpha.md`, in the format at its top.
- No em dashes in generated content or prose.

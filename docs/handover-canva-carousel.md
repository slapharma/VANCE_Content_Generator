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
   *How many lines a box actually holds:* `height = (lines - 1) × fontSize × lineHeight +
   fontSize × 1.19`. The last line takes the font's bounding box, not a full leading step, so
   the obvious `height / (fontSize × lineHeight)` under-reports by a whole line on nearly every
   slot. Solved 2026-08-04 from four V2 Education boxes against their exported artwork, and
   implemented in `.claude/skills/canva-promo-template/scripts/capacity.mjs`.
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
14. **Composio and the Canva MCP connector disagree about the separator in a title.** Verified
   2026-07-31 by querying both for the same id: Composio (the path the app uses) returns
   `EAHQ8c2j3xE` as `Vance Carousel - Dashboard` with a **hyphen**; the Canva MCP connector
   returns it as `Vance Carousel — Dashboard` with an **em dash**. Worse, copying a template
   through the MCP connector (`create-design-from-brand-template`, the trap 10 edit cycle) writes
   the em dash into the copy for real, so the templates republished on 2026-07-31 genuinely carry
   one and an exact hyphen match drops all four.
   Fixed by `isHouseTitle()` in `lib/social/canva.js`, which compares on letters and digits only.
   **Never compare a Canva title with `startsWith` on a punctuated prefix, and never trust one
   connector's rendering of a title as ground truth for another's.**
   *Correction to an earlier draft of this note: the em dash was NOT why the operator's original
   templates were missing from the picker. Under the old hyphen filter production returned six
   templates including Dashboard, Health Quiz and Meal Planner. Only Vance-Ai was absent, and the
   cause was the `dataset=non_empty` filter (it had no autofill fields at all), not the title.*
15. **Brand templates do not appear in folder listings.** Even the Canva MCP connector's
   `list-folder-items` returns `[]` for the "Vance-Social Media Kit" folder after the operator
   filed all three templates into it in the UI — folder listings cover designs, folders and
   images, not brand templates. So filing templates in a folder is useful human organisation and
   nothing more: it is invisible to every API surface, which closes off option 3 in section 2a for
   good, on top of Composio not exposing folder-items at all.
17. **`add_text` cannot be given a font, and no other operation can fix that.** Elements created
   by `add_text` land in the design's default face; `format_text` exposes size, colour,
   alignment, line height, italic and bold, but no font family, and only `normal`/`bold`
   weights, so a `thin` display face is unreachable. There is also no duplicate-element op, so
   the display face cannot be cloned from the element that already has it. **Splitting a styled
   text element in two is therefore not something the API can finish** — one half always lands
   in the wrong typeface. Learned the expensive way on the V2 Education cover 2026-08-04:
   split, published, then unpicked and republished as a merge, costing two template ids. Either
   do the split in the Canva UI, or keep the text as one element and accept that everything in
   it is autofilled together.
18. **A design created by `create-design-from-brand-template` keeps the ORIGINAL page and
   element locator ids**, not just the `dataFieldLabel` tags. Verified 2026-08-04: the copy of
   `EAHRT0smcak` carried `PBv79ZNnChrbdJsK-LB8vGKRcZBWgQf9T` exactly as the source did. So a
   mapping table written against a published template stays valid through the trap 10 edit
   cycle, and the `read-design` in step 1 is a confirmation rather than a rediscovery. Do not
   assume the reverse and skip it: unverified ids are how the wrong element gets tagged.
19. **A text box can be WIDER than its clear area, and the overflow is clipped, not wrapped.**
   Distinct from trap 7 and worse. On the V4 Gastro Living cover the headline box sat at
   `left: 108` with `width: 864` (right edge 972) while the photo panel started at **x=857**.
   The photo is layered in front, so every line longer than ~10 characters slid *underneath* it
   and was cut off mid-glyph — "EASE BLOATING" lost its G. An overrun is ugly but readable; this
   is silently truncated. **Nothing in the CDF flags it**: you only see it by comparing a text
   element's `left + width` against the `left` of a neighbouring image on the same page, or by
   exporting real copy. Fixed with `resize_element` (text elements take width only; height
   auto-calculates), which converts the failure back into an honest wrap.
20. **A box's CDF height is its CURRENT RENDERED CONTENT height, not a ceiling.** Canva text boxes
   auto-size to their copy, so `scripts/capacity.mjs` reports the line count the designer laid
   out, which is a sensible budget but not the limit. The real ceiling is the vertical gap to the
   next element below: generous on V2 Gastro Living (a whole circle of clear space), 35px — under
   half a line — between every headline and body on V4. Read the script's output as "what the
   design intends", then check the gap to the neighbour for "what it will tolerate".
21. **An open editing transaction is a snapshot, not a live view.** The operator renamed a design
   in the Canva UI on 2026-08-04 while a transaction was open on it; the transaction still held
   the old title and committing would have silently reverted the rename. Caught by re-reading
   `design_metadata` *outside* the transaction and re-applying `update_title` before finalising.
   Any UI edit made after `read-design` is invisible to the transaction and is overwritten on
   commit. **When a session spans operator activity, re-read metadata before committing.**
22. **Autofill replaces TEXT but not PARAGRAPH PROPERTIES, and a list marker is a paragraph
   property.** On V3 Gastro Living page 2 the visible "1." was not in the text at all — it came
   from `listMarker=decimal, level=1`, while pages 3-6 had "2." to "5." typed into their text with
   no marker. Tagging all five as `point{N}` would therefore have left page 2 showing "1." in
   front of the generated copy while pages 3-6 lost their numbers entirely: five slides, one
   numbered, four not, and nothing in the returned spec to show it. The same applies to
   `textAlign` (page 2 was `justify` against the others' `start`) — it survives the fill too.
   **Read `listMarker`, `level` and `textAlign` on every element you tag, not just the text**, and
   normalise them with `format_text` (`list_level: 0` removes the marker) before publishing.
   Numbering that must survive belongs inside the autofilled value, per trap 17's logic.

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

### Three-slide promo decks (operator-built 2026-07-30, retagged and republished 2026-07-31)

A second family, hand-built in the Canva UI rather than generated by
`scripts/build-canva-style-decks.mjs`. Three pages at 1080x1350, nine text elements, seven
distinct autofill fields. The house arc compressed: cover, points, close.

**These are the LIVE ids. Repoint any campaign storing an old one.**

**REBUILT 2026-07-31 from `scripts/build-canva-promo-decks.mjs`.** The hand-built decks were
replaced wholesale: new fonts (Horizon headings, Montserrat body, Neo Tech name label), per-deck
ground sequences, the Vance mark in place of the URL, and the template name at the top of every
slide. Regenerate and reimport rather than editing these by hand — see section 4's rule, which
applies here too: regenerate from tokens, never sync from artwork.

| Deck | Live brand template | Superseded, DELETE in the UI | Source design |
|---|---|---|---|
| Dashboard | `EAHQ8-pwhWs` | `EAHQ89A02z0` | `DAHQ8_QcC68` (consumed) |
| Health Quiz | `EAHQ8_7MNbo` | `EAHQ89A3lkc` | `DAHQ85CegBU` (consumed) |
| Meal Planner | `EAHQ83g4UH0` | `EAHQ8_XwtMM` | `DAHQ8xaK7R0` (consumed) |
| Vance-Ai | `EAHQ8wTqna0` | `EAHQ89Kp2gM` | `DAHQ84dd-Xs` (consumed) |

Field layout, confirmed on all four via `get-brand-template-dataset` (7 fields):

| Page | Ground (Health Quiz shown) | Fields |
|---|---|---|
| 1 cover | teal | `headline`, `subhead` |
| 2 points | white | `point1`, `point1body` |
| 3 close | navy | `update`, `note`, `ctaLink` |

`domain` is GONE: the URL was replaced by the Vance mark on every slide, and only the closing
slide carries a link, as `ctaLink`.

**Grounds are per-deck and text colour is derived, not configured.** `inkFor()` in the generator
picks white or dark from the ground's luminance and THROWS at build time if the best available
option is under 7:1. Change a ground and the type inverts itself or the build fails. The brand
kit's teal `#008080` is deliberately NOT a ground — white on it is 4.77:1, worse than the
`#006868` that Note 2 in carousel-theme.js already rejected. Grounds use `#004d4d` (9.68:1) and
`#008080` survives as an accent, where the 3:1 non-text floor applies. Likewise the light purple
`#8e7dbe` is accent-only: 3.60:1 with white, 4.38:1 with dark, both large-text-only.

**Known limit: headline length.** `TYPE.coverHead` is calibrated against the satori font; Horizon
is much wider. Measured on the first import, a 33-character headline set FOUR lines in the 936px
column. `buildPromoSpec` permits hookTitle up to ten words, which would overrun — and a fixed
Canva page never reflows (trap 7), so it overlaps rather than pushing down. The generator now
uses 72px covers and 520px of reserved height, but **the four templates published on 2026-07-31
were built at the earlier 84px/360px and are safe to about six words.** Regenerate and reimport
to lift that.

`domain` is shared across pages 1 and 2 deliberately: Canva writes a value to **every** element
carrying that label, and it is the same bare URL on both. Page 3's URL is a separate `ctaLink`
field precisely because it is not the same string — it carries an action prefix
("Go to dashboard → ..."), which a shared `domain` would have overwritten.

**`ctaLink` needed no code change.** It matches nothing in `buildAutofillData`'s vocabulary, so
it travels as an unknown CSV column through `spec.customFields` and is sent to Canva under its
own name. That path is the intended extension point for any future template field: add a column,
tag the element, done.

**Trap 16: every page was tagged with the SAME three names.** As built, all three pages carried
`headline`/`subhead`/`domain`, and Vance-Ai carried none at all. Colliding names are worse than
missing ones, because the dataset dedupes by name and reports a tidy three fields, which reads as
correct: only at autofill time would Canva stamp identical copy onto all three slides. Retagging
pages 2 and 3 into the points and close vocabulary is the fix. **When a multi-page template's
dataset looks suspiciously small, suspect collision before assuming the pages are untagged.**

Three code changes this family forced, all 2026-07-31:

- **`subhead` and `note` mapped to nothing** in `buildAutofillData`. `subhead` is now an alias of
  the brief; `note` maps to `spec.cta.note`.
- **`cta.note` was operator-only config** and usually blank, so page 3's second line had no
  generated source at all. `buildPromoSpec` now asks the model for `ctaNote`, with the campaign's
  own value still winning when set.
- **`pointCount`, `hasBrief` and `hasClose` are forced for `canva-template`.** Those thresholds
  describe slides *satori* draws; a Canva template's page count is fixed in Canva and the
  campaign's `slideCount` has no say over it. A three-slide campaign generated no points at all,
  leaving `point1` and `point1body` unfilled.

**VERIFIED END TO END 2026-07-31**, after deploy, via `POST /api/social/promos/preview` in
`messagingMode: 'csv'` driven by `docs/promo-csv/promo-3-slide.csv`: all four decks exported 3
slides with **8/8 fields carrying the CSV value verbatim**, confirmed on the artwork as well as
in the returned spec.

**An unfilled field keeps the design's existing text, it does not blank.** On these hand-built
decks that is the designer's own copy, so an unfilled slide publishes looking entirely normal
while repeating itself every occurrence. On the generated house decks the retained text is the
field name itself, so those fail loudly with "point1" on the artwork. The loud version is the
lucky one. Verified 2026-07-31 by exporting a live preview of `EAHQ8lfv6lg` against the
pre-fix production build: page 1's headline came through as generated copy while its `subhead`
kept the hand-written line, and pages 2 and 3 were entirely original.

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

### Seven-slide education carousel (operator-built 2026-08-04)

A third family, and the first built by the operator in the Canva UI from a stock layout rather
than generated from tokens. Seven pages at 1080x1350: cover, five numbered point slides, close.

| Deck | Live brand template | Superseded, DELETE in the UI | Source designs |
|---|---|---|---|
| V2 Education | `EAHRUQch1WM` | `EAHRT0smcak` | `DAHRTxa6iH0`, `DAHRUXLWkr4` (both consumed) |

**20 fields**, all `{"type":"text"}`: page 1 `hookTitle` + `subhead`; pages 2-6 `point{N}` +
`point{N}quote` + `point{N}body` for N = 1..5; page 7 `update` + `note` + `cta`.

**`hookTitle` on this deck carries two lines, including the leading count** (`"5\nGut Habits"`).
That is a consequence of trap 17, not a preference — see section 4.1 of the mapping doc. It
means a non-CSV messaging mode can rewrite the count to a number that contradicts the five point
slides, so keep this template on CSV.

`point{N}quote` is a field this app does not model, so it travels through `spec.customFields`
and **only fills in `messagingMode: 'csv'`** — the same extension point `ctaLink` uses. The
full audit, per-slot capacity measurements, the outstanding defects and a ready CSV header are
in `docs/canva-v2-education-mapping.md`. Read that before touching this template: three known
problems (a wrong typeface on the cover number, display boxes sized for phrases against
sentence-length fields, and no link element anywhere) are best fixed in one republish cycle
rather than three.

**VERIFIED END TO END 2026-08-04** via `POST /api/social/promos/preview` in `messagingMode:
'csv'`: 7 slides exported, all 20 fields carrying the CSV value verbatim, confirmed on the
downloaded artwork for pages 1, 2, 5 and 7 as well as in the returned spec. Re-verified against
`EAHRUQch1WM` after the cover merge — both headline lines export in the display face.

Being hand-built, this deck cannot be regenerated from tokens the way sections 4 and the promo
family can. It is the one template where the artwork IS the source, so the trap 10 cycle is the
only way to change it and losing the id means rebuilding by hand.

### Gastro Living carousels (operator-built 2026-08-04)

A fourth family, also hand-built in the Canva UI. Three decks that share a name and nothing else.

| Deck | Live brand template | Fields | Pages | Superseded, DELETE in the UI | Source designs |
|---|---|---|---|---|---|
| V2 Gastro Living | `EAHRUbI_kV0` | 10 | 5 | — | `DAHRULz8eq8` (consumed) |
| V3 Gastro Living | `EAHRUQAAU7c` | 12 | 6 | — | `DAHRUDTV-OY` (consumed) |
| V4 Gastro Living | `EAHRUZDydoc` | 8 | 4 | **`EAHRUTCPrzw`** | `DAHRT9UEaXI`, `DAHRURBD38s` (consumed) |

V2: `eyebrow`, `hookTitle`, `point1`-`point3` + bodies, `update`, `domain`. Cover, three point
slides, recap. Comfortable capacity throughout and **safe in `topic` mode**.

V3: `hookTitle`, `subhead`, `point1`-`point5` + bodies. Cover plus five point slides, no close and
no link. **Every text element is fillable — this deck has no static text at all.** Its cover
headline is a single non-wrapping line of about 31 characters, the tightest slot in the family, and
carries the list count. Its numbering was built two different ways (an automatic list marker on
page 2, typed numbers on pages 3-6) and was normalised so the number now travels inside the
`point{N}` value. **Keep it on CSV.** The VANCE mark is missing from pages 3 and 5.

V4: `eyebrow` (shared across all four pages, deliberately), `hookTitle`, `point1`-`point3` +
bodies. Cover plus three point slides, **no close slide and no link anywhere**. Three display
headline slots are hard-capped at 2-4 lines against an 8-word generator cap, so **keep it on CSV**.
Its cover is a two-part lockup whose static "How to" means `hookTitle` must grammatically complete
the phrase — which no messaging mode except CSV can be relied on to do.

No deck in this family uses `customFields`, so unlike V2 Education all three fill in every
messaging mode.

Full audit, per-slot capacities, element tables and CSV headers:
`docs/canva-gastro-living-mapping.md`. **VERIFIED END TO END 2026-08-04** on downloaded artwork.

---

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

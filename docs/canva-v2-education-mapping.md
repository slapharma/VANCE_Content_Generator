# Canva "Vance Carousel - V2 Education" — content audit and autofill field map

Design `DAHRTxa6iH0` — 7 pages, 1080x1350, all FIXED.
Edit: https://www.canva.com/design/DAHRTxa6iH0/vWRJy4O_Pch7kH26cZuceg/edit

Audited 2026-08-04, at element level across all 7 pages.
Companion reading: `docs/handover-canva-carousel.md` sections 3, 5 and 6.

**STATUS: PUBLISHED 2026-08-04. Live brand template id `EAHRUQch1WM`.**
20 fields, all `{"type":"text"}`, no name collision, confirmed via `get-brand-template-dataset`
and verified on exported artwork.

**Superseded, DELETE in the Canva UI: `EAHRT0smcak`** (the first publish, which shipped the
wrong cover typeface). Both source designs are consumed and gone (trap 6): `DAHRTxa6iH0` and
`DAHRUXLWkr4`. Any campaign storing `canvaBrandTemplateId` must be repointed to `EAHRUQch1WM`.

---

## 1. Content audit

**The copy is the stock template's, not Vance's.** Every point slide is generic
content-creator advice: "Editing tips", "Photography tricks", "Your camera setup",
"Lighting before & after", "Social media growth tips". Nothing on pages 2-6 relates to
clinical nutrition, gut health or medical foods. The cover reads "5 Gastro Ideas / When
You Don't Know What to Post", which is a prompt list for creators rather than anything a
Vance follower would engage with.

This matters more than it looks. Per the handover, **an unfilled autofill field keeps the
design's existing text, it does not blank.** So every slot left untagged, or tagged with a
field the app has no value for, publishes this copy verbatim on every occurrence. On the
generated house decks the retained text is the field name itself, which fails loudly; here
it is polished off-brand prose, which fails silently.

Everything must therefore either be tagged with a field the generator reliably fills, or
be rewritten as deliberate static furniture. There is no safe third option.

What is already correct:

- Handle `@VANCEHEALTHHUB` matches `BRAND.handle` (`@vancehealthhub`) in `lib/social/ava-prompts.js`. Keep.
- Title `Vance Carousel - V2 Education` passes `isHouseTitle()`, so the template will appear in the app's picker once published with at least one autofill field.
- No em dashes, no emoji, no medical claims anywhere in the current copy.
- Five point slides against `MAX_POINTS = 6` — the generator produces enough points, with `point6` spare.

---

## 2. Slot inventory

39 text elements: **20 tagged, 19 static** (7 handles, 5 "No.N", 5 "Example ideas:",
"Comment below:", "By Team Vance").

### Page 1 — cover `PBv79ZNnChrbdJsK`

| Element | Text | Tagged | Notes |
|---|---|---|---|
| `LB8vGKRcZBWgQf9T` | "5\nGastro Ideas" | `hookTitle` | **both lines**, count included — see 4.1 |
| `LBDgk7w37pBQ9lpk` | "When You Don't Know What to Post" | `subhead` | alias of `spec.brief.body` |
| `LBj991Kv3DS64czz` | "By Team Vance" | — | static |
| `LBjckwr4ZGr2n717` | "@VANCEHEALTHHUB" | — | static |

**The `headline` CSV column must carry the count and a newline**, e.g. `"5\nGut Habits"`. Two
lines is the box's whole capacity, so this is a two-line field, not a one-line field with a
number bolted on.

### Pages 2-6 — point slides (N = page number minus 1)

Same six elements on every page. Locator ids per page:

| N | Page | headline → `point{N}` | quote → `point{N}quote` | list → `point{N}body` |
|---|---|---|---|---|
| 1 | `PBSmpCgnDQxSGWx4` | `LBJcNBFpPZhXlCRR` | `LBNFgnqZBDTddhWQ` | `LBZf4ZFTmNXWhDQw` |
| 2 | `PBMwdnbg6yPmvCZ0` | `LBfP07ZdV9lwhGt3` | `LBKthQYPLKBhqXkp` | `LBtNQ88jkF1cZGfw` |
| 3 | `PB0t1W0yJlhHynls` | `LB951WspynnyPCw8` | `LBPFBCt2q1WpYHfK` | `LBbcFhlKWkYlcpZw` |
| 4 | `PBdRjgFg0x153VTg` | `LBmzXZ97j8wBwdws` | `LBZgY5thMqL1wnFj` | `LBRGMWm4Hp2QlLPH` |
| 5 | `PB7dPsQwBX6Wm5b4` | `LBTV7zmTPqNKlCfd` | `LBLS7Kg0zNH54P0J` | `LBk1y31G8Bb3jzqc` |

The "No.N" label and "Example ideas:" label on each page are deliberately untagged — both are
structural furniture. `point{N}quote` has **no generated source**; see 4.2.

**Page 5's headline is a three-region element** ("Before " / *vs* italic / " After"). Autofill
replaces the whole text with the first region's styling, so the italic "vs" treatment is lost
the first time that slide is filled. Cosmetic, but it will not look like the mockup.

### Page 7 — close `PBVnfdHl8Djr5dgV`

| Element | Text | Tagged | Notes |
|---|---|---|---|
| `LBpZ9Vjm4nVrmSGW` | "Never run out of content ideas again!" | `update` | **length mismatch** — see 4.3 |
| `LBHqJJl8FkrWjzBt` | "Save this post for later!" | `note` | `spec.cta.note`, model-generated, ≤15 words |
| `LBHm6g9NkmCHJKSn` | "Comment below:" | — | static label |
| `LB8SJ7vdVtcwzpFw` | "Which idea will you try first?" | `cta` | `spec.cta.label`, campaign config |
| `LBzlSVnmyMRvWhWk` | "@VANCEHEALTHHUB" | — | static |

`cta` is campaign config, and `promo-run.js` applies the themed default "SHOP THE RANGE" when
a campaign sets no `ctaLabel`. On this slide that reads as a non-sequitur under "Comment
below:". **Set `ctaLabel` to a question on every campaign using this template**, or retag the
element as a custom field.

**Unused by this template:** `eyebrow`, `domain`, `point6`, `point6body`. All are generated
and sent; Canva ignores keys the template does not declare, so they cost nothing.

---

## 3. Fit against the generator's word caps

Boxes are absolutely positioned and never reflow (handover trap 7), so an overrun overlaps
neighbouring elements rather than pushing them down. Capacities below are derived from each
element's box height, font size and line height; character counts are estimates at ~0.5em
average advance and should be treated as such.

| Slot | Box allows | Generator cap | Verdict |
|---|---|---|---|
| cover headline | 2 lines @ 138.7px ≈ 25 chars | `hookTitle` 10 words | **overruns badly** |
| cover subhead | ~2 lines @ 37.3px ≈ 60 chars | `brief.body` 35 words | **overruns badly** |
| point headline | 2 lines @ 85.3px ≈ 34 chars | `point{N}` 8 words | overruns at 6+ words |
| point quote | 1 line @ 37.3px ≈ 35 chars | none | n/a |
| point body | 3 lines @ 28px ≈ 150 chars | `point{N}body` 30 words | marginal, ~25 words safe |
| close headline | 3 lines @ 106.7px ≈ 40 chars | `update.body` 30 words | **overruns badly** |
| close note | ~2 lines @ 37.3px ≈ 60 chars | `cta.note` 15 words | overruns at 10+ words |
| close cta | 1-2 lines @ 28px | `cta.label` 40 chars | fits |

Three slots are display type sized for a phrase and wired to fields the generator writes as
sentences. This is the same failure mode as the "Known limit: headline length" note in the
handover, one register worse because the cover here is 138.7px against that family's 72px.

Two ways out, and they are not exclusive:

1. **Grow the boxes.** Reserve the height the longest realistic copy needs, as
   `scripts/build-canva-promo-decks.mjs` does. Cheap, but it changes the design.
2. **Cap generation per template.** `buildPromoSpec` already special-cases
   `renderer === 'canva-template'` for point counts; a per-template word budget would sit
   naturally beside it. This is the more general fix, since every hand-built template has
   its own geometry.

Until one is done, drive this deck from CSV (section 5), where the operator controls length
directly.

---

## 4. Decisions needed before tagging

### 4.1 The cover number — split, then deliberately merged back. RESOLVED

`LB8vGKRcZBWgQf9T` holds `"5\nGastro Ideas"` as a single text element with one region. It was
split on 2026-08-04 so the count could be static furniture that no generated copy could
overwrite, then **merged back the same day**, because the split could not be made to look
right.

The reason is worth keeping. `add_text` creates elements in the design's default font
(`YACgEZ1cb1Q`), and neither `format_text` nor any other operation can set a font family or the
`thin` weight — so a split always leaves one half in the wrong typeface, and the only element
carrying the display face is the original. There is no API route to a two-element cover that
matches; the fix genuinely requires the Canva UI. Merging back puts every glyph in
`YAFdJnTJPB4` again, at the cost of the count travelling inside the autofilled `hookTitle`.

**That cost is small here and would not be elsewhere.** This template is CSV-only in practice
(4.2), and in CSV mode the operator writes the headline anyway, so they write the count too.
Under `topic` or `repeat` the model would rewrite it, and a five-page deck announcing "7 Gut
Habits" is exactly the silent wrongness this file keeps warning about. **If this template is
ever driven by a non-CSV mode, split the cover in the Canva UI first** — where the typeface can
actually be set — rather than through the API.

### 4.2 Five quote lines have no generated source — TAGGED, but CSV-only until code changes

The italic line on each point slide ("People love real life content") is a field the app does
not model. It is now tagged `point1quote`…`point5quote`, which routes it through
`spec.customFields` — the documented extension point for template fields this app knows
nothing about. That works **only in `messagingMode: 'csv'`**. Under `'topic'` or `'repeat'`
nothing supplies those keys, so all five slides publish the stock creator-tips copy on every
occurrence.

So either:

1. **Run this template CSV-only** (section 5). Works today, no code change.
2. **Extend `buildPromoSpec`** to ask the model for a one-line pull quote per point, and
   `buildAutofillData` to emit `point{N}quote`. Makes the slot work in every messaging mode.
   Roughly the same shape as the `ctaNote` change made on 2026-07-31.

### 4.3 The close headline is a display phrase, not a paragraph

`update.body` is generated at up to 30 words; the slot holds about 40 characters. It is tagged
`update`, which means **under `topic` or `repeat` mode this slide will overrun on the first
real fill** — this is the clearest case for the per-template word budget in section 3. Until
that exists, drive it from CSV, where the operator controls the length.

### 4.4 There is no link anywhere in the deck

No element carries a URL, and nothing is tagged `domain`. A campaign's `ctaDomain` (default
`vancehealthhub.co.uk`) will be generated and silently discarded. If this deck is meant to
drive traffic rather than engagement, add a link element on page 7 and tag it `ctaLink`,
matching the convention the four promo decks already use. Not done here: adding a text element
to the artwork is a design decision, not a tagging one.

---

## 5. CSV header for full control

With the tagging above, this file drives every fillable slot. Column names are matched
case-insensitively and ignoring separators, and a named column always beats the generated
value (`applyCsvFields` in `lib/social/promo-spec.js`).

```csv
headline,subhead,point1,point1quote,point1body,point2,point2quote,point2body,point3,point3quote,point3body,point4,point4quote,point4body,point5,point5quote,point5body,update,note,cta
```

`headline` → `hookTitle`, `subhead` → `brief.body`, `note` → `cta.note`, `cta` →
`cta.label`. `point{N}quote` matches nothing the app models, so it rides on `customFields`
and reaches Canva under its own name. Row 1 is recognised as a header because `headline` is
in `CSV_HEADERS`.

---

## 6. Publishing

**Published twice on 2026-08-04.** First as `EAHRT0smcak`, then — after the cover merge in 4.1
— as `EAHRUQch1WM`, which is live. Both publishes returned the expected false error (trap 1)
naming the id they had just created, and both were confirmed with `get-brand-template-dataset`
rather than retried. All 20 fields survived the second cycle unchanged: `hookTitle`, `subhead`,
`point1`-`point5`, `point1quote`-`point5quote`, `point1body`-`point5body`, `update`, `note`,
`cta`, every one `{"type":"text"}`.

**The trap 10 cycle works and costs about five calls.** `create-design-from-brand-template` on
the live template → `read-design` with `open_transaction` → edit → commit → publish. Two things
worth knowing that the handover does not say: the copy keeps not just the autofill tags but the
**same page and element locator ids**, so a mapping table written against the old template still
applies to the copy; and each pass mints a new EA id, so **delete the superseded template in the
UI immediately**, while you still know which id is which.

The two remaining defects — the section 3 box capacities and the 4.4 link element — are worth
batching into one further cycle rather than two.

### End-to-end check

Posts nothing and persists nothing to KV or WordPress, but it does mint a real Canva design:

```bash
curl -s -X POST -H "Content-Type: application/json" -d "{\"promo\":{\"name\":\"check-v2-education\",\"renderer\":\"canva-template\",\"canvaBrandTemplateId\":\"EAHRUQch1WM\",\"canvaFields\":[],\"messagingMode\":\"topic\",\"topic\":\"A medical food for people with IBD.\",\"slideCount\":7,\"ctaDomain\":\"vancehealthhub.co.uk\"}}" https://vance-content.vercel.app/api/social/promos/preview
```

Expect 7 export URLs. In `topic` mode the five quote lines will still carry the stock copy
(4.2) and the close headline will overrun (4.3) — that is the predicted result, not a
regression. A CSV run using section 5's header is the test that should come back clean.

**VERIFIED END TO END 2026-08-04** in `messagingMode: 'csv'` with a single row carrying all 20
column values. Seven slides exported, one per page. Pages 1, 2, 5 and 7 were downloaded and
inspected on the artwork, not just in the returned spec:

- All 20 fields carry the CSV value verbatim. The `\n` line breaks inside `point{N}body` survive
  into the rendered three-line lists.
- `point{N}quote` arrived through `spec.customFields` exactly as designed and rendered in the
  italic slot. The CSV path fills every slot in this template.
- Page 5's three-region headline flattened to a single style with no visible defect, as
  predicted in section 2 — the replacement copy has no italic segment to lose.
- The generated `eyebrow` and a sixth generated point were sent and silently ignored, which is
  the expected behaviour for keys the template does not declare.
- The cover's "5" rendered as a visibly different face from "Gut Habits". Fixed by the merge in
  4.1 and re-verified against `EAHRUQch1WM` on the same day: with `headline` set to
  `"5\nGut Habits"`, both lines export in `YAFdJnTJPB4` from one CSV value.
- Short copy leaves visible gaps rather than overruns: a two-line `update` on page 7 sits well
  above the divider, because the box is top-anchored and fixed pages never reflow. Writing to
  the measured capacities in section 3 is what keeps the spacing right, in both directions.

**Unrelated defect surfaced by this run: `normaliseHashtags` returned one concatenated tag**,
`#GutHealthClinicalNutritionMedicalFoodsDigestiveWellbeingPatientSupportNutritionVanceHealthHub`.
`normaliseHashtags` in `lib/social/carousel-text.js` splits a bare *string* on whitespace and
commas, but treats every element of an *array* as a single tag and strips the spaces inside it.
The model returned all its tags in one array element, which is a shape it is free to choose, so
the caption shipped one unusable tag. This affects article carousels too, not just promos, and
is invisible whenever a campaign sets its own hashtags.

**FIXED.** Every element is now split, not just a bare string, and `#` joins whitespace and comma
as a delimiter so the run-together variant (`#GutHealth#Nutrition`) separates too. The leading
`replace(/^#+/, '')` became redundant and was dropped. Verified against the reported input and
against bare strings, unhashed tags, case-differing duplicates, null, and the 8-tag cap.

**Publishing consumes the design** (trap 6). `DAHRTxa6iH0` will disappear from the designs
list. Take a copy first if you want an editable original, and record the new `EA…` id here.

Then verify end to end. This posts nothing and persists nothing to KV or WordPress, but it
does mint a real Canva design:

```bash
curl -s -X POST -H "Content-Type: application/json" -d "{\"promo\":{\"name\":\"check-v2-education\",\"renderer\":\"canva-template\",\"canvaBrandTemplateId\":\"<ID>\",\"canvaFields\":[],\"messagingMode\":\"topic\",\"topic\":\"A medical food for people with IBD.\",\"slideCount\":7,\"ctaDomain\":\"vancehealthhub.co.uk\"}}" https://vance-content.vercel.app/api/social/promos/preview
```

Expect 7 export URLs, one per page. Open them and check the five quote lines and the close
headline specifically — those are the slots this audit predicts will fail.

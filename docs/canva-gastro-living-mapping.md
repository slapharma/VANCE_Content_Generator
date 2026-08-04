# Canva "Gastro Living" carousels — content audit and autofill field map

Three operator-built decks, mapped and published 2026-08-04. They are a *family by name only*:
different page counts, different layouts, different typography, and very different capacity.

| Deck | Live brand template | Fields | Pages | Superseded, DELETE in the UI | Source designs (consumed) |
|---|---|---|---|---|---|
| Vance Carousel - V2 Gastro Living | `EAHRUbI_kV0` | 10 | 5 | — | `DAHRULz8eq8` |
| Vance Carousel - V3 Gastro Living | `EAHRUledUQE` | 12 | 6 | **`EAHRUQAAU7c`** | `DAHRUDTV-OY`, `DAHRUXieNgs` |
| Vance Carousel - V4 Gastro Living | `EAHRUZDydoc` | 8 | 4 | **`EAHRUTCPrzw`** | `DAHRT9UEaXI`, `DAHRURBD38s` |

Both confirmed via `get-brand-template-dataset`, all `{"type":"text"}`, no name collisions, and
verified on downloaded artwork in `messagingMode: 'csv'`.

Companion reading: `docs/handover-canva-carousel.md` sections 3, 5 and 6, and
`docs/canva-v2-education-mapping.md` for the same process on the education deck.

---

## 1. Content audit

**The two decks arrived in opposite states, and this is the single most important difference.**

**V2 Gastro Living was already on-brand.** Hydration and digestion copy throughout, the real VANCE
mark on every page, `www.VanceHealthHub.co.uk` on page 3, a "GUT HEALTH TIPS" series lockup in the
corner. Nothing needed rewriting.

**V3 and V4 Gastro Living were entirely stock.**

V4's every word was the source template's "how to wake up at 5 AM and not feel tired" content: an
"Early bird tips" eyebrow on all four pages, three point slides about visualising your morning
routine.

V3's was generic self-care creator content — "5 HABITS that changed my life", then journaling,
no-phone mornings, moving my body out of love, speaking kindly to myself, doing one little thing
I love. Nothing on any slide related to gut health, and the copy additionally carried US spelling
("favorite"), em dashes and curly quotes.

Per the handover, an unfilled autofill field keeps the design's existing text, so any slot left
untagged would have published that copy from a clinical nutrition account, indefinitely, looking
entirely deliberate.

That is resolved on both: **every element carrying stock copy is now tagged**, so nothing stock
survives a fill. V3 has *no static text at all* — all twelve of its text elements are fillable.
V4's one exception is the cover's "How to" lockup, which is deliberate furniture (section 5.1).
Remaining static elements across the family are structural — index numbers, page counters, the
handle, the series label.

What was already correct on all three: no emoji and no medical claims. All three titles pass
`isHouseTitle()`. V4 carries `@VANCEHEALTHHUB`, matching `BRAND.handle` in `lib/social/ava-prompts.js`.

**Titles collided on arrival.** Both decks were named `Vance Carousel - V2 Gastro Living`. Same
title, same account, near-identical picker entries — the exact condition that caused a full rebuild
on 2026-07-30. The operator resolved it mid-session by renaming the 4-page deck to **V4**, which is
the naming now published. See section 6 for the transaction hazard that created.

---

## 2. Slot inventory — V2 Gastro Living (`EAHRUbI_kV0`)

5 pages at 1080x1350, FIXED. 17 text elements: **10 tagged, 7 static.**
Layout is centred type inside a translucent circle over a full-bleed photo.

| Page | Page id | Element | Field | Was |
|---|---|---|---|---|
| 1 cover | `PBBqYR0Fhy0nRmXD` | `LBfLcGDCsD1BMVXN` | `eyebrow` | "gut health tips" |
| | | `LBpfgQ4ZDR8Pfbpc` | `hookTitle` | "The benefits of hydration for digestion" |
| | | `LBtncpT6qdwzHMFR` | — | "gut health tips" corner lockup, static |
| 2 | `PBj19DwQZcz8Hfdf` | `LBkt5Z2gbX6yPPM6` | `point1` | "Sip throughout the day" |
| | | `LBFpmsmGJJ7zH2By` | `point1body` | |
| | | `LB6MbmTzqrBMTh51` | — | "01", static |
| 3 | `PBCQ89PzjgCfzVHc` | `LBk3fH2hJnzRmwy1` | `point2` | "Pair meals with water" |
| | | `LBj995RbwMHlHN7f` | `point2body` | |
| | | `LBNYgzTHRL2sK8h9` | `domain` | "www.VanceHealthHub.co.uk" |
| 4 | `PBRTx5g8nxqKp91K` | `LBjDD39bb4qBKQvp` | `point3` | "Infuse water with citrus" |
| | | `LBBZTTqtDrMK9n3s` | `point3body` | |
| 5 recap | `PBN1lWN4dFQxTlzk` | `LB7RDQhTLX3ZyM6H` | — | "Recap" heading, static |
| | | `LBxBGDlgCvxJ1JXP` | `update` | the three-line recap list |

The corner lockup repeats on all five pages, untagged, as does the VANCE mark. The "01"/"02"/"03"
index labels are structural furniture and must stay static — they have to agree with the page order.

**`domain` appears on page 3 only.** That is the design's own choice, not an oversight, and tagging
it keeps campaign config authoritative. It costs the "www." and the camel casing unless the campaign
sets `ctaDomain` to the full `www.VanceHealthHub.co.uk` — which the verification run did, and it
rendered identically to the original artwork. **Set `ctaDomain` explicitly on any campaign using
this deck**, or the slide degrades to a bare `vancehealthhub.co.uk`.

**Unused:** `cta`, `note`, `brief`/`subhead`, `point4`-`point6`. There is no CTA element and no
close prompt anywhere in the deck — it is an engagement piece that ends on a recap. Generated
values for those keys are sent and silently ignored.

**The recap slide is a compromise worth knowing about.** Its list is tagged `update`, so it always
fills in every messaging mode. But `update.body` is generated as a closing *paragraph*, and this
slot sits under a static "Recap" heading where three short lines belong. In CSV mode write it as
three newline-separated fragments (the verification run did exactly this and it rendered correctly).
In `topic` mode expect a paragraph under a "Recap" heading — legible, but not what the layout means.

---

## 3. Slot inventory — V3 Gastro Living (`EAHRUledUQE`)

6 pages at 1080x1350, FIXED. 12 text elements: **all 12 tagged, none static.**
Layout is a full-bleed lifestyle photo with the headline in a teal highlight band and an italic
caption beneath it, alternating between the top and bottom of the page.

| Page | Page id | Element | Field | Was |
|---|---|---|---|---|
| 1 cover | `PBW0QBN7m5lzVkRY` | `LBtGN5SrsTBlK4t1` | `hookTitle` | "5 HABITS that changed my life" |
| | | `LBxzG1MLc6gLydDm` | `subhead` | "gentle routines that helped me feel more like myself" |
| 2 | `PB91jpsTDgPNlj3K` | `LB7sflWWt72Q7M7h` | `point1` | "Journaling even when I didn't know what to say" |
| | | `LBPFPvSYsbVc8yGX` | `point1body` | |
| 3 | `PB0DzhmP6fcCvSSz` | `LBBLGpG2WH58qJ05` | `point2` | "2. No-phone mornings (even just 10 minutes)" |
| | | `LBJCyrm22LYtRXpV` | `point2body` | |
| 4 | `PBFWV9yxM6Wx1Brt` | `LBnzhZqgPV7gNx0T` | `point3` | "3. Moving my body out of love, not pressure" |
| | | `LBHFXXmdnqCCzsbR` | `point3body` | |
| 5 | `PBG3flh7pCXdPrf7` | `LBBW36gFS13K3x5b` | `point4` | "4. Speaking kindly to myself" |
| | | `LBJwhnPBmv4llG9L` | `point4body` | |
| 6 | `PB9cyPDZrYnB5SDS` | `LB0fGSVR9T0f3p7X` | `point5` | "5. Doing one little thing I love every day" |
| | | `LBw8yTByRWlMHTd3` | `point5body` | |

Five point slides against `MAX_POINTS = 6`, so the generator produces enough with `point6` spare.

**Unused:** `eyebrow`, `update`, `cta`, `note`, `domain`, `point6`. Like V4 this deck has **no close
slide and no link anywhere** — it ends on point 5.

**The only non-text elements are the VANCE mark, which now appears on all six pages** — see 5.4 for
the two that were missing it and how they were fixed.

---

## 4. Slot inventory — V4 Gastro Living (`EAHRUZDydoc`)

4 pages at 1080x1350, FIXED. 18 text elements: **12 tagged (8 distinct fields), 6 static.**
Layout is left-aligned display type beside an alternating rounded photo panel.

| Page | Page id | Element | Field | Was |
|---|---|---|---|---|
| 1 cover | `PBRBgJRDrXz8J3gz` | `LBMqlMnKBbDRgV0c` | `eyebrow` | "Early bird tips" |
| | | `LBvw74ZHZ3Ly0vVg` | `hookTitle` | "wake up at 5 am and not feel tired" |
| | | `LBqf3GB03XWPWjfp` | — | "How to" script lockup, static — see 4.1 |
| | | `LBc3xG0bWCgCtDQm` | — | "Swipe" pill, static |
| 2 | `PBWk75CQW2Df4409` | `LBNBHw3gPS6Xgb0x` | `eyebrow` | |
| | | `LB1BggzJvsncJ88p` | `point1` | "HAVE A STRONG WHY" |
| | | `LB3LgjxfJHbyGTCg` | `point1body` | |
| | | `LBtHH8C8DRJDxsB1` / `LBWzBtTNsdNcSKl8` | — | "01." and the "02" pill counter, static |
| 3 | `PBkRRDNZMZqHF2R9` | `LBw128HG9tDq5rbn` | `eyebrow` | |
| | | `LBNm1YWNpZDjTMG4` | `point2` | "Visualize your morning routine" |
| | | `LBj0bSfGK40hNHtf` | `point2body` | |
| | | `LBMFhj9Qg9hXyFNt` / `LB1YWN7l4Ydjgz1G` | — | "02." and the "03" pill counter, static |
| 4 | `PBDCZvJb22sm5Cyq` | `LBYhtvDgL5qlLpj1` | `eyebrow` | |
| | | `LBGMNJqJl5LDdm6F` | `point3` | "Be patient with yourself" |
| | | `LBg1dPlvKXXHVl1v` | `point3body` | |
| | | `LBp8T3mxbXMmKRj8` | — | "03.", static |
| | | `LBpQyY14RS0RNmfy` | — | `@VANCEHEALTHHUB`, static |

**`eyebrow` is deliberately shared across all four pages.** Canva writes a value to every element
carrying a label, and this genuinely is one string repeated as a running header — the same pattern
`domain` uses on the three-slide promo family. The dataset reporting 8 fields for 12 tagged
elements is correct here, not the collision bug from 2026-07-31.

**Unused:** `cta`, `note`, `domain`, `brief`/`subhead`, `update`, `point4`-`point6`. This deck has
**no close slide and no link anywhere** — it ends on point 3. A campaign's `ctaDomain` is generated
and discarded. If this deck is ever meant to drive traffic rather than engagement, a link element
has to be added in the Canva UI and tagged; that is a design decision, not a tagging one.

---

## 5. Capacity, measured against exported artwork

Fixed pages never reflow (handover trap 7), so an overrun overlaps its neighbours rather than
pushing them down. Two measurement notes that matter more than the numbers:

**A box's CDF height is its *current rendered content* height, not a ceiling.** Canva text boxes
auto-size to their copy, so `scripts/capacity.mjs` reports the line count the designer laid out.
The real ceiling is the vertical gap to the next element below. On V2 that gap is generous
everywhere; on V4 it is 35px — under half a line — between every point headline and its body, so
those headlines genuinely are hard-capped at the designed line count.

**A box can also be wider than its clear area.** See 4.2.

### V2 Gastro Living — comfortable throughout

| Slot | Designed | Ceiling before overlap | Generator cap | Verdict |
|---|---|---|---|---|
| `hookTitle` | 3 lines @ 66px | ~6 lines (circle bottom) | 10 words | fits; verified at 4 lines |
| `eyebrow` | 1 line ≈ 49 chars | 1 line | 4 words | fits |
| `point{N}` | 2 lines ≈ 66 chars | 3 lines | 8 words | fits |
| `point{N}body` | 5-7 lines ≈ 235-329 chars | 7-8 lines | 30 words | fits |
| `update` | 3 lines ≈ 141 chars | ~6 lines | 30 words | fits |
| `domain` | 1 line ≈ 36 chars | 1 line | config | fits |

Nothing on this deck needs a per-template word budget. It is safe in `topic` mode.

### V3 Gastro Living — a one-line cover and short captions

| Slot | Ceiling | ≈ chars | ≈ words | Generator cap | Verdict |
|---|---|---|---|---|---|
| `hookTitle` (cover) | **1 line** @ 56px | ~31 | 5 | 10 words | **overruns past ~5 words** |
| `subhead` (cover) | 1 line @ 28px | ~69 | 11 | 35 words | **overruns past ~11 words** |
| `point{N}` | 2 lines @ 42.7px | ~63 | 10 | 8 words | fits |
| `point{N}body` | 2 lines @ 28px | ~83-98 | 14-16 | 30 words | **overruns past ~15 words** |

**The cover headline is hard-capped at one line.** Its box bottom sits 15px above the subline, and
the highlight band is drawn around the text — so a second line gets its own band and collides.
This is the tightest slot in the whole family: ~31 characters.

The italic captions sit on open photo with no band, so an overrun adds white lines over the image
rather than colliding with anything. Ugly rather than broken, but it changes the composition.
Write them to ~12-15 words.

### V4 Gastro Living — three tight slots

The display face is a condensed grotesque at 85-128px; ~0.56em average advance.

| Slot | Ceiling | ≈ chars | ≈ words | Generator cap | Verdict |
|---|---|---|---|---|---|
| `hookTitle` (cover) | 4 lines @ 128px | ~40 | 7 | 10 words | **overruns past ~7 words** |
| `point1` (p2) | 3 lines @ 85px | ~32 | 5 | 8 words | **overruns at 6+ words** |
| `point2` (p3) | 4 lines @ 85px | ~43 | 7 | 8 words | marginal |
| `point3` (p4) | 2 lines @ 85px | ~26 | 4 | 8 words | **overruns badly** |
| `point{N}body` | 6-8 lines | 174-248 | 29-41 | 30 words | marginal on p2, fits p3/p4 |
| `eyebrow` | 1 line | ~31 | 5 | 4 words | fits |

**Drive V4 from CSV**, where the operator controls length, or accept clipped headlines in `topic`
mode. The three point headlines have three *different* capacities against one 8-word generator cap,
so a single per-template budget would not fix it either — only per-slot copy will.

Also worth writing to: a short headline does not centre itself. The body sits at a fixed `y`, so a
one-line `point1` where the design had three leaves a large visible gap. Write point headlines at
roughly the designed line count (3 / 4 / 2) to keep the slides balanced in both directions.

---

## 6. Decisions made

### 5.1 V4's cover is a two-part lockup and only half of it is fillable

The cover reads "How to" in a script face, then the headline beneath. The "How to" is a **separate
static element** and is left that way: it is the frame, and per handover trap 17 the API cannot
create a matching element in that typeface anyway.

**This constrains generation in a way nothing else in the pipeline knows about: `hookTitle` must
grammatically complete "How to …".** In CSV mode the operator writes it and this is trivial
("ease bloating after meals"). In `topic` or `repeat` mode the model writes a standalone headline
with no idea it is a sentence fragment, and the cover reads as a non-sequitur. **Keep V4 on CSV**,
or set a campaign brief that instructs the model explicitly.

### 5.2 V3's numbering was built two different ways — NORMALISED

The five point headlines were numbered inconsistently at the element level, which the artwork
hides. Page 2 had **no number in its text at all**: its "1." came from an automatic decimal list
marker (`listMarker=decimal, level=1`), and the page was additionally set to `textAlign=justify`,
producing the stretched word spacing visible in the original. Pages 3-6 had "2." to "5." typed
into the text with `listMarker=none` and `textAlign=start`.

That matters because autofill replaces *text* but not *paragraph properties*. Tagging all five as
`point{N}` would have left page 2 rendering "1." in front of whatever copy arrived, while pages
3-6 lost their numbers entirely — five slides, one numbered, four not.

Fixed with a single `format_text` op on page 2 setting `list_level: 0` and `text_align: "start"`,
so no slide carries structural numbering. **The number now travels inside the `point{N}` value**,
exactly as the count does on the V2 Education cover. In CSV the operator writes `"1. Eat at a
steady pace"`; verified on artwork. In `topic` mode the slides simply come out unnumbered, which
is a graceful degradation rather than a contradiction — unlike the cover count below.

### 5.3 V3's cover count is inside `hookTitle`

`"5 HABITS for a calmer gut"` is one element, so the count is autofilled with the headline. In CSV
the operator writes it and it agrees with the five point slides. In `topic` mode the model can
write any number, and a six-page deck announcing "7 habits" is the silent wrongness this file keeps
warning about. **Keep V3 on CSV**, or accept that risk. Splitting the count out is not possible
through the API (handover trap 17) and would have to be done in the Canva UI.

### 5.4 V3 was missing its brand mark on two slides — FIXED

As published at `EAHRUQAAU7c`, the VANCE mark appeared on pages 1, 2, 4 and 6 and was absent from
pages 3 and 5. Fixed through the trap 10 cycle, which is why that id is superseded.

**An existing element's `mediaId` IS a usable `asset_id`.** The mark is `MAHQ3UzVoGQ` on the pages
that already carried it; `get-assets` resolves that id directly (image, 1024x576), and `insert_fill`
accepts it. So adding an image already present elsewhere in a design needs **no upload** — read the
`mediaId` off a sibling page and insert it. This is worth knowing generally: it makes "the logo is
missing from two slides" a one-operation fix rather than a UI job.

Both inserts reuse the exact geometry pages 1, 2 and 4 use — `top: -24.479450178247703`,
`left: 21.98227186526185`, `325.3353041714795 x 183.00110859645724` — so the mark bleeds off the
top edge identically. Its 16:9 aspect matches the asset's 1024x576 exactly, so nothing is squashed.
Both pages carry their text at the bottom, so the top-left placement is clear of every tagged slot.
Verified on exported artwork.

### 5.5 The cover headline box was wider than its clear area — FIXED

The first publish (`EAHRUTCPrzw`) clipped its own cover. The headline box is at `left: 108` and was
`864` wide, so it ran to x=972 — but the photo panel starts at **x=857**. The box overlapped the
photo by 115px, and because the photo is layered in front, any line longer than ~10 characters slid
underneath and was **cut off mid-glyph**. Verified on exported artwork: "EASE BLOATING" lost its G.

This is a distinct failure from the usual overrun, and worse: overrun copy is ugly but readable,
whereas this is silently truncated. It is also invisible in the CDF unless you compare the text
box's right edge against the neighbouring image's left edge.

Fixed by `resize_element` to **740px** wide (right edge 848, 9px clearance), through the trap 10
cycle. Re-verified on artwork: the same copy now wraps to three clean lines. That republish is why
`EAHRUTCPrzw` is superseded.

### 5.6 All three decks end without a call to action

None has a `cta` or a `note`, and only V2 has a link. This is a deliberate property of the artwork,
not a mapping gap. It also sidesteps the problem the education deck has, where `promo-run.js`
injects the themed default "SHOP THE RANGE" into a slot that asks a question. No campaign on these
three templates needs `ctaLabel` set.

---

## 7. Publishing, and the transaction hazard the rename created

All three published on the first attempt, each returning the expected false error (trap 1) naming
the id it had just created. None was retried; all were confirmed with `get-brand-template-dataset`.

**The operator renamed a deck in the Canva UI while an editing transaction was open on it.** The
transaction had already snapshotted the old title, so committing would have silently reverted the
rename. Caught by re-reading `design_metadata` outside the transaction and re-applying
`update_title` with the new name before committing.

**An open Canva transaction is a snapshot, not a live view.** Anything the operator changes in the
UI after `read-design` is invisible to it and is overwritten on commit. When a session spans
operator activity, re-read metadata before finalising.

Trap 18 held again: the copy from `create-design-from-brand-template` retained both the autofill
tags and the **original page and element locator ids**, so the tables in sections 2 and 3 stay
valid through the edit cycle.

---

## 8. CSV headers

Every fillable slot, matched case-insensitively and ignoring separators. A named column always beats
the generated value (`applyCsvFields` in `lib/social/promo-spec.js`). Row 1 is recognised as a
header because `headline` is in `CSV_HEADERS`. **No deck in this family uses `customFields`** —
every field is one the app already models, so unlike the education deck all three fill in *every*
messaging mode. CSV is recommended for V3 and V4 on capacity and numbering grounds (sections 5.2,
5.3 and 6), not because it is required.

V2 Gastro Living:

```csv
eyebrow,headline,point1,point1body,point2,point2body,point3,point3body,update,domain
```

V3 Gastro Living — write the "1." to "5." prefixes into the `point{N}` values:

```csv
headline,subhead,point1,point1body,point2,point2body,point3,point3body,point4,point4body,point5,point5body
```

V4 Gastro Living:

```csv
eyebrow,headline,point1,point1body,point2,point2body,point3,point3body
```

---

## 9. Verification

**VERIFIED END TO END 2026-08-04** via `POST /api/social/promos/preview` in `messagingMode: 'csv'`,
one row carrying every column. The campaign must be nested as `{"promo": {...}}` (trap 5).

- **V2 Gastro Living** — 5 slides, all 10 fields verbatim. Pages 1, 3 and 5 inspected on downloaded
  artwork. The cover took a 4th line and stayed inside the circle; `domain` rendered as
  `www.VanceHealthHub.co.uk` identically to the original; the `\n` breaks in `update` survived into
  the three-line recap. Clean, no defects.
- **V3 Gastro Living** — 6 slides, all 12 fields verbatim. Pages 1, 2, 4 and 6 inspected. The
  numbering fix in 5.2 held: page 2 rendered a single "1." from the CSV value with normal word
  spacing, matching pages 3-6. The one-line cover took `"5 HABITS for a calmer gut"` (25 chars)
  without wrapping. Re-verified against `EAHRUledUQE` after the brand-mark insert: pages 3 and 5
  export with the mark in the same top-left position as the rest, all 12 fields still filling.
- **V4 Gastro Living** — 4 slides, all 8 fields verbatim, `eyebrow` correctly repeated on all four
  pages. Pages 1-4 inspected. Found and fixed the cover clipping in 5.5; re-verified against
  `EAHRUZDydoc`.

```bash
curl -s -X POST -H "Content-Type: application/json" -d @payload.json https://vance-content.vercel.app/api/social/promos/preview
```

A preview persists nothing to KV or WordPress, but it does mint a real Canva design — the smoke-test
decks it leaves behind are safe to delete.

All three decks are hand-built, so unlike the families in handover section 4 they **cannot be
regenerated from tokens**. The artwork is the source, the trap 10 cycle is the only way to change
them, and losing an id means rebuilding by hand.

---

## 10. Operator to-do

1. **Delete `EAHRUTCPrzw` and `EAHRUQAAU7c`** in the Canva UI — the superseded V4 publish with the
   clipping cover, and the superseded V3 publish missing its brand mark on two pages. There is no
   delete API, and same-titled templates with near-identical thumbnails have already forced one
   full rebuild on this project.
2. **Set `ctaDomain` to `www.VanceHealthHub.co.uk`** on any campaign using V2 Gastro Living.
3. **Keep V4 on CSV**, and write its cover headline to complete "How to …".
4. **Keep V3 on CSV**, write the "1." to "5." prefixes into its `point{N}` columns, and keep its
   cover headline to about 30 characters — it is a single line and will not wrap.
5. Delete the `check-v2-gastro-living`, `check-v3-gastro-living` and `check-v4-gastro-living`
   smoke-test designs.

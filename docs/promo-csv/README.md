# Promo campaign CSVs

One row per occurrence. A campaign set to messaging mode **CSV** walks the rows in order,
one each time its schedule fires, and `csvCursor` advances only after a deck actually exists,
so a failed run retries the same row rather than skipping it.

Upload under **Message CSV** in the campaign builder.

## Two files here

| File | Use it for |
|---|---|
| `promo-3-slide.csv` | The four promo decks (Dashboard, Health Quiz, Meal Planner, Vance-Ai). Three pages, seven fields. |
| `promo-carousel.csv` | The eight-page house decks (Education, Relatable, Breaking News). Full field vocabulary. |

Both are ready to open, overwrite the example rows and upload. The examples are real copy lifted
from the templates themselves, so a file uploaded unedited reproduces the decks as designed.

`promo-3-slide.csv` carries **one row per deck**, which is a starting point rather than a rule:
a campaign points at one template, so in practice you keep the row matching your template and
write the rest of the file as the occurrences you want that deck to run. Some cells contain
deliberate line breaks (inside quotes, standard CSV) because the artwork sets those lines
separately. Keep them.

## How the header row works

**If the first cell of row 1 is a recognised column name, row 1 is treated as a header** and
every column name becomes a field name. Recognised openers:

`message` `text` `copy` `headline` `hooktitle` `title` `eyebrow` `subhead` `subheading`
`subtitle` `brief` `cta` `ctalabel` `domain`

Without a header the old two-column contract still applies: column 1 the message, column 2
the call to action. Files uploaded before this change keep parsing exactly as they did.

Column names are matched ignoring case and punctuation, so `Sub Head`, `subhead` and
`SUBHEAD` are the same column.

## What each column fills

| Column (and its aliases) | Lands on | Appears as |
|---|---|---|
| `eyebrow` | `spec.eyebrow` | small label above the cover headline |
| `headline` · `hookTitle` · `title` | `spec.hookTitle` | the cover headline |
| `subhead` · `subheading` · `subtitle` · `brief` | `spec.brief.body` | the sentence under the headline |
| `point1`…`point6` (also `benefit1`…) | `spec.points[n].headline` | a point slide heading |
| `point1body`…`point6body` | `spec.points[n].body` | that point slide's copy |
| `update` · `close` · `closing` | `spec.update.body` | the closing slide |
| `cta` · `ctaLabel` | `spec.cta.label` | the CTA chip text |
| `note` · `ctaNote` | `spec.cta.note` | the line under the CTA |
| `domain` | `spec.cta.domain` | the URL on the CTA slide. A path is fine (`vancehealthhub.co.uk/ask-ai`) |
| `message` · `text` · `copy` | the model's brief | nothing directly. It steers what gets written |

**Any column name not in that table is passed straight to Canva under its own spelling.**
So if a template declares a field this app has never heard of, add a column with that exact
name and it gets filled. That is the whole point: the app cannot ask Canva what fields a
template declares (the brand-template list endpoint omits the dataset), so it sends every
name it holds and the template takes the ones it recognises. Unknown keys are ignored by
Canva rather than rejected.

## Column values are literal

A value in a named column **replaces** whatever the model wrote. It is not a hint. The model
is still called on every occurrence, because the Instagram caption and hashtags have to come
from somewhere, but anything you name in a column is yours.

Leave a cell empty and that field falls back to generated copy. Omit the column entirely and
the same thing happens.

## Field names must match the Canva template

The four promo decks declare exactly eight fields, spread across their three pages:

| Page | Fields |
|---|---|
| 1 cover | `headline`, `subhead`, `domain` |
| 2 points | `point1`, `point1body`, `domain` |
| 3 close | `update`, `note`, `ctaLink` |

`domain` repeats on pages 1 and 2 on purpose: one value written to both, because it is the same
bare URL on each. Canva writes a value to **every** element carrying a label, which is also why
the pages must not otherwise share names. They originally did, all three tagged
`headline`/`subhead`/`domain`, which made autofill stamp identical copy onto all three slides.

Page 3's URL is its own `ctaLink` field for the same reason in reverse: it carries an action
prefix ("Go to dashboard → ...") that differs from the bare URL, so sharing `domain` would have
overwritten it. **`ctaLink` is not in the app's vocabulary at all** — it works purely through the
unknown-column passthrough described above, which makes it the worked example of how to add any
new template field: tag the element in Canva, add a column with that exact name, no code change.

A template field that receives nothing does **not** go blank. It keeps whatever text the design
already held, which on these decks is the designer's own copy. The slide then publishes looking
completely normal while saying the same thing on every occurrence. That is the failure worth
guarding against: a visibly broken slide gets noticed, a silently stale one does not. It is why
`promo-3-slide.csv` fills all seven columns, and why the generator now always produces the full
envelope for a Canva template regardless of the campaign's slide count.

To check what a template declares, use `get-brand-template-dataset` on its id via the Canva
connector. See `docs/handover-canva-carousel.md` section 6 for the live ids.

# Site Audit — Padding, Margins & Headers
**Date:** 2026-03-19
**File audited:** `index.html` (single-file app)

---

## Summary

The app has **two distinct structural patterns** and several pages that fall outside either standard, creating visible inconsistency. Most pages use a self-contained wrapper div (e.g. `.dashboard-view`, `.archive-container`) with `padding: 1.5rem` or `padding: 2rem`, but the Generator and Settings pages use different systems entirely. The following cross-cutting issues were found:

- **Padding is inconsistent across pages:** `2rem` (Dashboard, Calendar), `1.5rem` (Archive, Comparison, Reports, Monitoring, Social, LLM, Categories), `1.25rem 1.5rem` (Settings), and no outer padding at all (Generator, Pipeline).
- **Page header structure is highly inconsistent:** some pages use `.dashboard-welcome h1`, others use `.archive-header-row h1`, `.monitoring-header h1`, `.pipeline-title div`, `.comparison-header h1`, `.cats-hero h1`; heading levels and visual treatment vary widely.
- **Generator has no page header at all.** It drops directly into a two-column card grid with no title.
- **Pipeline's "header" is a custom `div.pipeline-title`**, not an `h1`, with no semantic heading.
- **Archive and Reports share the `.archive-header-row` class** (Reports literally reuses it), which is functional but odd for what is meant to be a different page.
- **One critical inline style override** on a card-body at line 2105 sets `padding: 10px 12px` instead of the standard `14px`.
- **Several inline style attributes** exist on sub-containers throughout Generator and LLM pages, mostly on form inputs, but the card-body override is the most impactful.

---

## Page-by-Page

---

### view-dashboard
**Lines 2514–2600**

- **Header:** ✅ Has a clear `h1` inside `.dashboard-welcome`. Text: "Welcome to IBD Health Hub Content Generator" + a subtitle `<p>`. Structure is semantically correct.
- **Padding:** ❌ Uses `.dashboard-view { padding: 2rem; }` — **2rem**, which is inconsistent with the `1.5rem` used by most other pages.
- **Header spacing:** The `.dashboard-welcome` block has `margin-bottom: 2rem` before the metrics strip. This is the largest top-to-content gap in the app.
- **Issues:**
  - Padding `2rem` vs standard `1.5rem` on all comparable pages.
  - `max-width: 1200px` — narrower than the `1440px` used by Archive/Comparison/Reports.
  - No action buttons in the header row; the header is pure text. This is actually fine for a dashboard but worth noting it doesn't follow the action-button pattern other pages use.

---

### view-generator
**Lines 2094–2480**

- **Header:** ❌ **No page header at all.** The tab-view div opens directly into `.app-container` (the two-column grid), with no `h1`, no title, no subtitle. The only labelling is a "Content Category" card-header inside the left column.
- **Padding:** ❌ The outer container is `.app-container { padding: 1.5rem; }` — correct padding value, but `.app-container` is designed as a two-column content grid, not a page wrapper. There is no semantic page header or title layer above it.
- **Inline overrides:**
  - Line 2105: `<div class="card-body" style="padding:10px 12px;">` — overrides standard `card-body` padding of `14px`. The override is `10px 12px`, reducing both axes. This is the only card-body override that changes the core spacing token.
  - Line 2106: `.cat-bar` gets `style="border-bottom:none;padding:0;background:none;flex-wrap:wrap;"` — resets `.cat-bar` defaults inline. Functional but fragile.
- **Card spacing:** Uses the standard `.app-container` grid with `gap: 1.25rem`. ✅
- **Issues:**
  - Missing page title/header entirely.
  - `card-body` padding override at line 2105 breaks standard `14px` rule.

---

### view-monitoring
**Lines 2481–2497**

- **Header:** ⚠️ Uses `.monitoring-header` with an inline-styled `h1` rather than a CSS class: `<h1 style="font-size:1.1rem;font-weight:800;color:var(--sla-navy);margin:0 0 3px;">Content Monitoring</h1>`. There is also a subtitle `<p>` and a Refresh button on the right. The layout pattern (title + subtitle left / button right) is correct and mirrors Archive/Reports, but the heading styles are **inline** rather than using a CSS class.
- **Padding:** ✅ `.monitoring-view { padding: 1.5rem; max-width: 1400px; }` — consistent with the majority pattern.
- **Header spacing:** `.monitoring-header { margin-bottom: 1.25rem; }` — consistent with Archive (which also uses `1.25rem` via `.archive-header-row`).
- **Issues:**
  - `h1` styles are inline attributes rather than a reusable CSS class. This makes it impossible to update across pages centrally.
  - `max-width: 1400px` — slightly wider than Dashboard (1200px) and Calendar (1100px), but matches LLM and Monitoring.

---

### view-dashboard *(see above)*

---

### view-distribution (Social)
**Lines 2601–2691**

- **Header:** ❌ **No page-level h1.** The view opens with `.social-view` then immediately a `.social-tabs-bar` (Generate Posts / Prompt Library sub-tabs). There is no "Social" or "Distribution" title anywhere at the top of the page. Inside the Generate Posts pane, the Control Panel shows `.social-cp-title` ("Social Post Generator") but this is inside a card, not a true page header.
- **Padding:** ✅ `.social-view { padding: 1.5rem; max-width: 1200px; }` — consistent.
- **Issues:**
  - Missing page-level header entirely. User lands on this tab with no visible page title.
  - The tab bar (Generate Posts / Prompt Library) immediately follows the opening div — the eye has no anchor.
  - `max-width: 1200px` differs from the 1440px used by Archive/Comparison/Reports.

---

### view-calendar
**Lines 2692–2720**

- **Header:** ⚠️ Uses `.calendar-header-row` with a `.calendar-title` div (not an `h1`): `<div class="calendar-title" id="calMonthTitle">March 2026</div>`. The calendar-specific month title is the "heading," but it is a `div`, not a semantic heading element. There is navigation on the right (prev/next/Today buttons) — the layout pattern is fine.
- **Padding:** ❌ `.calendar-view { padding: 2rem; max-width: 1100px; }` — **2rem** padding, matching Dashboard but inconsistent with the `1.5rem` majority standard.
- **Issues:**
  - Month title uses a styled `div`, not `h1` or `h2`. Screen readers and accessibility are affected.
  - `max-width: 1100px` — narrowest in the app.
  - `padding: 2rem` is inconsistent with `1.5rem` standard.

---

### view-archive (Content Library)
**Lines 2723–2782**

- **Header:** ✅ Uses `.archive-header-row` with `h1#archiveHeading` ("Content Library") + `.archive-stats` subtitle + action buttons on the right. This is the clearest and most complete header pattern in the app. However, the header is **below** a floating `.cat-bar` category filter strip, not at the top of the page. The first visual element is the cat-bar, not the title.
- **Padding:** ✅ `.archive-container { padding: 1.5rem; max-width: 1440px; }` — consistent with Reports, Comparison.
- **Header spacing:** `.archive-header-row { margin-bottom: 1.25rem; }` ✅
- **Issues:**
  - The `.cat-bar` category selector (lines 2724–2731) sits directly inside the `tab-view` div, **above** the `.archive-container`, with no padding of its own. Its padding comes from `.cat-bar { padding: 10px 1.5rem; }`. This creates a header structure of: `[cat-bar strip] → [archive-container with its own padding]`, which is functional but means the first 10px top of the cat-bar has different left-edge alignment than the archive-header below it (the cat-bar is 1.5rem from left, the archive-container content is also 1.5rem from left — they do align, so this is acceptable).

---

### view-comparison (AI Comparison)
**Lines 2785–2830**

- **Header:** ❌ Inconsistent structure. The `.comparison-header` contains a `div` with a "Back to Library" button **and** an `h1` ("AI Comparison Report") side-by-side in a flex row, then a `p` subtitle below. This is the only page where the `h1` is positioned to the right of a button — it should be the other way around (h1 first, button as a secondary action, right-aligned).
- **Padding:** ✅ `.comparison-container { padding: 1.5rem; max-width: 1440px; }` — consistent.
- **Header spacing:** `.comparison-header { margin-bottom: 1.25rem; }` ✅
- **Issues:**
  - The "Back" button precedes the `h1` in DOM order, making the heading feel subordinate.
  - The `p` subtitle at line 2795 uses an inline style: `style="font-size:0.8rem;color:var(--text-muted);"` — not a CSS class.
  - The Analysis panel's header (line 2799) uses `h2` inside `.analysis-panel-header`, which is good — consistent with card headers elsewhere.

---

### view-reports (Comparison Reports)
**Lines 2833–2863**

- **Header:** ✅ Reuses `.archive-header-row` class (same structure as Library) with `h1#reportsHeading` + `.archive-stats` + action buttons. Same pattern as Archive — consistent within itself, though reusing the Archive class is semantically odd.
- **Padding:** ✅ `.reports-container { padding: 1.5rem; max-width: 1440px; }` — consistent.
- **Issues:**
  - Like Archive, has a `.cat-bar` (line 2834) sitting above `.reports-container`. Same alignment situation as Archive — both use `1.5rem` horizontal, so they align.
  - Reuses `.archive-header-row` — this class name implies it belongs to the Archive page. Should ideally be a generic class like `.page-header-row`.

---

### view-pipeline (Content Pipeline)
**Lines 2866–2910**

- **Header:** ❌ Uses `.pipeline-header-row { padding: 1.1rem 1.5rem 0.75rem; }` which contains a `.pipeline-title` **div** (not a heading element): `<div class="pipeline-title">Content <span>Pipeline</span></div>` with a `.pipeline-subtitle` below it. Many action buttons are on the right. The visual design is reasonable, but the title is a non-semantic `div`, not an `h1`.
- **Padding:** ❌ **No outer page-level padding wrapper.** The pipeline uses `.pipeline-container` (which has `display: flex; flex-direction: column; flex: 1; overflow: hidden;` — **no padding**). All spacing comes from the header's inline padding (`1.1rem 1.5rem 0.75rem`) and the board's own padding (`0 1.25rem 1.25rem`). The top of the header aligns to the top edge of the content area with only `1.1rem` top space — less than the `1.5rem` standard elsewhere.
- **Issues:**
  - `.pipeline-title` is a `div`, not a heading element.
  - Top padding of header row is `1.1rem` — less than the `1.5rem` used by most other pages as their container padding.
  - The gap between the last header button row and the board is `0.75rem` (from the bottom padding of `.pipeline-header-row`), which is the smallest vertical rhythm in the app.
  - Action button area (line 2873) uses `style="display:flex;gap:8px;align-items:center;"` — inline style on a layout container.

---

### view-llm (LLM Management)
**Lines 2915–3408**

- **Header:** ❌ **No page-level header at all.** The tab-view opens directly into `.llm-page` (a two-column grid). There is no `h1`, no page title, no subtitle at the top of the page. Each section card has an `.llm-section-header` with an `.llm-section-title`, but these are card-level titles, not a page title.
- **Padding:** ✅ `.llm-page { padding: 1.5rem; max-width: 1400px; }` — consistent padding value.
- **Issues:**
  - Missing page header entirely — same issue as Generator and Social.
  - `max-width: 1400px` — consistent with Monitoring.
  - Many inline style attributes on form inputs (lines 2931, 2935, 2939, 2957, 2962, 2987) that duplicate styles already in the global `input[type="text"]` rule. These are redundant and could cause drift.

---

### view-settings
**Lines 3409–3501**

- **Header:** ❌ **No page-level header.** The tab-view opens directly into `.settings-container` (a two-column grid). No `h1`, no page title. Each settings section card has a `h3` inside `.settings-section-header`, but these are card-level, not a page title.
- **Padding:** ⚠️ `.settings-container { padding: 1.25rem 1.5rem; }` — vertical padding is `1.25rem`, not the `1.5rem` used by other pages. Horizontal is consistent.
- **Issues:**
  - Missing page header.
  - Vertical padding `1.25rem` differs from standard `1.5rem`.

---

### view-categories
**Lines 3502–end**

- **Header:** ✅ The best-structured alternative header in the app. Uses `.cats-hero` which contains `h1` ("Content Categories") + subtitle `<p>` + stats row + a "New Category" button. The layout (title/description left, stats center, action button right) is clear and purposeful.
- **Padding:** ✅ `.cats-page { padding: 1.5rem; max-width: 1320px; }` — consistent padding value.
- **Header spacing:** `.cats-hero { margin-bottom: 1.5rem; }` — uses `1.5rem` as vertical spacing, slightly more than the `1.25rem` used by Archive. Acceptable.
- **Issues:**
  - `max-width: 1320px` is unique — not 1440px (Archive/Reports/Comparison) or 1400px (LLM/Monitoring) or 1200px (Dashboard/Social) or 1100px (Calendar). There are now 5 different max-width values across the app with no documented rationale.

---

## Recommended Fixes

**Priority 1 — Add missing page headers (high visual impact)**

1. **view-generator (line 2094–2095):** Insert a page header div above `.app-container`. Structure should mirror Archive: title "Content Generator" + subtitle + optional action buttons right. This is the most-used view and has no title at all.

2. **view-distribution / Social (line 2602):** Insert a page header above `.social-tabs-bar` with title "Social Distribution" or "Social Posts" and a brief subtitle. Currently the page has zero title.

3. **view-llm (line 2916):** Insert a page header above `.llm-page` grid. Title: "LLM Management" or "AI Configuration". A brief subtitle would help orient the user.

4. **view-settings (line 3410):** Insert a page header above `.settings-container`. Title: "Settings". This page has section-level `h3` headings but no page `h1`.

5. **view-pipeline (line 2870):** Change the `.pipeline-title` div to an `h1` element for semantic correctness. No visual change required.

6. **view-calendar (line 2695):** Change `.calendar-title` div to an `h1`. No visual change required.

**Priority 2 — Normalise outer padding to `1.5rem` everywhere**

7. **view-dashboard (line 1426):** Change `.dashboard-view { padding: 2rem; }` to `padding: 1.5rem;`. (Currently `2rem`; only Dashboard and Calendar use this value.)

8. **view-calendar (line 1493):** Change `.calendar-view { padding: 2rem; }` to `padding: 1.5rem;`.

9. **view-settings (line 1335):** Change `.settings-container { padding: 1.25rem 1.5rem; }` to `padding: 1.5rem;` to match both axes.

10. **view-pipeline — header top padding (line 1198):** Change `.pipeline-header-row { padding: 1.1rem 1.5rem 0.75rem; }` to `padding: 1.5rem 1.5rem 0.75rem;` to align the top edge with all other pages.

**Priority 3 — Remove the card-body padding override**

11. **Line 2105 (generator view):** Remove `style="padding:10px 12px;"` from `<div class="card-body" ...>`. This overrides the global `.card-body { padding: 14px; }` standard. If the Category selector card genuinely needs tighter padding, add a modifier class (e.g. `.card-body--compact`) in the `<style>` block rather than inline.

**Priority 4 — Replace inline heading styles with CSS classes**

12. **view-monitoring h1 (line 2485):** Move `style="font-size:1.1rem;font-weight:800;color:var(--sla-navy);margin:0 0 3px;"` from the `h1` element to a CSS class in the stylesheet (e.g. `.page-title`), and apply it consistently across all page headers.

13. **view-comparison subtitle (line 2795):** Replace `style="font-size:0.8rem;color:var(--text-muted);"` on the `<p>` with a reusable `.page-subtitle` class.

**Priority 5 — Rationalise max-width values**

14. Define 1–2 canonical `max-width` values in `:root` (e.g. `--content-width: 1440px; --content-width-narrow: 1200px;`) and apply consistently. Currently the app uses 5 different max-widths: 1100px, 1200px, 1320px, 1400px, 1440px.

**Priority 6 — Rename the reused archive class**

15. **`.archive-header-row` used in Reports (lines 2842, 3842):** Extract a generic `.page-header-row` class with the shared flex+spacing rules, then have both `.archive-header-row` and any reports header extend or replace it. This prevents semantic confusion and makes future changes easier.

---

## Appendix — Quick Reference Table

| Page (view-*) | Container class | Padding (CSS) | Has h1/page title | Max-width |
|---|---|---|---|---|
| dashboard | `.dashboard-view` | `2rem` | ✅ `.dashboard-welcome h1` | 1200px |
| generator | `.app-container` | `1.5rem` | ❌ None | 1440px |
| monitoring | `.monitoring-view` | `1.5rem` | ⚠️ Inline-styled `h1` | 1400px |
| distribution (social) | `.social-view` | `1.5rem` | ❌ None | 1200px |
| calendar | `.calendar-view` | `2rem` | ⚠️ `div.calendar-title` (not h1) | 1100px |
| archive | `.archive-container` | `1.5rem` | ✅ `.archive-header-row h1` | 1440px |
| comparison | `.comparison-container` | `1.5rem` | ⚠️ `h1` after Back button | 1440px |
| reports | `.reports-container` | `1.5rem` | ✅ `.archive-header-row h1` (reused class) | 1440px |
| pipeline | `.pipeline-container` | None (header: 1.1rem top) | ❌ `div.pipeline-title` (not h1) | — |
| llm | `.llm-page` | `1.5rem` | ❌ None | 1400px |
| settings | `.settings-container` | `1.25rem 1.5rem` | ❌ None | — |
| categories | `.cats-page` | `1.5rem` | ✅ `.cats-hero h1` | 1320px |

# Tech Spec — Article Highlight & Comment System for the Vance Health Hub WordPress Theme

**Status:** ✅ IMPLEMENTED & deployed to vancehealthhub.co.uk (2026-07-08). All 8 milestones shipped, plus features beyond spec. See **Appendix B — as-built record** for what was built, what diverged, and the bugs found in the process.
**Author:** Clifton Flack (spec drafted with Claude Code)
**Date:** 2026-07-08 (spec) · implementation record appended 2026-07-08
**Source system:** VANCE Content Generator (alpha) — `index.html` in-app commenting, `api/review/[token].js` email review flow, `api/content/[id]/comment.js`
**Target system:** Vance Health Hub WordPress theme (self-hosted WP)

---

## 1. Summary

Port the highlight-and-comment ("annotation") feature from the VANCE Content Generator into the Vance Health Hub WordPress theme, and extend it with:

1. **Text highlighting + inline comments** on published articles, in the front-end article view (logged-in users only).
2. **Image annotation** — select a region of any in-article image and attach a comment (net-new; does not exist in the source system).
3. **Email review flow** — tokenized links that let a reviewer comment without a WP session (optional module, ported from the Content Generator).
4. **WP Customizer panel** — master on/off toggle plus settings (roles, image commenting, colors, sidebar position, email notifications, Claude integration).
5. **Claude Code integration** — an authenticated export endpoint + workflow so Claude Code can pull open comments, synthesize them into a **to-do list held in "pending approval"** state, and only act once the site owner approves (the "cowork" loop).

### Non-goals (v1)

- Anonymous / logged-out commenting (explicitly excluded — logged-in only).
- Threaded replies on annotations (flat list + resolve/delete, matching the source system).
- Real-time multi-user cursors / live co-annotation.
- Replacing native WP comments — this is a separate system with its own storage and UI.

---

## 2. Background — how the source system works today

The Content Generator implementation is the reference behavior. Key facts to preserve or deliberately change:

### 2.1 Anchoring: quote-string re-matching (no offsets)

Highlights persist **only the selected text** (`quote`), never DOM paths or character offsets. At render time a `TreeWalker` concatenates the article's text nodes, runs a **whitespace-flexible, case-insensitive** regex for the quote, maps the match back to text nodes, and wraps it in `<mark class="article-highlight" data-note-id="N">`. Case-insensitivity is required because Chromium's `Selection.toString()` uppercases `text-transform: uppercase` headings. If `Range.surroundContents()` throws (selection spans element boundaries), a fallback wraps the first ~60 chars of the start node.

**Known weakness:** brittle to body edits — if the quoted text changes, the mark silently fails to anchor (the comment still shows in the side panel). See §5.2 for the v1 improvement (context selectors).

### 2.2 Data shapes (source of truth for the port)

Persisted highlight (server-sanitized):

```json
{ "quote": "string ≤1000 chars", "comment": "string ≤2000 chars" }
```

Per-reviewer feedback entry (`rejectionComments[]` on the content item):

```json
{
  "reviewerId":  "user id",
  "authorName":  "display name",
  "comment":     "merged blob: inline-note preamble + overall feedback",
  "overall":     "raw overall feedback",
  "at":          "ISO timestamp",
  "highlights":  [ { "quote": "...", "comment": "..." } ],
  "resolved":    true, "resolvedAt": "ISO", "resolvedBy": "userId",
  "deleted":     true, "deletedAt": "ISO", "deletedBy": "userId"
}
```

The `comment` field is a **denormalized merge** — each inline note is flattened as `> "quote"\n↳ comment\n\n` and prepended to the overall feedback, so downstream consumers (the AI-revise prompt) read one text blob. The WP port stores structured data and generates this merged form only at export time (§8.3).

### 2.3 Flows

- **In-app:** toolbar toggle → `mouseup` selection → floating "💬 Add comment" pill → popover → `POST /api/content/{id}/comment` → server re-renders + re-anchors. Side panel lists Overall feedback + Inline notes with hover popovers, scroll-to-mark, **Resolve/Unresolve** and **soft Delete** via PATCH.
- **Email:** `api/review/send.js` mints two JWTs per reviewer (approve/reject, HS256, 7-day expiry) and emails links via Resend. **GET never mutates** (defends against Outlook/Gmail link-prefetch scanners) — it serves the article + commenting widget; POST submits. "Request changes" records a rejection vote + comments but does not veto approval.
- **Image commenting: does not exist** in the source system. Net-new (§6).
- **To-do extraction: does not exist.** The only consumer of comment content is the AI-revise prompt. Net-new (§8).

---

## 3. Architecture in WordPress

### 3.1 Packaging: theme companion plugin, loaded by the theme

Implement as a **companion plugin** (`vhh-annotations/`) that the Vance Health Hub theme bundles (TGMPA-style require or `include` from theme, with graceful no-op if absent). Rationale:

- Annotations are **data + API**, and data must survive a theme switch (WP.org theme guidelines also prohibit non-presentational functionality in themes).
- The theme owns the **presentation** (CSS variables, sidebar placement, template hooks); the plugin owns storage, REST API, capabilities, email tokens, and the Claude export.

If distribution simplicity wins and this stays a private theme, the same code can live in `theme/inc/annotations/` — the module boundary below is unchanged. **Decision: companion plugin (recommended).**

### 3.2 Module layout

```
vhh-annotations/
├── vhh-annotations.php          # bootstrap, activation (schema), settings defaults
├── includes/
│   ├── class-storage.php        # comment-type storage + meta (see 4)
│   ├── class-rest.php           # /wp-json/vhh/v1/* endpoints (see 7)
│   ├── class-capabilities.php   # caps, role mapping, logged-in gating
│   ├── class-customizer.php     # Customizer section + settings (see 9)
│   ├── class-email-review.php   # token links, mail templates (see 10)
│   ├── class-claude-export.php  # export endpoint + todo CPT (see 8)
│   └── class-frontend.php       # asset enqueue, article-view integration
├── assets/
│   ├── js/annotator.js          # selection capture, anchoring, image regions
│   ├── js/sidebar.js            # notes panel, resolve/delete
│   └── css/annotations.css      # marks, pins, popover, panel (uses theme CSS vars)
└── templates/
    └── email-review.php         # standalone reviewer page (email flow)
```

### 3.3 Access gating

- Front-end UI renders **only for logged-in users** with the `vhh_annotate` capability. For logged-out visitors the theme outputs the article exactly as today — **zero annotation JS/CSS enqueued** (no dead weight, no leak of the feature's existence).
- Existing annotations are likewise only fetched/rendered for authorized users; they are never in the public HTML.
- Capabilities:
  - `vhh_annotate` — create highlights/comments (default: Administrator, Editor; Customizer lets you extend to Author/Contributor/Subscriber).
  - `vhh_moderate_annotations` — resolve, delete, approve Claude to-dos (default: Administrator, Editor).
- Email-token reviewers bypass WP auth via signed tokens scoped to one post + one reviewer (§10) — the token **is** the credential.

---

## 4. Data model

### 4.1 Storage: WP comments with a custom `comment_type`

Store each annotation as a row in `wp_comments` with `comment_type = 'vhh_annotation'`, structured payload in comment meta. Rationale: free author/date/post indexing, cascading delete with posts, WP-CLI and REST plumbing exist, no custom-table migrations. Rows with a custom `comment_type` are excluded from front-end comment templates and counts by default.

| WP field | Use |
|---|---|
| `comment_post_ID` | article post ID |
| `user_id` / `comment_author` | annotator (0 + name for email-token reviewers) |
| `comment_content` | the comment text (≤2000 chars, sanitized) |
| `comment_approved` | `1` open · `vhh-resolved` · `trash` (soft delete) |
| `comment_agent` | channel: `viaApp` \| `email-review` |

Comment meta:

| Meta key | Value |
|---|---|
| `_vhh_target_type` | `text` \| `image` |
| `_vhh_selector` | JSON selector (see 4.2 / 4.3) |
| `_vhh_overall` | `1` if this is an "overall feedback" entry (no selector) |
| `_vhh_content_hash` | `md5` of `post_content` at annotation time — detects stale anchors |
| `_vhh_resolved_by`, `_vhh_resolved_at` | audit fields |
| `_vhh_claude_task_id` | back-link once absorbed into a to-do (§8) |

### 4.2 Text selector — W3C-style quote + context

Upgrade the source system's bare `quote` to a **TextQuoteSelector** (W3C Web Annotation model) to fix the biggest known weakness (quote collisions and edit brittleness):

```json
{
  "type": "TextQuoteSelector",
  "exact": "the selected text, ≤1000 chars",
  "prefix": "≤64 chars of text immediately before",
  "suffix": "≤64 chars of text immediately after"
}
```

Anchoring algorithm (port of `_ahWrapMatch`, extended):

1. Concatenate text nodes of the article body via `TreeWalker`, keeping a node→offset map.
2. Whitespace-flexible, **case-insensitive** regex match on `exact` (keep the source system's Chromium `text-transform` workaround).
3. If multiple matches, disambiguate with `prefix`/`suffix` (choose the candidate whose surrounding text best matches).
4. Wrap via `Range.surroundContents(<mark>)`; on failure, per-text-node multi-mark wrap (improves on the source's "first 60 chars" fallback — wrap each intersected text node in its own `<mark>` so cross-element selections render fully).
5. No match → the note still appears in the sidebar flagged **"⚠ text changed since this note"** (compare `_vhh_content_hash`).

### 4.3 Image selector — normalized rectangle (net-new)

```json
{
  "type": "ImageRegionSelector",
  "src": "attachment URL at annotation time",
  "attachmentId": 123,
  "region": { "x": 0.42, "y": 0.10, "w": 0.25, "h": 0.18 }
}
```

- Coordinates are **normalized 0–1 fractions of the rendered image**, so anchors survive responsive resizing and `srcset` swaps.
- `attachmentId` (resolved server-side from the `src` / `wp-image-{id}` class) is the durable key; `src` is the fallback for hotlinked images.
- A full-image comment is `region: {x:0, y:0, w:1, h:1}` (the UI offers "comment on whole image" as a one-click option).

---

## 5. Front-end UX — text highlighting (article view)

Port of the Content Generator UX, consolidated from its three duplicate widget implementations into **one** `annotator.js`.

### 5.1 Interaction flow

1. Logged-in user with `vhh_annotate` sees a **"Comments" toggle** in the theme's article toolbar (or a floating action button — theme decides via a template hook `vhh_annotations_toolbar`).
2. Toggle on → article body gets a `vhh-commenting` class (text cursor), `mouseup`/`selectionchange` listener attached to the article content container (theme declares it via `data-vhh-annotatable` on the content wrapper).
3. User selects text → floating **"💬 Add comment"** pill appears near the selection (position from `Range.getBoundingClientRect()`; on touch devices, anchored above the native selection handles).
4. Pill click → popover with the quoted text (trimmed preview) + textarea + Save/Cancel.
5. Save → optimistic `<mark>` wrap locally, `POST /wp-json/vhh/v1/annotations` (§7). On failure, unwrap + toast.
6. Marks render with `class="vhh-mark" data-annotation-id="{id}"`. Hover/tap → popover showing author avatar, name, relative time, quote, comment, and (for moderators) Resolve/Delete.

### 5.2 Sidebar panel

- A collapsible **notes panel** (right rail on desktop ≥1024px, bottom sheet on mobile) lists: **Overall feedback** entries, then **Inline notes** ordered by document position.
- Clicking a note scrolls to and pulses its mark (or image pin). Orphaned notes (anchor failed) show the ⚠ badge.
- Per-note actions: **Resolve / Unresolve** (strikethrough + collapse; mark dims to 40% opacity), **Delete** (soft — `comment_approved = trash`, hidden from UI, retained for audit), gated by `vhh_moderate_annotations` or note ownership.
- Panel header: filter (Open / Resolved / All), count badge, and — for moderators — the **"Send to Claude"** shortcut (§8.4).

### 5.3 Overall feedback

A panel-level **"Add overall feedback"** button posts an annotation with `_vhh_overall = 1` and no selector — preserving the source system's overall/inline duality that the merged-export format (§8.3) depends on.

---

## 6. Front-end UX — image annotation (net-new)

1. In commenting mode, hovering any `img` inside the annotatable container shows a subtle "📌 comment on image" affordance (outline + cursor crosshair).
2. **Click-drag on the image** draws a marquee rectangle (semi-transparent fill, dashed border). Releasing opens the same comment popover. A plain **click without drag** offers "Comment on whole image."
3. On save, region is normalized against the image's current rendered box (`getBoundingClientRect()`), producing the `ImageRegionSelector` (§4.3).
4. **Rendering:** each image with annotations gets a positioned overlay `<div class="vhh-img-overlay">` (image wrapped in `position:relative` container at enqueue time, or via `ResizeObserver`-tracked absolute overlay to avoid disturbing theme layout). Regions render as outlined boxes with a numbered **pin badge**; hover/tap → the standard popover.
5. Overlay re-computes on `ResizeObserver` + `load` events so pins track responsive resizes and lazy-loaded/`srcset`-swapped images.
6. Touch: long-press starts the marquee; a corner handle allows resize before saving.

**Edge cases:** images inside galleries/sliders anchor by `attachmentId`, so the pin renders wherever that attachment appears; if the image is removed from the post, the note goes to the sidebar as orphaned (⚠).

---

## 7. REST API

Namespace `vhh/v1`. All routes require authentication (cookie + `X-WP-Nonce` from the front-end; **Application Passwords** for Claude Code; signed review token for the email flow). Standard WP sanitization (`sanitize_textarea_field`, length caps 1000/2000 matching the source), and per-user rate limit (30 writes/min) via transients.

| Method | Route | Cap | Purpose |
|---|---|---|---|
| `GET` | `/annotations?post={id}&status=open\|resolved\|all` | `vhh_annotate` | list annotations for a post |
| `POST` | `/annotations` | `vhh_annotate` | create — body: `{ post, target_type, selector, comment, overall }` |
| `PATCH` | `/annotations/{id}` | owner or `vhh_moderate_annotations` | `{ action: "resolve" \| "unresolve" \| "delete" }` |
| `GET` | `/export?post={id}\|since={ISO}&status=open&format=json\|merged` | `vhh_moderate_annotations` | Claude-facing export (§8.3) |
| `GET` | `/todos?status=pending\|approved\|done` | `vhh_moderate_annotations` | list Claude-generated to-dos |
| `POST` | `/todos` | `vhh_moderate_annotations` (App Password) | Claude posts a proposed to-do list |
| `PATCH` | `/todos/{id}` | `vhh_moderate_annotations` | `{ action: "approve" \| "reject" \| "done" }` |
| `POST` | `/review/send` | `vhh_moderate_annotations` | issue email review links for a post |
| `GET/POST` | `/review/{token}` | signed token | email reviewer page + submission (§10) |

Response envelope for annotations mirrors §4 (id, post, author `{id, name, avatar}`, target_type, selector, comment, status, created, resolved meta) so the front-end and Claude consume the same shape.

---

## 8. Claude Code integration — comment extraction → approved to-do list

### 8.1 Concept

Claude Code (running locally, or as a Claude Code scheduled cloud agent / "cowork" session) periodically pulls open annotations, clusters them into **actionable to-dos** (e.g., "3 comments flag the dosage table in *Understanding IBD Nutrition* as outdated → task: verify + update dosage table"), and **proposes** them back to WordPress. Nothing is acted on until the site owner **approves** each to-do in WP admin. Approval state is the contract: Claude only executes approved items.

```
WP annotations ──GET /export──▶ Claude Code session
                                   │  cluster, dedupe, draft tasks
WP todos (pending) ◀──POST /todos──┘
        │ owner reviews in WP admin (or the notes sidebar)
        ▼
   approve ──▶ Claude Code picks up approved todos on next run ──▶ executes
                (content edits as WP drafts / revisions — never direct publish)
        ▼
   PATCH /todos/{id} action=done  +  resolve source annotations
```

### 8.2 To-do storage: `vhh_todo` custom post type

Private CPT (`show_ui` in admin, not public). Fields:

- `post_title` — task summary; `post_content` — detail + proposed action.
- `post_status`: `vhh-pending` → `vhh-approved` / `vhh-rejected` → `vhh-done`.
- Meta: `_vhh_source_annotations` (array of annotation IDs), `_vhh_target_post`, `_vhh_claude_session` (session/run identifier), `_vhh_proposed_diff` (optional: proposed replacement text for simple fixes).
- Admin list table adds **Approve / Reject** row actions + bulk actions; approving fires `vhh_todo_approved` action hook (extensible: notify, webhook, etc.).
- Absorbed annotations get `_vhh_claude_task_id` back-links and show "⏳ in a proposed task" in the sidebar.

### 8.3 Export formats

`GET /wp-json/vhh/v1/export` supports:

- `format=json` (default) — structured array: post info (id, title, permalink, edit link), annotations with selectors, author, status. This is what Claude should consume.
- `format=merged` — the source system's denormalized blob per post (`> "quote"\n↳ comment` preamble + overall), for compatibility with the existing AI-revise prompt style in `lib/revise.js`.
- `since={ISO}` for incremental pulls; response includes `exported_at` for the next cursor.

Auth: WP **Application Password** for a dedicated `claude-bot` user holding only `vhh_moderate_annotations` + `read` (+ `edit_posts` capped to drafts if Claude will draft fixes). Credentials live in Claude Code env (`VHH_WP_URL`, `VHH_WP_APP_PASSWORD`) — never in the repo.

### 8.4 Claude Code side

- A project skill/command in the theme repo — **`/extract-comments`** — that: pulls `/export?since=<last-cursor>&status=open`, clusters annotations by post + theme, drafts to-dos (one per coherent action, citing source annotation IDs and quotes), `POST /todos` each with status `vhh-pending`, and prints a summary. State (cursor) kept in `tasks/annotation-cursor.json`.
- A second command — **`/work-approved-todos`** — pulls `status=approved`, and for each: performs the edit **as a WP draft/revision** (via REST `posts` endpoint), marks the todo `done`, resolves its source annotations, and reports for human review before publish.
- Optional automation: a Claude Code **scheduled agent** (or cron on the Vercel side of the Content Generator) running `/extract-comments` daily. Manual trigger also available from WP: the sidebar's **"Send to Claude"** button simply flags annotations for the next pull (no server-to-Claude push in v1 — pull model keeps credentials one-directional).

### 8.5 Safety rails

- Claude never publishes, deletes content, or resolves annotations that aren't attached to an **approved** todo.
- Every todo lists its source annotation IDs — the approval screen shows the underlying quotes/comments inline so approval is informed.
- All Claude-initiated writes are attributed to the `claude-bot` user → full audit trail in WP.

---

## 9. WP Customizer settings

Section: **Appearance → Customize → Article Annotations** (`vhh_annotations`). All settings live in one `vhh_annotations_options` option (autoloaded), filterable via `vhh_annotation_setting`.

| Setting | Control | Default |
|---|---|---|
| **Enable annotations** (master toggle) | checkbox | off |
| Allowed roles | multi-check (Editor/Author/Contributor/Subscriber; Admin always on) | Admin + Editor |
| Enable image annotation | checkbox | on |
| Enable email review links | checkbox | off |
| Email link expiry (days) | number 1–30 | 7 |
| Post types annotatable | multi-check (post, page, CPTs) | post |
| Highlight color | color picker | theme accent @ 30% |
| Resolved-mark style | select: dim / hide | dim |
| Sidebar position | select: right rail / bottom sheet / floating panel | right rail |
| Show marks to all logged-in users vs. annotators only | select | annotators only |
| Email notification on new annotation (to post author) | checkbox | off |
| **Claude integration: enable export endpoint** | checkbox | off |
| Claude bot user | user dropdown | — |
| Auto-resolve annotations when their todo completes | checkbox | on |

- Master toggle off → no assets enqueued, REST routes return `403 vhh_disabled`, Customizer children hidden via `active_callback`.
- Live preview: color and sidebar-position settings use `postMessage` transport.
- All settings sanitized server-side (`sanitize_callback` on every setting).

---

## 10. Email review flow (optional module)

Port of `api/review/send.js` + `api/review/[token].js`, adapted to WP:

1. **Send:** from the post edit screen (meta box "Request review") or `POST /vhh/v1/review/send` — select reviewers (WP users or bare emails), choose approve-required or feedback-only. For each reviewer, mint a signed token: `base64url(payload).hmac_sha256(payload, wp_salt('auth'))` with payload `{post_id, reviewer, action, exp}` (default 7 days, Customizer-controlled). Two links per email: **Approve** and **Request changes**. Mail via `wp_mail()` (site's SMTP plugin handles deliverability).
2. **GET `/review/{token}`** — never mutates (preserve the source system's link-prefetch defense verbatim: Outlook/Gmail scanners follow GET links). `action=changes` serves a standalone, theme-light page (`templates/email-review.php`) rendering the article with the same `annotator.js` (text + image annotation both work) + overall-feedback textarea. `action=approve` serves a confirm page with a POST button.
3. **POST** — approve records an approval meta on the post; changes submission creates annotations authored as the reviewer (`user_id=0`, `comment_author` from token, `comment_agent='email-review'`). Requires ≥1 of overall/highlights.
4. Approvals are votes, not vetoes — "request changes" never blocks approval (source-system semantics preserved).
5. Token pages are `noindex`, tokens single-post-scoped, and every token embeds the reviewer identity for attribution.

---

## 11. Security & privacy

- **Logged-in only, capability-gated** at every layer: asset enqueue, REST `permission_callback`, and render. No annotation data ever reaches logged-out HTML or REST responses.
- Nonce (`X-WP-Nonce`) on all cookie-authed writes; Application Passwords over HTTPS for Claude; HMAC tokens for email (constant-time compare, expiry enforced).
- Sanitize all input (`sanitize_textarea_field`; selectors validated against strict JSON schemas — reject unknown keys, clamp region values to 0–1, cap quote/comment at 1000/2000 chars, matching source limits).
- Escape all output (`esc_html` comments, marks built via `createTextNode` — never `innerHTML` from stored data) → no stored-XSS path.
- Soft delete everywhere (trash status), audit meta (`resolved_by/at`, `deleted_by/at`) on every state change.
- Rate limiting: 30 annotation writes/min/user; 5 review-send calls/min.
- These are medical-content articles: annotations may contain reviewer names + clinical remarks — they inherit WP's user-data handling; add the `vhh_annotation` type to WP's personal-data exporter/eraser hooks.

---

## 12. Implementation milestones

| # | Milestone | Scope | Acceptance check |
|---|---|---|---|
| 1 | Plugin skeleton + storage | CPT/comment-type registration, caps, activation, settings option | annotation CRUD via WP-CLI works; caps enforced |
| 2 | REST API | routes in §7 (annotations only), nonce + App Password auth, sanitization | create/list/resolve/delete via REST with correct 401/403s |
| 3 | Text annotation front-end | annotator.js selection→pill→popover, TextQuoteSelector anchor + fallback, marks, sidebar panel, resolve/delete | notes survive reload; anchor works on multi-paragraph + uppercase-heading selections; orphan flag on edited text |
| 4 | Image annotation | marquee, normalized regions, pins, ResizeObserver tracking, whole-image mode | pins track window resize + srcset swap; whole-image + region comments both round-trip |
| 5 | Customizer | full §9 panel, master toggle gating assets + REST, live-preview color | toggle off = zero footprint; role setting changes take effect without cache flush |
| 6 | Claude integration | export endpoint, `vhh_todo` CPT + approve UI, `/extract-comments` + `/work-approved-todos` commands | end-to-end: comment → extract → pending todo → approve → Claude drafts fix → todo done + annotation resolved |
| 7 | Email review | token mint/verify, send meta box, reviewer page, GET-safe semantics | Outlook prefetch does not mutate; email reviewer can highlight text *and* images |
| 8 | Hardening | rate limits, privacy exporter, i18n, a11y pass (keyboard selection commenting, ARIA on popovers), theme handoff docs | keyboard-only user can create + resolve a note |

Milestones 1–3 are the MVP; 4–6 deliver the differentiators; 7–8 complete parity + polish. Each milestone is a working increment — ship behind the master toggle from milestone 3 onward.

---

## 13. Open questions (decide at session start)

1. **Packaging final call** — companion plugin (recommended, §3.1) vs. theme-embedded module?
2. **Who sees marks** — should Subscribers with `vhh_annotate` see *other* people's annotations, or only their own? (Default in §9: annotators see all; flip to own-only if reviewers shouldn't cross-contaminate.)
3. **Claude execution scope** — should `/work-approved-todos` be allowed to edit `post_content` as drafts (spec'd), or should v1 stop at producing the approved to-do list and leave edits fully manual?
4. **Scheduled vs. manual extraction** — daily scheduled Claude agent, or manual `/extract-comments` runs only for v1?
5. **Gutenberg editor surface** — is a back-end (block editor) annotation view needed, or is front-end-only sufficient for v1? (Spec assumes front-end only.)
6. **Sync back to Content Generator** — should WP annotations flow back into the Content Generator's `rejectionComments` for articles it published (via its existing WP publish linkage), or stay WP-side? (Spec assumes WP-side only for v1.)

---

## Appendix A — divergences from the source system (deliberate)

| Source system | WP port | Why |
|---|---|---|
| Bare `quote` string anchor | TextQuoteSelector with prefix/suffix | fixes duplicate-text collisions and edit brittleness |
| First-60-chars fallback wrap | per-text-node multi-mark wrap | cross-element selections render fully |
| Merged `comment` blob stored | structured storage, blob generated at export | single source of truth; `format=merged` keeps AI-revise compatibility |
| Three duplicate widget copies | one `annotator.js` | maintenance |
| JWT via `jose` + `JWT_SECRET` | HMAC token via `wp_salt('auth')` | no extra dependency or secret to manage in WP |
| Resend for email | `wp_mail()` | site-standard SMTP path |
| No image annotation | normalized-rect regions + pins | requirement |
| No to-do extraction | export + `vhh_todo` approval loop | requirement |

---

## Appendix B — Implementation record (as-built, 2026-07-08)

Built as a companion plugin at `wp-content/plugins/vhh-annotations/` in the Vance Health Hub theme repo, deployed live and committed. This appendix captures what was actually built, the open-question decisions, features added beyond the spec, and the non-obvious bugs found along the way (worth carrying back into the Content Generator).

### B.0 Open questions — decisions taken

1. **Packaging** → companion plugin (as recommended). Deploy handled by a second leg in the existing CI (`deploy.yml`) with a `hashFiles` guard + first-deploy `mkdir`, plus a manual tar-over-SSH command in CLAUDE.md.
2. **Who sees marks** → **all logged-in users** see all comments. This was later widened further (see B.2): the front-end gate is now `is_user_logged_in()`, not the `vhh_annotate` capability — any logged-in user can view, comment, and reply. Moderation (resolve/delete/export) still needs `vhh_moderate_annotations`.
3. **Claude execution scope** → drafts allowed. Superseded in practice by an **in-plugin AI-edit engine** (B.2) so edits no longer require Claude Code at all.
4. **Extraction cadence** → manual. Plus a self-service **"Generate to-dos" button** in wp-admin (B.2).
5. **Gutenberg surface** → front-end only, but the whole page is annotatable (B.1), not just the article body.
6. **Sync back to Content Generator** → not built; WP-side only.

### B.1 Anchoring & coverage — as-built

- **TextQuoteSelector** (`exact` + `prefix`/`suffix`) with whitespace-flexible, case-insensitive matching and per-text-node multi-mark fallback — as spec'd (§4.2, §5). Verified with 27 jsdom tests including cross-element and partially-selected-element (`<strong>`) cases and duplicate-phrase disambiguation.
- **Whole-page coverage (beyond spec):** the annotatable root is not just `.oped-article-body`. The plugin wraps the entire page — nav, sidebar, footer, body — via the theme's existing `wp_body_open`/`wp_footer` hooks (a `display:contents` wrapper so layout is untouched), with **zero theme edits**. This also fixed custom page templates (e.g. the GI Health hub) that never call `the_content()` and so could never have been covered by a `the_content` filter.
  - **Known limitation:** the homepage runs in "latest posts" mode (no single post ID) and is not annotatable. Every other singular view is.

### B.2 Features added beyond the original spec

- **In-plugin AI-edit engine** (`class-vhh-apply.php`) — the biggest addition. Instead of Claude Code applying approved edits, an admin clicks **"Generate AI edit preview"** on a to-do; the plugin (via **admin-ajax**, no page reload) calls the site's existing **OpenRouter** key (reused from the theme's Ask AI config, `vance_askai_api_key`/`vance_askai_model`) with a strict copy-editor prompt, stores the proposal in post meta, and opens a **modal popup in one click** with the changed excerpt **rendered as HTML** (block-level Text_Diff → before/after panes via `wp_kses_post`, unchanged blocks skipped) plus a collapsible raw `wp_text_diff`. (If a preview already exists, the button reads "Review changes" and just opens the modal; "Regenerate" re-runs the AJAX in place.) **Confirm & apply** writes the edit as a reversible WP revision, marks the to-do done, and auto-resolves the source comment. The article is never touched until the human confirms the exact diff. Guards: refuses truncated output (`finish_reason=length`), refuses under 40% length, warns outside 0.7–1.5x, and refuses a stale preview (source hash changed).
- **Threaded replies** (was an explicit v1 non-goal) — a reply is a `vhh_annotation` comment with `comment_parent` set and no selector; top-level queries scope to `parent=0` and `to_api()` attaches a flat `replies[]`. Any logged-in user can reply from the sidebar.
- **All logged-in users participate** — gate widened from the `vhh_annotate` capability to `is_user_logged_in()` (view/create/reply). Moderation caps unchanged.
- **Sidebar polish:** Open/Done/All filter (fixed to also filter the cross-page list), a **category tag** + author username on each card, a cross-page **"Other pages"** section (site-wide `post=0` list) with links back to each article, and **auto-archive to Done** — applying a to-do resolves its source comment, which shows a "Done" badge and drops out of the default Open view.
- **Self-service "Generate to-dos" button** in the Claude To-Dos admin (mechanical 1:1 from open, un-linked comments) alongside the smarter `/extract-comments` skill.
- **Simplified approval flow** — the separate approve step / Approval meta box / row actions were removed. The single "Review & apply" box on a pending to-do is the whole surface: view context, generate the AI preview, confirm or reject.

### B.3 Bugs found in implementation (carry these back to the Content Generator)

1. **WP double-unslashing corrupts JSON/backslashes.** `wp_insert_comment`, `wp_insert_post`, and `update_*_meta` all `wp_unslash()` their input internally. Passing a `wp_json_encode`'d selector (or any text with backslashes / `\uXXXX` escapes) straight in silently strips the backslashes — `json_decode` then returns null and the highlight orphans. Fix: `wp_slash()` everything before those calls. (Check the Content Generator's own JSON persistence for an analogous unescape.)
2. **Popover state race.** `openPopover()` began by calling `closePopover()`, which nulled the pending selection that the just-opened Save handler needed → text saves posted `selector: null` and were rejected server-side. Fix: capture the selection in the handler's closure, not shared state. (The three duplicate widget copies in the source system likely share this latent bug.)
3. **Nested `<form>` in a WP meta box.** Meta boxes render inside the post-editor's main `<form>`; a nested `<form>` is invalid HTML, so the browser drops it and the button submits the outer form → bounced to `edit.php`. Fix: use nonce'd `<a class="button">` links to `admin-post.php`, never nested forms.
4. **`is_main_query()` is false for admin list tables.** A `pre_get_posts` guard on `is_main_query()` never fires for the wp-admin post-list table (it builds its own query via `wp_edit_posts_query()`, not `$wp_the_query`). Gate on `is_admin()` + post type instead.
5. **`internal` post statuses vanish from admin lists.** `register_post_status(..., 'internal' => true)` defaults `exclude_from_search` to true, so `WP_Query post_status => 'any'` (and `wp post list`) silently skip those rows — a filed to-do looked like it "disappeared." Fix: `exclude_from_search => false` plus a `pre_get_posts` default that includes all workflow statuses.
6. **"Mark done" that doesn't do the thing.** An early meta-box "Mark done" button let a human mark a to-do complete without the edit being applied. Removed it; "done" is now set only by the apply step. Lesson: never expose a completion control that doesn't perform the completion.
7. **GMT timestamp shift.** `mysql2date('c', $gmt, false)` re-interprets a GMT datetime in the site timezone. Use `gmdate('c', strtotime($gmt . ' UTC'))`.
8. **Category entity double-encoding.** `get_the_category()->name` can carry HTML entities ("Food &amp; Nutrition"); since the sidebar renders via `textContent`, decode with `wp_specialchars_decode()` server-side or the literal `&amp;` shows.
9. **GDPR eraser correctness.** `WP_Comment_Query`'s status wildcard is `'all'`, not `'any'` (which matches literally and returns nothing); and a hard-deleting eraser must always query page 1, since paginating while deleting skips every other batch.
10. **App Passwords need HTTPS + a non-broken permission match.** The Claude export can't authenticate over `http://` site URLs; and SSH allow-rules keyed on a command prefix miss commands that insert `-o ConnectTimeout=…` between the port and host — key-scope the rule instead.

### B.4 Verification approach

No local WP instance was used; validated with `php -l` on every file, `node --check` on the JS, **71 jsdom unit/integration tests** (anchoring engine, pill→save flow, sidebar tags/replies/filter/reply-POST), and live-server checks via `wp eval`/`wp eval-file` (reply nesting, parent exclusion, category decode, AI `generate()` round-trip, admin-list visibility, logged-out pages carrying zero annotation output). An 8-angle adversarial code review before first deploy caught findings 1, 2, 7, and 9 above.

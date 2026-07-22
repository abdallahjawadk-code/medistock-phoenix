# Inventory Center + OCR — visual evidence

Captured by `node scripts/phoenix-capture-inventory-ocr.mjs` against the dev-only
visual-QA harness on 2026-07-20, from branch `feat/phoenix-canonical-inventory-ocr`.

Run:

```
VITE_ENABLE_VISUAL_QA=true npx vite --port 5181 --strictPort
node scripts/phoenix-capture-inventory-ocr.mjs
```

Last run: **34 screenshots, all assertions passed, exit 0.**

## What is real here, and what is not

**Real.** The OCR captures are produced by the shipped code. The runner uploads a
de-identified fixture into the real `<input type="file">` and the real
browser-local Tesseract recognizes it from our self-hosted `/assets/ocr`. Every
bounding box, confidence band, quality verdict, catalog-match outcome and
duplicate warning below is engine output, not a mock.

**Not real.** The screens are backed by the QA fixture Supabase client, which is
SELECT-only by hard design. It proves nothing about RLS, authorization or
functional correctness — only about layout, state and gating.

**Consequence:** there is no "completed human-confirmed draft" screenshot, and
there cannot be one from this harness. A successful submit needs a mutating RPC,
which the fixture client refuses (`QA_READONLY`). `*-09-submit-outcome.png`
therefore shows the *error* path — the operator's corrections survive, the
request id is retained, and the intake error is classified and displayed. The
success state remains **unevidenced** and needs a live authenticated session.

## Inventory Center (9)

`inventory-{ar,en}-{dark,light}-{desktop,mobile}.png` plus
`inventory-ar-dark-tablet.png` (768×1024). Desktop is 1440×900, mobile 390×844.

Asserted per cell: correct `lang`/`dir`/`data-theme`; no page error; no console
error; no horizontal overflow; warehouse selector and all three tabs present and
enabled; every touch target ≥44×44.

## OCR flow

Two full passes — `ocr-en-dark-desktop-*` and `ocr-ar-dark-mobile-*`:

| # | File suffix | State |
|---|---|---|
| 01 | `capture-upload` | Capture / upload, language selector, camera-capable file input |
| 02 | `image-quality` | Quality assessment on the decoded image |
| 03 | `recognition-progress` | Engine loading / recognizing, cancel reachable |
| 04 | `review-bounding-boxes` | Split review, boxes on the document |
| 05 | `low-confidence-fields` | Uncertain / needs-review bands |
| 07 | `final-preview-zero-prechecked` | Final preview, **no** confirmation pre-ticked |
| 08 | `confirmed-ready-to-submit` | After the explicit warehouse confirmation |
| 09 | `submit-outcome` | Submit result (see caveat above) |

Blocking duplicate/conflict, in both languages — `ocr-conflict-{en,ar}-*`. The
fixture warehouse holds Amoxicillin batch `B4471X` at a *different* expiry, so a
clean read must block. It does: "The same batch is on file with a different
expiry" / "نفس التشغيلة مسجلة بتاريخ نفاد مختلف". `-02` proves the gate holds
**after every confirmation is ticked** — ticking cannot buy past a conflict.

Cancel / retry / error — `ocr-edge-*`: quality warning on a degraded document,
retake returning to capture, cancel available during recognition (measured at
**39 ms** after start), and the post-cancel state with the image intact.

Ambiguous material — `ocr-ambiguous-01`: two catalog rows for Paracetamol that
`central_items` cannot separate (no concentration column), so the matcher
correctly refuses to choose. This is the documented tier-1/tier-3 blocker.

## Assertions that fail the run

Page error · console error · horizontal overflow · missing Beta banner on any OCR
stage · critical control hidden or unexpectedly disabled/enabled · blank OCR
preview · zero bounding boxes after a successful recognition · final confirm
enabled before all required confirmations · a confirmation control that cannot be
clicked because another element intercepts the pointer · confirming a field
navigating away from the flow.

## Defects this run found and fixed

1. **Bounding boxes did not mark the text they came from.** `minWidth`/
   `minHeight: 44px` with `content-box` was on the *drawn* rectangle, inflating
   every small region into a 44px block. Fixed in `OcrReviewWorkspace.tsx`: the
   rectangle is now true-size, with a non-painting `[data-hit-area]` child
   preserving the 44px target. Verified by eye, not by DOM.
2. Sign-out button 86×26 (`PhoenixSidebar.tsx`).
3. Org-scope `<select>` 220×35 (`PhoenixOrgScope.tsx`) — on every viewport.
4. Skip-to-content link 40px tall (`phoenix-nexus.css`).
5. Harness fixture gap: `phoenix_get_pending_platform_broadcasts` had no fixture,
   so every shell-based QA cell logged a console error.

## Known gaps

- Success-after-submit is unevidenced (above).
- **Not yet proven:** on-screen-keyboard occlusion of the active field or the
  confirmation button, and large-image processing not freezing navigation.
  Neither is covered by the current assertions; both need a real device or a
  virtual-keyboard emulation this runner does not do.
- A fixed "© 2026 · MASAR" badge and the search FAB float over page content on
  mobile. They do not block the confirmation controls (proven — the run ticks
  them with actionability checks on), but they do overlap the document pane.
- Contrast is asserted only implicitly, by capturing both themes. No programmatic
  contrast-ratio check runs.

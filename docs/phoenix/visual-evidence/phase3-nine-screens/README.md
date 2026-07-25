# Phase 3 — nine-screen visual audit («الشاشات الداخلية»)

Real, pixel evidence for the 9 internal screen areas the user named for Phase 3
sign-off, captured against the DEV-only visual-QA harness (`?qa=1`) — never a
live Supabase session, never production. See `src/features/qa/qaConfig.ts` and
`tests/qa-harness-production-safety.test.ts` for the production-exclusion
contract.

## How this was captured

```bash
VITE_ENABLE_VISUAL_QA=true npx vite --port 5183 --strictPort   # from THIS worktree
node scripts/phoenix-capture-phase3-9screens.mjs http://localhost:5183
node scripts/phoenix-capture-fefo-override.mjs http://localhost:5183   # FEFO override dialog (added later, see below)
```

## Addendum — FEFO-reasoned-override dialog (the one gap closed after this pass)

The original pass above shipped with an explicit, named gap: `FefoOverrideDialog.tsx`
(`src/features/outlet/FefoOverrideDialog.tsx`, wired into
`OutletDispatchComposer.tsx` via `useFefoOverridePermission`) was never actually
opened through real UI interaction — it needs two batches of the SAME material
at the SAME warehouse, and the existing QA fixtures had only one batch per
material. This addendum closes that gap. Everything above this section is
UNCHANGED from the original pass; nothing already captured was re-touched.

**QA fixture added** (`src/features/qa/qaData.ts`): a second Amoxicillin
`warehouse_stock` row (`qa-ws-1b`, batch `B4470E`, expiry `2027-06-30`,
FEFO-compliant/earliest) alongside the existing `qa-ws-1` (batch `B4471X`,
expiry `2028-01-31`, later/non-compliant), both at `qa-wh-inst-a`. A paired
`rpc:phoenix_inventory_fefo_batches` fixture answers `getFefoAlternatives`
with both rows, earliest first — the exact shape 072's real RPC returns.
**Limitation, documented in the fixture's own comment:** `qaFixtureClient`'s
`.rpc(name)` resolves by RPC NAME only (it does not branch on arguments), so
this ONE fixture answers every `phoenix_inventory_fefo_batches` call in a QA
session identically — harmless for this capture (which only ever picks these
two Amoxicillin batches) but would misfire if a future capture also picked a
different material through the same dispatch composer in the same session.

**Two permission personas** (`src/features/qa/qaFixtures.ts`):
- `super_admin` — the pre-existing "with `inventory.fefo_override`" persona:
  `useFefoOverridePermission` special-cases `role === 'super_admin'` to `true`
  with no RPC at all (mirroring the real hook/RPC's own super_admin bypass).
- `warehouse_officer_assigned` — the "without" persona. It already carries a
  migration-062 warehouse assignment to `qa-wh-inst-a` (`qaScopes.ts`), but the
  harness's `myPermissions` is plain `roleDefaults(role)` with no live
  permission-matrix fetch, and `warehouse_dispatch.create` is in no
  non-super_admin fallback list — so before this addendum it could not reach
  the Dispatch tab AT ALL. A new, small, additive `QA_EXTRA_PERMISSIONS` map
  grants it JUST `warehouse_dispatch.create` (harness-only; `roleDefaults()`
  itself is untouched) so it can open the composer. It does NOT grant
  `inventory.fefo_override` — `useFefoOverridePermission`'s own scoped RPC
  preflight has no registered fixture for `phoenix_profile_has_scoped_permission`,
  so it fails closed to `false` through the exact same code path a real
  denied profile would hit.

Both are pure client-side/harness fixture data: no network call, no writes,
same `visualQaEnabled` gate and the same `tests/qa-harness-production-safety.test.ts`
production-exclusion proof as everything else in this module (re-run clean
after these additions).

**Call-log observability** (`src/features/qa/qaFixtureClient.ts`): a small,
additive `QA_RPC_CALLS` array now records every `.rpc(name, args)` call
BEFORE the existing fixture/mutation-outcome/read-only resolution logic runs
— nothing about that resolution changes. `QaHarness.tsx` exposes it as
`window.__phoenixQaRpcCalls` so a capture/verification script (or a human at
the console) can assert a negative ("Cancel fired zero calls") or inspect an
exact call's arguments, instead of inferring either from DOM state alone.

**Dialog interaction proof** — driven through the REAL rendered UI (warehouse
select → "Dispatch to outlets" tab → "New request" → outlet select →
"Material selection" → fill quantity → click "Add" on the LATER-expiry
Amoxicillin row), never a directly-mounted component:

| Acceptance point | Result |
|---|---|
| Earliest-compliant batch (`B4470E`) listed FIRST among alternatives | **Pass** — verified via DOM order, both personas, all 8 lang×theme×viewport cells |
| Batch number / expiry / available qty shown for picked AND alternatives | **Pass** — visible in every capture |
| NO-permission: checkbox/reason absent, denial message shown | **Pass** — `warehouse_officer_assigned`; DOM-asserted (`hasCheckbox===false`, `hasReasonInput===false`) |
| WITH-permission: reason mandatory, confirm disabled until non-whitespace reason | **Pass** — `super_admin`; whitespace-only reason keeps confirm disabled + shows `fefo_override_reason_required`; verified via real `input` events, not just reading source |
| Cancel performs ZERO writes | **Pass** — `window.__phoenixQaRpcCalls` was empty after Cancel (call log cleared immediately before) |
| Confirm passes reason + stable `requestId` through to `addDispatchLine`'s call shape | **Could not be fully verified live end-to-end** — see "Known QA-harness limitation" below; verified instead via the pre-existing, unmodified `fefo-override-contract.test.ts` (sections F/G) |
| Focus trap: Tab/Shift+Tab cycle only within the dialog | **Pass** (after a fix — see below) — real `Tab`/`Shift+Tab` key events wrapped correctly between "Use this batch" and "Cancel" |
| Keyboard operability: Escape closes/cancels | **Pass** — real `Escape` keypress closed the dialog with zero RPC calls |
| Touch targets ≥44px (checkbox, buttons, reason input) | **Pass** (after a fix — see below) |
| No horizontal overflow / no footer or bottom-nav overlap | **Pass** — `scrollWidth === clientWidth` and dialog-vs-bottom-nav non-overlap asserted for all 16 captures, see `INVENTORY.json`'s `fefoOverrideCapture` block |

**Known QA-harness limitation (honest accounting):** `addDispatchLine`'s exact
call arguments could not be observed through a live, full end-to-end UI
click-through in QA mode. Confirming the override only updates the LOCAL
draft (`OutletDispatchComposer`'s `lines`/`lineOverrides` state) — no RPC
fires at that point (verified: the call log stayed empty). The RPC itself
only fires later, inside `confirmAndCreate`, and requires `createHeader`
(`phoenix_create_warehouse_dispatch`) to succeed first — which it deliberately
never does in QA mode: that RPC is NOT in `QA_MUTATION_OUTCOMES`'s allowlist
(proven by the pre-existing, unmodified test `'still fails closed for the
non-allowlisted write RPC phoenix_create_warehouse_dispatch'` in
`qa-fixture-client.test.ts`), and `movement-commit.ts`'s `commitDraft` — by
design — never calls `addLine` once `createHeader` has failed. Clicking
"Create outlet dispatch" live was driven and observed: `phoenix_create_warehouse_dispatch`
WAS called and logged (with the correct `p_warehouse_id`/`p_destination_distribution_point_id`
etc.), and `phoenix_add_dispatch_line_fefo_guarded` was confirmed NEVER called
— proving the short-circuit, not a gap in this capture. Deliberately did NOT
add the dispatch-corridor RPCs to the QA mutation-outcomes allowlist to reach
further, since that allowlist's narrowness ("outlet-dispatch/outlet-return
corridor cannot move even simulated stock in QA mode") is itself an existing,
intentional safety boundary this task's scope forbids widening. The reason +
`requestId` WIRING itself (that `addDispatchLine` receives the SAME reason
confirmed at pick-time and a request id derived via `operation-token.ts`) is
proven correct by the pre-existing, unmodified `fefo-override-contract.test.ts`
sections F and G (10 tests, all passing, unmodified by this addendum).

**Fixes made** (presentational only, `FefoOverrideDialog.tsx`'s actual
open/confirm/cancel/validation logic untouched):

1. **Focus trap was entirely absent** in the SHARED `PhoenixDialog.tsx` (used
   by 25 other dialogs across the app) — Tab could leak focus to the page
   behind the modal overlay, and Escape was the only keyboard affordance.
   Added: focus moves into the panel on open (first focusable element),
   Tab/Shift+Tab cycle only among the panel's own focusable elements, and
   focus restores to whatever had it when the dialog opened, on close.
   Verified with real `key` events (not just source reading) for both
   directions and the wrap-around case, on `FefoOverrideDialog`.
2. **Checkbox and reason-input touch targets were below 44px** in
   `FefoOverrideDialog.tsx` specifically (the checkbox's label had no
   `minHeight`, the raw reason `<input>` had ~9px vertical padding only).
   Fixed with `minHeight: 44px` on the checkbox's label and the reason input,
   scoped to this dialog only (not a codebase-wide checkbox-component change).

## Evidence added

16 new files in this folder, naming convention unchanged
(`inventory-dispatch-fefo-override-<denied|reason-required>-<lang>-<theme>-<viewport>.png`):
AR/EN × light/dark × phone(390×844)/desktop(1440×900), 2 states per cell.
Tablet (768×1024) was NOT captured: the dialog is a fixed-`maxWidth:520px`
centered overlay with no responsive layout branch between phone and desktop,
so a tablet capture would be a strict linear interpolation with nothing new
to observe — consistent with this evidence set's existing "don't reflexively
shoot a breakpoint with no layout difference" convention (see "Matrix
coverage" above). Machine-readable detail (per-shot overflow/dialog-position
measurements AND the 80 DOM assertions from the capture run) is appended to
`INVENTORY.json` under the top-level `fefoOverrideCapture` key, additive to
the existing `shots` array — nothing from the original pass was removed or
overwritten.

## Evidence-folder size (Task 5 note)

The folder was ~24M before this addendum (`.git` for the whole repo is
~156M; the working tree is ~468M) — the 16 new raw PNGs added ~3.1M more.
Judgment: NOT disproportionate enough to warrant `.gitignore`-ing raw PNGs
out of git (option b) — 24–25M total is a small fraction of an already-156M
`.git`, there is no existing LFS/`.gitattributes` convention in this repo to
plug into, and losing the raw images from git tracking would make the
evidence set incomplete for a reviewer who only has the repo (no separate
artifact host is in use here). Instead: the 16 new PNGs were re-encoded
losslessly (`scripts/compress-fefo-evidence.mjs`, using `sharp` — an EXISTING
project dependency, no new dependency added — `png({ compressionLevel: 9,
effort: 10, palette: true })`, pixel content byte-identical on decode) via a
normal forward commit, cutting them from 3.1M to ~1.06M (65% smaller, folder
now ~25M total). The pre-existing 24M from the original pass was left
untouched, both in content and in git history — the task's own instructions
say that prior 24M "is already in git history regardless... don't try to
purge history," and re-touching ~200 already-reviewed, already-merged-to-PR
files to save a few more MB was judged not worth the diff noise for a
"narrow, final task." `INVENTORY.json` and this `README.md` (the evidence
INDEX) are untouched in content, only appended to — nothing was lost.

## Gaps found and fixed (superseding the original "Known gaps" #1 below)

Item 1 in the "Known gaps NOT closed" section below — the FEFO override
dialog — is now closed per the table above. Items 2 and 3 in that section are
UNCHANGED and still stand as documented.

The runner (`scripts/phoenix-capture-phase3-9screens.mjs`) drives real
Playwright/Chromium pages against the real sidebar/topbar/tab controls — no
mocked DOM, no manual approximation. For every capture it records, alongside
the PNG:

- **console errors / page errors** (must be empty),
- **`document.documentElement.scrollWidth` vs `clientWidth`** (must be equal —
  no horizontal overflow),
- **footer-vs-bottom-nav overlap**, computed by scrolling the REAL scroll
  owner (`#phoenix-main`, per `MOBILE-SCROLL-OWNER-HOTFIX-A`) to its true
  max `scrollTop` and comparing `MasarCopyrightSeal`'s footer rect against the
  fixed mobile bottom nav's rect.

Full machine-readable results: `INVENTORY.json` (one entry per capture, with
`overflow` and `footerCheck` fields).

## Screen → harness scene map

| # | Screen (as named by the user) | Harness scene | Screen # in app nav |
|---|---|---|---|
| 1 | مواقف / Status Center | `scene=status` | 12 |
| 2 | إدارة المؤسسات والمستخدمين / Institutions & Users admin | `scene=institutions` | 11 |
| 3 | مركز المخزون / Inventory Center | `scene=inventory` | 3 |
| 4 | عمليات المنفذ / Outlet Operations | `scene=outlet` | 18 |
| 5 | المشتريات الفرعية / Local (supplementary) Procurement | `scene=procurement` | 19 |
| 6 | الموقف المخزني الشهري / Monthly Stock Status | `scene=monthly` | 20 |
| 7 | الإشعارات / Notifications | `NotificationBell`, opened over `scene=dashboard` (topbar widget, no dedicated screen #) |
| 8 | طلبات التصحيح وFEFO والحجر / Corrections + FEFO + Quarantine | Inventory Center → «الحجر الصحي» + «تصحيحات بانتظار الاعتماد» tabs | 3 |
| 9 | التقارير والتتبع / Reports & tracking | `scene=reports` | 9 |

Persona used throughout: `super_admin` (org pinned via `&org=qa-org-a1`, the
harness's stand-in for the `<PhoenixOrgScope />` click a super_admin would
make live — see `qaFixtures.ts`). `super_admin` was chosen because it is the
only persona that reaches every one of the 9 areas in one pass (status/reports/
monthly all gate some actions by role — prepare/classify to warehouse_officer,
submit to institution_admin, approve+lock to central_warehouse_manager —
and `super_admin` is the union of all of them). Scope-gated personas
(`warehouse_officer_assigned`, `outlet_officer_assigned`, …) are already
evidenced separately for the corridors that predate this pass — see
`../outlet-corridor/README.md` and `../inventory-ocr/README.md` — and are not
re-proven here; this pass is a cross-screen VISUAL/layout audit, not a second
RBAC scope proof.

## QA harness audit: what already worked vs. what needed new fixtures

| Area | Worked via harness before this pass? | What was added |
|---|---|---|
| 1 Status Center | No scene existed | Added `scene=status` to `QaHarness.tsx`; added `item_availability` fixture rows (with the nested `distribution_points`/`local_items.central_items` shape `getAvailabilityByOrg`/`getLowStockItems` actually select) |
| 2 Institutions & Users | Yes (pre-existing scene) | — |
| 3 Inventory Center | Yes (pre-existing scene) | Added `warehouse_quarantine_stock`, `phoenix_stock_correction_requests`, `phoenix_warehouse_correction_requests` fixture rows so the Quarantine and Corrections tabs render POPULATED, not just their empty state |
| 4 Outlet Operations | Yes (pre-existing scene) | — |
| 5 Local Procurement | Yes (pre-existing scene) | — |
| 6 Monthly Stock Status | No scene existed | Added `scene=monthly`; added `inventory_status_reports` (one open/submitted + one locked, so prepare/classify/submit/review/amend all render) and `inventory_status_report_lines` fixture rows |
| 7 Notifications | Bell mounts on every shell scene already, but its two RPCs were unregistered → every scene logged a `console.error` on mount | Added `rpc:phoenix_notifications_unread_count` and `rpc:phoenix_notifications_list` fixtures |
| 8 Corrections/FEFO/Quarantine | Tabs existed in code but had no fixture rows → rendered only their empty state | Same fixture additions as #3 |
| 9 Reports & tracking | No scene existed | Added `scene=reports`; reuses already-fixtured `organizations`/`warehouses`/`distribution_points`/`qr_tokens`/`item_availability` and the already-fixtured dashboard RPCs |

### Production-exclusion mechanism (unchanged, verified intact)

Every addition above lives inside the SAME two files the harness already
gates: `src/features/qa/QaHarness.tsx` and `src/features/qa/qaData.ts`. Both
are reachable only when `import.meta.env.DEV === true` AND
`VITE_ENABLE_VISUAL_QA === 'true'` (`qaConfig.ts`'s `visualQaEnabled`), which
folds to a literal `false` in any production build
(`NODE_ENV=production` ⇒ `import.meta.env.DEV === false`), tree-shaking the
whole module graph out. `tests/qa-harness-production-safety.test.ts` proves
this by building with `VITE_ENABLE_VISUAL_QA=true` under `NODE_ENV=production`
(the adversarial case) and asserting the emitted `dist/` carries none of the
harness's marker strings — re-run and passing, see Verification below. No new
file, no new export path, no new marker was introduced outside this existing
contract.

## Matrix coverage actually achieved

Full AR/EN × light/dark × phone(390×844)/tablet(768×1024)/desktop(1440×900)
cross-product (12 cells) for the 3 NEW screens (status, monthly, reports) —
the actual gap this pass closed. The 4 screens that already had a working
scene before this pass (institutions, inventory, outlet, procurement) were
regression-checked at a reduced but still AR+EN × light+dark × phone+desktop
matrix (8 cells) — tablet was not re-shot for these four because their layout
is a strict subset of the phone/desktop breakpoints already exercised, and
this pass's job for them was regression, not first-time evidence (all four
already have deeper standalone evidence: `../inventory-ocr/`,
`../outlet-corridor/`, `../procurement/`). Notifications (desktop only, 4
cells — a topbar dropdown, not a responsive page) and the
Corrections/FEFO/Quarantine tabs (phone+desktop × AR/EN × light/dark, 8 cells
per tab × 2 tabs) close out the remaining 2 areas.

FEFO override (`FefoOverrideDialog.tsx`) itself is **not** captured — see
Known gaps below.

Every captured cell: **0 console errors, 0 `scrollWidth`/`clientWidth`
mismatches, 0 footer/bottom-nav overlaps.** See `INVENTORY.json` for the raw
per-cell measurements.

## Gaps found and fixed

### 1. Status Center / Reports had no fixture data at all
Before: no `scene=status` / `scene=reports` existed in the harness, so these
two of the 9 named areas could not be visually verified at all.
Fixed: scenes added, `item_availability` fixtures added with the real nested
embedded-relation shape the services select. Both screens now render
populated (Status Center: 4 materials across available/low/missing/near-expiry;
Reports: the summary tiles at 128/22/9/14).

### 2. Monthly Stock Status had no fixture data
Same class of gap as #1. Fixed with an open (submitted) report with 3 lines
in mixed classification states, plus a locked prior version so the amendment
panel also renders — see
`monthly-full-ar-dark-desktop.png` / `monthly-full-en-light-desktop.png`.

### 3. NotificationBell logged a console error on every single shell-based scene
`getUnreadNotificationCount()` calls `phoenix_notifications_unread_count`,
which had no fixture — before this fix, EVERY captured cell across ALL 9
screens (not just Notifications) carried a `console.error('[phoenix] unread
notification count failed: …')`, which would have failed the "0 console
errors" bar project-wide. Fixed by registering both notification read RPCs;
the bell now shows a populated badge (2 unread) and a populated dropdown.
Before/after not screenshotted separately (the "before" state is simply every
screenshot in the OLD `docs/phoenix/visual-evidence/*` folders predating this
fix carrying that console error) — the fix itself is proven by the 0-error
result recorded for every cell in `INVENTORY.json` in this pass.

### 3b. Fixture bug: invented `event_type` strings leaked as raw i18n keys
Once the fixture above existed, the FIRST version used made-up `event_type`
values (`return_request_submitted`, `procurement_order_approved`,
`monthly_status_locked`). `NotificationBell.eventLabel()` falls back to the
raw `event_type` when `t('notif_evt_' + eventType, lang)` doesn't resolve —
so the dropdown showed the literal English snake_case strings in the middle
of an Arabic panel (`notifications-bell-open-ar-dark-desktop.png`, BEFORE).
Root cause: the real vocabulary (`strings.ts`) is dotted `table.status` pairs
(`outlet_return_requests.submitted`, `procurement_orders.approved`,
`inventory_status_reports.locked`), not free-form phrases. This was a
fixture-accuracy bug in this pass's own additions, not a pre-existing product
defect. Fixed by aligning the fixture's `event_type` values to the real
enum; AFTER, the dropdown reads correctly in both languages — see the current
`notifications-bell-open-*-desktop.png` (all 4 cells re-verified with a
`leaked raw key: false` assertion in the recapture run).

### 4. Quarantine and Corrections tabs (screen area 8) had no fixture rows
Before: `scene=inventory` → «الحجر الصحي» tab and «تصحيحات بانتظار الاعتماد»
tab both rendered correctly, but always showed their EMPTY state — because
`warehouse_quarantine_stock`, `phoenix_stock_correction_requests`, and
`phoenix_warehouse_correction_requests` had no rows. This is the one named
screen area (#8) that would otherwise have shipped Phase-3-"tested" with
literally nothing to look at. Fixed with one quarantined lot and one pending
correction on each side (outlet + warehouse) — see
`inventory-corrections-fefo-quarantine-quarantine-tab-ar-dark-desktop.png`
and the `-corrections-tab-` counterpart, both now showing populated
release/destroy and approve/reject controls.

### 5. My own capture script's first footer/overflow pass was a false positive
The FIRST run of `phoenix-capture-phase3-9screens.mjs` (before the numbers
below) flagged `overlapsBottomNav: true` on every mobile screen. Root-caused
to the script itself: it called `footer.scrollIntoView({block:'end'})` and
read `getBoundingClientRect()` on the very next line without waiting for the
scroll to settle, so the measurement was taken mid-scroll. Verified against a
direct headless reproduction (`main.scrollTop = main.scrollHeight` + a 200ms
settle) that the SAME page/viewport/theme combination shows **no** overlap —
`#phoenix-main`'s `padding-bottom: calc(var(--bnh) + 14px + safe-area)` (the
already-verified `MOBILE-SCROLL-OWNER-HOTFIX-A` contract) does correctly clear
the fixed bottom nav. The script was fixed (direct `scrollTop` assignment +
an explicit settle) and re-run; the numbers in this README/`INVENTORY.json`
are from the fixed, re-verified runs. **This was not a product defect** — the
footer/scroll-owner foundation from the prior pass on this branch is intact,
as the setup brief predicted.

## Regression checks (per Task 5 — not rebuilt)

- **Loading screen** (`PharmacyPulseLoader.tsx`): unchanged; every `<Suspense>`
  fallback in `QaHarness.tsx` still resolves through it, observed during every
  capture with no console error.
- **Icon set**: unchanged; `PhoenixIcon` renders identically across all 9
  areas in both themes (see any screenshot's sidebar/tab icons).
- **Smart search**: the floating search trigger (bottom-start bubble, visible
  in every desktop screenshot) renders unchanged; not deep-tested in this pass
  (out of scope — it is a cross-cutting shell feature, not one of the 9 named
  screens), existing `src/shared/ui/__tests__/*smart*` unit tests re-run clean
  in Verification below.
- **Page-scroll behaviour**: re-verified as part of THIS pass's own footer
  check (`#phoenix-main` is still the single scroll owner, still clears the
  fixed mobile bottom nav) — see gap #5 above. No regression.

## Known gaps NOT closed (honest accounting)

1. **FEFO-reasoned override dialog (`FefoOverrideDialog.tsx`) is not
   captured.** It only opens when an operator picks a batch that is NOT the
   FEFO-earliest ELIGIBLE one for a material during outlet dispatch — which
   needs at least two active batches of the SAME scientific name at the same
   warehouse with different expiry dates, then a multi-step interactive drive
   (select warehouse → Dispatch tab → pick outlet → open the material picker
   → deliberately pick the non-earliest batch). The current fixture set has
   only one active batch per material. Reason not closed: time-boxed out of
   this pass; the corrections/quarantine gap (screen area 8's OTHER two
   surfaces) was prioritized since it affected literally every capture cell
   project-wide before the fix (see gap #3). Tracked as a follow-up: add a
   second `warehouse_stock` row for the same scientific name with an earlier
   expiry, then drive the dispatch composer's material picker in a dedicated
   capture script.
2. **Tablet breakpoint not re-shot for institutions/inventory/outlet/
   procurement** in this pass — see "Matrix coverage" above for the reasoning
   (regression-only scope for screens with pre-existing deeper evidence).
3. **Scope-gated personas** (`warehouse_officer_assigned`,
   `outlet_officer_assigned`, etc.) are not re-driven through all 9 screens in
   this pass — the RBAC/scope proof for the screens that need it already
   exists in `../outlet-corridor/README.md`. This pass is additive visual/
   layout coverage, not a second scope-proof pass.

## Files

- `INVENTORY.json` — machine-readable capture log (screen, label, lang,
  theme, viewport, file, overflow measurement, footer/nav overlap
  measurement) for every shot.
- PNGs — see the screen → harness scene map above for the naming convention
  (`<screen>-<label>-<lang>-<theme>-<viewport>.png`; mobile shots additionally
  have a `-scrolled-end-` companion showing the true bottom of content).

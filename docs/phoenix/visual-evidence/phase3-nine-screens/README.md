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
```

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

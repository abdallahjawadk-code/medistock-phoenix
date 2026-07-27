# Unified Reporting & Status Center — Equivalence Matrix

Audit basis for merging four separately-listed screens into one canonical
shell ("مركز التقارير والمواقف") with 11 real internal tabs. Nothing below
this file's KEEP/MERGE/MOVE column is deleted from the navigation until the
corresponding functionality lands in the unified shell and passes its own
equivalence test.

## Navigation model

No URL routing exists in this app (no react-router). Navigation is a single
integer `screen` state in `src/app/AuthenticatedApp.tsx` (`useState(12)`),
switched on in one `switch(screen)`, and duplicated across four nav surfaces
that must all change together: `PhoenixSidebar.tsx`, `PhoenixMobileDrawer.tsx`,
`PhoenixMobileBottomNav.tsx`, `CommandPalette.tsx`. "Redirect" therefore means:
the old screen numbers (9, 20, 21 — plus 12, since it becomes the new home
screen's number) resolve to the unified shell with the correct tab
pre-selected, not a URL rewrite.

Every deep-link into these four screens found in the codebase:
- `AuthenticatedApp.tsx:153` — logout resets to screen 12.
- `DecisionIntelligenceReportsScreen.tsx:1422` — Monthly deep-link tab → `onNavigate(20)`.
- `DecisionIntelligenceReportsScreen.tsx:1487` — Institutions tab "Open in Status Center" → `onNavigate(12)`.
- `PhoenixSidebar.tsx`, `PhoenixMobileDrawer.tsx`, `CommandPalette.tsx` — the four menu entries themselves.
- `PhoenixMobileBottomNav.tsx` — only screen 12 is on the bottom bar today.
- `DashboardScreen.tsx` references to 9/12 are dead code (screen never imported by `AuthenticatedApp.tsx`; only reachable from the dev-only `QaHarness.tsx`) — out of scope for this migration, flagged separately.

## Source screens

| # | Screen | Component | Lines |
|---|---|---|---|
| 9 | التقارير (Reports) | `src/features/reports/ReportsScreen.tsx` | 210 |
| 12 | مركز المواقف (Status Center) | `src/features/status/StatusCenterScreen.tsx` | 1178 |
| 20 | الموقف المخزني الشهري (Monthly Position) | `src/features/status/MonthlyStatusScreen.tsx` | 448 |
| 21 | مركز التقارير والذكاء القراري (Decision Intelligence) | `src/features/reports/DecisionIntelligenceReportsScreen.tsx` | 1653 |

Screen 21 is already structurally closest to the target 11-tab design (10 of
its own tabs map near-1:1) and is the most complete implementation for every
section it already owns — it is the base the unified shell is built from,
per its own header comment (lines 70-80) which already documents a
deliberate decision to keep screens 12 and 20 standalone rather than
duplicate their logic into 21.

## Equivalence matrix

| Item | Currently in | Decision | New tab | Notes |
|---|---|---|---|---|
| 4 metric cards (available/low/missing/near-expiry) | 9 (Summary) | **MERGE** | 1. الملخص التنفيذي | `phoenix_get_dashboard_condition_counts`'s 4 buckets are a subset of `phoenix_executive_overview`'s `classification_counts` (same table, same `condition` column) — verified by reading both RPC bodies (migrations 054, 119). Tab 1 must visually surface these same 4 labeled numbers from `classification_counts`, not just the executive overview's own totals. |
| Executive overview + supply-source drilldown + snapshot creation | 21 (overview) | **MOVE** | 1. الملخص التنفيذي | `ExecutiveOverviewTab` + `SupplySourceDrilldown`, verbatim. |
| Institution comparison (per-institution availability %) | 9 (Comparison) | **REMOVE** (redundant) | 2. الموقف الحي للمؤسسات | Same RPC (`phoenix_get_institution_condition_counts`) as 21's `InstitutionStatusTab`, which is richer (export+print). |
| Institution status tab (comparison + export/print) | 21 (institutions) | **MOVE** | 2. الموقف الحي للمؤسسات | `InstitutionStatusTab`, verbatim, including its "Open in Status Center" CTA which becomes an in-shell tab switch instead of `onNavigate(12)`. |
| Quick Actions grid | 12 | **MOVE** | 2. الموقف الحي للمؤسسات | Targets screens 11/13/6/15/14 — unrelated screens, stays a cross-navigation grid. |
| LIVE badge + status-count header card | 12 | **MOVE** | 2. الموقف الحي للمؤسسات | |
| Internal Alerts Section | 12 | **MOVE** | 2. الموقف الحي للمؤسسات | `InternalAlertsSection.tsx`, client-derived from already-loaded rows. |
| Recent Activity feed | 12 | **MOVE** | 2. الموقف الحي للمؤسسات | `CommandCenterActivityFeed.tsx`. |
| Live per-material availability table + filters (status/supply/search/quantity/recent/price/view-mode) + row actions (correct stock, reactivate, movement history) + outlet-grouped view | 12 (core) | **MERGE (12 wins)** | 3. المواد والدفعات | Replaces 21's simpler `MaterialsAndBatchesTab` (read-only subset, no row actions) — 12's version is a strict superset. All modals (`AvailabilityStockCorrectionModal`, `ReactivateMaterialModal`, `MovementHistoryModal`, `OutletAvailabilityReportModal`, `MobilePrintFallbackModal`) move with it. |
| XLSX export + print (availability table) | 12 | **MOVE** | 3. المواد والدفعات | `exportAvailabilityXlsx` / `printReport`. |
| InventoryIntelligencePanel (signals/thresholds/transfer suggestions) | 12 | **MOVE** | 3. المواد والدفعات | Self-gated on `inventory.view_signals`. |
| Materials & Batches tab (search-only) | 21 | **REMOVE** (superseded) | 3. المواد والدفعات | Superseded by 12's merged version above. |
| "Material Exchange Command Center" CTA → screen 13 | 12 | **KEEP** | 3. المواد والدفعات | Screen 13 (Inter-Institution Alerts) is not part of this merge; CTA stays a cross-navigation link. |
| Movement ledger report (`MovementReportSection`) | 12 (embedded), 21 (movements, embedded) | **KEEP** (already shared) | 4. الحركات المخزنية | Single shared component, was never duplicated — mount once in the new tab. |
| Custody Chain tab | 21 (custody) | **MOVE** | 5. سلسلة العهدة | `CustodyChainTab`, verbatim — dispatches, return requests/shipments, trace drilldown, dispense-context, paper references. |
| Corrections history tab | 21 (corrections) | **MOVE** | 6. الفروقات والتصحيحات | `CorrectionsHistoryTab`, verbatim. |
| Supplementary purchases tab | 21 (supplementary) | **MOVE** | 7. المشتريات الفرعية | `SupplementaryPurchasesTab` + `SupplementaryPurchaseDrilldown`, verbatim. |
| Full Monthly Position workflow (prepare → classify/stocktake → submit → approve+lock/return → amend) | 20 (entire screen) | **MOVE (real, not deep-link)** | 8. الموقف المخزني الشهري | Every RPC in `monthly-status.service.ts` (`phoenix_status_prepare_report`, `_classify_lines`, `_confirm_missing`, `_submit_report`, `_return_for_clarification`, `_approve_lock_report`, `_create_amendment`, `_record_stocktake`) moves with the UI, unchanged. Replaces 21's `MonthlyPositionDeepLinkTab` stub entirely — this is the one section explicitly called out as "not just a launch card." |
| Audit log | 9 (audit), 12 (audit), 21 (audit) | **KEEP** (already shared) | 9. سجل التدقيق والإجراءات الحساسة | `AuditLogSection`, single shared component — mount once. |
| Report Library + snapshot parity check | 21 (library) | **MOVE** | 10. مكتبة التقارير الرسمية | `ReportLibraryTab` + `SnapshotParityCheck`, verbatim, including the demo-organization watermark banner. |
| Global material search (super_admin only) | 9 (global) | **MOVE** | 11. البحث الشامل عن مادة | `GlobalMaterialSearchPanel` + `exportGlobalMaterialSearchWorkbook`, verbatim, super_admin gate preserved at both the tab-visibility level and the panel's own internal check. |

## Screens fully retired after migration

- **Screen 9** (`ReportsScreen`): every tab accounted for above (Summary→merge, Comparison→remove/redundant, Global→move, Audit→shared). Component becomes unused; nav entry removed.
- **Screen 12** (`StatusCenterScreen`): every section accounted for above, split across tabs 2 and 3. Component becomes unused; nav entry removed. This is the largest single migration (1178 lines) — filters, five modals, and all row-level write actions move with it, none re-implemented from scratch.
- **Screen 20** (`MonthlyStatusScreen`): entire workflow moves into tab 8 unchanged. Component becomes unused; nav entry removed.
- **Screen 21** (`DecisionIntelligenceReportsScreen`): becomes the unified shell itself (renamed/repositioned), not retired — it is the base every other screen's content is grafted onto.

## Permission/RBAC notes carried forward

- Screen 9's nav entries are `superAdminOnly: true` today; screen 21's are not. The new single nav entry must NOT be `superAdminOnly` (screens 12/20/21's content is for other roles too) — instead, tab 11 (Global Material Search) keeps its own internal `role === 'super_admin'` gate, exactly as it works today nested inside screen 9.
- `ScreenAuthzGuard.SCREEN_PERMISSION_KEYS` currently maps only screen 9 → `reports.view` (shadow-mode only, `enforce_super_admin` gate). Screens 12/20/21 have no route-level gate at all today. The unified shell's single screen number should carry the `reports.view` mapping forward (still shadow-mode, same enforcement mode) rather than silently dropping the one existing (if inert) mapping.
- Screen 20's role gates (`canPrepare`/`canClassify`/`canSubmit`/`canReview`, derived from `normalizeRole(role)`) are explicitly UX-only (every RPC re-checks server-side) — carried forward unchanged into tab 8.
- No other client-side role/permission gate is dropped: `STOCK_CORRECTION_VISIBILITY_KEYS`, `REACTIVATE_PERMISSION_KEYS`, `availability.movements.view/export/print`, `inventory.view_signals`, `users.view` (Quick Actions tile) all move with their owning section.

## Shared components inventory (must not be duplicated)

| Component | Used by (today) | Used by (after) |
|---|---|---|
| `AuditLogSection` | 9, 12, 21 | tab 9, mounted once |
| `MovementReportSection` | 12, 21 | tab 4, mounted once |
| `getInstitutionOverviews` / `phoenix_get_institution_condition_counts` | 9, 21 | tab 2 only (9's Comparison tab removed as redundant) |
| `getAvailabilityByOrg` | 12, 21 | tab 3 only (21's simpler Materials tab superseded) |
| `PhoenixOrgScope` (`activeOrgId`) | all four | unified shell, one instance, shared across all 11 tabs |
| `professional-export.ts` | 21 (all tabs), 12 (sibling `exportAvailabilityXlsx`) | each tab keeps its own export function; no consolidation of export *logic* required, only of the screen shell |
| `MobilePrintFallbackModal` | 12, 21 | wherever print is triggered, unchanged |

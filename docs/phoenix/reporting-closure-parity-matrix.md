# Reporting Closure — reuse-first gap/parity audit

Read-only audit of the four overlapping reporting surfaces, done before any
code changes, per the Reporting Closure acceptance gate. Source: full
codebase survey against `master` @ `6ecbb72517b404e4a6e2403e58a5b74f4670d8ed`
(Production).

**Global Material Search** is confirmed owned exclusively by
`GlobalMaterialSearchPanel.tsx`, rendered only inside `ReportsScreen.tsx`
(super_admin-gated). No other surface references it — must be preserved.

## Surface matrix

| Surface | Owns uniquely | Duplicates with | Known defects | Key files |
|---|---|---|---|---|
| **1. Reports (screen 9)** — `ReportsScreen.tsx` | Global Material Search tab (super_admin only); `summary`/`low`/`missing`/`comparison` tabs | Audit tab = shared `AuditLogSection.tsx` (also used by DIRC & Status Center) | None open. Audit UI intentionally moved to Status Center (`PHASE2-HIDE-REPORTS-MOVE-AUDIT-TO-STATUS-CENTER-A`); screen kept for back-compat | `reports/ReportsScreen.tsx`, `GlobalMaterialSearchPanel.tsx`, `global-material-search.service.ts`, `global-material-export.ts`, `AuditLogSection.tsx` |
| **2. Decision Intelligence Reporting Center (screen 21)** — `DecisionIntelligenceReportsScreen.tsx` (9 tabs) | Executive Overview (`phoenix_executive_overview`, `phoenix_supply_sources_detail`), Official Report Library (immutable server-numbered snapshots via `phoenix_create_report_snapshot`), Institution Status, Custody Chain (`phoenix_movement_timeline` + custody list RPCs), Differences & Corrections, Supplementary Purchases | **Stock Movements tab = literal `<MovementReportSection/>`** import from Status Center (zero divergence, "PURE embed"). **Audit-Sensitive Actions tab = literal `<AuditLogSection/>`** import. Materials & Batches reuses `getAvailabilityByOrg` (same fn Status Center calls) | "Blank Custody Chain page" (React hook-order crash) — **already fixed and regression-tested** in `__tests__/custody-chain-tab.runtime.test.tsx` during the Stage 1 recovery work this session. Not open. | `DecisionIntelligenceReportsScreen.tsx`, `decision-intelligence.service.ts`, `custody-chain.service.ts`, `differences-corrections.service.ts`, `supplementary-purchases.service.ts`, `ReportsTabErrorBoundary.tsx` |
| **3. Status Center and Reports (screen 12)** — `StatusCenterScreen.tsx` | Live availability matrix, `InternalAlertsSection`, `OutletMaterialGroups`, reactivation flow, `InventoryIntelligencePanel`, Quick Action Grid, Activity Feed | **Canonical home of `MovementReportSection.tsx`** (imported by DIRC); consumes shared `AuditLogSection.tsx`; calls `getAvailabilityByOrg` and `professional-export.ts` (both also used by DIRC / `OutletAvailabilityReportModal`) | None flagged. Manual `institution_item_status_reports` UI intentionally removed (data retained) — not a bug | `status/StatusCenterScreen.tsx`, `MovementReportSection.tsx`, `AvailabilityStockCorrectionModal.tsx` |
| **4. Monthly Inventory Position (screen 20)** — `MonthlyStatusScreen.tsx` | Sole owner of prepare→classify→submit→return/approve+lock workflow, entirely via `monthly-status.service.ts` | **None found** — no shared components with the other 3 surfaces | Confirmed by inspection: no opening+movements=closing reconciliation math anywhere in the service or screen — point-in-time snapshot only, as documented. This is a known, accepted limitation for this phase, not a regression to fix here. | `status/MonthlyStatusScreen.tsx`, `monthly-status.service.ts` |

## Consolidation signal

`AuditLogSection` and `MovementReportSection` are **already** single shared
components reused across 2–3 screens, not copy-pasted — good precedent to
extend. `getAvailabilityByOrg` / `professional-export.ts` are shared service
functions, not duplicated calculation logic.

The real duplication is **architectural surface count** — four entry points
into overlapping availability/movement/audit data — not code-level
copy-paste. Screen 21 (DIRC) is explicitly built as a superset/aggregator
embedding pieces of screens 9 and 12. Screen 20 (Monthly) is the only surface
with zero cross-reuse and a genuinely isolated, RPC-driven write workflow.

## Implication for this phase

- Do **not** delete or merge screens 9/12/20 in this phase (matches the
  standing Reporting Architecture Boundary — final consolidation waits for
  Unified Quantity Movements).
- The "blank Custody Chain page" item from the original defect list is
  **already resolved** — re-verify operationally (browser, not source scan)
  rather than re-fixing.
- Remaining defect-list items (CSV export, print, drill-down/export row
  parity, live-vs-snapshot correctness, org/role scoping, RTL, UI states)
  have not yet been operationally re-verified against the current Production
  build — that verification is the next step.

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

## SEQUENCING CORRECTION — PR #56 rescoped to Reporting Stabilization/Foundation

**Do not complete movement-dependent reporting consolidation before the
Unified Movements & Outlet Operations contract is finalized.** PR #56 is
rescoped from "Reporting Closure" to a narrower **Reporting
Stabilization/Foundation** checkpoint. No destructive consolidation, and no
temporary/invented movement data model, around `item_availability_movements`
or any movement-derived read path.

### In scope for THIS checkpoint (movement-independent infrastructure)

| Item | Why it's safe now |
|---|---|
| Custody Chain hook-order fix, Corrections crash fix (R01/R02) | Already merged to Production (PR #53→#54) — pure React lifecycle bug, no data-model dependency |
| CSV/XLSX export + print infrastructure (`MobilePrintFallbackModal`, export builders, zero-row honesty fix R03) | Already merged to Production, re-verified operationally this session with real captured bytes — generic infra, not movement-shaped |
| `ReportsTabErrorBoundary` | Pure React error containment, no data dependency |
| Navigation between the 4 surfaces | Pure routing/UI |
| Global Material Search (screen 9) | Availability-based (`item_availability`), not movement-ledger-based |
| Reports screen 9: Summary / Low Stock / Missing / Comparison tabs | Availability/dashboard-metric based, not movement-ledger-based |
| DIRC Executive Overview, Institution Status, Materials & Batches, Audit-Sensitive Actions, Supplementary Purchases tabs | Availability/procurement/audit based, not raw movement-ledger reads |
| Ownership/parity matrix (this document) | Documentation only |

### DEFERRED — movement-data-contract dependency (do not consolidate/rewire yet)

| Item | Why it's deferred |
|---|---|
| **Stock Movements tab (DIRC)** — embeds `MovementReportSection` | Reads `item_availability_movements` directly; shape will change under the canonical ledger |
| **Custody Chain tab (DIRC)** | `phoenix_movement_timeline` is movement-derived; canonical ledger will likely change its source/shape |
| **Differences & Corrections tab (DIRC)** | Corrections are movement-adjacent; the canonical contract will define how corrections post to the ledger |
| **Monthly Inventory Position (screen 20)** | The missing opening+movements=closing reconciliation is *exactly* what the canonical ledger must supply — do not build a temporary version |
| **Status Center's Quantity Movement Report section** | Same `MovementReportSection` component as DIRC's Stock Movements tab |
| **Patient/order/card/crash-cart context, movement-derived totals generally** | Not yet modeled anywhere in this codebase; explicitly reserved for the Unified Movements contract, not to be invented here |

These deferred items keep their **current, already-Production-verified
behavior** (including the genuine CSV/XLSX/print fixes, which are
data-model-independent and stay intact) — they are frozen in place, not
touched, until the canonical movement ledger exists to wire them to.

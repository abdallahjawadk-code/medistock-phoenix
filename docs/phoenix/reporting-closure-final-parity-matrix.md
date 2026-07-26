# Reporting Closure (Final) — updated ownership/parity matrix

Phase 1 deliverable for the Reporting Closure Final mission. This **extends**
the prior reuse-first audit
([`reporting-closure-parity-matrix.md`](reporting-closure-parity-matrix.md),
done at `master@6ecbb725` during PR #56/Reporting Stabilization) rather than
redoing it — that audit's surface-by-surface findings are still accurate and
are not repeated verbatim here except where the trigger condition it named
has now changed.

**Trigger that has now fired**: PR #56 explicitly deferred all
movement-dependent consolidation "until the canonical movement ledger
exists to wire them to." That ledger is the Unified Movements & Outlet
Operations contract (PR #57, migrations 122–137), now **merged to master
(`23bc7bd`) and live in Production** (`eyrzxgfkvqybjdgyphap`, verified
2026-07-26). This document re-surveys the four reporting surfaces against
that now-available contract and assigns the KEEP/MERGE/REDIRECT/REMOVE
decisions the original audit deferred.

Survey source: `master @ 23bc7bd4f0bea9b955293c8145f9d1f4d07d3e4e`
(this worktree's base), read-only code inspection, no changes made yet.

## Per-section decision matrix

| Section | Current surface(s) | Backend source (as of 23bc7bd) | Canonical-contract status | Unique capability to preserve | Decision |
|---|---|---|---|---|---|
| **النظرة التنفيذية** (Executive Overview) | DIRC only | `phoenix_executive_overview`, `phoenix_supply_sources_detail` RPCs | Availability/dashboard-metric based — not movement-ledger-shaped, unaffected by PR #57 | Live counts + supply-source breakdown | **KEEP** (DIRC is already sole owner) |
| **حالة المؤسسات** (Status Center, Reports-tab flavor) | DIRC "Institution Status" tab + `StatusCenterScreen.tsx` (screen 12) as separate nav entry | `getAvailabilityByOrg` (shared) | Availability-based, unaffected | Screen 12's live matrix, `InternalAlertsSection`, reactivation flow, Quick Action Grid, Activity Feed — **DIRC's tab is a narrower read view of the same data, not a superset** | **KEEP screen 12 as canonical operational surface; DIRC tab REDIRECTS/links into it** rather than duplicating a second live matrix — avoids two competing "status" views |
| **المواد والتشغيلات** (Materials & Batches, renamed from "و الدفعات") | DIRC tab only | `getAvailabilityByOrg` (same fn as Status Center) | Availability-based, unaffected | None unique — already a DIRC-only view | **KEEP in DIRC** (no duplicate exists to merge) |
| **حركات المخزون** (Stock Movements) | DIRC tab = literal `<MovementReportSection/>` embed; **also** a full copy of the same component inside `StatusCenterScreen.tsx` (screen 12) | `getAvailabilityMovementsReport()` in `availability.service.ts` → reads legacy **`item_availability_movements`** (migration 033) — **NOT the canonical ledger** | **GAP, now unblocked.** Migrations 122–137 give three ledgers (`warehouse_stock_movements`, `outlet_stock_movements`, `warehouse_quarantine_stock_movements`) with `reason_code`/`correlation_id`/`causation_id`/`source_movement_id`, plus `phoenix_movement_events`/`phoenix_movement_timeline` as the unified read envelope, plus dispense-context (patient/crash-cart/internal-order via `phoenix_movement_dispense_context`) — **none of this is surfaced in any report screen today** (confirmed: zero references to `dispense_context`/`beneficiary` under `src/features/reports` or `src/features/status`) | Existing filters (date range, movement type, outlet, material, user), CSV/XLSX/print infra (already Production-verified, data-model-independent) | **MERGE onto canonical contract.** One shared component (still `MovementReportSection`, already reused correctly) reads `phoenix_movement_timeline` instead of `item_availability_movements`, gains reason_code/correlation/causation columns and dispense-context drill-down (masked by role). DIRC tab and Status Center section both keep using the *same* component — no new duplication introduced. |
| **سلسلة العهدة** (Custody Chain) | DIRC tab only (`custody-chain.service.ts`) | `phoenix_movement_timeline` RPC — **already the canonical envelope** (migration 082, extended by 122) | **Mostly ready.** Already reads the unified timeline; needs verification that 122–137's contract fields (reason_code, correlation_id, causation_id, source linkage) are surfaced in its rendered columns, not just fetched | Dispatches / return requests / return shipments sections, paper-reference display, hook-order-crash regression coverage (already fixed & tested) | **KEEP + extend column set** — no architectural change, just surface the newer fields already present in the RPC response |
| **تتبع المشتريات الفرعية** (Supplementary Purchases tracking) | DIRC tab only | `procurement_orders` table direct read | Procurement-based, not movement-ledger-shaped — unaffected by PR #57, though correlates via `correlation_id` to receipt movements per migration 130 (Group E) | Filtering/tracking of `procurement_orders` | **KEEP**, optionally cross-link a row's receipt movement via `correlation_id` in a future pass — not required for closure |
| **الفروقات والتصحيحات** (Differences & Corrections) | DIRC tab only | `phoenix_warehouse_correction_requests`, `phoenix_stock_correction_requests` tables direct read | Correction-request lifecycle is movement-adjacent; migration 133 (Group H) defines how *approved* corrections post to the ledger with `reason_code` | Requested/approved/rejected status, before/after values, approver/timestamp | **KEEP**, add a "linked movement" reference once approved (via 133's contract) so a correction is traceable to its posted ledger entry — closes mission requirement 4C ("links to affected movements") |
| **الإجراءات الحساسة وسجل التدقيق** (Audit-sensitive Actions) | DIRC tab = literal `<AuditLogSection/>` embed; **also** embedded in Reports screen 9 and Status Center screen 12 | Shared `AuditLogSection.tsx` component, one query path | Audit-log based, unaffected by PR #57 | Already a single shared component, reused 3×, **zero duplication to fix** | **KEEP as-is** — this is the pattern to replicate for Stock Movements above, not a gap |
| **الموقف المخزني الشهري** (Monthly Inventory Position, screen 20) | `MonthlyStatusScreen.tsx`, standalone nav entry, zero cross-reuse | `phoenix_status_*` RPC family (`prepare`/`classify`/`confirm_missing`/`submit`/`return_for_clarification`/`approve_lock`/`create_amendment`/`record_stocktake`) + `inventory_status_reports(_lines)` tables | **Confirmed still isolated** — no overlap with the movement ledgers; its documented gap (no opening+movements=closing reconciliation) is exactly what the canonical ledger can now supply, but that is new functionality, not a consolidation | Full prepare→review→approve→lock workflow, official numbering, immutable snapshot, amendment path — **the most safety-critical surface in this matrix, must not be weakened** | **KEEP standalone workflow verbatim.** Add it as a **10th DIRC tab that deep-links to the existing screen** (navigation integration only, per mission Phase 2) — do not fold its RPCs into DIRC's data layer. Reconciliation-math enhancement (opening+movements=closing) is a candidate **follow-up**, not required for this closure, and must reuse `phoenix_movement_timeline`/ledger reads rather than inventing a parallel calculation. |
| **مكتبة التقارير الرسمية** (Official Report Library) | DIRC tab only | `phoenix_create_report_snapshot` RPC (mutation, explicit issue action), `phoenix_report_snapshots` table (read) | Snapshot-based, already immutable-by-design; unaffected by PR #57 structurally, but snapshot content can now cite canonical ledger fields | Immutable report ID, explicit issue-as-mutation contract, live-vs-snapshot distinction | **KEEP**, extend snapshot payload schema (additive only) to include `reason_code`/`correlation_id` context where the snapshot type is movement-derived |
| **Global Material Search** | Reports screen 9 only, super_admin-gated | `global-material-search.service.ts` | Availability-based, unaffected | Cross-institution real-balance search | **KEEP in screen 9** — confirmed still sole owner, no duplicate |

## Navigation consolidation implication

Per the original audit and reconfirmed here: **do not delete screens 9, 12,
or 20.** The mission's "single primary navigation entry" requirement is
satisfied by making **DIRC (screen 21) the canonical landing surface with
10 tabs**, while screens 9/12/20 remain reachable as:

- Screen 9 (Reports): kept for Global Material Search (super_admin-only,
  no duplicate elsewhere) — not a competing report surface once its
  Summary/Low/Missing/Comparison tabs are understood as availability
  dashboards, distinct from DIRC's movement/custody/correction reporting.
- Screen 12 (Status Center): kept as the **canonical live-operations**
  surface (matrix, alerts, reactivation, quick actions) — DIRC's "حالة
  المؤسسات" tab becomes a redirect/deep-link into it rather than a second
  live matrix.
- Screen 20 (Monthly Position): kept verbatim as its own screen; DIRC gains
  a 10th tab that deep-links to it.

No screen ID is deleted or made unreachable — this satisfies "no dead
screen IDs" while still resolving to one coherent entry point for the
*reporting* mental model.

## Backend-reuse ledger (Phase 3 preview)

| Canonical contract field/object | Currently reachable via | Consumers to wire (this phase) |
|---|---|---|
| `phoenix_movement_timeline` / `phoenix_movement_events` | `custody-chain.service.ts` (already) | **Stock Movements** (new), Monthly Position reconciliation (future, out of scope) |
| `reason_code`, `correlation_id`, `causation_id` | Present on all 3 ledgers since migrations 124–125 | Stock Movements, Custody Chain (surface, don't just fetch), Differences & Corrections (link approved correction → posted movement) |
| `phoenix_movement_dispense_context` + read RPCs | Migration 134/136, consumed only by `DispenseComposerDialog.tsx` today | Stock Movements drill-down (masked per role — patient/crash-cart/internal-order), nowhere else |
| `source_movement_id` chain | Migrations 127/128/135 | Stock Movements drill-down ("show originating movement") |

No new migration is anticipated for Phase 1/2 (navigation + read-surfacing
of already-existing contract fields). If a genuine backend gap is found
once implementation starts (e.g. a missing aggregate RPC to avoid N+1
reads), it starts at **migration 138**, forward-only, per mission rule.

## What Phase 1 does NOT change

Per mission scope and the "do not guess away a unique capability" rule, no
code has been modified in this commit. This document is the complete
Phase 1 deliverable; Phase 2 (navigation consolidation) and Phase 3
(canonical data contract wiring for Stock Movements) follow in subsequent
commits on this same branch, each independently tested per the mission's
operational-testing-at-every-milestone rule.

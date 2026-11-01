# R2 — final-send binding and operational candidate boundaries

The owner adopted final legal sending as the execution point on 2026-11-01. This document fixes the implementation boundary for the next independent SQL candidate. The policy is adopted; the SQL/API implementation described here is not activated or accepted merely by being documented.

## Accounting and reference ownership

Keep A (effective approved annual need), C (effective approved operational allocations), physical reservation, D (charged final sends less explicitly approved eligible settlements), actual receipt and stock balance separate. A missing/inconsistent reference is unavailable. Preserve signed overages. A−C is remaining to allocate; C−D is remaining to fulfill. A final send cannot exceed the selected allocation's lawful remainder.

An allocation carries the annual owner's year, beneficiary, canonical material, annual membership, field version, legal unit and exact approved annual reference. Its beneficiary comes from that reference. Each effective correction has one explicit predecessor; count the approved head once. Drafts never enter C. Approval and dispatch must revalidate current scope and effective references inside their transactions.

An approved annual correction must not orphan commitments or permit a second pool for the same need. An R2 reference continuation must explicitly link the old/new approved references, preserve the original allocation/execution history and prove the same beneficiary, material, membership and unit. Changed field versions require explicit reconciliation. A new annual reference cannot silently reset C/D or copy a different beneficiary's headroom. Withdrawing an unrelated correction draft remains the prior R1 operation.

## Authority

Proposed keys are `central_needs.allocation.view`, `.create`, `.approve`, `.correct`, `.settlement.create` and `.settlement.approve`. They have no new role defaults. The R2 candidate must use a separate authority predicate, retain active membership in the live owner pharmacy department and require the existing annual-view boundary plus the exact R2 key. Do not expand the accepted R1 predicate's key whitelist or inherit its same-actor exceptions.

The proposer and approver of a version or capacity-restoring settlement are different current authorized actors. Recheck authority on an exact replay and receipt reconciliation. No client-supplied actor/name/role is evidence. Capture a trusted employee snapshot under profile locks with the transition and audit record.

## Final-send corridor

The first corridor to verify is the existing central-warehouse-to-beneficiary-institution direct supply path. The source of truth is its current guarded canonical function, including FEFO, stock generation/suspension and warehouse-scoped permission checks. An R2 entry point may delegate to that owner; it cannot reimplement inventory debit or weaken the original checks. Preserve unlinked inventory operations outside R2.

Before the delegate runs, bind the selected effective allocation and expected approval to the actual source organization, destination institution/warehouse, canonical material and legal stock unit. If a need pins a target warehouse, enforce it. An allocation cannot turn a central transfer to another institution or an institution-to-outlet dispatch into a charge for its own beneficiary.

The canonical send movement and R2 execution charge commit or roll back together. A charge records the real canonical line and movement, exact positive executed quantity, approved allocation/version and full reference scope. Unique movement/intent identity prevents a second charge or attribution to another allocation. A previously successful unlinked send cannot be attached retrospectively by replaying its request id. An intermediate or downstream movement of the same stock does not charge the institution allocation again.

Failed, cancelled-before-send, draft and duplicate sends create no new charge. A response lost after commit is an unknown outcome; reconcile the exact durable receipt rather than creating a new request. Lock ordering must compose with the canonical year/material/request/document/stock locks; verify concurrent send and approval races in separate database sessions.

## Receipt and settlement

Read actual full/partial receipt through the existing canonical transfer line and receipt movement. Do not debit D a second time or replace dispatch quantity with received quantity. Preserve shortages, rejected/different receipt and confirmed physical return as distinct measured facts.

Settlement records retain the original execution and related canonical document, exact quantity, reason, trusted actor snapshot and server time. Creating a record is not approval or restoration. An approved restore settlement may reduce D only within the eligible confirmed quantity of that exact original execution/document, net of prior approved settlements. Concurrent partial settlements, exact retries, changed-intent retries and cross-allocation reuse cannot exceed or duplicate the eligible quantity. A physical return alone does not change A/C/D or create another stock movement.

## Candidate and acceptance

Keep candidate SQL outside immutable migrations and the design branches. Default operational activation is off; any test-only activation must be an administrator-owned database fact, not a caller-settable GUC or browser flag. API roles cannot write tables, receipts, authority or activation directly. New relations require forced RLS, append-only audit/version/event history and a separate capability seal that preserves the accepted R1/C2 seal.

Native acceptance must use pinned disposable cluster identity before any destructive harness action, actual restricted authenticated roles and independent sessions. Required cases include annual ceiling/floor, reference changes, proposer/approver separation, in-flight permission loss, successful/failed/duplicate final send, partial receipt, shortage, return without restoration, explicit approved settlement, exact/changed replay, rollback and concurrent approvals/sends/settlements. Real Auth/PostgREST acceptance and current-head CI remain separate gates. No candidate SQL is applied to Production through a design merge or this contract.

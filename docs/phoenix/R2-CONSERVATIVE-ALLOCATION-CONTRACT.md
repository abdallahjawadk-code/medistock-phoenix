# R2 — Conservative allocation policy

Status: **OWNER-ACCEPTED POLICY; IMPLEMENTATION AND HOSTED ACTIVATION NOT COMPLETE**.
Decision date: 2026-11-01 (Asia/Baghdad). The owner accepted the conservative proposal, conditional on compatibility with governing memory and accepted contracts, and required R2 operational SQL to remain separate from the design merge and to pass independent verification before Production application.

This reference defines calculation, refusal and audit requirements for R2 implementers and reviewers. It implements the policy choice left open in governing memory r14 §§7.4–7.5. It does not change R1, annual material identity, inventory accounting, FEFO, existing approval exceptions, or historical records. It does not claim that an allocation engine or a hosted SQL activation already exists.

## Accounting scope and quantities

Every calculation binds one owner organization, planning year, beneficiary, legal material identity, annual membership, annual field version, legal unit and approved reference. An allocation linked to an annual need retains that need's beneficiary. Changing a UI selector cannot transfer commitments to a different beneficiary or year.

| Quantity | Meaning |
|---|---|
| A | The effective approved annual quantity for the exact scope and reference. |
| C | The sum of effective approved operational allocations charged to that reference. Exclude drafts, cancelled allocations and replaced versions. Count a corrected allocation's effective successor once. |
| D | Final authorized dispatch execution to the allocation's beneficiary, charged once, less only separately approved eligible R2 settlements. Dispatch binding requirements below are owner-adopted; their operational implementation is not complete. |
| Remaining to allocate | A − C. |
| Remaining to fulfill | C − D. |
| Received | Valid receipt documents, shown separately. Do not subtract sending and receiving as two executions of the same quantity. |
| Reserved | The canonical stock engine's reservation state, shown independently. It is neither an approved allocation nor execution or receipt. |
| Stock balance | The canonical inventory/lot ledger's answer. Never infer it from A, C or D. |

If a reference is missing, a read fails, or scopes/units do not agree, return an explicit unavailable/conflict state. Do not substitute zero. Preserve a negative result as an overage requiring resolution; do not clamp it to zero or silently rewrite its inputs.

Example: A=12,000, C=3,000 and D=2,200 gives 9,000 remaining to allocate and 800 remaining to fulfill. These numbers make no statement about stock on hand.

## Approval and correction boundaries

1. If approving an allocation would make C>A, refuse it. A reason does not grant an over-ceiling exception. A future exception requires a separately adopted policy and permission contract.
2. If reducing an allocation would put its effective quantity below the execution charged to it, refuse the reduction until an authorized conflict-resolution path reconciles the commitments.
3. If lowering, replacing or withdrawing an annual reference would contradict effective allocations or execution, refuse the conflicting transition. Preserve its original references and history. Withdrawing a correction draft that leaves the effective reference intact is a different action and must not be refused merely because a draft exists.
4. Correct an effective allocation through a new, linked version. After authorized approval, replace the previous version atomically in effective totals. Do not overwrite history or add both versions to C.
5. Check the ceiling and commitment constraints inside the authoritative transaction under the relevant scope/reference locks. Two concurrent approvals must not both pass a stale remainder check.
6. Bind an idempotency key to the actor, action, full scope, expected version and payload. An unchanged authorized retry returns the original receipt; a changed intent under that key is refused. A client timeout is an unknown outcome requiring reconciliation, not an automatic new attempt.

Approving an annual need or allocation does not reserve, issue or decrement physical inventory by itself. Keep planning approval and inventory movements separate.

## Owner-adopted execution point

The owner subsequently adopted final legal sending as the R2 execution point on 2026-11-01. Charge the actual authorized quantity once when the canonical final dispatch to the allocation's beneficiary commits. Drafts, failed operations, duplicate requests and intermediate or downstream movement of the same quantity do not create another charge. Receipt, including partial receipt, is a separate measured fact and never a second execution.

Bind the effective allocation/version and its complete accounting scope explicitly to the canonical dispatch line and movement. Verify the actual destination, legal identity, unit, reference and eligible remaining quantity on the server. The stock movement and R2 charge must commit or roll back together in the legal send transaction. A successful historical or unlinked stock movement is not eligible for automatic retrospective quota attribution. The UI may not fabricate a successful charge from a send request, timeout or receipt.

Differences, shortages and returns have their own immutable settlement history, retaining the reason, trusted actor identity/name/role, server timestamp and related legal document. Observing a difference or physical return does not restore capacity. A capacity-restoring settlement requires explicit authorized approval, bound to the original allocation/execution and eligible confirmed document quantity; exact retries and concurrent partial settlements cannot exceed that quantity. Preserve creation and approval as separate acts. Do not inherit the R1 same-actor exception.

Expose annual need, approved allocation, physical reservation, charged execution, actual receipt and their named remainders separately. A refusal or unavailable read must not be rendered as a successful zero balance. The existing conservative ceiling and floor remain binding.

Acceptance must exercise actual canonical send, partial receipt, differences, returns, request replay and concurrent operations in a disposable database with real authorization. Pure arithmetic tests alone do not satisfy these execution cases. Operational SQL remains separate from design and cannot be applied to Production through a design merge.

## Returns and cancellation

A physical return follows the existing canonical stock/return corridor. Its stock effect does not automatically restore allocation capacity or alter A, C or D.

If an authorized actor explicitly requests restoration after a confirmed return, require a separate R2 settlement linked to the original allocation, execution and confirmed return receipt. Validate the remaining eligible quantity, material, unit, beneficiary and reference. Prevent replay, partial-return over-restoration and charging one return to multiple allocations. Record the physical return reference and settlement as separate facts.

Example: after the previous example's confirmed physical return of 200, R2 still shows C=3,000 and D=2,200 until a separate lawful R2 settlement exists. If that settlement restores 200 of the original charged execution, D becomes 2,000 and remaining to fulfill becomes 1,000. C stays 3,000; the settlement does not silently cancel or enlarge the allocation.

Cancellation, return approval, physical receipt and allocation settlement are distinct states and events. Do not invent one from another or reverse a past stock movement merely to make a planning total agree.

## Monthly proposals and rounding

Equal distribution is a visible proposal option, not automatic approval or a consumption forecast. Require an explicit set of periods and a known legal quantity step. For a current year, do not silently redistribute into elapsed or already approved periods.

For an equal proposal, divide the intended quantity across selected periods in legal steps and distribute the remaining steps in chronological order among those periods. Preserve the intended total exactly. For 100 whole boxes across 12 periods, the first four receive 9 and the remaining eight receive 8. Do not round twelve independent fractions into 96 or 108. Do not infer unit aliases or convert units.

If an operator changes proposed periods, preserve the proposal, revised value, difference, reason, actor, server time and scope. Preserve already approved periods and execution. Redistributing the unapproved remainder requires an explicit preview and action; changing the annual target must not erase manual edits silently.

## Authority and immutable audit

R2 needs explicit permissions for creation, approval, correction and capacity-restoring settlement. Do not inherit an R1 same-actor exception or invent new Production role defaults from this document. Keep database authorization final and preserve the established L1/L2/L3 scope boundaries.

Each successful transition records the actor UUID and trusted employee-name/role snapshot, server timestamp, reason, old/new version references, before/after quantities, exact scope, source document/event references and receipt. Derive actor identity on the server. Preserve the receipt, effective transition and audit record atomically. A later employee-name change must not rewrite historical attribution.

Rejected and unknown-outcome operations must retain an auditable correlation identifier without exposing another scope's records or credentials. An unavailable read must not be logged or rendered as a successful zero result.

## Implementation prerequisites and activation gate

Before operational R2 writes, specify and independently verify:

- The exact canonical corridor implementations that atomically bind the adopted final-send point to D, including in-transit sending, full/partial receipt, cancellation, rejection and return. Prove that receipt does not double-count sending.
- Effective-version selection, lock ordering, compare-and-swap conflicts, legal quantity steps and bounded restoration across partial events.
- The exact new permission keys, role defaults and server checks, without broadening previous domain authority.
- A separate reviewed SQL candidate, disposable low-privilege/native tests and real Auth/PostgREST acceptance. Preserve immutable historical migrations and prove compatibility with accepted R1 and inventory behavior.
- A separately verified Production target, migration history, rollback/recovery posture and explicit operational activation record. A design PR merge or green frontend build satisfies none of these SQL gates by itself.

The owner-approved policy is binding within this scope. The event schema, API signatures and database implementation are not adopted merely by appearing in a future proposal. Keep operational SQL separate from the P4-A design branch.

## Required acceptance cases

| Case | Required result |
|---|---|
| C would exceed A | Refuse approval without changing effective totals. |
| Two concurrent approvals exceed the shared remainder | At most one succeeds; the other receives a reproducible conflict/refusal. |
| A correction lowers an allocation below its D | Refuse; preserve the prior effective version and history. |
| A draft or replaced version appears beside an effective allocation | Count only the effective approved version. |
| A receipt follows an already charged dispatch | Do not charge the quantity twice. |
| A physical return is received | Preserve the stock effect; do not restore R2 capacity implicitly. |
| A settlement is retried or linked to another beneficiary | Exact authorized replay is idempotent; changed scope/intent is refused. |
| A partial return is settled in several commands | Total restoration never exceeds the eligible confirmed returned quantity. |
| A read/reference fails | Show unavailable/conflict, not zero; preserve signed overage results. |
| 100 legal steps are proposed across 12 periods | Four periods get 9 and eight get 8; total remains 100. |
| An operator changes the annual target after manual edits | Preserve edits and show the difference; do not rewrite approved periods. |
| A former approver becomes inactive or loses scope | Re-check current authority before any new mutation or receipt replay. |

Policy adoption alone does not mark these execution tests PASS. Their results must identify the tested source, database and actor.

## Bounded arithmetic implementation

`src/features/central-needs/allocation/conservative-policy.ts` implements the pure A−C/C−D calculation and equal monthly proposal in exact decimal text using BigInt coefficients. It reuses the existing R1 quantity-input grammar, keeps missing input unavailable and preserves signed overages. Proposal inputs include an explicit lawful step and only the caller's selected unapproved months; remainders follow chronological order.

The module has no UI imports, network access, authorization decisions, persistence or inventory effects. It is not connected to an operational writer. The caller must first establish a single authoritative accounting scope, effective versions, legal unit/step and period eligibility. The separate implementation and activation prerequisites above still apply.

`assessR2AllocationChange` additionally checks one effective replacement: the next total is C minus the replaced allocation plus the proposed successor, counted once. It reports incompatible annual excess or a successor below its charged execution, and keeps missing/invalid/inconsistent totals unavailable. Exact boundary values remain compatible. This assessment cannot grant permission, approve a version, settle a return or protect concurrent writers; the future authoritative transaction must repeat the same policy under current scope/version locks. No prior annual-approval contract or R1 writer is changed.

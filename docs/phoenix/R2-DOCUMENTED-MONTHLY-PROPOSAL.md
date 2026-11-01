# Documented monthly proposal reference — owner-approved r16 addition

The owner approved a documented legal quantity step and eligible periods per material/year/unit and beneficiary where required. No step or precision may be inferred from a unit label, decimal scale, SQL numeric storage, original workbook quantity or current date. Missing approved metadata displays **بانتظار تحديد سياسة التوزيع** / **Awaiting distribution policy**. It does not create effective allocations.

The reference binds owner/year, annual membership/current field version, canonical material and exact unit, plus policy identity/version/fingerprint, approved source document/hash, period basis and reviewer snapshot. Generic unit/period rules may be reused, but the resolved ledger basis ALWAYS binds the exact beneficiary, including a verified absence of prior allocations. Unavailable data is never a verified zero. General and beneficiary-specific references have no implicit priority; ambiguity remains held.

Policy publication is owner-controlled from independently approved data. There is no employee/browser API for inventing a policy, no default reference, new permission key or default grant. Production publication/application remains a separate authorized SQL gate.

Reading the resolved reference requires current annual view AND the existing explicit `central_needs.allocation.view` permission, because fixed approved quantities and ledger evidence are allocation data. R2 operational activation is not required for this read-only path. Annual view alone cannot disclose the reference; no production grant is introduced.

`remaining = manual annual quantity − sum(fixed approved/locked months)`. Existing fixed months remain unchanged. The accepted exact R2 calculator proposes the remainder only over explicit eligible months at the documented step, assigning remainders in calendar order. The union of fixed and proposed rows must sum EXACTLY to the annual quantity. Unlisted months are not invented as zero. Annual below fixed, non-multiple step, stale identity/version or missing ledger evidence remains held.

Manual edits affect eligible months only and must retain the exact annual sum and legal step. Changed drafts require a reason. A saved draft must journal the original proposal, edits/difference, current employee identity/name and server time, with full-intent idempotency and a previous-version fence. Shape validation or a browser fingerprint never establishes approval or authority. Effective quotas, approvals, charged SEND, RECEIVE, settlement and stock/FEFO are separate operations.

Changing the annual amount or policy must not overwrite manual edits silently. Reference selection must be stabilized against concurrent owner publication during a draft save; a lock on an old immutable policy row alone is insufficient. A lost write response is reconciled by the same actor/request receipt before explicit same-intent retry.

The current pure module validates and calculates only. Server reference publication/readback, draft journal and UI integration have independent acceptance gates; this document does not declare them implemented. Existing R2A SQL/seals and `operationalWritesImplemented=false` remain unchanged. New SQL helpers must use `phoenix_monthly` / `phoenix_monthly_*`, because the accepted R2A seal rejects new routines under `phoenix_r2` and its public prefix.

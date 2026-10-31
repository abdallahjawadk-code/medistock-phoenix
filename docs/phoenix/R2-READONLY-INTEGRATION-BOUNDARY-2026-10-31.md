# R2-1/2 — Read-only integration boundary (draft)

**Status:** SOURCE REVIEW + LOCAL PROTOTYPE; NOT ACCEPTED / NOT MERGED / NOT APPLIED.
**Parent:** C3 Draft #266 at `134de836f2796f47d749d985fc27209149b3fc59`.
**Governing:** r14 and the independently supplied R2-1…R2-6 offline engineering handoff.

## Verified stock source and distinction
- Existing `warehouse_transfer_lines` (migration 068) is the central→institution execution line. The legal status set is `in_transit`, `received`, `received_with_difference`, `rejected`. The line includes `transfer_id`, `central_item_id`, `sent_quantity`, `received_quantity`, `source_organization_id`, and original transfer header includes `destination_organization_id`.
- Transfer lines have **no annual allocation version FK**. C3/P3B annual need bindings target the manual need event chain, not warehouse transfer lines.
- Never imply that comparing codes or organization names establishes a quantity allocation. In R2-1, show genuine transfers as **unattributed**, with SEND and RECEIVE quantities independently reported; the approved annual amount and allocations must be displayed separately until a lawful join exists.
- Distribution from the institution warehouse to its outlets is *not* a second central supply. Do not add downstream dispatch or patient dispense to central supply.
- Missing or unauthorized source data means **unavailable**, never zero.

## Code activation design
The read-only material-list and reconciliation calculation prototype remains in `/mnt/data/MediStock-R2-1-to-R2-6-Local-Engineering-2026-10-31/`, with 62 Node unit tests (not PostgreSQL integration). Review before conversion to source modules:
1. Build a service adapter using the current authenticated client and existing RLS. Recheck owner organization, planning year, beneficiary organization, canonical item UUID, and unit on each returned row.
2. Read annual records only with the exact authorized annual contract active. If R2 allocation tables/roles are absent, report **capability unavailable**. Don't invent allocation values.
3. Read central transfer headers and lines under caller RLS and filter to the exact institution. Report unattributed records. Do not use a service-role client.
4. Expose a draft UI with a mandatory **evidence-source label** for each figure: annual approved, active allocation, transfer SEND, accepted RECEIVE, unknown, or incomplete.
5. Do not activate allocation writer or transform the existing central-to-institution SEND RPC until a reviewed R2-3 schema, row-level idempotency, and policy decision are approved.

## Business policy HOLD
Whether quota execution `D` is triggered by SEND or RECEIVE is not approved in governing r14. Earlier work recommends SEND but does not enact it. Refused receipt, difference, cancellation, return, reallocation, and ceiling exceptions are likewise unapproved. Thus `D` and `remainingToExecute` must remain **unavailable** in the production read model until approved policy and signed attribution records exist.

## Evidence and acceptance
- Local prototype: 62/62 Node tests; no actual PostgreSQL, JWT, RLS, live inventory, Vercel UI acceptance, or replay/resume test.
- Before any real UI claim: use per-institution approved annual revision and legal yearly material snapshot; verify cross-year and cross-organization negative access under authenticated PostgreSQL.
- Live source test: two central warehouses, partial receipt with reason, cancel, return, duplicate retry, expired lot, permission revocation, stale file version, and no receipt.
- Production remains untouched. Existing unmerged C1/C2/C3/P3B dependencies and hosted convergence are separate gates.

## Required future PRs (not yet implemented)
R2-1: read-only approved-scope adapter and UI; R2-2: approved annual material list draft; R2-3: independent SQL candidate and native pg-rig; R2-4: transactional SEND+attribution after policy; R2-5: reconciled reports/returns; R2-6: independent acceptance and staged deployment.

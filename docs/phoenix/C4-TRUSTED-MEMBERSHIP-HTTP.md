# C4 trusted review commit boundary

POST `/api/central-needs/commit-verified-membership` accepts explicit review references only: owner/year, stable requestUUID, retained originalUUID/expected SHA, server registration ID/version/expected SHA, page cursor/size, selected occurrence keys, explicit canonicalUUID/expected fingerprint, and reason. Actual streamed request bytes are limited to16KiB, a page to50 rows and complete evidence to256KiB. No cells, mapping, actor, service credentials, beneficiary or annual quantity are accepted.

The endpoint verifies the employee JWT, current view/edit authority and active C4 database contract; reads the original as that employee; checks source and server-registration hashes; reruns the admitted terminating worker; selects exact keys in deterministic source order; and rechecks authority after computation. It seals only the newly reconstructed evidence using the separate service identity. The original employee client commits the sealed proof. The existing SQL guard, canonical/source checks, idempotency and atomic annual writer remain authoritative.

The private compiled worker is packaged for this route as for C3. Its hash records the immutable deployed server artifact; no request controls a path or executable. Local mutable worker files are not a substitute for immutable deployment provenance. Whole-process memory is not guaranteed by V8 worker limits.

A lost or malformed commit response returns `c4_commit_outcome_unknown` with requestUUID and no raw infrastructure errors. The caller uses the protected `phoenix_c4_receipt` RPC to distinguish missing/prepared/committed, and refreshes annual selection after a committed replay. The endpoint never retries a write automatically or switches to the legacy writer. A prepared proof after a refusal remains evidence only.

Default deployment contains an EMPTY registration list. It refuses before database/source/service work; the SQL candidate and its independent activation are also required. No employee review UI is enabled in this slice, no real templates or workbooks are published, no Production SQL or platform-role changes are applied, and M231/hosted compatibility remain separate release gates.

Acceptance combines injected boundary faults with the actual loopback HTTP handler, real employee JWT and service identity, actual C2 reader and compiled worker on a synthetic disposable Supabase fixture. It is not hosted-Production parity or legal approval of source identities.

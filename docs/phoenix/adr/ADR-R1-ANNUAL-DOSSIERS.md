# Annual Needs: dossiers within one annual workspace

Status: local implementation, not released. Owner grant: 2026-10-29.
Baseline: 73928eb36fa4116ffe1ee48e7435d0d85dc15252 (M231).

## Evidence and decision

The existing journey selects one plan for `(organization_id, plan_year)` and only
its newest revision. The canonical approval replaces the approved predecessor of
that plan. M229 deliberately freezes the historical Excel pipeline after manual
activation. Removing that guard or treating a new file as a new annual revision
would either erase an earlier classification from the effective view or bypass
the cutover contract.

The annual workspace remains `(organization, year)`. Reuse the existing plan /
revision aggregate for each dossier, adding an immutable dossier key and display
name to `central_needs_plans`. The empty key identifies the unchanged historical
general dossier. Each named dossier has its own current draft, approvals,
corrections, event chain and effective approved revision. There is one key per
organization/year; a name is descriptive and never material identity.

Rejected alternatives: parallel line-approval tables (second authority), making
each uploaded file a new annual revision (replacement semantics), and weakening
the Excel freeze globally (reactivates a retired path).

## Invariants

- All mutations retain the canonical RPC guards, attestations, eligibility and
  audit. Internal locks resolve the actual plan ID, not an arbitrary plan in the
  same year. The existing organization/year advisory lock preserves one order.
- Legacy APIs resolve the empty-key dossier only. Restrictive SELECT policies keep old direct `maybeSingle(organization,year)` reads and revision lists confined to the general dossier. New scoped SECURITY DEFINER read RPCs return named dossiers under the same effective view permission. Existing data and IDs remain.
- An annual summary includes exactly one effective approved revision per dossier;
  drafts/rejected revisions never replace approved totals. The same beneficiary /
  material must not be approved in two dossiers, even under concurrent approval;
  resolve the overlap explicitly instead of silently summing it.
- Adding another classification does not change an approved dossier. Correcting
  one dossier replaces that dossier only, preserving others and prior evidence.
- Owner's same-actor amendment is limited to manual Central Needs and material
  registration, with separate effective permissions. No default or auto-grant.
- A distinct text national code preserves zeros and hyphens. Canonical item UUID
  remains identity; barcode is separate. No inferred barcode backfill or live
  data correction. Public QR projection is unchanged.

## Workbook intake

The new intake belongs to manual dossiers and is an explicit owner-approved
extension: local preview, human confirmation of columns/material/beneficiary/unit,
then an atomic batch through the existing manual writer. It does not reopen the
historical Excel source/revision API or treat fuzzy suggestions as decisions.
Original workbook bytes/hash, physical sheet/row/column pointers and the confirmed
write plan are immutable evidence. Re-uploading the same file to the same dossier
is refused/reconciled, never counted twice. Duplicate scopes are blocked; this
first release deliberately has no automatic sum or overwrite.

## Deployment compatibility and boundaries

New readers detect missing *specific contract* capabilities; permission/transport
errors are errors, not legacy/empty results. Features unavailable before their
migration display a clear unavailable state. Older clients still use the general
dossier. Old review/update RPCs refuse code-bearing material requests rather than letting a cached interface decide on an invisible code; the modern RPC pins the reviewed national-code value. Deploy compatible code before applying migrations. Historical 001..231
are immutable. No new stock, allocation, permission default or background retry.

Kimi's interrupted local files were not present in this workspace; they are not
claimed recovered, reviewed or complete. This candidate starts from verified
master and must be compared against any later supplied partial work before reuse.
No commit/push/merge/Production write is authorized in this local phase.

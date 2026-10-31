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

## Workbook intake — matrix follow-up (owner continuation, 2026-10-29)

The initial PR256 candidate is insufficient for the supplied corpus: 57 real XLS
workbooks (8 Office lock files excluded), 75 sheets, multiple institution columns,
comparison blocks and heterogeneous source units. Neither a blind multi-file
write nor raising a row limit alone resolves that shape.

The revised, still-unapplied M235 separates immutable original documents from
immutable captured selection plans and append-only batch receipts. A capture is
bounded at 10000 selected quantity cells; each application transaction handles at
most 100 rows. Submission/approval is fenced until every capture in that revision
has a complete contiguous receipt sequence. The old <=100-row RPC remains atomic
by invoking capture and batch within its single transaction.

The quantity-cell identity is (document, sheet, row, quantity column), not just
(sheet,row). Another institution column of the same original may be selected
without storing the source twice. Captures reserve physical cells and business
scopes under the canonical plan lock. An exact operation ID replays only an
identical intent by the same actor; changed intent, overlapping cells or duplicate
beneficiary/material scopes are refused, never summed. Canonical manual events,
quantities, provenance, approvals, correction history and warehouse SoD remain
authoritative. A source filename/header is never permission or institutional
identity.

Users confirm each sheet/region and beneficiary-column mapping, the target year,
material IDs, national codes and units. Exclusions need retained coordinates and
reasons. Header labels are retained as evidence, not automatic assignments. Only
ASCII-space/case unit spelling equivalence is permitted; kit/test, pack/piece and
concentration conversions remain unresolved until separately governed. Exact
quantity TEXT, blank/zero distinction and leading national-code zeros remain.

The UI parses at most five files sequentially, excludes Office locks before the
Worker, paginates the preview and offers at most 100 match suggestions per action.
A source capture precedes writes. Unknown outcomes stop application-level writes;
readback reconciles the operation ID before explicit resume. Parent-context transitions disable the old workspace controls; leaving a scope aborts continuation before the next batch (an already in-flight transaction still needs readback). Confirmed batches
are not relabelled failed when history refresh fails. SQL writer calls and their
append-only receipts are atomic. A catalog SHARE lock binds each batch's unit,
active status and national code to the write transaction. Actor permissions and
organization activation are rechecked on each mutation. There is no automatic
retry after an uncertain response and no unauthenticated upload path.

A pending capture whose actor/catalog eligibility changes may require governed
resolution or withdrawing the draft; there is no silent discard of committed
batches. HTTP/Supabase Auth/native independent-session behavior still requires
the native CI gates. PGlite tests are real PostgreSQL execution but are not native
transport/concurrency parity. The real virology source has been exercised locally
for J4=11520 and K4=10000 using synthetic fixture institutions, not live mappings.
This does not declare all 57 workbooks business-compatible.

FF2 is a new unnumbered emergency candidate, never automatically applied. It
pins the current RPC census and exact writer bodies and closes all 27 designated
manual/material/intake entry points, including the six missed by historical FF1.
The historical FF1 file is immutable; its original full-chain test now explicitly
replays through M230, and the new FF2 suite covers the current dossier chain.

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

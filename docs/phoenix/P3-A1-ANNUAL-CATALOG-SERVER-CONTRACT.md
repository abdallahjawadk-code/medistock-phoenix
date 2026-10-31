# P3-A1 — annual catalog server foundation

Status: **implemented and accepted on isolated native PostgreSQL 17.11**; unnumbered `NOT_APPLIED` candidate for later target review. No hosted application, UI activation, need-line binding, quantity import, allocation, or page retirement is part of this slice.

Authority: MediStock governing memory r6 §§5–6,8,20; accepted A0 and P2 tree `b0b8248a2527cb15c53acca9ec83d78c69e61cb6` at published commit `423181be24003ef615a4028694b1c4c54df426a2`.

## Bounded behavior

An explicit `(organization_id, planning_year)` catalog has independent memberships, immutable canonical field snapshots, immutable source witnesses and registration contexts. Creating 2027 copies nothing from 2026. A canonical UUID does not imply annual membership. A source classification is browsing evidence, never authorization, a beneficiary, or a dossier.

A1 creates snapshots **on the server from the locked legal canonical record**. The client cannot make arbitrary `known` fields, an asserted source association, or a new unit become legal canonical identity. Attaching a witness remains a human assertion, clearly separate from verified identity. Adding or refreshing a membership requires the exact canonical fingerprint returned by the preview RPC and a reason. Refresh explicitly creates a new immutable version; it cannot rebind an annual item to a different canonical. Source observations remain separate, raw and labelled `client_attested`: this slice does not upload or independently hash original workbook bytes. It neither infers identity from source text nor silently accepts `tab` as `tablet`.

This bounded snapshot policy does not implement a general annual-field adjudication editor. A source discrepancy remains visible even when a user explicitly chooses the existing canonical. Missing canonical scientific name, national code or legal unit makes a member `preparing` and unselectable; optional missing form/strength is recorded as missing, never fabricated `not_applicable`. Type-dependent clinical requirements remain governed by the legal registration contract, not a guessed category.

Annual management uses the existing **view + edit** permission keys within the actor's live home PDA. Reading uses view. No new role-name exemption is added. Catalog preparation itself is independent of quantity activation. Creating a legal registration request still passes through the existing M230 activation guard and M232/M233 review lifecycle. The existing quantity writers and beneficiary requirement are unchanged.

## RPC contract v1

All names below have prefix `phoenix_central_needs_`. Scope parameters are `p_organization_id uuid, p_planning_year integer` unless stated otherwise. No defaults are relied upon by the adapter. All RPC results are JSON objects; all UUIDs and fingerprints are strings.

| Suffix | Other parameters | Result |
|---|---|---|
| `annual_catalog_contract` | none | `{version:1, scope:'owner_year', canonicalSnapshots:true, sourceAttestation:'client_attested', quantityBinding:false}` |
| `open_catalog_year` | `p_idempotency_key text` | `{scope, year:{planningYear,status,createdAt}, idempotentReplay}` |
| `list_catalog_years` | organization only; `p_limit integer, p_after_year integer` | `{ownerOrgId, years:[{planningYear,status,createdAt}], nextAfterYear:number|null}`; descending year |
| `preview_annual_canonical` | `p_central_item_id uuid` | `{scope, canonicalItemId, canonicalSnapshot, canonicalFingerprint, eligible, missingRequired:string[]}`; explicit missing-material flow only |
| `search_annual_catalog` | `p_query text,p_limit integer,p_cursor jsonb` | `{scope,items:AnnualCatalogItemResult[],nextCursor:AnnualCatalogCursor|null}` |
| `get_annual_catalog_item` | `p_annual_item_id uuid,p_field_version_id uuid` (nullable version means current) | `AnnualCatalogItemResult` |
| `list_annual_catalog_occurrences` | `p_annual_item_id uuid,p_limit integer,p_after_occurrence_id uuid` | `{scope,annualItemId,occurrences:AnnualSourceOccurrence[],nextAfterOccurrenceId:string|null,attestation:'client_attested'}` |
| `add_annual_catalog_item` | `p_central_item_id uuid,p_expected_canonical_fingerprint text,p_occurrences jsonb,p_reason text,p_idempotency_key text` | `AnnualCatalogItemResult & {idempotentReplay:boolean}` |
| `refresh_annual_catalog_item` | `p_annual_item_id uuid,p_expected_field_version_id uuid,p_expected_canonical_fingerprint text,p_occurrences jsonb,p_reason text,p_idempotency_key text` | same result; append version and atomically change head |
| `create_annual_material_request` | `p_descriptor jsonb,p_idempotency_key text` | `{scope,requestId,status,version,idempotentReplay}` |
| `complete_annual_material_request` | `p_request_id uuid,p_expected_request_version integer,p_expected_canonical_fingerprint text,p_reason text,p_idempotency_key text` | `AnnualCatalogItemResult & {requestId:string,idempotentReplay:boolean}` |

`AnnualCatalogItemResult` is `{scope,membership,fieldVersion,canonicalFingerprint,canonicalDrift,selectable,selectionBlockers:string[],sourceOccurrenceCount:number,sourceAttestation:'client_attested'}`. Membership and fieldVersion use A0's camel-case structures. `canonicalFingerprint` belongs to the returned immutable version. `canonicalDrift` compares that version to the current canonical; eligibility also requires current active canonical and active year/member. Old-version reads retain the historical fields and are not permission to use them in a new need.

`AnnualCatalogCursor` is `{ownerOrgId,planningYear,query,rank,annualItemId}`. Query is trimmed, bounded to 200 characters, literal rather than SQL wildcard syntax. Rank 0 is exact national-code match; rank 1 is other matches. Pagination orders by `(rank,annualItemId)` and returns at most 50 rows. It does not claim a frozen multi-request snapshot during concurrent edits. Occurrences use UUID keyset pages of at most 50. Years use descending numeric keyset pages of at most 50. Cursors must match requested scope/query.

`canonicalSnapshot` has exactly `canonicalItemId,scientificName,nameAr,nationalCode,barcode,dosageForm,concentration,unit,status`, with strings or null for descriptive fields. Fingerprints use the server's canonical JSON serialization and SHA-256; clients pass the opaque token, never recompute it.

`p_occurrences` is an array of A0 `AnnualSourceOccurrence` objects, at most 100 per command and at most 500 distinct occurrences per item. Unknown keys, quantities, comments and arbitrary row payloads are rejected. Source IDs/occurrence keys from preparation are not database identity: persisted sources deduplicate by scoped byte-hash plus parser identity, and occurrences by source/sheet/block/row/mapping. The server assigns UUID keys. Duplicate witnesses may be reused only for the same annual item with identical immutable content. A client hash is an attestation, not verified original bytes.

The source array is bounded to 2 MiB of its PostgreSQL JSON text representation. Raw/formatted/formula cell strings are bounded to 16,000 UTF-16 units; A0's 4,000-unit usable-value boundary is preserved. Coordinates, headers, parser identity and every nested object's keys are validated. JavaScript and SQL use the same ECMAScript whitespace set for blank checks; stored raw values are not trimmed. A repeated scoped hash/parser with a different filename, or a repeated occurrence with different immutable content/association, is refused rather than overwritten.

`p_descriptor` accepts only `scientificName,nameAr,tradeName,strength,dosageForm,unit,barcode,nationalCode,note`; scientificName and unit are required by the existing registration draft contract. All others are string or null. The wrapper uses `manual_typed`, `{}` provenance, and `NULL plan_revision_id`. Review, request edits, missing-code handling and same-actor permissions remain in the existing registration service. Completing only `approved_new` or `resolved_existing` requests with the expected request version establishes membership explicitly. An already present eligible matching membership can receive the completion link; no second member is created. No year is auto-populated when canonical approval finishes.

## Transaction and security contract

Writes require Read Committed. Lock order is existing actor/owner guard, immutable operation-key lock, catalog-year row, request (if completing), canonical row `FOR SHARE`, annual member, sources/versions. Same-year catalog writes serialize on the year row. This is a deliberate bounded first implementation, not a claimed high-throughput bulk importer.

Operation keys are unique per owner/actor across these annual commands. The recorded intent contains action, owner, year and every supplied parameter. Authority is checked before replay. Exact replay precedes current-head/canonical/year-state checks and returns the recorded outcome; it does not authorize another mutation. A changed action/year/payload under the key fails. Receipt, mutation and audit are one transaction. Internal registration keys are derived from the outer annual intent and cannot collide with another year's request.

An item receipt replay explicitly returns `selectable:false` and `receipt_replay_requires_refresh`. Its other fields describe the original outcome; a fresh `get_annual_catalog_item` is required before new selection. The adapter rejects a replay marked selectable and marks malformed write acknowledgements as an unknown outcome, preserving the need to reconcile or retry the same intent/key.

Every relation has forced RLS, the existing restrictive actor-scope policy and no direct API DML or SELECT grant. Access is through bounded authorized RPCs. Private helpers are revoked from PUBLIC/anon/authenticated/service_role. New relations and exact signatures extend the existing capability seal while preserving its P1 private-writer tripwire. Historical migrations and the P1 candidate are immutable.

Composite foreign keys contain owner/year for all annual relationships. Membership uniqueness includes all statuses. Annual member identity, source witnesses, field versions, request context/resolution and receipts cannot be reassigned or silently overwritten. There are no DELETE/archive/reactivation commands in A1; future retirement must enumerate references and preserve history.

The profile and owner locks stabilize their mutable eligibility fields during a command. Existing permission override/default writers do not share one global revocation protocol; this slice does not claim linearizable concurrent permission revocation. Native low-privilege and controlled-race tests prove only the explicitly exercised boundaries.

## Acceptance and remaining activation work

Required evidence: empty new years; distinct annual identities across years; scope-forgery denials; current/historical version isolation; same-key exact replay and changed-intent rejection; duplicate/CAS/canonical/profile/org races; immutable evidence; legal registration completion; direct API/private-helper denial; clean capability seal and deliberate negative controls; atomic failure rollback; no plan/need/allocation/stock effects.

The TypeScript adapter must validate response structure/scope and never fall back to global search if this contract/RPC is unavailable. UI integration and transactional need-line binding are P3-B after acceptance. The current manual journey remains on its accepted service until that gate. No hosted database apply is authorized by this candidate's existence.

### Verified local acceptance — 2026-10-31

Candidate SHA-256: `1cfab7101634410288702e71bde670d6816ceeaea1dd06a21f510f9cc86e90bf`.

| Evidence layer | Result and scope |
|---|---|
| Native PostgreSQL 17.11, Node 22.23.4 | **68/68 PASS, zero skips**: 43 A1 cases and 25 existing dossier/matrix cases executed after A1 under the extended seal |
| Controlled concurrency | **22 cases within those 43**, independent connections, observed `pg_blocking_pids`, explicit commit/rollback order and postcondition checks |
| Runtime bridge | Actual PostgreSQL JSON validated by the TypeScript preview/current/historical/replay validators |
| Adapter | **67/67 PASS**; strict inputs/responses, no global fallback, no automatic retry |
| Affected application suites | **338/338 PASS** including the 67 adapter cases; build/type checking and full application lint passed |
| Independent review | SQL scope/ACL/manifest/locking review accepted at the candidate fingerprint above; executable native evidence is reported separately |

The first native attempt stopped in historical M194 because the disposable replay creator was not the expected `postgres` role; it did not apply A1. A subsequent native run found the empty-string UTF-16 defect in reason validation. It was fixed and retested, including Unicode-only whitespace and astral-text boundary regressions. These failed attempts remain in the private evidence bundle rather than being relabelled as successful runs.

No authenticated hosted session or PostgREST acceptance is implied by native SQL proof. The old FF2 closed-census containment candidate is not an A1 recovery procedure. Target-specific migration ordering, feature activation and recovery remain gates before hosted application. UI/source import completion, general field adjudication, quantity writer references, allocation and page retirement remain outside this accepted foundation.

### Official guidance checked

Reviewed on 2026-10-31: [Supabase function security and grants](https://supabase.com/docs/guides/database/functions), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [PostgreSQL 17 row locking](https://www.postgresql.org/docs/17/explicit-locking.html), and the [Supabase changelog](https://supabase.com/changelog.md). These support the security and locking choices; the test evidence above establishes this implementation's observed behavior.

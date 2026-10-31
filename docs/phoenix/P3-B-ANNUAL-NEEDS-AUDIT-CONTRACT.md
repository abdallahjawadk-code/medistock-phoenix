# P3-B — annual field corrections, employee attribution and need references

Status: **implementation contract; NOT_APPLIED candidate**. Base: published PR262 head `821e01312c1be7609766d72c04be30dba34b4a76`, tree `c293bb94979afeaf0aefbf77bc51759c16f90079`. Governing memory: r9 §§5–6, 20, 23, plus the owner's new requirement to edit material information with a mandatory reason and a fixed employee-name record.

This candidate depends on M001–235, the accepted P1 reservation candidate and the accepted A1 candidate. Their source files remain immutable. No hosted apply, merge, production release or page retirement is authorized by this contract.

## Annual editing policy

The editable object is the selected owner's **annual field version**, not the global legal material. `central_item_id` never changes. Each successful edit appends a version and uses compare-and-swap on the expected prior version and current canonical fingerprint. All seven fields are supplied: `scientificName`, `nameAr`, `nationalCode`, `barcode`, `dosageForm`, `concentration`, `unit`; values are strings or null. Unknown keys, empty/whitespace-only strings, controls, oversized strings and unknown units are refused. Null expresses a missing field. Units use the existing nine-value vocabulary, with no aliases or conversion.

`nameAr` is an annual display label and may differ from the legal record. Any difference in the other six fields is saved as a proposed annual correction, makes the membership `preparing`, and blocks new need selection. Missing required identity also blocks selection. The server reports `requiresLegalReview`. The employee may explicitly revert/refresh to current canonical information or use the existing registration review to obtain a lawful material and an explicit new membership. This does not approve identity, modify another year, or rebind the old membership. The existing registration workflow can create lawful materials or assign a previously missing national code under its established checks; it is not a general canonical-field editor.

An edit with no field difference is refused. Changed known values carry `{kind:'manual',decisionReference:changeId}`; removed values carry `{state:'missing',reason:'annual_correction_missing'}`. Unchanged field provenance is retained. Canonical snapshots/fingerprints still come from the locked server record. Original source witnesses remain untouched.

## Attribution and history

`central_needs_annual_catalog_changes` is append-only. A trigger on new annual versions with version number greater than one captures every later field version, including the existing A1 refresh RPC. It records old/new version IDs, flat seven-field before/after values, reason, server timestamp, actor UUID, role and the `profiles.full_name` value read under a row lock for `auth.uid()`. No actor name is accepted from the client. Later profile renames do not alter an earlier record. A missing/blank current employee name refuses a new correction rather than inventing one.

`changeId` equals the new field-version UUID. History also reads pre-P3-B versions, but their unavailable historical names are explicitly null with `fromTrustedProfile:false`; no current profile name is backfilled as a historical snapshot. New captured changes always have a nonblank name and `fromTrustedProfile:true`.

```ts
type FlatAnnualFields = Record<
  'scientificName'|'nameAr'|'nationalCode'|'barcode'|'dosageForm'|'concentration'|'unit',
  string|null
>;
type AnnualCatalogChange = {
  changeId: string; fromFieldVersionId: string; toFieldVersionId: string;
  actorId: string; actorName: string|null; fromTrustedProfile: boolean;
  createdAt: string; reason: string;
  beforeFields: FlatAnnualFields; afterFields: FlatAnnualFields;
  requiresLegalReview: string[];
};
type AnnualBinding = {
  scope: {ownerOrgId:string;planningYear:number};
  annualItemId:string; fieldVersionId:string; versionNumber:number;
  canonicalItemId:string; fields:AnnualFieldState7;
};
```

## Public RPC signatures and JSON

Every RPC below has prefix `phoenix_central_needs_`. Parameters have no defaults. All UUIDs are strings over the API. Every bounded list accepts `p_limit integer` in 1–50 and a nullable UUID cursor; a cursor must identify a row in the same requested scope. Pages order by `(created_at DESC,id DESC)` and do not promise a frozen multi-request snapshot.

| Suffix | Parameters | Result |
|---|---|---|
| `annual_needs_contract` | none | `{version:1,quantityBinding:true,annualEdits:true,actorSnapshots:true,scope:'owner_year',editPolicy:'annual_snapshot_with_legal_review'}` |
| `edit_annual_catalog_item` | `p_organization_id uuid,p_planning_year integer,p_annual_item_id uuid,p_expected_field_version_id uuid,p_expected_canonical_fingerprint text,p_fields jsonb,p_reason text,p_idempotency_key text` | A1 `AnnualCatalogItemResult` plus `{change:AnnualCatalogChange,idempotentReplay:boolean}` |
| `list_annual_catalog_changes` | `p_organization_id uuid,p_planning_year integer,p_annual_item_id uuid,p_limit integer,p_after_change_id uuid` | `{scope,annualItemId,changes:AnnualCatalogChange[],nextAfterChangeId:string|null}` |
| `list_annual_material_requests` | `p_organization_id uuid,p_planning_year integer,p_limit integer,p_after_request_id uuid` | `{scope,requests:MaterialRequest[],nextAfterRequestId:string|null}` |
| `list_annual_need_events` | `p_organization_id uuid,p_planning_year integer,p_plan_revision_id uuid,p_limit integer,p_after_event_id uuid` | `{scope,planRevisionId,events:AnnualNeedEvent[],nextAfterEventId:string|null}` |

`MaterialRequest` has the existing camel-case descriptor/list shape: `id,organizationId,requesterId,status,version,scientificName,nameAr,tradeName,strength,dosageForm,unit,barcode,nationalCode,note,provenanceKind,reviewerId,resolvedItemId,decisionReason,createdAt`. Only requests with a matching A1 annual request context are returned; another year or owner is excluded.

`AnnualNeedEvent` is the existing camel-case `ManualNeedEvent` (`id,planRevisionId,beneficiaryOrganizationId,centralItemId,targetWarehouseId,eventSeq,eventKind,quantityText,approvedUnit,reason,reference,actorId`) plus `createdAt,actorName:string|null,fromTrustedProfile:boolean,annualBinding:AnnualBinding|null`. Historical events without recorded annual references return null; their current global material or current profile is not substituted for a historical snapshot.

### Atomic quantity wrappers

`add_annual_need_line` and `correct_annual_need_line` take exactly:

```text
p_organization_id uuid, p_planning_year integer,
p_plan_revision_id uuid, p_beneficiary_organization_id uuid,
p_central_item_id uuid, p_target_warehouse_id uuid,
p_quantity_text text, p_reason text, p_idempotency_key text,
p_expected_last_event_id uuid, p_reference text,
p_annual_item_id uuid, p_field_version_id uuid
```

`void_annual_need_line` takes the same parameters except `p_quantity_text` is absent. A null expected-last-event is permitted only where the existing add writer permits it. Correct and void keep the existing required CAS event ID and legal lifecycle rules.

All three return `{scope,planRevisionId,idempotentReplay,eventId,eventSeq,annualBinding}`. The canonical UUID must match the annual membership. Revision owner/year, beneficiary, warehouse, canonical unit, annual membership and version must agree. Add/correct use a selectable current version. Void preserves the bound prior reference; it cannot use cancellation to rebind a line. The existing quantity writers remain the only quantity/event writers, including their reservation, idempotency, activation, overlap, draft/revision and permission checks.

`central_needs_annual_need_bindings` stores one immutable annual reference and employee snapshot per bound manual event. The wrapper calls the existing writer and records the binding and audit within the same database transaction. A deferred constraint rejects a reserved annual key or a descendant of an already bound event if its annual binding is absent at commit. Calling an old writer cannot strip the references. Existing unbound legacy events remain unbound; no historical association is fabricated. An unbound legacy row may still be voided through the existing manual void RPC after the UI reads the expected event in the same revision/scope and confirms `annualBinding === null`. That path creates no annual binding. The deferred server fence independently rejects an old-writer void/correction of a bound predecessor without its binding. Correcting a legacy row through the annual wrapper requires an explicit current annual membership/version selection.

Carry-forward preserves the source event's annual reference and frozen fields, captures the carrying employee at that time and never invents a binding for an unbound legacy source. Current legal identity/unit is checked for a carried bound line. A later annual display-label change does not rewrite carried history. Submitted/approved transitions check current legal compatibility of live bound lines without replacing their frozen field values. Historical reads always display the version actually used. A current annual proposal does not silently replace an earlier valid reference.

The existing `phoenix_central_needs_annual_summary(p_organization_id uuid,p_plan_year integer)` keeps its signature, ACL and legal quantity/unit fields. For a bound approved line its existing `name`, `name_ar` and `national_code` keys come from the immutable binding of the latest live event. It additionally returns `annual_binding:AnnualBinding|null` and `identity_source:'annual_version'|'legacy_current_canonical'`. Unbound legacy rows retain their established canonical display and explicitly have no annual snapshot. No independent manual-export implementation exists in this slice.

## Transaction boundaries

Writes require Read Committed. Authority precedes replay. The existing live home-PDA view/edit/manual-set checks remain effective; a new table grant or role-name exemption is not introduced. Actor names come from locked profiles. Catalog edit order is actor/owner, annual operation key, catalog year, canonical row, annual member. Need commands add the existing owner/year plan advisory lock and plan/revision locks, stabilize the existing beneficiary/warehouse predicates under `FOR SHARE`, then obtain catalog-year/canonical/member locks and call the existing writer reentrantly. Canonical rows use `FOR SHARE` when their mutable eligibility/fields must remain stable.

Receipts reuse the A1 owner/actor operation-key namespace and compare the whole action and intent, including both annual references, scope, quantity, expected event and reason. An exact retry returns the original bound result even after later lifecycle changes; a changed reference or intent under the same key fails. Internal manual keys use a reserved annual namespace. No automatic client retry is introduced.

The existing annual catalog search keeps its signature, ACL, owner/year scope and rank/UUID cursor. Search matching and exact-national-code rank use the current annual version’s known `scientificName`, `nameAr` and `nationalCode` field values, including proposed values. This changes discoverability only; selection still requires the independent legal eligibility checks. The original A1 search body is pinned as a candidate precondition.

Both new tables have forced RLS and no direct API SELECT or DML. All private helpers are denied to API roles. The new candidate extends the exact capability manifest, including its new routines, relations and trigger functions, and preserves the previous seal's checks. Historical SQL and the accepted A1 source file are not edited.

## Required acceptance evidence

Native proof covers owner/year/beneficiary forgery; current/old version CAS; identity proposals and legal-unit rejection; nameAr-only correction; missing/blank/Unicode reason; no-op; trusted employee snapshot and later rename; exact replay versus changed annual reference; atomic event/reference/audit rollback; old-writer omission denial; historical nulls; carry-forward preservation; current legal readiness; unchanged other year/source/stock; direct grants and private helper denial; controlled races in both orders. Existing P1 reservation and native A1 acceptance remain separate and must not be represented as a new production apply.

Official guidance consulted: [Supabase database functions/security](https://supabase.com/docs/guides/database/functions) and [PostgreSQL 17 explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html). The local native suite establishes observed behavior; no hosted Auth/PostgREST acceptance is implied.

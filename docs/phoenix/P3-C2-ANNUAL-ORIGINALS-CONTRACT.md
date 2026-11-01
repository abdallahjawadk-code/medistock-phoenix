# P3-C2 — annual original files, capability contract v1

Status: implemented and locally accepted for draft review on 2026-10-31; no hosted activation.
Baseline: governing r13; C1 local `f0cc40d8235a598ce891c2e94fa741f580417287`, tree `255a0465ee232477e90d383e38ae772bd9fa73c0`, published draft #264.
Authorization: local engineering, verification and draft review only. No merge, hosted SQL, production activation or historical migration changes.

## 1. Purpose and boundary

An eligible employee can save the original bytes of one source file in an existing annual catalog, read its receipt and download the identical bytes. The server records the original filename, SHA-256, byte count, employee identity/name/role snapshot and server time. Every resource is scoped to the owner organization and planning year. A beneficiary is neither required nor inferred for this operation.

`server_received_original` means that the server received, hashed and retained these bytes. It does not mean that the file format, cells, parser output, classifications, identities or quantities have been verified. C1/A1 `client_attested` witnesses retain their existing meaning and names; no automatic connection or trust upgrade is made. C3 owns trusted extraction; C4 owns reviewed membership intake and multiple-file orchestration; C5 owns comparison, export and management. No stock, need line, plan, allocation, catalog membership or canonical material is created here. There is no delete, replacement, archive or cross-year copying command in v1.

## 2. Storage decision and limits

Use dedicated immutable PostgreSQL `bytea` originals, separate immutable confirmed-upload events, and the existing annual receipt/audit infrastructure. The server computes `encode(sha256(bytes),'hex')`. Bytes, first-source metadata, confirmed upload event, receipt and canonical audit entry commit atomically.

This reuses the proven small-file transport pattern in M235/P1 without invoking their quantity intake. The existing CN-2B private Storage routes depend on plan revisions and quantity-import permissions; they are not suitable endpoints for annual originals. Adding Storage now would introduce a separate upload/finalization transaction and privileged service path without a demonstrated need for large files in C2.

Explicit v1 engineering limits: **one file per command, 1–3,145,728 bytes (3 MiB)**; **XLS, XLSX or CSV filename extension**, case-insensitive; filename 1–255 UTF-16 code units, exact nonblank text, no leading/trailing whitespace, path separators, control characters or bidi formatting controls, and no Excel `~$` lockfile name. This is an extension allowlist, not a claim that file contents were parsed or found safe. Content is never executed, rendered inline or decompressed by C2. All downloads use `application/octet-stream` and an explicit download action. ZIP and multiple-file queues remain C4 decisions. Limits are published by the capability RPC and enforced again in the database, not only in the browser.

Transfer is canonical padded Base64 in JSON. The database bounds encoded length before decode, checks canonical re-encoding, actual byte count and actual SHA-256 against the intended values. No new dependency or service key is introduced. Reconsider bytea when an accepted larger-file/ZIP requirement or measured database/transfer cost demands object storage; retain immutable IDs and scope when making that separately reviewed change.

## 3. Authority and immutability

Reuse `annual_catalog_guard_v1` and current profile/organization locks. Reads require `central_needs.view`; capture requires view + edit and a new capture requires an active existing year. An exact committed replay remains readable after archival with current authority. No implicit year creation. Anonymous, inactive, foreign-organization and unauthorized actors fail at the server. Read access is not limited to the original uploader, but receipt reconciliation is limited to the authenticated actor whose key was used.

Reuse `annual_needs_actor_name_v1` for a trusted historical profile-name snapshot. The client cannot submit a trusted actor name, role or timestamp. Missing or invalid profile names block a new capture. Historical metadata is not rewritten when a profile changes. Fresh authority is checked on every command and read; a past receipt never restores revoked authority.

Capture and receipt reconciliation also require `p_expected_actor_id` to equal the current authenticated actor. This is a consistency precondition, never an authorization source. It rejects a session change between preparing a file and sending its request before any side effect. The client retains the actor UUID in its immutable intent; names and roles still come exclusively from trusted server state.

New tables have forced RLS, restrictive actor scope, revoked direct table/column access and immutable update/delete/truncate guards. Only named public RPCs are executable by authenticated users; private helpers, public/anonymous/service-role callers and shadow overloads remain covered by the capability seal. Existing historical candidates and migrations remain byte-identical. A new unnumbered NOT_APPLIED candidate extends the exact accepted P3-B seal, never suppresses its checks.

## 4. Deduplication, idempotency and concurrency

Original identity is `(owner organization, planning year, server SHA-256)`; dedupe never crosses an owner or year. Matching hashes must also have byte-identical content and size; an inconsistency is an integrity error. The first original's filename/uploader/time never change.

A new explicitly submitted idempotency key creates a new confirmed-upload event (including its exact submitted filename and employee snapshot), even when bytes match an existing original. Thus identical bytes under two names produce one original and two truthful upload events, not overwritten provenance. A retry of the same key creates no new event, receipt or audit row.

The shared annual key namespace is `(owner organization, authenticated actor, idempotency key)`. The exact immutable intent contains planning year, exact filename, SHA-256 and byte count, with action `store_original_v1`. Same key + same intent returns the original committed result with `idempotentReplay: true`; same key + different year/action/filename/hash/size rejects without effects. Input bytes must still match the stated intent before replay. Existing A1/P3-B key collisions retain their conflict behavior.

Lock order: current profile/organization guards, the existing annual advisory key lock, then the existing year row for a new capture. This preserves the A1/P3-B key-before-year order. The year write lock serializes original creation and dedupe in the same scope; the unique constraint independently enforces the identity. Use READ COMMITTED for capture and receipt reconciliation. Receipt lookup acquires the same key lock as capture, then rechecks the receipt with a fresh statement; it is not an unlocked negative lookup.

## 5. Public capability and RPC shapes

All names below have the prefix `phoenix_central_needs_`.

| Suffix | Inputs | Result |
| --- | --- | --- |
| `annual_originals_contract` | none | Exact version `1`, scope `owner_year`, maxFileBytes, extensions, attestation and atomic/replay flags. No sensitive data. |
| `store_annual_original` | organization UUID, planning year, filename, expected SHA-256, byte size, canonical Base64, idempotency key | Confirmed `AnnualOriginalWriteResult`. |
| `get_annual_original_receipt` | organization UUID, planning year, filename, expected SHA-256, byte size, idempotency key | Scope + exact intent + `result: AnnualOriginalWriteResult | null`. Actor is always the current authenticated actor. No write. |
| `list_annual_original_uploads` | organization UUID, planning year, limit (default25, max50), after-upload UUID or null | Scope, ordered immutable upload events, each with original metadata, next UUID cursor or null. This is the minimal receipt/source read for C2, not C5 management. |
| `download_annual_original` | organization UUID, planning year, original UUID | Scope, original metadata and canonical Base64; server recomputes hash/size before returning. |

Exact argument names: common `p_organization_id`, `p_planning_year`; capture/receipt `p_filename`, `p_sha256`, `p_byte_size`, `p_idempotency_key`; capture additionally `p_base64`; list additionally `p_limit`, `p_after_upload_id`; download additionally `p_original_id`. Capture order is scope, filename, SHA-256, byte size, Base64, key. Receipt order omits Base64. List rows are `{original, upload}` in `uploads`, with `nextAfterUploadId`. Download content field is `base64`. Capability response is exactly `{version: 1, scope: 'owner_year', maxFileBytes: 3145728, extensions: ['xls','xlsx','csv'], attestation: 'server_received_original', atomicReceipt: true, intentBoundReplay: true}`.

For capture and receipt, append the mandatory `p_expected_actor_id` argument after `p_idempotency_key`. A null or different actor rejects with SQLSTATE `42501`; omitting the mandatory argument is an invalid RPC signature and fails before the function body. The shared receipt namespace already includes the actual authenticated actor; no caller-supplied employee name or role becomes part of server authority.

`Original`: `originalId`, `sha256`, `byteSize`, `firstFilename`, `createdBy`, `createdByName`, `createdByRole`, `createdAt`, `attestation: 'server_received_original'`.

`Upload`: `uploadId`, `originalId`, `filename`, `actorId`, `actorName`, `actorRole`, `createdAt`.

`AnnualOriginalWriteResult`: `scope`, `idempotencyKey`, `original`, `upload`, `deduplicated`, `idempotentReplay`.

Receipt wrapper includes `scope`, `intent: {filename, sha256, byteSize, idempotencyKey}`, `result`. The service binds every response to the requested scope, original/key/intent and expected actor, validates runtime types and invariants, and refuses unknown or inconsistent fields. First upload has original/upload matching first-name/actor/time; a deduplicated upload retains the original's distinct first metadata.

Upload pages sort by `(createdAt ASC, uploadId ASC)`. A non-null after-upload UUID must resolve within the requested owner/year; missing and foreign-scope cursors reject. The cursor is an incremental read, not a frozen complete-year export. The service verifies strict tuple order and that any returned next cursor equals the final upload ID.

## 6. Client outcomes and compatibility

No automatic write retry. Before send, create one immutable intent and key. On confirmed success, retain the receipt even if a subsequent list refresh fails and retry only that read. A network timeout, unclassified server error or malformed write response is outcome unknown: retain the same key/intent, offer receipt lookup and prevent a new alternative command for that pending attempt.

An absent reconciliation result is not proof that an arbitrarily delayed request cannot still arrive. An explicit retry is permitted only with the **same key, same filename, same hash, same size and same bytes**. A new-key retry is not offered. Scope/actor changes fence stale responses and pending operations; never carry them silently into another year or session. Client-side download decoding recomputes byte count and hash before exposing a Blob.

Capability discovery is explicit and fail-closed. Old deployments without C2 keep their current annual workflow; absence/error never becomes permission to use legacy quantity upload. The UI must not show a working upload/download control without the exact capability. A disabled or deferred integration is recorded honestly, not represented as hosted availability.

## 7. Acceptance required before claiming C2 ready for a draft

| ID | Evidence |
| --- | --- |
| C2-01 | Real PostgreSQL save/read/download, byte/hash equivalence, max bound and malformed Base64/hash/size/filename rejection; no false cell-trust claim. |
| C2-02 | Same-key replay returns exact original receipt and produces one effect; changed filename/hash/size/year/action conflicts with no effects; actor keys isolated. |
| C2-03 | Real low-privilege reads/writes, foreign owner/year/ID, inactive and anonymous caller, direct table/helper/service role denial; historical actor snapshot retained. |
| C2-04 | Explicitly synchronized races for same key, distinct keys with same bytes/different names, and capability/profile change; inspect committed bytes/events/receipts/audit and liveness. |
| C2-05 | Lost response after real commit + exact intent reconciliation; malformed responses and stale scope/actor in service/UI checks; success+read failure does not recapture. |
| C2-06 | Existing P1/A1/B seals and contracts retained; new seal detects a deliberately broadened grant in a rolled-back probe; no need/membership/quantity/stock sidewrites. |
| C2-07 | Typecheck, relevant tests/lint/build; independent code review. If UI is delivered, focused AR/EN RTL/LTR and responsive/browser acceptance for changed behavior. |

Native SQL bridge tests prove PostgreSQL and application adapter behavior, not live PostgREST limits, hosted activation or production readiness. Hosted transport acceptance and baseline convergence remain separate gates. Any not-run surface stays explicitly not run.

Independent contract review by `c2_storage_review` returned PASS before code implementation. Its two clarifications—exact transport field names and scope-checked chronological cursor ordering—are incorporated above. Implementation review is a separate gate and cannot be inferred from this contract review.

Before publication, root identified the actor-session consistency race and the independent reviewer approved the explicit expected-actor precondition above. Native tests and the service adapter must exercise the resulting final signature; earlier intermediate runs do not establish acceptance of these bytes.

## 8. Current primary documentation consulted

Reviewed 2026-10-31. PostgreSQL 17 documents bytea length/hash/base64 facilities: https://www.postgresql.org/docs/17/functions-binarystring.html . Supabase documents independent Storage upload/overwrite/concurrency behavior and RLS: https://supabase.com/docs/guides/storage/uploads/standard-uploads and https://supabase.com/docs/guides/storage/security/access-control . These establish available mechanisms; the bounded bytea choice is a project design decision.

Supabase changelog Markdown endpoint was unsupported by the research fetcher; the HTML index and relevant notices were read instead: https://supabase.com/changelog , https://supabase.com/changelog/cbc-tls-ciphers-deprecated and https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes . They do not justify an unrequested hosted upgrade. No SDK or database upgrade is part of C2.

## 9. Local implementation acceptance

The final SQL candidate is `supabase/candidates/P3C2_annual_originals_NOT_APPLIED.sql`, SHA-256 `17cd88fa51492c9b5722c4ae95a31275976360205f82584f46c676b65522f600`. The P1, A1 and B candidates remain byte-identical to their accepted versions.

- **53 native PostgreSQL cases passed**, with no skipped or failed cases, on the explicitly pinned disposable PostgreSQL 17.11 instance. Coverage includes 12 synchronized races, actual low-privilege calls, the TypeScript adapter, loss of the response after a real commit, exact receipt reconciliation, rollback and seal probes, and unchanged material/membership/need/stock tables. This is local PostgreSQL evidence, not hosted PostgREST acceptance.
- **73 service unit cases, 12 UI runtime cases and 13 preservation-gate cases passed.** The existing 22 annual journey and 12 source-panel cases also passed during the focused regression run. Counts from repeated runs are overlapping and are not added as new coverage.
- Production TypeScript/build, the supported changed-source ESLint scope and supplemental browser-fixture TypeScript checks passed. Existing large-bundle warnings remain. Temporary preview host configuration was removed before the final build.
- Independent SQL, service and UI source reviews passed within their stated scopes. The cross-page overlap finding was fixed; pending uncertainty remains preserved even when a later same-key retry is rejected.
- Bounded browser checks used the actual React components with explicit synthetic APIs: Arabic desktop selection/save/unknown outcome/reconciliation and exact 47-byte download, Arabic light 320px layout and keyboard disclosure, and English dark 390px layout. The narrow 320px iframe exposes a pre-existing 6px document overflow from the global 320px minimum; C2 cards themselves stay within their bounds. The 390px document measured 384px client and scroll widths.

First attempts and their diagnoses remain in the governing evidence: a native test bridge rejected digits in an argument name before SQL; a full-byte test comparison exceeded its timeout and was replaced by an equivalent full-byte Buffer comparison; one UI selector matched two labels; sandbox Git subprocess restrictions affected the first preservation run; the first lint command included an unsupported fixture path; the supplemental fixture check required the normal Vite ambient declaration and exposed the small compatibility/type corrections. None of these attempts is presented as a passing final run.

GitHub draft identity and CI conclusions are recorded separately after actual publication. Original-file capture remains capability-gated until the hosted baseline and explicit activation gates are completed. Trusted extraction, reviewed material intake, multi-file orchestration and final program release are not established by this acceptance.

## Master integration gate — 2026-11-01

PR #264 merged into `master` at `6ee0d0bc8fedd0555057e938241205aa2a6cafd9` after successful GitHub CI and authenticated E2E. PR #265 is retargeted to `master`; this documentation-only update requires fresh master-based CI and authenticated E2E. Earlier parent-branch evidence is historical and not substituted for this gate. This note does not change SQL, Storage, source bytes, auth, or production activation. The unnumbered C2 SQL candidate remains NOT_APPLIED and hosted validation is still required.

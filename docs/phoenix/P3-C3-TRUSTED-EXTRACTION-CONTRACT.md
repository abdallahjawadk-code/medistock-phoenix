# P3-C3 — Trusted annual-source extraction and reviewed templates

**Status:** PROPOSED FOR INDEPENDENT REVIEW — DOC-ONLY — NOT IMPLEMENTED, NOT ACCEPTED, NOT HOSTED.
**Governance:** MediStock governing continuity r14 (2026-10-31), sections 0, 5–6, 9, 13–15, 20 and 27.
**Stacked baseline:** C2 draft #265, head 798b78a5ffa0261658685a8fccc8dcee282fa491, on C1 draft #264.
**Authorization boundary:** contract drafting and isolated review. No merge, hosted SQL, Production, dependency upgrade, private workbook publication or page retirement.

## 1. Purpose and explicit decision

C3 derives reviewable cell, row, header and source-classification evidence from the **actual immutable bytes** retained by C2, using the existing CN-2A Node parser and a specifically reviewed, versioned template. A valid C2 hash/receipt is only evidence that an original was retained; it is not evidence that any cell, material, unit or annual quantity is correct.

**Chosen minimal C3 design for implementation review:** a **read-only, on-demand, caller-authorized Node 22 server endpoint**, with paged evidence and no C3 database write. It may identify candidate roles but does not accept/reject a legal material identity. The server independently downloads original bytes through the already-authorized C2 read RPC under the employee's own JWT, verifies original SHA-256/size, invokes the pinned Node parser, verifies a reviewed template, and returns bounded evidence with provenance. No browser-supplied parsed cell or client-side assertion may be elevated into server-derived evidence.

This is an architectural proposal, not an implemented endpoint. **C4 must independently re-fetch and re-parse the original (or verify a separately designed server-authenticated immutable extraction receipt) before any persisted catalog membership/source decision.** A C3 response is *not* a transferable permission token or an authoritative database event. No claim is made that a read-only page remains available across a browser session or that every workbook layout can be recognized.

C3 does not create annual catalog membership, legal registration, need lines, beneficiary selections, allocations, stock records, audit history revisions or need quantities. Those are separate existing/C4/R2 authorities. It does not modify C1 client-attested source witnesses, rewrite C2 originals or certify earlier files retroactively.

## 2. Source of authority and technical reuse

1. C2 existing owner/year-scoped immutable original identity: originalId, server SHA-256 and byte count. Confirmed upload events can have distinct filenames/actors for the same original; C3 binds to originalId and hash, not a mutable or alternative upload filename.
2. Existing user-scoped authorization path: api/_lib/supabase.ts authenticate(req) and caller.client, and C2 phoenix_central_needs_download_annual_original, not a general service-role bypass. An unauthorized originalId or foreign owner/year must fail at the database. Missing C2 RPC/capability fails closed.
3. Existing authoritative Node adapter: src/features/central-needs/import/node-replay.ts replayWorkbook(bytes, filename); parser-core.ts and import/contract.ts, CN2A contract **1.2.0**, SheetJS **0.20.3** with pinned tarball SHA-256 **8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8**. Do not fork or rewrite the parser as a second annual engine.
4. Existing parser output: SheetEvidence with native sheet index/name/visibility, physical 0-based row and column plus A1 address, cell presence (missing/blank/value), rawValue, formula/error indicators, merge ranges, duplicate header evidence and source-provenance anchors. Preserve its shape and documented limits. Do not promote a second header row silently into the canonical fieldName.
5. Existing annual identity helper extractAnnualIdentityBlock and comparison reviewAnnualSourceOccurrences may be reused only as **candidate/evidence utilities**, not as trusted legal-identity or quantity writers.
6. Neither captureDossierWorkbook nor finalize-import is called: they serve historical quantity/revision intake and would cross the C3 no-side-effect boundary.

## 3. Authentication, scope and target safety

- Require POST, an authenticated current employee, an explicit owner organization + planning year + original UUID. The server verifies Supabase Auth before reading or parsing, and passes the real caller JWT through the user-scoped client to the C2 RPC. Never rely on an actorId/role/name sent by the browser.
- The C2 RPC must authorize central_needs.view and the actual owner/year. C3 does not infer a beneficiary for an original file, and never uses an administrator role name by itself as permission.
- The server checks the returned scope, original UUID, hash, byte count, attestation and canonical Base64 before parsing. Recompute SHA-256 on received bytes and refuse mismatches; accept only the C2 max of 3,145,728 bytes.
- Bind the runtime endpoint explicitly to a permitted non-Production target. Preview may not silently inherit Production secrets/configuration. Do not activate a route until its target identity, capabilities and authenticated end-to-end access are verified. Hosted baseline convergence is a separate gate.
- No service-role key is needed for the proposed read-only C3 path. If actual implementation reveals a privileged operation is unavoidable, STOP and amend/review this contract; never silently introduce or expose a service key.

## 4. Format, parser isolation and resource controls

- The only C3 single-file formats are XLS, XLSX and CSV as covered by C2. Verify **content magic/encoding and extension** using the existing parser. Fail with a distinct diagnostic for malformed, encrypted, mismatched or unsupported input; filenames alone are not proof.
- Do not execute formulas, macros, DDE, external links, embedded scripts or hyperlink URLs; never fetch remote references or render untrusted workbook HTML. Retain formula text/cached result as explicitly non-authoritative evidence only. HTML/CSV presentation must escape source strings; export handling is outside C3.
- Parse in a bounded isolated worker/process with enforceable termination, time, memory and input/output ceilings; a Promise timeout alone does not stop synchronous spreadsheet parsing. The parser's default 64 MiB raw-input allowance is **tightened to C2's 3 MiB** in this path. Existing 10k-row/256-column/200-sheet defaults are upper bounds, not permission to return the entire parsed corpus. Prove abort behavior against adversarial XLS/XLSX/CSV.
- Only **one stored original per call**. Paged summaries/rows are bounded; do not send every cell in a multi-megabyte JSON response or persist it in browser storage. A page must re-check authorization/original identity and either reproduce evidence deterministically or explicitly expire.
- The 2026 private ZIP is **not** accepted through C3. C2 accepts individual originals only; ZIP queuing and nested-path provenance belong to C4. A directory label from the unretained ZIP must never be described as a verified in-workbook category.
- No workbook bytes, cell contents, national codes, employee names, JWTs, credentials or full private filenames in telemetry, exceptions, public previews, GitHub, exported test fixtures or application logs. Diagnostic logging uses opaque correlation IDs, scope-safe status and bounded counts.

## 5. Template registry, roles, drift and trust levels

A template is an explicit, immutable **reviewed version**, identified by templateId, semver, templateSha256 and reviewer/review artifact. The server bundles/loads only allowlisted reviewed versions. A single employee's mapping correction cannot change a template or teach a global rule; future promotion requires review and independent tests. A mismatch between requested template version and the reviewed server manifest must refuse, never fall back to an older unlabelled rule.

A template version declares:
- Supported workbook family/format; sheet selectors and expected header-band relationships, exact/approved alias header strings, expected raw text types, row/column geometry and merge rules; sheet index remains evidence, not presumed unchanging across arbitrary files.
- Per-field physical source-coordinate evidence for roles such as material name, scientific name, **national code**, old code versus new code, dosage form, concentration, source-unit text and source classification, and explicitly which fields are not present.
- Allowed variations (e.g. an explicitly reviewed moved column/header alias), required corroboration and **semantic drift refusals** (e.g. a department heading containing the word “وحدة” is not a unit of measure).
- An explicit distinction between raw original classification, a reviewed template proposal and an employee-entered category. Never claim that an operator-provided category was extracted from cells.

C3 statuses are at least: **verified_extraction** (cell bytes and declared coordinates reproduced from the immutable original under a reviewed template; not material approval), **needs_review** (missing/ambiguous/conflicting field or layout), **unsupported_format_or_template**, **rejected_integrity**, **unavailable_capability**. For every status, return a stable error/exception code; never replace unknown with zero or auto-select a canonical UUID/unit.

Real corpus hazard: CORPUS-CONTRACT.md documents many multiple-row headers, 468/510 generic header columns with other-row evidence, department labels “وحدة المناعة/وحدة الهرمونات”, 326 free-text unit variants, duplicate header groups and old/new codes. A “contains وحدة” or “most frequent code wins” heuristic is explicitly **forbidden**. Header candidates may help a reviewer; they do not select a final source unit. A zero is a value; blank, missing, formula, cached result and error are separate.

## 6. Reviewable evidence payload and proposed request/response

Proposed endpoint: **POST /api/central-needs/annual-originals/extract**. This path is reserved in the contract, **not** an implemented route. Request fields: organizationId UUID, planningYear, originalId UUID, templateId, templateVersion, pageCursor (nullable), pageLimit (maximum **50 candidate rows**). The authenticated actor comes from the bearer JWT, not the body.

Response identity and evidence must bind:
- scope {ownerOrgId, planningYear}; original {originalId, sha256, byteSize, attestation: server_received_original};
- parseRun {nonpersistent runFingerprint, parserContractVersion, sheetjsVersion, sheetjsTarballSha256, runtime: node, effectiveLimits, generationTime}; **runFingerprint is diagnostic only, not a signed receipt**;
- template {id, version, sha256, reviewRef, recognitionStatus, exact failed/passed predicates};
- per-row {sheetIndex, sheetName, sheetHidden, rowIndex, original category evidence or absent, candidate recordKind, role alternatives, ambiguities, severity};
- per-field {fieldRole, sheetIndex, rowIndex, colIndex, A1, presence, rawValue/valueType where present, isFormula, formula/error flags, header evidence references, source-versus-template provenance};
- page metadata {pageLimit, nextCursor, totalCount only if actually known, completeness flag}, bounded diagnostics and explicit statuses.

Determinism: page ordering is (sheetIndex, physical rowIndex, stable candidate key); no duplicate/omitted row across pages on unchanged bytes, template and parser version. Bind a continuation token to originalId/hash, year, template hash, parser identity and offset; do not permit it to change scope/template or bypass fresh authorization. A full-file proof cannot be claimed from the first page. Page count/size and response byte limits are testable acceptance constants; introduce no magic defaults where bounds are required.

**Clarification to review:** this contract deliberately avoids a new C3 SQL write and service-role flow. Before code, reviewers must confirm the existing API request-size/worker/runtime and paging approach can meet limits. If not, propose a separately authorized, immutable server-side parse-result store and receipts rather than accept client-generated “trusted” JSON. No RPC/table names for that alternative are approved here.

## 7. Employee experience and explicit human decision

After a confirmed C2 upload, “تحليل المصدر” is an **explicit** action; selecting/uploading an original does not auto-write catalog data. A disabled/clear state appears if hosted C2 or C3 is unavailable. Show original year/owner and the difference between “الأصل محفوظ”، “تم استخراج شاهد من الأصل”، and “المادة معتمدة”. On mobile, display a source-row list then details; on desktop/tablet support table + evidence panel; Arabic RTL and English LTR with isolated numeric and scientific values.

An unresolved row shows the **actual missing/ambiguous evidence** and lets the employee mark it for review; selecting a proposed role in the UI is NOT permanent template learning or a legal identity approval. Any future persisted review decision is C4 and requires actor/reason/version/idempotent writer and same owner/year. Original 2026 data never populates 2027 implicitly. C3 is read-only even when the employee has edit permission.

A missing source-unit does not become a legal unit. A code with leading zeroes and hyphens remains exact text; old code cannot silently override new code. A changed dose/form/unit may represent a distinct legal material: no deduplication or transfer on visual similarity.

## 8. Acceptance matrix — all OPEN until separately executed

| ID | Required evidence |
| --- | --- |
| C3-01 | C2 stored file -> caller JWT-scope download -> recomputed SHA/byte-size -> identical Node parse input; negative altered file/hash/owner/year/original ID; no client-trusted payload. |
| C3-02 | XLS + XLSX + CSV synthetic formats; bad magic, truncated/encrypted, formulas/macros/external-link abuse and resource ceilings; enforceable termination, no external I/O. |
| C3-03 | Physical sheet/row/column/A1 raw evidence including hidden sheets, merges, dual header bands, errors, blanks, missing, zero and formulas; no value normalization or formula execution. |
| C3-04 | Reviewed template SHA/version and semantic drift negatives: NEW CODE vs OLD CODE, moved column allowed only if reviewed, “وحدة المناعة” rejected as unit, changed meaning rejected, ambiguous classifications. |
| C3-05 | Fresh authorization per paged request, deterministic bounded pagination, scope/actor/context switch, late response fencing and no cross-year data; unknown count never fabricated. |
| C3-06 | Existing C1/C2/A1/P3-B behavior and exact candidate/hash guard unchanged; zero catalog, need, quantity, allocation, stock, profile or audit side writes; old witnesses stay client_attested. |
| C3-07 | Independent **unseen-file** evaluation not used in template preparation. Record number of files, row-level coverage, silent wrong approvals, exception rate, operator questions and time separately; never derive a generalization claim from the studied 2026 corpus alone. |
| C3-08 | Source review, TypeScript/lint/build and focused tests; AR/EN, RTL/LTR, keyboard, 320–390px/mobile and desktop UI **if** UI is implemented; client/server provenance labels are distinct. |
| C3-09 | Authenticated hosted Preview only after verified non-Production configuration, C2 prerequisite capability and target convergence. Native/mocked tests do not count as hosted Auth/RLS/PostgREST acceptance. |

A pass requires actual run identifiers, exact source revision, artifacts and failure records. In particular, no independent blind corpus is currently supplied; **C3-07 remains OPEN** and production-grade template auto-recognition must not be claimed. No use of real source files as public fixtures. Existing documented 2026 analysis is development evidence, never an unseen holdout.

## 9. Implementation sequence and no-cascade governance

**C3-0 — now:** record this contract, verify reuse points and baseline source; independent architecture/security review; make any needed contract corrections **before code**.

**C3-1 — implementation after acceptance:** implement user-scoped read-only extractor and reviewed-template manifest on an isolated branch stacked on #265. Add focused tests, bounded real-node evidence, parser resource-abuse rejection, and source/authorization review. A client-side demo alone cannot close the gate.

**C3-2 — optional bounded UI:** add a read-only provenance panel behind exact capability; preserve C1/C2 response and UI semantics. No annual catalog or quantity side-write.

**C3-3 — review and draft CI:** publish as draft only when the tested tree matches the reviewed source; record first failures and follow-up checks. No merge or hosted SQL activation from draft CI alone. C4/C5 are separate contracts; P5 allocation waits R2. The old annual page stays until documented feature/history/permissions/deep-link equivalence.

## 10. Grounding and open risk

Project source: CORPUS-CONTRACT.md; src/features/central-needs/import/{contract.ts,parser-core.ts,node-replay.ts}; api/_lib/supabase.ts; docs/phoenix/P3-C2-ANNUAL-ORIGINALS-CONTRACT.md; r14 evidence EVIDENCE/P3-C-PREPARATION/P3C-PREPARATION-AR.md and §27. Source C2 PR #265 (https://github.com/abdallahjawadk-code/medistock-phoenix/pull/265).

External defensive guidance (mechanisms, not authority to change the project): OWASP File Upload Cheat Sheet, https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html ; SheetJS Security, https://docs.sheetjs.com/docs/miscellany/security/ .

**Open review findings:** worker-level enforceable abort and response quotas; whether C2 transport roundtrip can reliably execute in the selected Node server environment without privileged credentials; how reviewed template changes are promoted with a valid independent holdout; and exact source-category provenance for stand-alone files. None is silently treated as closed.

**Evidence baseline only:** user-supplied 2026 archive SHA-256 b00208ca019c8735790c5401dee26d986234a12279d04e0a057f278bd99eaca2. Historical audit found 57 XLS workbook files and 8 Office lockfiles in its 65 file entries. These facts are not a claim that annual materials are already mapped or approved. Original bytes, names and workbooks remain private; this doc carries no such payload.

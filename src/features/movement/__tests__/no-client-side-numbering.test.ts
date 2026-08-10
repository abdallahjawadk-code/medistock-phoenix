/**
 * MOVEMENT-COMPOSER-A — the numbering guard.
 *
 * No atomic server-side allocator exists (see
 * docs/phoenix/proposals/sequential-document-numbers.md). The one thing that
 * must never happen in response to that gap is the frontend inventing a
 * sequence that LOOKS authoritative. This test makes that regression loud.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const MOVEMENT_DIR = join(ROOT, 'src', 'features', 'movement');

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name) && !full.includes('__tests__')) out.push(full);
  }
  return out;
}

const sourceFiles = walk(MOVEMENT_DIR);
const sources = sourceFiles.map(f => ({ file: f.replace(ROOT, '.'), text: readFileSync(f, 'utf8') }));

describe('no client-side document-number sequence exists', () => {
  it('has movement source files to scan (the guard is not vacuous)', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it('never derives a document number from MAX()+1 or a row count', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/Math\.max\([^)]*\)\s*\+\s*1/);
      expect(text, file).not.toMatch(/\.length\s*\+\s*1\s*[;,)]/);
      expect(text, file).not.toMatch(/last(Number|Value)\s*\+\s*1/i);
    }
  });

  it('never builds a document number from a timestamp or a random value', () => {
    for (const { file, text } of sources) {
      // Date.now()/random are fine for unrelated purposes, but must never be
      // adjacent to number/serial/reference construction in this feature.
      const numberish = /(?:requestNumber|transferNumber|returnNumber|shipmentNumber|documentNumber|serial)\s*[=:]\s*[^;\n]*(?:Date\.now\(\)|Math\.random\(\))/i;
      expect(text, file).not.toMatch(numberish);
    }
  });

  it('never persists or reads a counter from localStorage/sessionStorage', () => {
    for (const { file, text } of sources) {
      const storageCounter = /(?:localStorage|sessionStorage)[^;\n]*(?:number|serial|sequence|counter)/i;
      expect(text, file).not.toMatch(storageCounter);
    }
  });

  it('the QR trace key refuses anything that is not a uuid', async () => {
    const { buildMovementQrPayload } = await import('../movement-trace');
    // A formatted serial must never be accepted as the canonical trace key.
    expect(() => buildMovementQrPayload('supply_dispatch', 'SUP-DSP-2026-000001')).toThrow();
    expect(() => buildMovementQrPayload('supply_dispatch', '1')).toThrow();
  });

  it('operator-typed numbers are labelled as external references, not serials', () => {
    const strings = readFileSync(join(ROOT, 'src', 'shared', 'i18n', 'strings.ts'), 'utf8');
    expect(strings).toContain('mv_external_reference');
    expect(strings).toContain('Official letter / external document number');
    expect(strings).toContain('رقم الكتاب أو المستند الخارجي'); // UNIFIED-DOMAIN relabel
  });

  it('the migration proposal exists and is explicitly not applied', () => {
    const proposal = join(ROOT, 'docs', 'phoenix', 'proposals', 'sequential-document-numbers.md');
    expect(existsSync(proposal)).toBe(true);
    const text = readFileSync(proposal, 'utf8');
    expect(text).toMatch(/PROPOSAL ONLY/i);
    expect(text).toMatch(/not applied/i);
  });

  it('no migration file was added for MOVEMENT document numbering', () => {
    const migrations = readdirSync(join(ROOT, 'supabase', 'migrations')).filter(f => f.endsWith('.sql'));
    // 087 (institution local procurement) is the highest reviewed migration.
    // None of 083–086 add document numbering. 087 DOES create a sequence —
    // procurement_receipt_number_seq — but it is a SERVER-side allocator for
    // PROCUREMENT receipt numbers, consumed only inside the SECURITY DEFINER
    // receive RPC: exactly the safe direction this guard exists to protect
    // (the danger is a CLIENT inventing an authoritative-looking number).
    // The movement corridor's request/transfer/return/shipment numbers remain
    // unallocated and the proposal remains unapplied. The ceiling moves with
    // each reviewed migration that adds no MOVEMENT numbering.
    // 088 (canonical supply provenance) is reviewed and adds NO document
    // numbering — provenance columns + identity only.
    // 091 (PHOENIX-FIVE-ROLE-CUTOVER-091) is reviewed and adds NO document
    // numbering — role/RLS/RPC cutover only.
    // 092 (MONTHLY-STATUS-REDESIGN-092) is reviewed and adds NO document
    // numbering — inventory_status_reports/lines/amendments + stocktakes are
    // identified by uuid only, never a client- or server-numbered document
    // string.
    // 093 (SECURITY-ARCH-HARDENING-A) is reviewed and adds NO document
    // numbering — account-lifecycle contract only (reservations keyed by
    // profile uuid; no client- or server-numbered document string).
    // 094 (CUSTODY-CHAIN-NOTIFICATIONS-094-A) is reviewed and adds NO document
    // numbering — the notification feed and its dedupe_key reuse the SAME
    // uuid ':' status text 082 already writes to phoenix_movement_events; no
    // new sequence, no client- or server-numbered document string.
    // 095 (RETURN-AVAILABILITY-CAP-095-A) adds NO document numbering — a
    // quantity cap on an existing return-line RPC, identified by uuid only.
    // 096 (BULK-RECEIVE-MATCHING-DISPATCH-LINES-096-A) adds NO document
    // numbering — bulk delegation to 070's existing per-line RPC, no new
    // document identity of any kind.
    // 097 (FEFO-REASONED-OVERRIDE-097-A) adds NO document numbering — a
    // permission + audit gate on an existing line-insert RPC.
    // 098 (SECOND-PERSON-CORRECTION-APPROVAL-098-A) adds NO document
    // numbering — phoenix_stock_correction_requests rows are identified by
    // uuid only, never a client- or server-numbered document string.
    // 099 (NOTIFICATION-WIRING-AND-QUARANTINE-DISPOSITION-099-A) adds NO
    // document numbering — reuses 082's dedupe pattern and uuid identity
    // throughout, including the new quarantine disposition RPCs.
    // 100 (BULK-RECEIVE-REMAINING-CORRIDORS-100-A) adds NO document
    // numbering — three thin iterate-and-delegate wrappers over the
    // already-reviewed 068/069/071 single-line receive RPCs (088's current
    // bodies); each line's derived request id is a deterministic uuid
    // (md5 of bulk request id + line id), never a client- or server-numbered
    // document string.
    // 101 (WAREHOUSE-SECOND-PERSON-CORRECTION-APPROVAL-101-A) adds NO
    // document numbering — mirrors 098's uuid-only correction-request
    // identity (phoenix_warehouse_correction_requests rows are identified by
    // uuid only).
    // 102 (TRANSFER-SEND-FEFO-GUARDED-102-A) adds NO document numbering —
    // a permission + audit gate delegating to 068/088's existing
    // phoenix_send_warehouse_transfer_line, whose own request-id/fingerprint
    // identity is untouched.
    // 103 (INSTITUTION-WAREHOUSE-NO-DIRECT-ENTRY-103-A) adds NO document
    // numbering — a warehouse_kind fail-closed check inserted into 065/088's
    // existing phoenix_receive_warehouse_stock and 065's phoenix_apply_
    // warehouse_stock_movement; both functions' request-id/fingerprint
    // identity scheme is otherwise untouched.
    // 104 (RETURN-QUARANTINE-INSERT-COLUMN-FIX-104-A) adds NO document
    // numbering — a column/value alignment fix inside 069/071's existing
    // quarantine-credit branches; no new identity of any kind, request-id/
    // fingerprint scheme untouched.
    // 105 (QUARANTINE-READ-POLICY-DISPOSITION-PARITY-105-A) adds NO document
    // numbering — a pure RLS SELECT-policy widening, no RPC, no identity of
    // any kind. The ceiling moves to 106.
    // 106 (DISPATCH-LINE-IDEMPOTENCY-106-A) adds NO document numbering — an
    // OPTIONAL p_request_id dedup layer over 097's phoenix_add_dispatch_line_
    // fefo_guarded (a dedicated phoenix_dispatch_line_requests ledger keyed
    // on a client-derived uuid request id, not a document/sequence number of
    // any kind). The ceiling moves to 107.
    // 107 (DISPATCH-LINE-REQUEST-ID-REQUIRED-107-A) adds NO document
    // numbering — tightens 106's p_request_id from optional to REQUIRED (a
    // fail-closed IF p_request_id IS NULL THEN RAISE guard as the first
    // statement in the function body), same signature, same uuid-keyed
    // phoenix_dispatch_line_requests dedup ledger, no document/sequence
    // number of any kind introduced. The ceiling moves to 108.
    // 108 (CUSTODY-CHAIN-DIRECT-WRITE-LOCKDOWN-108-A) adds NO document
    // numbering — a pure REVOKE of INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/
    // REFERENCES from authenticated/anon/PUBLIC on custody-chain tables
    // (closing a TRUNCATE-grant gap every prior REVOKE missed); no RPC, no
    // schema change, no identity of any kind. The ceiling moves to 109.
    // 109 (PUBLIC-SCHEMA-DEFAULT-PRIVILEGES-LOCKDOWN-109) adds NO document
    // numbering — pure ALTER DEFAULT PRIVILEGES statements closing the
    // default-ACL root cause behind 108 (future tables/sequences/functions
    // no longer inherit broad authenticated/anon/PUBLIC access); no RPC, no
    // new table, no identity of any kind. The ceiling moves to 110.
    // 110 (PAPER-REFERENCE-CONTRACT-110) adds NO document numbering —
    // phoenix_paper_references.paper_reference_number is a deliberately
    // OPTIONAL, operator-typed EXTERNAL reference (the paper document a real
    // instruction traces back to), exactly like the pre-existing
    // mv_external_reference field this same guard already protects — never
    // an authoritative serial. Nothing in 110 allocates a client- or
    // server-side sequence for a MOVEMENT document; the row's own identity
    // is its uuid, and the canonical document/official numbers it links to
    // (dispatch_number, return_number, official_number) are 100% untouched.
    // The ceiling moves to 111.
    // 111 (THRESHOLD-BATCH-APPLY-111) adds NO document numbering —
    // phoenix_batch_upsert_inventory_threshold is a thin, validate-then-loop
    // wrapper delegating every element to 092's UNCHANGED per-material
    // phoenix_upsert_inventory_threshold; no new table, no sequence, no
    // MOVEMENT document identity of any kind (thresholds are not movement
    // documents). The ceiling moves to 112.
    // 112 (STATUS-CLASSIFICATION-BOUNDARY-CORRECTION-112) adds NO document
    // numbering — corrects the available/scarce/unavailable/surplus
    // classification comparisons and widens two CHECK constraints on
    // inventory_status_report_lines; no new table, no sequence, no MOVEMENT
    // document identity of any kind (a classification value is not a
    // document number). The ceiling moves to 113.
    // 113 (MONTHLY-STATUS-DIRECT-WRITE-LOCKDOWN-113) adds NO document
    // numbering — pure REVOKE/GRANT statements closing 092's unrevoked
    // default-ACL grants on three tables plus PUBLIC's un-revoked EXECUTE on
    // eleven RPCs; no new table, no sequence, no MOVEMENT document identity
    // of any kind (a privilege grant is not a document number). The ceiling
    // moves to 114.
    // 114 (CENTRAL-ITEMS-CATALOG-DETAIL-114) adds NO document numbering —
    // three nullable text columns on central_items (trade_name/concentration/
    // dosage_form); no sequence, no MOVEMENT document identity of any kind.
    // The ceiling moves to 115.
    // 115 (CENTRAL-INTAKE-CATALOG-LOCKDOWN-115) adds NO document numbering —
    // redefines phoenix_receive_warehouse_stock to require and derive
    // identity from an existing central_items row; reuses 090's WR-/WA-
    // official-number trigger unchanged, allocates no new sequence, no
    // MOVEMENT document identity of any kind. The ceiling moves to 116.
    // 116 (SUBPURCHASE-NATIONAL-CODE-116) adds NO document numbering — adds
    // an optional p_national_code parameter to phoenix_subpurchase_direct_entry,
    // threaded into the existing order/receipt line rows; the SP-/PR- number
    // sequences it reuses are 089's/087's UNCHANGED server-owned allocators,
    // no new sequence, no MOVEMENT document identity of any kind. The
    // ceiling moves to 117.
    // 117 (SUBPURCHASE-DUPLICATE-CANDIDATES-117) adds NO document numbering —
    // a read-only advisory fuzzy-match RPC (phoenix_subpurchase_duplicate_candidates);
    // no table, no sequence, no MOVEMENT document identity of any kind. The
    // ceiling moves to 118.
    // 118 (CENTRAL-INTAKE-MANUAL-IDENTITY-118) adds NO document numbering —
    // it redefines the existing intake writer and preserves the unchanged
    // 090 WR-/WA- server-owned allocator. The ceiling moves to 119.
    // 119 (REPORT-SNAPSHOTS-AND-EXECUTIVE-OVERVIEW-119) adds a NEW document
    // family (official report snapshots, RP-YYYY-nnnnnn) — not a MOVEMENT
    // document, but numbered with the exact same safe discipline this guard
    // exists to enforce: a REVOKEd sequence, stamped by a BEFORE INSERT
    // trigger (090's pattern verbatim), never a client-supplied or
    // client-computed number. The ceiling moves to 120.
    // 120 (SUPPLY-SOURCES-DETAIL-120) adds NO document numbering — a
    // read-only drill-down function over warehouse_stock/outlet_stock's
    // existing rows; no table, no sequence, no MOVEMENT document identity
    // of any kind. The ceiling moves to 121.
    // 121 (MONTHLY-STATUS-PUBLIC-EXECUTE-LOCKDOWN-121) adds NO document
    // numbering either — eleven idempotent REVOKE EXECUTE statements only, no
    // table, no sequence, no MOVEMENT document identity. The ceiling moves to
    // 122.
    // 122 (MOVEMENT-TIMELINE-CORRECTION-COVERAGE-122) adds NO document
    // numbering either — attaches an existing status-transition trigger to
    // two correction-request tables, no table, no sequence, no MOVEMENT
    // document identity. The ceiling moves to 123.
    // 123 (MOVEMENT-LEDGER-EVENT-CAPTURE-123) adds NO document numbering
    // either — two new event-capture trigger functions attached to the
    // quantity-movement ledgers and stocktakes, no document/sequence
    // identity of any kind. The ceiling moves to 124.
    // 124 (MOVEMENT-CONTRACT-CORRELATION-FIELDS-124) adds NO document
    // numbering either — nullable occurred_at/correlation_id/causation_id
    // columns on the three quantity ledgers plus quantity_before/
    // quantity_after/correlation_id/causation_id on phoenix_movement_events,
    // threaded through the existing capture trigger. No new sequence, no
    // document/official-number identity of any kind (correlation_id and
    // causation_id are cross-reference aids for tracing related events, not
    // sequential document numbers, and are never client-computed — they pass
    // through NULL until a writer RPC populates them). The ceiling moves to
    // 125.
    // 125 (MOVEMENT-REASON-CODE-VOCABULARY-125) adds NO document numbering
    // either — a closed-vocabulary reason_code column (CHECK-constrained to
    // a fixed 16-value set) on the three quantity ledgers, schema-only, no
    // RPC touched. reason_code is a category label, not a sequential or
    // unique document/official number of any kind — no sequence, no
    // generation counter, nothing client-computed (the DEFAULT is a fixed
    // literal, 'legacy_unclassified', not derived from any counter). The
    // ceiling moves to 126.
    // 126 (MOVEMENT-REASON-CODE-GROUP-A-WAREHOUSE-INTAKE-126) adds NO
    // document numbering either -- it redefines the two Group A root-op
    // writer RPCs to populate the already-closed reason_code column and a
    // freshly-generated correlation_id (gen_random_uuid(), never a
    // sequential counter). phoenix_apply_warehouse_stock_movement gains one
    // new OPTIONAL p_reason_code parameter, itself CHECK-constrained to a
    // closed vocabulary subset -- not a document/official number, not
    // client-computed, not sequential. The ceiling moves to 127.
    // 127 (MOVEMENT-REASON-CODE-GROUP-B-WAREHOUSE-TRANSFER-127) adds NO
    // document numbering either -- it wires reason_code (hardcoded
    // 'transferred'/'received', no client choice, no new parameter on
    // either function) and correlation_id/causation_id chaining into the
    // warehouse-to-warehouse transfer send/receive pair, plus a single
    // nullable source_movement_id FK column linking a transfer line to its
    // own send movement -- a UUID foreign key, not a sequence or document
    // number of any kind. The ceiling moves to 128.
    // 128 (MOVEMENT-REASON-CODE-GROUP-C-WAREHOUSE-RETURN-128) adds NO
    // document numbering either -- it propagates an ALREADY-EXISTING closed
    // reason_code (warehouse_return_request_lines.reason_code, a 9-value
    // vocabulary member) onto both the send and receive ledger rows, plus a
    // nullable source_movement_id FK on warehouse_return_shipment_lines
    // mirroring 127's Group B fix -- again a UUID foreign key, never a
    // sequence or document number. The ceiling moves to 129.
    // 129 (MOVEMENT-REASON-CODE-GROUP-D-DIRECT-SUPPLY-129) adds NO document
    // numbering either -- structural twin of 127/128's fixes applied to the
    // direct (route-free) central<->institution send functions: hardcoded
    // 'transferred' / propagated v_reqline.reason_code, fresh
    // correlation_id, and population of the SAME source_movement_id
    // columns 127/128 already added (no new schema at all in this
    // migration). The ceiling moves to 130.
    // 130 (MOVEMENT-REASON-CODE-GROUP-E-PROCUREMENT-130) adds NO document
    // numbering either -- _phoenix_procurement_post_receipt_line gets a
    // hardcoded 'received' reason_code and a fresh correlation_id (no
    // signature change, an internal helper); phoenix_procurement_return_to_supplier
    // gains one new mandatory-alongside-existing-reason p_reason_code
    // parameter, CHECK-validated against the original 9-value quality/loss
    // vocabulary, and chains correlation_id/causation_id from
    // procurement_receipt_lines.movement_id -- a column that already
    // existed before this migration (no ALTER TABLE anywhere in 130). No
    // sequence, no client-computed identifier, no document/official number
    // of any kind. The ceiling moves to 131.
    // 131 (MOVEMENT-REASON-CODE-GROUP-F-OUTLET-131) adds NO document
    // numbering either -- phoenix_receive_outlet_dispatch_line and
    // phoenix_count_outlet_stock each gain one new closed-vocabulary
    // p_reason_code parameter (validated, no free text); phoenix_dispense_outlet_stock
    // gets a hardcoded 'dispensed' reason_code; phoenix_send_outlet_return_shipment_line
    // propagates an already-closed v_line.reason_code. Chaining uses
    // dispatch_line_id and original_inbound_movement_id, both pre-existing
    // columns -- no ALTER TABLE anywhere in 131. Also fixes
    // phoenix_send_warehouse_dispatch (070, a genuine gap found while
    // verifying this slice, not one of the 20 originally audited writers)
    // with a hardcoded 'transferred' reason_code and a fresh correlation_id
    // per dispatch line -- again no sequence, no document number, nothing
    // client-computed. The ceiling moves to 132.
    // 132 (MOVEMENT-REASON-CODE-GROUP-G-QUARANTINE-132) adds NO document
    // numbering either -- phoenix_release_quarantine_stock and
    // phoenix_destroy_quarantine_stock each get reason_code wired from the
    // already-locked v_q.quarantine_reason (no new parameter, no free-text
    // mapping), and chain correlation_id/causation_id from the most recent
    // PRIOR movement against the same quarantine lot (a real, queryable
    // predecessor row id, never a sequence or document number). No ALTER
    // TABLE, no DROP FUNCTION, no signature change anywhere in 132. The
    // ceiling moves to 133.
    // 133 (MOVEMENT-REASON-CODE-GROUP-H-CORRECTION-APPROVAL-133) adds NO
    // document numbering either -- phoenix_approve_outlet_stock_correction
    // and phoenix_approve_warehouse_stock_correction each get a fixed
    // reason_code='corrected' literal (not client-derived) and chain
    // correlation_id/causation_id from the most recent PRIOR movement
    // against the exact stock row being corrected (a real, queryable
    // predecessor row id, never a sequence or document number). No ALTER
    // TABLE, no DROP FUNCTION, no signature change, no GRANT anywhere in
    // 133 -- the LAST of the 8 reason_code/correlation domain slices. The
    // ceiling moves to 134.
    // 134 (MOVEMENT-DISPENSE-CONTEXT-134) adds a new table
    // (phoenix_movement_dispense_context) whose primary key is
    // gen_random_uuid() -- no sequence, no client-computed identifier, no
    // document/official number of any kind. The three new RPCs
    // (record/get/export) never accept a client-supplied id/number either
    // -- request_id is only ever used for idempotency fingerprinting, the
    // same pattern as every writer RPC audited so far. The ceiling moves
    // to 135.
    // 135 (MOVEMENT-REASON-CODE-GROUP-I-OUTLET-RETURN-RECEIVE-135) adds NO
    // document numbering either -- it adds ONE nullable FK column
    // (outlet_return_shipment_lines.source_movement_id, a real movement row
    // id, never a sequence) and wires reason_code + correlation/causation
    // into phoenix_receive_outlet_return_shipment_line, the live writer the
    // completeness guard discovered was never in the original audit of 20.
    // No sequence, no document number, nothing client-computed. The ceiling
    // moves to 136.
    // 136 (DISPENSE-WITH-CONTEXT-ATOMIC-136) adds NO document numbering
    // either -- one closed-vocabulary column (patient_reference_type:
    // chart/card/pass, a document KIND, never an allocated number) and an
    // orchestration RPC that composes two already-reviewed writers. The
    // patient reference NUMBER it records is an EXTERNAL, operator-read
    // hospital document reference -- exactly the mv_external_reference
    // category this guard already protects -- never a serial this system
    // allocates. No sequence, nothing client-computed. Ceiling moves to 137.
    // 137 (FIVE-ROLE-CUTOVER-PORTS-VIEW-GAP-137) adds NO document numbering
    // either -- it is a pure role_permission_defaults grant (ports.view for
    // outlet_officer/central_warehouse_manager), the RBAC gap a real
    // authenticated browser session found blocking Outlet Operations from
    // ever resolving an outlet_officer's own scoped outlet. No new table,
    // no sequence, no document/official number of any kind. Ceiling moves
    // to 138.
    // 138 (MOVEMENT-LEDGER-REPORT-138) adds NO document numbering either --
    // it is a read-only, paginated SELECT-shaped RPC over the three existing
    // ledgers plus a location-name join. No table, sequence, or allocator of
    // any kind. Ceiling moves to 139.
    // 139 (MOVEMENT-TIMELINE-CONTRACT-FIELDS-139) adds NO document numbering
    // either -- it only widens an existing read-only RPC's emitted JSON with
    // contract fields the ledgers already store. No table, sequence, or
    // allocator. Ceiling moves to 140.
    // 140 (PHOENIX-DEMO-DATASET-MANIFEST-140) adds NO document numbering --
    // an ownership manifest keyed by (dataset_key, table_name, row_id uuid)
    // plus register/summary/purge RPCs. No sequence, no document string.
    // Ceiling moves to 141.
    // 141 (PHOENIX-DEMO-IMMUTABLE-EXEMPTION-141) adds NO document numbering --
    // a write-once demo marker column, a NOLOGIN owner role, a reviewed FK
    // preflight and a scoped delete exemption. No sequence, no allocator.
    // Ceiling moves to 142.
    // 142 (PHOENIX-DEMO-PROFILE-DETACH-142) adds NO document numbering --
    // a write-once profile marker and a detach routine. Ceiling -> 143.
    // 143 (PHOENIX-DEMO-PURGE-RESTRICT-VIOLATION-AND-ORDERING-143) adds NO
    // document numbering -- it broadens phoenix_demo_purge's exception
    // handling (foreign_key_violation OR restrict_violation, two SQLSTATEs
    // Postgres raises for a blocked RESTRICT-FK delete) and reorders
    // phoenix_demo_purgeable_tables() so every child precedes a RESTRICT-FK
    // parent it references. No sequence, no allocator, no document string.
    // Ceiling -> 144.
    // 144 (PHOENIX-DEMO-AVAILABILITY-PURGE-EXEMPTION-144) adds NO document
    // numbering -- one narrow, additive DELETE exemption on
    // trg_guard_availability_source_kind (065) for the demo purger's
    // existing ownership boundary. No sequence, no allocator. Ceiling -> 145.
    // 145 (PHOENIX-DEMO-ORGANIZATION-WATERMARK-145) adds NO document
    // numbering -- one read-only boolean RPC (is this organization id
    // registered in the demo manifest?) for frontend watermarking. No
    // sequence, no allocator, no document string. Ceiling -> 146.
    // 146 (SECURE-USER-PROVISIONING-146) adds NO document numbering -- it
    // replaces an authenticated profile UPSERT with a service-only,
    // nonce-bound, UPDATE-only account-provisioning contract. No sequence,
    // allocator, or document string. Ceiling -> 147.
    // 147 (SECURE-USER-DELETE-HISTORY-GUARD-147) adds NO document numbering
    // -- it extends phoenix_lifecycle_reserve with an operational-history
    // check (EXISTS across movement/request/approval tables) before allowing
    // a hard delete. No sequence, allocator, or document string of any kind.
    // Ceiling -> 148.
    // 148 (TRANSFER-SUGGESTION-DRAFT-BRIDGE-148, renumbered from 147 to make
    // room for master's SECURE-USER-DELETE-HISTORY-GUARD-147) adds NO new
    // document numbering -- phoenix_create_transfer_draft_from_suggestion's
    // p_document_number is an OPERATOR-TYPED value passed straight through
    // to the EXISTING request_number/dispatch_number/return_number
    // parameters 068/070/071 already require from a human caller; no new
    // sequence, no server-side allocator, no client-computed identifier of
    // any kind is introduced by this migration. Ceiling -> 149.
    // 149 (INVENTORY-SUGGESTION-LINEAGE-COMMITMENTS-149) adds lineage and
    // derived commitment accounting around those same existing transfer
    // documents. It introduces no sequence, allocator, or document number.
    // Ceiling -> 150.
    // 150 adds canonical material/lot identity and does not allocate or
    // synthesize any movement document number. Ceiling -> 151.
    // 151 changes only the scoped authorization gate around the existing
    // operator-supplied Draft bridge number. Ceiling -> 152.
    // 152 adds only the server-backed suggestion action read model; it
    // allocates no document number and creates no sequence. Ceiling -> 153.
    // 153 only retires EXECUTE on the legacy exchange status writer. It
    // creates no function, sequence, allocator, or document number.
    // Ceiling -> 154.
    // 154 (TRANSFER-CORRIDOR-PRIVILEGE-LOCKDOWN-154) adds NO document
    // numbering -- it is a pure REVOKE of INSERT/UPDATE/DELETE/TRUNCATE/
    // TRIGGER/REFERENCES on four existing transfer-corridor tables
    // (warehouse_transfer_requests/_lines, warehouse_transfers/_lines) from
    // authenticated/anon/PUBLIC. No function, sequence, allocator, or
    // document string of any kind is created, touched, or referenced.
    // Ceiling -> 155.
    // 155 (TRANSFER-SEND-RECEIVE-LIFECYCLE-NOTIFICATIONS-155) adds NO
    // document numbering -- it redefines phoenix_capture_lifecycle_event()
    // (an existing 082/094 trigger function) to also read the EXISTING
    // transfer_number column (created by 068, populated by the operator at
    // SEND time, already a required NOT NULL parameter of
    // phoenix_send_direct_warehouse_transfer_line) into its notification
    // label, and attaches that same trigger to warehouse_transfers. No new
    // sequence, allocator, or server/client-computed identifier of any kind
    // is introduced. Ceiling -> 156.
    // 156 (OUTLET-RETURN-LINE-IDEMPOTENCY-156) adds NO document numbering --
    // p_request_id is a caller-derived IDEMPOTENCY key (operation-token.ts),
    // never a document/reference number of any kind, and is stored only in
    // the new phoenix_outlet_return_line_requests dedup ledger, never
    // surfaced as a document identifier. Ceiling -> 157.
    // 157 (OUTLET-RETURN-EXCEPTION-RESOLUTION-157) adds NO document
    // numbering -- p_request_id is a caller-derived IDEMPOTENCY key, never a
    // document/reference number, stored only in the new
    // phoenix_outlet_return_exception_resolutions ledger. Ceiling -> 158.
    // 158 (TRANSACTIONAL-OUTBOX-FOUNDATION-158) adds NO document numbering --
    // event_key is a producer-supplied deterministic idempotency key (D2-1
    // architecture audit), never a document/reference number of any kind,
    // and no trigger or business writer references this migration's table
    // or helper yet (foundation only). Ceiling -> 159.
    // 159 (LIFECYCLE-OUTBOX-PRODUCER-159) adds NO document numbering --
    // it redefines phoenix_capture_lifecycle_event() to additionally append
    // one outbox event per accepted transition, keyed by 'lifecycle:' plus
    // the SAME pre-existing dedupe_key (NEW.id::text || ':' || status) —
    // an idempotency key over already-existing values, never a new document/
    // reference number of any kind. Ceiling -> 160.
    // 160 (DEMO-PURGE-OUTBOX-COMPATIBILITY-160) adds NO document numbering
    // at all -- it only redefines phoenix_demo_purgeable_tables() (143), a
    // pure table-name array with no numbering concept of any kind. Ceiling -> 161.
    // 161 (MOVEMENT-OUTBOX-PRODUCER-161) adds NO document numbering -- it
    // redefines phoenix_capture_movement_posted() to additionally append one
    // outbox event per accepted movement, keyed by 'movement:' plus the SAME
    // pre-existing dedupe_key (NEW.id::text || ':posted') -- an idempotency
    // key over an already-existing value, never a new document/reference
    // number of any kind. Ceiling -> 162.
    // 162 (STOCKTAKE-AND-EXCEPTION-OUTBOX-PRODUCERS-162) adds NO document
    // numbering -- it redefines phoenix_capture_stocktake_recorded() and
    // phoenix_resolve_outlet_return_exception(...) to additionally append
    // outbox events keyed by 'stocktake:' plus the SAME pre-existing
    // dedupe_key, and by 'outlet-return-exception-resolution:' plus the
    // RPC's own already-existing p_request_id -- idempotency keys over
    // already-existing/already-caller-supplied values, never a new
    // document/reference number of any kind. Ceiling -> 163.
    // 163 (OUTBOX-CONSUMER-STATE-FOUNDATION-163) adds NO document numbering
    // -- it adds two new tables (a consumer registry and a per-consumer
    // delivery-state machine) and four internal claim/complete/fail/release
    // functions. lease_owner_token is a caller-supplied lease-ownership
    // token (a distributed-lock/idempotency handle, exactly like every
    // other request-id/idempotency key this guard already excludes above),
    // never a document/reference number of any kind, and delivery_state
    // rows are never surfaced as a document identifier anywhere. Ceiling ->
    // 164.
    // 164 (FACILITY-IDENTITY-AND-ROUTING-FOUNDATION-164) adds NO document
    // numbering -- it is Stage E's metadata foundation: two classification
    // columns (organizations.institution_class,
    // distribution_points.clinical_location_kind), one nullable link column
    // (warehouses.facility_id), and two tables (organization_facilities,
    // outlet_replenishment_routes). Neither table carries a document,
    // reference, dispatch, transfer, return or shipment number, and neither
    // is ever surfaced as a document identifier. The one identifier-shaped
    // column, organization_facilities.code, is an OPTIONAL, caller-supplied
    // administrative label unique per organization -- exactly the shape of
    // the long-existing organizations.code (001) and warehouses.code, never
    // generated, never sequential, and never a movement/document number. No
    // sequence, no counter, no max()+1, and no generated numeric identity is
    // introduced anywhere in the migration. Ceiling -> 165.
    // 165 (SECTOR-HEALTH-CENTER-SUPPLY-AND-RETURN-165) adds NO document
    // numbering -- it is exactly two CREATE OR REPLACE statements over the two
    // existing direct-corridor endpoint validators
    // (phoenix_assert_direct_supply_endpoints /
    // phoenix_assert_direct_return_endpoints), each gaining one narrow,
    // facility-pinned branch. It creates no table, no column, no sequence, no
    // counter, no max()+1 and no generated identity of any kind, and it reads
    // only warehouse_kind/status/facility_id/institution_class plus the
    // pre-existing warehouse_transfers provenance row. Every transfer, return
    // and shipment number it interacts with is caller-supplied exactly as
    // before. Ceiling -> 166.
    // 166 (INITIAL-PROVISIONING-INVARIANT-166) adds NO document numbering. It
    // adds two FLAG columns to warehouse_dispatches (is_initial_provisioning
    // boolean, initial_provisioning_consumed_at timestamptz), one CHECK, one
    // partial unique index keyed on destination_distribution_point_id, one new
    // RPC that DELEGATES creation to the existing
    // phoenix_create_warehouse_dispatch (070), and one CREATE OR REPLACE of the
    // 149 receive wrapper. Neither column is an identifier: one is a boolean
    // marker, the other a consumption timestamp. No sequence, no counter, no
    // max()+1 and no generated numeric identity is introduced, and the
    // dispatch_number every path uses remains caller-supplied exactly as
    // before -- the new RPC forwards p_dispatch_number to 070 untouched.
    // Ceiling -> 167.
    // 167 (DISPATCH-LINE-FULL-REJECTION-RECONCILIATION-167) adds NO document
    // numbering — it reconciles one existing CHECK constraint branch
    // (warehouse_dispatch_lines_decision_chk's 'rejected' case) to match the
    // receive writer's own long-standing received_quantity = 0, and backfills
    // any legacy NULL-quantity rejected row to the same value. It creates no
    // table, no column, no sequence, no counter, no max()+1 and no generated
    // numeric identity of any kind, and it replaces no function — the receive
    // RPC and its 149 delegate are byte-for-byte unchanged. 167 was authored
    // on its own branch concurrently with 166 and is independent of it — it
    // neither reads nor writes anything 166 creates. Both are now reviewed
    // and registered in their real numeric order. The ceiling moves to 168.
    // 168 (ATOMIC-EMERGENCY-OUTLET-REPLENISHMENT-168) adds replenish_send /
    // replenish_receive movement types and the atomic E-5 RPC, but introduces
    // no client-side document numbering, sequence, counter, or max()+1.
    // 169 (OUTLET-REPLENISHMENT-REVERSAL-169) adds the E-6 reversal once-index,
    // a read-only reversible-batches helper, and the atomic reversal RPC. It
    // reuses returned_quantity (071) as the reversal cap and creates no
    // document numbering, sequence, counter, or max()+1 of any kind.
    // 170 (ORGANIZATION-CLASS-AND-WAREHOUSE-FACILITY-ASSIGNMENT-170, Stage E ·
    // E7-1) adds ONE NOT NULL column alteration (organizations.institution_class),
    // two triggers, and two new functions (an immutability guard on
    // organizations, a hard operational-dependency guard + assignment RPC on
    // warehouses.facility_id). None of it is a document/movement number: the
    // trigger functions inspect OLD/NEW column values and the RPC forwards a
    // caller-supplied facility_id verbatim. No sequence, no counter, no
    // max()+1, and no generated numeric identity of any kind is introduced.
    // Ceiling moves to 171.
    // 171 (ORGANIZATION-KIND-AND-PHARMACY-DEPARTMENT-AUTHORITY-171, Stage E ·
    // E7-1 follow-up) adds ONE new column (organizations.organization_kind,
    // a 2-value discriminator), relaxes institution_class back to nullable,
    // two new CHECK constraints, and three new trigger functions (an
    // immutability guard on organization_kind, a one-way warehouse-ownership
    // guard, and a distribution_point-ownership guard). None of it is a
    // document/movement number: organization_kind is a fixed 2-value
    // enum-like classifier (care_institution | pharmacy_department_authority),
    // not an identifier; every trigger inspects OLD/NEW column values or
    // performs an EXISTS check, never allocates one. No sequence, no counter,
    // no max()+1, and no generated numeric identity of any kind is
    // introduced. Ceiling moves to 172.
    // 172 (PATIENT-DISPENSING-CONTRACT-172, Stage F) adds NO column, NO table
    // and NO identifier of any kind. It adds one internal eligibility oracle
    // plus one read-only advisory (both DERIVE an allowed document-type SET
    // from existing canonical columns), replaces two existing writer bodies so
    // they refuse retired vocabulary, and adds one BEFORE INSERT guard
    // trigger. patient_reference_type is a fixed 2-value document CLASSIFIER
    // (card | chart), not an identifier; the patient reference NUMBER is
    // caller-supplied text read off a physical document and is never
    // allocated, incremented or derived here. No sequence, no counter, no
    // max()+1, and no generated numeric identity of any kind is introduced.
    // Ceiling moves to 173.
    const beyond = migrations.filter(f => /^(17[3-9]|1[89]\d|[2-9]\d\d)_/.test(f));
    expect(beyond).toEqual([]);
    expect(migrations).toContain('172_phoenix_patient_dispensing_contract.sql');
    expect(migrations).toContain('167_phoenix_dispatch_line_full_rejection_reconciliation.sql');
    expect(migrations).toContain('168_phoenix_atomic_emergency_outlet_replenishment.sql');
    expect(migrations).toContain('169_phoenix_outlet_replenishment_reversal.sql');
    expect(migrations).toContain('170_phoenix_organization_class_and_warehouse_facility_assignment.sql');
    expect(migrations).toContain('171_phoenix_organization_kind_pharmacy_department_authority.sql');
    expect(migrations).toContain('149_phoenix_inventory_suggestion_lineage_commitments.sql');
    expect(migrations).toContain('150_phoenix_material_identity_fefo_provenance_hardening.sql');
    expect(migrations).toContain('151_phoenix_suggestion_route_policy_gates.sql');
    expect(migrations).toContain('152_phoenix_suggestion_action_read_model.sql');
    expect(migrations).toContain('153_phoenix_retire_inter_org_exchange_status_writer.sql');
    expect(migrations).toContain('154_phoenix_transfer_corridor_privilege_lockdown.sql');
    expect(migrations).toContain('155_phoenix_transfer_send_receive_lifecycle_notifications.sql');
    expect(migrations).toContain('156_phoenix_outlet_return_line_idempotency.sql');
    expect(migrations).toContain('157_phoenix_outlet_return_exception_resolution.sql');
    expect(migrations).toContain('158_phoenix_transactional_outbox_foundation.sql');
    expect(migrations).toContain('159_phoenix_lifecycle_outbox_producer.sql');
    expect(migrations).toContain('160_phoenix_demo_purge_outbox_compatibility.sql');
    expect(migrations).toContain('161_phoenix_movement_outbox_producer.sql');
    expect(migrations).toContain('162_phoenix_stocktake_and_exception_outbox_producers.sql');
    expect(migrations).toContain('163_phoenix_outbox_consumer_foundation.sql');
    expect(migrations).toContain('088_phoenix_canonical_supply_provenance.sql');
    // 089 allocates SERVER-side numbers (SP-/PR- sequences inside a SECURITY
    // DEFINER RPC) — exactly the safe direction; no client numbering exists.
    expect(migrations).toContain('089_phoenix_subpurchase_direct_entry.sql');
    // 090 stamps SERVER-side official numbers (WR-/WA- via a sequence inside a
    // BEFORE INSERT trigger) — again the safe direction; no client numbering.
    expect(migrations).toContain('090_phoenix_warehouse_receipt_official_number.sql');
    expect(migrations).toContain('091_phoenix_five_role_cutover.sql');
    expect(migrations).toContain('092_phoenix_monthly_status_redesign.sql');
    expect(migrations).toContain('093_phoenix_super_admin_lifecycle_guard.sql');
    expect(migrations).toContain('094_phoenix_custody_chain_notifications.sql');
    expect(migrations).toContain('095_phoenix_return_availability_cap.sql');
    expect(migrations).toContain('096_phoenix_bulk_receive_matching_dispatch_lines.sql');
    expect(migrations).toContain('097_phoenix_fefo_reasoned_override.sql');
    expect(migrations).toContain('098_phoenix_second_person_correction_approval.sql');
    expect(migrations).toContain('099_phoenix_notification_wiring_and_quarantine_disposition.sql');
    expect(migrations).toContain('100_phoenix_bulk_receive_remaining_corridors.sql');
    expect(migrations).toContain('101_phoenix_warehouse_second_person_correction_approval.sql');
    expect(migrations).toContain('102_phoenix_transfer_send_fefo_guarded.sql');
    expect(migrations).toContain('103_phoenix_institution_warehouse_no_direct_entry.sql');
    expect(migrations).toContain('104_phoenix_return_quarantine_insert_column_fix.sql');
    expect(migrations).toContain('105_phoenix_quarantine_read_policy_disposition_parity.sql');
    expect(migrations).toContain('106_phoenix_dispatch_line_idempotency.sql');
    expect(migrations).toContain('107_phoenix_dispatch_line_request_id_required.sql');
    expect(migrations).toContain('108_phoenix_custody_chain_direct_write_lockdown.sql');
    expect(migrations).toContain('109_phoenix_public_schema_default_privileges_lockdown.sql');
    expect(migrations).toContain('110_phoenix_paper_reference_contract.sql');
    expect(migrations).toContain('111_phoenix_threshold_batch_apply.sql');
    expect(migrations).toContain('112_phoenix_status_classification_boundary_correction.sql');
    expect(migrations).toContain('113_phoenix_monthly_status_direct_write_lockdown.sql');
    expect(migrations).toContain('118_phoenix_central_intake_manual_identity.sql');
    expect(migrations.some(f => /document_number|sequence/i.test(f))).toBe(false);
  });
});

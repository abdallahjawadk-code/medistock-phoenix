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
    const beyond = migrations.filter(f => /^(10[6-9]|1[1-9]\d|[2-9]\d\d)_/.test(f));
    expect(beyond).toEqual([]);
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
    expect(migrations.some(f => /document_number|sequence/i.test(f))).toBe(false);
  });
});

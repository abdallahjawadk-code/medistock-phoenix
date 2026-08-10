/**
 * MOVEMENT-COMPOSER-A — client-side numbering guard.
 *
 * The frontend must never invent an authoritative-looking movement sequence.
 * Historical migration prose was intentionally compacted here; assertions are
 * preserved and the future ceiling remains fail-closed by exact migration name.
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
    expect(() => buildMovementQrPayload('supply_dispatch', 'SUP-DSP-2026-000001')).toThrow();
    expect(() => buildMovementQrPayload('supply_dispatch', '1')).toThrow();
  });

  it('operator-typed numbers are labelled as external references, not serials', () => {
    const strings = readFileSync(join(ROOT, 'src', 'shared', 'i18n', 'strings.ts'), 'utf8');
    expect(strings).toContain('mv_external_reference');
    expect(strings).toContain('Official letter / external document number');
    expect(strings).toContain('رقم الكتاب أو المستند الخارجي');
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

    // 174 is ACL-only hardening; any unreviewed 175+ migration still fails.
    const beyond = migrations.filter(f => /^(17[5-9]|1[89]\d|[2-9]\d\d)_/.test(f));
    expect(beyond).toEqual([]);
    expect(migrations).toContain('174_phoenix_authenticated_rpc_surface_hardening.sql');
    expect(migrations).toContain('173_phoenix_database_security_surface_hardening.sql');
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
    expect(migrations).toContain('089_phoenix_subpurchase_direct_entry.sql');
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

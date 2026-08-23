/**
 * MOVEMENT-COMPOSER-A — client-side numbering guard.
 * The frontend must never invent an authoritative-looking movement sequence.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const MOVEMENT_DIR = join(ROOT, 'src', 'features', 'movement');
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[]=[];
  for(const entry of readdirSync(dir,{withFileTypes:true})){
    const full=join(dir,entry.name);
    if(entry.isDirectory()) out.push(...walk(full));
    else if(/\.tsx?$/.test(entry.name)&&!full.includes('__tests__')) out.push(full);
  }
  return out;
}
const sources=walk(MOVEMENT_DIR).map(f=>({file:f.replace(ROOT,'.'),text:readFileSync(f,'utf8')}));

describe('no client-side document-number sequence exists',()=>{
  it('has movement source files to scan',()=>expect(sources.length).toBeGreaterThan(0));
  it('never derives a document number from MAX()+1 or a row count',()=>{
    for(const {file,text} of sources){
      expect(text,file).not.toMatch(/Math\.max\([^)]*\)\s*\+\s*1/);
      expect(text,file).not.toMatch(/\.length\s*\+\s*1\s*[;,)]/);
      expect(text,file).not.toMatch(/last(Number|Value)\s*\+\s*1/i);
    }
  });
  it('never builds a document number from timestamp/random',()=>{
    for(const {file,text} of sources) expect(text,file).not.toMatch(/(?:requestNumber|transferNumber|returnNumber|shipmentNumber|documentNumber|serial)\s*[=:]\s*[^;\n]*(?:Date\.now\(\)|Math\.random\(\))/i);
  });
  it('never persists/reads a numbering counter from storage',()=>{
    for(const {file,text} of sources) expect(text,file).not.toMatch(/(?:localStorage|sessionStorage)[^;\n]*(?:number|serial|sequence|counter)/i);
  });
  it('QR trace key refuses non-uuid values',async()=>{
    const {buildMovementQrPayload}=await import('../movement-trace');
    expect(()=>buildMovementQrPayload('supply_dispatch','SUP-DSP-2026-000001')).toThrow();
    expect(()=>buildMovementQrPayload('supply_dispatch','1')).toThrow();
  });
  it('operator typed numbers remain external references',()=>{
    const strings=readFileSync(join(ROOT,'src','shared','i18n','strings.ts'),'utf8');
    expect(strings).toContain('mv_external_reference');
    expect(strings).toContain('Official letter / external document number');
    expect(strings).toContain('رقم الكتاب أو المستند الخارجي');
  });
  it('numbering proposal exists and is not applied',()=>{
    const proposal=join(ROOT,'docs','phoenix','proposals','sequential-document-numbers.md');
    expect(existsSync(proposal)).toBe(true);
    const text=readFileSync(proposal,'utf8');
    expect(text).toMatch(/PROPOSAL ONLY/i); expect(text).toMatch(/not applied/i);
  });
  it('179–198 introduce no numbering and no 199+ migration exists',()=>{
    const migrations=readdirSync(join(ROOT,'supabase','migrations')).filter(f=>f.endsWith('.sql'));
    // P0 HOTFIX 178: adds SECURITY DEFINER to Migration 171's outlet
    // owner-kind guard so its FOR SHARE row lock stops failing with 42501 for
    // callers holding only SELECT on warehouses. One function attribute: no
    // sequence, no counter, no max()+1, no generated numeric identity, no
    // document number of any kind.
    // STAGE-G-G2: 177 replaces get_public_qr_payload's body so physical
    // quantity/condition derive from outlet_stock instead of the
    // item_availability cache. It is a READ cutover: no sequence, no counter,
    // no max()+1, no generated numeric identity — the only counter it touches
    // is qr_tokens.scan_count, which is pre-existing scan accounting and not a
    // document number.
    // STAGE-G-G3.1: 179 replaces phoenix_outlet_availability_read_model's body
    // so physical rows group on outlet_stock.material_identity_key (Migration
    // 150's GENERATED column) instead of raw material columns, and publishes an
    // additive row-level unit. Its only derived value is a row_key that is a
    // LOSSLESS encoding of already-persisted canonical identity — a pure
    // function of existing data, not a sequence, counter, max()+1 or generated
    // numeric identity, and never a document number.
    // R1.2: 180 separates ordinary from initial-provisioning dispatch
    // authority. It moves migration 070's creator body into one trusted
    // internal core and adds an emergency-outlet corridor refusal. It creates
    // no table, column, sequence, counter, max()+1 or generated numeric
    // identity, and the dispatch number stays exactly what it always was — a
    // caller-supplied text the core only trims and requires to be non-empty.
    // R1.1: 181 reconciles health-sector topology and installs shape guards. It
    // creates no table, sequence, counter, max()+1 or generated numeric
    // identity, and no document number of any kind — the only value it
    // generates is a warehouse UUID from the column default.
    // R1.1-U: 182 adds the facility-scoped RBAC surface — a nullable uuid
    // column, constraints, an index, RLS predicates and authorization helpers.
    // It creates no table, sequence, counter, max()+1 or generated numeric
    // identity, and no document number of any kind; its only generated value is
    // an assignment UUID from the column default.
    // R1.2C: 183 states the active-outlet topology matrix once, in one
    // validator, and calls it from the distribution_points write boundary and
    // Migration 180's initial-provisioning entry point. It creates no table,
    // sequence, counter, max()+1 or generated numeric identity, and no document
    // number of any kind — the dispatch number it passes through stays exactly
    // what 180 made it, a caller-supplied text.
    // R1.3: 184 narrows the two direct-corridor endpoint validators and the
    // local-procurement root, and re-asserts 153's revoke on the retired
    // exchange writer. It creates no table, sequence, counter, max()+1 or
    // generated numeric identity, and no document number of any kind — the
    // transfer and order numbers it passes through stay exactly what 077 and
    // 087 made them, caller-supplied text.
    // R1.5: 185 forward-replaces the return-review caps, the quarantine release
    // path and the recall entry points, and adds the provenance-anchored recall
    // selectors. It creates no table, sequence, counter, max()+1 or generated
    // numeric identity, and no document number of any kind — every return number
    // it handles is caller-supplied text it only btrim()s and matches on.
    // R1.6: 186 forward-replaces two correction wrappers. It creates no table,
    // sequence, counter, max()+1 or generated numeric identity.
    // 187: delegated operational access creates no numbering.
    // M188: public QR facility context is a security-hardening READ cutover of
    // 177's public resolver. It creates no table, sequence, counter, max()+1 or
    // generated numeric identity, and no document number of any kind.
    // G3.3 / M189: inter-org alert canonical identity forward-replaces the two
    // live inter-institution alert RPCs and adds one shared read bridge that
    // resolves item_availability rows to Migration 150's canonical
    // material_identity_key. Every value it produces is a pure function of
    // already-persisted data — no table, sequence, counter, max()+1 or generated
    // numeric identity, and no document number of any kind. The alert_key it
    // still composes is the pre-existing 039 shape, a concatenation of two row
    // UUIDs and the alert type, never a counted or issued number. Boundary moves
    // to 189 so the next unknown migration still fails closed.
    // G4.1 / M190: the inter-org alert CQRS boundary ADDS one explicit refresh
    // command and two PURE query RPCs beside 189's surface, and changes nothing
    // that already existed. Its only derived value is 039's pre-existing
    // alert_key — a concatenation of two row UUIDs and the alert type — plus
    // 048's expiry-risk tier, both pure functions of already-persisted data. No
    // table, sequence, counter, max()+1 or generated numeric identity, and no
    // document number of any kind. Boundary moves to 192 so the next unknown
    // migration still fails closed.
    // H UNIT 1 / M193: the alert command-surface hardening performs exactly
    // one ALTER FUNCTION (a SECURITY DEFINER flip) and two REVOKEs. It creates
    // no table, sequence, counter, max()+1 or generated numeric identity, and
    // no document number of any kind — it introduces no SQL object at all.
    // Boundary moves to 193 so the next unknown migration still fails closed.
    // H UNIT 2A / M194: the authorization-surface reproducibility convergence
    // is pure GRANT/REVOKE. It creates no table, sequence, counter, max()+1 or
    // generated numeric identity, and no document number of any kind — it
    // introduces no SQL object at all. Boundary moves to 194 so the next
    // unknown migration still fails closed.
    // H UNIT 4 / M195: schema-qualifies `profiles` to `public.profiles` inside
    // the two existing SECURITY DEFINER identity helpers (phoenix_my_role,
    // phoenix_my_org) and changes nothing else. It creates no sequence, no
    // counter, no max()+1 logic, no generated numeric identity and no document
    // number — it introduces no SQL object at all. Boundary moves to 195 so the
    // next unknown migration still fails closed.
    // I-3 / M196: schema-qualifies the 106 audited relation references inside
    // exactly 22 existing SECURITY DEFINER functions. It creates no table,
    // sequence, counter, max()+1 logic, generated numeric identity or document
    // number — it only replaces function bodies. Boundary moves to 196 so the
    // next unknown migration still fails closed.
    // I-4 / M197: converges PUBLIC EXECUTE on six SECURITY DEFINER routines
    // into explicit role grants. It is ACL-only — no table, sequence,
    // counter, max()+1 logic, generated identity or document number, and no
    // function body at all.
    // I-5 / M198: converges the function-level search_path of thirty SECURITY
    // DEFINER routines from `public` to `public, pg_temp`. It is
    // search_path-only — one ALTER FUNCTION per target, no table, sequence,
    // counter, max()+1 logic, generated identity, document number or function
    // body. Boundary moves to 198 so the next unknown migration still fails
    // closed.
    const beyond=migrations.filter(f=>/^(1[89]\d|[2-9]\d\d)_/.test(f)&&!/^(179|180|181|182|183|184|185|186|187|188|189|190|191|192|193|194|195|196|197|198)_/.test(f));
    expect(beyond).toEqual([]);
    for(const f of [
      '198_phoenix_secdef_search_path_convergence.sql',
      '197_phoenix_public_execute_convergence.sql',
      '196_phoenix_secdef_relation_schema_qualification.sql',
      '195_phoenix_auth_helper_profile_schema_qualification.sql',
      '194_phoenix_authorization_surface_reproducibility_convergence.sql',
      '193_phoenix_inter_org_alert_command_surface_hardening.sql',
      '191_phoenix_canonical_scope_topology_read_contract.sql',
      '192_phoenix_anonymous_read_surface_convergence.sql',
      '190_phoenix_inter_org_alert_cqrs_boundary.sql',
      '189_phoenix_inter_org_alert_canonical_identity.sql',
      '188_phoenix_public_qr_facility_context.sql',
      '187_phoenix_delegated_operational_access.sql',
      '186_phoenix_correction_reason_code_wrapper_parity.sql',
      '185_phoenix_return_quarantine_recall_parity.sql',
      '184_phoenix_canonical_supply_cycle.sql',
      '183_phoenix_emergency_outlet_integrity.sql',
      '182_phoenix_health_center_facility_scoped_rbac.sql',
      '181_phoenix_health_sector_topology_reconciliation.sql',
      '180_phoenix_emergency_initial_provisioning_boundary.sql',
      '179_phoenix_canonical_authenticated_availability_hardening.sql',
      '178_phoenix_distribution_point_owner_guard_privilege_fix.sql',
      '177_phoenix_canonical_public_qr.sql',
      '176_phoenix_canonical_outlet_availability_read_model.sql',
      '175_phoenix_read_helper_anonymous_surface_hardening.sql',
      '174_phoenix_authenticated_rpc_surface_hardening.sql',
      '173_phoenix_database_security_surface_hardening.sql',
      '172_phoenix_patient_dispensing_contract.sql',
      '167_phoenix_dispatch_line_full_rejection_reconciliation.sql',
      '168_phoenix_atomic_emergency_outlet_replenishment.sql',
      '169_phoenix_outlet_replenishment_reversal.sql',
      '170_phoenix_organization_class_and_warehouse_facility_assignment.sql',
      '171_phoenix_organization_kind_pharmacy_department_authority.sql',
      '149_phoenix_inventory_suggestion_lineage_commitments.sql',
      '150_phoenix_material_identity_fefo_provenance_hardening.sql',
      '151_phoenix_suggestion_route_policy_gates.sql',
      '152_phoenix_suggestion_action_read_model.sql',
      '153_phoenix_retire_inter_org_exchange_status_writer.sql',
      '154_phoenix_transfer_corridor_privilege_lockdown.sql',
      '155_phoenix_transfer_send_receive_lifecycle_notifications.sql',
      '156_phoenix_outlet_return_line_idempotency.sql',
      '157_phoenix_outlet_return_exception_resolution.sql',
      '158_phoenix_transactional_outbox_foundation.sql',
      '159_phoenix_lifecycle_outbox_producer.sql',
      '160_phoenix_demo_purge_outbox_compatibility.sql',
      '161_phoenix_movement_outbox_producer.sql',
      '162_phoenix_stocktake_and_exception_outbox_producers.sql',
      '163_phoenix_outbox_consumer_foundation.sql',
      '088_phoenix_canonical_supply_provenance.sql','089_phoenix_subpurchase_direct_entry.sql','090_phoenix_warehouse_receipt_official_number.sql','091_phoenix_five_role_cutover.sql','092_phoenix_monthly_status_redesign.sql','093_phoenix_super_admin_lifecycle_guard.sql','094_phoenix_custody_chain_notifications.sql','095_phoenix_return_availability_cap.sql','096_phoenix_bulk_receive_matching_dispatch_lines.sql','097_phoenix_fefo_reasoned_override.sql','098_phoenix_second_person_correction_approval.sql','099_phoenix_notification_wiring_and_quarantine_disposition.sql','100_phoenix_bulk_receive_remaining_corridors.sql','101_phoenix_warehouse_second_person_correction_approval.sql','102_phoenix_transfer_send_fefo_guarded.sql','103_phoenix_institution_warehouse_no_direct_entry.sql','104_phoenix_return_quarantine_insert_column_fix.sql','105_phoenix_quarantine_read_policy_disposition_parity.sql','106_phoenix_dispatch_line_idempotency.sql','107_phoenix_dispatch_line_request_id_required.sql','108_phoenix_custody_chain_direct_write_lockdown.sql','109_phoenix_public_schema_default_privileges_lockdown.sql','110_phoenix_paper_reference_contract.sql','111_phoenix_threshold_batch_apply.sql','112_phoenix_status_classification_boundary_correction.sql','113_phoenix_monthly_status_direct_write_lockdown.sql','118_phoenix_central_intake_manual_identity.sql'
    ]) expect(migrations,f).toContain(f);
    expect(migrations.some(f=>/document_number|sequence/i.test(f))).toBe(false);
  });
});

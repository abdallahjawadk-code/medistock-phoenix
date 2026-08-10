/**
 * MIGRATION-GUARD-DERIVE-A — canonical migration-review manifest test.
 *
 * SECURITY MODEL
 * --------------
 * Review is exact-filename membership, never filesystem presence, numeric
 * ceiling, contiguity, prefix, range, wildcard, or regex acceptance.
 *
 * This file deliberately keeps an INDEPENDENT exact allowlist in addition to
 * helpers/reviewed-migrations.ts. The duplication is intentional: the helper
 * cannot self-approve a newly added filename. The tests below compare:
 *
 *   independent allowlist <-> registry <-> real migration directory
 *
 * in both directions, then exhaustively verify every derived `above()` and
 * `between()` slice. A new migration therefore requires an explicit exact-name
 * edit here and in the registry; merely placing SQL on disk cannot pass.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  REVIEWED_MIGRATION_FILES,
  extractMigrationNumber,
  findDuplicateReviewedFilenames,
  findDuplicateReviewedNumbers,
  findMalformedMigrationFiles,
  findMalformedReviewedFilenames,
  findMissingReviewedMigrationFiles,
  findUnreviewedMigrationFiles,
  getMaximumReviewedMigrationNumber,
  getNextUnreviewedMigrationNumber,
  isNumberedMigrationFile,
  isReviewedMigrationFile,
  reviewedMigrationFilesAbove,
  reviewedMigrationFilesBetween,
  sortMigrationFiles,
} from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');
const actualSqlFiles = (): string[] =>
  readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));

/**
 * Independent exact-filename oracle. NEVER derive this from the registry or
 * filesystem. This is the counter-gate that makes registry edits reviewable.
 */
const EXPECTED_REVIEWED_MIGRATION_FILES: readonly string[] = Object.freeze([
  '001_phoenix_core_schema.sql',
  '002_phoenix_rls_policies.sql',
  '003_phoenix_rpc_lifecycle.sql',
  '004_phoenix_seed_demo_data.sql',
  '005_phoenix_assign_profile_role.sql',
  '006_phoenix_status_reports.sql',
  '007_phoenix_clear_port_availability.sql',
  '008_phoenix_org_status_contacts.sql',
  '009_phoenix_inter_institution_alerts.sql',
  '010_phoenix_user_permission_matrix.sql',
  '011_phoenix_user_lifecycle_controls.sql',
  '012_phoenix_institution_admin_role.sql',
  '013_phoenix_user_identity_snapshot_foundation.sql',
  '014_phoenix_actor_snapshot_write_path_triggers.sql',
  '015_phoenix_user_account_recycling.sql',
  '016_phoenix_local_credentials_mode.sql',
  '017_phoenix_permission_rpc_42703_fix.sql',
  '018_phoenix_actor_snapshot_record_field_fix.sql',
  '019_phoenix_availability_editor_institution_ux.sql',
  '020_phoenix_availability_material_fields_and_status_editor.sql',
  '021_phoenix_ports_permissions_warehouse_retirement.sql',
  '022_phoenix_qr_permission_fix.sql',
  '023_phoenix_live_profile_role_resolution_fix.sql',
  '024_phoenix_distribution_points_rls_state_repair.sql',
  '025_phoenix_distribution_points_grants_fix.sql',
  '026_phoenix_qr_random_bytes_fix.sql',
  '027_phoenix_public_availability_privacy_hardening.sql',
  '028_phoenix_public_qr_expiry_scientific_name_fix.sql',
  '029_phoenix_availability_scientific_name_unique.sql',
  '030_phoenix_availability_upsert_rpc.sql',
  '031_phoenix_availability_upsert_rpc_port_name_fix.sql',
  '032_phoenix_availability_permission_matrix_integration.sql',
  '033_phoenix_availability_movements_schema.sql',
  '034_phoenix_apply_availability_movement_rpc.sql',
  '035_phoenix_upsert_quantity_hard_guard.sql',
  '036_phoenix_live_inter_institution_alerts_rpc.sql',
  '037_phoenix_live_alert_identifiers.sql',
  '038_phoenix_inter_org_alert_lifecycle_schema.sql',
  '039_phoenix_inter_org_alert_lifecycle_rpcs.sql',
  '040_phoenix_inter_org_exchange_schema.sql',
  '041_phoenix_inter_org_exchange_rpcs.sql',
  '042_phoenix_clear_port_availability_movement_safe.sql',
  '043_phoenix_fix_item_availability_unique_indexes.sql',
  '044_phoenix_profiles_whatsapp_phone.sql',
  '045_phoenix_update_my_whatsapp_phone_rpc.sql',
  '046_phoenix_set_my_org_whatsapp_contact_rpc.sql',
  '047_phoenix_live_alerts_contact_fields.sql',
  '048_live_alerts_expiry_risk_tiers.sql',
  '049_add_national_code_to_item_availability.sql',
  '050_phoenix_upsert_availability_national_code.sql',
  '051_material_batch_identity_option_a.sql',
  '052_qr_effective_condition_quantity_zero.sql',
  '053_item_availability_removed_marker.sql',
  '054_dashboard_condition_counts_rpcs.sql',
  '055_phoenix_clean_availability_data.sql',
  '056_phoenix_platform_broadcast_notices.sql',
  '057_phoenix_platform_broadcast_admin_details_delete.sql',
  '058_phoenix_public_qr_dosage_form.sql',
  '059_phoenix_public_qr_concentration.sql',
  '060_phoenix_warehouse_foundation.sql',
  '061_phoenix_warehouse_dispatch_schema.sql',
  '062_phoenix_user_rbac_scope_foundation.sql',
  '063_phoenix_rbac_security_hardening.sql',
  '064_fix_profile_identity_snapshot_return_type.sql',
  '065_phoenix_warehouse_truth_and_stock_rpcs.sql',
  '066_phoenix_inventory_network_expand.sql',
  '067_phoenix_outlet_stock_expand.sql',
  '068_phoenix_central_to_institution_supply.sql',
  '069_phoenix_institution_to_central_return.sql',
  '070_phoenix_institution_warehouse_outlet_dispatch.sql',
  '071_phoenix_outlet_to_institution_return.sql',
  '072_phoenix_inventory_intelligence.sql',
  '073_phoenix_fixed_near_expiry_policy.sql',
  '074_phoenix_warehouse_management_rpcs.sql',
  '075_phoenix_supply_route_rpcs.sql',
  '076_phoenix_profile_scope_assignment_rpcs.sql',
  '077_phoenix_direct_central_to_institution_supply.sql',
  '078_phoenix_warehouse_receipt_expected_generation.sql',
  '079_phoenix_warehouse_generation_fail_closed.sql',
  '080_phoenix_revoke_unguarded_warehouse_writers.sql',
  '081_phoenix_movement_timeline.sql',
  '082_phoenix_movement_event_capture.sql',
  '083_phoenix_inventory_derived_availability.sql',
  '084_phoenix_availability_visibility.sql',
  '085_phoenix_revoke_manual_availability_writers.sql',
  '086_phoenix_outlet_stock_correction_expected_generation.sql',
  '087_phoenix_institution_local_procurement.sql',
  '088_phoenix_canonical_supply_provenance.sql',
  '089_phoenix_subpurchase_direct_entry.sql',
  '090_phoenix_warehouse_receipt_official_number.sql',
  '091_phoenix_five_role_cutover.sql',
  '092_phoenix_monthly_status_redesign.sql',
  '093_phoenix_super_admin_lifecycle_guard.sql',
  '094_phoenix_custody_chain_notifications.sql',
  '095_phoenix_return_availability_cap.sql',
  '096_phoenix_bulk_receive_matching_dispatch_lines.sql',
  '097_phoenix_fefo_reasoned_override.sql',
  '098_phoenix_second_person_correction_approval.sql',
  '099_phoenix_notification_wiring_and_quarantine_disposition.sql',
  '100_phoenix_bulk_receive_remaining_corridors.sql',
  '101_phoenix_warehouse_second_person_correction_approval.sql',
  '102_phoenix_transfer_send_fefo_guarded.sql',
  '103_phoenix_institution_warehouse_no_direct_entry.sql',
  '104_phoenix_return_quarantine_insert_column_fix.sql',
  '105_phoenix_quarantine_read_policy_disposition_parity.sql',
  '106_phoenix_dispatch_line_idempotency.sql',
  '107_phoenix_dispatch_line_request_id_required.sql',
  '108_phoenix_custody_chain_direct_write_lockdown.sql',
  '109_phoenix_public_schema_default_privileges_lockdown.sql',
  '110_phoenix_paper_reference_contract.sql',
  '111_phoenix_threshold_batch_apply.sql',
  '112_phoenix_status_classification_boundary_correction.sql',
  '113_phoenix_monthly_status_direct_write_lockdown.sql',
  '114_phoenix_central_items_catalog_detail.sql',
  '115_phoenix_central_intake_catalog_lockdown.sql',
  '116_phoenix_subpurchase_national_code.sql',
  '117_phoenix_subpurchase_duplicate_candidates.sql',
  '118_phoenix_central_intake_manual_identity.sql',
  '119_phoenix_report_snapshots_and_executive_overview.sql',
  '120_phoenix_supply_sources_detail.sql',
  '121_phoenix_monthly_status_public_execute_lockdown.sql',
  '122_phoenix_movement_timeline_correction_coverage.sql',
  '123_phoenix_movement_ledger_event_capture.sql',
  '124_phoenix_movement_contract_correlation_fields.sql',
  '125_phoenix_movement_reason_code_vocabulary.sql',
  '126_phoenix_movement_reason_code_group_a_warehouse_intake.sql',
  '127_phoenix_movement_reason_code_group_b_warehouse_transfer.sql',
  '128_phoenix_movement_reason_code_group_c_warehouse_return.sql',
  '129_phoenix_movement_reason_code_group_d_direct_supply.sql',
  '130_phoenix_movement_reason_code_group_e_procurement.sql',
  '131_phoenix_movement_reason_code_group_f_outlet.sql',
  '132_phoenix_movement_reason_code_group_g_quarantine.sql',
  '133_phoenix_movement_reason_code_group_h_correction_approval.sql',
  '134_phoenix_movement_dispense_context.sql',
  '135_phoenix_movement_reason_code_group_i_outlet_return_receive.sql',
  '136_phoenix_dispense_with_context_atomic.sql',
  '137_phoenix_five_role_cutover_ports_view_gap.sql',
  '138_phoenix_movement_ledger_report.sql',
  '139_phoenix_movement_timeline_contract_fields.sql',
  '140_phoenix_demo_dataset_manifest.sql',
  '141_phoenix_demo_immutable_exemption.sql',
  '142_phoenix_demo_profile_detach.sql',
  '143_phoenix_demo_purge_restrict_violation_and_ordering.sql',
  '144_phoenix_demo_availability_purge_exemption.sql',
  '145_phoenix_demo_organization_watermark.sql',
  '146_phoenix_secure_user_provisioning.sql',
  '147_phoenix_secure_user_delete_history_guard.sql',
  '148_phoenix_transfer_suggestion_draft_bridge.sql',
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
  '164_phoenix_facility_identity_and_routing_foundation.sql',
  '165_phoenix_sector_health_center_supply_and_return.sql',
  '166_phoenix_initial_provisioning_invariant.sql',
  '167_phoenix_dispatch_line_full_rejection_reconciliation.sql',
  '168_phoenix_atomic_emergency_outlet_replenishment.sql',
  '169_phoenix_outlet_replenishment_reversal.sql',
  '170_phoenix_organization_class_and_warehouse_facility_assignment.sql',
  '171_phoenix_organization_kind_pharmacy_department_authority.sql',
  '172_phoenix_patient_dispensing_contract.sql',
  '173_phoenix_database_security_surface_hardening.sql',
  '174_phoenix_authenticated_rpc_surface_hardening.sql',
]);

const SYNTH_NEXT = '175_unreviewed_test_migration.sql';
const SYNTH_NEXT_ALT = '175_phoenix_some_other_name.sql';
const SYNTH_059_ALT = '059_unreviewed_alternate_name.sql';
const SYNTH_HIGH = '999_phoenix_very_high_number.sql';
const SYNTH_MALFORMED = 'hotfix_no_number.sql';

describe('1. independent allowlist and registry agree exactly', () => {
  it('pins all 174 reviewed migrations by exact concrete filename', () => {
    expect(EXPECTED_REVIEWED_MIGRATION_FILES).toHaveLength(174);
    expect([...REVIEWED_MIGRATION_FILES]).toEqual([...EXPECTED_REVIEWED_MIGRATION_FILES]);
  });

  it('contains no patterns, malformed entries, duplicate filename, or duplicate number', () => {
    for (const f of EXPECTED_REVIEWED_MIGRATION_FILES) {
      expect(isNumberedMigrationFile(f), `${f} must be a well-formed filename`).toBe(true);
      expect(f).not.toMatch(/[*?[\]{}()|^$\\]/);
    }
    expect(findMalformedReviewedFilenames()).toEqual([]);
    expect(findDuplicateReviewedFilenames()).toEqual([]);
    expect(findDuplicateReviewedNumbers()).toEqual([]);
    expect([...REVIEWED_MIGRATION_FILES]).toEqual(sortMigrationFiles(REVIEWED_MIGRATION_FILES));
  });
});

describe('2. disk, independent allowlist, and registry agree in both directions', () => {
  it('has no missing, unreviewed, or malformed migration SQL', () => {
    const disk = actualSqlFiles();
    expect(findMissingReviewedMigrationFiles(disk)).toEqual([]);
    expect(findUnreviewedMigrationFiles(disk)).toEqual([]);
    expect(findMalformedMigrationFiles(disk)).toEqual([]);
  });

  it('disk is the same exact set as the independent allowlist', () => {
    expect(sortMigrationFiles(actualSqlFiles())).toEqual([...EXPECTED_REVIEWED_MIGRATION_FILES]);
  });
});

describe('3. reviewed ceiling is registry-owned and exact', () => {
  it('pins current maximum 174 and next unreviewed 175', () => {
    expect(getMaximumReviewedMigrationNumber()).toBe(174);
    expect(getNextUnreviewedMigrationNumber()).toBe(175);
  });

  it('a high-number file on disk cannot raise the reviewed ceiling', () => {
    const pretendDisk = [...actualSqlFiles(), SYNTH_HIGH];
    expect(getMaximumReviewedMigrationNumber()).toBe(174);
    expect(findUnreviewedMigrationFiles(pretendDisk)).toEqual([SYNTH_HIGH]);
  });

  it('174 is accepted only by its exact reviewed name', () => {
    expect(isReviewedMigrationFile('174_phoenix_authenticated_rpc_surface_hardening.sql')).toBe(true);
    expect(isReviewedMigrationFile('174_phoenix_some_other_name.sql')).toBe(false);
  });
});

describe('4. rejection proofs — plausible names still fail without exact review', () => {
  it('rejects the next well-formed migration and its alternate name', () => {
    expect(isNumberedMigrationFile(SYNTH_NEXT)).toBe(true);
    expect(isReviewedMigrationFile(SYNTH_NEXT)).toBe(false);
    expect(isReviewedMigrationFile(SYNTH_NEXT_ALT)).toBe(false);
    expect(findUnreviewedMigrationFiles([...actualSqlFiles(), SYNTH_NEXT])).toEqual([SYNTH_NEXT]);
  });

  it('rejects an alternate name at an already-reviewed number', () => {
    expect(extractMigrationNumber(SYNTH_059_ALT)).toBe(59);
    expect(isReviewedMigrationFile(SYNTH_059_ALT)).toBe(false);
    expect(findUnreviewedMigrationFiles([...actualSqlFiles(), SYNTH_059_ALT])).toEqual([
      SYNTH_059_ALT,
    ]);
  });

  it('rejects malformed SQL and near-miss reviewed filenames', () => {
    expect(findMalformedMigrationFiles([...actualSqlFiles(), SYNTH_MALFORMED])).toEqual([
      SYNTH_MALFORMED,
    ]);
    for (const nearMiss of [
      '174_phoenix_authenticated_rpc_surface_hardening.SQL',
      '174_phoenix_authenticated_rpc_surface_hardenings.sql',
      '74_phoenix_authenticated_rpc_surface_hardening.sql',
      '174_phoenix_authenticated_rpc_surface_hardening.sql.bak',
      ' 174_phoenix_authenticated_rpc_surface_hardening.sql',
      '*.sql',
      '',
    ]) expect(isReviewedMigrationFile(nearMiss), nearMiss).toBe(false);
  });
});

describe('5. derived slices are exhaustively exact against the independent allowlist', () => {
  const numberOf = (f: string): number => {
    const n = extractMigrationNumber(f);
    if (n === null) throw new Error(`malformed expected migration: ${f}`);
    return n;
  };

  it('reviewedMigrationFilesAbove() is exact for every threshold 0..175', () => {
    for (let threshold = 0; threshold <= 175; threshold += 1) {
      const expected = EXPECTED_REVIEWED_MIGRATION_FILES.filter(f => numberOf(f) > threshold);
      expect(reviewedMigrationFilesAbove(threshold), `above(${threshold})`).toEqual(expected);
    }
  });

  it('reviewedMigrationFilesBetween() is exact for every valid boundary pair 1..175', () => {
    for (let from = 1; from <= 175; from += 1) {
      for (let to = from; to <= 175; to += 1) {
        const expected = EXPECTED_REVIEWED_MIGRATION_FILES.filter(f => {
          const n = numberOf(f);
          return n >= from && n <= to;
        });
        expect(reviewedMigrationFilesBetween(from, to), `between(${from},${to})`).toEqual(expected);
      }
    }
  });
});

describe('6. future-migration workflow remains fail-closed', () => {
  it('unreviewed 175 on disk fails validation', () => {
    const unreviewed = findUnreviewedMigrationFiles([...actualSqlFiles(), SYNTH_NEXT]);
    expect(unreviewed).toEqual([SYNTH_NEXT]);
    expect(unreviewed.length).toBeGreaterThan(0);
  });

  it('simulated explicit review accepts one exact 175 name only', () => {
    const nextRegistry = new Set([...REVIEWED_MIGRATION_FILES, SYNTH_NEXT]);
    expect(nextRegistry.has(SYNTH_NEXT)).toBe(true);
    expect(nextRegistry.has(SYNTH_NEXT_ALT)).toBe(false);
    expect(isReviewedMigrationFile(SYNTH_NEXT)).toBe(false); // real registry unchanged
  });

  it('missing reviewed file is reported', () => {
    const diskWithout001 = actualSqlFiles().filter(f => f !== EXPECTED_REVIEWED_MIGRATION_FILES[0]);
    expect(findMissingReviewedMigrationFiles(diskWithout001)).toEqual([
      EXPECTED_REVIEWED_MIGRATION_FILES[0],
    ]);
  });

  it('registering a name without shipping its file is counter-gated by disk', () => {
    const pretendRegistry = [...REVIEWED_MIGRATION_FILES, SYNTH_NEXT];
    const actual = new Set(actualSqlFiles());
    expect(pretendRegistry.filter(f => !actual.has(f))).toEqual([SYNTH_NEXT]);
  });
});

describe('7. registry purity — no self-approval or runtime bypass', () => {
  it('registry is frozen', () => {
    expect(Object.isFrozen(REVIEWED_MIGRATION_FILES)).toBe(true);
    expect(() => (REVIEWED_MIGRATION_FILES as string[]).push(SYNTH_NEXT)).toThrow();
    expect(isReviewedMigrationFile(SYNTH_NEXT)).toBe(false);
  });

  it('helper source performs no filesystem access, environment bypass, or production import', () => {
    const src = readFileSync(join(__dirname, 'helpers/reviewed-migrations.ts'), 'utf8');
    const code = src
      .split('\n')
      .filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');

    expect(code).not.toMatch(/\bfrom\s+['"](node:)?fs['"]/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\breaddirSync\b|\breadFileSync\b|\bexistsSync\b/);
    expect(code).not.toMatch(/\bprocess\.env\b/);
    expect(code).not.toMatch(/\bfrom\s+['"]@\//);
    expect(code).not.toMatch(/\bwriteFileSync\b|\bmkdirSync\b|\brmSync\b/);
    expect(code).not.toMatch(/\.(skip|only|todo)\(/);
    expect(code).not.toMatch(/\btry\s*\{/);
  });
});

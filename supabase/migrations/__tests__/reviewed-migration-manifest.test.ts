/**
 * MIGRATION-GUARD-DERIVE-A — canonical migration-review manifest test.
 *
 * This is the single place where "which migrations have been reviewed?" is
 * enforced against the real supabase/migrations directory. Historical test files
 * derive their inventory assertions from the same registry instead of carrying
 * their own copies.
 *
 * The property under test is EXACT FILENAME MEMBERSHIP. Every synthetic case
 * below exists to prove that presence, numbering, contiguity, and pattern-match
 * are each insufficient on their own.
 *
 * Synthetic cases operate on in-memory filename arrays only — no file is ever
 * written to the real migrations directory.
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

/** Real `.sql` files on disk (excludes __tests__/ and any non-SQL entry). */
const actualSqlFiles = (): string[] =>
  readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));

// Synthetic filenames — never written to disk.
//
// DIRECT-CENTRAL-TO-INSTITUTION-SUPPLY-077-A: migration 077 is now genuinely
// reviewed and registered, so the "next unreviewed number" synthetic moved
// 077 → 078. This is the intended maintenance step the registry was designed
// for, and it happened HERE ONLY — no historical guard file needed an edit.
//
// DISPATCH-LINE-IDEMPOTENCY-106-A: migration 106 is now genuinely reviewed
// and registered, so the "next unreviewed number" synthetic moved 106 → 107.
//
// DISPATCH-LINE-REQUEST-ID-REQUIRED-107-A: migration 107 is now genuinely
// reviewed and registered, so the "next unreviewed number" synthetic moved
// 107 → 108.
//
// CUSTODY-CHAIN-DIRECT-WRITE-LOCKDOWN-108-A: migration 108 is now genuinely
// reviewed and registered, so the "next unreviewed number" synthetic moved
// 108 → 109.
//
// PUBLIC-SCHEMA-DEFAULT-PRIVILEGES-LOCKDOWN-109: migration 109 is now
// genuinely reviewed and registered, so the "next unreviewed number"
// synthetic moved 109 → 110.
//
// PAPER-REFERENCE-CONTRACT-110: migration 110 is now genuinely reviewed and
// registered, so the "next unreviewed number" synthetic moved 110 → 111.
//
// THRESHOLD-BATCH-APPLY-111: migration 111 is now genuinely reviewed and
// registered, so the "next unreviewed number" synthetic moved 111 → 112.
//
// STATUS-CLASSIFICATION-BOUNDARY-CORRECTION-112: migration 112 is now
// genuinely reviewed and registered, so the "next unreviewed number"
// synthetic moved 112 → 113.
//
// MONTHLY-STATUS-DIRECT-WRITE-LOCKDOWN-113: migration 113 is now genuinely
// reviewed and registered, so the "next unreviewed number" synthetic moved
// 113 → 114.
//
// MONTHLY-STATUS-PUBLIC-EXECUTE-LOCKDOWN-121: migration 121 is now genuinely
// reviewed and registered, so the "next unreviewed number" synthetic moved
// 121 → 122.
//
// MOVEMENT-TIMELINE-CORRECTION-COVERAGE-122: migration 122 is now genuinely
// reviewed and registered, so the "next unreviewed number" synthetic moved
// 122 → 123.
//
// SECURE-USER-PROVISIONING-146: migration 146 is now genuinely reviewed and
// registered, so the "next unreviewed number" synthetic moved 146 → 147.
//
// SECURE-USER-DELETE-HISTORY-GUARD-147: migration 147 is now genuinely
// reviewed and registered (master's actual ceiling was 146 and the separate,
// still-unmerged PR #68 had not occupied 147 on master), so the "next
// unreviewed number" synthetic moved 147 → 148.
//
// TRANSFER-SUGGESTION-DRAFT-BRIDGE-148: migration 148 (renumbered from 147 to
// make room for SECURE-USER-DELETE-HISTORY-GUARD-147 above) is now genuinely
// reviewed and registered, so the "next unreviewed number" synthetic moved
// 148 → 149.
//
// INVENTORY-SUGGESTION-LINEAGE-COMMITMENTS-149: migration 149 is now
// genuinely reviewed and registered, so the next-unreviewed synthetic moved
// 149 → 150. MATERIAL-IDENTITY-FEFO-PROVENANCE-150 and
// REAL-OPERATIONAL-ROLE-GATES-151 and SUGGESTION-ACTION-READ-MODEL-152 then
// moved it 150 → 151 → 152 → 153. RETIRE-INTER-ORG-EXCHANGE-STATUS-WRITER-153
// then moved it 153 → 154.
//
// TRANSFER-CORRIDOR-PRIVILEGE-LOCKDOWN-154: migration 154 is now genuinely
// reviewed and registered, so the "next unreviewed number" synthetic moved
// 154 → 155.
//
// TRANSFER-SEND-RECEIVE-LIFECYCLE-NOTIFICATIONS-155: migration 155 merged to
// master (sibling PR #87) and is now genuinely reviewed and registered, so
// the "next unreviewed number" synthetic moved 155 → 156.
// OUTLET-RETURN-LINE-IDEMPOTENCY-156: migration 156 (sibling PR #89) merged
// to master and is now genuinely reviewed and registered, so the synthetic
// moved 156 → 157.
// OUTLET-RETURN-EXCEPTION-RESOLUTION-157: migration 157 is now genuinely
// reviewed and registered directly after 156, so the synthetic moved
// 157 → 158.
// TRANSACTIONAL-OUTBOX-FOUNDATION-158: migration 158 is now genuinely
// reviewed and registered directly after 157, so the synthetic moved
// 158 → 159.
// LIFECYCLE-OUTBOX-PRODUCER-159: migration 159 (this phase, D2-2) is now
// genuinely reviewed and registered directly after 158, so the synthetic
// moved 159 → 160.
// DEMO-PURGE-OUTBOX-COMPATIBILITY-160: migration 160 (this phase, D2-2's own
// prerequisite compatibility correction) is now genuinely reviewed and
// registered directly after 159, so the synthetic moved 160 → 161.
const SYNTH_NEXT = '161_unreviewed_test_migration.sql';
const SYNTH_NEXT_ALT = '161_phoenix_some_other_name.sql';
const SYNTH_060_ALT = '060_phoenix_some_other_name.sql';
const SYNTH_059_ALT = '059_unreviewed_alternate_name.sql';
const SYNTH_HIGH = '999_phoenix_very_high_number.sql';
const SYNTH_MALFORMED = 'hotfix_no_number.sql';
const REAL_059 = '059_phoenix_public_qr_concentration.sql';
const REAL_060 = '060_phoenix_warehouse_foundation.sql';
const REAL_061 = '061_phoenix_warehouse_dispatch_schema.sql';
const REAL_062 = '062_phoenix_user_rbac_scope_foundation.sql';
const REAL_063 = '063_phoenix_rbac_security_hardening.sql';
const REAL_064 = '064_fix_profile_identity_snapshot_return_type.sql';
const REAL_065 = '065_phoenix_warehouse_truth_and_stock_rpcs.sql';
const REAL_066 = '066_phoenix_inventory_network_expand.sql';
const REAL_067 = '067_phoenix_outlet_stock_expand.sql';
const REAL_068 = '068_phoenix_central_to_institution_supply.sql';
const REAL_069 = '069_phoenix_institution_to_central_return.sql';
const REAL_070 = '070_phoenix_institution_warehouse_outlet_dispatch.sql';
const REAL_071 = '071_phoenix_outlet_to_institution_return.sql';
const REAL_072 = '072_phoenix_inventory_intelligence.sql';
const REAL_073 = '073_phoenix_fixed_near_expiry_policy.sql';
const REAL_074 = '074_phoenix_warehouse_management_rpcs.sql';
const REAL_075 = '075_phoenix_supply_route_rpcs.sql';
const REAL_076 = '076_phoenix_profile_scope_assignment_rpcs.sql';
const REAL_077 = '077_phoenix_direct_central_to_institution_supply.sql';
const REAL_078 = '078_phoenix_warehouse_receipt_expected_generation.sql';
const REAL_079 = '079_phoenix_warehouse_generation_fail_closed.sql';
const REAL_080 = '080_phoenix_revoke_unguarded_warehouse_writers.sql';
const REAL_081 = '081_phoenix_movement_timeline.sql';
const REAL_082 = '082_phoenix_movement_event_capture.sql';
const REAL_083 = '083_phoenix_inventory_derived_availability.sql';
const REAL_084 = '084_phoenix_availability_visibility.sql';
const REAL_085 = '085_phoenix_revoke_manual_availability_writers.sql';
const REAL_086 = '086_phoenix_outlet_stock_correction_expected_generation.sql';
const REAL_087 = '087_phoenix_institution_local_procurement.sql';
const REAL_088 = '088_phoenix_canonical_supply_provenance.sql';
const REAL_089 = '089_phoenix_subpurchase_direct_entry.sql';
const REAL_090 = '090_phoenix_warehouse_receipt_official_number.sql';
const REAL_091 = '091_phoenix_five_role_cutover.sql';
const REAL_092 = '092_phoenix_monthly_status_redesign.sql';
const REAL_093 = '093_phoenix_super_admin_lifecycle_guard.sql';
const REAL_094 = '094_phoenix_custody_chain_notifications.sql';
const REAL_095 = '095_phoenix_return_availability_cap.sql';
const REAL_096 = '096_phoenix_bulk_receive_matching_dispatch_lines.sql';
const REAL_097 = '097_phoenix_fefo_reasoned_override.sql';
const REAL_098 = '098_phoenix_second_person_correction_approval.sql';
const REAL_099 = '099_phoenix_notification_wiring_and_quarantine_disposition.sql';
const REAL_100 = '100_phoenix_bulk_receive_remaining_corridors.sql';
const REAL_101 = '101_phoenix_warehouse_second_person_correction_approval.sql';
const REAL_102 = '102_phoenix_transfer_send_fefo_guarded.sql';
const REAL_103 = '103_phoenix_institution_warehouse_no_direct_entry.sql';
const REAL_104 = '104_phoenix_return_quarantine_insert_column_fix.sql';
const REAL_105 = '105_phoenix_quarantine_read_policy_disposition_parity.sql';
const REAL_106 = '106_phoenix_dispatch_line_idempotency.sql';
const REAL_107 = '107_phoenix_dispatch_line_request_id_required.sql';
const REAL_108 = '108_phoenix_custody_chain_direct_write_lockdown.sql';
const REAL_109 = '109_phoenix_public_schema_default_privileges_lockdown.sql';
const REAL_110 = '110_phoenix_paper_reference_contract.sql';
const REAL_111 = '111_phoenix_threshold_batch_apply.sql';
const REAL_112 = '112_phoenix_status_classification_boundary_correction.sql';
const REAL_113 = '113_phoenix_monthly_status_direct_write_lockdown.sql';
const REAL_114 = '114_phoenix_central_items_catalog_detail.sql';
const REAL_115 = '115_phoenix_central_intake_catalog_lockdown.sql';
const REAL_116 = '116_phoenix_subpurchase_national_code.sql';
const REAL_117 = '117_phoenix_subpurchase_duplicate_candidates.sql';
const REAL_118 = '118_phoenix_central_intake_manual_identity.sql';
const REAL_119 = '119_phoenix_report_snapshots_and_executive_overview.sql';
const REAL_120 = '120_phoenix_supply_sources_detail.sql';
const REAL_121 = '121_phoenix_monthly_status_public_execute_lockdown.sql';
const REAL_122 = '122_phoenix_movement_timeline_correction_coverage.sql';
const REAL_123 = '123_phoenix_movement_ledger_event_capture.sql';
const REAL_124 = '124_phoenix_movement_contract_correlation_fields.sql';
const REAL_125 = '125_phoenix_movement_reason_code_vocabulary.sql';
const REAL_126 = '126_phoenix_movement_reason_code_group_a_warehouse_intake.sql';
const REAL_127 = '127_phoenix_movement_reason_code_group_b_warehouse_transfer.sql';
const REAL_128 = '128_phoenix_movement_reason_code_group_c_warehouse_return.sql';
const REAL_129 = '129_phoenix_movement_reason_code_group_d_direct_supply.sql';
const REAL_130 = '130_phoenix_movement_reason_code_group_e_procurement.sql';
const REAL_131 = '131_phoenix_movement_reason_code_group_f_outlet.sql';
const REAL_132 = '132_phoenix_movement_reason_code_group_g_quarantine.sql';
const REAL_133 = '133_phoenix_movement_reason_code_group_h_correction_approval.sql';
const REAL_134 = '134_phoenix_movement_dispense_context.sql';
const REAL_135 = '135_phoenix_movement_reason_code_group_i_outlet_return_receive.sql';
const REAL_136 = '136_phoenix_dispense_with_context_atomic.sql';
const REAL_137 = '137_phoenix_five_role_cutover_ports_view_gap.sql';
const REAL_138 = '138_phoenix_movement_ledger_report.sql';
const REAL_139 = '139_phoenix_movement_timeline_contract_fields.sql';
const REAL_140 = '140_phoenix_demo_dataset_manifest.sql';
const REAL_141 = '141_phoenix_demo_immutable_exemption.sql';
const REAL_142 = '142_phoenix_demo_profile_detach.sql';
const REAL_143 = '143_phoenix_demo_purge_restrict_violation_and_ordering.sql';
const REAL_144 = '144_phoenix_demo_availability_purge_exemption.sql';
const REAL_145 = '145_phoenix_demo_organization_watermark.sql';
const REAL_146 = '146_phoenix_secure_user_provisioning.sql';
const REAL_147 = '147_phoenix_secure_user_delete_history_guard.sql';
const REAL_148 = '148_phoenix_transfer_suggestion_draft_bridge.sql';
const REAL_149 = '149_phoenix_inventory_suggestion_lineage_commitments.sql';
const REAL_150 = '150_phoenix_material_identity_fefo_provenance_hardening.sql';
const REAL_151 = '151_phoenix_suggestion_route_policy_gates.sql';
const REAL_152 = '152_phoenix_suggestion_action_read_model.sql';
const REAL_153 = '153_phoenix_retire_inter_org_exchange_status_writer.sql';
const REAL_154 = '154_phoenix_transfer_corridor_privilege_lockdown.sql';
const REAL_155 = '155_phoenix_transfer_send_receive_lifecycle_notifications.sql';
const REAL_156 = '156_phoenix_outlet_return_line_idempotency.sql';
const REAL_157 = '157_phoenix_outlet_return_exception_resolution.sql';
const REAL_158 = '158_phoenix_transactional_outbox_foundation.sql';
const REAL_159 = '159_phoenix_lifecycle_outbox_producer.sql';
const REAL_160 = '160_phoenix_demo_purge_outbox_compatibility.sql';

// ============================================================================
// 1. Registry shape — exact filenames, no duplicates, deterministic order
// ============================================================================

describe('1. registry contains exact filenames only', () => {
  it('every entry is a concrete NNN_name.sql filename (no globs, ranges or regex)', () => {
    for (const f of REVIEWED_MIGRATION_FILES) {
      expect(isNumberedMigrationFile(f), `${f} must be a well-formed filename`).toBe(true);
      expect(f).not.toMatch(/[*?[\]{}()|^$\\]/); // no wildcard/regex metacharacters
    }
  });

  it('contains no malformed entries', () => {
    expect(findMalformedReviewedFilenames()).toEqual([]);
  });

  it('contains no duplicate exact filename', () => {
    expect(findDuplicateReviewedFilenames()).toEqual([]);
  });

  it('contains no duplicate migration number (repo has no reviewed duplicates)', () => {
    expect(findDuplicateReviewedNumbers()).toEqual([]);
  });

  it('is stored in deterministic canonical order', () => {
    expect([...REVIEWED_MIGRATION_FILES]).toEqual(sortMigrationFiles(REVIEWED_MIGRATION_FILES));
  });

  it('sorting is stable and deterministic regardless of input order', () => {
    const shuffled = [...REVIEWED_MIGRATION_FILES].reverse();
    expect(sortMigrationFiles(shuffled)).toEqual(sortMigrationFiles(REVIEWED_MIGRATION_FILES));
  });
});

// ============================================================================
// 2. Registry ↔ disk agreement (both directions)
// ============================================================================

describe('2. registry and disk agree exactly, in both directions', () => {
  it('every registry entry exists on disk (no missing reviewed migration)', () => {
    expect(findMissingReviewedMigrationFiles(actualSqlFiles())).toEqual([]);
  });

  it('every SQL file on disk is in the registry (no unreviewed migration accepted)', () => {
    expect(findUnreviewedMigrationFiles(actualSqlFiles())).toEqual([]);
  });

  it('no malformed SQL file is present on disk', () => {
    expect(findMalformedMigrationFiles(actualSqlFiles())).toEqual([]);
  });

  it('disk and registry are the same set, exactly', () => {
    expect(sortMigrationFiles(actualSqlFiles())).toEqual([...REVIEWED_MIGRATION_FILES]);
  });
});

// ============================================================================
// 3. Maximum is derived from the registry, not from the directory
// ============================================================================

describe('3. reviewed maximum derives from the registry', () => {
  it('the current reviewed maximum is 160', () => {
    expect(getMaximumReviewedMigrationNumber()).toBe(160);
  });

  it('the next unreviewed number is 161', () => {
    expect(getNextUnreviewedMigrationNumber()).toBe(161);
  });

  it('the maximum equals the highest number in the registry itself', () => {
    const highest = Math.max(
      ...REVIEWED_MIGRATION_FILES.map(extractMigrationNumber).filter((n): n is number => n !== null),
    );
    expect(getMaximumReviewedMigrationNumber()).toBe(highest);
  });

  it('a file on disk cannot raise the ceiling merely by existing', () => {
    // The helper never reads the directory: the ceiling is a property of the
    // registry alone. Pretending 999 is on disk changes nothing.
    const pretendDisk = [...actualSqlFiles(), SYNTH_HIGH];
    expect(getMaximumReviewedMigrationNumber()).toBe(160);
    expect(findUnreviewedMigrationFiles(pretendDisk)).toEqual([SYNTH_HIGH]);
  });
});

// ============================================================================
// 4. Migrations 059–073 registered by exact real name; 074 is not registered
// ============================================================================

describe('4. migrations 059–073 registered by exact name; 074 absent', () => {
  it('contains migration 059 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_059);
    expect(isReviewedMigrationFile(REAL_059)).toBe(true);
  });

  it('contains migration 060 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_060);
    expect(isReviewedMigrationFile(REAL_060)).toBe(true);
  });

  it('registers exactly one migration 060 (no alternate 060 name)', () => {
    const sixties = REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 60);
    expect(sixties).toEqual([REAL_060]);
    expect(isReviewedMigrationFile(SYNTH_060_ALT)).toBe(false);
  });

  it('contains migration 061 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_061);
    expect(isReviewedMigrationFile(REAL_061)).toBe(true);
  });

  it('contains migration 062 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_062);
    expect(isReviewedMigrationFile(REAL_062)).toBe(true);
  });

  it('registers exactly one migration 062 (no alternate 062 name)', () => {
    const sixtyTwos = REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 62);
    expect(sixtyTwos).toEqual([REAL_062]);
    expect(isReviewedMigrationFile('062_phoenix_some_other_name.sql')).toBe(false);
  });

  it('contains migration 063 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_063);
    expect(isReviewedMigrationFile(REAL_063)).toBe(true);
  });

  it('registers exactly one migration 063 (no alternate 063 name)', () => {
    const sixtyThrees = REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 63);
    expect(sixtyThrees).toEqual([REAL_063]);
    expect(isReviewedMigrationFile('063_phoenix_some_other_name.sql')).toBe(false);
  });

  it('contains migration 064 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_064);
    expect(isReviewedMigrationFile(REAL_064)).toBe(true);
  });

  it('registers exactly one migration 064 (no alternate 064 name)', () => {
    const sixtyFours = REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 64);
    expect(sixtyFours).toEqual([REAL_064]);
    expect(isReviewedMigrationFile('064_phoenix_some_other_name.sql')).toBe(false);
  });

  it('contains migration 065 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_065);
    expect(isReviewedMigrationFile(REAL_065)).toBe(true);
  });

  it('registers exactly one migration 065 (no alternate 065 name)', () => {
    const sixtyFives = REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 65);
    expect(sixtyFives).toEqual([REAL_065]);
    expect(isReviewedMigrationFile('065_phoenix_some_other_name.sql')).toBe(false);
  });

  it('contains migration 066 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_066);
    expect(isReviewedMigrationFile(REAL_066)).toBe(true);
  });

  it('registers exactly one migration 066 (no alternate 066 name)', () => {
    const sixtySixes = REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 66);
    expect(sixtySixes).toEqual([REAL_066]);
    expect(isReviewedMigrationFile('066_phoenix_some_other_name.sql')).toBe(false);
  });

  it('contains migration 067 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_067);
    expect(isReviewedMigrationFile(REAL_067)).toBe(true);
  });

  it('registers exactly one migration 067 (no alternate 067 name)', () => {
    const sixtySevens = REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 67);
    expect(sixtySevens).toEqual([REAL_067]);
    expect(isReviewedMigrationFile('067_phoenix_some_other_name.sql')).toBe(false);
  });

  it('contains migration 068 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_068);
    expect(isReviewedMigrationFile(REAL_068)).toBe(true);
  });

  it('registers exactly one migration 068 (no alternate 068 name)', () => {
    const sixtyEights = REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 68);
    expect(sixtyEights).toEqual([REAL_068]);
    expect(isReviewedMigrationFile('068_phoenix_some_other_name.sql')).toBe(false);
  });

  it('contains migration 069 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_069);
    expect(isReviewedMigrationFile(REAL_069)).toBe(true);
  });

  it('registers exactly one migration 069 (no alternate 069 name)', () => {
    const sixtyNines = REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 69);
    expect(sixtyNines).toEqual([REAL_069]);
    expect(isReviewedMigrationFile('069_phoenix_some_other_name.sql')).toBe(false);
  });

  it('contains migration 070 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_070);
    expect(isReviewedMigrationFile(REAL_070)).toBe(true);
  });

  it('registers exactly one migration 070 (no alternate 070 name)', () => {
    const seventies = REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 70);
    expect(seventies).toEqual([REAL_070]);
    expect(isReviewedMigrationFile('070_phoenix_some_other_name.sql')).toBe(false);
  });

  it('contains migration 071 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_071);
    expect(isReviewedMigrationFile(REAL_071)).toBe(true);
  });

  it('registers exactly one migration 071 (no alternate 071 name)', () => {
    const seventyOnes = REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 71);
    expect(seventyOnes).toEqual([REAL_071]);
    expect(isReviewedMigrationFile('071_phoenix_some_other_name.sql')).toBe(false);
  });

  it('contains migration 072 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_072);
    expect(isReviewedMigrationFile(REAL_072)).toBe(true);
  });

  it('registers exactly one migration 072 (no alternate 072 name)', () => {
    const seventyTwos = REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 72);
    expect(seventyTwos).toEqual([REAL_072]);
    expect(isReviewedMigrationFile('072_phoenix_some_other_name.sql')).toBe(false);
  });

  it('contains migration 073 by its exact real filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(REAL_073);
    expect(isReviewedMigrationFile(REAL_073)).toBe(true);
  });

  it('registers exactly one migration 073 (no alternate 073 name)', () => {
    const seventyThrees = REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 73);
    expect(seventyThrees).toEqual([REAL_073]);
    expect(isReviewedMigrationFile('073_phoenix_some_other_name.sql')).toBe(false);
  });

  it('registers exactly one each of migrations 074-087 (no alternate names)', () => {
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 74)).toEqual([REAL_074]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 75)).toEqual([REAL_075]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 76)).toEqual([REAL_076]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 77)).toEqual([REAL_077]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 78)).toEqual([REAL_078]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 79)).toEqual([REAL_079]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 80)).toEqual([REAL_080]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 81)).toEqual([REAL_081]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 82)).toEqual([REAL_082]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 83)).toEqual([REAL_083]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 84)).toEqual([REAL_084]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 85)).toEqual([REAL_085]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 86)).toEqual([REAL_086]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 87)).toEqual([REAL_087]);
  });

  it('registers migrations 088-099 by exact reviewed names, and nothing beyond', () => {
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 88))
      .toEqual(['088_phoenix_canonical_supply_provenance.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 89))
      .toEqual(['089_phoenix_subpurchase_direct_entry.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 90))
      .toEqual(['090_phoenix_warehouse_receipt_official_number.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 91))
      .toEqual(['091_phoenix_five_role_cutover.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 92))
      .toEqual(['092_phoenix_monthly_status_redesign.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 93))
      .toEqual(['093_phoenix_super_admin_lifecycle_guard.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 94))
      .toEqual(['094_phoenix_custody_chain_notifications.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 95))
      .toEqual(['095_phoenix_return_availability_cap.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 96))
      .toEqual(['096_phoenix_bulk_receive_matching_dispatch_lines.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 97))
      .toEqual(['097_phoenix_fefo_reasoned_override.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 98))
      .toEqual(['098_phoenix_second_person_correction_approval.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 99))
      .toEqual(['099_phoenix_notification_wiring_and_quarantine_disposition.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 100))
      .toEqual(['100_phoenix_bulk_receive_remaining_corridors.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 101))
      .toEqual(['101_phoenix_warehouse_second_person_correction_approval.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 102))
      .toEqual(['102_phoenix_transfer_send_fefo_guarded.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 103))
      .toEqual(['103_phoenix_institution_warehouse_no_direct_entry.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 104))
      .toEqual(['104_phoenix_return_quarantine_insert_column_fix.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 105))
      .toEqual(['105_phoenix_quarantine_read_policy_disposition_parity.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 106))
      .toEqual(['106_phoenix_dispatch_line_idempotency.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 107))
      .toEqual(['107_phoenix_dispatch_line_request_id_required.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 108))
      .toEqual(['108_phoenix_custody_chain_direct_write_lockdown.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 109))
      .toEqual(['109_phoenix_public_schema_default_privileges_lockdown.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 110))
      .toEqual(['110_phoenix_paper_reference_contract.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 111))
      .toEqual(['111_phoenix_threshold_batch_apply.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 112))
      .toEqual(['112_phoenix_status_classification_boundary_correction.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 113))
      .toEqual(['113_phoenix_monthly_status_direct_write_lockdown.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 114))
      .toEqual(['114_phoenix_central_items_catalog_detail.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 115))
      .toEqual(['115_phoenix_central_intake_catalog_lockdown.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 116))
      .toEqual(['116_phoenix_subpurchase_national_code.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 117))
      .toEqual(['117_phoenix_subpurchase_duplicate_candidates.sql']);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 118))
      .toEqual([REAL_118]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 119))
      .toEqual([REAL_119]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 120))
      .toEqual([REAL_120]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 121))
      .toEqual([REAL_121]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 122))
      .toEqual([REAL_122]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 123))
      .toEqual([REAL_123]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 124)).toEqual([REAL_124]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 125)).toEqual([REAL_125]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 126)).toEqual([REAL_126]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 127)).toEqual([REAL_127]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 128)).toEqual([REAL_128]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 129)).toEqual([REAL_129]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 130)).toEqual([REAL_130]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 131)).toEqual([REAL_131]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 132)).toEqual([REAL_132]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 133)).toEqual([REAL_133]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 134)).toEqual([REAL_134]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 135)).toEqual([REAL_135]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 136)).toEqual([REAL_136]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 137)).toEqual([REAL_137]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 138)).toEqual([REAL_138]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 139)).toEqual([REAL_139]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 140)).toEqual([REAL_140]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 141)).toEqual([REAL_141]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 142)).toEqual([REAL_142]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 143)).toEqual([REAL_143]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 144)).toEqual([REAL_144]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 145)).toEqual([REAL_145]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 146)).toEqual([REAL_146]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 147)).toEqual([REAL_147]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 148)).toEqual([REAL_148]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 149)).toEqual([REAL_149]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 150)).toEqual([REAL_150]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 151)).toEqual([REAL_151]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 152)).toEqual([REAL_152]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 153)).toEqual([REAL_153]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 154)).toEqual([REAL_154]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 155)).toEqual([REAL_155]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 156)).toEqual([REAL_156]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 157)).toEqual([REAL_157]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 158)).toEqual([REAL_158]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 159)).toEqual([REAL_159]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === 160)).toEqual([REAL_160]);
  });
});

// ============================================================================
// 5. Rejection proofs — presence, number, and pattern are each insufficient
// ============================================================================

describe('5. approval requires exact filename membership, nothing less', () => {
  it('rejects a synthetic unreviewed migration 161 (the next unreviewed number)', () => {
    expect(isReviewedMigrationFile(SYNTH_NEXT)).toBe(false);
    expect(findUnreviewedMigrationFiles([...actualSqlFiles(), SYNTH_NEXT])).toEqual([SYNTH_NEXT]);
  });

  it('rejects a name that matches the naming pattern but is not registered', () => {
    // Well-formed, plausible, correctly numbered — and still rejected.
    expect(isNumberedMigrationFile(SYNTH_060_ALT)).toBe(true);
    expect(isReviewedMigrationFile(SYNTH_060_ALT)).toBe(false);
  });

  it('rejects an alternate filename at an already-reviewed number (059)', () => {
    // 59 <= max reviewed (59), yet the exact name is unknown ⇒ rejected.
    expect(extractMigrationNumber(SYNTH_059_ALT)).toBe(59);
    expect(extractMigrationNumber(SYNTH_059_ALT)!).toBeLessThanOrEqual(
      getMaximumReviewedMigrationNumber(),
    );
    expect(isReviewedMigrationFile(SYNTH_059_ALT)).toBe(false);
    expect(findUnreviewedMigrationFiles([...actualSqlFiles(), SYNTH_059_ALT])).toEqual([
      SYNTH_059_ALT,
    ]);
  });

  it('rejects a very high-number migration', () => {
    expect(isReviewedMigrationFile(SYNTH_HIGH)).toBe(false);
    expect(findUnreviewedMigrationFiles([SYNTH_HIGH])).toEqual([SYNTH_HIGH]);
  });

  it('rejects a non-numbered SQL file rather than ignoring it', () => {
    expect(isReviewedMigrationFile(SYNTH_MALFORMED)).toBe(false);
    expect(findUnreviewedMigrationFiles([...actualSqlFiles(), SYNTH_MALFORMED])).toEqual([
      SYNTH_MALFORMED,
    ]);
    expect(findMalformedMigrationFiles([...actualSqlFiles(), SYNTH_MALFORMED])).toEqual([
      SYNTH_MALFORMED,
    ]);
  });

  it('rejects near-miss variants of a real reviewed filename', () => {
    for (const nearMiss of [
      '059_phoenix_public_qr_concentration.SQL', // different case extension
      '059_phoenix_public_qr_concentrations.sql', // trailing s
      '59_phoenix_public_qr_concentration.sql', // two-digit number
      '059_phoenix_public_qr_concentration.sql.bak', // suffixed
      ' 059_phoenix_public_qr_concentration.sql', // leading space
    ]) {
      expect(isReviewedMigrationFile(nearMiss), `${nearMiss} must not be reviewed`).toBe(false);
    }
  });

  it('uses no wildcard or range acceptance — membership is Set-exact', () => {
    // A registry-derived prefix/range rule would wrongly admit these; Set
    // membership does not.
    expect(isReviewedMigrationFile('059_')).toBe(false);
    expect(isReviewedMigrationFile('059')).toBe(false);
    expect(isReviewedMigrationFile('*.sql')).toBe(false);
    expect(isReviewedMigrationFile('')).toBe(false);
  });
});

// ============================================================================
// 6. Registry-derived slices keep exact-filename semantics
// ============================================================================

describe('6. derived slices remain exact-filename lists', () => {
  it('reviewedMigrationFilesAbove(43) yields the exact 044–123 filenames', () => {
    expect(reviewedMigrationFilesAbove(43)).toEqual([
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
    ]);
  });

  it('reviewedMigrationFilesAbove(64) contains exactly migrations 065-118', () => {
    expect(reviewedMigrationFilesAbove(64)).toEqual([REAL_065, REAL_066, REAL_067, REAL_068, REAL_069, REAL_070, REAL_071, REAL_072, REAL_073, REAL_074, REAL_075, REAL_076, REAL_077, REAL_078, REAL_079, REAL_080, REAL_081, REAL_082, REAL_083, REAL_084, REAL_085, REAL_086, REAL_087, REAL_088, REAL_089, REAL_090, REAL_091, REAL_092, REAL_093, REAL_094, REAL_095, REAL_096, REAL_097, REAL_098, REAL_099, REAL_100, REAL_101, REAL_102, REAL_103, REAL_104, REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
  });

  it('reviewedMigrationFilesAbove(71) contains exactly migrations 072-118', () => {
    expect(reviewedMigrationFilesAbove(71)).toEqual([REAL_072, REAL_073, REAL_074, REAL_075, REAL_076, REAL_077, REAL_078, REAL_079, REAL_080, REAL_081, REAL_082, REAL_083, REAL_084, REAL_085, REAL_086, REAL_087, REAL_088, REAL_089, REAL_090, REAL_091, REAL_092, REAL_093, REAL_094, REAL_095, REAL_096, REAL_097, REAL_098, REAL_099, REAL_100, REAL_101, REAL_102, REAL_103, REAL_104, REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
  });

  it('reviewedMigrationFilesAbove(72) contains exactly migrations 073-118', () => {
    expect(reviewedMigrationFilesAbove(72)).toEqual([REAL_073, REAL_074, REAL_075, REAL_076, REAL_077, REAL_078, REAL_079, REAL_080, REAL_081, REAL_082, REAL_083, REAL_084, REAL_085, REAL_086, REAL_087, REAL_088, REAL_089, REAL_090, REAL_091, REAL_092, REAL_093, REAL_094, REAL_095, REAL_096, REAL_097, REAL_098, REAL_099, REAL_100, REAL_101, REAL_102, REAL_103, REAL_104, REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
  });

  it('reviewedMigrationFilesAbove(76) contains exactly migrations 077-118', () => {
    expect(reviewedMigrationFilesAbove(76)).toEqual([REAL_077, REAL_078, REAL_079, REAL_080, REAL_081, REAL_082, REAL_083, REAL_084, REAL_085, REAL_086, REAL_087, REAL_088, REAL_089, REAL_090, REAL_091, REAL_092, REAL_093, REAL_094, REAL_095, REAL_096, REAL_097, REAL_098, REAL_099, REAL_100, REAL_101, REAL_102, REAL_103, REAL_104, REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
  });

  it('reviewedMigrationFilesAbove(77) contains exactly migrations 078-118', () => {
    expect(reviewedMigrationFilesAbove(77)).toEqual([REAL_078, REAL_079, REAL_080, REAL_081, REAL_082, REAL_083, REAL_084, REAL_085, REAL_086, REAL_087, REAL_088, REAL_089, REAL_090, REAL_091, REAL_092, REAL_093, REAL_094, REAL_095, REAL_096, REAL_097, REAL_098, REAL_099, REAL_100, REAL_101, REAL_102, REAL_103, REAL_104, REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
  });

  it('reviewedMigrationFilesAbove(109) contains 110-118; above(118) is empty', () => {
    expect(reviewedMigrationFilesAbove(87)).toEqual([REAL_088, REAL_089, REAL_090, REAL_091, REAL_092, REAL_093, REAL_094, REAL_095, REAL_096, REAL_097, REAL_098, REAL_099, REAL_100, REAL_101, REAL_102, REAL_103, REAL_104, REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(89)).toEqual([REAL_090, REAL_091, REAL_092, REAL_093, REAL_094, REAL_095, REAL_096, REAL_097, REAL_098, REAL_099, REAL_100, REAL_101, REAL_102, REAL_103, REAL_104, REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(90)).toEqual([REAL_091, REAL_092, REAL_093, REAL_094, REAL_095, REAL_096, REAL_097, REAL_098, REAL_099, REAL_100, REAL_101, REAL_102, REAL_103, REAL_104, REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(91)).toEqual([REAL_092, REAL_093, REAL_094, REAL_095, REAL_096, REAL_097, REAL_098, REAL_099, REAL_100, REAL_101, REAL_102, REAL_103, REAL_104, REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(92)).toEqual([REAL_093, REAL_094, REAL_095, REAL_096, REAL_097, REAL_098, REAL_099, REAL_100, REAL_101, REAL_102, REAL_103, REAL_104, REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(93)).toEqual([REAL_094, REAL_095, REAL_096, REAL_097, REAL_098, REAL_099, REAL_100, REAL_101, REAL_102, REAL_103, REAL_104, REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(94)).toEqual([REAL_095, REAL_096, REAL_097, REAL_098, REAL_099, REAL_100, REAL_101, REAL_102, REAL_103, REAL_104, REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(95)).toEqual([REAL_096, REAL_097, REAL_098, REAL_099, REAL_100, REAL_101, REAL_102, REAL_103, REAL_104, REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(96)).toEqual([REAL_097, REAL_098, REAL_099, REAL_100, REAL_101, REAL_102, REAL_103, REAL_104, REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(97)).toEqual([REAL_098, REAL_099, REAL_100, REAL_101, REAL_102, REAL_103, REAL_104, REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(98)).toEqual([REAL_099, REAL_100, REAL_101, REAL_102, REAL_103, REAL_104, REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(99)).toEqual([REAL_100, REAL_101, REAL_102, REAL_103, REAL_104, REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(104)).toEqual([REAL_105, REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(105)).toEqual([REAL_106, REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(106)).toEqual([REAL_107, REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(107)).toEqual([REAL_108, REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(108)).toEqual([REAL_109, REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(109)).toEqual([REAL_110, REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(110)).toEqual([REAL_111, REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(111)).toEqual([REAL_112, REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(112)).toEqual([REAL_113, REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(113)).toEqual([REAL_114, REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(114)).toEqual([REAL_115, REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(115)).toEqual([REAL_116, REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(116)).toEqual([REAL_117, REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(117)).toEqual([REAL_118, REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(118)).toEqual([REAL_119, REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(119)).toEqual([REAL_120, REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(120)).toEqual([REAL_121, REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(121)).toEqual([REAL_122, REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(122)).toEqual([REAL_123, REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(123)).toEqual([REAL_124, REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(124)).toEqual([REAL_125, REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(125)).toEqual([REAL_126, REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(126)).toEqual([REAL_127, REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(127)).toEqual([REAL_128, REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(128)).toEqual([REAL_129, REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(129)).toEqual([REAL_130, REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(130)).toEqual([REAL_131, REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(131)).toEqual([REAL_132, REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(132)).toEqual([REAL_133, REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(133)).toEqual([REAL_134, REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(134)).toEqual([REAL_135, REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(135)).toEqual([REAL_136, REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(136)).toEqual([REAL_137, REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(137)).toEqual([REAL_138, REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(138)).toEqual([REAL_139, REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(139)).toEqual([REAL_140, REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(140)).toEqual([REAL_141, REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(141)).toEqual([REAL_142, REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(142)).toEqual([REAL_143, REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(143)).toEqual([REAL_144, REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(144)).toEqual([REAL_145, REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(145)).toEqual([REAL_146, REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(146)).toEqual([REAL_147, REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(147)).toEqual([REAL_148, REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(148)).toEqual([REAL_149, REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(149)).toEqual([REAL_150, REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(150)).toEqual([REAL_151, REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(151)).toEqual([REAL_152, REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(152)).toEqual([REAL_153, REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(153)).toEqual([REAL_154, REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(154)).toEqual([REAL_155, REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(155)).toEqual([REAL_156, REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(156)).toEqual([REAL_157, REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(157)).toEqual([REAL_158, REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(158)).toEqual([REAL_159, REAL_160]);
    expect(reviewedMigrationFilesAbove(159)).toEqual([REAL_160]);
    expect(reviewedMigrationFilesAbove(160)).toEqual([]);
  });

  it('every derived slice entry is itself an exactly-reviewed filename', () => {
    for (const f of reviewedMigrationFilesAbove(0)) {
      expect(isReviewedMigrationFile(f)).toBe(true);
    }
  });

  it('reviewedMigrationFilesBetween is inclusive and exact', () => {
    expect(reviewedMigrationFilesBetween(58, 62)).toEqual([
      '058_phoenix_public_qr_dosage_form.sql',
      '059_phoenix_public_qr_concentration.sql',
      '060_phoenix_warehouse_foundation.sql',
      '061_phoenix_warehouse_dispatch_schema.sql',
      '062_phoenix_user_rbac_scope_foundation.sql',
    ]);
  });

  it('slices cover the registry with no gaps or invented names', () => {
    expect(reviewedMigrationFilesAbove(0)).toEqual([...REVIEWED_MIGRATION_FILES]);
  });
});

// ============================================================================
// 7. Future-migration workflow (Scenarios A–D)
// ============================================================================

describe('7. future-migration workflow', () => {
  it('Scenario A — unreviewed 066 on disk fails validation', () => {
    const disk = [...actualSqlFiles(), SYNTH_NEXT];
    const unreviewed = findUnreviewedMigrationFiles(disk);
    expect(unreviewed).toEqual([SYNTH_NEXT]);
    // "validation fails" = the manifest assertion this test file makes would fail.
    expect(unreviewed.length).toBeGreaterThan(0);
  });

  it('Scenario B — explicitly reviewing 066 accepts that exact name only', () => {
    // In-memory registry copy: exactly what registering migration 065 did for real.
    const nextRegistry = new Set([...REVIEWED_MIGRATION_FILES, SYNTH_NEXT]);
    const isReviewedNext = (f: string): boolean => nextRegistry.has(f);

    expect(isReviewedNext(SYNTH_NEXT)).toBe(true); // the reviewed name is accepted
    expect(isReviewedNext(SYNTH_060_ALT)).toBe(false); // a different 060 is NOT
    // The real registry is untouched by the simulation.
    expect(isReviewedMigrationFile(SYNTH_NEXT)).toBe(false);
  });

  it('Scenario C — an alternate 059 name stays rejected despite 59 <= max', () => {
    expect(isReviewedMigrationFile(SYNTH_059_ALT)).toBe(false);
    expect(extractMigrationNumber(SYNTH_059_ALT)).toBeLessThanOrEqual(
      getMaximumReviewedMigrationNumber(),
    );
  });

  it('Scenario D — a reviewed file missing from disk is reported', () => {
    const diskWithout059 = actualSqlFiles().filter(f => f !== REAL_059);
    expect(findMissingReviewedMigrationFiles(diskWithout059)).toEqual([REAL_059]);
  });

  it('adding a disk file without registering it fails (registry is the gate)', () => {
    expect(findUnreviewedMigrationFiles([...actualSqlFiles(), SYNTH_NEXT])).not.toEqual([]);
  });

  it('registering a name without shipping the file fails (disk is the counter-gate)', () => {
    const pretendRegistry = [...REVIEWED_MIGRATION_FILES, SYNTH_NEXT];
    const actual = new Set(actualSqlFiles());
    expect(pretendRegistry.filter(f => !actual.has(f))).toEqual([SYNTH_NEXT]);
  });
});

// ============================================================================
// 8. Purity — the registry cannot be self-approving
// ============================================================================

describe('8. registry purity', () => {
  it('is frozen (cannot be mutated at runtime by a test)', () => {
    expect(Object.isFrozen(REVIEWED_MIGRATION_FILES)).toBe(true);
    expect(() => {
      (REVIEWED_MIGRATION_FILES as string[]).push(SYNTH_NEXT);
    }).toThrow();
    expect(isReviewedMigrationFile(SYNTH_NEXT)).toBe(false);
  });

  it('helper source performs no filesystem access and imports no production code', () => {
    // Reading the helper's own source keeps "never derive the registry from
    // disk" enforceable rather than merely documented in a comment.
    const src = readFileSync(join(__dirname, 'helpers/reviewed-migrations.ts'), 'utf8');
    const code = src
      .split('\n')
      .filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n');

    expect(code).not.toMatch(/\bfrom\s+['"](node:)?fs['"]/); // no fs import
    expect(code).not.toMatch(/\brequire\s*\(/); // no dynamic require
    expect(code).not.toMatch(/\breaddirSync\b|\breadFileSync\b|\bexistsSync\b/);
    expect(code).not.toMatch(/\bprocess\.env\b/); // no env-dependent behavior
    expect(code).not.toMatch(/\bfrom\s+['"]@\//); // no production module import
    expect(code).not.toMatch(/\bwriteFileSync\b|\bmkdirSync\b|\brmSync\b/); // no mutation
  });

  it('helper declares no test bypasses', () => {
    const src = readFileSync(join(__dirname, 'helpers/reviewed-migrations.ts'), 'utf8');
    expect(src).not.toMatch(/\.(skip|only|todo)\(/);
    expect(src).not.toMatch(/\btry\s*\{/); // no swallowed failures
  });
});

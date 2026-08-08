/**
 * MIGRATION-GUARD-DERIVE-A — canonical reviewed-migration registry (test-only).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Migration review used to be duplicated across dozens of historical test
 * files, in two shapes that both had to be edited for every new migration:
 *
 *   1. Tail inventory:  readdirSync(MIGRATIONS_DIR).filter(f => /^0(4[4-9]|[5-9][0-9])_/.test(f))
 *                       expect(matches).toEqual([ ...every exact filename above 043... ])
 *
 *   2. Future ceiling:  readdirSync(MIGRATIONS_DIR).filter(f => /^0(6[0-9]|[7-9][0-9])_/.test(f))
 *                       expect(matches).toEqual([])
 *
 * Adding migration 059 therefore meant appending a filename to ~5 long arrays
 * and bumping ~9 ceiling regexes in files that had nothing to do with 059. That
 * churn is a safety hazard: the more unrelated guards a phase must edit, the
 * easier it is to smuggle a weakening edit past review.
 *
 * This module makes the review list explicit and singular. Historical tests keep
 * their own migration-specific assertions and simply derive the inventory half
 * from here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY MODEL — READ BEFORE EDITING
 * ─────────────────────────────────────────────────────────────────────────────
 * Approval is by EXACT FILENAME MEMBERSHIP in REVIEWED_MIGRATION_FILES below.
 *
 * A migration is NEVER approved because it:
 *   • exists in supabase/migrations/            (directory presence proves nothing)
 *   • has a number <= the maximum reviewed      (059_alternate_name.sql is rejected)
 *   • matches the NNN_name.sql naming pattern   (pattern is not review)
 *   • is numerically contiguous with its peers  (contiguity is not review)
 *   • matches a wildcard, prefix or range       (none are used here)
 *
 * The registry is hand-maintained and MUST NOT be derived from the filesystem —
 * deriving it would make every file on disk self-approving, which is precisely
 * the property these guards exist to deny.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADDING A MIGRATION (the whole workflow)
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Author the migration SQL.
 *   2. Add its exact filename to REVIEWED_MIGRATION_FILES below (once).
 *   3. Add that migration's own semantic / security / privacy tests.
 *   4. Run `npx vitest run supabase/migrations/__tests__` and full validation.
 *   5. Do NOT edit ceilings in historical test files — there are none left.
 *
 * This module is pure: no filesystem access, no I/O, no mutation, no imports
 * from production code, no environment-dependent behavior.
 */

/**
 * Every migration SQL file that has been explicitly reviewed, by exact filename.
 *
 * Ordering is the canonical ascending-number order and is asserted by the
 * manifest test. Note the deliberately irregular naming — 048/049 and 051–054
 * carry no `phoenix_` prefix while their neighbours do. That irregularity is
 * real, and it is exactly why this registry stores exact filenames instead of a
 * generated `NNN_phoenix_*.sql` pattern.
 */
export const REVIEWED_MIGRATION_FILES: readonly string[] = Object.freeze([
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
]);

/** Exact-membership index. Built once; never derived from disk. */
const REVIEWED_SET: ReadonlySet<string> = new Set(REVIEWED_MIGRATION_FILES);

/**
 * A numbered migration filename: exactly three digits, `_`, a name, `.sql`.
 * Used ONLY to classify what on disk is *claiming* to be a migration. Matching
 * this pattern grants nothing — approval still requires exact registry membership.
 */
const NUMBERED_MIGRATION_RE = /^(\d{3})_[A-Za-z0-9_]+\.sql$/;

/** Any `.sql` file, however named. Non-numbered SQL is surfaced, never ignored. */
const SQL_FILE_RE = /\.sql$/i;

/**
 * The migration number encoded in a filename, or null when the name is not a
 * well-formed numbered migration. Never throws — callers surface the null.
 */
export function extractMigrationNumber(fileName: string): number | null {
  const m = NUMBERED_MIGRATION_RE.exec(fileName);
  if (m === null) return null;
  return parseInt(m[1], 10);
}

/** True only when `fileName` is byte-for-byte a reviewed filename. */
export function isReviewedMigrationFile(fileName: string): boolean {
  return REVIEWED_SET.has(fileName);
}

/** True when a name claims to be a numbered migration (claim ≠ approval). */
export function isNumberedMigrationFile(fileName: string): boolean {
  return NUMBERED_MIGRATION_RE.test(fileName);
}

/** Deterministic order: by number, then by filename for equal numbers. */
export function sortMigrationFiles(files: readonly string[]): string[] {
  return [...files].sort((a, b) => {
    const na = extractMigrationNumber(a);
    const nb = extractMigrationNumber(b);
    if (na !== null && nb !== null && na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * Every actual `.sql` file that is not an exact reviewed filename.
 *
 * Deliberately covers non-numbered SQL too (e.g. `hotfix.sql`), so an
 * unreviewed file cannot hide by skipping the naming convention.
 */
export function findUnreviewedMigrationFiles(actualFiles: readonly string[]): string[] {
  return sortMigrationFiles(
    actualFiles.filter(f => SQL_FILE_RE.test(f) && !isReviewedMigrationFile(f)),
  );
}

/** Registry entries with no corresponding file on disk. */
export function findMissingReviewedMigrationFiles(actualFiles: readonly string[]): string[] {
  const actual = new Set(actualFiles);
  return REVIEWED_MIGRATION_FILES.filter(f => !actual.has(f));
}

/** `.sql` files that do not parse as `NNN_name.sql`. Surfaced, not ignored. */
export function findMalformedMigrationFiles(actualFiles: readonly string[]): string[] {
  return sortMigrationFiles(
    actualFiles.filter(f => SQL_FILE_RE.test(f) && !isNumberedMigrationFile(f)),
  );
}

/** Exact filenames appearing more than once in the registry. */
export function findDuplicateReviewedFilenames(): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const f of REVIEWED_MIGRATION_FILES) {
    if (seen.has(f)) dupes.add(f);
    seen.add(f);
  }
  return sortMigrationFiles([...dupes]);
}

/**
 * Migration numbers claimed by more than one registry filename.
 *
 * The repository currently contains no reviewed duplicates, so the manifest
 * test asserts this is empty. If a genuine duplicate is ever reviewed, document
 * it there deliberately rather than loosening this function.
 */
export function findDuplicateReviewedNumbers(): number[] {
  const byNumber = new Map<number, string[]>();
  for (const f of REVIEWED_MIGRATION_FILES) {
    const n = extractMigrationNumber(f);
    if (n === null) continue;
    byNumber.set(n, [...(byNumber.get(n) ?? []), f]);
  }
  return [...byNumber.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([n]) => n)
    .sort((a, b) => a - b);
}

/** Registry filenames that are not well-formed numbered migrations. */
export function findMalformedReviewedFilenames(): string[] {
  return REVIEWED_MIGRATION_FILES.filter(f => extractMigrationNumber(f) === null);
}

/**
 * Highest reviewed migration number, derived from the REGISTRY — never from the
 * migrations directory. A file on disk cannot raise this ceiling by existing.
 */
export function getMaximumReviewedMigrationNumber(): number {
  const numbers = REVIEWED_MIGRATION_FILES.map(extractMigrationNumber).filter(
    (n): n is number => n !== null,
  );
  return Math.max(...numbers);
}

/** The next number that has not been reviewed yet (max + 1). */
export function getNextUnreviewedMigrationNumber(): number {
  return getMaximumReviewedMigrationNumber() + 1;
}

/**
 * Reviewed filenames numbered strictly above `afterNumber`, in canonical order.
 *
 * This is the shared replacement for the old per-file "everything beyond NNN is
 * exactly this list" tail arrays. It still yields EXACT filenames — callers
 * compare disk contents against it with toEqual, so an unregistered file on disk
 * still fails.
 */
export function reviewedMigrationFilesAbove(afterNumber: number): string[] {
  return sortMigrationFiles(
    REVIEWED_MIGRATION_FILES.filter(f => {
      const n = extractMigrationNumber(f);
      return n !== null && n > afterNumber;
    }),
  );
}

/**
 * Reviewed filenames whose number falls within [from, to] inclusive, in
 * canonical order. Same exact-filename guarantee as reviewedMigrationFilesAbove.
 */
export function reviewedMigrationFilesBetween(from: number, to: number): string[] {
  return sortMigrationFiles(
    REVIEWED_MIGRATION_FILES.filter(f => {
      const n = extractMigrationNumber(f);
      return n !== null && n >= from && n <= to;
    }),
  );
}

/**
 * CN-2B / M211 — STATIC guard over the migration's executable SQL.
 *
 * Asserts against SQL with comments stripped, so prose can never satisfy a
 * check, and against string-blanked SQL for negative assertions, so a phrase
 * inside a RAISE message can never masquerade as the thing it forbids.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeSql, executableSql, sqlFunctionSource } from './helpers/sql-source';

const MIGRATIONS = join(__dirname, '..');

const FILENAME = '211_phoenix_central_needs_batch_and_disposition.sql';
const SQL = readFileSync(join(MIGRATIONS, FILENAME), 'utf8');
const CODE = activeSql(SQL);
const EXEC = executableSql(SQL);

const VERIFY_AT = CODE.indexOf('DO $verify$');
const IMPL = CODE.slice(0, VERIFY_AT);
const VERIFY = CODE.slice(VERIFY_AT);

const CLIENT_RPCS: ReadonlyArray<readonly [string, string]> = [
  ['phoenix_central_needs_set_record_disposition', 'uuid, text, text, uuid, text'],
  ['phoenix_central_needs_set_record_mapping', 'uuid, text, uuid'],
  ['phoenix_central_needs_abandon_import_session', 'uuid, text'],
  ['phoenix_central_needs_start_import_session', 'uuid, text, text, text, jsonb, bigint, text'],
  ['phoenix_central_needs_submit_revision', 'uuid'],
  ['phoenix_central_needs_review_readiness', 'uuid'],
];

const TRUSTED = [
  ['phoenix_central_needs_register_import_batch',
   'uuid, text, text, text, text, jsonb, jsonb, bigint, integer, jsonb'],
  ['_phoenix_central_needs_review_blockers_v1', 'uuid'],
] as const;

describe('CN-2B/211 batch + disposition — static', () => {
  it('is one transaction', () => {
    expect(CODE).toContain('BEGIN;');
    expect(CODE.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(CODE).not.toContain('ROLLBACK;');
  });

  it('never edits migration 209 or 210', () => {
    expect(EXEC).not.toContain('209_');
    expect(EXEC).not.toContain('210_');
  });

  it('fails closed on a completed pre-M211 import session', () => {
    expect(IMPL).toContain('211_precondition_failed');
    expect(IMPL).toMatch(/central_needs_import_sessions\s+WHERE\s+status\s*=\s*'completed'/);
  });

  it('creates no backfill of batch lineage', () => {
    // A pre-M211 completed session is refused, never invented a batch for.
    expect(IMPL).not.toMatch(/INSERT\s+INTO\s+public\.central_needs_import_batches[\s\S]{0,400}SELECT[\s\S]{0,200}central_needs_import_sessions/);
  });

  it('evolves the existing mapping table rather than creating a parallel ledger', () => {
    expect(IMPL).toContain('ALTER TABLE public.central_needs_record_mappings');
    expect(IMPL).toContain('ALTER COLUMN central_item_id DROP NOT NULL');
    expect(IMPL).toContain('ADD COLUMN decision');
    // No second mapping table anywhere.
    expect(EXEC).not.toMatch(/CREATE TABLE public\.central_needs_(record_)?mappings_v2/);
    expect(EXEC).not.toMatch(/CREATE TABLE public\.central_needs_dispositions/);
  });

  it('drops the decision DEFAULT so every write states its decision', () => {
    expect(IMPL).toContain('ALTER COLUMN decision DROP DEFAULT');
  });

  it('constrains the two decisions to be complete and mutually exclusive', () => {
    expect(IMPL).toContain("CHECK (decision IN ('mapped', 'not_applicable'))");
    const chk = IMPL.slice(IMPL.indexOf('central_needs_record_mappings_disposition_chk'));
    expect(chk).toMatch(/decision = 'mapped'[\s\S]{0,200}central_item_id IS NOT NULL/);
    expect(chk).toMatch(/decision = 'not_applicable'[\s\S]{0,200}central_item_id IS NULL/);
    expect(chk).toMatch(/decision = 'not_applicable'[\s\S]{0,300}btrim\(decision_reason\) <> ''/);
  });

  it('preserves UNIQUE (import_session_id, target_entity)', () => {
    // M210 created it and M211 must not drop it.
    expect(EXEC).not.toMatch(/DROP CONSTRAINT[\s\S]{0,120}import_session_id_target_entity/);
    expect(IMPL).toContain('ON CONFLICT (import_session_id, target_entity) DO UPDATE');
  });

  it('creates both batch relations with RLS enabled AND forced', () => {
    for (const table of ['central_needs_import_batches', 'central_needs_import_batch_entries']) {
      expect(IMPL).toContain(`CREATE TABLE public.${table} (`);
      expect(IMPL).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(IMPL).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
      expect(IMPL).toContain(`REVOKE INSERT, UPDATE, DELETE ON TABLE public.${table} FROM authenticated`);
      expect(IMPL).toContain(`GRANT SELECT ON TABLE public.${table} TO authenticated`);
    }
  });

  it('gives the batch tables a SELECT policy on central_needs.view and no write policy', () => {
    expect(IMPL).toMatch(/central_needs_import_batches_select_authorized[\s\S]{0,260}central_needs\.view/);
    expect(IMPL).toMatch(/central_needs_import_batch_entries_select_authorized[\s\S]{0,260}central_needs\.view/);
    expect(EXEC).not.toMatch(/CREATE POLICY[\s\S]{0,160}FOR (INSERT|UPDATE|DELETE|ALL)[\s\S]{0,120}central_needs_import_batch/);
  });

  it('keeps the container hash and the entry hash as separate columns', () => {
    const batches = IMPL.slice(
      IMPL.indexOf('CREATE TABLE public.central_needs_import_batches'),
      IMPL.indexOf('CREATE TABLE public.central_needs_import_batch_entries'));
    expect(batches).toContain('container_sha256');
    expect(batches).not.toContain('entry_sha256');

    const entries = IMPL.slice(IMPL.indexOf('CREATE TABLE public.central_needs_import_batch_entries'));
    expect(entries).toContain('entry_sha256');
    expect(entries).toContain('archive_entry_path');
    // The VERIFY block re-proves this at apply time.
    expect(VERIFY).toContain('must not carry an entry-level hash column');
  });

  it('binds batch membership declaratively to one revision and one organization', () => {
    expect(IMPL).toContain('central_needs_import_sessions_id_revision_org_key');
    expect(IMPL).toMatch(/FOREIGN KEY \(import_session_id, plan_revision_id, organization_id\)/);
    expect(IMPL).toMatch(/FOREIGN KEY \(batch_id, plan_revision_id, organization_id\)/);
    // One session belongs to at most one batch, globally.
    expect(IMPL).toMatch(/UNIQUE \(import_session_id\)/);
  });

  it('every client RPC is granted to authenticated and revoked from anon', () => {
    for (const [name, args] of CLIENT_RPCS) {
      expect(sqlFunctionSource(SQL, name), `${name} missing`).not.toBeNull();
      expect(IMPL).toContain(`REVOKE ALL ON FUNCTION public.${name}(${args}) FROM PUBLIC, anon;`);
      expect(IMPL).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(${args}) TO authenticated;`);
    }
  });

  it('the trusted surfaces are revoked from authenticated and never granted', () => {
    for (const [name, args] of TRUSTED) {
      expect(sqlFunctionSource(SQL, name), `${name} missing`).not.toBeNull();
      expect(IMPL).toContain(`REVOKE ALL ON FUNCTION public.${name}(${args})`);
      expect(IMPL).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\)\\s*\\n?\\s*FROM PUBLIC, anon, authenticated`));
      expect(IMPL).not.toContain(`GRANT EXECUTE ON FUNCTION public.${name}(${args}) TO authenticated`);
    }
  });

  it('every function pins search_path and is SECURITY DEFINER', () => {
    const defs = CODE.match(/CREATE OR REPLACE FUNCTION public\.[a-z_0-9]+/g) ?? [];
    expect(defs.length).toBeGreaterThanOrEqual(7);
    for (const name of defs.map((d) => d.replace('CREATE OR REPLACE FUNCTION public.', ''))) {
      const src = sqlFunctionSource(SQL, name);
      expect(src, name).not.toBeNull();
      expect(src, name).toContain('SECURITY DEFINER');
      expect(src, name).toContain('SET search_path = public, pg_temp');
    }
  });

  it('the batch writer demands a node runtime and refuses anything else', () => {
    const src = sqlFunctionSource(SQL, 'phoenix_central_needs_register_import_batch')!;
    expect(src).toMatch(/p_parser_identity->>'runtime'[\s\S]{0,40}<>\s*'node'/);
    expect(src).toContain('batch_registration_must_be_node_runtime');
  });

  it('the batch writer validates the WHOLE manifest before inserting anything', () => {
    const src = sqlFunctionSource(SQL, 'phoenix_central_needs_register_import_batch')!;
    const firstInsert = src.indexOf('INSERT INTO public.central_needs_import_batches');
    expect(firstInsert).toBeGreaterThan(0);
    const before = src.slice(0, firstInsert);
    for (const check of [
      'batch_entry_requires_ordinal_sha256_and_session',
      'batch_entry_ordinals_must_be_exactly_one_through_n',
      'batch_entry_session_must_be_completed_in_this_revision',
      'batch_entry_sha256_does_not_match_session_source_file',
      '_phoenix_central_needs_assert_org_live_v1',
      '_phoenix_central_needs_assert_draft_v1',
    ]) {
      expect(before, `${check} must precede the first INSERT`).toContain(check);
    }
  });

  it('submit enforces all five completeness preconditions through ONE predicate', () => {
    const src = sqlFunctionSource(SQL, 'phoenix_central_needs_submit_revision')!;
    expect(src).toContain('_phoenix_central_needs_review_blockers_v1');
    for (const blocker of [
      'no_finalized_import',
      'import_session_still_open',
      'completed_session_not_in_trusted_batch',
      'incomplete_trusted_batch',
      'target_entity_without_disposition',
    ]) {
      expect(src, blocker).toContain(blocker);
    }
  });

  it('the readiness projection reuses the same predicate as the gate', () => {
    const src = sqlFunctionSource(SQL, 'phoenix_central_needs_review_readiness')!;
    expect(src).toContain('_phoenix_central_needs_review_blockers_v1');
    expect(src).toContain("'central_needs.view'");
  });

  it('a failed session never blocks submission', () => {
    const src = sqlFunctionSource(SQL, '_phoenix_central_needs_review_blockers_v1')!;
    expect(src).toMatch(/status IN \('pending', 'processing'\)/);
    // 'failed' appears nowhere as a blocking condition.
    expect(src).not.toMatch(/status IN \([^)]*'failed'/);
  });

  it('never infers a disposition from workbook structure', () => {
    // No heuristic vocabulary anywhere in executable SQL.
    for (const word of ['subtotal', 'footer', 'continuation', 'heuristic', 'guess']) {
      expect(EXEC.toLowerCase(), word).not.toContain(word);
    }
  });

  it('start_import gains explicit retry semantics and fails closed', () => {
    // The semantics live in the entry-aware function; the 7-argument M210 form
    // delegates to it, so this asserts against the single real definition.
    const src = sqlFunctionSource(SQL, 'phoenix_central_needs_start_import_entry_session')!;
    expect(src).toMatch(/v_session\.status = 'completed'/);
    expect(src).toMatch(/v_session\.status IN \('pending', 'processing'\)/);
    expect(src).toMatch(/v_session\.status = 'failed'/);
    expect(src).toContain('import_session_unexpected_state');
  });

  it('abandon requires a reason, is draft-only, and never touches evidence', () => {
    const src = sqlFunctionSource(SQL, 'phoenix_central_needs_abandon_import_session')!;
    expect(src).toContain('abandon_reason_required');
    expect(src).toContain('_phoenix_central_needs_assert_draft_v1');
    expect(src).toContain("'central_needs.import'");
    expect(src).toContain('import_session_not_abandonable');
    expect(src).not.toContain('central_needs_source_records');
    expect(src).not.toMatch(/DELETE\s+FROM/);
  });

  it('never invents automatic timeout semantics', () => {
    for (const word of ['interval', 'age(', 'now() -', 'timeout']) {
      expect(EXEC.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it('every client write is audited', () => {
    for (const name of [
      'phoenix_central_needs_set_record_disposition',
      'phoenix_central_needs_abandon_import_session',
      'phoenix_central_needs_submit_revision',
      'phoenix_central_needs_register_import_batch',
    ]) {
      expect(sqlFunctionSource(SQL, name), name).toContain('INSERT INTO public.audit_logs');
    }
  });

  it('authorizes before disclosing revision state', () => {
    for (const name of [
      'phoenix_central_needs_set_record_disposition',
      'phoenix_central_needs_abandon_import_session',
    ]) {
      const src = sqlFunctionSource(SQL, name)!;
      const guard = src.indexOf('_phoenix_central_needs_guard_v1');
      const draft = src.indexOf('_phoenix_central_needs_assert_draft_v1');
      expect(guard, name).toBeGreaterThan(0);
      expect(draft, name).toBeGreaterThan(guard);
    }
  });

  it('creates no permission key, no grant, and never central_needs.send', () => {
    expect(IMPL).not.toContain('INSERT INTO public.permission_keys');
    expect(IMPL).not.toContain('INSERT INTO public.role_permission_defaults');
    expect(IMPL).not.toContain('profile_permission_overrides');
    // The only mention is the VERIFY block's negative assertion.
    expect(IMPL).not.toContain('central_needs.send');
    expect(VERIFY).toContain('central_needs.send');
  });

  it('touches no stock, movement, transfer or suggestion surface', () => {
    for (const forbidden of [
      'stock_movements', 'warehouse_transfer', 'inventory_transfer_suggestions',
      'movement_lines', 'central_needs.send',
    ]) {
      expect(IMPL, forbidden).not.toContain(forbidden);
    }
  });

  it('restricts Central Needs to the eligible role class, without editing M209', () => {
    const src = sqlFunctionSource(SQL, '_phoenix_central_needs_role_eligible_v1')!;
    expect(src).toContain("'super_admin'");
    expect(src).toContain("'central_warehouse_manager'");
    // Strictly boolean: a NULL would make `IF NOT eligible THEN RAISE` skip its
    // own RAISE, which is fail-OPEN in the write guard.
    expect(src).toContain('COALESCE(public.phoenix_my_role()');
    // No other role name is admitted anywhere in the predicate.
    for (const role of ['institution_admin', 'outlet_officer', 'warehouse_officer', 'health_center_manager']) {
      expect(src, role).not.toContain(role);
    }
    // The narrowing is RESTRICTIVE (ANDs with M209's permissive policies), so
    // M209's own file is untouched.
    expect(IMPL).toContain('AS RESTRICTIVE FOR ALL TO authenticated');
    expect(IMPL).toContain('_role_eligible_restrictive');
  });

  it('keeps the capability check BESIDE the role check, never instead of it', () => {
    const guard = sqlFunctionSource(SQL, '_phoenix_central_needs_guard_v1')!;
    const roleAt = guard.indexOf('_phoenix_central_needs_role_eligible_v1');
    const capAt = guard.indexOf('phoenix_status_center_authorized');
    expect(roleAt).toBeGreaterThan(0);
    expect(capAt).toBeGreaterThan(roleAt);
    expect(guard).toContain('forbidden_central_needs_role');
    // The existing identifier survives as a substring, so every M210 assertion
    // about a refused caller keeps its exact meaning.
    expect(guard).toContain('forbidden_central_needs');
    expect(guard).toContain('_phoenix_central_needs_assert_org_live_v1');
  });

  it('gives an archive entry its own session identity', () => {
    expect(IMPL).toContain('ADD COLUMN entry_path');
    expect(IMPL).toContain('central_needs_import_sessions_live_entry_uidx');
    // Live-entry uniqueness, with failed attempts excluded so a retry is possible.
    expect(IMPL).toMatch(/UNIQUE INDEX[\s\S]{0,200}COALESCE\(entry_path, ''\)[\s\S]{0,80}WHERE status <> 'failed'/);
    const entry = sqlFunctionSource(SQL, 'phoenix_central_needs_start_import_entry_session')!;
    expect(entry).toContain("COALESCE(entry_path, '') = COALESCE(v_entry, '')");
    // M210's 7-argument form is preserved and delegates with a NULL entry.
    const legacy = sqlFunctionSource(SQL, 'phoenix_central_needs_start_import_session')!;
    expect(legacy).toContain('phoenix_central_needs_start_import_entry_session');
  });

  it('binds a manifest entry to the session that recorded that entry path', () => {
    const src = sqlFunctionSource(SQL, 'phoenix_central_needs_register_import_batch')!;
    expect(src).toContain('batch_entry_path_does_not_match_session_entry_path');
  });

  it('treats a batch retry as exact only when EVERY recorded semantic matches', () => {
    const src = sqlFunctionSource(SQL, 'phoenix_central_needs_register_import_batch')!;
    for (const field of [
      'v_existing.container_kind', 'v_existing.container_filename',
      'v_existing.container_byte_size', 'v_existing.storage_locator',
      'v_existing.excluded_entry_count', 'v_existing.reconciliation',
      'v_existing.parser_identity', 'v_existing.accepted_entry_count',
      'v_existing_manifest',
    ]) {
      expect(src, field).toContain(field);
    }
    expect(src).toContain('import_batch_already_registered_with_different_evidence');
  });

  it('the VERIFY block re-proves the privilege and permission surface', () => {
    expect(VERIFY).toContain('VERIFY FAILED (211)');
    expect(VERIFY).toContain('relrowsecurity');
    expect(VERIFY).toContain('relforcerowsecurity');
    expect(VERIFY).toContain('has_function_privilege');
    expect(VERIFY).toContain('aclexplode');
    expect(VERIFY).toContain('role_permission_defaults');
  });
});

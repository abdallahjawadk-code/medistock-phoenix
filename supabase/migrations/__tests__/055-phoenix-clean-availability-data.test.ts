/**
 * PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A (physical-delete revision)
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 055: phoenix_clean_availability_data.
 * A Super Admin-only, dry-run-first RPC that PHYSICALLY DELETES
 * item_availability, item_availability_movements, and every inter-org
 * alert/exchange row that transitively references them, in strict FK-safe
 * order, while leaving every structural/system table untouched. No live DB
 * is used — these are text/shape assertions against the SQL file, mirroring
 * the 042/053 tests' conventions.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../');
const MIGRATION_055_PATH = join(MIGRATIONS_DIR, '055_phoenix_clean_availability_data.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

/** Strip `--` comment lines, leaving only active SQL for whole-file guardrails. */
function activeSql(sql: string): string {
  return sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
}

function extractFunction(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const afterStart = sql.indexOf('AS $$', start) + 'AS $$'.length;
  const end = sql.indexOf('\n$$;', afterStart);
  return sql.slice(start, end);
}

const migration055 = readMigration('055_phoenix_clean_availability_data.sql');
const fnBody = extractFunction(migration055, 'phoenix_clean_availability_data');

describe('Migration 055 exists exactly once', () => {
  it('055_phoenix_clean_availability_data.sql exists', () => {
    expect(existsSync(MIGRATION_055_PATH)).toBe(true);
  });

  it('is the only file named 055_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('055_'));
    expect(matches).toEqual(['055_phoenix_clean_availability_data.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    expect(migration055).toContain('MANUAL APPLY ONLY');
    expect(migration055).toContain('supabase db push');
  });

  it('has a DO $$ ... VERIFY block with ASSERT statements', () => {
    expect(migration055).toContain('DO $$');
    expect(migration055).toContain('ASSERT');
  });
});

describe('Migration 055: RPC signature and security properties', () => {
  it('defines public.phoenix_clean_availability_data(p_dry_run boolean DEFAULT true, p_confirmation text DEFAULT NULL)', () => {
    expect(migration055).toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_clean_availability_data\(\s*p_dry_run\s+boolean\s+DEFAULT\s+true,\s*p_confirmation\s+text\s+DEFAULT\s+NULL\s*\)/);
  });

  it('returns jsonb', () => {
    expect(migration055).toMatch(/RETURNS jsonb/);
  });

  it('is SECURITY DEFINER with SET search_path = public', () => {
    const header = migration055.slice(migration055.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_clean_availability_data'));
    expect(header).toMatch(/SECURITY DEFINER/);
    expect(header).toMatch(/SET search_path = public/);
  });

  it('rejects unauthenticated callers', () => {
    expect(fnBody).toContain('NOT_AUTHENTICATED');
    expect(fnBody).toContain('auth.uid()');
  });

  it('performs an explicit super_admin role check (not just a frontend gate)', () => {
    expect(fnBody).toMatch(/SELECT role INTO v_role FROM public\.profiles WHERE id = v_actor/);
    expect(fnBody).toMatch(/v_role IS DISTINCT FROM 'super_admin'/);
    expect(fnBody).toContain('INSUFFICIENT_ROLE');
  });
});

describe('Migration 055: confirmation phrase is exactly DEEP CLEAN AVAILABILITY', () => {
  it("v_required is set to exactly 'DEEP CLEAN AVAILABILITY'", () => {
    expect(fnBody).toContain("v_required text := 'DEEP CLEAN AVAILABILITY';");
  });

  it('execute branch rejects any mismatch with INVALID_CONFIRMATION', () => {
    expect(fnBody).toMatch(/p_confirmation IS DISTINCT FROM v_required/);
    expect(fnBody).toContain('INVALID_CONFIRMATION');
  });
});

describe('Migration 055: dry-run branch is fully read-only', () => {
  const dryRunIdx = fnBody.indexOf('IF p_dry_run THEN');
  const dryRunBlock = fnBody.slice(dryRunIdx, fnBody.indexOf('END IF;', dryRunIdx));

  it('dry-run branch exists', () => {
    expect(dryRunIdx).toBeGreaterThan(-1);
  });

  it('dry-run branch contains no DELETE statement', () => {
    expect(dryRunBlock).not.toMatch(/\bDELETE\b/i);
  });

  it('dry-run branch contains no UPDATE statement', () => {
    expect(dryRunBlock).not.toMatch(/\bUPDATE\b/i);
  });

  it('dry-run branch contains no audit_logs INSERT', () => {
    expect(dryRunBlock).not.toMatch(/INSERT INTO/i);
  });

  it('dry-run branch returns ok=true, dryRun=true, strategy, confirmationRequired, warning, counts, protectedTables', () => {
    expect(dryRunBlock).toContain("'ok', true");
    expect(dryRunBlock).toContain("'dryRun', true");
    expect(dryRunBlock).toContain("'strategy', 'physical_delete_operational_availability'");
    expect(dryRunBlock).toContain("'confirmationRequired', v_required");
    expect(dryRunBlock).toContain("'warning'");
    expect(dryRunBlock).toMatch(/permanently and physically deleted/i);
    expect(dryRunBlock).toContain("'counts', v_counts_before");
    expect(dryRunBlock).toContain("'protectedTables'");
  });

  it('dry-run counts cover exactly the six operational tables', () => {
    expect(fnBody).toMatch(/v_counts_before := jsonb_build_object\(\s*\n\s*'inter_org_exchange_events',\s*v_exchange_events_total,\s*\n\s*'inter_org_exchange_requests',\s*v_exchange_requests_total,\s*\n\s*'inter_org_alert_events',\s*v_alert_events_total,\s*\n\s*'inter_org_alert_states',\s*v_alert_states_total,\s*\n\s*'item_availability_movements',\s*v_movements_total,\s*\n\s*'item_availability',\s*v_availability_total/);
  });
});

describe('Migration 055: physical DELETE in the exact required order', () => {
  it('DELETE statements appear for all six tables', () => {
    expect(fnBody).toContain('DELETE FROM public.inter_org_exchange_events;');
    expect(fnBody).toContain('DELETE FROM public.inter_org_exchange_requests;');
    expect(fnBody).toContain('DELETE FROM public.inter_org_alert_events;');
    expect(fnBody).toContain('DELETE FROM public.inter_org_alert_states;');
    expect(fnBody).toContain('DELETE FROM public.item_availability_movements;');
    expect(fnBody).toContain('DELETE FROM public.item_availability;');
  });

  it('the DELETE order is exactly: exchange_events -> exchange_requests -> alert_events -> alert_states -> movements -> item_availability', () => {
    const order = [
      'DELETE FROM public.inter_org_exchange_events;',
      'DELETE FROM public.inter_org_exchange_requests;',
      'DELETE FROM public.inter_org_alert_events;',
      'DELETE FROM public.inter_org_alert_states;',
      'DELETE FROM public.item_availability_movements;',
      'DELETE FROM public.item_availability;',
    ];
    const positions = order.map(stmt => fnBody.indexOf(stmt));
    for (const p of positions) expect(p).toBeGreaterThan(-1);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it('all six DELETEs occur after the confirmation check (never in the dry-run branch)', () => {
    const dryRunEnd = fnBody.indexOf('END IF;', fnBody.indexOf('IF p_dry_run THEN'));
    const confirmCheckIdx = fnBody.indexOf('INVALID_CONFIRMATION');
    const firstDeleteIdx = fnBody.indexOf('DELETE FROM public.inter_org_exchange_events;');
    expect(confirmCheckIdx).toBeGreaterThan(dryRunEnd);
    expect(firstDeleteIdx).toBeGreaterThan(confirmCheckIdx);
  });

  it('records rows deleted per table via GET DIAGNOSTICS', () => {
    expect(fnBody).toMatch(/GET DIAGNOSTICS v_exchange_events_deleted = ROW_COUNT;/);
    expect(fnBody).toMatch(/GET DIAGNOSTICS v_exchange_requests_deleted = ROW_COUNT;/);
    expect(fnBody).toMatch(/GET DIAGNOSTICS v_alert_events_deleted = ROW_COUNT;/);
    expect(fnBody).toMatch(/GET DIAGNOSTICS v_alert_states_deleted = ROW_COUNT;/);
    expect(fnBody).toMatch(/GET DIAGNOSTICS v_movements_deleted = ROW_COUNT;/);
    expect(fnBody).toMatch(/GET DIAGNOSTICS v_availability_deleted = ROW_COUNT;/);
  });

  it('never uses TRUNCATE as active SQL in the function body (comments describing the design decision are fine)', () => {
    expect(activeSql(fnBody)).not.toMatch(/TRUNCATE/i);
  });

  // FIX-MIGRATION-055-TRUNCATE-VERIFY-FALSE-POSITIVE-A: the VERIFY block's
  // own TRUNCATE ASSERT previously ran a naive ILIKE '%TRUNCATE%' against the
  // full function source (including comments), so a prose comment merely
  // explaining "DELETE only — never TRUNCATE" tripped the assertion on a
  // clean function that never actually ran TRUNCATE — a false positive that
  // blocked manual apply in Supabase SQL Editor. These tests guard against
  // that exact class of bug recurring.
  it('the function body itself contains no literal "TRUNCATE" anywhere, comments included (root cause of the original false positive — safest fix is to never say the word in the body at all)', () => {
    expect(fnBody).not.toMatch(/TRUNCATE/i);
  });

  it('the VERIFY block strips comments before checking for TRUNCATE, so this class of false positive cannot recur even if a future comment mentions the word', () => {
    const verifyBlock = migration055.slice(migration055.indexOf('DO $$', migration055.indexOf('GRANT EXECUTE')));
    expect(verifyBlock).toContain("v_active_sql := regexp_replace(v_fn_src, '--[^\\n]*', '', 'g');");
    expect(verifyBlock).toMatch(/ASSERT v_active_sql NOT ILIKE '%TRUNCATE%'/);
    // The TRUNCATE assertion must be checked against the stripped copy, not
    // the raw v_fn_src directly.
    expect(verifyBlock).not.toMatch(/ASSERT v_fn_src NOT ILIKE '%TRUNCATE%'/);
  });
});

describe('Migration 055: no protected table is ever deleted from', () => {
  const protectedTables = [
    'organizations', 'warehouses', 'distribution_points', 'local_items',
    'central_items', 'profiles', 'permission_keys', 'role_permission_defaults',
    'profile_permission_overrides', 'qr_targets', 'qr_tokens',
    'organization_status_contacts', 'user_identity_history',
    'audit_logs', 'institution_item_status_reports',
  ];

  it.each(protectedTables)('no DELETE FROM public.%s in the function body', (table) => {
    const re = new RegExp(`DELETE FROM public\\.${table}\\b`, 'i');
    expect(fnBody).not.toMatch(re);
  });

  it('no DELETE FROM auth.users in the function body (the VERIFY block\'s own defensive ASSERT literal mentioning the phrase does not count)', () => {
    expect(fnBody).not.toMatch(/DELETE FROM auth\.users/i);
  });

  it('has no DROP TABLE or DROP FUNCTION', () => {
    expect(activeSql(migration055)).not.toMatch(/DROP TABLE|DROP FUNCTION/i);
  });
});

describe('Migration 055: audit logging (execute path only)', () => {
  it('inserts into audit_logs with action = availability_data_deep_cleaned, entity_type = system', () => {
    expect(fnBody).toContain('INSERT INTO public.audit_logs');
    expect(fnBody).toContain("'availability_data_deep_cleaned'");
    expect(fnBody).toContain("'system'");
  });

  it('audit payload records strategy, counts_before, counts_after, rows_deleted_by_table, protected_tables_preserved, confirmation_used, executed_at', () => {
    const insertIdx = fnBody.indexOf('INSERT INTO public.audit_logs');
    const auditBlock = fnBody.slice(insertIdx, fnBody.indexOf('RETURN jsonb_build_object', insertIdx));
    expect(auditBlock).toContain("'strategy', 'physical_delete_operational_availability'");
    expect(auditBlock).toContain("'dryRun', false");
    expect(auditBlock).toContain("'counts_before', v_counts_before");
    expect(auditBlock).toContain("'counts_after', v_counts_after");
    expect(auditBlock).toContain("'rows_deleted_by_table', v_rows_deleted");
    expect(auditBlock).toContain("'protected_tables_preserved', true");
    expect(auditBlock).toContain("'confirmation_used', true");
    expect(auditBlock).toContain("'executed_at', now()");
  });

  it('the audit INSERT occurs only after all six DELETEs (execute path), never in the dry-run branch', () => {
    const dryRunIdx = fnBody.indexOf('IF p_dry_run THEN');
    const dryRunEnd = fnBody.indexOf('END IF;', dryRunIdx);
    const lastDeleteIdx = fnBody.indexOf('DELETE FROM public.item_availability;');
    const insertIdx = fnBody.indexOf('INSERT INTO public.audit_logs');
    expect(insertIdx).toBeGreaterThan(dryRunEnd);
    expect(insertIdx).toBeGreaterThan(lastDeleteIdx);
  });
});

describe('Migration 055: execute success payload', () => {
  it('returns ok=true, dryRun=false, strategy, countsBefore, countsAfter, rowsDeletedByTable', () => {
    const tail = fnBody.slice(fnBody.lastIndexOf('RETURN jsonb_build_object'));
    expect(tail).toContain("'ok', true");
    expect(tail).toContain("'dryRun', false");
    expect(tail).toContain("'strategy', 'physical_delete_operational_availability'");
    expect(tail).toContain("'countsBefore', v_counts_before");
    expect(tail).toContain("'countsAfter', v_counts_after");
    expect(tail).toContain("'rowsDeletedByTable', v_rows_deleted");
  });
});

describe('Migration 055: grants (authenticated only, no anon)', () => {
  it('REVOKEs from PUBLIC/anon and GRANTs EXECUTE to authenticated', () => {
    expect(migration055).toContain('REVOKE ALL ON FUNCTION public.phoenix_clean_availability_data(boolean, text) FROM PUBLIC, anon;');
    expect(migration055).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_clean_availability_data(boolean, text) TO authenticated;');
  });

  it('no GRANT EXECUTE to anon anywhere in the file', () => {
    expect(activeSql(migration055)).not.toMatch(/GRANT EXECUTE[^;]*TO\s+anon/i);
  });
});

describe('Migration 055: does not touch unrelated RPCs, policies, or migrations', () => {
  it('does not redefine clear_port_availability, phoenix_apply_availability_movement, or phoenix_upsert_availability', () => {
    expect(migration055).not.toContain('CREATE OR REPLACE FUNCTION public.clear_port_availability');
    expect(migration055).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement');
    expect(migration055).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability');
  });

  it('does not touch get_public_qr_payload, qr_tokens, or qr_targets schema', () => {
    expect(migration055).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_public_qr_payload/);
    expect(activeSql(migration055)).not.toMatch(/ALTER TABLE[^;]*qr_tokens|ALTER TABLE[^;]*qr_targets/);
  });

  it('does not CREATE POLICY or ALTER TABLE on any table', () => {
    const active = activeSql(migration055);
    expect(active).not.toMatch(/CREATE POLICY/i);
    expect(active).not.toMatch(/ALTER TABLE/i);
  });

  it('all prior migration files (001-054) still exist untouched by filename', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0[0-4][0-9]_|^05[0-4]_/.test(f));
    expect(matches.length).toBeGreaterThanOrEqual(54);
  });
});

describe('Migration 055: security guardrails', () => {
  it('no service_role reference in active SQL', () => {
    expect(activeSql(migration055)).not.toMatch(/service_role/i);
  });

  it('no auth.admin reference', () => {
    expect(activeSql(migration055)).not.toMatch(/auth\.admin/i);
  });

  it('no React/TSX component syntax (SQL-only file)', () => {
    expect(migration055).not.toMatch(/import React|export function|useState|useEffect/);
  });
});

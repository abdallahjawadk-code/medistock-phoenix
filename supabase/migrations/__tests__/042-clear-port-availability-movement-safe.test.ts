/**
 * BUGFIX-CLEAR-PORT-AVAILABILITY-RPC-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 042: clear_port_availability no
 * longer hard-DELETEs item_availability rows (which violated the ON DELETE
 * RESTRICT FK from item_availability_movements whenever a port had any
 * quantity-movement history — migration 033). It now UPDATEs every row in
 * scope to quantity = 0, condition = 'missing', preserving the row id (and
 * therefore every FK pointing at it: item_availability_movements/033,
 * inter_org_alert_states/038, inter_org_exchange_requests/040). No live DB
 * is used — these are text/shape assertions against the SQL file, mirroring
 * the 035 and 041 tests' conventions.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../');
const MIGRATION_042_PATH = join(MIGRATIONS_DIR, '042_phoenix_clear_port_availability_movement_safe.sql');

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

const migration042 = readMigration('042_phoenix_clear_port_availability_movement_safe.sql');
const fnBody = extractFunction(migration042, 'clear_port_availability');

describe('Migration 042 exists exactly once', () => {
  it('042_phoenix_clear_port_availability_movement_safe.sql exists', () => {
    expect(existsSync(MIGRATION_042_PATH)).toBe(true);
  });

  it('is the only file named 042_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('042_'));
    expect(matches).toEqual(['042_phoenix_clear_port_availability_movement_safe.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    expect(migration042).toContain('MANUAL APPLY ONLY');
    expect(migration042).toContain('supabase db push');
  });

  it('has a DO $$ ... VERIFY block with ASSERT statements', () => {
    expect(migration042).toContain('DO $$');
    expect(migration042).toContain('ASSERT');
  });
});

describe('Migration 042: does not modify migrations 001-041', () => {
  it('007_phoenix_clear_port_availability.sql is untouched (still the original delete-based definition)', () => {
    const sql007 = readMigration('007_phoenix_clear_port_availability.sql');
    expect(sql007).toContain('delete from item_availability where distribution_point_id = p_point_id;');
  });

  it('033/038/040 filenames are unchanged (no duplicate numbering introduced)', () => {
    for (const [prefix, name] of [
      ['033_', '033_phoenix_availability_movements_schema.sql'],
      ['038_', '038_phoenix_inter_org_alert_lifecycle_schema.sql'],
      ['040_', '040_phoenix_inter_org_exchange_schema.sql'],
      ['041_', '041_phoenix_inter_org_exchange_rpcs.sql'],
    ] as const) {
      expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith(prefix))).toEqual([name]);
    }
  });

  it('all prior migration files (001-041) still exist', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0[0-3][0-9]_|^04[01]_/.test(f));
    expect(matches.length).toBeGreaterThanOrEqual(41);
  });
});

describe('Migration 042: redefines clear_port_availability with the same signature', () => {
  it('uses CREATE OR REPLACE FUNCTION public.clear_port_availability(p_point_id uuid, p_confirmation text)', () => {
    expect(migration042).toMatch(/CREATE OR REPLACE FUNCTION public\.clear_port_availability\(\s*p_point_id\s+uuid,\s*p_confirmation\s+text\s*\)/);
  });

  it('returns jsonb, same as the original', () => {
    expect(migration042).toMatch(/RETURNS jsonb/);
  });

  it('preserves SECURITY DEFINER and SET search_path', () => {
    expect(fnBody.length).toBeGreaterThan(0);
    const header = migration042.slice(migration042.indexOf('CREATE OR REPLACE FUNCTION public.clear_port_availability'));
    expect(header).toMatch(/SECURITY DEFINER/);
    expect(header).toMatch(/SET search_path = public/);
  });
});

describe('Migration 042: never deletes item_availability, movements, or audit_logs', () => {
  it('does not DELETE FROM item_availability', () => {
    expect(fnBody).not.toMatch(/DELETE FROM item_availability\b/i);
    expect(fnBody).not.toMatch(/DELETE FROM public\.item_availability\b/i);
  });

  it('does not DELETE FROM item_availability_movements', () => {
    // Scoped to the function body — the migration header/VERIFY-block prose
    // legitimately mentions this phrase while documenting/checking its absence.
    expect(fnBody).not.toMatch(/DELETE FROM item_availability_movements/i);
  });

  it('does not DELETE FROM audit_logs', () => {
    expect(fnBody).not.toMatch(/DELETE FROM audit_logs/i);
  });

  it('has no TRUNCATE anywhere in the file', () => {
    expect(activeSql(migration042)).not.toMatch(/TRUNCATE/i);
  });

  it('has no DROP TABLE or DROP FUNCTION', () => {
    expect(activeSql(migration042)).not.toMatch(/DROP TABLE|DROP FUNCTION/i);
  });
});

describe('Migration 042: rows with movement history are UPDATEd, not deleted', () => {
  it('computes items_with_movement_history via EXISTS against item_availability_movements (read-only)', () => {
    expect(fnBody).toContain('v_with_history');
    expect(fnBody).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM item_availability_movements m/);
  });

  it('the UPDATE sets quantity = 0 and condition = \'missing\' unconditionally for the port (not branched by history)', () => {
    expect(fnBody).toMatch(/UPDATE item_availability\s*\n\s*SET quantity\s*=\s*0,\s*\n\s*condition\s*=\s*'missing'/);
    expect(fnBody).toMatch(/WHERE distribution_point_id = p_point_id/);
  });

  it('does not branch DELETE vs UPDATE by movement-history existence (single UPDATE statement, no history-based DELETE branch)', () => {
    expect(fnBody).not.toMatch(/IF\s+.*v_with_history.*THEN[\s\S]*DELETE/i);
  });

  it('sets last_updated_by so the actor-snapshot trigger records who cleared the port', () => {
    expect(fnBody).toContain('last_updated_by  = v_actor_id');
  });

  it('the returned mode field documents the zeroed-not-deleted behavior', () => {
    expect(fnBody).toContain("'mode', 'zeroed_not_deleted'");
  });
});

describe('Migration 042: preserves role, org-scope, and confirmation-phrase checks from 007', () => {
  it('rejects unauthenticated callers', () => {
    expect(fnBody).toContain('NOT_AUTHENTICATED');
    expect(fnBody).toContain('auth.uid()');
  });

  it('allows exactly super_admin, hospital_admin, warehouse_manager', () => {
    expect(fnBody).toMatch(/v_role NOT IN \('super_admin', 'hospital_admin', 'warehouse_manager'\)/);
    expect(fnBody).toContain('INSUFFICIENT_ROLE');
  });

  it('rejects a point that does not exist', () => {
    expect(fnBody).toContain('POINT_NOT_FOUND');
  });

  it('enforces org scope for non-super_admin roles', () => {
    expect(fnBody).toMatch(/v_role != 'super_admin' AND v_point_org != v_org_id/);
    expect(fnBody).toContain('FORBIDDEN_ORG');
  });

  it('super_admin bypasses the org-scope check (can clear any organization\'s port)', () => {
    expect(fnBody).toMatch(/v_role != 'super_admin' AND/);
  });

  it('preserves the exact confirmation phrase format CLEAR_PORT_ITEMS_<point_id>', () => {
    expect(fnBody).toContain("v_required := 'CLEAR_PORT_ITEMS_' || p_point_id::text;");
    expect(fnBody).toContain('CONFIRMATION_MISMATCH');
  });

  it('returns the required phrase back to the caller on mismatch (existing 007 behavior)', () => {
    expect(fnBody).toMatch(/'error', 'CONFIRMATION_MISMATCH',\s*\n\s*'required', v_required/);
  });
});

describe('Migration 042: return payload and audit logging', () => {
  it('returns { ok: true, cleared: <count>, ... } on success', () => {
    expect(fnBody).toMatch(/RETURN jsonb_build_object\(\s*\n\s*'ok', true,\s*\n\s*'cleared', v_total_count/);
  });

  it('still writes an audit_logs row with action = port_items_cleared', () => {
    expect(fnBody).toContain('INSERT INTO audit_logs');
    expect(fnBody).toContain("'port_items_cleared'");
  });

  it('audit payload records items_cleared and the zeroed_not_deleted mode', () => {
    const insertIdx = fnBody.indexOf('INSERT INTO audit_logs');
    const auditBlock = fnBody.slice(insertIdx, fnBody.indexOf('RETURN jsonb_build_object', insertIdx));
    expect(auditBlock).toContain("'items_cleared', v_total_count");
    expect(auditBlock).toContain("'mode', 'zeroed_not_deleted'");
  });
});

describe('Migration 042: idempotency', () => {
  it('the UPDATE WHERE clause allows a no-op re-run (skips rows already at quantity=0/condition=missing)', () => {
    expect(fnBody).toMatch(/AND \(quantity <> 0 OR condition IS DISTINCT FROM 'missing'\)/);
  });

  it('the returned cleared count reflects the scope of the port, not just rows physically touched by the UPDATE (stable across repeat calls)', () => {
    expect(fnBody).toContain('SELECT count(*) INTO v_total_count');
    const countIdx = fnBody.indexOf('SELECT count(*) INTO v_total_count');
    const updateIdx = fnBody.indexOf('UPDATE item_availability');
    expect(countIdx).toBeLessThan(updateIdx);
  });
});

describe('Migration 042: grants unchanged (authenticated only, no anon)', () => {
  it('REVOKEs from PUBLIC/anon and GRANTs EXECUTE to authenticated', () => {
    expect(migration042).toContain('REVOKE ALL ON FUNCTION public.clear_port_availability(uuid, text) FROM PUBLIC, anon;');
    expect(migration042).toContain('GRANT EXECUTE ON FUNCTION public.clear_port_availability(uuid, text) TO authenticated;');
  });

  it('no GRANT EXECUTE to anon anywhere in the file', () => {
    expect(activeSql(migration042)).not.toMatch(/GRANT EXECUTE[^;]*TO\s+anon/i);
  });
});

describe('Migration 042: does not touch other RPCs, policies, or tables', () => {
  it('does not redefine phoenix_apply_availability_movement or phoenix_upsert_availability', () => {
    expect(migration042).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement');
    expect(migration042).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability');
  });

  it('does not CREATE POLICY or ALTER TABLE on item_availability_movements', () => {
    expect(activeSql(migration042)).not.toMatch(/CREATE POLICY[^;]*item_availability_movements/i);
    expect(activeSql(migration042)).not.toMatch(/ALTER TABLE[^;]*item_availability_movements/i);
  });

  it('does not touch get_public_qr_payload, qr_tokens, or qr_targets', () => {
    expect(migration042).not.toMatch(/get_public_qr_payload|qr_tokens|qr_targets/);
  });

  it('does not CREATE/ALTER/DROP any inter_org_exchange_* or inter_org_alert_* RPC/table — the header only documents them as FK-risk context for the root cause', () => {
    const active = activeSql(migration042);
    expect(active).not.toMatch(/CREATE (OR REPLACE FUNCTION|TABLE|POLICY)[^;]*inter_org_(exchange|alert)/i);
    expect(active).not.toMatch(/ALTER TABLE[^;]*inter_org_(exchange|alert)/i);
    expect(active).not.toMatch(/DROP[^;]*inter_org_(exchange|alert)/i);
  });
});

describe('Migration 042: security guardrails', () => {
  it('no service_role reference in active SQL', () => {
    expect(activeSql(migration042)).not.toMatch(/service_role/i);
  });

  it('no auth.admin reference', () => {
    expect(activeSql(migration042)).not.toMatch(/auth\.admin/i);
  });

  it('no React/TSX component syntax (SQL-only file)', () => {
    expect(migration042).not.toMatch(/import React|useState|useEffect|<div/);
  });

  it('no WhatsApp or Google Drive integration', () => {
    expect(migration042).not.toMatch(/whatsapp|google.?drive/i);
  });

  it('does not run supabase db push directly (only mentions it as prohibited)', () => {
    const lines = migration042.split('\n').filter(l => l.includes('supabase db push'));
    for (const l of lines) {
      expect(l).toMatch(/DO NOT|manual|Manual/i);
    }
  });
});

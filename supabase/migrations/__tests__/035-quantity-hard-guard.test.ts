/**
 * BACKEND-QUANTITY-UPSERT-HARD-GUARD-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 035: phoenix_upsert_availability's
 * UPDATE branch must no longer be able to silently change quantity. These
 * are text/shape assertions against the SQL file — no live DB is used.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { expectRetiredSurfaceAbsent } from '../../../tests/helpers/retired-surfaces';

const MIGRATIONS_DIR = join(__dirname, '../');
const MIGRATION_035_PATH = join(MIGRATIONS_DIR, '035_phoenix_upsert_quantity_hard_guard.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

describe('Migration 035 exists exactly once, does not overwrite anything', () => {
  it('035_phoenix_upsert_quantity_hard_guard.sql exists', () => {
    expect(existsSync(MIGRATION_035_PATH)).toBe(true);
  });

  it('is non-trivial in size', () => {
    expect(readFileSync(MIGRATION_035_PATH, 'utf8').length).toBeGreaterThan(1000);
  });

  it('is the only file named 035_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('035_'));
    expect(matches).toEqual(['035_phoenix_upsert_quantity_hard_guard.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    const sql = readMigration('035_phoenix_upsert_quantity_hard_guard.sql');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('supabase db push');
  });
});

describe('Migration 035 redefines phoenix_upsert_availability with the same signature', () => {
  const sql = readMigration('035_phoenix_upsert_quantity_hard_guard.sql');

  it('uses CREATE OR REPLACE FUNCTION (redefine, not a new function)', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability');
  });

  it('preserves the exact 12-argument signature from migrations 030/031/032', () => {
    const sigStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability(');
    const sigEnd = sql.indexOf(')', sql.indexOf('RETURNS uuid', sigStart));
    const sig = sql.slice(sigStart, sigEnd);
    expect(sig).toContain('p_distribution_point_id uuid');
    expect(sig).toContain('p_scientific_name        text');
    expect(sig).toContain('p_trade_name             text');
    expect(sig).toContain('p_dosage_form            text');
    expect(sig).toContain('p_concentration          text');
    expect(sig).toContain('p_quantity               integer');
    expect(sig).toContain('p_condition              text');
    expect(sig).toContain('p_expiry_date            date');
    expect(sig).toContain('p_batch_number           text');
    expect(sig).toContain('p_notes                  text');
    expect(sig).toContain('p_supply_type            text');
    expect(sig).toContain('p_price                  numeric');
  });

  it('preserves RETURNS uuid, SECURITY DEFINER, SET search_path', () => {
    expect(sql).toContain('RETURNS uuid');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public');
  });

  it('preserves grants: authenticated only, revoked from PUBLIC/anon', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_upsert_availability\(\s*uuid, text, text, text, text, integer, text, date, text, text, text, numeric\s*\)\s*FROM PUBLIC, anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_upsert_availability\(\s*uuid, text, text, text, text, integer, text, date, text, text, text, numeric\s*\)\s*TO authenticated;/);
  });
});

describe('Migration 035: UPDATE branch guard', () => {
  const sql = readMigration('035_phoenix_upsert_quantity_hard_guard.sql');
  const updateBlock = sql.slice(
    sql.indexOf('IF v_existing_id IS NOT NULL THEN'),
    sql.indexOf('-- 5. INSERT path'),
  );

  it('raises quantity_update_requires_movement when p_quantity differs from stored quantity', () => {
    expect(updateBlock).toContain('quantity_update_requires_movement');
    expect(updateBlock).toMatch(/IF\s+p_quantity\s+IS\s+DISTINCT\s+FROM\s+v_existing_quantity\s+THEN/);
    expect(updateBlock).toMatch(/RAISE EXCEPTION 'quantity_update_requires_movement' USING ERRCODE = '23514';/);
  });

  it('does NOT set quantity = p_quantity anywhere in the UPDATE branch', () => {
    expect(updateBlock).not.toMatch(/SET\s+quantity\s*=\s*p_quantity/);
  });

  it('fetches the existing row quantity before deciding the branch', () => {
    expect(sql).toMatch(/SELECT ia\.id, ia\.quantity INTO v_existing_id, v_existing_quantity/);
  });

  it('still updates all the other non-quantity fields', () => {
    expect(updateBlock).toContain('condition     = p_condition');
    expect(updateBlock).toContain('expiry_date   = p_expiry_date');
    expect(updateBlock).toContain('batch_number  = p_batch_number');
    expect(updateBlock).toContain('notes         = p_notes');
    expect(updateBlock).toContain('supply_type   = p_supply_type');
    expect(updateBlock).toContain('price         = p_price');
    expect(updateBlock).toContain('trade_name    = p_trade_name');
  });

  it('retains the availability.update permission check on the UPDATE branch', () => {
    expect(updateBlock).toContain('forbidden_availability_update');
    expect(updateBlock).toContain("phoenix_profile_has_permission(auth.uid(), 'availability.update')");
  });
});

describe('Migration 035: INSERT branch unchanged (still uses p_quantity as initial stock)', () => {
  const sql = readMigration('035_phoenix_upsert_quantity_hard_guard.sql');
  const insertBlock = sql.slice(
    sql.indexOf('-- 5. INSERT path'),
    sql.indexOf('$$;'),
  );

  it('requires availability.create for the INSERT path', () => {
    expect(insertBlock).toContain('forbidden_availability_create');
    expect(insertBlock).toContain("phoenix_profile_has_permission(auth.uid(), 'availability.create')");
  });

  it('INSERT statement lists quantity and passes p_quantity as its value', () => {
    const insertStmt = insertBlock.slice(insertBlock.indexOf('INSERT INTO public.item_availability'));
    expect(insertStmt).toMatch(/quantity,/);
    expect(insertStmt).toMatch(/p_quantity,/);
  });
});

describe('Migration 035: permission checks and org scope preserved', () => {
  const sql = readMigration('035_phoenix_upsert_quantity_hard_guard.sql');

  it('references availability.create and availability.update', () => {
    expect(sql).toContain("'availability.create'");
    expect(sql).toContain("'availability.update'");
  });

  it('has a super_admin bypass', () => {
    expect(sql).toMatch(/v_is_super\s*:=\s*\(v_role = 'super_admin'\)/);
  });

  it('raises forbidden_cross_org for out-of-org access', () => {
    expect(sql).toContain('forbidden_cross_org');
    expect(sql).toMatch(/RAISE EXCEPTION 'forbidden_cross_org' USING ERRCODE = '42501';/);
  });
});

describe('Migration 035: explanatory comments reference the correct remediation path', () => {
  const sql = readMigration('035_phoenix_upsert_quantity_hard_guard.sql');

  it('references phoenix_apply_availability_movement as the required path for quantity changes', () => {
    expect(sql).toContain('phoenix_apply_availability_movement');
  });

  it('explains this migration prevents silent direct quantity overwrite', () => {
    expect(sql.toLowerCase()).toMatch(/silent/);
    expect(sql.toLowerCase()).toMatch(/overwrite/);
  });
});

describe('Migration 035: verification block exists', () => {
  const sql = readMigration('035_phoenix_upsert_quantity_hard_guard.sql');

  it('has a DO $$ ... VERIFY block', () => {
    expect(sql).toContain('VERIFY');
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toContain('ASSERT');
  });

  it('verify block checks the function exists and contains the guard text', () => {
    expect(sql).toContain("FROM pg_proc WHERE proname = 'phoenix_upsert_availability'");
    expect(sql).toMatch(/v_fn_src LIKE '%quantity_update_requires_movement%'/);
  });

  it('verify block checks phoenix_apply_availability_movement is untouched (still matches its 034 shape)', () => {
    expect(sql).toContain("FROM pg_proc WHERE proname = 'phoenix_apply_availability_movement'");
    expect(sql).toMatch(/quantity_cannot_go_negative/);
  });

  it('verify block checks get_public_qr_payload still exists (untouched)', () => {
    expect(sql).toContain('get_public_qr_payload');
  });

  it('verify block checks item_availability policy count is unchanged (4)', () => {
    expect(sql).toMatch(/tablename = 'item_availability'\s*\n\s*\) = 4,/);
  });
});

describe('Migration 035: guardrails — no unrelated changes', () => {
  const sql = readMigration('035_phoenix_upsert_quantity_hard_guard.sql');

  it('does not modify migrations 001-034 (only creates 035)', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^03[0-4]_/.test(f));
    expect(matches.length).toBe(5); // 030,031,032,033,034 all still present, none renamed
  });

  it('does not redefine phoenix_apply_availability_movement', () => {
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement');
  });

  it('does not touch get_public_qr_payload definition (only references it in VERIFY)', () => {
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.get_public_qr_payload');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION get_public_qr_payload');
  });

  it('does not create or drop any RLS policy', () => {
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
    expect(sql).not.toMatch(/DROP\s+POLICY/i);
  });

  it('does not reference service_role', () => {
    expect(sql).not.toContain('service_role');
  });

  it('does not add Excel/xlsx import machinery', () => {
    expect(sql).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
  });

  it('does not run supabase db push directly (only mentions it as prohibited)', () => {
    const activeLines = sql.split('\n').filter(l => !l.trimStart().startsWith('--'));
    expect(activeLines.join('\n')).not.toMatch(/supabase\s+db\s+push/);
  });

  it('has no DROP TABLE, TRUNCATE, or destructive DELETE', () => {
    const activeLines = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(activeLines).not.toMatch(/drop table/i);
    expect(activeLines).not.toMatch(/truncate/i);
    expect(activeLines).not.toMatch(/delete from/i);
  });
});

describe('Service layer: classifyAvailabilitySaveError maps the new guard error', () => {
  const service = readFileSync(join(__dirname, '../../../src/shared/supabase/services/availability.service.ts'), 'utf8');

  it('classifies quantity_update_requires_movement', () => {
    expect(service).toContain('quantity_update_requires_movement');
    expect(service).toContain('avail_qty_update_requires_movement');
  });
});

describe('i18n: bilingual string for the new guard error', () => {
  const strings = readFileSync(join(__dirname, '../../../src/shared/i18n/strings.ts'), 'utf8');

  it('avail_qty_update_requires_movement exists bilingually', () => {
    expect(strings).toMatch(/avail_qty_update_requires_movement:\s*\{\s*ar:\s*'[^']+',\s*en:\s*'[^']+'\s*\}/);
  });

  it('English text matches the required message', () => {
    const line = strings.split('\n').find(l => l.includes('avail_qty_update_requires_movement'));
    expect(line).toContain('Quantity changes must be made from Status Center');
    expect(line).toContain('Adjust Quantity');
  });

  it('Arabic text matches the required message', () => {
    const line = strings.split('\n').find(l => l.includes('avail_qty_update_requires_movement'));
    expect(line).toContain('مركز المواقف');
    expect(line).toContain('تعديل الكمية');
  });
});

describe('the retired EditorScreen cannot reference this backend guard', () => {
  // E6: was "EditorScreen remains unchanged for this backend-only phase", read
  // straight off the file. The screen is retired, so the isolation guard
  // becomes an absence guard: error classification stays centralized in
  // availability.service, and no retired screen can reintroduce a local copy.
  it('EditorScreen is deleted, unimported and unrendered', () => {
    expectRetiredSurfaceAbsent('EditorScreen');
  });

  it('the guard error key stays centralized in the availability service', () => {
    const service = readFileSync(
      join(__dirname, '../../../src/shared/supabase/services/availability.service.ts'),
      'utf8',
    );
    expect(service).toContain('quantity_update_requires_movement');
  });
});

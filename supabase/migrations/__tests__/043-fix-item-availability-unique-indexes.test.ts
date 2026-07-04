/**
 * BUGFIX-AVAILABILITY-DUPLICATE-PORT-INDEX-B
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 043: drops the two wrong legacy
 * unique indexes on item_availability that were silently blocking multi-
 * material adds in production (live 23505 error: "duplicate key value
 * violates unique constraint item_avail_point_port_idx").
 *
 * Root cause: item_avail_point_port_idx (migration 019) is UNIQUE on
 * (distribution_point_id, port_name) alone — but every material row for a
 * given outlet shares the same port_name, so this index allowed at most ONE
 * item_availability row per outlet, total. item_avail_point_sciname_idx
 * (migration 020) is UNIQUE on (distribution_point_id, scientific_name)
 * alone — narrower than the 4-column identity the product actually needs,
 * blocking the same scientific_name at different concentrations/dosage
 * forms. Migration 029 added the correct 4-column replacement
 * (item_availability_dp_sci_conc_form_uniq) but never dropped the two old
 * ones — this migration finishes that cleanup, index-only, no data touched.
 *
 * No live DB is used — these are text/shape assertions against the SQL
 * file, mirroring the 035/041/042 tests' conventions.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../');
const MIGRATION_043_PATH = join(MIGRATIONS_DIR, '043_phoenix_fix_item_availability_unique_indexes.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

/** Strip `--` comment lines, leaving only active SQL for whole-file guardrails. */
function activeSql(sql: string): string {
  return sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
}

const migration043 = readMigration('043_phoenix_fix_item_availability_unique_indexes.sql');
const active043 = activeSql(migration043);

describe('Migration 043 exists exactly once', () => {
  it('043_phoenix_fix_item_availability_unique_indexes.sql exists', () => {
    expect(existsSync(MIGRATION_043_PATH)).toBe(true);
  });

  it('is the only file named 043_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('043_'));
    expect(matches).toEqual(['043_phoenix_fix_item_availability_unique_indexes.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    expect(migration043).toContain('MANUAL APPLY ONLY');
    expect(migration043).toContain('supabase db push');
  });

  it('has a DO $$ ... VERIFY block with ASSERT statements', () => {
    expect(migration043).toContain('DO $$');
    expect(migration043).toContain('ASSERT');
  });

  it('reloads the PostgREST schema cache', () => {
    expect(migration043).toContain("NOTIFY pgrst, 'reload schema';");
  });
});

describe('Migration 043: does not modify migrations 001-042', () => {
  it('019/020/029 still create the original (now-superseded) indexes untouched', () => {
    const sql019 = readMigration('019_phoenix_availability_editor_institution_ux.sql');
    expect(sql019).toContain('create unique index if not exists item_avail_point_port_idx');
    const sql020 = readMigration('020_phoenix_availability_material_fields_and_status_editor.sql');
    expect(sql020).toContain('create unique index if not exists item_avail_point_sciname_idx');
    const sql029 = readMigration('029_phoenix_availability_scientific_name_unique.sql');
    expect(sql029).toContain('CREATE UNIQUE INDEX IF NOT EXISTS item_availability_dp_sci_conc_form_uniq');
  });

  it('033/040/041/042 filenames are unchanged (no duplicate numbering introduced)', () => {
    for (const [prefix, name] of [
      ['033_', '033_phoenix_availability_movements_schema.sql'],
      ['040_', '040_phoenix_inter_org_exchange_schema.sql'],
      ['041_', '041_phoenix_inter_org_exchange_rpcs.sql'],
      ['042_', '042_phoenix_clear_port_availability_movement_safe.sql'],
    ] as const) {
      expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith(prefix))).toEqual([name]);
    }
  });

  it('only the reviewed migrations 044/045/046/047 (DB-MY-ACCOUNT-WHATSAPP-PHONE-A / DB-MY-ACCOUNT-WHATSAPP-RPC-A / DB-OFFICIAL-ORG-WHATSAPP-CONTACT-RPC-A / DB-ALERTS-LIVE-WHATSAPP-CONTACT-FIELDS-A) exist beyond 043 — any other migration beyond 043 still fails this check', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(4[4-9]|[5-9][0-9])_/.test(f));
    expect(matches).toEqual([
      '044_phoenix_profiles_whatsapp_phone.sql',
      '045_phoenix_update_my_whatsapp_phone_rpc.sql',
      '046_phoenix_set_my_org_whatsapp_contact_rpc.sql',
      '047_phoenix_live_alerts_contact_fields.sql',
    ]);
  });
});

describe('Migration 043: drops exactly the two wrong legacy indexes', () => {
  it('drops item_avail_point_port_idx', () => {
    expect(active043).toMatch(/DROP INDEX IF EXISTS public\.item_avail_point_port_idx;/);
  });

  it('drops item_avail_point_sciname_idx', () => {
    expect(active043).toMatch(/DROP INDEX IF EXISTS public\.item_avail_point_sciname_idx;/);
  });

  it('uses IF EXISTS on both drops (idempotent / safe to re-run)', () => {
    const dropLines = active043.split('\n').filter(l => l.trim().startsWith('DROP INDEX'));
    expect(dropLines.length).toBe(2);
    for (const line of dropLines) {
      expect(line).toContain('IF EXISTS');
    }
  });

  it('drops exactly two indexes — no other DROP statement of any kind exists', () => {
    const dropStatements = active043.match(/^\s*DROP\s+\w+/gim) ?? [];
    expect(dropStatements.length).toBe(2);
  });
});

describe('Migration 043: preserves the correct material-identity indexes', () => {
  it('does not drop item_availability_dp_sci_conc_form_uniq', () => {
    expect(active043).not.toMatch(/DROP[^;]*item_availability_dp_sci_conc_form_uniq/i);
  });

  it('does not drop item_availability_local_item_id_distribution_point_id_key', () => {
    expect(active043).not.toMatch(/DROP[^;]*item_availability_local_item_id_distribution_point_id_key/i);
  });

  it('the VERIFY block asserts both correct indexes still exist', () => {
    expect(migration043).toMatch(/ASSERT EXISTS[\s\S]{0,150}item_availability_dp_sci_conc_form_uniq/);
    expect(migration043).toMatch(/ASSERT EXISTS[\s\S]{0,200}item_availability_local_item_id_distribution_point_id_key/);
  });

  it('the VERIFY block asserts both wrong indexes are absent', () => {
    expect(migration043).toMatch(/ASSERT NOT EXISTS[\s\S]{0,150}item_avail_point_port_idx/);
    expect(migration043).toMatch(/ASSERT NOT EXISTS[\s\S]{0,150}item_avail_point_sciname_idx/);
  });
});

describe('Migration 043: no data or unrelated schema touched', () => {
  it('has no DELETE, TRUNCATE, or DROP TABLE/SCHEMA statement anywhere', () => {
    expect(active043).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(active043).not.toMatch(/\bTRUNCATE\b/i);
    expect(active043).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(active043).not.toMatch(/\bDROP\s+SCHEMA\b/i);
  });

  it('does not touch item_availability_movements or audit_logs beyond an existence check', () => {
    // The only mentions of these tables are read-only existence assertions
    // in the VERIFY block (information_schema.tables SELECT) — never a
    // DELETE/UPDATE/INSERT/DROP against either table.
    expect(active043).not.toMatch(/(DELETE|UPDATE|INSERT|DROP)[^;]*item_availability_movements/i);
    expect(active043).not.toMatch(/(DELETE|UPDATE|INSERT|DROP)[^;]*audit_logs/i);
  });

  it('does not ALTER TABLE item_availability (no column/row change, index-only)', () => {
    expect(active043).not.toMatch(/ALTER TABLE[^;]*item_availability\b/i);
  });

  it('does not CREATE/ALTER/DROP any RLS policy', () => {
    expect(active043).not.toMatch(/CREATE POLICY|ALTER POLICY|DROP POLICY/i);
  });
});

describe('Migration 043: phoenix_upsert_availability is not modified (identity lookup already matches the preserved index)', () => {
  it('migration 043 does not redefine phoenix_upsert_availability or any other RPC', () => {
    expect(migration043).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
  });

  it("migration 035's existing-row lookup already matches item_availability_dp_sci_conc_form_uniq's 4-column shape", () => {
    const sql035 = readMigration('035_phoenix_upsert_quantity_hard_guard.sql');
    expect(sql035).toMatch(/ia\.distribution_point_id\s*=\s*p_distribution_point_id/);
    expect(sql035).toMatch(/ia\.scientific_name\s*=\s*p_scientific_name/);
    expect(sql035).toMatch(/COALESCE\(ia\.concentration,\s*''\)\s*=\s*v_conc/);
    expect(sql035).toMatch(/COALESCE\(ia\.dosage_form,\s*''\)\s*=\s*v_dosage/);
  });
});

describe('Migration 043: security guardrails', () => {
  it('no service_role reference in active SQL', () => {
    expect(active043).not.toMatch(/service_role/i);
  });

  it('no auth.admin reference', () => {
    expect(active043).not.toMatch(/auth\.admin/i);
  });

  it('no CREATE/ALTER/DROP touching any inter_org_exchange_* or inter_org_alert_* table/RPC — the header only documents them as out of scope', () => {
    expect(active043).not.toMatch(/CREATE (OR REPLACE FUNCTION|TABLE|POLICY)[^;]*inter_org_(exchange|alert)/i);
    expect(active043).not.toMatch(/ALTER (TABLE|POLICY)[^;]*inter_org_(exchange|alert)/i);
    expect(active043).not.toMatch(/DROP[^;]*inter_org_(exchange|alert)/i);
  });

  it('no React/TSX component syntax (SQL-only file)', () => {
    expect(migration043).not.toMatch(/import React|useState|useEffect|<div/);
  });

  it('no wipe tooling references', () => {
    expect(migration043).not.toMatch(/phoenix-wipe-execute|FULL_PUBLIC_APP_WIPE_APPROVED|full_wipe/i);
  });

  it('does not run supabase db push directly (only mentions it as prohibited)', () => {
    const lines = migration043.split('\n').filter(l => l.includes('supabase db push'));
    for (const l of lines) {
      expect(l).toMatch(/DO NOT|manual|Manual/i);
    }
  });
});

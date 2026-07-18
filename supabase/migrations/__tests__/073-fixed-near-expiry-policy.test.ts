import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../../');
const NAME = '073_phoenix_fixed_near_expiry_policy.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const norm = sql.replace(/\s+/g, ' ').trim();

function functionSource(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf('\n$$;', start);
  expect(end, `${name} must terminate`).toBeGreaterThan(start);
  return sql.slice(start, end + 4).replace(/\s+/g, ' ');
}

const guard = functionSource('phoenix_inventory_threshold_guard');
const upsert = functionSource('phoenix_upsert_inventory_threshold');

describe('073 identity and atomicity', () => {
  it('uses the exact reviewed filename', () => expect(NAME).toBe('073_phoenix_fixed_near_expiry_policy.sql'));
  it('is explicitly manual-apply-only and not applied by the PR', () => {
    expect(sql).toContain('MANUAL APPLY ONLY. NOT APPLIED BY THIS PR.');
  });
  it('wraps the whole contract in one transaction', () => {
    expect((sql.match(/^begin;$/gm) ?? []).length).toBe(1);
    expect((sql.match(/^commit;$/gm) ?? []).length).toBe(1);
    expect(sql.indexOf('begin;')).toBeLessThan(sql.indexOf('commit;'));
  });
  it('requires the 072 table, functions, column, constraint and trigger', () => {
    for (const token of ['inventory_signal_thresholds', 'phoenix_upsert_inventory_threshold',
      'phoenix_inventory_threshold_guard', 'near_expiry_days',
      'inventory_thresholds_near_expiry_days_chk', 'inventory_threshold_guard']) {
      expect(sql).toContain(token);
    }
    expect(sql).toContain('073 preconditions OK.');
  });
});

describe('073 fixed column contract', () => {
  it('normalizes every existing non-270 value in-transaction', () => {
    expect(norm).toContain('UPDATE public.inventory_signal_thresholds SET near_expiry_days = 270');
    expect(norm).toContain('WHERE near_expiry_days IS DISTINCT FROM 270');
  });
  it('records the normalization count without exposing row data', () => {
    expect(sql).toContain('GET DIAGNOSTICS v_normalized = ROW_COUNT');
    expect(sql).toContain('normalized % inventory threshold row(s)');
  });
  it('pins DEFAULT 270 and NOT NULL', () => {
    expect(norm).toContain('ALTER COLUMN near_expiry_days SET DEFAULT 270');
    expect(norm).toContain('ALTER COLUMN near_expiry_days SET NOT NULL');
  });
  it('replaces the 1..270 constraint with equality to 270', () => {
    expect(norm).toContain('DROP CONSTRAINT inventory_thresholds_near_expiry_days_chk');
    expect(norm).toContain('CHECK (near_expiry_days = 270) NOT VALID');
  });
  it('validates the new constraint before commit', () => {
    expect(norm).toContain('VALIDATE CONSTRAINT inventory_thresholds_near_expiry_days_chk');
  });
});

describe('073 every-writer trigger guard', () => {
  it('keeps the established scope-kind guard', () => expect(guard).toContain("NEW.scope_kind NOT IN ('warehouse', 'outlet')"));
  it('keeps the established scope-to-organization guard', () => expect(guard).toContain('phoenix_inventory_scope_org(NEW.scope_kind, NEW.scope_id)'));
  it('normalizes a legacy NULL to 270', () => expect(guard).toContain('NEW.near_expiry_days := 270'));
  it('rejects every explicit non-270 value', () => {
    expect(guard).toContain('NEW.near_expiry_days <> 270');
    expect(guard).toContain('near_expiry_days_fixed_270');
  });
  it('remains SECURITY DEFINER with a pinned search path', () => {
    expect(guard).toContain('SECURITY DEFINER');
    expect(guard).toContain('SET search_path = public, pg_temp');
  });
  it('is not client-callable', () => {
    expect(norm).toContain('REVOKE ALL ON FUNCTION public.phoenix_inventory_threshold_guard() FROM PUBLIC, anon, authenticated');
  });
});

describe('073 rolling-compatible threshold RPC', () => {
  it('keeps the exact nine-argument signature', () => {
    expect(norm).toContain('phoenix_upsert_inventory_threshold( uuid, text, uuid, text, text, integer, integer, integer, boolean )');
  });
  it('changes only the argument default to the fixed policy', () => expect(upsert).toContain('p_near_expiry_days integer DEFAULT 270'));
  it('accepts omitted/NULL legacy input as a compatibility alias', () => {
    expect(upsert).toContain('p_near_expiry_days IS NOT NULL AND p_near_expiry_days <> 270');
  });
  it('rejects an explicit override with a stable error', () => expect(upsert).toContain("RAISE EXCEPTION 'near_expiry_days_fixed_270'"));
  it('writes 270 on INSERT regardless of the caller argument', () => {
    expect(upsert).toMatch(/p_reorder_point, p_target_max, 270, COALESCE\(p_is_active/);
  });
  it('writes 270 on conflict UPDATE', () => expect(upsert).toContain('near_expiry_days = 270'));
  it('audits the stored value 270, not the legacy input', () => expect(upsert).toContain("'near_expiry_days', 270"));
  it('preserves exact scoped authorization for warehouse/outlet/org-default', () => {
    expect(upsert).toContain("'inventory.manage_thresholds'");
    expect(upsert).toContain("p_scope_kind = 'warehouse'");
    expect(upsert).toContain("p_scope_kind = 'outlet'");
    expect(upsert).toContain('p_scope_id IS NULL');
  });
  it('preserves SECURITY DEFINER and public,pg_temp pinning', () => {
    expect(upsert).toContain('SECURITY DEFINER');
    expect(upsert).toContain('SET search_path = public, pg_temp');
  });
  it('keeps authenticated-only execution', () => {
    expect(norm).toContain('REVOKE ALL ON FUNCTION public.phoenix_upsert_inventory_threshold( uuid, text, uuid, text, text, integer, integer, integer, boolean ) FROM PUBLIC, anon');
    expect(norm).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_upsert_inventory_threshold( uuid, text, uuid, text, text, integer, integer, integer, boolean ) TO authenticated');
  });
});

describe('073 live post-conditions', () => {
  it('verifies NOT NULL/default, equality CHECK and all existing rows', () => {
    expect(sql).toContain('near_expiry_days is not NOT NULL DEFAULT 270');
    expect(sql).toContain('fixed-270 CHECK is absent');
    expect(sql).toContain('a threshold row is not fixed at 270');
  });
  it('verifies the stored upsert and trigger definitions', () => {
    expect(sql).toContain('upsert RPC does not pin and audit 270');
    expect(sql).toContain('every-writer trigger guard is incomplete');
  });
  it('verifies trigger security/search_path and enabled state', () => {
    expect(sql).toContain('trigger guard security/search_path changed');
    expect(sql).toContain('inventory_threshold_guard is not enabled');
  });
  it('verifies function ACLs and direct-table writes remain closed', () => {
    expect(sql).toContain("has_function_privilege(\n       'anon'");
    expect(sql).toContain("has_table_privilege('authenticated', 'public.inventory_signal_thresholds', 'INSERT')");
    expect(sql).toContain('function ACL boundary is incorrect');
    expect(sql).toContain('table ACL boundary changed');
  });
  it('verifies RLS remains enabled', () => {
    expect(sql).toContain('relrowsecurity');
    expect(sql).toContain('threshold RLS is not enabled');
  });
});

describe('073 bounded safety', () => {
  it('does not create/drop/truncate/delete a table', () => {
    expect(sql).not.toMatch(/\b(?:CREATE|DROP|TRUNCATE)\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
  it('does not touch stock, movements, auth users, cron, blobs or images', () => {
    for (const forbidden of ['warehouse_stock SET', 'outlet_stock SET', 'warehouse_stock_movements',
      'outlet_stock_movements', 'auth.users SET', 'pg_cron', 'cron.schedule', 'bytea', 'base64']) {
      expect(sql).not.toContain(forbidden);
    }
  });
  it('does not weaken RLS or grant table writes', () => {
    expect(sql).not.toMatch(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i);
    expect(sql).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|ALL).*inventory_signal_thresholds/is);
  });
  it('does not recompute alerts under a migration superuser context', () => {
    expect(sql).not.toMatch(/PERFORM\s+public\.phoenix_recompute_inventory_alerts/i);
    expect(sql).toContain('does not recompute alert projections');
  });
});

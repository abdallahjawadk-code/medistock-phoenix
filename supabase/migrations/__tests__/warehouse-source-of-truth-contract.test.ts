/**
 * WAREHOUSE-SOURCE-OF-TRUTH-CONTRACT-A
 *
 * Cross-migration acceptance guards for the warehouse product contract.
 * Static source only: no database connection and no production write.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../../');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const contract = read('docs/warehouse-source-of-truth.md');
const m010 = read('supabase/migrations/010_phoenix_user_permission_matrix.sql');
const m060 = read('supabase/migrations/060_phoenix_warehouse_foundation.sql');
const m061 = read('supabase/migrations/061_phoenix_warehouse_dispatch_schema.sql');
const m062 = read('supabase/migrations/062_phoenix_user_rbac_scope_foundation.sql');

function activeSql(sql: string): string {
  return sql.split('\n').map(line => line.replace(/--.*$/, '')).join('\n');
}

const active010 = activeSql(m010);
const active060 = activeSql(m060);
const active061 = activeSql(m061);
const active062 = activeSql(m062);
const contractText = contract.replace(/\s+/g, ' ');

describe('warehouse source-of-truth contract', () => {
  it('is explicit, binding, and leaves historical migrations immutable', () => {
    expect(contractText).toContain('binding implementation contract');
    expect(contractText).toContain('authoritative quantity and batch source');
    expect(contractText).toContain('Historical migrations 001–064 must not be edited');
    expect(contractText).toContain('migration 065 or later');
  });

  it('keeps warehouse and outlet as distinct domain entities', () => {
    expect(contractText).toContain('A warehouse is a real warehouse entity');
    expect(contractText).toContain('It is not modelled as a distribution point');
    expect(active061).toMatch(
      /warehouse_id\s+uuid NOT NULL,[\s\S]*destination_distribution_point_id uuid NOT NULL/,
    );
  });

  it('uses a generated available quantity and forbids impossible stock arithmetic', () => {
    expect(active060).toMatch(
      /available_quantity\s+integer GENERATED ALWAYS AS \(on_hand_quantity - reserved_quantity\) STORED/,
    );
    expect(active060).toContain('warehouse_stock_reserved_le_on_hand_chk');
    expect(active060).toMatch(/CHECK \(on_hand_quantity\s*>=\s*0\)/);
    expect(active060).toMatch(/CHECK \(reserved_quantity\s*>=\s*0\)/);
  });

  it('keeps the warehouse movement ledger immutable and client-read-only', () => {
    expect(active060).toContain('CREATE TABLE IF NOT EXISTS public.warehouse_stock_movements');
    expect(active060).toContain('warehouse_stock_movements_on_hand_math_chk');
    expect(active060).toContain('warehouse_stock_movements_reserved_math_chk');
    expect(active060).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.warehouse_stock_movements\s+FROM authenticated/,
    );
    expect(active060).not.toMatch(
      /CREATE POLICY[\s\S]{0,160}warehouse_stock_movements[\s\S]{0,160}FOR (INSERT|UPDATE|DELETE|ALL)/i,
    );
  });

  it('preserves real no-batch semantics and private provenance', () => {
    expect(active060).toContain('has_no_batch_number');
    expect(active060).toContain('internal_batch_reference');
    expect(active060).toMatch(
      /CHECK \(batch_number IS NULL OR \(btrim\(batch_number\) = batch_number/,
    );
    expect(active061).toContain('AND ia.internal_batch_reference IS NULL');
    expect(contractText).toContain('is private provenance');
    expect(contractText).toContain('never exposed through public QR');
  });

  it('makes dispatch acceptance idempotent at the outlet movement boundary', () => {
    expect(active061).toContain('item_availability_movements_dispatch_line_fk');
    expect(active061).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS item_availability_movements_dispatch_line_uniq\s+ON public\.item_availability_movements \(dispatch_line_id\)\s+WHERE dispatch_line_id IS NOT NULL/,
    );
    expect(contractText).toContain('is idempotent and cannot be repeated');
  });

  it('pins every dispatch to one organization structurally', () => {
    expect(active061).toContain('warehouse_dispatches_wh_org_fk');
    expect(active061).toContain('warehouse_dispatches_dest_org_fk');
    expect(active061).toContain('warehouse_dispatch_lines_dispatch_org_fk');
    expect(active061).toContain('warehouse_dispatch_lines_stock_org_fk');
  });

  it('enforces sender/receiver separation in role defaults', () => {
    const defaults = active061.slice(
      active061.indexOf('INSERT INTO public.role_permission_defaults'),
      active061.indexOf("INSERT INTO public.role_permission_defaults (role, permission_key, allowed)\n  SELECT 'super_admin'"),
    );

    expect(defaults).toContain(
      "('warehouse_officer','warehouse_dispatch.send',true)",
    );
    expect(defaults).not.toContain(
      "('warehouse_officer','warehouse_dispatch.accept',true)",
    );
    expect(defaults).not.toContain(
      "('warehouse_officer','warehouse_dispatch.reject',true)",
    );

    expect(defaults).toContain(
      "('port_officer','warehouse_dispatch.accept',true)",
    );
    expect(defaults).toContain(
      "('port_officer','warehouse_dispatch.reject',true)",
    );
    expect(defaults).not.toContain(
      "('port_officer','warehouse_dispatch.send',true)",
    );
    expect(defaults).not.toContain(
      "('port_officer','warehouse_dispatch.cancel',true)",
    );
  });

  it('keeps warehouse officer as data-entry, not warehouse ownership', () => {
    expect(active062).toMatch(
      /UPDATE public\.role_permission_defaults[\s\S]*SET allowed = false[\s\S]*role = 'warehouse_officer'[\s\S]*permission_key = 'warehouses\.manage'/,
    );
    expect(active010).toContain(
      "('warehouse_officer','warehouses.view',true)",
    );
    expect(contractText).toContain('A sender must never self-accept a line');
  });

  it('requires active assignments and never widens organization scope', () => {
    expect(active062).toContain('CREATE TABLE IF NOT EXISTS public.profile_scope_assignments');
    expect(active062).toContain('phoenix_profile_has_scoped_permission');
    expect(active062).toContain('phoenix_profile_has_warehouse_assignment');
    expect(active062).toContain('phoenix_profile_has_point_assignment');
    expect(contractText).toContain('Organization scope may only be');
    expect(contractText).toContain('narrowed by an assignment; never widened');
  });

  it('does not authorize automatic transfer or derived-system writes', () => {
    expect(contractText).toContain('No automatic transfer or silent stock reconciliation');
    expect(contractText).toContain('do not become a second inventory source');
    expect(contractText).toContain('cannot create one itself');
  });

  it('does not authorize production mutation or RBAC enforcement', () => {
    expect(contractText).toContain(
      'No production SQL, migration application, RBAC enforcement, or destructive data',
    );
  });
});

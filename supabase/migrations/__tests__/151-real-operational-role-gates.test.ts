import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
  __dirname,
  '..',
  '151_phoenix_suggestion_route_policy_gates.sql',
);
const sql = readFileSync(migrationPath, 'utf8');

const functionBody = (name: string, nextMarker: string): string => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  const end = sql.indexOf(nextMarker, start);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  expect(end, `${name} must have a bounded definition`).toBeGreaterThan(start);
  return sql.slice(start, end);
};

describe('151 suggestion route policy gates', () => {
  it('is forward-only, transactional, and preserves the public RPC signature', () => {
    expect(sql).toMatch(/\nBEGIN;\s*\n/);
    expect(sql).toMatch(/COMMIT;\s*$/);
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.phoenix_create_transfer_draft_from_suggestion(',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.phoenix_create_transfer_draft_from_suggestion(uuid,text)',
    );
    expect(sql).not.toMatch(/\b(DROP TABLE|TRUNCATE|ALTER TABLE)\b/i);
  });

  it('maps every route to its existing operational permission at the exact source scope', () => {
    const gate = functionBody(
      '_phoenix_authorize_suggestion_draft_route_v1(',
      'REVOKE ALL ON FUNCTION public._phoenix_authorize_suggestion_draft_route_v1',
    );
    expect(gate).toContain("'central_to_institution'");
    expect(gate).toContain("'warehouse_transfer.send'");
    expect(gate).toContain('p_suggestion.source_scope_id');
    expect(gate).toContain("'warehouse_to_outlet'");
    expect(gate).toContain("'warehouse_dispatch.create'");
    expect(gate).toContain("'outlet_to_warehouse'");
    expect(gate).toContain("'outlet_stock.return_request'");
    expect(gate).toContain('p_suggestion.source_organization_id');
    expect(gate).toMatch(/SECURITY DEFINER[\s\S]*SET search_path = public, pg_temp/);
  });

  it('keeps the internal policy capsule non-callable by client roles', () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\._phoenix_authorize_suggestion_draft_route_v1\([\s\S]*?\)\s+FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\._phoenix_authorize_suggestion_draft_route_v1/,
    );
  });

  it('replaces the broad suggestion-action gate without changing the lock order', () => {
    const delegate = functionBody(
      '_phoenix_150_delegate_create_transfer_draft_from_suggestion(',
      'REVOKE ALL ON FUNCTION public._phoenix_150_delegate_create_transfer_draft_from_suggestion',
    );
    expect(delegate).toContain("'inv_suggest:' || v_lock_a");
    expect(delegate).toMatch(/FROM public\.inventory_transfer_suggestions[\s\S]*FOR UPDATE;/);
    expect(delegate).toContain(
      'public._phoenix_authorize_suggestion_draft_route_v1(v_actor, v_s)',
    );
    expect(delegate).not.toContain('inventory.act_on_suggestions');
    expect(delegate.indexOf("'inv_suggest:' || v_lock_a")).toBeLessThan(
      delegate.indexOf('public._phoenix_authorize_suggestion_draft_route_v1'),
    );
  });

  it('uses resolved suggestion identity for outlet-return lineage', () => {
    const wrapper = functionBody(
      'phoenix_create_transfer_draft_from_suggestion(',
      'REVOKE ALL ON FUNCTION public.phoenix_create_transfer_draft_from_suggestion',
    );
    expect(wrapper).toContain(
      'public._phoenix_authorize_suggestion_draft_route_v1(v_actor, v_s)',
    );
    expect(wrapper.indexOf('_phoenix_authorize_suggestion_draft_route_v1')).toBeLessThan(
      wrapper.indexOf("'inv_material:' || v_s.material_identity_key"),
    );
    const returnBranch = wrapper.slice(
      wrapper.indexOf("ELSIF v_s.route_kind='outlet_to_warehouse'"),
    );
    expect(returnBranch).toContain(
      'v_s.central_item_id,v_line.scientific_name,v_line.national_code',
    );
    expect(returnBranch).not.toContain(
      'v_line.central_item_id,v_line.scientific_name,v_line.national_code',
    );
  });

  it('does not mutate role defaults, permission vocabulary, stock, ledger, or process state', () => {
    expect(sql).not.toMatch(
      /\b(INSERT INTO|UPDATE|DELETE FROM)\s+public\.(role_permission_defaults|permission_keys)\b/i,
    );
    expect(sql).not.toMatch(
      /\b(INSERT INTO|UPDATE|DELETE FROM)\s+public\.(warehouse_stock|outlet_stock|warehouse_stock_movements|outlet_stock_movements|inventory_movement_ledger)\b/i,
    );
    expect(sql).not.toMatch(/\b(create table|outbox|process_instance|workflow_instance)\b/i);
  });
});

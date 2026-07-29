import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(__dirname, '..', '152_phoenix_suggestion_action_read_model.sql'),
  'utf8',
);
const normalized = sql.replace(/\s+/g, ' ');

describe('152 server-backed suggestion action read model', () => {
  it('is an authenticated-only bounded batch with no write statement', () => {
    expect(normalized).toMatch(
      /CREATE OR REPLACE FUNCTION public\.phoenix_get_inventory_suggestion_actions\( p_suggestion_ids uuid\[\] \)/,
    );
    expect(sql).toContain('cardinality(p_suggestion_ids), 0) > 200');
    expect(sql).toContain("SELECT p.status = 'active'");
    expect(sql).toContain('IF COALESCE(v_actor_active, false) = false');
    expect(normalized).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_get_inventory_suggestion_actions\(uuid\[\]\) FROM PUBLIC, anon/,
    );
    expect(normalized).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.phoenix_get_inventory_suggestion_actions\(uuid\[\]\) TO authenticated/,
    );
    expect(normalized).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s+(INTO|public\.)/);
  });

  it('delegates createDraft to the exact 151 policy gate', () => {
    expect(sql).toContain(
      'PERFORM public._phoenix_authorize_suggestion_draft_route_v1(v_actor, v_s)',
    );
    expect(sql).not.toContain("'warehouse_transfer.send'");
    expect(sql).not.toContain("'warehouse_dispatch.create'");
    expect(sql).not.toContain("'outlet_stock.return_request'");
  });

  it('keeps reject independent on inventory.act_on_suggestions', () => {
    expect(sql).toContain("'inventory.act_on_suggestions'");
    expect(sql).toContain("'reject', v_can_reject");
  });

  it('checks the real RLS helper for every linked document kind', () => {
    expect(sql).toContain('public.phoenix_can_read_warehouse_transfer(');
    expect(sql).toContain('public.phoenix_can_read_warehouse_dispatch(');
    expect(sql).toContain('public.phoenix_can_read_outlet_return(');
    expect(sql).toContain("'openDocument', v_can_open");
    expect(sql).toContain("'document_link_missing'");
    expect(sql).toContain("'document_unavailable'");
  });

  it('does not expose an internal helper or create process-state storage', () => {
    expect(sql).not.toMatch(/CREATE TABLE/i);
    expect(sql).not.toMatch(/process_state|outbox|event_sourc|reservation|ledger/i);
    expect(sql).toContain('process_version := 1');
  });
});

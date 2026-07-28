import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(__dirname, '../149_phoenix_inventory_suggestion_lineage_commitments.sql'),
  'utf8',
);

const compact = (value: string) => value.replace(/\s+/g, ' ').toLowerCase();
const normalized = compact(sql);

describe('149 inventory suggestion lineage and derived commitments', () => {
  it('is one transactional additive migration after 148', () => {
    expect(normalized).toContain(
      "to_regprocedure('public.phoenix_create_transfer_draft_from_suggestion(uuid,text)')",
    );
    expect(normalized).toContain('begin;');
    expect(normalized).toMatch(/commit;\s*$/);
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+\S+\s+DROP\s+COLUMN/i);
  });

  it.each([
    'draft_warehouse_transfer_request_line_id',
    'draft_warehouse_dispatch_line_id',
    'draft_outlet_return_request_line_id',
  ])('adds explicit lineage column %s', (column) => {
    expect(normalized).toContain(`add column ${column} uuid`);
  });

  it('binds every line id to its matching document head with SET NULL on line deletion', () => {
    expect(normalized.match(/foreign key \(draft_[^)]+_line_id, draft_[^)]+_id\)/g)).toHaveLength(3);
    expect(normalized.match(/on delete set null \(draft_[^)]+_line_id\)/g)).toHaveLength(3);
  });

  it('versions linked, unresolved legacy, terminal legacy and deleted-line states', () => {
    for (const state of ['legacy_unresolved', 'legacy_terminal', 'linked', 'line_deleted']) {
      expect(normalized).toContain(`'${state}'`);
    }
    expect(normalized).toContain('lineage_version smallint not null default 0');
    expect(normalized).toContain("commitment_closed_reason = 'line_deleted'");
  });

  it('backfills only semantically proven line identity and never guesses from cardinality alone', () => {
    expect(normalized).toContain('phoenix_dispatch_line_requests');
    expect(normalized).toContain('request_id = s.id');
    expect(normalized).toContain('warehouse_stock_id = s.source_stock_id');
    expect(normalized).toContain('original_dispatch_line_id = s.provenance_dispatch_line_id');
    expect(normalized).toContain('source_outlet_stock_id = s.source_stock_id');
    expect(normalized.match(/lower\(btrim\([^)]*scientific_name[^)]*\)\)/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(3);
    expect(normalized).not.toMatch(
      /from public\.warehouse_dispatch_lines\s+group by dispatch_id\s+having count\(\*\) = 1/i,
    );
    expect(normalized).not.toMatch(/\blimit\s+1\b[\s\S]{0,80}draft_\w+_line_id/i);
  });

  it('exposes one internal four-dimensional commitment contract and truth state', () => {
    expect(normalized).toContain('create or replace function public.phoenix_inventory_suggestion_commitments');
    for (const field of [
      'source_commitment',
      'target_commitment',
      'batch_commitment',
      'provenance_commitment',
      'commitment_state',
      'truth_source',
      'is_active',
    ]) {
      expect(normalized).toContain(field);
    }
  });

  it('keeps the commitment helper internal', () => {
    expect(normalized).toContain(
      'revoke all on function public.phoenix_inventory_suggestion_commitments(uuid) from public, anon, authenticated',
    );
    expect(normalized).not.toMatch(
      /grant\s+execute\s+on\s+function\s+public\.phoenix_inventory_suggestion_commitments/i,
    );
  });

  it('derives draft, in-transit, stock, quarantine and exception transitions without a new ledger', () => {
    for (const term of [
      "'draft'",
      "'in_transit_custody'",
      "'stock_quarantine_or_exception'",
      'warehouse_transfer_lines',
      'warehouse_dispatch_lines',
      'outlet_return_shipment_lines',
    ]) {
      expect(normalized).toContain(term);
    }
    expect(sql).not.toMatch(/CREATE\s+TABLE\s+.*(?:ledger|commitment)/i);
  });

  it('expires stale open rows and permits one open suggestion key per cycle', () => {
    expect(normalized).toContain("set status = 'expired'");
    expect(normalized).toContain('where status = \'open\'');
    expect(normalized).toContain('create unique index inventory_suggestions_open_key_uniq');
    expect(normalized).not.toMatch(/CREATE\s+UNIQUE\s+INDEX[\s\S]{0,180}\(suggestion_key\)\s*;/i);
  });

  it('uses the derived helper in the guard, both generators and bridge', () => {
    const calls = normalized.match(/phoenix_inventory_suggestion_commitments\(s\.id\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(10);
    expect(normalized).not.toContain('sum(s.suggested_quantity)');
  });

  it('keeps open-key conflict handling aligned with the partial index', () => {
    expect(normalized.match(/on conflict \(suggestion_key\) where status = 'open'/g)).toHaveLength(2);
  });

  it('captures and returns the real line id for all three routes, including replay', () => {
    for (const key of [
      'warehouse_transfer_request_line_id',
      'warehouse_dispatch_line_id',
      'outlet_return_request_line_id',
    ]) {
      expect(normalized).toContain(`'${key}'`);
    }
    expect(normalized).toContain("'idempotent_replay', true");
  });

  it('prelocks canonical suggestion domains before delegated lifecycle locks', () => {
    expect(normalized).toContain("'inv_suggest:' || org_id::text");
    expect(normalized).toContain('public._phoenix_lock_inventory_resources(v_keys)');
    expect(normalized).toContain('order by s.id for update');
    expect(normalized).toContain('public._phoenix_lock_linked_suggestions');
    expect(normalized).toContain('_phoenix_149_delegate_');
  });

  it('rejects quantity increases on linked central and dispatch lines after the suggestion prelock', () => {
    expect(normalized.match(
      /v_linked_count\s*:=\s*public\._phoenix_lock_linked_suggestions/g,
    )).toHaveLength(2);
    expect(normalized).toContain('suggestion_linked_quantity_increase_requires_regeneration');
    expect(normalized.match(/errcode\s*=\s*'23514'/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(normalized).toMatch(
      /select requested_quantity[\s\S]*if p_requested_quantity > v_current_quantity/i,
    );
    expect(normalized).toMatch(
      /select sent_quantity[\s\S]*if p_quantity > v_current_quantity/i,
    );
  });

  it('closes a linked commitment before deleting its line', () => {
    const closeAt = normalized.indexOf("lineage_state = 'line_deleted'");
    const delegateAt = normalized.indexOf(
      'public._phoenix_149_delegate_delete_warehouse_transfer_request_line',
      closeAt,
    );
    expect(closeAt).toBeGreaterThan(0);
    expect(delegateAt).toBeGreaterThan(closeAt);
    expect(normalized).toContain("'lifecycle', 'commitment_closed'");
  });

  it('enforces the exact linked source-stock identity before direct central send', () => {
    expect(normalized).toContain(
      'draft_warehouse_transfer_request_line_id = p_transfer_request_line_id',
    );
    expect(normalized).toContain('v_expected_stock_id is distinct from p_warehouse_stock_id');
    expect(normalized).toContain('suggestion_source_stock_mismatch');
  });

  it('repairs outlet-return review and send headers from all live lines', () => {
    expect(normalized).toContain("status = 'approved'");
    expect(normalized).toContain("status = 'rejected'");
    expect(normalized).toContain("status not in ('fulfilled', 'rejected', 'cancelled')");
    expect(normalized).toContain("'partially_fulfilled'");
  });

  it('preserves public RPC signatures and authenticated-only execution', () => {
    for (const signature of [
      'phoenix_update_warehouse_transfer_request_line(uuid, integer, text)',
      'phoenix_send_direct_warehouse_transfer_line(uuid, uuid, uuid, integer, text, uuid, text, text)',
      'phoenix_receive_outlet_dispatch_line(uuid, uuid, integer, text, text, text)',
      'phoenix_receive_outlet_return_shipment_line(uuid, uuid, integer, text, text, text)',
    ]) {
      expect(normalized).toContain(`revoke all on function public.${signature} from public, anon`);
      expect(normalized).toContain(`grant execute on function public.${signature} to authenticated`);
    }
  });

  it('does not redefine reports, custody views, RLS policies, permission keys or stock ledgers', () => {
    expect(sql).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?VIEW/i);
    expect(sql).not.toMatch(/CREATE\s+POLICY|ALTER\s+POLICY/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+(?:public\.)?permission/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+(?:public\.)?(?:inventory_movement|movement_ledger)/i);
  });

  it('contains fail-closed deployment checks for index, helper ACL, readers and lineage FKs', () => {
    expect(normalized).toContain('abort 149: suggestion_key index contract is not partial-open');
    expect(normalized).toContain('abort 149: raw commitment reader remains');
    expect(normalized).toContain('abort 149: an internal helper is directly executable');
    expect(normalized).toContain('abort 149: explicit line/header lineage is incomplete');
  });
});

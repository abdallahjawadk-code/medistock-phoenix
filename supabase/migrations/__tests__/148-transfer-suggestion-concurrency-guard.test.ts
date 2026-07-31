import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  join(here, '..', '148_phoenix_transfer_suggestion_draft_bridge.sql'),
  'utf8',
);

function body(name: string) {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const start = sql.indexOf(marker);
  expect(start, `${name} definition`).toBeGreaterThan(-1);
  const as = sql.indexOf('AS $$', start);
  const end = sql.indexOf('$$;', as);
  return sql.slice(as, end);
}

describe('4B canonical transfer-suggestion concurrency contract', () => {
  it('uses a single sorted advisory-lock guardian', () => {
    const lock = body('_phoenix_lock_inventory_resources');
    expect(lock).toContain('SELECT DISTINCT btrim(k)');
    expect(lock).toContain('ORDER BY btrim(k)');
    expect(lock).toContain('pg_advisory_xact_lock(hashtextextended(v_key, 0))');
  });

  it('position keys are direction-neutral and never contain src:/tgt:', () => {
    const bridge = body('phoenix_create_transfer_draft_from_suggestion');
    expect(bridge).toContain("'inv_position:'");
    expect(bridge).not.toContain("'src:'");
    expect(bridge).not.toContain("'tgt:'");
    expect(bridge.indexOf("'inv_suggest:'")).toBeLessThan(bridge.indexOf('FOR UPDATE'));
  });

  it('protects missing/new stock rows through sorted scope anchors before stock rows', () => {
    const bridge = body('phoenix_create_transfer_draft_from_suggestion');
    const anchor = bridge.indexOf('AS x(scope_kind, scope_id, organization_id)');
    const stock = bridge.indexOf('FROM public.warehouse_stock ws WHERE ws.id = r.stock_id FOR UPDATE');
    expect(anchor).toBeGreaterThan(-1);
    expect(stock).toBeGreaterThan(anchor);
    expect(bridge).toContain('ORDER BY scope_kind, scope_id');
    expect(bridge).toContain('ORDER BY q.stock_kind, q.stock_id');
  });

  it('shares one broad threshold key across default/specific and coded/wildcard writers', () => {
    const bridge = body('phoenix_create_transfer_draft_from_suggestion');
    const upsert = body('phoenix_upsert_inventory_threshold');
    const batch = body('phoenix_batch_upsert_inventory_threshold');
    for (const fn of [bridge, upsert, batch]) expect(fn).toContain("'inv_threshold:'");
    expect(bridge).toContain('v_s.source_scope_kind');
    expect(bridge).not.toMatch(/inv_threshold:[^']*national_code/);
    expect(batch.indexOf('_phoenix_lock_inventory_resources(v_keys)'))
      .toBeLessThan(batch.indexOf('FOR v_item, v_ord IN'));
    expect(batch).toContain("ORDER BY lower(btrim(elem ->> 'scientific_name'))");
  });

  it('provenance is acquired before provenance/stock rows by bridge, guard and add-line', () => {
    const bridge = body('phoenix_create_transfer_draft_from_suggestion');
    const guard = body('phoenix_inventory_suggestion_guard');
    const addLine = body('phoenix_add_outlet_return_request_line');
    for (const fn of [bridge, guard, addLine]) expect(fn).toContain("'inv_provline:'");
    expect(addLine.indexOf("'inv_provline:'")).toBeLessThan(addLine.indexOf('FOR UPDATE'));
    expect(guard.indexOf("'inv_provline:'")).toBeLessThan(guard.indexOf("'inv_stock:'"));
  });
});

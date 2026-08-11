import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPubliclyAvailableQrItem } from '../PublicQrScreen';

const screen=readFileSync(join(__dirname,'..','PublicQrScreen.tsx'),'utf8');
const migration=readFileSync(join(__dirname,'../../../../supabase/migrations/177_phoenix_canonical_public_qr.sql'),'utf8');

describe('Stage G2 · public QR target-type compatibility',()=>{
  it('keeps medicine rows fail-closed by quantity/condition',()=>{
    expect(isPubliclyAvailableQrItem({quantity:5,condition:'available'})).toBe(true);
    expect(isPubliclyAvailableQrItem({quantity:0,condition:'available'})).toBe(false);
    expect(isPubliclyAvailableQrItem({quantity:5,condition:'expired'})).toBe(false);
    expect(isPubliclyAvailableQrItem({quantity:5})).toBe(false);
  });

  it('does not run warehouse point records through the medicine filter',()=>{
    expect(screen).toContain("targetType === 'warehouse' ? rawItems : rawItems.filter(isPubliclyAvailableQrItem)");
    expect(screen).toContain('item_count?: number');
    expect(screen).toContain("payload?.warehouse_label");
    expect(screen).toMatch(/typeof item\.item_count === 'number'/);
  });

  it('keeps distribution-point and local-item payloads medicine-shaped',()=>{
    expect(migration).toContain("'target_type','distribution_point'");
    expect(migration).toContain("'target_type','local_item'");
    expect(migration).toContain("'condition',s.effective_condition");
    expect(migration).toContain("'quantity',CASE WHEN s.effective_condition='expired' THEN NULL ELSE s.available_quantity END");
  });

  it('gives every local-item availability row its own canonical unit, not the central unit',()=>{
    const localItem=migration.slice(migration.indexOf("WHEN 'local_item' THEN"));
    // Sourced from the canonical stock identity...
    expect(localItem).toContain('min(s.unit) AS unit');
    // ...and the ROW object specifically must use it, never ci.unit, which is a
    // single label shared by every unit-distinct identity under this local item.
    const rowStart=localItem.indexOf('SELECT jsonb_agg(jsonb_build_object(');
    expect(rowStart).toBeGreaterThan(-1);
    // Executable lines only — the block's own commentary names ci.unit in order
    // to say it is NOT used, and a raw scan would match that explanation.
    const rowBuilder=localItem
      .slice(rowStart,localItem.indexOf('ORDER BY s.point_name_ar',rowStart))
      .split('\n').filter(l=>!l.trim().startsWith('--')).join('\n');
    expect(rowBuilder).toContain("'unit',NULLIF(s.unit,'')");
    expect(rowBuilder).not.toContain('ci.unit');
    // The top-level central unit stays for backward compatibility.
    expect(localItem).toContain("'unit',ci.unit");
  });

  it('renders a row unit next to the quantity, so 5 box and 3 strip stay distinguishable',()=>{
    // The screen already had this rendering path; the G2 defect was that the
    // local_item RPC never populated item.unit for it.
    expect(screen).toContain("{item.quantity}{item.unit ? ` ${item.unit}` : ''}");
    expect(screen).toContain('unit?: string;');
    // availability rows flow through the same PublicItem rendering as items.
    expect(screen).toContain('(payload?.availability as PublicItem[] | undefined)');
  });

  it('keeps warehouse payload point-shaped rather than faking medicine quantity/status',()=>{
    expect(migration).toContain("'target_type','warehouse'");
    expect(migration).toContain("'point_id',dp.id");
    expect(migration).toContain("'item_count',(");
    const warehouseStart=migration.indexOf("WHEN 'warehouse' THEN");
    const localItemStart=migration.indexOf("WHEN 'local_item' THEN");
    const warehouse=migration.slice(warehouseStart,localItemStart);
    expect(warehouse).not.toContain("'quantity'");
    expect(warehouse).not.toContain("'condition'");
  });
});

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
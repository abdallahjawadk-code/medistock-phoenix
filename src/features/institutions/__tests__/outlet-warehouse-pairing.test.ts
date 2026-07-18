/**
 * PRE-DESIGN-OUTLET-STRUCTURE-A
 *
 * Source-level regression coverage for the migration-066/067 outlet contract.
 * An operational outlet must be paired with one active institution warehouse
 * and use exactly pharmacy | crash_cabinet | rescue_cart. Legacy values remain
 * readable only so existing rows can be repaired through Edit.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const screen = readFileSync(new URL('../InstitutionScreen.tsx', import.meta.url), 'utf8');
const service = readFileSync(
  new URL('../../../shared/supabase/services/warehouses.service.ts', import.meta.url),
  'utf8',
);
const strings = readFileSync(
  new URL('../../../shared/i18n/strings.ts', import.meta.url),
  'utf8',
);

describe('service contract mirrors migrations 066/067', () => {
  it('defines the three approved operational point types separately from legacy values', () => {
    expect(service).toContain("type ApprovedPointType = 'pharmacy' | 'crash_cabinet' | 'rescue_cart'");
    for (const legacy of ['dispensing', 'storage', 'returns', 'emergency']) {
      expect(service).toContain(`'${legacy}'`);
    }
  });

  it('requires warehouseId when creating an outlet and writes warehouse_id', () => {
    const create = service.slice(
      service.indexOf('export async function createDistributionPoint'),
      service.indexOf('export async function updateDistributionPoint'),
    );
    expect(create).toMatch(/warehouseId:\s*string/);
    expect(create).toMatch(/pointType:\s*ApprovedPointType/);
    expect(create).toContain('warehouse_id:   input.warehouseId');
    expect(create).toContain("throw new Error('WAREHOUSE_REQUIRED')");
  });

  it('allows Edit to repair the warehouse pairing', () => {
    expect(service).toMatch(/warehouseId\?: string/);
    expect(service).toContain('update.warehouse_id = input.warehouseId');
  });

  it('loads warehouse_kind so the UI can exclude central warehouses', () => {
    expect(service).toContain('organization_id, warehouse_kind');
    expect(service).toContain('warehouseKind: r.warehouse_kind as WarehouseKind');
  });
});

describe('InstitutionScreen creates only structurally valid outlets', () => {
  it('loads RLS-visible warehouses for the selected organization', () => {
    expect(screen).toContain('getWarehouses');
    expect(screen).toContain('getWarehouses(orgId)');
  });

  it('offers only active institution warehouses for pairing', () => {
    expect(screen).toContain("w.warehouseKind === 'institution' && w.status === 'active'");
  });

  it('offers exactly the three approved outlet types', () => {
    const block = screen.slice(
      screen.indexOf('const APPROVED_POINT_TYPES'),
      screen.indexOf('const POINT_TYPE_LABEL_KEY'),
    );
    for (const type of ['pharmacy', 'crash_cabinet', 'rescue_cart']) {
      expect(block).toContain(`value: '${type}'`);
    }
    for (const legacy of ['dispensing', 'storage', 'returns', 'emergency']) {
      expect(block).not.toContain(`value: '${legacy}'`);
    }
  });

  it('never hardcodes dispensing in the create payload', () => {
    const create = screen.slice(
      screen.indexOf('function AddPortForm'),
      screen.indexOf('function PortCard'),
    );
    expect(create).toContain('warehouseId,');
    expect(create).toContain('pointType,');
    expect(create).not.toMatch(/pointType:\s*['"]dispensing['"]/);
    expect(create).not.toMatch(/point_type:\s*['"]dispensing['"]/);
  });

  it('blocks submit without both a warehouse and a name', () => {
    expect(screen).toMatch(/portName\.trim\(\)\.length > 0[\s\S]{0,180}warehouseId\.length > 0/);
  });

  it('Edit repairs legacy rows by requiring a warehouse and approved type', () => {
    const edit = screen.slice(
      screen.indexOf('const [editName'),
      screen.indexOf('const ptTypeKey'),
    );
    expect(edit).toContain("isApprovedPointType(point.pointType) ? point.pointType : 'pharmacy'");
    expect(edit).toContain('warehouseId: editWarehouseId');
    expect(edit).toContain('pointType: editPointType');
  });

  it('warns instead of pretending an old/unpaired row is operational', () => {
    expect(screen).toContain('const operationallyValid =');
    expect(screen).toContain("t('port_operational_fix_required', lang)");
  });
});

describe('bilingual labels exist', () => {
  it('contains Arabic and English labels for each approved outlet type', () => {
    for (const key of [
      'port_type_pharmacy',
      'port_type_crash_cabinet',
      'port_type_rescue_cart',
      'port_operational_fix_required',
    ]) {
      expect(strings).toContain(`${key}:`);
    }
  });
});

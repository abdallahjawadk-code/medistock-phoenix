/**
 * Availability Editor Institution UX Tests (AVAILABILITY-EDITOR-INSTITUTION-UX-A, Part G)
 * Run: npm test -- --run
 *
 * Static source-code tests verifying the UX changes without a DB connection.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SRC     = join(__dirname, '../../../');
const PHOENIX = join(__dirname, '../../../../');

function readSrc(rel: string) {
  return readFileSync(join(SRC, rel), 'utf8');
}

function readPhoenix(rel: string) {
  return readFileSync(join(PHOENIX, rel), 'utf8');
}

function allTsxFiles(dir: string): string[] {
  const base = join(SRC, dir);
  return readdirSync(base, { recursive: true })
    .filter((f): f is string =>
      typeof f === 'string' &&
      (f.endsWith('.ts') || f.endsWith('.tsx')) &&
      !f.includes('__tests__') &&
      !f.endsWith('.test.ts') &&
      !f.endsWith('.spec.ts')
    )
    .map(f => join(base, f));
}

function readFile(path: string) {
  return readFileSync(path, 'utf8');
}

const editor  = readSrc('features/editor/EditorScreen.tsx');
const strings = readSrc('shared/i18n/strings.ts');
const types   = readSrc('shared/lib/types.ts');
const service = readSrc('shared/supabase/services/availability.service.ts');

// ============================================================================
// Part A — Institution auto-selection
// ============================================================================

describe('Part A: Institution auto-selection for institution users', () => {
  it('institution-scoped user sees locked display, not dropdown', () => {
    expect(editor).toContain('lockedFieldStyle');
    expect(editor).toContain('avail_inst_locked_note');
  });

  it('super_admin still sees institution dropdown', () => {
    expect(editor).toContain('isSuper');
    expect(editor).toContain('<select id="ed-inst"');
  });

  it('locked display uses myOrg data for org name', () => {
    expect(editor).toContain('myOrgName');
    expect(editor).toContain('myOrg.data');
  });

  it('locked note is bilingual', () => {
    expect(strings).toContain('تم تحديد المؤسسة تلقائيًا حسب حسابك.');
    expect(strings).toContain('Institution is selected automatically based on your account.');
  });

  it('institution label is bilingual', () => {
    expect(strings).toContain("avail_inst_label");
    expect(strings).toContain("'المؤسسة'");
    expect(strings).toContain("'Institution'");
  });

  it('non-super users only load their own org, not the full list', () => {
    expect(editor).toContain('isSuper ? getOrganizations() : Promise.resolve([])');
    expect(editor).toContain('getOrganization(activeOrgId)');
  });
});

// ============================================================================
// Part B — "الصنف" replaced with "المنفذ" (free text)
// ============================================================================

describe('Part B: "الصنف" replaced by "المنفذ" free text input', () => {
  it('"الصنف" label is NOT used in the editor', () => {
    expect(editor).not.toContain("t('item', lang)");
  });

  it('"المنفذ" label appears in the editor', () => {
    expect(editor).toContain("avail_port_field");
  });

  it('port field is a free text input, not a dropdown', () => {
    expect(editor).toContain('<input id="ed-port" type="text"');
  });

  it('port field uses placeholder from i18n', () => {
    expect(editor).toContain("avail_port_ph");
  });

  it('port field is required (included in canSubmit)', () => {
    expect(editor).toContain('portName.trim()');
  });

  it('bilingual port labels exist', () => {
    expect(strings).toContain('المنفذ');
    expect(strings).toContain('Access point / Port');
    expect(strings).toContain('اكتب اسم المنفذ');
    expect(strings).toContain('Enter access point / port name');
  });
});

// ============================================================================
// Part C — "رقم الدفعة" renamed to "الرمز الوطني"
// ============================================================================

describe('Part C: "رقم الدفعة" renamed to "الرمز الوطني"', () => {
  it('"رقم الدفعة" label is NOT used in the editor', () => {
    expect(editor).not.toContain("t('batch_no', lang)");
  });

  it('"الرمز الوطني" label appears in the editor', () => {
    expect(editor).toContain('avail_national_code');
  });

  it('bilingual national code labels exist', () => {
    expect(strings).toContain('الرمز الوطني');
    expect(strings).toContain('National code');
    expect(strings).toContain('أدخل الرمز الوطني');
    expect(strings).toContain('Enter national code');
  });

  it('still stores into the batch_number column (no DB rename)', () => {
    expect(service).toContain('batch_number');
    expect(service).toContain('batchNumber');
  });
});

// ============================================================================
// Part D — Material status localization
// ============================================================================

describe('Part D: Material status localization', () => {
  it('raw "low_stock" enum is never shown as UI text', () => {
    const conditionDropdownArea = editor.slice(
      editor.indexOf('CONDITION_OPTIONS'),
      editor.indexOf('EditorScreen')
    );
    expect(conditionDropdownArea).not.toContain("'low_stock' as label");
    expect(editor).toContain("t(opt.labelKey, lang)");
  });

  it('label key is "موقف المادة" / "Material status"', () => {
    expect(strings).toContain("avail_material_status");
    expect(strings).toContain('موقف المادة');
    expect(strings).toContain('Material status');
  });

  it('all four condition options have localized keys', () => {
    expect(strings).toContain('cond_available');
    expect(strings).toContain('cond_low_stock');
    expect(strings).toContain('cond_missing');
    expect(strings).toContain('cond_surplus');
  });

  it('Arabic options are correct', () => {
    expect(strings).toContain('متوفرة');
    expect(strings).toContain('قليلة / شحيحة');
    expect(strings).toContain('مفقودة');
    expect(strings).toContain('الفائضة - قريبة النفاذ');
  });

  it('English options are correct', () => {
    expect(strings).toContain("'Available'");
    expect(strings).toContain("'Low stock'");
    expect(strings).toContain("'Missing'");
    expect(strings).toContain("'Surplus - Near expiry'");
  });

  it('surplus and near_expiry both display as the combined wording', () => {
    expect(strings).toContain('cond_surplus');
    expect(strings).toContain('cond_near_expiry');
    const surplusLine = strings.split('\n').find(l => l.includes('cond_surplus'));
    const nearLine = strings.split('\n').find(l => l.includes('cond_near_expiry'));
    expect(surplusLine).toContain('الفائضة - قريبة النفاذ');
    expect(nearLine).toContain('الفائضة - قريبة النفاذ');
  });
});

// ============================================================================
// Part E — Supply type (institution-private)
// ============================================================================

describe('Part E: "نوع التجهيز" field', () => {
  it('supply type field appears in the editor', () => {
    expect(editor).toContain('avail_supply_type');
    expect(editor).toContain('<input id="ed-supply"');
  });

  it('supply type is a free text input', () => {
    expect(editor).toContain('type="text"');
    expect(editor).toContain('supplyType');
  });

  it('bilingual supply type labels exist', () => {
    expect(strings).toContain('نوع التجهيز');
    expect(strings).toContain('Supply type');
    expect(strings).toContain('اكتب نوع التجهيز');
    expect(strings).toContain('Enter supply type');
  });

  it('supply type is passed to upsert service', () => {
    expect(editor).toContain('supplyType: supplyType');
    expect(service).toContain('supply_type');
    expect(service).toContain('supplyType');
  });

  it('AvailabilityRecord type includes supply_type', () => {
    expect(types).toContain('supply_type');
  });
});

// ============================================================================
// Part F — Bilingual strings completeness
// ============================================================================

describe('Part F: Bilingual strings completeness', () => {
  const REQUIRED_KEYS = [
    'avail_inst_label',
    'avail_inst_locked_note',
    'avail_port_field',
    'avail_port_ph',
    'avail_national_code',
    'avail_national_code_ph',
    'avail_material_status',
    'cond_available',
    'cond_low_stock',
    'cond_missing',
    'cond_surplus',
    'cond_near_expiry',
    'avail_supply_type',
    'avail_supply_type_ph',
  ];

  REQUIRED_KEYS.forEach(key => {
    it(`string key "${key}" exists in strings.ts`, () => {
      expect(strings).toContain(key);
    });
  });
});

// ============================================================================
// Migration 019 safety
// ============================================================================

describe('Migration 019: availability editor institution UX', () => {
  const sql = readPhoenix('supabase/migrations/019_phoenix_availability_editor_institution_ux.sql');

  it('file exists and is non-empty', () => {
    expect(sql.length).toBeGreaterThan(500);
  });

  it('is manual-apply-only', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('DO NOT use');
    expect(sql).toContain('supabase db push');
  });

  it('has no DROP, TRUNCATE, or destructive DELETE', () => {
    expect(sql).not.toMatch(/^\s*(drop table|drop function|truncate)\b/im);
    expect(sql).not.toMatch(/^\s*delete from\b/im);
  });

  it('has no unsafe CASCADE in SQL statements (comments excluded)', () => {
    const sqlStatements = sql.split('\n').filter(l => !l.trimStart().startsWith('--'));
    const joined = sqlStatements.join('\n');
    expect(joined).not.toMatch(/cascade/i);
  });

  it('does not write to auth.users', () => {
    expect(sql).not.toMatch(/\b(insert|update|delete)\b.*auth\.users/i);
  });

  it('adds port_name column', () => {
    expect(sql).toContain('add column if not exists port_name');
  });

  it('adds supply_type column', () => {
    expect(sql).toContain('add column if not exists supply_type');
  });

  it('makes local_item_id nullable', () => {
    expect(sql).toContain('drop not null');
    expect(sql).toContain('local_item_id');
  });

  it('adds identity check constraint', () => {
    expect(sql).toContain('item_availability_identity_chk');
    expect(sql).toContain('local_item_id is not null or port_name is not null');
  });

  it('creates unique index for port_name upsert', () => {
    expect(sql).toContain('item_avail_point_port_idx');
    expect(sql).toContain('distribution_point_id, port_name');
  });

  it('does not modify condition CHECK constraint', () => {
    expect(sql).not.toContain("check (condition");
  });

  it('does not modify RLS policies', () => {
    expect(sql).not.toContain('create policy');
    expect(sql).not.toContain('alter policy');
  });

  it('does not modify permission RPCs', () => {
    expect(sql).not.toContain('phoenix_profile_has_permission');
    expect(sql).not.toContain('assign_profile_role');
  });

  it('includes a verification block', () => {
    expect(sql).toContain('assert');
    expect(sql).toContain('VERIFY');
  });

  it('is idempotent (uses IF NOT EXISTS / IF EXISTS patterns)', () => {
    expect(sql).toContain('if not exists');
    expect(sql).toContain('add column if not exists');
    expect(sql).toContain('create unique index if not exists');
  });

  it('does not reference service_role', () => {
    expect(sql).not.toContain('service_role');
  });
});

// ============================================================================
// Service layer: upsert supports both flows
// ============================================================================

describe('Service: availability upsert supports port_name flow', () => {
  it('UpsertAvailabilityInput has portName field', () => {
    expect(service).toContain('portName');
  });

  it('UpsertAvailabilityInput has supplyType field', () => {
    expect(service).toContain('supplyType');
  });

  it('upsert targets port_name conflict key for free-text flow', () => {
    expect(service).toContain("onConflict: 'distribution_point_id,port_name'");
  });

  it('upsert still supports legacy localItemId flow', () => {
    expect(service).toContain("onConflict: 'local_item_id,distribution_point_id'");
  });

  it('requires exactly one of localItemId or portName', () => {
    expect(service).toContain('localItemId');
    expect(service).toContain('portName');
  });
});

// ============================================================================
// Security guardrails (unchanged)
// ============================================================================

describe('Security: no service_role, no auth.admin in frontend', () => {
  const files = allTsxFiles('');

  it('no service_role in any frontend file', () => {
    files.forEach(path => {
      expect(readFile(path)).not.toContain('service_role');
    });
  });

  it('no auth.admin in any frontend file', () => {
    files.forEach(path => {
      expect(readFile(path)).not.toMatch(/auth\.admin/);
    });
  });
});

describe('Safety: Data Reset absent, Intake disabled', () => {
  const files = allTsxFiles('');

  it('no DataReset import', () => {
    files.forEach(path => {
      expect(readFile(path)).not.toMatch(/import.*DataReset/i);
    });
  });

  it('no OcrImport, ExcelImport, DocIntel import', () => {
    files.forEach(path => {
      const content = readFile(path);
      expect(content).not.toMatch(/import.*OcrImport/i);
      expect(content).not.toMatch(/import.*ExcelImport/i);
      expect(content).not.toMatch(/import.*DocIntel/i);
    });
  });
});

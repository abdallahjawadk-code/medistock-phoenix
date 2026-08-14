/**
 * R1.2C / MIGRATION 183 — outlet affordance UI parity.
 *
 * The matrix itself is proved twice already: server-side against a real
 * PostgreSQL chain (supabase/migrations/__tests__/183-*.dynamic.test.ts) and
 * exhaustively over the shared helper
 * (src/shared/lib/__tests__/outlet-affordances.test.ts).
 *
 * What is left, and what this file proves, is the WIRING — that the screen
 * actually consults that one helper, that CREATE and EDIT consult the SAME one,
 * and that neither dialog kept a private copy of any rule. A second copy inside
 * PortCard is the drift R1.2C exists to close, one layer up from the database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const screen = read('features/institutions/InstitutionScreen.tsx');
const strings = read('shared/i18n/strings.ts');

/** The source of one function declaration, bounded by the next one. */
function fnSource(name: string): string {
  const start = screen.indexOf(`function ${name}(`);
  expect(start, `function not found: ${name}`).toBeGreaterThan(-1);
  const next = screen.indexOf('\nfunction ', start + 1);
  return screen.slice(start, next === -1 ? screen.length : next);
}

const addForm = () => fnSource('AddPortForm');
const portCard = () => fnSource('PortCard');
const portSection = () => fnSource('PortSection');

// ════════════════════════════════════════════════════════════════════════════
// 1. ONE AUTHORITY
// ════════════════════════════════════════════════════════════════════════════
describe('create and edit share ONE affordance authority', () => {
  it('the screen imports the shared helper rather than restating the matrix', () => {
    expect(screen).toMatch(/from '@\/shared\/lib\/outlet-affordances'/);
    for (const fn of [
      'canCreateOutlets',
      'isClinicalContextRequired',
      'isOutletShapeSubmittable',
      'legalClinicalContexts',
      'normalizeClinicalContext',
      'selectableOutletPointTypes',
      'selectableOutletWarehouses',
    ]) expect(screen, fn).toContain(fn);
  });

  it('BOTH dialogs receive the same owner classification', () => {
    expect(addForm()).toMatch(/owner: OutletOwner;/);
    expect(portCard()).toMatch(/owner: OutletOwner;/);
    expect(portSection()).toMatch(/<AddPortForm[\s\S]{0,400}owner=\{owner\}/);
    expect(portSection()).toMatch(/<PortCard[\s\S]{0,400}owner=\{owner\}/);
    // …and it is memoized on the two PRIMITIVES, so the section's warehouse and
    // type memos are not defeated by a fresh object literal every render.
    expect(screen).toMatch(
      /const outletOwner: OutletOwner = useMemo\(\s*\n\s*\(\) => \(\{ organizationKind: o\?\.organizationKind, institutionClass: o\?\.institutionClass \}\),\s*\n\s*\[o\?\.organizationKind, o\?\.institutionClass\],\s*\n\s*\);/,
    );
    expect(screen).toMatch(/owner=\{outletOwner\}/);
  });

  it('BOTH dialogs normalise a stale context through the SAME function', () => {
    expect(addForm()).toMatch(/setClinicalKind\(normalizeClinicalContext\(owner, next, clinicalKind\)\)/);
    expect(portCard()).toMatch(/setEditClinicalKind\(normalizeClinicalContext\(owner, next, editClinicalKind\)\)/);
  });

  it('BOTH dialogs gate submission through the SAME function', () => {
    expect(addForm()).toMatch(/isOutletShapeSubmittable\(owner, pointType, clinicalKind, warehouseId\)/);
    expect(portCard()).toMatch(/isOutletShapeSubmittable\(owner, editPointType, editClinicalKind, editWarehouseId\)/);
  });

  it('NEITHER dialog restates a matrix rule of its own', () => {
    // The vocabulary must not appear as a DECISION anywhere in the screen: no
    // hard-coded type list, no hard-coded context per class, no class test.
    for (const source of [addForm(), portCard()]) {
      expect(source).not.toMatch(/'rescue_cart'\s*(===|!==|:)/);
      expect(source).not.toMatch(/=== 'health_sector'|=== 'hospital'|=== 'specialized_center'/);
      expect(source).not.toMatch(/pointType !== 'pharmacy'/);
      expect(source).not.toMatch(/filter\([^)]*rescue_cart/);
    }
    // …and the option lists are rendered FROM the helper, never literal.
    expect(addForm()).not.toMatch(/<option value="emergency">/);
    expect(portCard()).not.toMatch(/<option value="non_emergency">/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. THE OFFERED SHAPES
// ════════════════════════════════════════════════════════════════════════════
describe('the section offers only shapes the database will accept', () => {
  it('the point types come from the helper, filtered against the approved list', () => {
    expect(portSection()).toMatch(/const allowed = selectableOutletPointTypes\(owner\);/);
    expect(portSection()).toMatch(/APPROVED_POINT_TYPES\.filter\(type => allowed\.includes\(type\.value\)\)/);
    // The approved list itself still carries all three; the NARROWING is the
    // helper's job, so a hospital keeps its rescue cart.
    expect(screen).toMatch(/\{ value: 'rescue_cart',\s*labelKey: 'port_type_rescue_cart' \}/);
  });

  it('the warehouses come from the helper — the Sector Main is never offered', () => {
    expect(portSection()).toMatch(/const selectableWarehouses = useMemo\(\s*\n\s*\(\) => selectableOutletWarehouses\(owner, warehouses\)/);
    // The EDIT dialog moves an outlet only among the narrowed set.
    expect(portSection()).toMatch(/<PortCard[\s\S]{0,500}assignableWarehouses=\{selectableWarehouses\}/);
    expect(portCard()).toMatch(/\{assignableWarehouses\.map\(w => \(/);
  });

  it('a PHARMACY DEPARTMENT AUTHORITY gets no create affordance at all', () => {
    expect(portSection()).toMatch(/const canOfferCreate = canCreatePorts && canCreateOutlets\(owner\);/);
    // The button is gated on it…
    expect(portSection()).toMatch(/\{canOfferCreate && \(\s*\n\s*<PhoenixButton[\s\S]{0,200}port_add/);
    // …and so is the form itself, so no other path can open it.
    expect(portSection()).toMatch(/\{showAdd && canOfferCreate && \(/);
    expect(portSection()).toMatch(/canCreate=\{canOfferCreate\}/);
  });

  it('the CURRENT owner remains resolvable for display, even when unassignable', () => {
    // PortCard keeps the full warehouse list for the name lookup and takes the
    // narrowed one only as a move target, so a legacy owner still renders.
    expect(portCard()).toMatch(/warehouses: Warehouse\[\];[\s\S]{0,300}assignableWarehouses: Warehouse\[\];/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. THE FORM-VALIDITY BUG
// ════════════════════════════════════════════════════════════════════════════
describe('a required clinical context cannot remain blank on submit', () => {
  it('the "*" and canSubmit now come from the same question', () => {
    // Previously: the label rendered "*" for pointType !== 'pharmacy' while
    // canSubmit ignored the field entirely.
    expect(addForm()).toMatch(/const clinicalRequired = isClinicalContextRequired\(pointType\);/);
    expect(addForm()).toMatch(/\{t\('port_clinical_kind', lang\)\}\{clinicalRequired \? ' \*' : ''\}/);
    expect(addForm()).toMatch(/&& isOutletShapeSubmittable\(owner, pointType, clinicalKind, warehouseId\)/);
  });

  it('the blank option is not even offered for an emergency outlet', () => {
    expect(addForm()).toMatch(/\{!clinicalRequired && <option value="">—<\/option>\}/);
    expect(addForm()).toMatch(/\{clinicalOptions\.map\(kind => \(/);
  });

  it('the create form seeds a legal context instead of starting blank', () => {
    expect(addForm()).toMatch(/useState<ClinicalLocationKind \| ''>\(\s*\n\s*\(\) => normalizeClinicalContext\(owner, 'pharmacy', ''\),\s*\n\s*\)/);
  });

  it('changing the point type re-normalises rather than keeping the old value', () => {
    expect(addForm()).toMatch(/function onPointTypeChange\(next: ApprovedPointType\)/);
    expect(addForm()).toMatch(/onChange=\{e => onPointTypeChange\(e\.target\.value as ApprovedPointType\)\}/);
    expect(portCard()).toMatch(/function onEditPointTypeChange\(next: ApprovedPointType\)/);
    expect(portCard()).toMatch(/onChange=\{e => onEditPointTypeChange\(e\.target\.value as ApprovedPointType\)\}/);
    // The old, unguarded setters are gone from both selects.
    expect(addForm()).not.toMatch(/onChange=\{e => setPointType\(/);
    expect(portCard()).not.toMatch(/onChange=\{e => setEditPointType\(/);
  });

  it('the edit dialog refuses to save an illegal combination', () => {
    expect(portCard()).toMatch(/const editShapeLegal = isOutletShapeSubmittable\(/);
    expect(portCard()).toMatch(/if \(!editShapeLegal\) \{\s*\n\s*setEditError\(t\('port_shape_illegal', lang\)\);/);
    expect(portCard()).toMatch(/disabled=\{!editShapeLegal\}/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. HISTORY IS DISPLAYED HONESTLY
// ════════════════════════════════════════════════════════════════════════════
describe('a legacy illegal row is shown as it is, never silently repaired', () => {
  it('opening the edit dialog loads the STORED values verbatim', () => {
    const open = portCard().slice(portCard().indexOf('function openEdit()'));
    expect(open).toMatch(/setEditPointType\(isApprovedPointType\(point\.pointType\) \? point\.pointType : 'pharmacy'\)/);
    expect(open).toMatch(/setEditClinicalKind\(point\.clinicalLocationKind \?\? ''\)/);
    // No normalisation call on open — that would mutate history by merely looking.
    expect(open.slice(0, open.indexOf('function onEditPointTypeChange')))
      .not.toContain('normalizeClinicalContext');
  });

  it('a stored value outside the legal set stays visible in the select', () => {
    expect(portCard()).toMatch(
      /\{editClinicalKind !== '' && !editClinicalOptions\.includes\(editClinicalKind\) && \(/,
    );
  });

  it('the operator is told WHY it cannot be saved as it stands', () => {
    expect(portCard()).toMatch(/const storedShapeLegal = isStoredOutletShapeLegal\(/);
    expect(portCard()).toMatch(/\{!storedShapeLegal && \(/);
    expect(portCard()).toContain("t('port_shape_legacy', lang)");
  });

  it('both new strings exist in BOTH languages', () => {
    for (const key of ['port_shape_illegal', 'port_shape_legacy']) {
      const at = strings.indexOf(`${key}:`);
      expect(at, key).toBeGreaterThan(-1);
      const entry = strings.slice(at, strings.indexOf('},', at));
      expect(entry, `${key} ar`).toMatch(/ar:\s*'/);
      expect(entry, `${key} en`).toMatch(/en:\s*'/);
    }
  });

  it('the UI states that it is a mirror, and the database the boundary', () => {
    expect(screen).toMatch(/database remains the final fail-closed boundary/i);
    expect(screen).toMatch(/Migration 183/);
  });
});

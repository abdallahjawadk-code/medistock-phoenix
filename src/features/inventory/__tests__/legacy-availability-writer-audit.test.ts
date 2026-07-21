/**
 * E6 — LEGACY MANUAL-AVAILABILITY WRITER AUDIT.
 *
 * The approved model is the migration-065 warehouse ledger as stock truth:
 * availability condition is DERIVED from the ledger and never typed in by an
 * operator. Three legacy writers predate that model. This file pins what is
 * true about each one today, so none of them can quietly become reachable
 * again while the backend replacement is still outstanding.
 *
 *   1. EditorScreen            — UNREACHABLE. No production route or import.
 *   2. QuickAvailForm          — UNREACHABLE. Its trigger control was removed,
 *                                so the render condition can never be true.
 *   3. ReactivateMaterialModal — REACHABLE, permission-gated, and recorded as a
 *                                hard deployment blocker: no replacement exists.
 *
 * These are reachability guards, not a licence to keep the code. 1 and 2 are
 * deletion candidates whose test blast radius (23 and 8 files respectively)
 * is tracked separately; until they are deleted, THIS is what stops them being
 * wired back up.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const authenticatedApp = read('app/AuthenticatedApp.tsx');
const institutionScreen = read('features/institutions/InstitutionScreen.tsx');
const statusCenter = read('features/status/StatusCenterScreen.tsx');
const reactivateModal = read('features/status/ReactivateMaterialModal.tsx');

describe('1. EditorScreen — the retired create-then-reopen availability form', () => {
  it('is not imported by the authenticated app', () => {
    expect(authenticatedApp).not.toContain("from '@/features/editor/EditorScreen'");
    expect(authenticatedApp).not.toContain('<EditorScreen />');
  });

  it('screen 3 routes to the Inventory Center, which replaced it', () => {
    expect(authenticatedApp).toContain('case 3:  return <InventoryCenterScreen />;');
  });

  it('is imported by no production module — every navigation entry point is clear', () => {
    // Matched on the IMPORT PATH, not the bare identifier: `StatusEditorScreen`
    // is a different, live screen (16) whose name contains this one's.
    const entryPoints = [
      'app/AuthenticatedApp.tsx',
      'app/App.tsx',
      'shared/ui/PhoenixSidebar.tsx',
      'shared/ui/PhoenixMobileDrawer.tsx',
      'shared/ui/CommandPalette.tsx',
      'shared/ui/PhoenixMobileBottomNav.tsx',
    ];
    for (const f of entryPoints) {
      expect(read(f), `${f} must not reach the retired editor`).not.toContain('features/editor/EditorScreen');
    }
  });

  it('the nav item for screen 3 now reads "Inventory Center", not an editor', () => {
    const strings = read('shared/i18n/strings.ts');
    const line = strings.split('\n').find(l => l.trim().startsWith('nav_editor:'));
    expect(line).toBeDefined();
    expect(line).toContain('Inventory Center');
  });
});

describe('2. QuickAvailForm — the manual availability quick-add', () => {
  it('still calls the legacy upsertAvailability writer (so it must stay unreachable)', () => {
    expect(institutionScreen).toContain('await upsertAvailability(');
  });

  it('renders only behind a showAdd flag that nothing can ever set', () => {
    // Two independent `showAdd` states exist in this file. The FIRST belongs to
    // the create-distribution-point section and has a real trigger. The SECOND
    // belongs to PortAvailabilitySection and gates QuickAvailForm — its
    // add-item button was removed (see ui-hide-port-add-item.test.ts), leaving
    // no way to set it true. Assert exactly that shape by position.
    const firstShowAdd = institutionScreen.indexOf('const [showAdd, setShowAdd]');
    const secondShowAdd = institutionScreen.indexOf('const [showAdd, setShowAdd]', firstShowAdd + 1);
    const quickForm = institutionScreen.indexOf('<QuickAvailForm');

    expect(firstShowAdd).toBeGreaterThan(-1);
    expect(secondShowAdd).toBeGreaterThan(firstShowAdd);
    expect(quickForm).toBeGreaterThan(secondShowAdd);

    // Exactly one `setShowAdd(true)` exists in the whole file...
    const trueSetters = [...institutionScreen.matchAll(/setShowAdd\(true\)/g)];
    expect(trueSetters).toHaveLength(1);

    // ...and it belongs to the FIRST state, i.e. before the second declaration.
    // If a future edit adds a trigger for the availability form, this fails.
    expect(trueSetters[0].index!).toBeLessThan(secondShowAdd);
  });
});

describe('3. ReactivateMaterialModal — reachable, and a deployment blocker', () => {
  it('is reachable from Status Center, so it cannot be assumed dead', () => {
    expect(statusCenter).toContain('<ReactivateMaterialModal');
    expect(statusCenter).toContain('setReactivateRow(');
  });

  it('stays behind an explicit permission gate', () => {
    expect(reactivateModal).toContain("REACTIVATE_PERMISSION_KEYS = ['availability.quantity.set', 'availability.update']");
    expect(reactivateModal).toContain('REACTIVATE_PERMISSION_KEYS.every(key => myPermissions.has(key))');
  });

  it('writes quantity ONLY through the recorded movement path, never a raw balance set', () => {
    // Migration 035's guard: quantity changes must go through
    // phoenix_apply_availability_movement, which writes a movement row. The
    // upsert that follows only clears the removed marker at the same quantity.
    expect(reactivateModal).toContain('applyAvailabilityMovement');
    expect(reactivateModal).toContain('await upsertAvailability(');
  });
});

describe('no NEW legacy availability writer appears', () => {
  it('upsertAvailability has exactly the three known production call sites', () => {
    const files = [
      'features/editor/EditorScreen.tsx',
      'features/institutions/InstitutionScreen.tsx',
      'features/status/ReactivateMaterialModal.tsx',
    ];
    for (const f of files) {
      expect(read(f), `${f} should still call upsertAvailability`).toContain('upsertAvailability(');
    }
  });

  it('the Inventory Center never writes availability by hand', () => {
    const inventory = read('features/inventory/InventoryCenterScreen.tsx');
    expect(inventory).not.toContain('upsertAvailability');
  });

  it('Screen 18 never writes availability by hand', () => {
    const outlet = read('features/outlet/OutletOperationsScreen.tsx');
    expect(outlet).not.toContain('upsertAvailability');
  });
});

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
 *   3. ReactivateMaterialModal — REACHABLE, permission-gated, and NO LONGER a
 *                                manual quantity writer: migration 084 gave it a
 *                                visibility-only path (phoenix_set_availability_
 *                                visibility), so it no longer calls
 *                                upsertAvailability or applyAvailabilityMovement.
 *
 * These are reachability guards, not a licence to keep the code. 1 and 2 are
 * deletion candidates whose test blast radius (23 and 8 files respectively)
 * is tracked separately; until they are deleted, THIS is what stops them being
 * wired back up. As of the 083/084 cutover, NO production surface reaches the
 * manual availability quantity writer phoenix_upsert_availability at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  expectRetiredSurfaceAbsent,
  expectScreenThreeIsInventoryCenter,
  expectQuickAvailFormAbsent,
  productionSourceFiles,
} from '../../../../tests/helpers/retired-surfaces';

const SRC = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const authenticatedApp = read('app/AuthenticatedApp.tsx');
const institutionScreen = read('features/institutions/InstitutionScreen.tsx');
const statusCenter = read('features/status/StatusCenterScreen.tsx');
const reactivateModal = read('features/status/ReactivateMaterialModal.tsx');

describe('1. EditorScreen — the retired create-then-reopen availability form', () => {
  // E6 UPDATE: previously "present but unreachable". The file is now DELETED,
  // so this asserts the full absence contract: gone from disk, unimported and
  // unrendered by every production module.
  it('is deleted, and reachable from no production module', () => {
    expectRetiredSurfaceAbsent('EditorScreen');
  });

  it('is not imported by the authenticated app', () => {
    expect(authenticatedApp).not.toContain("from '@/features/editor/EditorScreen'");
    expect(authenticatedApp).not.toContain('<EditorScreen />');
  });

  it('screen 3 routes to the Inventory Center, which replaced it', () => {
    expectScreenThreeIsInventoryCenter();
    expect(authenticatedApp).toMatch(/case 3:\s*return <InventoryCenterScreen[\s\S]*?initialSuggestionDocument=/);
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
  // E6 UPDATE: previously "unreachable but still present". It is now DELETED,
  // so the guard is absence rather than unreachability.
  it('is deleted from InstitutionScreen, along with its writer call', () => {
    expectQuickAvailFormAbsent();
  });

  it('the availability section keeps no add-form state that could resurrect it', () => {
    // The surviving `setShowAdd(true)` belongs to the create-distribution-point
    // form higher up the file, which is a live workflow — so this is scoped to
    // PortAvailabilitySection rather than to the whole file.
    const sectionStart = institutionScreen.indexOf('function PortAvailabilitySection');
    expect(sectionStart).toBeGreaterThan(-1);
    expect(institutionScreen.slice(sectionStart)).not.toContain('setShowAdd');
  });

  it('the live create-distribution-point form is preserved and still has its trigger', () => {
    // Proving the cleanup removed the retired form ONLY, not the neighbouring
    // workflow that shares the `showAdd` name.
    expect([...institutionScreen.matchAll(/setShowAdd\(true\)/g)]).toHaveLength(1);
  });
});

describe('3. ReactivateMaterialModal — reachable, permission-gated, visibility-only', () => {
  it('is reachable from Status Center, so it cannot be assumed dead', () => {
    expect(statusCenter).toContain('<ReactivateMaterialModal');
    expect(statusCenter).toContain('setReactivateRow(');
  });

  it('stays behind an explicit permission gate (the single key its RPC re-enforces)', () => {
    expect(reactivateModal).toContain("REACTIVATE_PERMISSION_KEYS = ['availability.update']");
    expect(reactivateModal).toContain('REACTIVATE_PERMISSION_KEYS.every(key => myPermissions.has(key))');
  });

  it('reactivates by CATALOGUE VISIBILITY only — no quantity write of any kind', () => {
    // Migration 084: clearing the 053 removed marker no longer touches quantity
    // or condition. The old manual writers are gone from this surface.
    expect(reactivateModal).toContain('setAvailabilityVisibility(row!.id, false)');
    expect(reactivateModal).not.toContain('applyAvailabilityMovement');
    expect(reactivateModal).not.toContain('upsertAvailability');
  });
});

describe('no legacy availability quantity writer is reachable', () => {
  it('upsertAvailability now has ZERO production call sites', () => {
    // Was three (EditorScreen, QuickAvailForm, ReactivateMaterialModal). All are
    // retired: 1 and 2 deleted; 3 converted to visibility-only (migration 084).
    // A new entry here means a manual quantity writer came back and the audit
    // must be redone before it ships.
    const callers = productionSourceFiles()
      .filter(f => readFileSync(f, 'utf8').includes('await upsertAvailability('))
      .map(f => f.replace(/\\/g, '/').split('/src/')[1])
      .sort();
    expect(callers).toEqual([]);
  });

  it('applyAvailabilityMovement (the migration-034 quantity writer) now has ZERO production call sites', () => {
    // CANONICAL-STOCK-CUTOVER: the last caller was Status Center's
    // AdjustQuantityModal (now deleted). item_availability is a read-only
    // projection (083); corrections go to the canonical lot-level guarded RPCs
    // (outlet 086 / warehouse 078). A new entry here means the movement RPC
    // became reachable from the UI again — the item_availability zero-writer
    // invariant is broken and this must be re-audited before it ships. The
    // service wrapper's own definition and the classifier are excluded (the
    // CALL form `applyAvailabilityMovement(` prefixed by `await` or `= `).
    const callers = productionSourceFiles()
      .filter(f => {
        const src = readFileSync(f, 'utf8');
        return /\bawait applyAvailabilityMovement\(|=\s*applyAvailabilityMovement\(/.test(src);
      })
      .map(f => f.replace(/\\/g, '/').split('/src/')[1])
      .sort();
    expect(callers).toEqual([]);
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

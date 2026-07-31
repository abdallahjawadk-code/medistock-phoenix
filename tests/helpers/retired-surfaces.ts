/**
 * E6 — shared guards for RETIRED surfaces.
 *
 * Several phases used to pin "this phase did not touch EditorScreen.tsx" by
 * reading the file and asserting on its contents. Once the file is deleted that
 * read throws, and the tempting fix — deleting the assertion — would silently
 * remove the protection at the exact moment it starts mattering.
 *
 * So each of those isolation assertions becomes an ABSENCE assertion instead:
 * the retired surface must stay gone, must stay unimported, and must not come
 * back through a route, a lazy import or a bundle chunk. That is a strictly
 * stronger guarantee than "the file still exists and does not contain X".
 *
 * Reachability of the surviving legacy writer is tracked separately in
 * src/features/inventory/__tests__/legacy-availability-writer-audit.test.ts.
 */
import { expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const REPO_ROOT = join(__dirname, '..', '..');
export const SRC_ROOT = join(REPO_ROOT, 'src');

/**
 * Retired availability surfaces, by repo-relative path.
 *
 * `importMarker` is what an import specifier would look like — matched instead
 * of the bare component name because `StatusEditorScreen` is a DIFFERENT, live
 * screen whose name contains `EditorScreen`.
 */
export const RETIRED_SURFACES = [
  {
    name: 'EditorScreen',
    path: 'src/features/editor/EditorScreen.tsx',
    importMarker: 'features/editor/EditorScreen',
    renderMarker: '<EditorScreen',
    replacedBy: 'InventoryCenterScreen (screen 3)',
  },
  {
    // CANONICAL-STOCK-CUTOVER: the last item_availability quantity writer
    // (Status Center → applyAvailabilityMovement, migration 034). Corrections
    // now require explicit canonical lot selection through the guarded
    // migration-086 path, so this manual aggregate writer is deleted.
    name: 'AdjustQuantityModal',
    path: 'src/features/status/AdjustQuantityModal.tsx',
    importMarker: 'features/status/AdjustQuantityModal',
    renderMarker: '<AdjustQuantityModal',
    replacedBy: 'AvailabilityStockCorrectionModal → OutletStockCorrectionModal (086)',
  },
] as const;

/** Every production entry point that could reach a screen. */
export const NAVIGATION_ENTRY_POINTS = [
  'src/app/AuthenticatedApp.tsx',
  'src/app/App.tsx',
  'src/shared/ui/PhoenixSidebar.tsx',
  'src/shared/ui/PhoenixMobileDrawer.tsx',
  'src/shared/ui/PhoenixMobileBottomNav.tsx',
  'src/shared/ui/CommandPalette.tsx',
];

export function readRepoFile(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

/** Every .ts/.tsx under src/, excluding test files. */
export function productionSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        walk(p);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(p);
      }
    }
  };
  walk(SRC_ROOT);
  return out;
}

/**
 * The full absence contract for one retired surface: the file is gone, no
 * production module imports or renders it, and no navigation entry point
 * reaches it.
 */
export function expectRetiredSurfaceAbsent(name: string): void {
  const surface = RETIRED_SURFACES.find(s => s.name === name);
  if (!surface) throw new Error(`unknown retired surface: ${name}`);

  expect(
    existsSync(join(REPO_ROOT, surface.path)),
    `${surface.path} was retired and must stay deleted (replaced by ${surface.replacedBy})`,
  ).toBe(false);

  for (const file of productionSourceFiles()) {
    const text = readFileSync(file, 'utf8');
    expect(text, `${file} must not import the retired ${surface.name}`)
      .not.toContain(surface.importMarker);
    expect(text, `${file} must not render the retired ${surface.name}`)
      .not.toContain(surface.renderMarker);
  }

  for (const entry of NAVIGATION_ENTRY_POINTS) {
    const text = readRepoFile(entry);
    expect(text, `${entry} must not reach the retired ${surface.name}`)
      .not.toContain(surface.importMarker);
  }
}

/** Screen 3 must keep routing to the replacement, never back to the editor. */
export function expectScreenThreeIsInventoryCenter(): void {
  const app = readRepoFile('src/app/AuthenticatedApp.tsx');
  expect(app).toMatch(/case 3:\s*return <InventoryCenterScreen[\s\S]*?initialSuggestionDocument=/);
  expect(app).not.toContain('features/editor/EditorScreen');
}

/**
 * The retired manual quick-add availability writer must stay gone from
 * InstitutionScreen, together with any control that could re-summon it.
 */
export function expectQuickAvailFormAbsent(): void {
  const screen = readRepoFile('src/features/institutions/InstitutionScreen.tsx');
  // Matched as CODE, not as the bare word: comments explaining why the form was
  // retired are worth keeping, and must not trip the guard that enforces it.
  expect(screen, 'the retired QuickAvailForm component must stay deleted')
    .not.toContain('function QuickAvailForm');
  expect(screen, 'the retired QuickAvailForm must stay unrendered')
    .not.toContain('<QuickAvailForm');
  expect(screen, 'the retired manual availability writer must stay uncalled here')
    .not.toContain('await upsertAvailability(');
  expect(screen, "the retired form's add-item label must stay gone")
    .not.toContain("t('avail_add', lang)");

  // PortAvailabilitySection must keep NO local add-form state. The surviving
  // `setShowAdd(true)` belongs to the create-distribution-point form higher up
  // the file, which is a live workflow — so this asserts the availability
  // section itself, not the whole file.
  const sectionStart = screen.indexOf('function PortAvailabilitySection');
  expect(sectionStart, 'PortAvailabilitySection should still exist').toBeGreaterThan(-1);
  const section = screen.slice(sectionStart);
  expect(section, 'the availability section must own no add-form toggle')
    .not.toContain('setShowAdd');
}

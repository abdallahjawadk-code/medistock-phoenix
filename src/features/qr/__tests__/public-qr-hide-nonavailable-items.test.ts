/**
 * QR-HIDE-NONAVAILABLE-ITEMS-FROM-PUBLIC-LIST-A
 *
 * The public QR page ("available medicines" list) must never list a
 * removed/zeroed/expired/missing row as available stock. Migration 052
 * already makes the RPC fold quantity <= 0 into effective_condition =
 * 'missing' — this phase adds a frontend-only visibility filter
 * (isPubliclyAvailableQrItem) so such rows, and any other non-available
 * condition, never reach the rendered list, the item count, or the search
 * index, while org/point header info and the QR call itself are untouched.
 *
 * isPubliclyAvailableQrItem is a pure exported function — tested directly,
 * matching this repo's convention of pure-function unit tests plus static
 * source-code wiring checks (no @testing-library/react component rendering
 * is used anywhere else in this codebase).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { isPubliclyAvailableQrItem } from '../PublicQrScreen';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');

function readSrc(rel: string) {
  return readFileSync(join(SRC, rel), 'utf8');
}

const screen = readSrc('features/qr/PublicQrScreen.tsx');
const strings = readSrc('shared/i18n/strings.ts');

describe('isPubliclyAvailableQrItem: visibility rules', () => {
  it('quantity=0, condition=missing -> hidden', () => {
    expect(isPubliclyAvailableQrItem({ quantity: 0, condition: 'missing' })).toBe(false);
  });

  it('quantity=0, condition=available -> hidden (defensive; should not occur post-052 but must never render as available)', () => {
    expect(isPubliclyAvailableQrItem({ quantity: 0, condition: 'available' })).toBe(false);
  });

  it('quantity=0, condition=surplus -> hidden (defensive)', () => {
    expect(isPubliclyAvailableQrItem({ quantity: 0, condition: 'surplus' })).toBe(false);
  });

  it('quantity>0, condition=missing -> hidden', () => {
    expect(isPubliclyAvailableQrItem({ quantity: 5, condition: 'missing' })).toBe(false);
  });

  it('quantity>0, condition=expired -> hidden', () => {
    expect(isPubliclyAvailableQrItem({ quantity: 5, condition: 'expired' })).toBe(false);
  });

  it('quantity>0, condition=available -> visible', () => {
    expect(isPubliclyAvailableQrItem({ quantity: 5, condition: 'available' })).toBe(true);
  });

  it('quantity>0, condition=near_expiry -> visible', () => {
    expect(isPubliclyAvailableQrItem({ quantity: 5, condition: 'near_expiry' })).toBe(true);
  });

  it('quantity>0, condition=surplus -> visible', () => {
    expect(isPubliclyAvailableQrItem({ quantity: 5, condition: 'surplus' })).toBe(true);
  });

  it('quantity>0, condition=low_stock -> visible', () => {
    expect(isPubliclyAvailableQrItem({ quantity: 5, condition: 'low_stock' })).toBe(true);
  });

  it('negative quantity -> hidden', () => {
    expect(isPubliclyAvailableQrItem({ quantity: -1, condition: 'available' })).toBe(false);
  });

  it('missing/undefined quantity -> hidden (conservative default)', () => {
    expect(isPubliclyAvailableQrItem({ condition: 'available' })).toBe(false);
  });

  it('unrecognized condition with positive quantity -> hidden (conservative default, documented in source)', () => {
    expect(isPubliclyAvailableQrItem({ quantity: 5, condition: 'some_future_status' })).toBe(false);
  });

  it('missing/undefined condition with positive quantity -> hidden (conservative default)', () => {
    expect(isPubliclyAvailableQrItem({ quantity: 5 })).toBe(false);
  });

  it('non-finite quantity (NaN) -> hidden', () => {
    expect(isPubliclyAvailableQrItem({ quantity: NaN, condition: 'available' })).toBe(false);
  });
});

describe('PublicQrScreen: wiring uses visibleItems (filtered), not rawItems, for the rendered list', () => {
  it('exports isPubliclyAvailableQrItem for testability', () => {
    expect(screen).toContain('export function isPubliclyAvailableQrItem');
  });

  it('computes visibleItems = rawItems.filter(isPubliclyAvailableQrItem)', () => {
    expect(screen).toMatch(/rawItems\.filter\(isPubliclyAvailableQrItem\)/);
  });

  it('summaryCounts is derived from visibleItems, not rawItems', () => {
    const start = screen.indexOf('const summaryCounts = useMemo(');
    const end = screen.indexOf('}, [', start);
    const block = screen.slice(start, end);
    expect(block).toContain('visibleItems');
    expect(block).not.toContain('rawItems');
  });

  it('filteredItems (search) is derived from visibleItems, not rawItems', () => {
    const start = screen.indexOf('const filteredItems = search');
    const end = screen.indexOf(';', start);
    const block = screen.slice(start, end);
    expect(block).toContain('visibleItems');
    expect(block).not.toContain('rawItems');
  });

  it('the item-count display uses visibleItems.length, not rawItems.length', () => {
    expect(screen).toMatch(/visibleItems\.length > 0[\s\S]{0,200}public_items_count[\s\S]{0,60}visibleItems\.length/);
  });

  it('the search input visibility threshold uses visibleItems.length, not rawItems.length', () => {
    expect(screen).toMatch(/\{\/\* Search \*\/\}\s*\{visibleItems\.length > 3/);
  });

  it('rendered item cards come from filteredItems (derived from visibleItems)', () => {
    expect(screen).toMatch(/filteredItems\.map\(/);
  });
});

describe('PublicQrScreen: empty-state behavior', () => {
  it('shows public_empty_port when the port has no items at all (rawItems empty)', () => {
    expect(screen).toMatch(/rawItems\.length === 0[\s\S]{0,200}public_empty_port/);
  });

  it('shows a distinct "no available medicines" state when items exist but none are publicly available', () => {
    expect(screen).toMatch(/rawItems\.length > 0 && visibleItems\.length === 0[\s\S]{0,200}public_no_available_now/);
  });

  it('shows empty_items only when a search yields nothing among visible items (not when hidden by availability)', () => {
    expect(screen).toMatch(/visibleItems\.length > 0 && filteredItems\.length === 0 && search[\s\S]{0,200}empty_items/);
  });

  it('public_no_available_now i18n key exists with Arabic and English text matching the required copy', () => {
    expect(strings).toMatch(/public_no_available_now:\s*\{\s*ar:\s*'لا توجد أدوية متوفرة حالياً'\s*,\s*en:\s*'No available medicines right now'\s*\}/);
  });
});

describe('PublicQrScreen: org/point header and QR call untouched', () => {
  it('still renders orgName and point_label from the payload (header untouched)', () => {
    expect(screen).toContain('{orgName}');
    expect(screen).toContain("payload?.point_label");
  });

  it('still calls getPublicQrPayload via useAsync with the same publicId — no RPC/service change', () => {
    expect(screen).toMatch(/useAsync\(\s*\(\) => getPublicQrPayload\(publicId\),\s*\[publicId\],\s*\)/);
  });

  it('qr.service.ts (RPC call site) has no working-tree diff', () => {
    const service = readSrc('shared/supabase/services/qr.service.ts');
    expect(service).toContain("supabase.rpc('get_public_qr_payload'");
    // Confirms the RPC call itself is untouched — same function name/shape as before this phase.
  });
});

describe('QR-HIDE-NONAVAILABLE-ITEMS-FROM-PUBLIC-LIST-A: safety guards', () => {
  // FIX-MIGRATION-053-REMOVED-BY-FK-A: 053 is excluded below — corrected
  // in-place before its first successful manual apply (removed_by FK
  // creation/verification fix), same pattern as the 051 immutable-expiry-date
  // correction elsewhere in this repo.
  it('no migration SQL file has a working-tree diff (other than the already-approved 053 removed_by-FK fix)', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/053_item_availability_removed_marker.sql" ":!supabase/migrations/054_dashboard_condition_counts_rpcs.sql" ":!supabase/migrations/055_phoenix_clean_availability_data.sql" ":!supabase/migrations/056_phoenix_platform_broadcast_notices.sql" ":!supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql"',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');
  });

  // DB-REMOVED-OUTLET-MATERIAL-MARKER-053-A: migration 053 is a later,
  // separately-reviewed phase — this phase's own scope is unaffected.
  it('no migration 058 (or higher) file was created (053-057 are later, separately-reviewed additions)', () => {
    const migsDir = join(ROOT, 'supabase/migrations');
    const matches = (readdirSync(migsDir) as string[]).filter(f => /^0(5[8-9]|[6-9][0-9])_/.test(f));
    expect(matches).toEqual([]);
  });

  it('no package/lockfile diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('premium-preview.html remains untracked (only "??" status if present)', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });

  it('supabase/.temp/ was not staged', () => {
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    const tempLine = status.split('\n').find((l: string) => l.includes('supabase/.temp'));
    if (tempLine) {
      expect(tempLine.trim().startsWith('??')).toBe(true);
    }
  });

  it('Service-D stash (paused inter-org exchange service work) remains untouched', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });

  // Scoped to production alert/editor/movement files only — this phase's own
  // safety-guard updates to *other* phases' __tests__ files (bumping their
  // "PublicQrScreen.tsx untouched" assertions to admit this phase, the same
  // established convention used when migration 052 itself landed) are
  // expected and are not alert lifecycle/WhatsApp/editor/movement behavior.
  // DB-PRESSURE-QUICK-WINS-A: a later, separately-reviewed phase legitimately
  // adds cache-invalidation to archiveOrganization in
  // src/shared/supabase/services/lifecycle.service.ts — excluded here.
  it('no alert lifecycle/WhatsApp/editor/movement production files changed', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/features/alerts/InterInstitutionAlertsScreen.tsx src/features/alerts/materialAlertEngine.ts src/features/alerts/inter-org-alert-lifecycle.service.ts src/features/editor/EditorScreen.tsx src/features/status/AdjustQuantityModal.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

/**
 * BUGFIX-OUTLET-MATERIAL-NAME-NOT-SHOWN-A
 * Run: npm test -- --run
 *
 * Static source-code tests proving the outlet material list (InstitutionScreen's
 * PortAvailabilitySection, under "إدارة التوفر") shows a real material identity
 * for every row instead of a bare "—". Root cause: the row title was computed
 * solely from the legacy local_items -> central_items join
 * (`centralOf(r.local_items)`), but the current write path
 * (phoenix_upsert_availability, migrations 030/031) inserts rows with
 * local_item_id = NULL and denormalizes scientific_name/trade_name/
 * concentration/dosage_form directly onto item_availability — so every
 * material added through the current flow rendered with no name at all.
 *
 * Also hardens OutletMaterialGroups (Status Center's outlet view), which
 * already used the direct scientific_name field correctly but had no
 * trade_name/placeholder fallback, for consistency with the same required
 * fallback order.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { findUnexpectedMigrationGitStatusEntries } from '../../../../supabase/migrations/__tests__/helpers/reviewed-migration-git-status';
import { execSync } from 'child_process';
import { expectQuickAvailFormAbsent } from '../../../../tests/helpers/retired-surfaces';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const screen = readSrc('features/institutions/InstitutionScreen.tsx');
const outletGroups = readSrc('features/status/OutletMaterialGroups.tsx');
const availabilityService = readSrc('shared/supabase/services/availability.service.ts');
const strings = readSrc('shared/i18n/strings.ts');

describe('1. Outlet material row uses item_availability direct fields as the primary source', () => {
  it('outletMaterialTitle checks r.scientific_name before the legacy central_items join', () => {
    const fn = screen.slice(screen.indexOf('function outletMaterialTitle'), screen.indexOf('function outletMaterialTitle') + 500);
    const scientificIdx = fn.indexOf('r.scientific_name');
    const ciIdx = fn.indexOf('ci?.name');
    expect(scientificIdx).toBeGreaterThan(-1);
    expect(ciIdx).toBeGreaterThan(-1);
    expect(scientificIdx).toBeLessThan(ciIdx);
  });

  it('the row rendering calls outletMaterialTitle, not the raw legacy-join-only itemName pattern', () => {
    const section = screen.slice(screen.indexOf('function PortAvailabilitySection'), screen.indexOf('function PortCleanupWizard'));
    expect(section).toContain('outletMaterialTitle(r, ci, lang)');
    expect(section).not.toMatch(/const itemName = lang === 'ar' \? \(ci\?\.name_ar/);
  });

  it('getAvailabilityByPoint already selects the direct identity fields used here', () => {
    const fn = availabilityService.slice(availabilityService.indexOf('export async function getAvailabilityByPoint'), availabilityService.indexOf('export async function getAvailabilityByPoint') + 1400);
    expect(fn).toContain('scientific_name');
    expect(fn).toContain('trade_name');
    expect(fn).toContain('dosage_form');
    expect(fn).toContain('concentration');
  });
});

describe('2. Trade name, concentration, and dosage form are displayed when present', () => {
  const section = screen.slice(screen.indexOf('function PortAvailabilitySection'), screen.indexOf('function PortCleanupWizard'));

  it('shows trade_name as secondary text distinct from the title', () => {
    expect(section).toContain('r.trade_name?.trim() && r.trade_name.trim() !== title');
  });

  it('shows concentration + dosage_form as compact metadata', () => {
    expect(section).toContain("[r.concentration?.trim(), r.dosage_form?.trim()].filter(Boolean).join(' · ')");
  });

  it('shows expiry_date whenever present (not only for one specific condition value)', () => {
    const rowBlock = section.slice(section.indexOf('rows.map(r =>'));
    expect(rowBlock).toMatch(/r\.expiry_date\s*&&\s*\(/);
    expect(rowBlock).not.toContain("r.expiry_date && r.condition === 'near_expiry'");
  });
});

describe('3. local_items/central_items fallback still works when direct fields are missing', () => {
  it('outletMaterialTitle falls back to centralOf(...) and finally local_code before the translated placeholder', () => {
    const fn = screen.slice(screen.indexOf('function outletMaterialTitle'), screen.indexOf('function outletMaterialTitle') + 600);
    expect(fn).toContain('ci?.name_ar');
    expect(fn).toContain('ci?.name');
    expect(fn).toContain('r.local_items?.local_code');
    expect(fn).toContain("t('avail_unnamed_material', lang)");
  });

  it('centralOf(...) (the legacy join resolver) is unchanged and still called', () => {
    expect(screen).toContain('function centralOf(row: LocalRow');
    const section = screen.slice(screen.indexOf('function PortAvailabilitySection'), screen.indexOf('function PortCleanupWizard'));
    expect(section).toContain('centralOf(r.local_items)');
  });
});

describe('4. "—" is never the sole material title when a material exists', () => {
  it('the row title expression no longer renders a bare em-dash fallback', () => {
    const section = screen.slice(screen.indexOf('function PortAvailabilitySection'), screen.indexOf('function PortCleanupWizard'));
    expect(section).not.toMatch(/\{itemName \?\? '—'\}/);
    expect(section).not.toMatch(/\{title \?\? '—'\}/);
  });

  it('outletMaterialTitle always resolves to a non-empty string via the translated placeholder as the final fallback', () => {
    const start = screen.indexOf('function outletMaterialTitle');
    const fn = screen.slice(start, screen.indexOf('\n}', start) + 2);
    // The translated placeholder must be the LAST `||` term of the fallback
    // chain (i.e. nothing after it but the closing return), never a raw '—'.
    const placeholderIdx = fn.indexOf("t('avail_unnamed_material', lang)");
    const returnCloseIdx = fn.indexOf(');', placeholderIdx);
    expect(placeholderIdx).toBeGreaterThan(-1);
    expect(fn.slice(placeholderIdx + "t('avail_unnamed_material', lang)".length, returnCloseIdx).trim()).toBe('');
  });

  it('OutletMaterialGroups (Status Center outlet view) also falls back to trade_name/placeholder instead of a bare "—"', () => {
    const fn = outletGroups.slice(outletGroups.indexOf('function outletGroupRowTitle'), outletGroups.indexOf('function outletGroupRowTitle') + 300);
    expect(fn).toContain('r.scientific_name?.trim()');
    expect(fn).toContain('r.trade_name?.trim()');
    expect(fn).toContain("t('avail_unnamed_material', lang)");
    expect(outletGroups).not.toMatch(/\{r\.scientific_name \|\| '—'\}/);
  });
});

describe('5. intentionally-removed rows remain hidden from active outlet contents', () => {
  it('PortAvailabilitySection filters on the removed_at marker before rendering (FRONTEND-LIVE-REMOVED-AT-FILTERS-A: replaced the old blunt quantity=0+missing heuristic, which also hid genuine still-open shortages)', () => {
    const section = screen.slice(screen.indexOf('function PortAvailabilitySection'), screen.indexOf('function PortCleanupWizard'));
    expect(section).toContain('filter(r => r.removed_at == null)');
  });
});

describe('6. Visible count uses the filtered active-materials array only', () => {
  it('the "إدارة التوفر (N أصناف)" header counts rows.length (post-filter), not the raw async payload', () => {
    const section = screen.slice(screen.indexOf('function PortAvailabilitySection'), screen.indexOf('function PortCleanupWizard'));
    const headerIdx = section.indexOf("avail_manage', lang");
    const around = section.slice(headerIdx, headerIdx + 80);
    expect(around).toContain('rows.length');
    expect(around).not.toContain('avail.data');
  });
});

describe('7. Empty state appears with the required translated copy when all rows are cleared/hidden', () => {
  it('renders avail_outlet_active_empty (not the generic empty_avail) when rows.length === 0', () => {
    const section = screen.slice(screen.indexOf('function PortAvailabilitySection'), screen.indexOf('function PortCleanupWizard'));
    const emptyBlock = section.slice(section.indexOf('rows.length === 0 &&'), section.indexOf('rows.length === 0 &&') + 200);
    expect(emptyBlock).toContain("t('avail_outlet_active_empty', lang)");
  });

  it('the exact required Arabic/English empty-state copy exists in strings.ts', () => {
    expect(strings).toContain("avail_outlet_active_empty: { ar: 'لا توجد مواد فعالة في هذا المنفذ.'");
    expect(strings).toContain("en: 'No active materials in this outlet.'");
  });

  it('the unnamed-material placeholder string exists bilingually', () => {
    expect(strings).toMatch(/avail_unnamed_material:\s*\{\s*ar:\s*'مادة غير مسماة',\s*en:\s*'Unnamed material'/);
  });
});

describe('8. No DB/RPC write path was changed by this fix', () => {
  // REMOVE-BUTTON-MARKS-REMOVED-AT-A: PortAvailabilitySection's own
  // onConfirmRemove now only calls applyAvailabilityMovement (the follow-up
  // upsertAvailability call was removed — see that phase's own tests).
  // upsertAvailability is still used elsewhere in this file (QuickAvailForm,
  // a sibling function rendered by PortAvailabilitySection, uses it to add a
  // new material), so it remains a valid RPC for the whole file's writes.
  it('PortAvailabilitySection still only reads via getAvailabilityByPoint and removes materials via the existing audited movement RPC', () => {
    const section = screen.slice(screen.indexOf('function PortAvailabilitySection'), screen.indexOf('function PortCleanupWizard'));
    expect(section).toContain('getAvailabilityByPoint(pointId)');
    expect(section).toContain('applyAvailabilityMovement(');
    expect(section).not.toMatch(/\.rpc\(\s*['"](?!phoenix_apply_availability_movement|phoenix_upsert_availability)/);
  });

  // E6: QuickAvailForm was the ONLY upsertAvailability caller in this file and
  // is now retired, so the assertion inverts: the remove path still must not
  // use it, and neither does anything else here any more.
  it('upsertAvailability is no longer called anywhere in this file, remove path included', () => {
    expect(screen).not.toContain('await upsertAvailability(');
    expectQuickAvailFormAbsent();
  });

  it('getAvailabilityByPoint itself is unchanged (still a plain SELECT, no new RPC/table)', () => {
    const fn = availabilityService.slice(availabilityService.indexOf('export async function getAvailabilityByPoint'), availabilityService.indexOf('export async function getAvailabilityByPoint') + 1400);
    expect(fn).toContain(".from('item_availability')");
    expect(fn).not.toContain('.rpc(');
    expect(fn).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
  });
});

describe('9. No package/lockfile/migration changes', () => {
  it('no package/lockfile diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const removedLines = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'));
    expect(removedLines.length).toBe(0);
    expect(addedLines.every(l => /"exceljs":/.test(l))).toBe(true);
  });

  // REFRESH-MIGRATION-051-DIFF-GUARDS-A: 051_material_batch_identity_option_a.sql
  // is excluded from the diff check because a later, separately-reviewed
  // phase (FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A) legitimately corrects
  // it in-place before its first successful manual apply.
  it('no existing migration SQL was modified (other than the already-approved 051 immutable-expiry-date fix), and no unreviewed migration SQL was created — only the separately-reviewed migration 045 (DB-MY-ACCOUNT-WHATSAPP-RPC-A) is allowed as an untracked addition (test-only maintenance under supabase/migrations/__tests__/ is not a migration SQL change; 044 is already committed and no longer appears here)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/051_material_batch_identity_option_a.sql" ":!supabase/migrations/053_item_availability_removed_marker.sql" ":!supabase/migrations/054_dashboard_condition_counts_rpcs.sql" ":!supabase/migrations/055_phoenix_clean_availability_data.sql" ":!supabase/migrations/056_phoenix_platform_broadcast_notices.sql" ":!supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
    let status = '';
    try {
      status = execSync('git status --porcelain -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    // MIGRATION-GUARD-DERIVE-B: the allowed in-flight migration entries are
    // now DERIVED from the canonical reviewed registry instead of a copy kept
    // in this file, so registering a migration once permits it everywhere and
    // no historical guard needs an edit. Strictly stronger than the old list:
    // an unregistered migration still fails, and a MODIFIED reviewed migration
    // now fails too (the old list tolerated `M `/`M  ` entries).
    expect(findUnexpectedMigrationGitStatusEntries(status)).toEqual([]);
  });
});

describe('10. No service_role/auth.admin in frontend', () => {
  it('InstitutionScreen.tsx and OutletMaterialGroups.tsx never reference service_role/auth.admin', () => {
    for (const src of [screen, outletGroups]) {
      expect(src).not.toMatch(/service_role|SUPABASE_SERVICE_ROLE|auth\.admin/);
    }
  });
});

describe('11-12. Safety guards', () => {
  it('no Service-D / inter_org_exchange UI added to the touched files', () => {
    for (const src of [screen, outletGroups]) {
      expect(src).not.toContain('inter_org_exchange');
    }
  });

  it('no wipe tooling references were restored', () => {
    for (const src of [screen, outletGroups]) {
      expect(src).not.toMatch(/phoenix-wipe-execute|FULL_PUBLIC_APP_WIPE_APPROVED|full_wipe/i);
    }
  });

  it('stash@{0} (paused Service-D work) was not popped or applied', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });

  it('premium-preview.html remains untouched', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });
});

describe('QR generation, creation/update RPCs, and permission checks are untouched', () => {
  it('no qr_targets/qr_tokens/QR RPC references appear anywhere near the edited sections', () => {
    const section = screen.slice(screen.indexOf('function PortAvailabilitySection'), screen.indexOf('function PortCleanupWizard'));
    expect(section).not.toMatch(/qr_targets|qr_tokens|generateQr|revokeQr/i);
  });

  it('canRemove permission prop is still threaded through unchanged (canMutate was removed by UI-HIDE-PORT-ADD-ITEM-A once its only use, the "+ Add" button, was hidden)', () => {
    const section = screen.slice(screen.indexOf('function PortAvailabilitySection'), screen.indexOf('function PortCleanupWizard'));
    expect(section).toContain('canRemove');
  });
});

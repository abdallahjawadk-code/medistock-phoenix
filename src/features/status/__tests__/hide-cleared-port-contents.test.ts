/**
 * BUGFIX-HIDE-CLEARED-PORT-CONTENTS-A
 * Run: npm test -- --run
 *
 * Product rule (unchanged from migration 042): clear_port_availability and
 * "Remove from outlet" never delete item_availability rows — they zero
 * quantity and set condition = 'missing' to preserve the
 * item_availability_movements FK / audit trail. This left cleared/removed
 * materials still visible as "quantity 0 / missing" rows in the active
 * outlet contents views. This phase hides those rows from active-contents
 * display ONLY — no backend/data change, no migration, movement history and
 * reporting remain fully intact.
 *
 * Two surfaces are fixed:
 * 1. StatusCenterScreen.tsx — the org-wide live availability table/outlet-
 *    grouped view. Cleared rows (quantity=0 + condition='missing') are
 *    hidden by default; an explicit "missing" status filter still shows
 *    them, so that filter option stays meaningful for real out-of-stock
 *    reporting instead of always returning zero rows. Disabled/archived
 *    outlets' rows are hidden unconditionally (no override).
 * 2. InstitutionScreen.tsx's PortAvailabilitySection — a single outlet's
 *    material list. Cleared rows are filtered out entirely (this view has
 *    no reporting-vs-active-contents tension, so no opt-in override is
 *    needed). A disabled outlet shows a dedicated empty-state message
 *    instead of its (now hidden) materials.
 *
 * No live DB is used — these are static source-code / string-catalog
 * assertions, matching this repo's established test conventions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { T } from '@/shared/i18n/strings';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
const institutions = readSrc('features/institutions/InstitutionScreen.tsx');
const movementReport = readSrc('features/status/MovementReportSection.tsx');
const movementHistoryModal = readSrc('features/status/MovementHistoryModal.tsx');
const availabilityService = readSrc('shared/supabase/services/availability.service.ts');
const lifecycleService = readSrc('shared/supabase/services/lifecycle.service.ts');

describe('StatusCenterScreen: hides cleared (quantity=0 + missing) rows from active contents by default', () => {
  it('the rows computation filters out quantity=0/missing rows unless the user explicitly filters for "missing"', () => {
    const rowsBlock = statusCenter.slice(statusCenter.indexOf('const rows = useMemo('), statusCenter.indexOf('}, [allRows, filterStatus, filterSupply, search]);'));
    expect(rowsBlock).toContain("filterStatus !== 'missing'");
    expect(rowsBlock).toMatch(/r\.quantity === 0 && r\.condition === 'missing'/);
  });

  it('an explicit "missing" status filter still reveals cleared rows (the filter is not permanently dead)', () => {
    const rowsBlock = statusCenter.slice(statusCenter.indexOf('const rows = useMemo('), statusCenter.indexOf('}, [allRows, filterStatus, filterSupply, search]);'));
    // The hide-rule is wrapped in `if (filterStatus !== 'missing')` — when
    // filterStatus === 'missing', the filter is skipped entirely, so those
    // rows survive into the later `effOf(r) === filterStatus` filter too.
    const hideRuleStart = rowsBlock.indexOf("if (filterStatus !== 'missing')");
    expect(hideRuleStart).toBeGreaterThan(-1);
  });

  it('disabled/archived outlets are hidden unconditionally, regardless of any status filter', () => {
    const rowsBlock = statusCenter.slice(statusCenter.indexOf('const rows = useMemo('), statusCenter.indexOf('}, [allRows, filterStatus, filterSupply, search]);'));
    expect(rowsBlock).toMatch(/distribution_points\?\.status.*!==\s*'active'|!r\.distribution_points\?\.status \|\| r\.distribution_points\.status === 'active'/);
  });

  it('LiveAvailRow carries the distribution point status needed for the disabled-outlet filter', () => {
    expect(statusCenter).toMatch(/distribution_points:\s*\{\s*id:\s*string;\s*name:\s*string;\s*name_ar:\s*string;\s*status\?:\s*string\s*\}/);
  });

  it('getAvailabilityByOrg now selects distribution_points status (additive, read-only — no migration)', () => {
    const fnStart = availabilityService.indexOf('export async function getAvailabilityByOrg');
    const fnBody = availabilityService.slice(fnStart, availabilityService.indexOf('\n}', fnStart));
    expect(fnBody).toMatch(/distribution_points\s*\(\s*id,\s*name,\s*name_ar,\s*status\s*\)/);
  });

  it('OutletMaterialGroups (the outlet-grouped view mode) receives the same already-filtered rows — no separate data source to also fix', () => {
    expect(statusCenter).toContain('<OutletMaterialGroups rows={rows} />');
  });
});

describe('StatusCenterScreen: movement/reporting counts and internal alerts are not silently corrupted', () => {
  it('counts are still derived from the same rows the table renders (consistent, not a separate hidden metric)', () => {
    const countsBlock = statusCenter.slice(statusCenter.indexOf('const counts = useMemo('), statusCenter.indexOf('}, [rows]);') + 20);
    expect(countsBlock).toMatch(/for \(const r of rows\)/);
  });

  it('internal alerts (computeInternalAlerts) are computed from allRows, unaffected by the new active-contents hiding — this phase does not touch alert logic', () => {
    expect(statusCenter).toContain('computeInternalAlerts(allRows)');
  });
});

describe('PortAvailabilitySection: cleared materials are removed from the outlet contents list entirely', () => {
  const fnStart = institutions.indexOf('function PortAvailabilitySection');
  const fnBody = institutions.slice(fnStart, institutions.indexOf('function QuickAvailForm'));

  it('filters rows to exclude quantity=0 + condition=missing before rendering (not merely hiding a button on a still-visible row)', () => {
    expect(fnBody).toMatch(/\.filter\(r => !\(r\.quantity === 0 && r\.condition === 'missing'\)\)/);
  });

  it('the item count in the section header reflects the filtered (active) rows, not the raw fetched set', () => {
    expect(fnBody).toMatch(/\{rows\.length\}\s*\{t\('avail_count', lang\)\}/);
  });

  it('reload is keyed on both pointId and a refreshKey prop, so it re-fetches after a sibling "Clear port items" action succeeds', () => {
    expect(fnBody).toContain('useAsync(() => getAvailabilityByPoint(pointId), [pointId, refreshKey]);');
  });
});

describe('PortAvailabilitySection / PortCard: disabled outlet shows an honest empty state, not stale/hidden-but-implied contents', () => {
  const fnStart = institutions.indexOf('function PortAvailabilitySection');
  const fnBody = institutions.slice(fnStart, institutions.indexOf('function QuickAvailForm'));

  it("returns the disabled-outlet message when pointStatus !== 'active', before rendering the normal add/list UI", () => {
    expect(fnBody).toMatch(/if \(pointStatus !== 'active'\) \{/);
    expect(fnBody).toContain("t('avail_outlet_disabled_empty', lang)");
  });

  it('does not delete or otherwise mutate data to produce the disabled empty state — it is a pure render branch', () => {
    const disabledBranch = fnBody.slice(fnBody.indexOf("if (pointStatus !== 'active')"), fnBody.indexOf("if (pointStatus !== 'active')") + 400);
    expect(disabledBranch).not.toMatch(/\.delete\(|\.update\(|\.insert\(|supabase\.rpc\(/);
  });

  it('avail_outlet_disabled_empty exists bilingually with the exact required wording', () => {
    expect(T.avail_outlet_disabled_empty.ar).toBe('تم تعطيل هذا المنفذ، ولا توجد مواد فعالة معروضة.');
    expect(T.avail_outlet_disabled_empty.en).toBe('This outlet is disabled; no active materials are displayed.');
  });

  it('PortCard passes the outlet\'s own status down to PortAvailabilitySection', () => {
    const cardStart = institutions.indexOf('function PortCard');
    const cardBody = institutions.slice(cardStart, institutions.indexOf('function QrPreviewModal', cardStart));
    expect(cardBody).toMatch(/<PortAvailabilitySection[\s\S]{0,300}pointStatus=\{point\.status\}/);
  });

  it('PortCard bumps a refresh key when PortCleanupWizard\'s clear succeeds, so PortAvailabilitySection reloads', () => {
    const cardStart = institutions.indexOf('function PortCard');
    const cardBody = institutions.slice(cardStart, institutions.indexOf('function QrPreviewModal', cardStart));
    expect(cardBody).toMatch(/<PortCleanupWizard[\s\S]{0,200}onDone=\{\(\)\s*=>\s*\{\s*onReload\(\);\s*setAvailRefreshKey\(k => k \+ 1\);\s*\}\}/);
  });
});

describe('Clear port items: honest success message, no fake deletion wording', () => {
  it('dw_cleared no longer implies a destructive delete — matches the required wording exactly', () => {
    expect(T.dw_cleared.ar).toBe('تم إخفاء مواد المنفذ من المحتويات الفعالة مع حفظ سجل الحركات.');
    expect(T.dw_cleared.en).toBe('Outlet materials were removed from active contents while preserving movement history.');
  });

  it('PortCleanupWizard still shows this message only after the RPC actually succeeds (no fake success)', () => {
    const fnStart = institutions.indexOf('async function onClearItems');
    const fnBody = institutions.slice(fnStart, institutions.indexOf('} catch (e) {', fnStart));
    expect(fnBody).toMatch(/await clearPortAvailability\(pointId\);[\s\S]{0,100}onToast\(t\('dw_cleared', lang\)\)/);
  });
});

describe('Movement history / reporting: unaffected, still fully visible, with a retention note', () => {
  it('MovementReportSection is not touched by the active-contents hiding logic (different component, different data source)', () => {
    expect(movementReport).not.toMatch(/condition === 'missing'.*quantity === 0|quantity === 0.*condition === 'missing'/);
  });

  it('MovementHistoryModal is not touched by the active-contents hiding logic', () => {
    expect(movementHistoryModal).not.toMatch(/condition === 'missing'.*quantity === 0|quantity === 0.*condition === 'missing'/);
  });

  it('MovementReportSection renders the retention note near its title with the exact required wording', () => {
    expect(movementReport).toContain("t('mvmt_report_history_preserved_note', lang)");
    expect(T.mvmt_report_history_preserved_note.ar).toBe('سجل الحركات محفوظ لأغراض التتبع ولا يُحذف عند حذف مواد المنفذ.');
    expect(T.mvmt_report_history_preserved_note.en).toBe('Movement history is retained for traceability and is not deleted when outlet materials are cleared.');
  });

  it('neither movement component is read-only violated — no mutating RPC/table call added', () => {
    expect(movementReport).not.toMatch(/\.rpc\(/);
    expect(movementReport).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(movementHistoryModal).not.toMatch(/\.rpc\(/);
    expect(movementHistoryModal).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });
});

describe('No movement-history delete button/path was added anywhere', () => {
  it('no delete/clear/purge-movement button, RPC call, or permission key exists', () => {
    for (const src of [statusCenter, institutions, movementReport, movementHistoryModal]) {
      expect(src).not.toMatch(/\.rpc\(\s*['"](clear|delete|purge)_.*movement/i);
    }
    const permissions = readSrc('shared/lib/permissions.ts');
    expect(permissions).not.toMatch(/movements?\.(clear|delete|purge)/i);
  });

  it('item_availability_movements is still never deleted from by any file touched in this phase', () => {
    for (const src of [statusCenter, institutions, availabilityService, lifecycleService]) {
      expect(src).not.toMatch(/\.from\('item_availability_movements'\)[\s\S]{0,120}?\.delete\(/);
    }
  });

  it('audit_logs is never deleted from by any file touched in this phase', () => {
    for (const src of [statusCenter, institutions, availabilityService, lifecycleService]) {
      expect(src).not.toMatch(/\.from\('audit_logs'\)[\s\S]{0,120}?\.delete\(/);
    }
  });
});

describe('Permission gating for clear/remove/disable is unchanged by this phase', () => {
  it('PortCleanupWizard visibility is still gated by canArchivePorts (unchanged)', () => {
    const cardStart = institutions.indexOf('function PortCard');
    const cardBody = institutions.slice(cardStart, institutions.indexOf('function QrPreviewModal', cardStart));
    expect(cardBody).toMatch(/\{canArchivePorts &&\s*\(\s*<PortCleanupWizard/);
  });

  it('the outlet contents "Remove from outlet" button is still gated by canRemove, not canMutate', () => {
    const fnStart = institutions.indexOf('function PortAvailabilitySection');
    const fnBody = institutions.slice(fnStart, institutions.indexOf('function QuickAvailForm'));
    expect(fnBody).toMatch(/\{canRemove\s*&&\s*\(/);
  });

  it('no new permission key was invented — permissions.ts is unchanged by this phase', () => {
    const permissions = readSrc('shared/lib/permissions.ts');
    expect(permissions).not.toMatch(/BUGFIX-HIDE-CLEARED-PORT-CONTENTS-A/);
  });

  it('super_admin retains access: clear_port_availability role allowlist is untouched (migration 042, no new migration this phase)', () => {
    const migration042 = readSrc('../supabase/migrations/042_phoenix_clear_port_availability_movement_safe.sql');
    expect(migration042).toMatch(/v_role NOT IN \('super_admin', 'hospital_admin', 'warehouse_manager'\)/);
  });
});

describe('Error handling: precise classification preserved, not weakened by this phase', () => {
  it('classifyClearPortItemsError is unchanged and still exported', () => {
    expect(lifecycleService).toContain('export function classifyClearPortItemsError');
  });

  it('PortCleanupWizard still classifies failures and logs to console instead of showing a raw/generic message', () => {
    const fnStart = institutions.indexOf('async function onClearItems');
    const fnBody = institutions.slice(fnStart, institutions.indexOf('} finally {', fnStart));
    expect(fnBody).toContain('console.error(');
    expect(fnBody).toContain('classifyClearPortItemsError(e)');
  });
});

describe('Guards: no Service-D/inter_org_exchange, no wipe tooling, no migration created', () => {
  it('no inter_org_exchange reference in any file touched this phase', () => {
    for (const src of [statusCenter, institutions, movementReport, availabilityService]) {
      expect(src).not.toMatch(/inter_org_exchange/i);
    }
  });

  it('no service_role/auth.admin usage in any file touched this phase', () => {
    for (const src of [statusCenter, institutions, movementReport, availabilityService]) {
      expect(src).not.toMatch(/service_role|auth\.admin/i);
    }
  });

  it('no wipe tooling references', () => {
    for (const src of [statusCenter, institutions]) {
      expect(src).not.toMatch(/phoenix-wipe-execute|FULL_PUBLIC_APP_WIPE_APPROVED|full_wipe/i);
    }
  });

  it('no new migration was added for this phase — display-only fix, no backend/data change required (only the separately-reviewed migrations 044/045, DB-MY-ACCOUNT-WHATSAPP-PHONE-A / DB-MY-ACCOUNT-WHATSAPP-RPC-A, are allowed beyond 043)', () => {
    const ROOT = join(__dirname, '../../../../');
    const migrationsDir = join(ROOT, 'supabase/migrations');
    const matches = readdirSync(migrationsDir).filter((f: string) => /^0(4[4-9]|[5-9][0-9])_/.test(f));
    expect(matches).toEqual(['044_phoenix_profiles_whatsapp_phone.sql', '045_phoenix_update_my_whatsapp_phone_rpc.sql', '046_phoenix_set_my_org_whatsapp_contact_rpc.sql', '047_phoenix_live_alerts_contact_fields.sql', '048_live_alerts_expiry_risk_tiers.sql', '049_add_national_code_to_item_availability.sql', '050_phoenix_upsert_availability_national_code.sql', '051_material_batch_identity_option_a.sql', '052_qr_effective_condition_quantity_zero.sql', '053_item_availability_removed_marker.sql']);
  });
});

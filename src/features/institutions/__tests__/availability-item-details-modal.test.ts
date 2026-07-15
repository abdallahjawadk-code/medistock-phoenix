/**
 * PHASE2-AVAILABILITY-ITEM-DETAILS-MODAL-A
 *
 * Static source-code tests for the read-only availability item details
 * modal: PortAvailabilitySection's outlet material row now opens
 * AvailabilityItemDetailsModal.tsx on click, showing already-fetched
 * inventory/availability fields only — never clinical/pharmacological
 * information, never raw internal IDs/auth UUIDs/removed_by.
 *
 * No live DB is used and no component is rendered — these are static
 * source-code assertions, matching this repo's established test conventions
 * (see remove-button-marks-removed-at.test.ts / hide-cleared-port-contents.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const institutionScreen = readSrc('features/institutions/InstitutionScreen.tsx');
const detailsModal = readSrc('features/institutions/AvailabilityItemDetailsModal.tsx');
const strings = readSrc('shared/i18n/strings.ts');

function portAvailabilitySectionBody(): string {
  const start = institutionScreen.indexOf('function PortAvailabilitySection');
  const end = institutionScreen.indexOf('function QuickAvailForm');
  return institutionScreen.slice(start, end);
}

describe('A) Clicking an availability row opens the details modal', () => {
  it('the material row is clickable and opens the details modal via setDetailsRow', () => {
    const body = portAvailabilitySectionBody();
    expect(body).toMatch(/onClick=\{\(\) => setDetailsRow\(r\)\}/);
    expect(body).toContain('role="button"');
  });

  it('the row is also keyboard-activatable (Enter/Space) — same handler, not a mouse-only trap', () => {
    const body = portAvailabilitySectionBody();
    expect(body).toMatch(/onKeyDown=\{\(e\) => \{ if \(e\.key === 'Enter' \|\| e\.key === ' '\) \{ e\.preventDefault\(\); setDetailsRow\(r\); \} \}\}/);
  });

  it('clicking the status badge also opens the modal (badge has no own onClick, so the click bubbles to the row)', () => {
    const body = portAvailabilitySectionBody();
    const badgeIdx = body.indexOf('<PhoenixStatusBadge variant={variant} label={condKey ? t(condKey, lang) : r.condition} />');
    expect(badgeIdx).toBeGreaterThan(-1);
    // The badge itself must not stopPropagation or carry its own onClick — otherwise
    // clicking it would NOT reach the row's onClick and the modal would not open.
    const badgeTag = body.slice(badgeIdx, badgeIdx + 100);
    expect(badgeTag).not.toContain('onClick');
    expect(badgeTag).not.toContain('stopPropagation');
  });

  it('the modal is wired with the detailsRow state and pointName/orgName pass-through', () => {
    expect(institutionScreen).toContain('<AvailabilityItemDetailsModal');
    expect(institutionScreen).toContain('open={detailsRow !== null}');
    expect(institutionScreen).toContain('onClose={() => setDetailsRow(null)}');
    expect(institutionScreen).toContain('row={detailsRow}');
    expect(institutionScreen).toContain('pointName={pointName}');
    expect(institutionScreen).toContain('orgName={orgName}');
  });

  it('detailsRow state is purely local UI state (useState), not a data fetch', () => {
    const body = portAvailabilitySectionBody();
    expect(body).toContain('const [detailsRow, setDetailsRow] = useState<AvailRow | null>(null);');
  });
});

describe('B) Remove / QR / Edit / Disable / Clear-port actions do not accidentally open the modal', () => {
  it('the Remove from outlet button stops propagation before its own click handler runs', () => {
    const body = portAvailabilitySectionBody();
    expect(body).toMatch(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); setRemoveError\(null\); setRemoveTarget\(r\); \}\}/);
  });

  it('the Remove button click handler never calls setDetailsRow', () => {
    const body = portAvailabilitySectionBody();
    const btnStart = body.indexOf("onClick={(e) => { e.stopPropagation(); setRemoveError(null); setRemoveTarget(r); }}");
    const btnLine = body.slice(btnStart, btnStart + 120);
    expect(btnLine).not.toContain('setDetailsRow');
  });

  it('QR/Edit outlet/Disable outlet/Clear port buttons live in PortCard, outside PortAvailabilitySection\'s row — not descendants of the new clickable row, so they cannot bubble into it', () => {
    // These actions are rendered by PortCard itself (point-level), not inside
    // the per-row div inside PortAvailabilitySection — confirm PortAvailabilitySection's
    // own body renders none of their JSX/calls (a passing mention in a doc
    // comment, e.g. explaining the refreshKey prop, doesn't count).
    const body = portAvailabilitySectionBody();
    expect(body).not.toMatch(/createQrForTarget\(|regenerateQrForPoint\(/);
    expect(body).not.toContain("t('port_disable_action'");
    expect(body).not.toContain('<PortCleanupWizard');
  });

  it('existing remove-from-outlet RPC call/behavior is unchanged (still the single unconditional applyAvailabilityMovement call)', () => {
    const start = institutionScreen.indexOf('async function onConfirmRemove');
    const body = institutionScreen.slice(start, start + 900);
    expect(body).toContain("movementType: 'set_exact'");
    expect(body).toContain('amount: 0');
    expect(body).toContain("reason: 'removed_from_outlet'");
    expect(body).not.toMatch(/if\s*\(\s*removeTarget\.quantity\s*!==\s*0\s*\)/);
  });

  it('clear-port / safe-delete (PortCleanupWizard, onClearItems) is untouched by this phase', () => {
    const start = institutionScreen.indexOf('async function onClearItems');
    const body = institutionScreen.slice(start, institutionScreen.indexOf('} catch (e) {', start));
    expect(body).toMatch(/await clearPortAvailability\(pointId\);/);
  });
});

describe('C) AvailabilityItemDetailsModal is read-only', () => {
  it('never imports or calls any write RPC / mutating service function', () => {
    expect(detailsModal).not.toMatch(/upsertAvailability|applyAvailabilityMovement|clearPortAvailability|supabase\.rpc\(/);
    expect(detailsModal).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });

  it('has no delete/remove/reactivate/edit/clear action of any kind — only a Close button', () => {
    expect(detailsModal).not.toMatch(/reactivat/i);
    expect(detailsModal).not.toContain('setRemoveTarget');
    expect(detailsModal).not.toContain('setDetailsRow');
    const buttonCount = (detailsModal.match(/<PhoenixButton/g) ?? []).length;
    expect(buttonCount).toBe(1);
    expect(detailsModal).toContain("t('close', lang)");
  });

  it('title is the required bilingual "تفاصيل المادة" / "Item Details"', () => {
    expect(T('avail_details_title').ar).toBe('تفاصيل المادة');
    expect(T('avail_details_title').en).toBe('Item Details');
    expect(detailsModal).toContain("title={t('avail_details_title', lang)}");
  });

  it('has an explicit close (X) button in addition to the footer Close button', () => {
    expect(detailsModal).toContain('onClick={onClose}');
    expect(detailsModal).toContain('✕');
  });
});

describe('D) Modal shows the required inventory fields when available', () => {
  const fields = [
    'avail_scientific_name', 'avail_trade_name', 'avail_dosage_form', 'avail_concentration',
    'qty', 'avail_condition', 'sc_entered_price', 'avail_supply_type', 'batch_no', 'expiry',
    'avail_details_days_to_expiry', 'avail_details_early_monitoring', 'sc_notes', 'last_upd',
    'avail_details_outlet_label', 'avail_inst_label',
  ];
  it.each(fields)('renders a labeled row for %s', (key) => {
    expect(detailsModal).toContain(`t('${key}', lang)`);
  });

  it('reads price/batch_number/expiry_date/supply_type/notes/updated_at/removed_at directly off the row (already fetched by getAvailabilityByPoint)', () => {
    expect(detailsModal).toContain('row.price');
    expect(detailsModal).toContain('row.batch_number');
    expect(detailsModal).toContain('row.expiry_date');
    expect(detailsModal).toContain('row.supply_type');
    expect(detailsModal).toContain('row.notes');
    expect(detailsModal).toContain('row.updated_at');
    expect(detailsModal).toContain('row.removed_at');
  });

  it('formats price with 2 decimals when a positive numeric price is present, otherwise a dash placeholder', () => {
    const fnStart = detailsModal.indexOf('function priceOrDash');
    const fnBody = detailsModal.slice(fnStart, fnStart + 250);
    expect(fnBody).toContain('toFixed(2)');
    expect(fnBody).toContain("return DASH;");
  });

  it('missing optional text fields (trade name, batch number, notes, supply type) fall back to the dash placeholder, never blank/undefined', () => {
    const fnStart = detailsModal.indexOf('function textOrDash');
    const fnBody = detailsModal.slice(fnStart, fnStart + 200);
    expect(fnBody).toContain('DASH');
    expect(detailsModal).toContain("const DASH = '—';");
  });

  it('Removed status is shown only when row.removed_at is set, using the exact same sc_removed_badge/sc_removed_at_label i18n keys as Status Center', () => {
    expect(detailsModal).toContain('const isRemoved = row.removed_at != null;');
    expect(detailsModal).toMatch(/isRemoved && \(/);
    expect(detailsModal).toContain("t('sc_removed_badge', lang)");
    expect(detailsModal).toContain("t('sc_removed_at_label', lang)");
  });
});

describe('E) No sensitive/clinical data is exposed', () => {
  it('never renders row.id or any other raw internal id/uuid field', () => {
    expect(detailsModal).not.toMatch(/\brow\.id\b/);
    expect(detailsModal).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it('never actually reads/renders row.removed_by (the raw auth uuid column) — only mentioned in a doc comment explaining its deliberate exclusion', () => {
    expect(detailsModal).not.toMatch(/row\.removed_by|r\.removed_by/);
  });

  it('never renders dose/dosing/mechanism/warning/clinical/pharmacology-type medical content as UI copy (only appears in the file-level doc comment stating this is explicitly NOT a medical card)', () => {
    const withoutComments = detailsModal.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(withoutComments).not.toMatch(/mechanism of action|contraindicat|dosage instructions|side effect|drug interaction/i);
  });

  it('AvailRow (the type this modal is built against) itself carries no removal_reason/removed_by/national_code — only fields getAvailabilityByPoint actually selects', () => {
    const start = institutionScreen.indexOf('export interface AvailRow');
    const body = institutionScreen.slice(start, institutionScreen.indexOf('\n}', start));
    expect(body).not.toMatch(/removed_by|removal_reason|national_code/);
  });
});

describe('F) i18n: new keys exist bilingually with the exact required Arabic/English wording', () => {
  it('avail_details_title / avail_details_outlet_label / avail_details_days_to_expiry / avail_details_early_monitoring', () => {
    expect(T('avail_details_title')).toEqual({ ar: 'تفاصيل المادة', en: 'Item Details' });
    expect(T('avail_details_outlet_label')).toEqual({ ar: 'المنفذ', en: 'Outlet' });
    expect(T('avail_details_days_to_expiry')).toEqual({ ar: 'الأيام المتبقية للنفاد', en: 'Days to Expiry' });
    expect(T('avail_details_early_monitoring')).toEqual({ ar: 'المراقبة المبكرة', en: 'Early Monitoring' });
  });
});

function T(key: string): { ar: string; en: string } {
  const re = new RegExp(`${key}:\\s*\\{\\s*ar:\\s*'([^']+)',\\s*en:\\s*'([^']+)'`);
  const m = strings.match(re);
  if (!m) throw new Error(`key ${key} not found`);
  return { ar: m[1], en: m[2] };
}

describe('Guards: no SQL/migration/package change, safety files untouched', () => {
  it('no migration .sql file was created or modified by this phase (this phase\'s own test-file updates to existing migration guard tests are expected and out of scope here)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/055_phoenix_clean_availability_data.sql" ":!supabase/migrations/056_phoenix_platform_broadcast_notices.sql" ":!supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
    let listing = '';
    try {
      listing = execSync('git status --porcelain -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    // PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A: new reviewed migration 055,
    // prepared but not yet applied/committed, is the only allowed entry here.
    const unexpectedListing = listing.split(String.fromCharCode(10)).map(l => l.trim()).filter(Boolean)
      .filter(l => l !== '?? supabase/migrations/055_phoenix_clean_availability_data.sql'
                 && l !== 'A  supabase/migrations/055_phoenix_clean_availability_data.sql'
                 && l !== 'M supabase/migrations/055_phoenix_clean_availability_data.sql'
                 && l !== 'M  supabase/migrations/055_phoenix_clean_availability_data.sql'
                 && l !== '?? supabase/migrations/056_phoenix_platform_broadcast_notices.sql'
                 && l !== 'A  supabase/migrations/056_phoenix_platform_broadcast_notices.sql'
                 && l !== 'M supabase/migrations/056_phoenix_platform_broadcast_notices.sql'
                 && l !== 'M  supabase/migrations/056_phoenix_platform_broadcast_notices.sql'
                 && l !== '?? supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql'
                 && l !== 'A  supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql'
                 // PUBLIC-QR-DOSAGE-FORM-IMPLEMENT-A: new reviewed additive migration (untracked).
                 && l !== '?? supabase/migrations/058_phoenix_public_qr_dosage_form.sql'
                 && l !== '?? supabase/migrations/059_phoenix_public_qr_concentration.sql'
                 && l !== 'A  supabase/migrations/058_phoenix_public_qr_dosage_form.sql'
                 && l !== 'A  supabase/migrations/059_phoenix_public_qr_concentration.sql');
    expect(unexpectedListing).toEqual([]);
  });

  it('no package/lockfile diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  // QR-BUNDLE-CODE-SPLIT-A: a later, separately-reviewed phase legitimately
  // restructures src/app/App.tsx (route-level lazy loading) — excluded here.
  // DB-PRESSURE-QUICK-WINS-A: a later, separately-reviewed phase legitimately
  // adds a skipAuthBootstrap flag to src/app/AppContext.tsx — excluded here.
  it('no QR/auth/permissions/alert-lifecycle/movement-history file was touched by this phase', () => {
    let diff = '';
    try {
      diff = execSync(
        // PUBLIC-QR-DOSAGE-FORM-IMPLEMENT-A: PublicQrScreen.tsx excluded — additive
        // dosage_form render landed in that later, separately-reviewed phase.
        'git diff -- src/shared/supabase/services/qr.service.ts src/features/alerts/inter-org-alert-lifecycle.service.ts src/shared/supabase/services/auth.service.ts src/shared/lib/permissions.ts src/features/status/MovementHistoryModal.tsx src/features/status/MovementReportSection.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('availability.service.ts was not touched (no new query/RPC needed for this phase)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/shared/supabase/services/availability.service.ts', { cwd: ROOT, encoding: 'utf8' });
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
    const tempLine = status.split('\n').find(l => l.includes('supabase/.temp'));
    if (tempLine) {
      expect(tempLine.trim().startsWith('??')).toBe(true);
    }
  });

  it('Service-D stash (paused inter-org exchange service work) remains untouched', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });
});

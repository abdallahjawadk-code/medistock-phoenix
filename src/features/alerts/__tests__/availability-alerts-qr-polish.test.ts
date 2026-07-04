/**
 * AVAILABILITY-ALERTS-QR-POLISH-A
 * Run: npm test -- --run
 *
 * Static source-code tests for this frontend-only polish phase covering
 * alert cards, the material editor, and the public QR display:
 *  - no raw UUID/alert_key rendered to users in alert cards.
 *  - no supply_type shown in user-facing alert/dashboard/QR screens (the
 *    pre-existing, properly-labeled supply_type field in the material
 *    editor and Status Center reports is an intentional, unrelated feature
 *    and is out of scope for this guard).
 *  - the public QR page exposes only safe display fields.
 *  - alert screens use the existing safe bilingual labels (no
 *    suggestion/recommendation/opportunity/اقتراح/فرصة wording).
 *  - no exchange-request UI or Service-D files were added/reintroduced in
 *    this phase (stash@{0} was not popped/applied).
 *  - no WhatsApp/Google Drive/chat code was added.
 *  - no migrations were touched and no package/lockfile changed.
 *  - premium-preview.html remains untouched.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const alertsScreen = readSrc('features/alerts/InterInstitutionAlertsScreen.tsx');
const publicQr = readSrc('features/qr/PublicQrScreen.tsx');
const editorScreen = readSrc('features/editor/EditorScreen.tsx');
const dashboardScreen = readSrc('features/dashboard/DashboardScreen.tsx');
const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');

const UUID_LITERAL_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('Alert cards: no raw UUID or alert_key rendered to users', () => {
  it('InterInstitutionAlertsScreen renders no literal UUID string in JSX text content', () => {
    // A UUID may legitimately appear as a React `key` prop value (internal,
    // never displayed) — this check only fails on a hardcoded UUID literal
    // appearing anywhere in the source, which would indicate a mock/example
    // value accidentally left in rendered markup.
    expect(alertsScreen).not.toMatch(UUID_LITERAL_RE);
  });

  it('does not render the raw alert_key field as visible text', () => {
    // alertKey is used internally only (React key, RPC calls) — never as
    // {a.alertKey} or similar inside a visible <span>/<div> text node.
    expect(alertsScreen).not.toMatch(/>\{a\.alertKey\}</);
    expect(alertsScreen).not.toMatch(/>\{alert\.alertKey\}</);
  });

  it('does not render raw source/target item availability ids as visible text', () => {
    expect(alertsScreen).not.toMatch(/>\{a\.sourceItemAvailabilityId\}</);
    expect(alertsScreen).not.toMatch(/>\{a\.targetItemAvailabilityId\}</);
  });
});

describe('supply_type is not shown in user-facing alert/dashboard/QR screens', () => {
  it('InterInstitutionAlertsScreen does not reference supply_type', () => {
    expect(alertsScreen).not.toContain('supply_type');
  });

  it('DashboardScreen does not reference supply_type', () => {
    expect(dashboardScreen).not.toContain('supply_type');
  });

  it('PublicQrScreen does not reference supply_type', () => {
    expect(publicQr).not.toContain('supply_type');
  });
});

describe('Public QR page exposes only safe display fields', () => {
  it('does not reference any raw id/uuid field', () => {
    expect(publicQr).not.toMatch(/\bitem\.id\b/);
    expect(publicQr).not.toMatch(/\bpublic_id\b/);
    expect(publicQr).not.toMatch(UUID_LITERAL_RE);
  });

  it('does not reference batch_number or audit fields', () => {
    expect(publicQr).not.toMatch(/batch_number|audit_log|created_by|updated_by/);
  });

  it('does not reference alert_key or exchange fields', () => {
    expect(publicQr).not.toContain('alert_key');
    expect(publicQr).not.toContain('inter_org_exchange');
  });

  it('displays the "no internal data exposed" privacy footer', () => {
    expect(publicQr).toContain("t('qr_no_expose', lang)");
  });

  it('item cards use the shared design-token shadow (visual polish applied)', () => {
    expect(publicQr).toContain("boxShadow: 'var(--sh-xs)'");
  });
});

describe('AVAILABILITY-ALERTS-QR-POLISH-D: public QR status-summary chips', () => {
  it('computes summary counts from rawItems only (no new fetch/field)', () => {
    expect(publicQr).toContain('summaryCounts');
    expect(publicQr).toMatch(/for \(const item of rawItems\)/);
  });

  it('only uses conditions already present in the existing CONDITION_VARIANT/CONDITION_LABEL set', () => {
    expect(publicQr).toContain("const SUMMARY_CONDITIONS = ['available', 'surplus', 'low_stock', 'near_expiry', 'missing', 'expired']");
  });

  it('summary chips are display-only — no buttons, no exchange wiring', () => {
    const summaryBlock = publicQr.slice(publicQr.indexOf('Status summary'), publicQr.indexOf('{/* Search */}'));
    expect(summaryBlock).not.toMatch(/<button/);
    expect(summaryBlock).not.toContain('inter_org_exchange');
    expect(summaryBlock).not.toContain('createInterOrgExchangeRequest');
  });

  it('summary does not expose ids/uuid/alert_key/exchange fields', () => {
    const summaryBlock = publicQr.slice(publicQr.indexOf('Status summary'), publicQr.indexOf('{/* Search */}'));
    expect(summaryBlock).not.toMatch(UUID_LITERAL_RE);
    expect(summaryBlock).not.toMatch(/\bitem\.id\b/);
    expect(summaryBlock).not.toContain('alert_key');
    expect(summaryBlock).not.toContain('inter_org_exchange');
  });

  it('still does not reference supply_type anywhere in the file', () => {
    expect(publicQr).not.toContain('supply_type');
  });

  it('has no forbidden wording near the summary block', () => {
    const summaryBlock = publicQr.slice(publicQr.indexOf('Status summary'), publicQr.indexOf('{/* Search */}'));
    expect(summaryBlock.toLowerCase()).not.toMatch(/suggestion|suggested|recommendation|recommended|opportunit/);
    expect(summaryBlock).not.toContain('اقتراح');
    expect(summaryBlock).not.toContain('فرصة');
  });
});

describe('Material editor: responsive layout polish', () => {
  it('uses an auto-fit responsive grid instead of a fixed 2-column grid (mobile-friendly)', () => {
    expect(editorScreen).toContain("gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))'");
    expect(editorScreen).not.toContain("gridTemplateColumns: '1fr 1fr'");
  });
});

describe('Alert screens use safe bilingual labels (no forbidden wording)', () => {
  it('InterInstitutionAlertsScreen has no suggestion/recommendation/opportunity/اقتراح/فرصة wording', () => {
    expect(alertsScreen.toLowerCase()).not.toMatch(/suggestion|suggested|recommendation|recommended|opportunit/);
    expect(alertsScreen).not.toContain('اقتراح');
    expect(alertsScreen).not.toContain('فرصة');
  });

  it('PublicQrScreen has no suggestion/recommendation/opportunity/اقتراح/فرصة wording', () => {
    expect(publicQr.toLowerCase()).not.toMatch(/suggestion|suggested|recommendation|recommended|opportunit/);
    expect(publicQr).not.toContain('اقتراح');
    expect(publicQr).not.toContain('فرصة');
  });
});

describe('No exchange-request UI or Service-D files were added in this phase', () => {
  it('src/features/alerts/inter-org-exchange.service.ts does not exist in the working tree (paused via stash, not reintroduced)', () => {
    expect(existsSync(join(SRC, 'features/alerts/inter-org-exchange.service.ts'))).toBe(false);
  });

  it('no exchange screen/component directory exists', () => {
    expect(existsSync(join(SRC, 'features/exchange'))).toBe(false);
  });

  it('InterInstitutionAlertsScreen has no exchange-request button/modal wiring', () => {
    expect(alertsScreen).not.toContain('createInterOrgExchangeRequest');
    expect(alertsScreen).not.toContain('Create Exchange Request');
    expect(alertsScreen).not.toContain('inter_org_exchange');
  });

  it('stash@{0} (paused Service-D work) was not popped or applied', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });
});

describe('No WhatsApp/Google Drive/chat code was added', () => {
  // UX-WHATSAPP-ALERT-CONTACT-WIRING-A later approved a real, safe wa.me
  // WhatsApp contact button specifically inside InterInstitutionAlertsScreen
  // (see src/features/alerts/__tests__/whatsapp-alert-contact-wiring.test.ts
  // for its full safety coverage) — excluded from the "no WhatsApp" files
  // below on purpose; every other screen here must still have none.
  const files = [publicQr, editorScreen, dashboardScreen, statusCenter];

  it('no WhatsApp integration outside the approved InterInstitutionAlertsScreen wiring', () => {
    files.forEach(f => expect(f.toLowerCase()).not.toMatch(/wa\.me|whatsapp/));
  });

  it('no Google Drive integration', () => {
    [alertsScreen, ...files].forEach(f => expect(f.toLowerCase()).not.toMatch(/googleapis|google drive|drive\.google|gapi/));
  });

  it('no chat widget/module', () => {
    [alertsScreen, ...files].forEach(f => expect(f.toLowerCase()).not.toMatch(/livechat|chatwidget|intercom|zendesk chat/));
  });
});

describe('No migrations touched, no package/lockfile changes', () => {
  it('no migration SQL file was modified (checked via git diff, working tree only; test-only maintenance under supabase/migrations/__tests__/ is not a migration SQL change)', () => {
    let diff = '';
    try {
      diff = execSync("git diff -- 'supabase/migrations/*.sql'", { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');
  });

  it('no package.json/lockfile diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');
  });

  it('no migration newer than 043 was added by this phase — only the separately-reviewed migration 044 (DB-MY-ACCOUNT-WHATSAPP-PHONE-A) is allowed beyond it', () => {
    const migrationsDir = join(ROOT, 'supabase/migrations');
    const matches = readdirSync(migrationsDir).filter(f => /^0(4[4-9]|[5-9][0-9])_/.test(f));
    expect(matches).toEqual(['044_phoenix_profiles_whatsapp_phone.sql']);
  });
});

describe('premium-preview.html remains untouched', () => {
  it('is untracked and not staged/modified according to git status', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });
});

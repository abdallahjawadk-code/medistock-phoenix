import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { StatusReport } from '@/shared/supabase/services/status-reports.service';
import {
  buildScopedAlertsFromReports,
  scopeAlertsForActor,
  statusPairKey,
  recommendationSummary,
  sortByPriority,
  type OrgContact,
} from '../inter-institution-alerts';

// __dirname = phoenix/src/features/alerts/__tests__
const SRC     = join(__dirname, '../../../');     // → phoenix/src/
const PHOENIX = join(__dirname, '../../../../');  // → phoenix/
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const readPhoenix = (rel: string) => readFileSync(join(PHOENIX, rel), 'utf8');

// ─── report factory ──────────────────────────────────────────────────────────
let seq = 0;
function report(p: Partial<StatusReport> & { organization_id: string; status_type: StatusReport['status_type'] }): StatusReport {
  seq += 1;
  return {
    id: `r${seq}`,
    organization_id: p.organization_id,
    item_id: p.item_id ?? null,
    item_name: p.item_name ?? null,
    item_name_ar: p.item_name_ar ?? null,
    status_type: p.status_type,
    quantity: p.quantity ?? null,
    unit: p.unit ?? null,
    expiry_date: p.expiry_date ?? null,
    notes: p.notes ?? null,
    submitted_by: null,
    submitted_at: '2026-06-01T00:00:00Z',
    resolved_at: null,
    resolved_by: null,
    is_active: p.is_active ?? true,
    created_at: '2026-06-01T00:00:00Z',
    organizations: p.organizations ?? { name: `Org ${p.organization_id}`, name_ar: `مؤسسة ${p.organization_id}` },
  };
}

const ITEM = { item_name: 'Insulin', item_name_ar: 'أنسولين' };

// ============================================================================
// 1. Alert rules
// ============================================================================
describe('Inter-institution alert rules', () => {
  it('surplus source + missing target with quantity = high priority', () => {
    const alerts = buildScopedAlertsFromReports([
      report({ organization_id: 'A', status_type: 'surplus', quantity: 50, ...ITEM }),
      report({ organization_id: 'B', status_type: 'missing', ...ITEM }),
    ], [], null, true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].priority).toBe('high');
    expect(alerts[0].statusPair).toBe('surplus_missing');
  });

  it('surplus source + missing target without quantity = low priority', () => {
    const alerts = buildScopedAlertsFromReports([
      report({ organization_id: 'A', status_type: 'surplus', ...ITEM }),
      report({ organization_id: 'B', status_type: 'missing', ...ITEM }),
    ], [], null, true);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].priority).toBe('low');
  });

  it('surplus source + scarce target = medium priority', () => {
    const alerts = buildScopedAlertsFromReports([
      report({ organization_id: 'A', status_type: 'surplus', quantity: 10, ...ITEM }),
      report({ organization_id: 'B', status_type: 'scarce', ...ITEM }),
    ], [], null, true);
    expect(alerts[0].priority).toBe('medium');
    expect(alerts[0].statusPair).toBe('surplus_scarce');
  });

  it('near_expiry source + missing target = high priority', () => {
    const alerts = buildScopedAlertsFromReports([
      report({ organization_id: 'A', status_type: 'near_expiry', expiry_date: '2026-07-01', ...ITEM }),
      report({ organization_id: 'B', status_type: 'missing', ...ITEM }),
    ], [], null, true);
    expect(alerts[0].priority).toBe('high');
    expect(alerts[0].statusPair).toBe('expiry_missing');
    expect(alerts[0].recommendationKind).toBe('expiry_match');
  });

  it('near_expiry source + scarce target = medium priority', () => {
    const alerts = buildScopedAlertsFromReports([
      report({ organization_id: 'A', status_type: 'near_expiry', ...ITEM }),
      report({ organization_id: 'B', status_type: 'scarce', ...ITEM }),
    ], [], null, true);
    expect(alerts[0].priority).toBe('medium');
    expect(alerts[0].statusPair).toBe('expiry_scarce');
  });

  it('same organization is excluded', () => {
    const alerts = buildScopedAlertsFromReports([
      report({ organization_id: 'A', status_type: 'surplus', quantity: 50, ...ITEM }),
      report({ organization_id: 'A', status_type: 'missing', ...ITEM }),
    ], [], null, true);
    expect(alerts).toHaveLength(0);
  });

  it('inactive / resolved reports are excluded', () => {
    const alerts = buildScopedAlertsFromReports([
      report({ organization_id: 'A', status_type: 'surplus', quantity: 50, is_active: false, ...ITEM }),
      report({ organization_id: 'B', status_type: 'missing', ...ITEM }),
    ], [], null, true);
    expect(alerts).toHaveLength(0);
  });

  it('manual action is always required (no auto-transfer)', () => {
    const alerts = buildScopedAlertsFromReports([
      report({ organization_id: 'A', status_type: 'surplus', quantity: 5, ...ITEM }),
      report({ organization_id: 'B', status_type: 'missing', ...ITEM }),
    ], [], null, true);
    expect(alerts[0].manualActionRequired).toBe(true);
  });
});

// ============================================================================
// 2. Strict isolation (mirrors RPC WHERE clause)
// ============================================================================
describe('Inter-institution alert isolation', () => {
  const reports = () => [
    report({ organization_id: 'A', status_type: 'surplus', quantity: 5, ...ITEM }),
    report({ organization_id: 'B', status_type: 'missing', ...ITEM }),
    // Unrelated pair between C and D — must never leak to A.
    report({ organization_id: 'C', status_type: 'surplus', quantity: 5, item_name: 'Gauze', item_name_ar: 'شاش' }),
    report({ organization_id: 'D', status_type: 'missing', item_name: 'Gauze', item_name_ar: 'شاش' }),
  ];

  it('super_admin sees all alerts', () => {
    const alerts = buildScopedAlertsFromReports(reports(), [], null, true);
    expect(alerts.length).toBe(2);
  });

  it('non-super org A sees only alerts where A is source or target', () => {
    const alerts = buildScopedAlertsFromReports(reports(), [], 'A', false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].sourceOrgId === 'A' || alerts[0].targetOrgId === 'A').toBe(true);
  });

  it('unrelated institution alerts are hidden from a non-super actor', () => {
    const alerts = buildScopedAlertsFromReports(reports(), [], 'A', false);
    const involvesCorD = alerts.some(a =>
      ['C', 'D'].includes(a.sourceOrgId) || ['C', 'D'].includes(a.targetOrgId));
    expect(involvesCorD).toBe(false);
  });

  it('non-super with no org sees nothing', () => {
    expect(buildScopedAlertsFromReports(reports(), [], null, false)).toHaveLength(0);
  });

  it('scopeAlertsForActor keeps only own-org alerts for non-super', () => {
    const base = [
      { sourceOrgId: 'A', targetOrgId: 'B' },
      { sourceOrgId: 'C', targetOrgId: 'D' },
      { sourceOrgId: 'B', targetOrgId: 'A' },
    ];
    expect(scopeAlertsForActor(base, 'A', false)).toHaveLength(2);
    expect(scopeAlertsForActor(base, 'A', true)).toHaveLength(3);
  });
});

// ============================================================================
// 3. Contact privacy
// ============================================================================
describe('Inter-institution alert contacts', () => {
  const contacts: OrgContact[] = [
    { organizationId: 'A', displayName: 'Officer A', phone: '+964 770 111 2222' },
    { organizationId: 'B', displayName: 'Officer B', phone: '+964 771 333 4444' },
    { organizationId: 'C', displayName: 'Officer C', phone: '+964 772 555 6666' },
  ];

  it('attaches source and target officer contacts to a scoped alert', () => {
    const alerts = buildScopedAlertsFromReports([
      report({ organization_id: 'A', status_type: 'surplus', quantity: 5, ...ITEM }),
      report({ organization_id: 'B', status_type: 'missing', ...ITEM }),
    ], contacts, 'A', false);
    expect(alerts[0].sourceContactPhone).toBe('+964 770 111 2222');
    expect(alerts[0].targetContactPhone).toBe('+964 771 333 4444');
    expect(alerts[0].targetContactName).toBe('Officer B');
  });

  it('phone is shown only for the scoped matching alert (no unrelated phones)', () => {
    const reports = [
      report({ organization_id: 'A', status_type: 'surplus', quantity: 5, ...ITEM }),
      report({ organization_id: 'B', status_type: 'missing', ...ITEM }),
      report({ organization_id: 'C', status_type: 'surplus', quantity: 5, item_name: 'Gauze', item_name_ar: 'شاش' }),
      report({ organization_id: 'A', status_type: 'missing', item_name: 'Gauze', item_name_ar: 'شاش' }),
    ];
    const alerts = buildScopedAlertsFromReports(reports, contacts, 'A', false);
    const phones = alerts.flatMap(a => [a.sourceContactPhone, a.targetContactPhone]).filter(Boolean);
    // Org D never appears; only A/B/C contacts that are party to an A-scoped alert.
    expect(phones).not.toContain(null);
    // Every alert returned must involve org A.
    expect(alerts.every(a => a.sourceOrgId === 'A' || a.targetOrgId === 'A')).toBe(true);
  });

  it('missing contact yields null phone (graceful)', () => {
    const alerts = buildScopedAlertsFromReports([
      report({ organization_id: 'A', status_type: 'surplus', quantity: 5, ...ITEM }),
      report({ organization_id: 'B', status_type: 'missing', ...ITEM }),
    ], [], 'A', false);
    expect(alerts[0].sourceContactPhone).toBeNull();
    expect(alerts[0].targetContactPhone).toBeNull();
  });
});

// ============================================================================
// 4. Helpers
// ============================================================================
describe('Inter-institution alert helpers', () => {
  it('statusPairKey maps each pair', () => {
    expect(statusPairKey('surplus', 'missing')).toBe('surplus_missing');
    expect(statusPairKey('surplus', 'scarce')).toBe('surplus_scarce');
    expect(statusPairKey('near_expiry', 'missing')).toBe('expiry_missing');
    expect(statusPairKey('near_expiry', 'scarce')).toBe('expiry_scarce');
  });

  it('sortByPriority orders high → low', () => {
    const sorted = sortByPriority([
      { priority: 'low' as const }, { priority: 'high' as const }, { priority: 'medium' as const },
    ]);
    expect(sorted.map(s => s.priority)).toEqual(['high', 'medium', 'low']);
  });

  it('recommendationSummary includes phone and a manual-action note', () => {
    const [alert] = buildScopedAlertsFromReports([
      report({ organization_id: 'A', status_type: 'surplus', quantity: 5, unit: 'box', ...ITEM }),
      report({ organization_id: 'B', status_type: 'missing', ...ITEM }),
    ], [{ organizationId: 'B', displayName: 'Officer B', phone: '07712223333' }], 'A', false);
    const en = recommendationSummary(alert, 'en');
    expect(en).toContain('07712223333');
    expect(en.toLowerCase()).toContain('manual');
    const ar = recommendationSummary(alert, 'ar');
    expect(ar).toContain('يدوي');
  });
});

// ============================================================================
// 5. Navigation wiring + route
// ============================================================================
describe('Inter-institution alerts: navigation wiring', () => {
  it('App routes screen 13 to the alerts screen', () => {
    // QR-BUNDLE-CODE-SPLIT-A: the screen-number switch now lives in
    // AuthenticatedApp.tsx, not App.tsx.
    const authenticatedApp = readSrc('app/AuthenticatedApp.tsx');
    expect(authenticatedApp).toContain('InterInstitutionAlertsScreen');
    expect(authenticatedApp).toMatch(/case 13:\s*return <InterInstitutionAlertsScreen/);
  });

  it('sidebar includes the alerts page', () => {
    const sidebar = readSrc('shared/ui/PhoenixSidebar.tsx');
    expect(sidebar).toContain('nav_inter_alerts');
    expect(sidebar).toContain('screen: 13');
  });

  it('mobile drawer includes the alerts page', () => {
    const drawer = readSrc('shared/ui/PhoenixMobileDrawer.tsx');
    expect(drawer).toContain('nav_inter_alerts');
    expect(drawer).toContain('screen: 13');
  });

  it('app shell maps the alerts title', () => {
    const shell = readSrc('shared/ui/PhoenixAppShell.tsx');
    expect(shell).toContain("13: 'nav_inter_alerts'");
  });
});

// ============================================================================
// 6. Bilingual labels
// ============================================================================
describe('Inter-institution alerts: bilingual labels', () => {
  const strings = readSrc('shared/i18n/strings.ts');
  const REQUIRED = [
    'nav_inter_alerts', 'iia_title', 'iia_sub',
    'iia_priority_high', 'iia_priority_medium', 'iia_priority_low',
    'iia_source', 'iia_target', 'iia_item', 'iia_quantity', 'iia_expiry',
    'iia_officer', 'iia_phone', 'iia_copy_phone', 'iia_copy_reco',
    'iia_manual', 'iia_empty',
    'iia_pair_surplus_missing', 'iia_pair_surplus_scarce',
    'iia_pair_expiry_missing', 'iia_pair_expiry_scarce',
  ];
  REQUIRED.forEach(key => {
    it(`string key exists: ${key}`, () => {
      expect(strings).toContain(`${key}:`);
    });
  });

  it('Arabic empty-state text matches the spec', () => {
    expect(strings).toContain('لا توجد تنبيهات بين المؤسسات حالياً');
  });
  it('Arabic title matches the spec', () => {
    expect(strings).toContain('تنبيهات بين المؤسسات');
  });
});

// ============================================================================
// 7. Frontend safety
// ============================================================================
describe('Inter-institution alerts: frontend safety', () => {
  const screen  = readSrc('features/alerts/InterInstitutionAlertsScreen.tsx');
  const service = readSrc('features/alerts/inter-institution-alerts.service.ts');
  const helper  = readSrc('features/alerts/inter-institution-alerts.ts');

  it('no service_role anywhere in the new code', () => {
    expect(screen).not.toContain('service_role');
    expect(service).not.toContain('service_role');
    expect(helper).not.toContain('service_role');
  });

  it('no auto-transfer / auto-approval logic', () => {
    const all = screen + service + helper;
    expect(all).not.toMatch(/createTransfer|auto_transfer|autoApprove|approveTransfer/i);
  });

  it('service calls the scoped RPC', () => {
    expect(service).toContain("supabase.rpc('get_scoped_inter_institution_alerts')");
  });

  it('non-super gets migrationMissing (never loads all reports) when RPC absent', () => {
    expect(service).toContain('migrationMissing: true');
    // Fallback to client-side report scan is gated behind isSuper.
    expect(service).toMatch(/if \(actor\.isSuper\)/);
  });

  it('timestamps/dates render with dir="ltr" (LIVE-INTER-INSTITUTION-ALERTS-UI-A: the rebuilt screen has no phone/contact UI — the live RPC payload carries no contact fields at all, unlike the legacy migration-009 RPC)', () => {
    expect(screen).toMatch(/dir="ltr"/);
    expect(screen).not.toContain('tel:');
  });

  it('dates render with dir="ltr"', () => {
    expect(screen).toMatch(/dir="ltr">[\s\S]*?expiry/i);
  });

  it('item names and org names use dir="auto"', () => {
    expect(screen).toContain('dir="auto"');
  });

  it('public QR screen never exposes phone fields', () => {
    const publicQr = readSrc('features/qr/PublicQrScreen.tsx');
    expect(publicQr).not.toMatch(/phone|contact_phone|officer/i);
  });
});

// ============================================================================
// 8. Migration safety (008 contacts + 009 scoped RPC) — not applied
// ============================================================================
describe('Migration 008: organization_status_contacts', () => {
  const sql = readPhoenix('supabase/migrations/008_phoenix_org_status_contacts.sql');

  it('creates the contacts table with RLS enabled', () => {
    expect(sql).toMatch(/create table if not exists organization_status_contacts/i);
    expect(sql).toMatch(/alter table organization_status_contacts\s+enable row level security/i);
  });
  it('has no anon policy', () => {
    expect(sql).not.toMatch(/to anon/i);
  });
  it('warns not to use db push', () => {
    expect(sql).toContain('supabase db push');
  });
  it('uses no DROP/TRUNCATE shortcut', () => {
    expect(sql).not.toMatch(/\bdrop table\b|\btruncate\b/i);
  });
});

describe('Migration 009: get_scoped_inter_institution_alerts RPC', () => {
  const sql = readPhoenix('supabase/migrations/009_phoenix_inter_institution_alerts.sql');

  it('is SECURITY DEFINER with a fixed search_path', () => {
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = public, pg_temp/i);
  });
  it('requires auth.uid()', () => {
    expect(sql).toContain('auth.uid()');
    expect(sql).toContain('NOT_AUTHENTICATED');
  });
  it('scopes non-super to own-org source or target', () => {
    expect(sql).toMatch(/v_role = 'super_admin'/);
    expect(sql).toMatch(/m\.src_org = v_org_id/);
    expect(sql).toMatch(/m\.tgt_org = v_org_id/);
  });
  it('excludes same-org and inactive reports', () => {
    expect(sql).toMatch(/s\.organization_id <> t\.organization_id/);
    expect(sql).toMatch(/is_active = true/);
  });
  it('revokes anon and grants authenticated', () => {
    expect(sql).toContain('revoke all on function get_scoped_inter_institution_alerts() from anon');
    expect(sql).toContain('grant execute on function get_scoped_inter_institution_alerts() to authenticated');
  });
  it('returns manual_action_required = true (no auto-transfer)', () => {
    expect(sql).toMatch(/true\s+as manual_action_required/);
  });
  it('warns not to use db push', () => {
    expect(sql).toContain('supabase db push');
  });
});

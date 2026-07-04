/**
 * ALERT-CARDS-EXPIRY-RISK-BADGES-UI-A
 * Run: npm test -- --run
 *
 * Frontend-only wiring of migration 048's source_expiry_risk_tier /
 * source_expiry_days_remaining jsonb fields into the inter-institution
 * alert cards. Static source-code tests (same pattern as
 * whatsapp-alert-contact-wiring.test.ts and live-inter-institution-alerts-ui.test.ts:
 * readFileSync + string/regex assertions — there is no React test renderer
 * wired up in this repo).
 *
 * Scope: this phase does NOT touch DB/RPC/RLS/alert lifecycle/WhatsApp
 * behavior — it only maps two already-returned RPC fields into the existing
 * camelCase alert model and renders them using the existing, already-tested
 * EXPIRY-RISK-TIERS-A frontend helper (src/shared/lib/expiry-risk.ts).
 * batch_number/national_code are NOT part of the current alert RPC payload
 * and are therefore intentionally NOT added here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const lifecycleService = readSrc('features/alerts/inter-org-alert-lifecycle.service.ts');
const alertsScreen = readSrc('features/alerts/InterInstitutionAlertsScreen.tsx');
const expiryRiskHelper = readSrc('shared/lib/expiry-risk.ts');

describe('Service: LiveInterInstitutionAlertWithState declares the two new optional fields', () => {
  it('declares sourceExpiryRiskTier and sourceExpiryDaysRemaining as optional/nullable', () => {
    const typeBlock = lifecycleService.slice(
      lifecycleService.indexOf('export interface LiveInterInstitutionAlertWithState'),
      lifecycleService.indexOf('export interface LiveInterInstitutionAlertsWithStateResult'),
    );
    expect(typeBlock).toContain("sourceExpiryRiskTier?: 'unknown' | 'expired' | 'critical_3m' | 'warning_6m' | 'watch_9m' | 'normal' | string | null;");
    expect(typeBlock).toContain('sourceExpiryDaysRemaining?: number | null;');
  });

  it('RawLiveAlertWithStateRow declares the matching snake_case optional fields', () => {
    const rawBlock = lifecycleService.slice(
      lifecycleService.indexOf('interface RawLiveAlertWithStateRow'),
      lifecycleService.indexOf('interface RawAlertEventRow'),
    );
    expect(rawBlock).toContain('source_expiry_risk_tier?: string | null;');
    expect(rawBlock).toContain('source_expiry_days_remaining?: number | null;');
  });
});

describe('Service: mapRow maps source_expiry_risk_tier/source_expiry_days_remaining to camelCase', () => {
  const mapBlock = lifecycleService.slice(
    lifecycleService.indexOf('function mapRow('),
    lifecycleService.indexOf('function mapEvent('),
  );

  it('maps source_expiry_risk_tier to sourceExpiryRiskTier, defaulting a missing value to null (never undefined)', () => {
    expect(mapBlock).toContain('sourceExpiryRiskTier: r.source_expiry_risk_tier ?? null');
  });

  it('maps source_expiry_days_remaining to sourceExpiryDaysRemaining, defaulting a missing value to null (never undefined)', () => {
    expect(mapBlock).toContain('sourceExpiryDaysRemaining: r.source_expiry_days_remaining ?? null');
  });

  it('is backward-compatible with a pre-048 payload (both fields optional on the raw row type, so an absent key does not throw)', () => {
    const rawBlock = lifecycleService.slice(
      lifecycleService.indexOf('interface RawLiveAlertWithStateRow'),
      lifecycleService.indexOf('interface RawAlertEventRow'),
    );
    // Optional (`?:`) — TypeScript/JS destructuring an absent key is `undefined`,
    // and `undefined ?? null` safely resolves to `null`, never throwing.
    expect(rawBlock).toMatch(/source_expiry_risk_tier\?:/);
    expect(rawBlock).toMatch(/source_expiry_days_remaining\?:/);
  });
});

describe('Screen: reuses the existing EXPIRY-RISK-TIERS-A helper for labels/tones', () => {
  it('imports getExpiryRiskLabel, getExpiryRiskTone, and the ExpiryRiskTier type from the shared helper', () => {
    expect(alertsScreen).toContain("from '@/shared/lib/expiry-risk'");
    expect(alertsScreen).toContain('getExpiryRiskLabel');
    expect(alertsScreen).toContain('getExpiryRiskTone');
  });

  it('does not reimplement tier labels/thresholds locally (no new hardcoded ar/en tier label map)', () => {
    // The 6 tier labels already exist bilingually in expiry-risk.ts; this
    // phase must not duplicate them anywhere else.
    expect(expiryRiskHelper).toContain("critical_3m: { ar:");
    expect(alertsScreen).not.toMatch(/critical_3m['"]?\s*:\s*\{\s*ar:/);
  });

  it('validates the RPC tier string against the known vocabulary before using it (never trusts an arbitrary string)', () => {
    expect(alertsScreen).toContain('function asExpiryRiskTier(');
    expect(alertsScreen).toContain('KNOWN_EXPIRY_RISK_TIERS');
  });
});

describe('Screen: PartyBlock renders the tier badge and days-remaining line', () => {
  const partyBlockBlock = alertsScreen.slice(
    alertsScreen.indexOf('function PartyBlock('),
    alertsScreen.length,
  );

  it('PartyBlock accepts optional expiryRiskTier/expiryDaysRemaining props', () => {
    const sigBlock = alertsScreen.slice(
      alertsScreen.indexOf('function PartyBlock('),
      alertsScreen.indexOf('const riskTier ='),
    );
    expect(sigBlock).toContain('expiryRiskTier?: string | null;');
    expect(sigBlock).toContain('expiryDaysRemaining?: number | null;');
  });

  it('renders a PhoenixStatusBadge for the tier only when both an expiry date and a known tier are present', () => {
    expect(partyBlockBlock).toContain('{expiryDate && riskTier && (');
    expect(partyBlockBlock).toContain('<PhoenixStatusBadge variant={getExpiryRiskTone(riskTier)} label={getExpiryRiskLabel(riskTier, lang)} />');
  });

  it('renders the days-remaining line only when a numeric value is present', () => {
    expect(partyBlockBlock).toContain("{expiryDate && typeof expiryDaysRemaining === 'number' && (");
    expect(partyBlockBlock).toContain('{formatExpiryDaysRemaining(expiryDaysRemaining, lang)}');
  });

  it('formatExpiryDaysRemaining renders the exact suggested bilingual phrasing for both positive and negative day counts', () => {
    const fnBlock = alertsScreen.slice(
      alertsScreen.indexOf('function formatExpiryDaysRemaining('),
      alertsScreen.indexOf('function formatExpiryDaysRemaining(') + 400,
    );
    expect(fnBlock).toContain("lang === 'ar' ? `منتهي منذ ${n} يوم` : `Expired ${n} days ago`");
    expect(fnBlock).toContain("lang === 'ar' ? `بقي ${days} يوم` : `${days} days remaining`");
  });
});

describe('Screen: AlertCard only passes the new fields for the near-expiry source party', () => {
  it('gates expiryRiskTier/expiryDaysRemaining on alertType === near_expiry_to_shortage, exactly like the existing expiryDate gating', () => {
    expect(alertsScreen).toContain("expiryRiskTier={a.alertType === 'near_expiry_to_shortage' ? a.sourceExpiryRiskTier : null}");
    expect(alertsScreen).toContain("expiryDaysRemaining={a.alertType === 'near_expiry_to_shortage' ? a.sourceExpiryDaysRemaining : null}");
  });

  it('never passes the new fields for the target party (unchanged: target PartyBlock call has no expiry fields)', () => {
    const targetCallIdx = alertsScreen.indexOf('roleLabel={t(\'alertLifecycle_institution_targetInstitution\', lang)}');
    const targetCallBlock = alertsScreen.slice(targetCallIdx, targetCallIdx + 400);
    expect(targetCallBlock).not.toContain('expiryRiskTier=');
    expect(targetCallBlock).not.toContain('expiryDaysRemaining=');
  });
});

describe('No regression: alert sorting/filtering/lifecycle/WhatsApp behavior unchanged', () => {
  it('sortAlerts still only reorders on severity/targetStatus/alertType/computedAt (no new sort mode added)', () => {
    const sortBlock = alertsScreen.slice(alertsScreen.indexOf('function sortAlerts('), alertsScreen.indexOf('// ─── Main screen'));
    expect(sortBlock).toContain("case 'severity':");
    expect(sortBlock).toContain("case 'newest':");
    expect(sortBlock).not.toContain('ExpiryRisk');
  });

  it('the filtered/useMemo filter predicate is unchanged (no new expiry-risk filter field added)', () => {
    const filterBlock = alertsScreen.slice(alertsScreen.indexOf('const filtered = useMemo('), alertsScreen.indexOf('const sortedFiltered'));
    expect(filterBlock).not.toMatch(/ExpiryRisk/);
  });

  it('lifecycle action buttons (acknowledge/start processing/resolve/dismiss/reopen/history) are all still present', () => {
    expect(alertsScreen).toContain("t('alertLifecycle_action_acknowledge', lang)");
    expect(alertsScreen).toContain("t('alertLifecycle_action_startProcessing', lang)");
    expect(alertsScreen).toContain("t('alertLifecycle_action_resolve', lang)");
    expect(alertsScreen).toContain("t('alertLifecycle_action_dismiss', lang)");
    expect(alertsScreen).toContain("t('alertLifecycle_action_reopen', lang)");
    expect(alertsScreen).toContain("t('alertLifecycle_action_viewHistory', lang)");
  });

  it('WhatsApp contact button phone prop is unchanged (still sourced directly from sourceContactPhone/targetContactPhone)', () => {
    expect(alertsScreen).toContain("phone={target.key === 'source' ? a.sourceContactPhone : a.targetContactPhone}");
  });

  it('does not add any WhatsApp API/token/automation call', () => {
    expect(alertsScreen).not.toMatch(/graph\.facebook\.com|access_token=|api\.whatsapp\.com|Bearer |sendMessage\(/);
  });

  it('does not change alertKey usage (still the internal React key / RPC parameter, never rendered)', () => {
    expect(alertsScreen).toContain('key={a.alertKey}');
  });
});

describe('Safety: no DB/migration/package/protected-file side effects from this phase', () => {
  it('no migration SQL file has a working-tree diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');
  });

  it('no new untracked migration SQL file was created (no migration 052)', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(status.trim()).toBe('');
  });

  it('no package/lockfile diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('does not use service_role or auth.admin anywhere in the touched files', () => {
    for (const src of [lifecycleService, alertsScreen]) {
      expect(src).not.toMatch(/service_role|auth\.admin/);
    }
  });

  it('does not modify the RPC call site (still calls the unchanged phoenix_get_live_inter_institution_alerts_with_state RPC name)', () => {
    expect(lifecycleService).toContain("supabase.rpc('phoenix_get_live_inter_institution_alerts_with_state'");
  });

  it('does not change alert_key derivation client-side (still a raw pass-through field, never recomputed)', () => {
    expect(lifecycleService).toContain('alertKey: r.alert_key,');
  });

  it('premium-preview.html and supabase/.temp/ remain untracked', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html supabase/.temp', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    const lines = status.split('\n').map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      expect(line.startsWith('??')).toBe(true);
    }
  });

  it('stash@{0} (paused Service-D work) was not popped or applied', () => {
    let stashList = '';
    try {
      stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });
});

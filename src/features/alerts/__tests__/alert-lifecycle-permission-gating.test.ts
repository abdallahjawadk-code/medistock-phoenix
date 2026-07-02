/**
 * FINAL-POLISH-PERMISSIONS-QR-A
 *
 * F-04 — the 4 active alert-lifecycle permission keys (migration 038) exist in
 *        the frontend catalog with role defaults mirroring the DB matrix, and
 *        the dormant inter_org_exchange.* keys (paused Service-D) do NOT.
 * F-03 — the alert lifecycle action buttons are gated by the user's effective
 *        permissions using the EXACT per-transition keys the server RPCs
 *        (migration 039) enforce — not just by lifecycleStatus.
 * F-06 — the anonymous public QR page never renders the raw useAsync error
 *        string; it shows the translated public-safe qr_public_load_error.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  PERMISSION_KEYS, PERMISSION_KEY_SET, isDangerousPermission,
  roleDefaults, effectivePermissions,
} from '@/shared/lib/permissions';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const screen  = readSrc('features/alerts/InterInstitutionAlertsScreen.tsx');
const publicQr = readSrc('features/qr/PublicQrScreen.tsx');
const strings = readSrc('shared/i18n/strings.ts');

const LIFECYCLE_KEYS = [
  'inter_institution_alerts.acknowledge',
  'inter_institution_alerts.manage',
  'inter_institution_alerts.resolve',
  'inter_institution_alerts.dismiss',
] as const;

// ============================================================================
// F-04: catalog
// ============================================================================
describe('F-04: alert-lifecycle permission keys in the frontend catalog', () => {
  it('contains all 4 active lifecycle keys', () => {
    LIFECYCLE_KEYS.forEach(key => expect(PERMISSION_KEY_SET.has(key)).toBe(true));
  });

  it('keys live in the inter_institution_alerts module with the correct action', () => {
    LIFECYCLE_KEYS.forEach(key => {
      const def = PERMISSION_KEYS.find(p => p.key === key);
      expect(def).toBeTruthy();
      expect(def!.module).toBe('inter_institution_alerts');
      expect(def!.action).toBe(key.split('.')[1]);
    });
  });

  it('dangerous flags mirror migration 038 (only dismiss is dangerous)', () => {
    expect(isDangerousPermission('inter_institution_alerts.dismiss')).toBe(true);
    expect(isDangerousPermission('inter_institution_alerts.acknowledge')).toBe(false);
    expect(isDangerousPermission('inter_institution_alerts.manage')).toBe(false);
    expect(isDangerousPermission('inter_institution_alerts.resolve')).toBe(false);
  });

  it('does NOT add any dormant inter_org_exchange key (Service-D stays paused)', () => {
    for (const key of PERMISSION_KEY_SET) {
      expect(key.startsWith('inter_org_exchange')).toBe(false);
    }
  });

  it('every lifecycle key has a bilingual label in strings.ts', () => {
    LIFECYCLE_KEYS.forEach(key => {
      const labelKey = `perm_inter_institution_alerts_${key.split('.')[1]}`;
      expect(strings).toContain(`${labelKey}:`);
    });
    // Bilingual content (from migration 038 label_ar/label_en)
    expect(strings).toContain('Acknowledge inter-institution alert');
    expect(strings).toContain('تأكيد الاطلاع على التنبيه بين المؤسسات');
    expect(strings).toContain('Dismiss inter-institution alert');
    expect(strings).toContain('تجاهل التنبيه بين المؤسسات');
  });
});

// ============================================================================
// F-04: role defaults mirror migration 038 role_permission_defaults
// ============================================================================
describe('F-04: role defaults mirror migration 038', () => {
  it('super_admin has all 4', () => {
    const d = roleDefaults('super_admin');
    LIFECYCLE_KEYS.forEach(key => expect(d.has(key)).toBe(true));
  });

  it('institution_admin and hospital_admin (legacy) have all 4', () => {
    for (const role of ['institution_admin', 'hospital_admin']) {
      const d = roleDefaults(role);
      LIFECYCLE_KEYS.forEach(key => expect(d.has(key)).toBe(true));
    }
  });

  it('warehouse_officer (and legacy warehouse_manager) has acknowledge/manage/resolve but NOT dismiss', () => {
    for (const role of ['warehouse_officer', 'warehouse_manager']) {
      const d = roleDefaults(role);
      expect(d.has('inter_institution_alerts.acknowledge')).toBe(true);
      expect(d.has('inter_institution_alerts.manage')).toBe(true);
      expect(d.has('inter_institution_alerts.resolve')).toBe(true);
      expect(d.has('inter_institution_alerts.dismiss')).toBe(false);
    }
  });

  it('port_officer (and legacy point_operator) has acknowledge only', () => {
    for (const role of ['port_officer', 'point_operator']) {
      const d = roleDefaults(role);
      expect(d.has('inter_institution_alerts.acknowledge')).toBe(true);
      expect(d.has('inter_institution_alerts.manage')).toBe(false);
      expect(d.has('inter_institution_alerts.resolve')).toBe(false);
      expect(d.has('inter_institution_alerts.dismiss')).toBe(false);
    }
  });

  it('monthly_status_officer (and legacy transfer_manager) has acknowledge only', () => {
    for (const role of ['monthly_status_officer', 'transfer_manager']) {
      const d = roleDefaults(role);
      expect(d.has('inter_institution_alerts.acknowledge')).toBe(true);
      expect(d.has('inter_institution_alerts.manage')).toBe(false);
      expect(d.has('inter_institution_alerts.resolve')).toBe(false);
      expect(d.has('inter_institution_alerts.dismiss')).toBe(false);
    }
  });

  it('viewer has none of the 4 lifecycle write keys', () => {
    const d = roleDefaults('viewer');
    LIFECYCLE_KEYS.forEach(key => expect(d.has(key)).toBe(false));
  });

  it('per-user overrides still work on the new keys (two-layer model unchanged)', () => {
    const granted = effectivePermissions('viewer', { 'inter_institution_alerts.acknowledge': true });
    expect(granted.has('inter_institution_alerts.acknowledge')).toBe(true);
    const denied = effectivePermissions('institution_admin', { 'inter_institution_alerts.dismiss': false });
    expect(denied.has('inter_institution_alerts.dismiss')).toBe(false);
  });
});

// ============================================================================
// F-03: alert lifecycle action buttons are permission-gated
// ============================================================================
describe('F-03: lifecycle action buttons gated by effective permissions', () => {
  it('screen reads myPermissions from useApp', () => {
    expect(screen).toMatch(/const \{ lang, myPermissions \} = useApp\(\)/);
  });

  it('defines the server-mirroring TRANSITION_PERMISSION map (migration 039 exact keys)', () => {
    expect(screen).toContain('TRANSITION_PERMISSION');
    expect(screen).toMatch(/open:\s*'inter_institution_alerts\.manage'/);         // reopen → manage
    expect(screen).toMatch(/acknowledged:\s*'inter_institution_alerts\.acknowledge'/);
    expect(screen).toMatch(/in_progress:\s*'inter_institution_alerts\.manage'/);  // start processing → manage
    expect(screen).toMatch(/resolved:\s*'inter_institution_alerts\.resolve'/);
    expect(screen).toMatch(/dismissed:\s*'inter_institution_alerts\.dismiss'/);
  });

  it('canTransition checks myPermissions', () => {
    expect(screen).toContain('myPermissions.has(TRANSITION_PERMISSION[to])');
  });

  it('every lifecycle ActionButton requires BOTH lifecycleStatus relevance AND canTransition', () => {
    expect(screen).toMatch(/a\.lifecycleStatus === 'open' && canTransition\('acknowledged'\)/);
    expect(screen).toMatch(/a\.lifecycleStatus === 'acknowledged' && canTransition\('in_progress'\)/);
    expect(screen).toMatch(/a\.lifecycleStatus === 'in_progress' && canTransition\('resolved'\)/);
    expect(screen).toMatch(/includes\(a\.lifecycleStatus\) && canTransition\('dismissed'\)/);
    expect(screen).toMatch(/includes\(a\.lifecycleStatus\) && canTransition\('open'\)/);
  });

  it('AlertCard receives canTransition from both call sites (flat list and grouped)', () => {
    const matches = screen.match(/canTransition=\{canTransition\}/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('view-history stays ungated (read path, view-permission enforced server-side)', () => {
    expect(screen).toMatch(/<ActionButton onClick=\{onHistory\}/);
    expect(screen).not.toMatch(/canTransition\([^)]*\) && <ActionButton onClick=\{onHistory\}/);
  });

  it('backend rejection handling is untouched (no fake success, translated errors kept)', () => {
    expect(screen).toContain('lifecycleErrorKey');
    expect(screen).toContain("if (!response.ok)");
    expect(screen).toContain('alertLifecycle_error_forbidden');
  });
});

// ============================================================================
// F-06: public QR page never renders raw internal error text
// ============================================================================
describe('F-06: public QR error is a translated public-safe message', () => {
  it('does not pass the raw useAsync error string to the error state', () => {
    expect(publicQr).not.toContain('message={error}');
  });

  it('uses the translated qr_public_load_error key', () => {
    expect(publicQr).toContain("t('qr_public_load_error', lang)");
  });

  it('retry stays available on the public error state', () => {
    expect(publicQr).toContain('onRetry={reload}');
  });

  it('qr_public_load_error exists bilingually and is public-safe', () => {
    expect(strings).toContain('qr_public_load_error:');
    expect(strings).toContain('Unable to load this QR code. It may be invalid or expired.');
    expect(strings).toContain('تعذر تحميل بيانات رمز QR. قد يكون الرمز غير صالح أو منتهي الصلاحية.');
  });

  it('no PostgREST/internal wording leaks into the public QR screen', () => {
    expect(publicQr).not.toMatch(/PGRST|postgrest|stack|SQLSTATE/i);
  });
});

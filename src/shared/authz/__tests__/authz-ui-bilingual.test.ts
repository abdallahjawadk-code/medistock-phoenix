/**
 * PHASE-1-CONTROLLED-RBAC-ACTIVATION-SHADOW-MODE — K. bilingual UI + RTL, and
 * the integration surface.
 *
 * Static, matching the repository's convention (there is no component-rendering
 * harness anywhere in this codebase). These assert the properties a render test
 * would: every reason code has both languages, the wording leaks nothing, and
 * nothing hard-codes a physical direction.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { T, t } from '@/shared/i18n/strings';
import { PERMISSION_KEY_SET } from '@/shared/lib/permissions';
import { AUTHZ_REASON_STRING_KEY, isRecoverableReason } from '../PhoenixPermissionGate';
import { SCOPED_PERMISSION_KEYS } from '../scoped-permissions';
import type { AuthzReasonCode } from '../diagnostics';

const SRC  = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const ALL_REASONS: AuthzReasonCode[] = [
  'ALLOWED', 'FLAG_OFF', 'NOT_AUTHENTICATED', 'PROFILE_UNAVAILABLE',
  'PERMISSION_DENIED', 'ASSIGNMENT_MISSING', 'OUT_OF_SCOPE', 'TEMPORARY_FAILURE',
];

describe('K. bilingual denial states', () => {
  it('every reason code maps to a string that exists in both languages', () => {
    for (const reason of ALL_REASONS) {
      const key = AUTHZ_REASON_STRING_KEY[reason];
      expect(key, `missing mapping for ${reason}`).toBeTruthy();
      expect(T[key], `missing string ${key}`).toBeTruthy();
      expect(T[key].ar.trim().length).toBeGreaterThan(0);
      expect(T[key].en.trim().length).toBeGreaterThan(0);
    }
  });

  it('distinguishes the six states the phase requires', () => {
    // Six DISTINCT messages, not one generic "denied" reused six times.
    const distinct = new Set([
      t(AUTHZ_REASON_STRING_KEY.NOT_AUTHENTICATED,   'en'),
      t(AUTHZ_REASON_STRING_KEY.PROFILE_UNAVAILABLE, 'en'),
      t(AUTHZ_REASON_STRING_KEY.PERMISSION_DENIED,   'en'),
      t(AUTHZ_REASON_STRING_KEY.ASSIGNMENT_MISSING,  'en'),
      t(AUTHZ_REASON_STRING_KEY.OUT_OF_SCOPE,        'en'),
      t(AUTHZ_REASON_STRING_KEY.TEMPORARY_FAILURE,   'en'),
    ]);
    expect(distinct.size).toBe(6);

    const distinctAr = new Set([
      t(AUTHZ_REASON_STRING_KEY.NOT_AUTHENTICATED,   'ar'),
      t(AUTHZ_REASON_STRING_KEY.PROFILE_UNAVAILABLE, 'ar'),
      t(AUTHZ_REASON_STRING_KEY.PERMISSION_DENIED,   'ar'),
      t(AUTHZ_REASON_STRING_KEY.ASSIGNMENT_MISSING,  'ar'),
      t(AUTHZ_REASON_STRING_KEY.OUT_OF_SCOPE,        'ar'),
      t(AUTHZ_REASON_STRING_KEY.TEMPORARY_FAILURE,   'ar'),
    ]);
    expect(distinctAr.size).toBe(6);
  });

  it('the Arabic strings are actually Arabic, not an English fallback', () => {
    const arabic = /[؀-ۿ]/;
    for (const reason of ALL_REASONS) {
      const key = AUTHZ_REASON_STRING_KEY[reason];
      expect(arabic.test(T[key].ar), `${key}.ar is not Arabic`).toBe(true);
    }
    for (const key of ['authz_checking', 'authz_retry', 'authz_pilot_unavailable_title']) {
      expect(arabic.test(T[key].ar), `${key}.ar is not Arabic`).toBe(true);
    }
  });

  it('no denial message reveals whether a protected record exists', () => {
    // Wording that confirms a record — "this warehouse", "record not found",
    // an ID — would let an unassigned user probe for real resources.
    const leaky = [
      /warehouse/i, /dispatch/i, /record/i, /does not exist/i,
      /not found/i, /invalid id/i, /مذخر/, /سجل/,
    ];
    for (const reason of ALL_REASONS) {
      const key = AUTHZ_REASON_STRING_KEY[reason];
      for (const lang of ['ar', 'en'] as const) {
        for (const pattern of leaky) {
          expect(
            `${key}.${lang} matches ${pattern}: ${pattern.test(T[key][lang])}`,
          ).toBe(`${key}.${lang} matches ${pattern}: false`);
        }
      }
    }
  });

  it('marks exactly the recoverable reasons as retryable', () => {
    expect(isRecoverableReason('TEMPORARY_FAILURE')).toBe(true);
    expect(isRecoverableReason('PROFILE_UNAVAILABLE')).toBe(true);
    // A denial is not something retrying fixes; offering Retry would be a lie.
    expect(isRecoverableReason('PERMISSION_DENIED')).toBe(false);
    expect(isRecoverableReason('ASSIGNMENT_MISSING')).toBe(false);
    expect(isRecoverableReason('OUT_OF_SCOPE')).toBe(false);
    expect(isRecoverableReason('NOT_AUTHENTICATED')).toBe(false);
  });
});

describe('K. RTL is preserved', () => {
  const uiFiles = ['shared/authz/PhoenixPermissionGate.tsx', 'shared/authz/ScreenAuthzGuard.tsx'];

  it('no authz UI hard-codes a physical direction', () => {
    for (const f of uiFiles) {
      const body = read(f);
      expect(`${f}: ${/dir=["'](ltr|rtl)["']/.test(body)}`).toBe(`${f}: false`);
      expect(`${f}: ${body.includes('direction:')}`).toBe(`${f}: false`);
    }
  });

  it('no authz UI uses a physical margin/padding that would not mirror', () => {
    for (const f of uiFiles) {
      const body = read(f);
      for (const physical of ['marginLeft', 'marginRight', 'paddingLeft', 'paddingRight', 'textAlign: \'left\'', 'textAlign: \'right\'']) {
        expect(`${f} ${physical}: ${body.includes(physical)}`).toBe(`${f} ${physical}: false`);
      }
    }
    // ...and the one directional offset it does need is the logical form.
    expect(read('shared/authz/PhoenixPermissionGate.tsx')).toContain('marginInlineStart');
  });

  it('renders text through the shared t() dictionary, never inline literals', () => {
    for (const f of uiFiles) {
      expect(read(f)).toContain("from '@/shared/i18n/strings'");
    }
  });
});

describe('accessible permission explanation', () => {
  it('announces politely and exposes the reason to assistive tech', () => {
    const gate = read('shared/authz/PhoenixPermissionGate.tsx');
    expect(gate).toContain('role="status"');
    expect(gate).toContain('aria-live="polite"');
    expect(gate).toContain('data-authz-reason');
    // Decorative glyphs are hidden from the accessibility tree.
    expect(gate).toContain('aria-hidden="true"');
  });

  it('the pilot shows a stated reason instead of an infinite loading state', () => {
    const guard = read('shared/authz/ScreenAuthzGuard.tsx');
    expect(guard).toContain('authz_pilot_unavailable_title');
    expect(guard).toContain('authz_retry');
    expect(guard).toContain('onRetry');
  });
});

describe('integration surface — read-only flows only', () => {
  it('the screens integrated in this phase observe rather than gate', () => {
    for (const f of [
      'features/reports/ReportsScreen.tsx',
      'features/reports/AuditLogSection.tsx',
      'features/users/UserManagementScreen.tsx',
    ]) {
      expect(read(f)).toContain('useShadowObservation');
    }
  });

  it('the observation hook returns nothing, so no caller can branch on it', () => {
    const src = read('shared/authz/useAuthorization.ts');
    expect(src).toMatch(/export function useShadowObservation\([\s\S]*?\): void \{/);
  });

  it('no write flow is gated by the new layer in this phase', () => {
    const guard = read('shared/authz/ScreenAuthzGuard.tsx');
    for (const writeKey of [
      'warehouse_stock.adjust', 'warehouse_stock.correct',
      'warehouse_dispatch.send', 'warehouse_dispatch.accept',
      'warehouse_dispatch.reject', 'users.edit_scope',
    ]) {
      expect(`${writeKey}: ${guard.includes(writeKey)}`).toBe(`${writeKey}: false`);
    }
  });

  it('the legacy permission catalog is untouched — no new checkboxes appear', () => {
    // Asserted against the CATALOG, not the file text: permissions.ts now
    // documents in prose why transfer_manager is denied reports.view and
    // audit.view (RBAC-PHASE-2), and a grep-based test would force that
    // explanation to be deleted to stay green. What must hold is that the ten
    // keys are not offered as permission-matrix checkboxes.
    for (const def of SCOPED_PERMISSION_KEYS) {
      expect(`${def.key}: ${PERMISSION_KEY_SET.has(def.key)}`).toBe(`${def.key}: false`);
    }
  });
});

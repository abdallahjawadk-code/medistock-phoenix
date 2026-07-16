/* ─── MEDISTOCK PHOENIX — Permission gate + explanation UI ────────────────────
   Renders the six authorization states the phase requires the UI to
   distinguish, bilingually and RTL-safe.

   RTL: nothing here sets a physical direction or a physical margin. Layout uses
   logical properties and inherits `dir` from <html> (AppContext sets it from
   `lang`), so Arabic mirrors without a second code path.
   ──────────────────────────────────────────────────────────────────────────── */

import type { ReactNode } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { useAuthzDecision } from './useAuthorization';
import type { AuthzReasonCode } from './diagnostics';
import type { AuthzScope } from './authorization';

/** Reason code → i18n key. Exhaustive: a new code will not typecheck without one. */
export const AUTHZ_REASON_STRING_KEY: Record<AuthzReasonCode, string> = {
  ALLOWED:             'authz_permission_denied', // unreachable in a denial UI
  FLAG_OFF:            'authz_permission_denied',
  NOT_AUTHENTICATED:   'authz_not_authenticated',
  PROFILE_UNAVAILABLE: 'authz_profile_unavailable',
  PERMISSION_DENIED:   'authz_permission_denied',
  ASSIGNMENT_MISSING:  'authz_assignment_missing',
  OUT_OF_SCOPE:        'authz_out_of_scope',
  TEMPORARY_FAILURE:   'authz_temporary_failure',
};

/** True when retrying could plausibly change the answer. */
export function isRecoverableReason(reason: AuthzReasonCode): boolean {
  return reason === 'TEMPORARY_FAILURE' || reason === 'PROFILE_UNAVAILABLE';
}

interface ExplanationProps {
  reason: AuthzReasonCode;
  onRetry?: () => void;
}

/**
 * The accessible permission explanation. `role="status"` (not "alert"): a
 * disabled button's reason is information, not an interruption, and an alert
 * would preempt whatever the screen-reader user was already reading.
 */
export function PhoenixPermissionExplanation({ reason, onRetry }: ExplanationProps) {
  const { lang } = useApp();
  const message = t(AUTHZ_REASON_STRING_KEY[reason], lang);
  const recoverable = isRecoverableReason(reason);

  return (
    <div
      role="status"
      aria-live="polite"
      data-authz-reason={reason}
      style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '10px 14px', borderRadius: 'var(--r2)',
        background: recoverable ? 'var(--warn2)' : 'var(--bg2)',
        border: `1px solid ${recoverable ? 'var(--warn)' : 'var(--brd)'}`,
        color: recoverable ? 'var(--warn)' : 'var(--t2)',
        fontSize: '12.5px',
      }}
    >
      <span aria-hidden="true">{recoverable ? '⚠️' : '🔒'}</span>
      <span>{message}</span>
      {recoverable && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginInlineStart: 'auto', padding: '4px 10px',
            borderRadius: 'var(--r2)', border: '1px solid currentColor',
            background: 'transparent', color: 'inherit',
            fontSize: '11.5px', fontWeight: 600, cursor: 'pointer',
          }}
        >
          {t('authz_retry', lang)}
        </button>
      )}
    </div>
  );
}

interface GateProps {
  permissionKey: string;
  scope?: AuthzScope;
  children: ReactNode;
  /**
   * What a denial renders.
   *   'hide'    — render nothing. For navigation targets that cannot be entered.
   *   'explain' — render the reason. For contextual actions where the user is
   *               entitled to know why the thing they can see is unavailable.
   */
  onDenied?: 'hide' | 'explain';
  /** Render this instead of the default loading affordance while pending. */
  fallback?: ReactNode;
}

/**
 * Gate a subtree on one permission.
 *
 * NOTE ON WHAT THIS IS: outside the super_admin pilot the decision it obeys is
 * the LEGACY one — the scoped engine runs alongside and is reported, never
 * enforced. This component is therefore safe to place on read-only surfaces
 * today; it changes production behavior for nobody until the flag says so.
 */
export function PhoenixPermissionGate({
  permissionKey, scope, children, onDenied = 'hide', fallback,
}: GateProps) {
  const { authz } = useApp();
  const explain = onDenied === 'explain';
  const state = useAuthzDecision(authz, permissionKey, scope, explain);

  if (state.pending) return <>{fallback ?? <PhoenixLoadingState />}</>;
  if (state.allowed) return <>{children}</>;
  if (onDenied === 'hide') return null;

  return <PhoenixPermissionExplanation reason={state.decision?.reason ?? 'PERMISSION_DENIED'} />;
}

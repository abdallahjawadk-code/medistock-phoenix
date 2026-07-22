/* ─── MEDISTOCK PHOENIX — Route guard (super_admin enforcement pilot) ─────────
   Screen-level authorization for the ONE mode that enforces:
   PHOENIX_SCOPED_RBAC_MODE=enforce_super_admin, role === 'super_admin'.

   For every other mode and every other role this component renders its children
   after running the scoped check purely as an observation. It is a no-op on
   production behavior until the flag says otherwise, by construction:
   `scopedEngineEnforcesRole` is the only thing that can turn it into a gate, and
   it returns true for exactly one (mode, role) pair.

   FAIL CLOSED, RECOVERABLY: if the pilot cannot establish a decision — the RPC
   is unreachable, the profile did not load — a protected screen does NOT open,
   and does NOT spin forever. It shows a stated reason and a retry.
   ──────────────────────────────────────────────────────────────────────────── */

import { useCallback, useState, type ReactNode } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { scopedEngineEnforcesRole } from './mode';
import { useAuthzDecision, useShadowObservation } from './useAuthorization';
import { AUTHZ_REASON_STRING_KEY, isRecoverableReason } from './PhoenixPermissionGate';
import type { AuthzReasonCode } from './diagnostics';

/**
 * The read-only permission key each existing screen answers to, for the pilot.
 * Screens absent from this map are not part of the pilot and are never gated.
 *
 * Only READ keys appear here. Stock adjustment, correction, dispatch decisions
 * and user-scope mutations are explicitly out of scope for this phase, so no
 * write key is listed — a screen cannot be enforced into blocking a write that
 * this phase never activated.
 */
export const SCREEN_PERMISSION_KEYS: Readonly<Record<number, string>> = {
  9:  'reports.view',
  14: 'users.view',
};

interface Props {
  screen: number;
  children: ReactNode;
}

export function ScreenAuthzGuard({ screen, children }: Props) {
  const { authz, role, activeOrgId, lang, scopedRbacMode, session, profile } = useApp();
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    authz.invalidate();
    setAttempt(a => a + 1);
  }, [authz]);

  const permissionKey = SCREEN_PERMISSION_KEYS[screen];
  const isPilotBuild = permissionKey !== undefined && scopedRbacMode === 'enforce_super_admin';

  // A session with no profile: we do not know who this is. Under the pilot a
  // protected screen must NOT open on that — and must not spin forever either.
  // This is the one place the guard acts without a role, and it acts by
  // refusing: the alternative is guessing, and the only guess that opens the
  // screen is "super_admin", which is exactly the escalation this phase forbids.
  if (isPilotBuild && session !== null && profile === null) {
    return (
      <AuthzUnavailable reason="PROFILE_UNAVAILABLE" lang={lang} onRetry={retry} />
    );
  }

  // The pilot's exact boundary. `role` here is AppContext's display role, whose
  // fallback is 'viewer' — it can never escalate anyone into the pilot, and the
  // profile-null case above is already handled.
  const enforcing = permissionKey !== undefined &&
    scopedEngineEnforcesRole(scopedRbacMode, role);

  return enforcing
    ? <EnforcedScreen
        key={attempt}
        permissionKey={permissionKey}
        orgId={activeOrgId}
        lang={lang}
        onRetry={retry}
      >
        {children}
      </EnforcedScreen>
    : <ObservedScreen permissionKey={permissionKey} orgId={activeOrgId}>{children}</ObservedScreen>;
}

/* Shadow path — renders children unconditionally, exactly as before the guard
   existed. The observation runs for comparison telemetry only. */
function ObservedScreen(
  { permissionKey, orgId, children }: { permissionKey?: string; orgId: string | null; children: ReactNode },
) {
  const { authz } = useApp();
  useShadowObservation(authz, permissionKey ?? 'reports.view', { organizationId: orgId });
  return <>{children}</>;
}

/* Pilot path — the scoped decision actually gates. */
function EnforcedScreen({
  permissionKey, orgId, lang, onRetry, children,
}: {
  permissionKey: string;
  orgId: string | null;
  lang: 'ar' | 'en';
  onRetry: () => void;
  children: ReactNode;
}) {
  const { authz } = useApp();
  const state = useAuthzDecision(authz, permissionKey, { organizationId: orgId }, true);

  if (state.pending) return <PhoenixLoadingState />;
  if (state.allowed) return <>{children}</>;

  return (
    <AuthzUnavailable
      reason={state.decision?.reason ?? 'PERMISSION_DENIED'}
      lang={lang}
      onRetry={onRetry}
    />
  );
}

/** The denied/unavailable screen. Always states a reason; never a dead end. */
function AuthzUnavailable({
  reason, lang, onRetry,
}: {
  reason: AuthzReasonCode;
  lang: 'ar' | 'en';
  onRetry: () => void;
}) {
  const recoverable = isRecoverableReason(reason);

  return (
    <div
      role="status"
      aria-live="polite"
      data-authz-reason={reason}
      style={{
        maxWidth: '520px', margin: '48px auto', padding: '24px',
        borderRadius: 'var(--r3)', border: '1px solid var(--brd)',
        background: 'var(--bg2)', textAlign: 'center',
      }}
    >
      <div style={{ marginBottom: '10px', color: recoverable ? 'var(--warn)' : 'var(--t2)' }} aria-hidden="true">
        <PhoenixIcon name={recoverable ? 'warning' : 'lock'} size={28} />
      </div>
      <div style={{ fontWeight: 700, marginBottom: '8px', color: 'var(--t1)' }}>
        {t('authz_pilot_unavailable_title', lang)}
      </div>
      <p style={{ fontSize: '13px', color: 'var(--t2)' }}>
        {t(AUTHZ_REASON_STRING_KEY[reason], lang)}
      </p>
      {recoverable && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginTop: '16px', padding: '8px 18px',
            borderRadius: 'var(--r2)', border: '1px solid var(--p)',
            background: 'transparent', color: 'var(--p)',
            fontSize: '12.5px', fontWeight: 600, cursor: 'pointer',
          }}
        >
          {t('authz_retry', lang)}
        </button>
      )}
    </div>
  );
}

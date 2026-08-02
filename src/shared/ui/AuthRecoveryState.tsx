import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from './PhoenixIcon';

/**
 * PHASE-B1-AUTH-RESILIENCE — the full-screen state shown when authentication
 * cannot complete.
 *
 * It exists so that the three unrecoverable-looking moments (the session read
 * failed, the profile read failed, no profile is readable) each end in a
 * STATED outcome with a way forward, instead of the permanent spinner they
 * used to share.
 *
 * Deliberate properties:
 *  • the message is generic and bilingual — no Supabase error, HTTP status or
 *    network detail is ever rendered; the technical cause stays in the console;
 *  • retry is always a manual, single attempt — this component schedules
 *    nothing and never retries on its own, so it cannot become a loop;
 *  • it never calls signIn or signOut by itself: sign-out is only offered when
 *    the caller supplies a handler, and only the operator can trigger it.
 */
interface Props {
  title: string;
  message: string;
  onRetry: () => void;
  /** Omitted for the pre-session boot failure — there is nothing to sign out of. */
  onSignOut?: () => void;
}

export function AuthRecoveryState({ title, message, onRetry, onSignOut }: Props) {
  const { lang } = useApp();

  return (
    <div className="nexus-state-screen">
      <div
        role="alert"
        data-phoenix-auth-recovery
        style={{
          maxWidth: '460px', margin: '0 auto', padding: '28px 24px',
          borderRadius: 'var(--r3)', border: '1px solid var(--brd)',
          background: 'var(--s)', textAlign: 'center',
        }}
      >
        <div style={{ marginBottom: '12px', color: 'var(--warn)', display: 'flex', justifyContent: 'center' }} aria-hidden="true">
          <PhoenixIcon name="warning" size={30} />
        </div>

        <h1 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '8px', color: 'var(--t)' }}>
          {title}
        </h1>
        <p dir="auto" style={{ fontSize: '13px', lineHeight: 1.6, color: 'var(--t2)', marginBottom: '20px' }}>
          {message}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <button
            type="button"
            onClick={onRetry}
            className="premium-focus-ring"
            style={{
              width: '100%', minHeight: 'var(--touch-target)', padding: '12px',
              borderRadius: 'var(--r2)', border: 'none',
              background: 'var(--phoenix-gold, var(--p))', color: 'var(--phoenix-gold-ink)',
              fontSize: '14px', fontWeight: 700, cursor: 'pointer',
            }}
          >
            {t('retry', lang)}
          </button>

          {onSignOut && (
            <button
              type="button"
              onClick={onSignOut}
              className="premium-focus-ring"
              style={{
                width: '100%', minHeight: 'var(--touch-target)', padding: '12px',
                borderRadius: 'var(--r2)',
                border: '1px solid color-mix(in srgb, var(--danger) 45%, var(--line))',
                background: 'transparent', color: 'var(--danger)',
                fontSize: '13.5px', fontWeight: 700, cursor: 'pointer',
              }}
            >
              {t('auth_sign_out', lang)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

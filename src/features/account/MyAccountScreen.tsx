import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { roleLabelKey } from '@/shared/lib/roles';
import { markPasswordChanged } from '@/shared/supabase/services/auth.service';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';

const fieldStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 'var(--r2)',
  border: '1px solid var(--brd)', background: 'var(--s)',
  color: 'var(--t)', fontSize: '12.5px',
} as const;

export function MyAccountScreen() {
  const { lang, profile, session, requestPasswordReset, updatePassword, reloadProfile } = useApp();

  const [toast, setToast]     = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);

  const [newPw, setNewPw]       = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [pwBusy, setPwBusy]     = useState(false);

  const isLocal = profile?.login_mode === 'local';
  const email = session?.user?.email ?? '';
  const pwMatch = newPw === confirmPw;
  const pwLong  = newPw.length >= 8;
  const canSubmitPw = pwLong && pwMatch;

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(null), 4000); }

  async function onRequestReset() {
    if (!email) return;
    setResetBusy(true);
    try {
      await requestPasswordReset(email);
      showToast(t('ma_reset_requested', lang));
    } catch {
      showToast(t('um_lifecycle_failed', lang));
    } finally {
      setResetBusy(false);
    }
  }

  async function onChangePassword() {
    if (!canSubmitPw) return;
    setPwBusy(true);
    try {
      const res = await updatePassword(newPw);
      if (res.ok) {
        if (profile?.must_change_password) {
          await markPasswordChanged();
          await reloadProfile();
        }
        showToast(t('ma_password_updated', lang));
        setNewPw('');
        setConfirmPw('');
      } else {
        showToast(res.error ?? t('um_lifecycle_failed', lang));
      }
    } catch {
      showToast(t('um_lifecycle_failed', lang));
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: '640px', animation: 'fs .3s ease' }}>
      <h2 style={{ fontSize: '22px', fontWeight: 700, marginBottom: '16px' }}>{t('ma_title', lang)}</h2>

      {/* Account info */}
      <PhoenixCard padding="18px" style={{ marginBottom: '16px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>{t('ma_info', lang)}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <InfoRow label={t('um_full_name', lang)} value={profile?.full_name ?? '—'} />
          {isLocal ? (
            <>
              <InfoRow label={t('ma_username', lang)} value={profile?.username ?? '—'} dir="ltr" />
              <InfoRow label={t('ma_contact_email', lang)} value={profile?.contact_email ?? '—'} dir="ltr" />
            </>
          ) : (
            <InfoRow label={t('ma_email', lang)} value={email || '—'} dir="ltr" />
          )}
          <InfoRow label={t('um_role', lang)} value={t(roleLabelKey(profile?.role), lang)} />
          <InfoRow label={t('ma_status', lang)}>
            <PhoenixStatusBadge
              variant={profile?.status === 'active' ? 'ok' : 'warn'}
              label={profile?.status === 'active' ? t('um_active', lang) : t('um_suspended', lang)}
            />
          </InfoRow>
        </div>
      </PhoenixCard>

      {/* Password reset: email link for email-mode accounts, admin-assisted note for local accounts */}
      {isLocal ? (
        <PhoenixCard padding="18px" style={{ marginBottom: '16px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '8px' }}>{t('ma_local_reset_title', lang)}</h3>
          <p style={{ fontSize: '12px', color: 'var(--t2)' }} dir="auto">
            {t('login_local_reset_note', lang)}
          </p>
        </PhoenixCard>
      ) : (
        <PhoenixCard padding="18px" style={{ marginBottom: '16px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '8px' }}>{t('ma_reset_title', lang)}</h3>
          <p style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '12px' }} dir="auto">
            {t('ma_reset_desc', lang)}
          </p>
          <PhoenixButton variant="ghost" size="md" loading={resetBusy} onClick={onRequestReset}>
            📧 {t('ma_reset_btn', lang)}
          </PhoenixButton>
        </PhoenixCard>
      )}

      {/* Direct password change */}
      <PhoenixCard padding="18px">
        <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '8px' }}>{t('ma_change_pw', lang)}</h3>
        <p style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '12px' }} dir="auto">
          {t('ma_change_pw_desc', lang)}
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('ma_new_pw', lang)}</label>
              <div style={{ position: 'relative' }}>
                <input type={showPw ? 'text' : 'password'} value={newPw} onChange={e => setNewPw(e.target.value)}
                  style={{ ...fieldStyle, paddingInlineEnd: '60px' }} autoComplete="new-password" dir="ltr" />
                <button type="button" onClick={() => setShowPw(s => !s)}
                  style={{ position: 'absolute', insetInlineEnd: '8px', top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', cursor: 'pointer', fontSize: '11px', color: 'var(--t2)' }}>
                  {showPw ? t('um_hide_password', lang) : t('um_show_password', lang)}
                </button>
              </div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('ma_confirm_pw', lang)}</label>
              <input type={showPw ? 'text' : 'password'} value={confirmPw} onChange={e => setConfirmPw(e.target.value)}
                style={{ ...fieldStyle, borderColor: confirmPw && !pwMatch ? 'var(--err)' : undefined }}
                autoComplete="new-password" dir="ltr" />
            </div>
          </div>
          {newPw && !pwLong && (
            <p style={{ fontSize: '11.5px', color: 'var(--warn)', margin: 0 }}>{t('ma_pw_min_length', lang)}</p>
          )}
          {confirmPw && !pwMatch && (
            <p style={{ fontSize: '11.5px', color: 'var(--err)', margin: 0 }}>{t('ma_pw_mismatch', lang)}</p>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <PhoenixButton variant="primary" size="md" loading={pwBusy} disabled={!canSubmitPw} onClick={onChangePassword}>
              {t('ma_change_pw', lang)}
            </PhoenixButton>
          </div>
        </div>
      </PhoenixCard>

      {/* Security note */}
      <div style={{ marginTop: '14px', fontSize: '11px', color: 'var(--t3)' }} dir="auto">
        {t('ma_security_note', lang)}
      </div>

      {toast && <PhoenixToast message={toast} />}
    </div>
  );
}

function InfoRow({ label, value, dir, children }: { label: string; value?: string; dir?: string; children?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
      <span style={{ fontSize: '12px', color: 'var(--t2)' }}>{label}</span>
      {children ?? <span style={{ fontSize: '12.5px', fontWeight: 600 }} dir={dir}>{value}</span>}
    </div>
  );
}

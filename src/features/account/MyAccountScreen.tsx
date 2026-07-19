import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { roleLabelKey } from '@/shared/lib/roles';
import { markPasswordChanged, updateMyWhatsappPhone, setMyOrgWhatsappContact } from '@/shared/supabase/services/auth.service';
import { normalizeWhatsappPhone, isValidWhatsappPhone } from '@/shared/lib/whatsapp';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';

const fieldStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 'var(--r2)',
  border: '1px solid var(--brd)', background: 'var(--s)',
  color: 'var(--t)', fontSize: '12.5px',
} as const;

// UX-OFFICIAL-ORG-WHATSAPP-CONTACT-TOGGLE-A: client-side eligibility check is
// a UX convenience only (hide/disable the action for obviously-ineligible
// profiles) — phoenix_set_my_org_whatsapp_contact (migration 046) re-checks
// role/status/organization_id server-side and is the final authority.
const ORG_CONTACT_ELIGIBLE_ROLES = ['institution_admin', 'hospital_admin', 'monthly_status_officer'];

export function MyAccountScreen() {
  const { lang, profile, session, requestPasswordReset, updatePassword, reloadProfile } = useApp();

  const [toast, setToast]     = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);

  const [newPw, setNewPw]       = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [pwBusy, setPwBusy]     = useState(false);

  // UX-MY-ACCOUNT-WHATSAPP-SAVE-A: real persistence to profiles.whatsapp_phone
  // (migration 044). Empty input is a valid "clear the number" state, not an
  // invalid one — only non-empty input is checked against isValidWhatsappPhone.
  const [waNumber, setWaNumber] = useState(() => profile?.whatsapp_phone ?? '');
  const [waBusy, setWaBusy]     = useState(false);
  const waValid = waNumber.trim() === '' || isValidWhatsappPhone(waNumber);

  // UX-OFFICIAL-ORG-WHATSAPP-CONTACT-TOGGLE-A
  const [orgContactBusy, setOrgContactBusy] = useState(false);
  const hasSavedWhatsapp = !!(profile?.whatsapp_phone && profile.whatsapp_phone.trim() !== '');
  const isOrgContactEligible =
    !!profile?.organization_id &&
    profile?.status === 'active' &&
    ORG_CONTACT_ELIGIBLE_ROLES.includes((profile?.role as string | undefined) ?? '');

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

  async function onSaveWhatsapp() {
    if (!waValid) return;
    const trimmed = waNumber.trim();
    const phoneToSave = trimmed === '' ? null : normalizeWhatsappPhone(trimmed);
    setWaBusy(true);
    try {
      // BUGFIX-MY-ACCOUNT-CLEAR-WHATSAPP-DISABLES-OFFICIAL-CONTACT-A: clearing
      // the personal number must not leave a stale official organization
      // contact behind (organization_status_contacts.phone would otherwise
      // still hold the just-deleted number). phoenix_set_my_org_whatsapp_contact
      // (migration 046) only checks role/org/status when DISABLING — never
      // profiles.whatsapp_phone — so it is always safe to call here, before
      // the phone itself is cleared. Best-effort: if the caller was never
      // eligible or never had a contact row, the RPC no-ops/raises harmlessly
      // and is ignored — the user's primary action (clearing their own
      // number) must not be blocked by it.
      if (phoneToSave === null) {
        await setMyOrgWhatsappContact(false).catch(() => undefined);
      }
      const res = await updateMyWhatsappPhone(phoneToSave);
      if (res.ok) {
        setWaNumber(phoneToSave ?? '');
        await reloadProfile();
        showToast(t('ma_whatsapp_save_success', lang));
      } else {
        showToast(t('ma_whatsapp_save_error', lang));
      }
    } catch {
      showToast(t('ma_whatsapp_save_error', lang));
    } finally {
      setWaBusy(false);
    }
  }

  async function onEnableOrgContact() {
    if (!isOrgContactEligible || !hasSavedWhatsapp || orgContactBusy) return;
    setOrgContactBusy(true);
    try {
      const res = await setMyOrgWhatsappContact(true);
      if (res.ok) {
        showToast(t('ma_org_contact_enable_success', lang));
      } else {
        showToast(t('ma_org_contact_error', lang));
      }
    } catch {
      showToast(t('ma_org_contact_error', lang));
    } finally {
      setOrgContactBusy(false);
    }
  }

  async function onDisableOrgContact() {
    if (!isOrgContactEligible || orgContactBusy) return;
    setOrgContactBusy(true);
    try {
      const res = await setMyOrgWhatsappContact(false);
      if (res.ok) {
        showToast(t('ma_org_contact_disable_success', lang));
      } else {
        showToast(t('ma_org_contact_error', lang));
      }
    } catch {
      showToast(t('ma_org_contact_error', lang));
    } finally {
      setOrgContactBusy(false);
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

      {/* Contact information — WhatsApp number (UX-MY-ACCOUNT-WHATSAPP-SAVE-A).
          Saves to the real profiles.whatsapp_phone column (migration 044).
          Empty input clears the number (saves NULL) — never treated as invalid.
          Never read by inter-institution alerts in this phase. */}
      <PhoenixCard padding="18px" style={{ marginBottom: '16px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '8px' }}>{t('ma_contact_info_title', lang)}</h3>
        <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>
          {t('ma_whatsapp_label', lang)}
        </label>
        <input
          type="tel"
          inputMode="tel"
          value={waNumber}
          onChange={e => setWaNumber(e.target.value)}
          placeholder="9647XXXXXXXXX"
          dir="ltr"
          style={{ ...fieldStyle, maxWidth: '100%', borderColor: waNumber.trim() && !waValid ? 'var(--err)' : undefined }}
        />
        <p style={{ fontSize: '11px', color: waNumber.trim() && !waValid ? 'var(--err)' : 'var(--t2)', margin: '6px 0 0' }} dir="auto">
          {t('ma_whatsapp_hint', lang)}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
          <PhoenixButton variant="primary" size="md" loading={waBusy} disabled={!waValid} onClick={onSaveWhatsapp}>
            {t('ma_whatsapp_save', lang)}
          </PhoenixButton>
        </div>
      </PhoenixCard>

      {/* Official organization WhatsApp contact (UX-OFFICIAL-ORG-WHATSAPP-CONTACT-TOGGLE-A).
          Publishes/withdraws the caller's OWN already-saved profiles.whatsapp_phone as
          organization_status_contacts.phone via phoenix_set_my_org_whatsapp_contact
          (migration 046, manually applied). Never sends a phone/profile/org id — the
          RPC resolves everything from auth.uid() and is the final eligibility authority.
          Two explicit actions (not a single toggle) because this screen has no reliable
          read model for whether the contact is currently active. */}
      <PhoenixCard padding="18px" style={{ marginBottom: '16px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '8px' }}>{t('ma_org_contact_title', lang)}</h3>
        {isOrgContactEligible ? (
          <>
            {!hasSavedWhatsapp && (
              <p style={{ fontSize: '11.5px', color: 'var(--warn)', margin: '0 0 10px' }} dir="auto">
                {t('ma_org_contact_phone_required', lang)}
              </p>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'flex-end' }}>
              <PhoenixButton variant="ghost" size="md" loading={orgContactBusy} disabled={orgContactBusy} onClick={onDisableOrgContact}>
                {t('ma_org_contact_disable', lang)}
              </PhoenixButton>
              <PhoenixButton variant="primary" size="md" loading={orgContactBusy} disabled={orgContactBusy || !hasSavedWhatsapp} onClick={onEnableOrgContact}>
                {t('ma_org_contact_enable', lang)}
              </PhoenixButton>
            </div>
          </>
        ) : (
          <p style={{ fontSize: '11.5px', color: 'var(--t2)', margin: 0 }} dir="auto">
            {t('ma_org_contact_ineligible', lang)}
          </p>
        )}
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
<PhoenixIcon name="mail" size={15} inline /> {t('ma_reset_btn', lang)}
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

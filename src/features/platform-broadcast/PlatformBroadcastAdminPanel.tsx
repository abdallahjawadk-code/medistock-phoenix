import { useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { normalizeRole } from '@/shared/lib/roles';
import { useAsync } from '@/shared/lib/useAsync';
import { getOrganizations, type OrgRow } from '@/shared/supabase/services/organizations.service';
import {
  createPlatformBroadcast, deactivatePlatformBroadcast, listPlatformBroadcastsAdmin,
  type BroadcastSeverity, type BroadcastTargetScope, type AdminBroadcast,
} from '@/shared/supabase/services/platform-broadcast.service';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';

const fieldStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 'var(--r2)',
  border: '1px solid var(--brd)', background: 'var(--s)',
  color: 'var(--t)', fontSize: '12.5px',
} as const;

const SEVERITY_BADGE: Record<BroadcastSeverity, 'info' | 'warn' | 'err'> = {
  info: 'info',
  warning: 'warn',
  important: 'warn',
  urgent: 'err',
};

interface Props {
  lang: 'ar' | 'en';
  role: string;
}

function messageStatus(m: AdminBroadcast): 'active' | 'inactive' | 'expired' {
  if (!m.is_active) return 'inactive';
  if (m.expires_at && new Date(m.expires_at).getTime() <= Date.now()) return 'expired';
  return 'active';
}

const STATUS_BADGE: Record<'active' | 'inactive' | 'expired', 'ok' | 'neutral' | 'err'> = {
  active: 'ok',
  inactive: 'neutral',
  expired: 'err',
};

/**
 * Super Admin-only broadcast management panel (migration 056,
 * PHASE3-PLATFORM-BROADCAST-NOTICES-A). Mounted in UserManagementScreen.tsx
 * alongside the existing AvailabilityCleanupWizard — the established home
 * for Super Admin maintenance tools in this app. Renders null for any
 * non-super_admin role; the real authorization boundary is the server-side
 * super_admin check inside each RPC, not this frontend gate.
 */
export function PlatformBroadcastAdminPanel({ lang, role }: Props) {
  const isSuper = normalizeRole(role) === 'super_admin';

  const orgs = useAsync(() => isSuper ? getOrganizations() : Promise.resolve([]), [isSuper]);
  const list = useAsync(() => isSuper ? listPlatformBroadcastsAdmin() : Promise.resolve({ ok: true as const, messages: [] }), [isSuper]);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<BroadcastSeverity>('info');
  const [targetScope, setTargetScope] = useState<BroadcastTargetScope>('all');
  const [selectedOrgIds, setSelectedOrgIds] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState(false);
  const [deactivateBusyId, setDeactivateBusyId] = useState<string | null>(null);

  if (!isSuper) return null;

  function toggleOrg(id: string) {
    setSelectedOrgIds(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  }

  async function onCreate() {
    setValidationError(null);
    setCreateError(null);
    setCreateSuccess(false);

    if (title.trim() === '') {
      setValidationError(t('pbc_validation_title_required', lang));
      return;
    }
    if (body.trim() === '') {
      setValidationError(t('pbc_validation_body_required', lang));
      return;
    }
    if (targetScope === 'selected' && selectedOrgIds.length === 0) {
      setValidationError(t('pbc_validation_orgs_required', lang));
      return;
    }

    setCreateBusy(true);
    try {
      const res = await createPlatformBroadcast({
        title: title.trim(),
        body: body.trim(),
        severity,
        targetScope,
        orgIds: targetScope === 'selected' ? selectedOrgIds : undefined,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      if (!res.ok) {
        setCreateError(res.error);
        return;
      }
      setCreateSuccess(true);
      setTitle('');
      setBody('');
      setSeverity('info');
      setTargetScope('all');
      setSelectedOrgIds([]);
      setExpiresAt('');
      list.reload();
    } catch (err) {
      console.error('[phoenix] createPlatformBroadcast failed:', err);
      setCreateError('NETWORK_ERROR');
    } finally {
      setCreateBusy(false);
    }
  }

  async function onDeactivate(messageId: string) {
    if (!window.confirm(t('pbc_deactivate_confirm', lang))) return;
    setDeactivateBusyId(messageId);
    try {
      const res = await deactivatePlatformBroadcast(messageId);
      if (res.ok) list.reload();
    } catch (err) {
      console.error('[phoenix] deactivatePlatformBroadcast failed:', err);
    } finally {
      setDeactivateBusyId(null);
    }
  }

  const orgList: OrgRow[] = orgs.data ?? [];
  const messages: AdminBroadcast[] = (list.data && list.data.ok) ? list.data.messages : [];

  return (
    <PhoenixCard padding="18px" style={{ marginTop: '20px' }}>
      <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '4px' }}>{t('pbc_admin_title', lang)}</h3>
      <p style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '14px' }} dir="auto">
        {t('pbc_admin_subtitle', lang)}
      </p>

      <div style={{ paddingBottom: '14px', marginBottom: '14px', borderBottom: '1px solid var(--brd)' }}>
        <div style={{ fontSize: '12.5px', fontWeight: 700, marginBottom: '10px' }}>{t('pbc_create_title', lang)}</div>

        <div style={{ marginBottom: '10px' }}>
          <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('pbc_field_title', lang)}</label>
          <input type="text" value={title} onChange={e => setTitle(e.target.value)} style={fieldStyle} dir="auto" />
        </div>

        <div style={{ marginBottom: '10px' }}>
          <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('pbc_field_body', lang)}</label>
          <textarea value={body} onChange={e => setBody(e.target.value)} style={{ ...fieldStyle, minHeight: '80px', resize: 'vertical' }} dir="auto" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('pbc_field_severity', lang)}</label>
            <select value={severity} onChange={e => setSeverity(e.target.value as BroadcastSeverity)} style={fieldStyle}>
              <option value="info">{t('pbc_severity_info', lang)}</option>
              <option value="warning">{t('pbc_severity_warning', lang)}</option>
              <option value="important">{t('pbc_severity_important', lang)}</option>
              <option value="urgent">{t('pbc_severity_urgent', lang)}</option>
            </select>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('pbc_field_target_scope', lang)}</label>
            <select value={targetScope} onChange={e => setTargetScope(e.target.value as BroadcastTargetScope)} style={fieldStyle}>
              <option value="all">{t('pbc_target_all', lang)}</option>
              <option value="selected">{t('pbc_target_selected', lang)}</option>
            </select>
          </div>
        </div>

        {targetScope === 'selected' && (
          <div style={{ marginBottom: '10px' }}>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('pbc_select_orgs_placeholder', lang)}</label>
            <div style={{ maxHeight: '160px', overflowY: 'auto', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '8px' }}>
              {orgList.map(org => (
                <label key={org.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', padding: '4px 0', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={selectedOrgIds.includes(org.id)}
                    onChange={() => toggleOrg(org.id)}
                  />
                  <span dir="auto">{lang === 'ar' ? org.name_ar : org.name}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginBottom: '14px' }}>
          <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('pbc_field_expires_at', lang)}</label>
          <input type="datetime-local" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} style={fieldStyle} />
        </div>

        {validationError && (
          <p style={{ fontSize: '12px', color: 'var(--err)', marginBottom: '10px' }} dir="auto">{validationError}</p>
        )}
        {createError && (
          <p style={{ fontSize: '12px', color: 'var(--err)', marginBottom: '10px' }} dir="auto">{t('pbc_create_failed', lang)}</p>
        )}
        {createSuccess && (
          <p style={{ fontSize: '12px', color: 'var(--ok)', marginBottom: '10px' }} dir="auto">{t('pbc_create_success', lang)}</p>
        )}

        <PhoenixButton variant="primary" size="md" loading={createBusy} onClick={onCreate}>
          {t('pbc_create_button', lang)}
        </PhoenixButton>
      </div>

      <div>
        <div style={{ fontSize: '12.5px', fontWeight: 700, marginBottom: '10px' }}>{t('pbc_list_title', lang)}</div>

        {list.loading && <PhoenixLoadingState label={t('pbc_list_loading', lang)} />}
        {list.error && <PhoenixErrorState message={t('pbc_list_load_failed', lang)} onRetry={list.reload} />}
        {!list.loading && !list.error && messages.length === 0 && (
          <PhoenixEmptyState title={t('pbc_list_empty', lang)} />
        )}

        {!list.loading && !list.error && messages.map(m => {
          const status = messageStatus(m);
          return (
            <div key={m.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--brd)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                <PhoenixStatusBadge variant={SEVERITY_BADGE[m.severity]} label={t(`pbc_severity_${m.severity}`, lang)} />
                <PhoenixStatusBadge variant={STATUS_BADGE[status]} label={t(`pbc_status_${status}`, lang)} />
                <span style={{ fontSize: '13px', fontWeight: 600 }} dir="auto">{m.title}</span>
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginBottom: '6px' }}>
                {t('pbc_ack_summary', lang)}: {m.acknowledged_count}/{m.target_count}
              </div>
              {status === 'active' && (
                <PhoenixButton variant="danger" size="sm" loading={deactivateBusyId === m.id} onClick={() => onDeactivate(m.id)}>
                  {t('pbc_deactivate_button', lang)}
                </PhoenixButton>
              )}
            </div>
          );
        })}
      </div>
    </PhoenixCard>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import {
  upsertInventoryThreshold,
  type InventoryScopeKind,
  type InventoryThreshold,
} from './inventory-intelligence.service';
import { useExactThresholdPermission, useInventoryScopes } from './useInventoryScopes';

/**
 * Create/update an inventory threshold for a REAL scope the caller may manage.
 *
 * Round 2 corrections:
 *   • near_expiry_days is NOT editable — the near-expiry window is a fixed
 *     270-day policy. The modal always sends 270 (never NULL, never a
 *     user-supplied value) and shows the tier policy as read-only text. A DB
 *     migration to pin 270 server-side will follow separately.
 *   • A real scope selector: pick warehouse|outlet, then the named scope from
 *     the RLS-filtered catalog (no raw UUID shown). The real scope_kind +
 *     scope_id go to the RPC. The org-wide default row is offered ONLY when the
 *     caller holds org-level inventory.manage_thresholds. The upsert RPC + RLS
 *     remain the final authority — UI options are never trusted alone.
 */
interface Props {
  open: boolean;
  organizationId: string;
  organizationLabel?: string | null;
  /** Existing row to edit. Its identity tuple remains immutable. */
  editing?: InventoryThreshold | null;
  onCancel: () => void;
  onSaved: () => void;
}

/** The fixed 270-day near-expiry window sent on every write (never editable). */
export const FIXED_NEAR_EXPIRY_DAYS = 270;

type ApplyTo = 'scope' | 'org_default';

function numOrNull(v: string): number | null {
  const s = v.trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : null;
}

export function InventoryThresholdModal({ open, organizationId, organizationLabel, editing = null, onCancel, onSaved }: Props) {
  const { lang } = useApp();

  const scopes = useInventoryScopes(organizationId);

  const [scopeKind, setScopeKind] = useState<InventoryScopeKind>('warehouse');
  const [applyTo, setApplyTo] = useState<ApplyTo>('scope');
  const [scopeId, setScopeId] = useState<string>('');
  const [scientificName, setScientificName] = useState('');
  const [nationalCode, setNationalCode] = useState('');
  const [reorderPoint, setReorderPoint] = useState('');
  const [targetMax, setTargetMax] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options = scopeKind === 'warehouse'
    ? (scopes.data?.manageableWarehouses ?? [])
    : (scopes.data?.manageableOutlets ?? []);
  const selectedScope = options.find(o => o.id === scopeId) ?? null;
  const identityLocked = editing !== null;
  const orgPermission = useExactThresholdPermission(organizationId, null, null, open);
  const selectedPermission = useExactThresholdPermission(
    organizationId,
    scopeKind,
    selectedScope?.id ?? null,
    open && selectedScope !== null,
  );
  const canOrgDefault = orgPermission.data === true;

  const reorderNum = numOrNull(reorderPoint);
  const targetNum = numOrNull(targetMax);
  const nameOk = scientificName.trim() !== '';
  const bothPresent = reorderNum !== null && targetNum !== null;
  const bandOk = bothPresent && reorderNum >= 0 && reorderNum < targetNum;
  const effectiveApplyTo: ApplyTo = editing
    ? (editing.scopeId === null ? 'org_default' : 'scope')
    : canOrgDefault ? applyTo : 'scope';
  const scopeChosen = effectiveApplyTo === 'org_default' ? canOrgDefault : selectedScope !== null;
  const scopeAuthorized = effectiveApplyTo === 'org_default'
    ? orgPermission.data === true
    : selectedPermission.data === true;
  const permissionPending = effectiveApplyTo === 'org_default' ? orgPermission.loading : selectedPermission.loading;
  const canSave = nameOk && bandOk && scopeChosen && scopeAuthorized && !permissionPending && !scopes.loading && !scopes.error && !busy;

  useEffect(() => {
    if (!open) return;
    if (editing && editing.organizationId === organizationId) {
      setScopeKind(editing.scopeKind);
      setApplyTo(editing.scopeId === null ? 'org_default' : 'scope');
      setScopeId(editing.scopeId ?? '');
      setScientificName(editing.scientificName);
      setNationalCode(editing.nationalCode ?? '');
      setReorderPoint(editing.reorderPoint?.toString() ?? '');
      setTargetMax(editing.targetMax?.toString() ?? '');
      setIsActive(editing.isActive);
    } else {
      // New organization/new row: never retain a scope id from the previous
      // organization or a previously closed dialog.
      setScopeKind('warehouse');
      setApplyTo('scope');
      setScopeId('');
      setScientificName('');
      setNationalCode('');
      setReorderPoint('');
      setTargetMax('');
      setIsActive(true);
    }
    setBusy(false);
    setError(null);
  }, [open, organizationId, editing]);

  const bandError = useMemo(() => {
    if (reorderPoint === '' || targetMax === '') return bothPresent ? undefined : t('inv_th_both_required', lang);
    if (!bothPresent) return t('inv_th_both_required', lang);
    if (!bandOk) return t('inv_th_band_invalid', lang);
    return undefined;
  }, [reorderPoint, targetMax, bothPresent, bandOk, lang]);

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const res = await upsertInventoryThreshold({
      organizationId,
      // In edit mode the identity tuple comes from the existing row rather
      // than mutable form state. Changing identity means creating a new row.
      scopeKind: editing?.scopeKind ?? scopeKind,
      scopeId: editing ? editing.scopeId : effectiveApplyTo === 'org_default' ? null : selectedScope!.id,
      scientificName: editing?.scientificName ?? scientificName.trim(),
      nationalCode: editing ? editing.nationalCode : (nationalCode.trim() || null),
      reorderPoint: reorderNum,
      targetMax: targetNum,
      nearExpiryDays: FIXED_NEAR_EXPIRY_DAYS, // fixed policy — never user-supplied, never NULL
      isActive,
    });
    setBusy(false);
    if (!res.ok) { setError(res.error ?? 'error'); return; }
    onSaved();
  }

  return (
    <PhoenixDialog open={open} onClose={onCancel} title={t(editing ? 'inv_threshold_edit' : 'inv_threshold_add', lang)} maxWidth={520}>
      {/* Organization context (name first, per UX spec) */}
      <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginBottom: '12px' }} dir="auto">
        {t('inv_org_label', lang)}: <strong>{organizationLabel || t('inv_org_loading', lang)}</strong>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {/* Scope kind */}
        <PhoenixSelect
          label={t('inv_th_scope', lang)}
          value={scopeKind}
          onChange={e => { setScopeKind(e.target.value as InventoryScopeKind); setScopeId(''); }}
          disabled={identityLocked}
          options={[
            { value: 'warehouse', label: t('inv_scope_warehouse', lang) },
            { value: 'outlet', label: t('inv_scope_outlet', lang) },
          ]}
        />

        {/* Apply-to: specific scope vs org-default (org-default only if org-level authz) */}
        <PhoenixSelect
          label={t('inv_th_apply_to', lang)}
          value={effectiveApplyTo}
          onChange={e => setApplyTo(e.target.value as ApplyTo)}
          disabled={identityLocked || !canOrgDefault}
          options={
            canOrgDefault
              ? [
                  { value: 'scope', label: t('inv_th_specific_scope', lang) },
                  { value: 'org_default', label: t('inv_th_org_default', lang) },
                ]
              : [{ value: 'scope', label: t('inv_th_specific_scope', lang) }]
          }
        />

        {/* Named scope picker (RLS-filtered; no UUID shown) */}
        {effectiveApplyTo === 'scope' && (
          <div>
            {scopes.loading && <PhoenixLoadingState label={t('inv_th_loading_scopes', lang)} />}
            {!scopes.loading && scopes.error && (
              <PhoenixErrorState title={t('load_error', lang)} message={scopes.error} onRetry={scopes.reload} />
            )}
            {!scopes.loading && !scopes.error && options.length === 0 && (
              <div style={{ fontSize: '12px', color: 'var(--t2)', padding: '10px 12px', borderRadius: 'var(--r2)', border: '1px dashed var(--brd)' }} dir="auto">
                {t('inv_th_no_scopes', lang)}
              </div>
            )}
            {!scopes.loading && !scopes.error && options.length > 0 && (
              <>
                <PhoenixSelect
                  label={t('inv_th_select_scope', lang)}
                  value={scopeId}
                  onChange={e => setScopeId(e.target.value)}
                  disabled={identityLocked}
                  error={scopeId !== '' && selectedScope === null ? t('inv_th_scope_invalid', lang) : scopeId === '' ? t('inv_th_scope_required', lang) : undefined}
                  options={[
                    { value: '', label: t('inv_th_select_placeholder', lang) },
                    ...options.map(o => ({ value: o.id, label: lang === 'ar' ? (o.nameAr || o.name) : (o.name || o.nameAr) })),
                  ]}
                />
                {selectedScope && !selectedPermission.loading && selectedPermission.data !== true && (
                  <div role="alert" style={{ fontSize: '11.5px', color: 'var(--err)', marginTop: '6px' }} dir="auto">
                    {t('inv_th_denied', lang)}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <PhoenixInput
          label={t('inv_th_scientific_name', lang)}
          value={scientificName}
          onChange={e => setScientificName(e.target.value)}
          disabled={identityLocked}
          dir="auto"
        />
        <PhoenixInput
          label={t('inv_th_national_code', lang)}
          value={nationalCode}
          onChange={e => setNationalCode(e.target.value)}
          disabled={identityLocked}
        />

        {identityLocked && (
          <div role="note" style={{ fontSize: '10.5px', color: 'var(--t2)' }} dir="auto">
            {t('inv_th_identity_locked', lang)}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div>
            <PhoenixInput
              label={t('inv_th_reorder_point', lang)}
              type="number" min={0} inputMode="numeric"
              value={reorderPoint}
              onChange={e => setReorderPoint(e.target.value)}
            />
            <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '4px' }} dir="auto">{t('inv_th_reorder_hint', lang)}</div>
          </div>
          <div>
            <PhoenixInput
              label={t('inv_th_target_max', lang)}
              type="number" min={0} inputMode="numeric"
              value={targetMax}
              onChange={e => setTargetMax(e.target.value)}
            />
            <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '4px' }} dir="auto">{t('inv_th_target_hint', lang)}</div>
          </div>
        </div>
        {bandError && (
          <div role="alert" style={{ fontSize: '11.5px', color: 'var(--err)' }} dir="auto">{bandError}</div>
        )}

        {/* Availability + signal semantics explanation */}
        <div style={{ fontSize: '11px', color: 'var(--t2)', background: 'var(--s)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '8px 10px', lineHeight: 1.6 }} dir="auto">
          <div>{t('inv_available_explain', lang)}</div>
          <div>• {t('inv_signal_rules_missing', lang)}</div>
        </div>

        {/* Fixed near-expiry policy — read-only, NO input field */}
        <div style={{ fontSize: '11px', color: 'var(--t2)', background: 'var(--info2)', border: '1px solid var(--info)', borderRadius: 'var(--r2)', padding: '8px 10px', lineHeight: 1.7 }} dir="auto">
          <div style={{ fontWeight: 700, color: 'var(--info)' }}>{t('inv_near_policy_title', lang)}</div>
          <div>{t('inv_near_policy_window', lang)}</div>
          <div>• {t('inv_near_policy_expired', lang)}</div>
          <div>• {t('inv_near_policy_critical', lang)}</div>
          <div>• {t('inv_near_policy_warning', lang)}</div>
          <div>• {t('inv_near_policy_watch', lang)}</div>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', cursor: 'pointer' }}>
          <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
          {t('inv_th_active', lang)}
        </label>

        {error && (
          <div role="alert" style={{ fontSize: '12px', color: 'var(--err)', background: 'var(--err2)', border: '1px solid var(--err)', borderRadius: 'var(--r2)', padding: '8px 10px' }} dir="auto">
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '4px' }}>
          <PhoenixButton variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {t('inv_cancel', lang)}
          </PhoenixButton>
          <PhoenixButton variant="primary" size="sm" loading={busy} disabled={!canSave} onClick={save}>
            {t('inv_confirm', lang)}
          </PhoenixButton>
        </div>
      </div>
    </PhoenixDialog>
  );
}

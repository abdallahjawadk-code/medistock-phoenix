import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import {
  upsertInventoryThreshold,
  type InventoryScopeKind,
  type InventoryThreshold,
} from './inventory-intelligence.service';

/**
 * Create/update an ORGANIZATION-DEFAULT inventory threshold (scope_id NULL).
 * Gated by the parent on inventory.manage_thresholds; the RPC re-checks the
 * org-level manage permission server-side. Per-warehouse/outlet threshold
 * editing (a scope picker) is intentionally out of scope for this PR.
 */
interface Props {
  open: boolean;
  organizationId: string;
  /** Optional row to prefill (edit an existing org-default threshold). */
  editing?: InventoryThreshold | null;
  onCancel: () => void;
  onSaved: () => void;
}

function numOrNull(v: string): number | null {
  const s = v.trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function InventoryThresholdModal({ open, organizationId, editing, onCancel, onSaved }: Props) {
  const { lang } = useApp();
  const [scopeKind, setScopeKind] = useState<InventoryScopeKind>(editing?.scopeKind ?? 'warehouse');
  const [scientificName, setScientificName] = useState(editing?.scientificName ?? '');
  const [nationalCode, setNationalCode] = useState(editing?.nationalCode ?? '');
  const [reorderPoint, setReorderPoint] = useState(editing?.reorderPoint?.toString() ?? '');
  const [targetMax, setTargetMax] = useState(editing?.targetMax?.toString() ?? '');
  const [nearExpiryDays, setNearExpiryDays] = useState(editing?.nearExpiryDays?.toString() ?? '');
  const [isActive, setIsActive] = useState(editing?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameOk = scientificName.trim() !== '';

  async function save() {
    if (!nameOk) return;
    setBusy(true);
    setError(null);
    const res = await upsertInventoryThreshold({
      organizationId,
      scopeKind,
      scopeId: null, // org-wide default row
      scientificName: scientificName.trim(),
      nationalCode: nationalCode.trim() || null,
      reorderPoint: numOrNull(reorderPoint),
      targetMax: numOrNull(targetMax),
      nearExpiryDays: numOrNull(nearExpiryDays),
      isActive,
    });
    setBusy(false);
    if (!res.ok) { setError(res.error ?? 'error'); return; }
    onSaved();
  }

  return (
    <PhoenixDialog open={open} onClose={onCancel} title={t('inv_threshold_add', lang)} maxWidth={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ fontSize: '11.5px', color: 'var(--t2)' }}>{t('inv_th_org_default', lang)}</div>

        <PhoenixSelect
          label={t('inv_th_scope', lang)}
          value={scopeKind}
          onChange={e => setScopeKind(e.target.value as InventoryScopeKind)}
          options={[
            { value: 'warehouse', label: t('inv_scope_warehouse', lang) },
            { value: 'outlet', label: t('inv_scope_outlet', lang) },
          ]}
        />

        <PhoenixInput
          label={t('inv_th_scientific_name', lang)}
          value={scientificName}
          onChange={e => setScientificName(e.target.value)}
          dir="auto"
          error={!nameOk && scientificName !== '' ? t('inv_reason_required', lang) : undefined}
        />
        <PhoenixInput
          label={t('inv_th_national_code', lang)}
          value={nationalCode}
          onChange={e => setNationalCode(e.target.value)}
        />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <PhoenixInput
            label={t('inv_th_reorder_point', lang)}
            type="number" min={0} inputMode="numeric"
            value={reorderPoint}
            onChange={e => setReorderPoint(e.target.value)}
          />
          <PhoenixInput
            label={t('inv_th_target_max', lang)}
            type="number" min={0} inputMode="numeric"
            value={targetMax}
            onChange={e => setTargetMax(e.target.value)}
          />
        </div>
        <PhoenixInput
          label={t('inv_th_near_expiry_days', lang)}
          type="number" min={1} max={270} inputMode="numeric"
          value={nearExpiryDays}
          onChange={e => setNearExpiryDays(e.target.value)}
        />
        <div style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '-6px' }}>{t('inv_th_near_expiry_hint', lang)}</div>

        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', cursor: 'pointer' }}>
          <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
          {t('inv_th_active', lang)}
        </label>

        {error && (
          <div role="alert" style={{ fontSize: '12px', color: 'var(--err)', background: 'var(--err2)', border: '1px solid var(--err)', borderRadius: 'var(--r2)', padding: '8px 10px' }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '6px' }}>
          <PhoenixButton variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            {t('inv_cancel', lang)}
          </PhoenixButton>
          <PhoenixButton variant="primary" size="sm" loading={busy} disabled={!nameOk || busy} onClick={save}>
            {t('inv_confirm', lang)}
          </PhoenixButton>
        </div>
      </div>
    </PhoenixDialog>
  );
}

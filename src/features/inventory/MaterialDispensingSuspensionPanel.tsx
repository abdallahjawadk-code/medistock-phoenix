import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixMaterialResolver } from '@/shared/materials/PhoenixMaterialResolver';
import type { ResolvedMaterial } from '@/shared/materials/material-resolver.service';
import {
  getMaterialDispensingSuspensions, suspendMaterialDispensing, liftMaterialDispensingSuspension,
  type MaterialDispensingSuspensionRow, type SuspensionReasonCode,
} from './material-dispensing-suspension.service';
import { useMaterialDispensingSuspensionPermission } from './useMaterialDispensingSuspensionPermission';

const newRequestId = () =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const REASON_CODES: SuspensionReasonCode[] = [
  'regulatory_hold', 'recall_investigation', 'clinical_safety_concern',
  'quality_investigation', 'license_or_permit_issue', 'supply_integrity_concern', 'other',
];

interface Props {
  organizationId: string;
}

/**
 * MATERIAL-DISPENSING-SUSPENSION panel — views every موقوف الصرف record for
 * an organization and suspends/lifts via migration 203's RPCs.
 *
 * Deliberately a SEPARATE panel from QuarantinePanel, not a mode of it — the
 * two domains never share a row, a badge, or a translated string. Scope is
 * org-wide only in this first pass (p_distribution_point_id always null):
 * the server (203-207) already enforces point-scoped suspensions correctly,
 * this panel just doesn't yet offer an outlet picker to create one.
 */
export function MaterialDispensingSuspensionPanel({ organizationId }: Props) {
  const { lang, dir } = useApp();
  const perm = useMaterialDispensingSuspensionPermission(organizationId, null);
  const [rows, setRows] = useState<MaterialDispensingSuspensionRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const reload = useCallback(async () => {
    if (!organizationId) { setRows([]); return; }
    setLoading(true);
    setError(null);
    try {
      setRows(await getMaterialDispensingSuspensions(organizationId));
    } catch {
      setError(t('err_generic', lang));
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, [organizationId, lang]);

  useEffect(() => { void reload(); }, [reload]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  const canViewDetail = perm.data?.canViewDetail ?? false;
  const canSuspend = perm.data?.canSuspend ?? false;
  const canLift = perm.data?.canLift ?? false;

  if (!canViewDetail && !perm.loading) {
    return <PhoenixEmptyState icon="🚫" title={t('e_forbidden_material_dispensing_suspension_view_badge', lang)} description="" />;
  }
  if (loading && rows === null) return <PhoenixLoadingState />;
  if (error) return <PhoenixErrorState title={t('err_generic', lang)} message={error} onRetry={reload} />;

  const active = (rows ?? []).filter(r => !r.liftedAt);
  const history = (rows ?? []).filter(r => r.liftedAt);

  return (
    <div dir={dir} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {toast && <div style={{ fontSize: '12px', color: 'var(--ok)' }}>{toast}</div>}

      {canSuspend && !composing && (
        <div>
          <PhoenixButton onClick={() => setComposing(true)}>{t('mds_suspend_action', lang)}</PhoenixButton>
        </div>
      )}

      {composing && (
        <SuspendForm
          lang={lang}
          organizationId={organizationId}
          onCancel={() => setComposing(false)}
          onDone={(msg) => { setComposing(false); showToast(msg); void reload(); }}
          onError={showToast}
        />
      )}

      {active.length === 0 && history.length === 0 ? (
        <PhoenixEmptyState icon="⛔" title={t('mds_history_empty', lang)} description="" />
      ) : (
        <>
          {active.map(row => (
            <SuspensionRow
              key={row.id} row={row} lang={lang} canLift={canLift}
              busy={busyId === row.id}
              onBusy={busy => setBusyId(busy ? row.id : null)}
              onDone={(msg) => { showToast(msg); void reload(); }}
              onError={showToast}
            />
          ))}
          {history.length > 0 && (
            <details>
              <summary style={{ fontSize: '12px', color: 'var(--t2)', cursor: 'pointer' }}>{t('mds_history_title', lang)}</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                {history.map(row => (
                  <SuspensionRow key={row.id} row={row} lang={lang} canLift={false}
                    busy={false} onBusy={() => {}} onDone={() => {}} onError={() => {}} />
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function reasonLabel(reasonCode: string, lang: 'ar' | 'en'): string {
  const key = `mds_reason_${reasonCode}`;
  const label = t(key, lang);
  return label === key ? reasonCode : label;
}

interface SuspendFormProps {
  lang: 'ar' | 'en';
  organizationId: string;
  onCancel: () => void;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}

function SuspendForm({ lang, organizationId, onCancel, onDone, onError }: SuspendFormProps) {
  const [material, setMaterial] = useState<ResolvedMaterial | null>(null);
  const [reasonCode, setReasonCode] = useState<SuspensionReasonCode>('regulatory_hold');
  const [reasonDetail, setReasonDetail] = useState('');
  const [referenceDocument, setReferenceDocument] = useState('');
  const [busy, setBusy] = useState(false);

  const detailRequired = reasonCode === 'other';
  const valid = !!material?.centralItemId && (!detailRequired || reasonDetail.trim() !== '');

  const submit = async () => {
    if (busy || !valid || !material?.centralItemId) return;
    setBusy(true);
    const result = await suspendMaterialDispensing({
      requestId: newRequestId(),
      centralItemId: material.centralItemId,
      organizationId,
      reasonCode,
      reasonDetail: reasonDetail.trim() || null,
      referenceDocument: referenceDocument.trim() || null,
    });
    setBusy(false);
    if (result.ok) onDone(t('mds_suspend_success', lang));
    else onError(t(`e_${result.error}`, lang));
  };

  return (
    <PhoenixCard>
      <div style={{ fontWeight: 700, fontSize: '13px', marginBottom: '8px' }}>{t('mds_suspend_confirm_title', lang)}</div>
      <div style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '10px' }}>{t('mds_suspend_confirm_body', lang)}</div>
      <div style={{ display: 'grid', gap: '8px' }}>
        {material ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px' }}>
            <span style={{ fontWeight: 700 }}>{material.scientificName}</span>
            <PhoenixButton variant="ghost" onClick={() => setMaterial(null)}>{t('mv_cancel', lang)}</PhoenixButton>
          </div>
        ) : (
          <PhoenixMaterialResolver lang={lang} onSelect={setMaterial} label={t('mds_suspend_action', lang)} />
        )}
        <PhoenixSelect
          label={t('mds_reason_label', lang)}
          value={reasonCode}
          onChange={e => setReasonCode(e.target.value as SuspensionReasonCode)}
          options={REASON_CODES.map(code => ({ value: code, label: reasonLabel(code, lang) }))}
        />
        <PhoenixInput
          label={t('mds_reason_detail_label', lang)}
          value={reasonDetail}
          onChange={e => setReasonDetail(e.target.value)}
          disabled={busy}
        />
        {detailRequired && reasonDetail.trim() === '' && (
          <div style={{ fontSize: '11.5px', color: 'var(--danger)' }}>{t('mds_reason_detail_required', lang)}</div>
        )}
        <PhoenixInput
          label={t('mds_reference_document_label', lang)}
          value={referenceDocument}
          onChange={e => setReferenceDocument(e.target.value)}
          disabled={busy}
        />
        <div style={{ display: 'flex', gap: '8px' }}>
          <PhoenixButton disabled={busy || !valid} onClick={() => void submit()}>{t('mds_suspend_action', lang)}</PhoenixButton>
          <PhoenixButton variant="ghost" disabled={busy} onClick={onCancel}>{t('mv_cancel', lang)}</PhoenixButton>
        </div>
      </div>
    </PhoenixCard>
  );
}

interface RowProps {
  row: MaterialDispensingSuspensionRow;
  lang: 'ar' | 'en';
  canLift: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}

function SuspensionRow({ row, lang, canLift, busy, onBusy, onDone, onError }: RowProps) {
  const [lifting, setLifting] = useState(false);
  const [liftReason, setLiftReason] = useState('');
  const isActive = !row.liftedAt;
  const materialName = lang === 'ar' ? (row.materialNameAr || row.materialName) : (row.materialName || row.materialNameAr);

  const submitLift = async () => {
    if (busy || liftReason.trim() === '') return;
    onBusy(true);
    const result = await liftMaterialDispensingSuspension({
      requestId: newRequestId(), suspensionId: row.id, liftReason: liftReason.trim(),
    });
    onBusy(false);
    if (result.ok) { onDone(t('mds_lift_success', lang)); setLifting(false); }
    else onError(t(`e_${result.error}`, lang));
  };

  return (
    <PhoenixCard>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13.5px', fontWeight: 700 }}>{materialName || '—'}</span>
            <PhoenixStatusBadge variant={isActive ? 'err' : 'neutral'} label={isActive ? t('mds_badge', lang) : t('mds_status_lifted', lang)} />
          </div>
          <div style={{ fontSize: '11.5px', color: 'var(--warn)', fontWeight: 700, marginTop: '3px' }}>
            {reasonLabel(row.reasonCode, lang)}
          </div>
          <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '2px' }}>
            {row.distributionPointId ? t('mds_scope_point', lang) : t('mds_scope_org_wide', lang)}
            {row.referenceDocument ? ` · ${row.referenceDocument}` : ''}
          </div>
          {row.reasonDetail && (
            <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '2px' }}>{row.reasonDetail}</div>
          )}
        </div>
      </div>

      {isActive && canLift && !lifting && (
        <div style={{ marginTop: '10px' }}>
          <PhoenixButton variant="secondary" onClick={() => setLifting(true)}>{t('mds_lift_action', lang)}</PhoenixButton>
        </div>
      )}

      {lifting && (
        <div style={{ display: 'grid', gap: '8px', marginTop: '10px' }}>
          <div style={{ fontSize: '12px', color: 'var(--t2)' }}>{t('mds_lift_confirm_body', lang)}</div>
          <PhoenixInput label={t('mds_lift_reason_label', lang)} value={liftReason} disabled={busy}
            onChange={e => setLiftReason(e.target.value)} />
          <div style={{ display: 'flex', gap: '8px' }}>
            <PhoenixButton disabled={busy || liftReason.trim() === ''} onClick={() => void submitLift()}>
              {t('mds_lift_action', lang)}
            </PhoenixButton>
            <PhoenixButton variant="ghost" disabled={busy} onClick={() => setLifting(false)}>{t('mv_cancel', lang)}</PhoenixButton>
          </div>
        </div>
      )}
    </PhoenixCard>
  );
}

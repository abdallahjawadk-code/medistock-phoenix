/**
 * MONTHLY-STATUS-REDESIGN-092 — Screen 20, «الموقف المخزني الشهري».
 *
 * The unified per-institution material list (warehouse + assigned outlets),
 * driving the prepare -> classify -> submit -> return/approve+lock cycle.
 * Every write goes through a migration-092 RPC (monthly-status.service.ts);
 * this screen never writes inventory_status_reports/_lines directly. Role
 * gating here is UX only — the real boundary is server-side, re-checked by
 * every RPC and by RLS on every read.
 */
import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { normalizeRole } from '@/shared/lib/roles';
import { getExpiryRiskTier, getExpiryRiskLabel, getExpiryRiskTone } from '@/shared/lib/expiry-risk';
import { formatStableDate } from '@/shared/lib/date';
import { useInventoryScopes } from '@/features/inventory/useInventoryScopes';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';
import {
  getOpenMonthlyStatusReport, getLatestLockedMonthlyStatusReport, getMonthlyStatusLines,
  prepareMonthlyStatusReport, classifyMonthlyStatusLines, confirmSuspectedMissing,
  submitMonthlyStatusReport, returnMonthlyStatusReportForClarification,
  approveLockMonthlyStatusReport, createMonthlyStatusAmendment,
  recordStocktake, getStocktakeCountLines,
  type MonthlyStatusLine, type MaterialClassification, type StocktakeCountLine,
} from '@/shared/supabase/services/monthly-status.service';

const CLASSIFICATION_LABEL_KEY: Record<MaterialClassification, string> = {
  available: 'mst_class_available',
  unavailable: 'mst_class_unavailable',
  scarce: 'mst_class_scarce',
  surplus: 'mst_class_surplus',
  suspected_missing: 'mst_class_suspected_missing',
};
const CLASSIFICATION_VARIANT: Record<MaterialClassification, 'ok' | 'warn' | 'err' | 'neutral'> = {
  // 'unavailable' is a plain zero-balance fact, distinct from the ERROR-toned
  // suspected_missing (which requires stocktake evidence + confirmation) —
  // rendered as a warning, never conflated with the missing/error state.
  available: 'ok', unavailable: 'warn', scarce: 'warn', surplus: 'ok', suspected_missing: 'err',
};

export function MonthlyStatusScreen() {
  const { lang, activeOrgId, role } = useApp();
  const normalizedRole = normalizeRole(role ?? '');

  const canPrepare  = normalizedRole === 'warehouse_officer' || normalizedRole === 'super_admin';
  const canClassify = canPrepare;
  const canSubmit   = normalizedRole === 'institution_admin' || normalizedRole === 'super_admin';
  const canReview   = normalizedRole === 'central_warehouse_manager' || normalizedRole === 'super_admin';

  const scopes = useInventoryScopes(activeOrgId);
  const [toast, setToastMessage] = useState<string | null>(null);
  const setToast = (message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(null), 3000);
  };
  const [busy, setBusy] = useState(false);

  const reportState = useAsync(
    () => (activeOrgId ? getOpenMonthlyStatusReport(activeOrgId) : Promise.resolve(null)),
    [activeOrgId],
  );
  const report = reportState.data;

  const lockedState = useAsync(
    () => (activeOrgId ? getLatestLockedMonthlyStatusReport(activeOrgId) : Promise.resolve(null)),
    [activeOrgId],
  );

  const linesState = useAsync(
    () => (report ? getMonthlyStatusLines(report.id) : Promise.resolve([])),
    [report?.id],
  );
  const lines = linesState.data ?? [];

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkClassification, setBulkClassification] = useState<MaterialClassification>('available');
  const [bulkReason, setBulkReason] = useState('');
  const [returnReason, setReturnReason] = useState('');
  const [amendReason, setAmendReason] = useState('');

  // Stocktake mini-form (WO records evidence before classifying suspected_missing).
  const [stkScopeKind, setStkScopeKind] = useState<'warehouse' | 'outlet'>('warehouse');
  const [stkScopeId, setStkScopeId] = useState('');
  const [stkCounts, setStkCounts] = useState<Record<string, string>>({}); // line.id -> counted qty text
  const [lastStocktakeId, setLastStocktakeId] = useState<string | null>(null);
  const stocktakeLinesState = useAsync(
    () => (lastStocktakeId ? getStocktakeCountLines(lastStocktakeId) : Promise.resolve<StocktakeCountLine[]>([])),
    [lastStocktakeId],
  );

  const scopeOptions = stkScopeKind === 'warehouse' ? scopes.data?.manageableWarehouses ?? [] : scopes.data?.manageableOutlets ?? [];

  async function onPrepare() {
    if (!activeOrgId) return;
    setBusy(true);
    try {
      await prepareMonthlyStatusReport(activeOrgId);
      reportState.reload();
      linesState.reload();
      setToast(t('mst_prepared', lang));
    } catch (e) { setToast((e as Error).message); }
    finally { setBusy(false); }
  }

  async function onRecordStocktake() {
    if (!activeOrgId || !stkScopeId) return;
    const stkLines = lines
      .filter(l => selected.has(l.id) && stkCounts[l.id] !== undefined && stkCounts[l.id] !== '')
      .map(l => ({ scientific_name: l.scientific_name, national_code: l.national_code, counted_qty: Number(stkCounts[l.id]) }));
    if (stkLines.length === 0) { setToast(t('mst_stocktake_no_lines', lang)); return; }
    setBusy(true);
    try {
      const res = await recordStocktake({ organizationId: activeOrgId, scopeKind: stkScopeKind, scopeId: stkScopeId, lines: stkLines });
      setLastStocktakeId(res.stocktake_id);
      setToast(t('mst_stocktake_recorded', lang));
    } catch (e) { setToast((e as Error).message); }
    finally { setBusy(false); }
  }

  function stocktakeLineFor(line: MonthlyStatusLine): StocktakeCountLine | undefined {
    return (stocktakeLinesState.data ?? []).find(
      s => s.scientific_name.toLowerCase() === line.scientific_name.toLowerCase()
        && (s.national_code ?? '') === (line.national_code ?? ''),
    );
  }

  async function onApplyBulkClassification() {
    if (!report || selected.size === 0) return;
    const payload = [...selected].map(lineId => {
      const line = lines.find(l => l.id === lineId)!;
      const evidence = bulkClassification === 'suspected_missing' ? stocktakeLineFor(line) : undefined;
      return {
        line_id: lineId,
        classification: bulkClassification,
        reason: bulkReason || null,
        stocktake_count_line_id: evidence?.id ?? null,
      };
    });
    setBusy(true);
    try {
      const res = await classifyMonthlyStatusLines(report.id, payload);
      setToast(t('mst_classified', lang).replace('{n}', String(res.classified)));
      setSelected(new Set());
      setBulkReason('');
      linesState.reload();
      reportState.reload();
    } catch (e) { setToast((e as Error).message); }
    finally { setBusy(false); }
  }

  async function onConfirmMissing(lineId: string) {
    setBusy(true);
    try {
      const res = await confirmSuspectedMissing(lineId);
      setToast(res.confirmed ? t('mst_confirmed', lang) : t('mst_confirm_pending_second', lang));
      linesState.reload();
    } catch (e) { setToast((e as Error).message); }
    finally { setBusy(false); }
  }

  async function onSubmit() {
    if (!report) return;
    setBusy(true);
    try {
      await submitMonthlyStatusReport(report.id);
      setToast(t('mst_submitted', lang));
      reportState.reload();
    } catch (e) { setToast((e as Error).message); }
    finally { setBusy(false); }
  }

  async function onReturn() {
    if (!report || !returnReason.trim()) return;
    setBusy(true);
    try {
      await returnMonthlyStatusReportForClarification(report.id, returnReason.trim());
      setToast(t('mst_returned', lang));
      setReturnReason('');
      reportState.reload();
    } catch (e) { setToast((e as Error).message); }
    finally { setBusy(false); }
  }

  async function onApproveLock() {
    if (!report) return;
    setBusy(true);
    try {
      await approveLockMonthlyStatusReport(report.id);
      setToast(t('mst_locked', lang));
      reportState.reload();
      lockedState.reload();
    } catch (e) { setToast((e as Error).message); }
    finally { setBusy(false); }
  }

  async function onAmend() {
    const locked = lockedState.data;
    if (!locked || !amendReason.trim()) return;
    setBusy(true);
    try {
      await createMonthlyStatusAmendment(locked.id, amendReason.trim());
      setToast(t('mst_amended', lang));
      setAmendReason('');
      reportState.reload();
    } catch (e) { setToast((e as Error).message); }
    finally { setBusy(false); }
  }

  const editable = report && (report.status === 'draft' || report.status === 'returned');
  const allClassified = lines.length > 0 && lines.every(l => l.classification !== null);
  const anyUnconfirmedMissing = lines.some(l => l.classification === 'suspected_missing' && !l.confirmed_missing);

  return (
    <div style={{ maxWidth: '1200px', animation: 'fs .3s ease' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <div>
          <h2 style={{ fontSize: '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('mst_title', lang)}</h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('mst_sub', lang)}</p>
        </div>
        <PhoenixOrgScope />
      </div>

      {toast && <PhoenixToast message={toast} />}

      {reportState.loading && <PhoenixLoadingState />}

      {!reportState.loading && !report && (
        <PhoenixCard padding="16px">
          <PhoenixEmptyState icon="clipboard" title={t('mst_no_open_report', lang)} description={t('mst_no_open_report_desc', lang)} />
          {canPrepare && (
            <div style={{ marginTop: '12px' }}>
              <PhoenixButton onClick={onPrepare} disabled={busy}>{t('mst_prepare_action', lang)}</PhoenixButton>
            </div>
          )}
        </PhoenixCard>
      )}

      {report && (
        <PhoenixCard padding="16px" style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <PhoenixStatusBadge
                variant={report.status === 'locked' ? 'ok' : report.status === 'returned' ? 'warn' : 'neutral'}
                label={t(`mst_status_${report.status}`, lang)}
              />
              <span style={{ fontSize: '11.5px', color: 'var(--t2)' }} dir="ltr">v{report.version}</span>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {canPrepare && editable && (
                <PhoenixButton variant="secondary" size="sm" onClick={onPrepare} disabled={busy}>{t('mst_refresh_action', lang)}</PhoenixButton>
              )}
              {canSubmit && editable && (
                <PhoenixButton size="sm" onClick={onSubmit} disabled={busy || !allClassified || anyUnconfirmedMissing}>
                  {t('mst_submit_action', lang)}
                </PhoenixButton>
              )}
              {canReview && report.status === 'submitted' && (
                <PhoenixButton size="sm" onClick={onApproveLock} disabled={busy}>{t('mst_approve_lock_action', lang)}</PhoenixButton>
              )}
            </div>
          </div>
          {report.status === 'returned' && report.return_reason && (
            <div style={{ marginTop: '10px', fontSize: '12px', color: 'var(--warn)' }}>
              {t('mst_return_reason_label', lang)}: {report.return_reason}
            </div>
          )}
          {canReview && report.status === 'submitted' && (
            <div style={{ marginTop: '12px', display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <PhoenixInput
                label={t('mst_return_reason_placeholder', lang)}
                value={returnReason}
                onChange={e => setReturnReason(e.target.value)}
                dir="auto"
              />
              <PhoenixButton variant="secondary" size="sm" onClick={onReturn} disabled={busy || !returnReason.trim()}>
                {t('mst_return_action', lang)}
              </PhoenixButton>
            </div>
          )}
          {!allClassified && lines.length > 0 && (
            <p style={{ marginTop: '8px', fontSize: '11.5px', color: 'var(--t2)' }}>{t('mst_unclassified_warning', lang)}</p>
          )}
          {anyUnconfirmedMissing && (
            <p style={{ marginTop: '4px', fontSize: '11.5px', color: 'var(--err)' }}>{t('mst_unconfirmed_missing_warning', lang)}</p>
          )}
        </PhoenixCard>
      )}

      {report && canPrepare && editable && (
        <PhoenixCard padding="16px" style={{ marginBottom: '16px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '8px' }}>{t('mst_stocktake_title', lang)}</h3>
          <p style={{ fontSize: '11.5px', color: 'var(--t2)', marginBottom: '10px' }}>{t('mst_stocktake_desc', lang)}</p>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
            <PhoenixSelect
              label={t('mst_scope_kind', lang)}
              value={stkScopeKind}
              onChange={e => { setStkScopeKind(e.target.value as 'warehouse' | 'outlet'); setStkScopeId(''); }}
              options={[
                { value: 'warehouse', label: t('mst_scope_warehouse', lang) },
                { value: 'outlet', label: t('mst_scope_outlet', lang) },
              ]}
            />
            <PhoenixSelect
              label={t('mst_scope_target', lang)}
              value={stkScopeId}
              onChange={e => setStkScopeId(e.target.value)}
              options={[{ value: '', label: '—' }, ...scopeOptions.map(o => ({ value: o.id, label: lang === 'ar' ? o.nameAr || o.name : o.name }))]}
            />
          </div>
          <p style={{ fontSize: '11px', color: 'var(--t2)', marginBottom: '6px' }}>{t('mst_stocktake_select_hint', lang)}</p>
          <PhoenixButton variant="secondary" size="sm" onClick={onRecordStocktake} disabled={busy || !stkScopeId}>
            {t('mst_stocktake_record_action', lang)}
          </PhoenixButton>
        </PhoenixCard>
      )}

      {report && lines.length > 0 && (
        <PhoenixCard padding="0" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--brd)' }}>
                {canClassify && editable && <th style={{ padding: '10px' }} />}
                <th style={{ padding: '10px', textAlign: 'start' }}>{t('mst_col_material', lang)}</th>
                <th style={{ padding: '10px', textAlign: 'end' }}>{t('mst_col_on_hand', lang)}</th>
                <th style={{ padding: '10px', textAlign: 'end' }}>{t('mst_col_central', lang)}</th>
                <th style={{ padding: '10px', textAlign: 'end' }}>{t('mst_col_supplementary', lang)}</th>
                <th style={{ padding: '10px', textAlign: 'center' }}>{t('mst_col_expiry', lang)}</th>
                <th style={{ padding: '10px', textAlign: 'center' }}>{t('mst_col_suggested', lang)}</th>
                <th style={{ padding: '10px', textAlign: 'center' }}>{t('mst_col_classification', lang)}</th>
                <th style={{ padding: '10px' }} />
              </tr>
            </thead>
            <tbody>
              {lines.map(line => {
                const tier = getExpiryRiskTier(line.nearest_expiry_date);
                const stk = stocktakeLineFor(line);
                return (
                  <tr key={line.id} style={{ borderBottom: '1px solid var(--brd)' }}>
                    {canClassify && editable && (
                      <td style={{ padding: '10px' }}>
                        <input
                          type="checkbox"
                          checked={selected.has(line.id)}
                          onChange={e => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(line.id); else next.delete(line.id);
                            setSelected(next);
                          }}
                        />
                      </td>
                    )}
                    <td style={{ padding: '10px' }} dir="auto">{line.scientific_name}</td>
                    <td style={{ padding: '10px', textAlign: 'end' }} dir="ltr">{line.on_hand_qty}</td>
                    <td style={{ padding: '10px', textAlign: 'end' }} dir="ltr">{line.central_qty}</td>
                    <td style={{ padding: '10px', textAlign: 'end' }} dir="ltr">{line.supplementary_qty}</td>
                    <td style={{ padding: '10px', textAlign: 'center' }}>
                      {line.nearest_expiry_date ? (
                        <PhoenixStatusBadge variant={getExpiryRiskTone(tier) as 'ok'|'warn'|'err'|'neutral'} label={getExpiryRiskLabel(tier, lang)} />
                      ) : '—'}
                    </td>
                    <td style={{ padding: '10px', textAlign: 'center' }}>
                      <PhoenixStatusBadge variant={CLASSIFICATION_VARIANT[line.suggested_classification]} label={t(CLASSIFICATION_LABEL_KEY[line.suggested_classification], lang)} />
                    </td>
                    <td style={{ padding: '10px', textAlign: 'center' }}>
                      {line.classification ? (
                        <PhoenixStatusBadge variant={CLASSIFICATION_VARIANT[line.classification]} label={t(CLASSIFICATION_LABEL_KEY[line.classification], lang)} />
                      ) : <span style={{ color: 'var(--t2)' }}>{t('mst_unclassified', lang)}</span>}
                      {line.classification === 'suspected_missing' && (
                        <div style={{ fontSize: '10.5px', marginTop: '4px', color: line.confirmed_missing ? 'var(--ok)' : 'var(--warn)' }}>
                          {line.confirmed_missing ? t('mst_confirmed_badge', lang) : t('mst_pending_confirmation_badge', lang)}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '10px' }}>
                      {canClassify && editable && line.classification === 'suspected_missing' && !line.confirmed_missing && (
                        <PhoenixButton variant="secondary" size="sm" onClick={() => onConfirmMissing(line.id)} disabled={busy}>
                          {t('mst_confirm_action', lang)}
                        </PhoenixButton>
                      )}
                      {editable && (
                        <input
                          type="number"
                          placeholder={t('mst_counted_qty_placeholder', lang)}
                          value={stkCounts[line.id] ?? ''}
                          onChange={e => setStkCounts({ ...stkCounts, [line.id]: e.target.value })}
                          style={{ width: '70px', marginInlineStart: '6px' }}
                          dir="ltr"
                        />
                      )}
                      {stk && <div style={{ fontSize: '10px', color: 'var(--t2)' }} dir="ltr">Δ{stk.variance}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </PhoenixCard>
      )}

      {report && canClassify && editable && selected.size > 0 && (
        <PhoenixCard padding="16px" style={{ marginTop: '16px' }}>
          <h3 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '8px' }}>
            {t('mst_bulk_title', lang).replace('{n}', String(selected.size))}
          </h3>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <PhoenixSelect
              label={t('mst_col_classification', lang)}
              value={bulkClassification}
              onChange={e => setBulkClassification(e.target.value as MaterialClassification)}
              options={(['available', 'unavailable', 'scarce', 'surplus', 'suspected_missing'] as MaterialClassification[])
                .map(c => ({ value: c, label: t(CLASSIFICATION_LABEL_KEY[c], lang) }))}
            />
            <PhoenixInput label={t('mst_reason_placeholder', lang)} value={bulkReason} onChange={e => setBulkReason(e.target.value)} dir="auto" />
            <PhoenixButton onClick={onApplyBulkClassification} disabled={busy}>{t('mst_apply_action', lang)}</PhoenixButton>
          </div>
          {bulkClassification === 'suspected_missing' && (
            <p style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '6px' }}>{t('mst_suspected_missing_hint', lang)}</p>
          )}
        </PhoenixCard>
      )}

      {canReview && lockedState.data && (
        <PhoenixCard padding="16px" style={{ marginTop: '16px' }}>
          <h3 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '6px' }}>{t('mst_amend_title', lang)}</h3>
          <p style={{ fontSize: '11.5px', color: 'var(--t2)', marginBottom: '8px' }}>
            {t('mst_amend_desc', lang)} ({formatStableDate(lockedState.data.locked_at, lang)})
          </p>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <PhoenixInput label={t('mst_reason_placeholder', lang)} value={amendReason} onChange={e => setAmendReason(e.target.value)} dir="auto" />
            <PhoenixButton variant="secondary" size="sm" onClick={onAmend} disabled={busy || !amendReason.trim()}>
              {t('mst_amend_action', lang)}
            </PhoenixButton>
          </div>
        </PhoenixCard>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import {
  listPendingOutletCorrections, approveOutletStockCorrection, rejectOutletStockCorrection,
  classifyCorrectionDecisionError,
} from '@/features/outlet/outlet-stock.service';
import {
  listPendingWarehouseCorrections, approveWarehouseStockCorrection, rejectWarehouseStockCorrection,
  classifyIntakeError,
} from './warehouse-intake.service';
import { getPaperReference, setPaperReference } from '@/features/movement/paper-reference.service';
import { PaperReferenceFields, EMPTY_PAPER_REFERENCE, paperReferenceSummary, type PaperReferenceValue } from '@/features/movement/ui/PaperReferenceFields';
import { useAsync } from '@/shared/lib/useAsync';

/** A single scope's pending correction, normalized for shared rendering. */
interface NormalizedCorrection {
  id: string;
  scope: 'outlet' | 'warehouse';
  scientificName: string | null;
  batchNumber: string | null;
  expiryDate: string | null;
  before: number;
  after: number;
  variance: number;
  reason: string;
  proposedBy: string;
  proposedByName: string | null;
  proposedAt: string;
  currentGeneration: number | null;
}

interface Props {
  /** Which scope(s) this profile may approve. Both are checked independently
   *  server-side regardless of what's shown — this only controls what the
   *  panel bothers to load and render. */
  canApproveOutlet: boolean;
  canApproveWarehouse: boolean;
}

/**
 * SECOND-PERSON-CORRECTION-APPROVAL — the pending-corrections list for BOTH
 * scopes (098 outlet, 101 warehouse). Both approval RPCs check an ORG-WIDE
 * permission (phoenix_status_center_authorized), never a warehouse/outlet
 * scope, so one shared, org-wide panel is the correct shape — matching where
 * central_warehouse_manager (the sole default holder of both keys) already
 * works.
 */
export function PendingCorrectionsPanel({ canApproveOutlet, canApproveWarehouse }: Props) {
  const { lang, dir, profile } = useApp();
  const [rows, setRows] = useState<NormalizedCorrection[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [outlet, warehouse] = await Promise.all([
        canApproveOutlet ? listPendingOutletCorrections() : Promise.resolve([]),
        canApproveWarehouse ? listPendingWarehouseCorrections() : Promise.resolve([]),
      ]);
      const normalized: NormalizedCorrection[] = [
        ...outlet.map((r): NormalizedCorrection => ({
          id: r.id, scope: 'outlet', scientificName: r.scientificName, batchNumber: r.batchNumber,
          expiryDate: r.expiryDate, before: r.onHandBefore, after: r.countedQuantity, variance: r.variance,
          reason: r.reason, proposedBy: r.proposedBy, proposedByName: r.proposedByName, proposedAt: r.proposedAt,
          currentGeneration: r.currentGeneration,
        })),
        ...warehouse.map((r): NormalizedCorrection => ({
          id: r.id, scope: 'warehouse', scientificName: r.scientificName, batchNumber: r.batchNumber,
          expiryDate: r.expiryDate, before: r.onHandBefore, after: r.newQuantity, variance: r.variance,
          reason: r.reason, proposedBy: r.proposedBy, proposedByName: r.proposedByName, proposedAt: r.proposedAt,
          currentGeneration: r.currentGeneration,
        })),
      ].sort((a, b) => a.proposedAt.localeCompare(b.proposedAt));
      setRows(normalized);
    } catch {
      setError(t('err_generic', lang));
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, [canApproveOutlet, canApproveWarehouse, lang]);

  useEffect(() => { void reload(); }, [reload]);

  const showToast = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 4000); };

  const approve = async (row: NormalizedCorrection) => {
    setBusyId(row.id);
    try {
      if (row.scope === 'outlet') {
        // outlet-stock.service throws on RPC failure — a resolved value here
        // always means success.
        await approveOutletStockCorrection(row.id, row.currentGeneration);
        showToast(t('cor_approved_ok', lang));
        await reload();
      } else {
        const result = await approveWarehouseStockCorrection(row.id, row.currentGeneration);
        if (result.ok) {
          showToast(t('cor_approved_ok', lang));
          await reload();
        } else {
          showToast(t(classifyIntakeError(result.error), lang));
        }
      }
    } catch (e) {
      showToast(t(classifyCorrectionDecisionError(e), lang));
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (row: NormalizedCorrection) => {
    if (!rejectReason.trim()) return;
    setBusyId(row.id);
    try {
      // outlet-stock.service throws on RPC error; warehouse-intake.service
      // (callRpc) instead RESOLVES with { ok: false, error }. Both must be
      // checked explicitly here — trusting an unchecked resolve for the
      // warehouse branch would show "rejected" on a failed/self/stale reject.
      if (row.scope === 'outlet') {
        await rejectOutletStockCorrection(row.id, rejectReason.trim());
      } else {
        const result = await rejectWarehouseStockCorrection(row.id, rejectReason.trim());
        if (!result.ok) {
          showToast(t(classifyIntakeError(result.error), lang));
          return;
        }
      }
      showToast(t('cor_rejected_ok', lang));
      setRejectingId(null);
      setRejectReason('');
      await reload();
    } catch (e) {
      showToast(t(classifyCorrectionDecisionError(e), lang));
    } finally {
      setBusyId(null);
    }
  };

  if (loading && rows === null) return <PhoenixLoadingState />;
  if (error) return <PhoenixErrorState title={t('err_generic', lang)} message={error} onRetry={reload} />;
  if (!rows || rows.length === 0) {
    return <PhoenixEmptyState icon="🔒" title={t('cor_pending_empty_title', lang)} description={t('cor_pending_empty_description', lang)} />;
  }

  return (
    <div dir={dir} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {toast && <div style={{ fontSize: '12px', color: 'var(--ok)' }}>{toast}</div>}
      {rows.map(row => {
        const isOwnRequest = profile?.id === row.proposedBy;
        const busy = busyId === row.id;
        return (
          <PhoenixCard key={`${row.scope}:${row.id}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: '13.5px', fontWeight: 700 }}>
                  {row.scientificName ?? '—'}
                  <span style={{ fontWeight: 400, color: 'var(--t2)', fontSize: '11.5px' }}>
                    {' '}· {t(row.scope === 'outlet' ? 'cor_scope_outlet' : 'cor_scope_warehouse', lang)}
                  </span>
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '2px' }}>
                  {[row.batchNumber, row.expiryDate].filter(Boolean).join(' · ') || '—'}
                </div>
                <div style={{ fontSize: '12px', marginTop: '4px' }}>
                  {t('cor_reason', lang)}: <strong dir="auto">{row.reason}</strong>
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '2px' }}>
                  {t('cor_proposed_by', lang)}: {row.proposedByName ?? row.proposedBy} · {t('cor_proposed_at', lang)}: {new Date(row.proposedAt).toLocaleString(lang === 'ar' ? 'ar' : 'en')}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', fontWeight: 700 }}>
                <span>{t('cor_before', lang)}: {row.before}</span>
                <span>→</span>
                <span style={{ color: 'var(--warn)' }}>{t('cor_after', lang)}: {row.after}</span>
                <span style={{ color: 'var(--t2)', fontWeight: 400 }}>({t('cor_variance', lang)}: {row.variance})</span>
              </div>
            </div>

            {/* PAPER-REFERENCE-CONTRACT-110: document_type 'stock_correction_request'
                maps ONLY to phoenix_stock_correction_requests (the OUTLET
                correction table) — phoenix_warehouse_correction_requests
                (scope 'warehouse') is a different table 110 does not cover,
                so this control is deliberately outlet-scope only. This panel
                only ever lists PENDING rows, which is exactly 110's editable
                window for this document type. */}
            {row.scope === 'outlet' && <OutletCorrectionPaperRef lang={lang} correctionRequestId={row.id} />}

            {isOwnRequest ? (
              <p style={{ fontSize: '11.5px', color: 'var(--warn)', marginTop: '10px' }}>{t('cor_own_request_notice', lang)}</p>
            ) : rejectingId === row.id ? (
              <div style={{ display: 'grid', gap: '8px', marginTop: '10px' }}>
                <PhoenixInput label={t('cor_reject_reason_label', lang)} value={rejectReason} disabled={busy}
                  onChange={e => setRejectReason(e.target.value)} />
                <div style={{ display: 'flex', gap: '8px' }}>
                  <PhoenixButton disabled={busy || !rejectReason.trim()} onClick={() => void reject(row)}>
                    {t('cor_confirm_reject', lang)}
                  </PhoenixButton>
                  <PhoenixButton variant="ghost" disabled={busy} onClick={() => { setRejectingId(null); setRejectReason(''); }}>
                    {t('mv_cancel', lang)}
                  </PhoenixButton>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                <PhoenixButton disabled={busy} loading={busy} onClick={() => void approve(row)}>
                  {t('cor_approve', lang)}
                </PhoenixButton>
                <PhoenixButton variant="ghost" disabled={busy} onClick={() => setRejectingId(row.id)}>
                  {t('cor_reject', lang)}
                </PhoenixButton>
              </div>
            )}
          </PhoenixCard>
        );
      })}
    </div>
  );
}

function OutletCorrectionPaperRef({ lang, correctionRequestId }: { lang: 'ar' | 'en'; correctionRequestId: string }) {
  const [reloadKey, setReloadKey] = useState(0);
  const paperRef = useAsync(() => getPaperReference('stock_correction_request', correctionRequestId), [correctionRequestId, reloadKey]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<PaperReferenceValue>(EMPTY_PAPER_REFERENCE);
  const [busy, setBusy] = useState(false);

  return (
    <div style={{ marginTop: '8px', paddingTop: '8px', borderTop: '1px solid var(--brd)' }}>
      {editing ? (
        <div style={{ display: 'grid', gap: '8px' }}>
          <PaperReferenceFields lang={lang} value={draft} onChange={setDraft} disabled={busy} />
          <div style={{ display: 'flex', gap: '8px' }}>
            <PhoenixButton size="sm" loading={busy} disabled={draft.number.trim() === ''} onClick={async () => {
              setBusy(true);
              await setPaperReference({
                documentType: 'stock_correction_request', documentId: correctionRequestId,
                paperReferenceNumber: draft.number, paperReferenceDate: draft.date || null,
                issuingAuthority: draft.authority || null,
              });
              setBusy(false);
              setEditing(false);
              setReloadKey(k => k + 1);
            }}>{t('net_op_save', lang)}</PhoenixButton>
            <PhoenixButton size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>{t('mv_cancel', lang)}</PhoenixButton>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: '11.5px', color: 'var(--t2)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span>{t('mv_h_paper_reference_number', lang)}: {paperReferenceSummary(paperRef.data)}</span>
          <PhoenixButton size="sm" variant="ghost" onClick={() => {
            setDraft({
              number: paperRef.data?.paperReferenceNumber ?? '',
              date: paperRef.data?.paperReferenceDate ?? '',
              authority: paperRef.data?.issuingAuthority ?? '',
            });
            setEditing(true);
          }}>{t('net_op_edit', lang)}</PhoenixButton>
        </div>
      )}
    </div>
  );
}

/**
 * CURRENT MOVEMENT STATUS — resolve a scanned QR / pasted canonical UUID to a
 * document's CURRENT server state, through RLS-scoped reads only.
 *
 * NOT a historical timeline (that needs a backend timeline RPC — see
 * docs/phoenix/proposals/movement-timeline-rpc.md). This surface states so plainly.
 *
 * SECURITY: unknown and unauthorized both resolve to the same generic result,
 * so scanning can never confirm a record exists. No privileged service key, no
 * admin auth API, no fabricated history — every value is a live RLS-scoped read.
 */
import { useCallback, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { useOnlineStatus } from '@/shared/lib/useOnlineStatus';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import type { MovementDocumentKind } from '@/features/movement/movement-trace';
import {
  getOutletReturnRequests, getOutletReturnRequestLines,
  getOutletReturnShipments, getOutletReturnShipmentLines,
} from './outlet-return.service';
import {
  parseMovementStatusInput, resolveMovementStatus,
  type MovementStatus, type MovementStatusResult, type MovementStatusDeps,
} from './movement-status';
import { getMovementTimeline, type MovementTimeline } from '@/features/movement/movement-timeline.service';
import { searchMovementDocuments, type TraceCandidate } from '@/features/movement/movement-search.service';

type Lang = 'ar' | 'en';
const dash = (v: string | number | null | undefined) => (v == null || v === '' ? '—' : String(v));

const liveDeps: MovementStatusDeps = {
  getReturnRequests: () => getOutletReturnRequests(),
  getReturnRequestLines: id => getOutletReturnRequestLines(id),
  getReturnShipments: () => getOutletReturnShipments(),
  getReturnShipmentLines: id => getOutletReturnShipmentLines(id),
};

type ViewState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'result'; result: MovementStatusResult; timeline: MovementTimeline | null; fetchedAt: number };

interface Props {
  lang: Lang;
  /** Injectable for tests; defaults to the live RLS-scoped reads. */
  deps?: MovementStatusDeps;
  isOnline?: () => boolean;
}

export function CurrentMovementStatus({ lang, deps = liveDeps, isOnline }: Props) {
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  // Subscribed, not sampled. Reading navigator.onLine during render left the
  // banner latched at whatever connectivity happened to be true at mount, so an
  // operator who lost the network while looking at this screen was told nothing.
  // The hook is called unconditionally (hook rules); the injectable prop still
  // wins so tests can drive connectivity directly.
  const liveOnline = useOnlineStatus();
  const online = isOnline ?? (() => liveOnline);

  const [raw, setRaw] = useState('');
  const [kindHint, setKindHint] = useState<MovementDocumentKind>('return_request');
  const [state, setState] = useState<ViewState>({ phase: 'idle' });

  const [candidates, setCandidates] = useState<TraceCandidate[] | null>(null);

  /** SMART SEARCH: QR / UUID / official number / order-receipt number /
      external reference — auto-detected; multiple hits are LISTED (external
      refs are not unique), never auto-picked. */
  const smartLookup = useCallback(async () => {
    setCandidates(null);
    setState({ phase: 'loading' });
    try {
      const found = await searchMovementDocuments(raw);
      if (!found.ok) {
        setState({ phase: 'result', result: { ok: false, reason: found.reason === 'invalid_input' ? 'invalid_input' : 'not_available' }, timeline: null, fetchedAt: Date.now() });
        return;
      }
      if (found.candidates.length > 1) {
        setCandidates(found.candidates);
        setState({ phase: 'idle' });
        return;
      }
      await lookupCandidate(found.candidates[0]);
    } catch {
      setState({ phase: 'error' });
    }
    // raw is the only live input; lookupCandidate is stable per deps.
  }, [raw]); // lookupCandidate intentionally omitted (declared below, stable)

  const lookupCandidate = useCallback(async (candidate: TraceCandidate) => {
    setCandidates(null);
    setState({ phase: 'loading' });
    try {
      const kind = (candidate.kind === 'return_request' || candidate.kind === 'return_shipment')
        ? candidate.kind : undefined;
      const [result, timeline] = await Promise.all([
        kind
          ? resolveMovementStatus({ kind, id: candidate.id }, deps)
          : Promise.resolve({ ok: false, reason: 'unsupported_kind', kind: 'return_request' } as MovementStatusResult),
        getMovementTimeline(candidate.id).catch(() => null),
      ]);
      setState({ phase: 'result', result, timeline, fetchedAt: Date.now() });
    } catch {
      setState({ phase: 'error' });
    }
  }, [deps]);

  const lookup = useCallback(async () => {
    const target = parseMovementStatusInput(raw, kindHint);
    if (!target) {
      // Not a QR/UUID: route through the smart document search.
      await smartLookup();
      return;
    }
    setState({ phase: 'loading' });
    try {
      // MOVEMENT-TRACKING-MERGE: the current status AND the full 081/082
      // server-side timeline resolve together. The timeline RPC is org-scoped
      // server-side and returns the SAME empty shape for unknown and
      // unauthorized ids — no existence leak, no duplicated events (each event
      // row is one append-only ledger/lifecycle record).
      const [result, timeline] = await Promise.all([
        resolveMovementStatus(target, deps),
        getMovementTimeline(target.id).catch(() => null),
      ]);
      setState({ phase: 'result', result, timeline, fetchedAt: Date.now() });
    } catch {
      setState({ phase: 'error' });
    }
  }, [raw, kindHint, deps]);

  return (
    <div dir={dir} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div>
        <h3 style={{ fontSize: '16px', fontWeight: 700 }}>{t('or_status_title', lang)}</h3>
        <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('or_status_hint', lang)}</p>
      </div>

      {!online() && (
        <div data-testid="movement-status-offline" style={{ background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r3)', padding: '10px 14px', fontSize: '12px', color: 'var(--warn)' }}>
          {t('or_status_offline', lang)}
        </div>
      )}

      <PhoenixCard>
        <div style={{ display: 'grid', gap: '10px' }}>
          <PhoenixInput
            label={t('or_status_input_label', lang)}
            value={raw}
            onChange={e => setRaw(e.target.value)}
            data-testid="movement-status-input"
          />
          <PhoenixSelect
            label={t('or_status_kind_label', lang)}
            value={kindHint}
            onChange={e => setKindHint(e.target.value as MovementDocumentKind)}
            options={[
              { value: 'return_request', label: t('or_kind_return_request', lang) },
              { value: 'return_shipment', label: t('or_kind_return_shipment', lang) },
            ]}
          />
          <div style={{ display: 'flex', gap: '8px' }}>
            <PhoenixButton disabled={!raw.trim() || state.phase === 'loading'} onClick={() => void lookup()} data-testid="movement-status-lookup">
              {t('or_status_lookup', lang)}
            </PhoenixButton>
            {state.phase === 'result' && state.result.ok && (
              <PhoenixButton variant="ghost" onClick={() => void lookup()}>{t('or_status_refresh', lang)}</PhoenixButton>
            )}
          </div>
        </div>
      </PhoenixCard>

      {candidates && candidates.length > 1 && (
        <PhoenixCard data-testid="movement-search-candidates">
          <p style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '8px' }}>{t('or_search_multiple', lang)}</p>
          <div style={{ display: 'grid', gap: '6px' }}>
            {candidates.map(candidate => (
              <PhoenixButton key={candidate.id} variant="ghost" size="sm" onClick={() => void lookupCandidate(candidate)}>
                <span dir="ltr">{candidate.number ?? candidate.id}</span>
                {candidate.status ? ` · ${candidate.status}` : ''}
                {candidate.externalReference ? ` · ${candidate.externalReference}` : ''}
              </PhoenixButton>
            ))}
          </div>
        </PhoenixCard>
      )}

      {state.phase === 'loading' && <PhoenixLoadingState />}
      {state.phase === 'error' && (
        <div data-testid="movement-status-error" style={{ background: 'var(--err2)', border: '1px solid var(--err)', borderRadius: 'var(--r3)', padding: '10px 14px', fontSize: '12px', color: 'var(--err)' }}>
          {t('or_status_error', lang)}
        </div>
      )}
      {state.phase === 'result' && !state.result.ok && (
        <div data-testid="movement-status-not-available">
          <PhoenixEmptyState
            icon="package"
            title={t(
              state.result.reason === 'invalid_input' ? 'or_status_invalid'
                : state.result.reason === 'unsupported_kind' ? 'or_status_unsupported'
                  : 'or_status_not_available',
              lang,
            )}
          />
        </div>
      )}
      {state.phase === 'result' && state.result.ok && (
        <StatusResult status={state.result.status} fetchedAt={state.fetchedAt} lang={lang} />
      )}

      {/* The unified, ordered, server-authoritative timeline (081/082) — shown
          for ANY resolvable trace id, including corridors the status card does
          not cover yet. */}
      {state.phase === 'result' && state.timeline && state.timeline.events.length > 0 && (
        <TimelineResult timeline={state.timeline} lang={lang} />
      )}
    </div>
  );
}

function TimelineResult({ timeline, lang }: { timeline: MovementTimeline; lang: Lang }) {
  return (
    <PhoenixCard data-testid="movement-timeline">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <h4 style={{ fontSize: '13.5px', fontWeight: 700 }}>{t('or_timeline_title', lang)}</h4>
        <PhoenixButton variant="ghost" size="sm" onClick={() => window.print()}>
          {t('or_timeline_print', lang)}
        </PhoenixButton>
      </div>
      <ol style={{ listStyle: 'none', marginTop: '10px', display: 'grid', gap: '8px' }}>
        {timeline.events.map(e => (
          <li key={e.eventId} style={{ display: 'flex', gap: '10px', alignItems: 'baseline', fontSize: '12px', borderInlineStart: '2px solid var(--p)', paddingInlineStart: '10px' }}>
            <span dir="ltr" style={{ color: 'var(--t3)', whiteSpace: 'nowrap', fontSize: '11px' }}>
              {new Date(e.occurredAt).toLocaleString(lang === 'ar' ? 'ar' : 'en')}
            </span>
            <span style={{ minWidth: 0 }}>
              <strong>{dash(e.statusAfter)}</strong>
              {e.materialLabel ? ` · ${e.materialLabel}` : ''}
              {e.batchLabel ? ` (${e.batchLabel})` : ''}
              {e.quantityDelta != null ? ` · ${e.quantityDelta > 0 ? '+' : ''}${e.quantityDelta}` : ''}
              {e.actorName ? ` · ${e.actorName}` : ''}
              {e.referenceLabel ? ` · ${e.referenceLabel}` : ''}
            </span>
          </li>
        ))}
      </ol>
      {!timeline.complete && timeline.completenessNote && (
        <p style={{ fontSize: '10.5px', color: 'var(--t3)', marginTop: '8px' }}>{timeline.completenessNote}</p>
      )}
    </PhoenixCard>
  );
}

function StatusResult({ status, fetchedAt, lang }: { status: MovementStatus; fetchedAt: number; lang: Lang }) {
  const kindLabel = status.kind === 'return_shipment' ? t('or_kind_return_shipment', lang) : t('or_kind_return_request', lang);
  return (
    <div style={{ display: 'grid', gap: '10px' }} data-testid="movement-status-result">
      <PhoenixCard>
        <div style={{ fontSize: '12.5px', display: 'grid', gap: '4px' }}>
          <div><strong>{kindLabel}</strong> · {t('mv_h_status', lang)}: {dash(status.status)}</div>
          <div style={{ fontSize: '11px', color: 'var(--t2)' }}>
            {t('mv_h_trace_key', lang)}: <code>{status.traceKey}</code>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--t2)' }}>
            {t('mv_external_reference', lang)}: {dash(status.externalReference)} ·{' '}
            {t('or_status_current_at', lang)}: {new Date(fetchedAt).toLocaleTimeString(lang === 'ar' ? 'ar' : 'en')}
          </div>
        </div>
      </PhoenixCard>

      {status.lines.map((l, i) => (
        <PhoenixCard key={`${l.provenance ?? i}-${i}`}>
          <div style={{ fontSize: '12.5px', fontWeight: 700 }}>{l.scientificName}</div>
          <div style={{ fontSize: '11px', color: 'var(--t2)' }}>
            {t('mv_f_batch_number', lang)}: {dash(l.batchNumber)} · {t('mv_f_expiry_date', lang)}: {dash(l.expiryDate)}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--t2)' }}>
            {t('mv_f_moved_quantity', lang)}: {dash(l.movedQuantity)} ·{' '}
            {t('mv_f_received_quantity', lang)}: {dash(l.receivedQuantity)} ·{' '}
            {t('mv_h_status', lang)}: {dash(l.status)}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--t2)' }}>
            {t('mv_f_original_supply_reference', lang)}: {dash(l.provenance)}
            {l.disposition ? ` · ${t('mv_f_disposition', lang)}: ${l.disposition}` : ''}
            {l.reason ? ` · ${l.reason}` : ''}
          </div>
        </PhoenixCard>
      ))}
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { formatStableDateTime } from '@/shared/lib/date';
import {
  getAvailabilityMovementsByItem,
  type AvailabilityMovementRecord,
  type AvailabilityMovementType,
} from '@/shared/supabase/services/availability.service';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { MaterialTimeline, type MaterialTimelineEntry } from '@/shared/ui/MaterialTimeline';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import type { AdjustQuantityRow } from './AdjustQuantityModal';

/**
 * AVAILABILITY-MOVEMENT-HISTORY-VIEW-A
 *
 * Read-only quantity movement history for one item_availability row. This
 * component NEVER writes: it only calls getAvailabilityMovementsByItem, a
 * plain PostgREST SELECT against item_availability_movements (migration 033),
 * which grants no INSERT/UPDATE/DELETE to any client role and whose
 * avail_mvmt_select_perm RLS policy independently re-enforces org scope +
 * availability.movements.view. Visibility of the row action that opens this
 * modal is UX-only — RLS is the real read boundary.
 */

const MOVEMENT_TYPE_LABEL_KEY: Record<AvailabilityMovementType, string> = {
  set_exact: 'mvmt_set_exact',
  add: 'mvmt_add',
  subtract: 'mvmt_subtract',
  correction: 'mvmt_correction',
};

function formatDelta(type: AvailabilityMovementType, delta: number): string {
  if (type === 'add') return `+${Math.abs(delta)}`;
  if (type === 'subtract') return `-${Math.abs(delta)}`;
  // set_exact / correction: display the stored signed delta as-is, never recomputed.
  return delta > 0 ? `+${delta}` : String(delta);
}

interface Props {
  open: boolean;
  row: AdjustQuantityRow | null;
  lang: 'ar' | 'en';
  onClose: () => void;
}

export function MovementHistoryModal({ open, row, lang, onClose }: Props) {
  const [movements, setMovements] = useState<AvailabilityMovementRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // UX-SMART-FILTERS-TIMELINE-A: table stays the default view (unchanged
  // behavior); timeline is an additional, opt-in presentation of the exact
  // same already-fetched `movements` — no new query.
  const [viewMode, setViewMode] = useState<'table' | 'timeline'>('table');

  async function load(itemAvailabilityId: string) {
    setLoading(true);
    setError(null);
    try {
      const data = await getAvailabilityMovementsByItem(itemAvailabilityId);
      setMovements(data);
    } catch (e) {
      console.error('[phoenix] movement history load failed:', e);
      setError(t('load_error', lang));
    } finally {
      setLoading(false);
    }
  }

  // Load whenever the modal opens for a row — this also covers the "refresh
  // after a successful Adjust Quantity" requirement, since the modal is
  // closed during that flow and this effect re-fetches fresh data next time
  // it is opened for the same or a different row.
  useEffect(() => {
    if (open && row) {
      load(row.id);
    }
    if (!open) {
      setMovements([]);
      setError(null);
    }
  }, [open, row?.id]);

  // UX-SMART-FILTERS-TIMELINE-A: maps the exact same already-fetched
  // `movements` into MaterialTimeline's entry shape — no new fetch, no
  // fabricated fields. Location is the row's own outlet name (real, constant
  // across all of this item's movements).
  const dpNameForTimeline = row?.distribution_points
    ? (lang === 'ar' ? (row.distribution_points.name_ar || row.distribution_points.name) : row.distribution_points.name)
    : undefined;
  const timelineEntries: MaterialTimelineEntry[] = useMemo(() => movements.map(m => ({
    id: m.id,
    timestamp: formatStableDateTime(m.createdAt, lang),
    typeLabel: t(MOVEMENT_TYPE_LABEL_KEY[m.movementType], lang),
    quantityBefore: m.quantityBefore,
    quantityAfter: m.quantityAfter,
    deltaLabel: formatDelta(m.movementType, m.quantityDelta),
    actor: (m.actorNameSnapshot || m.actorEmailSnapshot || undefined)
      ? `${m.actorNameSnapshot || m.actorEmailSnapshot}${m.actorRoleSnapshot ? ` (${m.actorRoleSnapshot})` : ''}`
      : undefined,
    reason: m.reason ?? undefined,
    notes: m.notes ?? undefined,
    location: dpNameForTimeline,
  })), [movements, lang, dpNameForTimeline]);

  if (!open || !row) return null;

  const dpName = dpNameForTimeline;

  const th = { textAlign: 'start' as const, padding: '7px 8px', fontSize: '10.5px', fontWeight: 700, color: 'var(--t2)', borderBottom: '2px solid var(--brd)', whiteSpace: 'nowrap' as const };
  const td = { padding: '6px 8px', fontSize: '11px', borderBottom: '1px solid var(--brd)' };

  return (
    <PhoenixDialog open={open} onClose={onClose} title={t('mvmt_history_title', lang)} maxWidth={860}>
      {/* Material identity + current quantity — read-only, no edit fields here */}
      <div style={{ background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '12px 14px', marginBottom: '16px', fontSize: '12.5px' }}>
        <div style={{ fontWeight: 700, marginBottom: '4px' }} dir="auto">
          {row.scientific_name || '—'}{row.trade_name ? ` (${row.trade_name})` : ''}
        </div>
        <div style={{ color: 'var(--t2)', display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
          {row.concentration && <span dir="auto">{row.concentration}</span>}
          {row.dosage_form && <span dir="auto">{row.dosage_form}</span>}
          {dpName && <span dir="auto"><PhoenixIcon name="location" size={13} style={{ verticalAlign: 'text-bottom', marginInlineEnd: '4px' }} /> {dpName}</span>}
        </div>
        <div style={{ marginTop: '6px', fontSize: '13px' }}>
          {t('mvmt_current_qty', lang)}: <strong>{row.quantity}</strong>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '10px' }}>
        <button
          onClick={() => load(row.id)}
          disabled={loading}
          style={{ padding: '6px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '11.5px', fontWeight: 600, cursor: loading ? 'default' : 'pointer' }}
        >
          <PhoenixIcon name="refresh" size={14} style={{ verticalAlign: 'text-bottom', marginInlineEnd: '5px' }} /> {t('mvmt_history_refresh', lang)}
        </button>
      </div>

      {loading && <PhoenixLoadingState label={t('loading', lang)} />}

      {!loading && error && (
        <PhoenixErrorState title={t('load_error', lang)} message={error} onRetry={() => load(row.id)} />
      )}

      {!loading && !error && movements.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px', color: 'var(--t2)', fontSize: '12.5px' }}>
          {t('mvmt_history_empty', lang)}
        </div>
      )}

      {/* View toggle — UX-SMART-FILTERS-TIMELINE-A. Table remains the default
          and unchanged; timeline is an additional, opt-in presentation of the
          same already-fetched movements. */}
      {!loading && !error && movements.length > 0 && (
        <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
          <button
            onClick={() => setViewMode('table')}
            aria-pressed={viewMode === 'table'}
            style={{ padding: '5px 12px', minHeight: '38px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: viewMode === 'table' ? 'var(--p2)' : 'var(--s)', color: viewMode === 'table' ? 'var(--pd)' : 'var(--t)', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer' }}
          >
            <PhoenixIcon name="table" size={14} style={{ verticalAlign: 'text-bottom', marginInlineEnd: '5px' }} /> {t('mt_view_table', lang)}
          </button>
          <button
            onClick={() => setViewMode('timeline')}
            aria-pressed={viewMode === 'timeline'}
            style={{ padding: '5px 12px', minHeight: '38px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: viewMode === 'timeline' ? 'var(--p2)' : 'var(--s)', color: viewMode === 'timeline' ? 'var(--pd)' : 'var(--t)', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer' }}
          >
            <PhoenixIcon name="clock" size={14} style={{ verticalAlign: 'text-bottom', marginInlineEnd: '5px' }} /> {t('mt_view_timeline', lang)}
          </button>
        </div>
      )}

      {!loading && !error && movements.length > 0 && viewMode === 'timeline' && (
        <MaterialTimeline entries={timelineEntries} />
      )}

      {!loading && !error && movements.length > 0 && viewMode === 'table' && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>{t('mvmt_col_datetime', lang)}</th>
                <th style={th}>{t('mvmt_col_type', lang)}</th>
                <th style={th}>{t('mvmt_col_before', lang)}</th>
                <th style={th}>{t('mvmt_col_delta', lang)}</th>
                <th style={th}>{t('mvmt_col_after', lang)}</th>
                <th style={th}>{t('mvmt_col_actor', lang)}</th>
                <th style={th}>{t('mvmt_col_reason', lang)}</th>
                <th style={th}>{t('mvmt_col_notes', lang)}</th>
              </tr>
            </thead>
            <tbody>
              {movements.map(m => (
                <tr key={m.id}>
                  <td style={td} dir="ltr">{formatStableDateTime(m.createdAt, lang)}</td>
                  <td style={td}>{t(MOVEMENT_TYPE_LABEL_KEY[m.movementType], lang)}</td>
                  <td style={td}>{m.quantityBefore}</td>
                  <td style={td} dir="ltr">{formatDelta(m.movementType, m.quantityDelta)}</td>
                  <td style={td}>{m.quantityAfter}</td>
                  <td style={td} dir="auto">
                    {(m.actorNameSnapshot || m.actorEmailSnapshot || '—')}
                    {m.actorRoleSnapshot ? ` (${m.actorRoleSnapshot})` : ''}
                  </td>
                  <td style={td} dir="auto">{m.reason || '—'}</td>
                  <td style={td} dir="auto">{m.notes || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
        <PhoenixButton variant="ghost" size="md" onClick={onClose}>
          {t('mvmt_history_close', lang)}
        </PhoenixButton>
      </div>
    </PhoenixDialog>
  );
}

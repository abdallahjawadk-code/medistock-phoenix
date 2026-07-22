import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from './PhoenixCard';
import { PhoenixIcon } from './PhoenixIcon';

/**
 * UX-SMART-FILTERS-TIMELINE-A — a single, already-known-real timeline event.
 * The caller is responsible for mapping its own already-loaded/fetched
 * records into this shape; this component never fetches and never invents
 * an entry that wasn't handed to it.
 */
export interface MaterialTimelineEntry {
  id: string;
  /** ISO or already-formatted date/time string — rendered as-is, dir="ltr". */
  timestamp: string;
  /** Already-localized action/type label (e.g. t(MOVEMENT_TYPE_LABEL_KEY[...])). */
  typeLabel: string;
  quantityBefore?: number;
  quantityAfter?: number;
  /** Already-formatted delta, e.g. "+5" / "-2". */
  deltaLabel?: string;
  actor?: string;
  reason?: string;
  notes?: string;
  /** Outlet/institution name, if already available on the source record. */
  location?: string;
}

interface EventCardProps {
  entry: MaterialTimelineEntry;
  isLast: boolean;
}

export function TimelineEventCard({ entry, isLast }: EventCardProps) {
  const hasQuantity = entry.quantityBefore !== undefined || entry.quantityAfter !== undefined || !!entry.deltaLabel;

  return (
    <div style={{ display: 'flex', gap: '10px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
        <div
          aria-hidden="true"
          style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--p)', marginTop: '8px', flexShrink: 0 }}
        />
        {!isLast && <div aria-hidden="true" style={{ width: '2px', flex: 1, background: 'var(--brd)', marginTop: '2px', minHeight: '16px' }} />}
      </div>
      <PhoenixCard padding="10px 14px" style={{ flex: 1, marginBottom: '10px', minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px', flexWrap: 'wrap', marginBottom: '4px' }}>
          <span style={{ fontSize: '12.5px', fontWeight: 700 }} dir="auto">{entry.typeLabel}</span>
          <span style={{ fontSize: '10.5px', color: 'var(--t2)' }} dir="ltr">{entry.timestamp}</span>
        </div>
        {hasQuantity && (
          <div style={{ fontSize: '11.5px', color: 'var(--t)', marginBottom: '4px' }} dir="ltr">
            {entry.quantityBefore !== undefined && <span>{entry.quantityBefore}</span>}
            {entry.deltaLabel && <span> → {entry.deltaLabel} → </span>}
            {entry.quantityAfter !== undefined && <span>{entry.quantityAfter}</span>}
          </div>
        )}
        {entry.location && (
          <div style={{ fontSize: '10.5px', color: 'var(--t2)' }} dir="auto"><PhoenixIcon name="hospital" size={11} inline /> {entry.location}</div>
        )}
        {entry.actor && (
          <div style={{ fontSize: '10.5px', color: 'var(--t2)' }} dir="auto"><PhoenixIcon name="account" size={11} inline /> {entry.actor}</div>
        )}
        {entry.reason && (
          <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }} dir="auto">{entry.reason}</div>
        )}
        {entry.notes && (
          <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }} dir="auto">{entry.notes}</div>
        )}
      </PhoenixCard>
    </div>
  );
}

interface Props {
  entries: MaterialTimelineEntry[];
}

/**
 * Read-only material activity timeline. Renders ONLY entries the caller
 * already loaded from an existing screen/service's real data — no fetching
 * here, no fabricated events. Shows the honest empty state when there is
 * nothing recorded yet.
 */
export function MaterialTimeline({ entries }: Props) {
  const { lang } = useApp();

  if (entries.length === 0) {
    return (
      <div style={{
        padding: '18px 16px', borderRadius: 'var(--r3)',
        background: 'var(--s)', border: '1px solid var(--brd)',
        color: 'var(--t2)', fontSize: '12.5px', textAlign: 'center',
      }}>
        {t('mt_timeline_empty', lang)}
      </div>
    );
  }

  return (
    <div>
      {entries.map((entry, i) => (
        <TimelineEventCard key={entry.id} entry={entry} isLast={i === entries.length - 1} />
      ))}
    </div>
  );
}

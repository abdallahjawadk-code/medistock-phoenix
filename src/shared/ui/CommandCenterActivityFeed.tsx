import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from './PhoenixCard';

export interface ActivityFeedEntry {
  id: string;
  title: string;
  subtitle?: string;
  timestamp?: string;
}

interface Props {
  entries: ActivityFeedEntry[];
}

/**
 * UX-COMMAND-CENTER-SMART-A — read-only "recent activity" strip.
 *
 * Renders ONLY entries the caller already loaded from an existing screen's
 * data source (no fetching here, no new Supabase reads). When there are no
 * entries yet, shows the honest empty state instead of inventing rows.
 */
export function CommandCenterActivityFeed({ entries }: Props) {
  const { lang } = useApp();

  if (entries.length === 0) {
    return (
      <div style={{
        padding: '14px 16px', borderRadius: 'var(--r3)',
        background: 'var(--s)', border: '1px solid var(--brd)',
        color: 'var(--t2)', fontSize: '12.5px', textAlign: 'center',
      }}>
        {t('cc_activity_empty', lang)}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {entries.map(entry => (
        <PhoenixCard key={entry.id} padding="10px 14px">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: '12.5px', fontWeight: 600 }} dir="auto">{entry.title}</div>
              {entry.subtitle && (
                <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }} dir="auto">{entry.subtitle}</div>
              )}
            </div>
            {entry.timestamp && (
              <div style={{ fontSize: '10.5px', color: 'var(--t2)' }} dir="ltr">{entry.timestamp}</div>
            )}
          </div>
        </PhoenixCard>
      ))}
    </div>
  );
}

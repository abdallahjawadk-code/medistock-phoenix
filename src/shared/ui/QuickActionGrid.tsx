import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon, type PhoenixIconName } from './PhoenixIcon';

/** UX-COMMAND-CENTER-SMART-A — a single quick-action tile. */
export interface QuickAction {
  screen: number;
  icon: PhoenixIconName;
  labelKey: string;
}

interface Props {
  actions: QuickAction[];
  onNavigate: (screen: number) => void;
}

/**
 * Premium quick-action tile grid. Every action navigates via the existing
 * `onNavigate` screen-switch mechanism only — no new routes, no new backend
 * actions. Wraps/stacks cleanly on mobile (auto-fit grid, min 44px touch
 * height per tile).
 */
export function QuickActionGrid({ actions, onNavigate }: Props) {
  const { lang } = useApp();

  return (
    <div
      className="premium-quick-action-grid"
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: '10px',
      }}
    >
      {actions.map(action => (
        <button
          key={action.screen}
          type="button"
          onClick={() => onNavigate(action.screen)}
          className="premium-quick-action premium-focus-ring premium-3d-hover"
          style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            padding: '12px 14px', minHeight: '44px',
            borderRadius: 'var(--r3)', border: '1px solid var(--brd)',
            background: 'var(--s)', color: 'var(--t)', textAlign: 'start',
            cursor: 'pointer', transition: 'all 120ms', width: '100%',
          }}
        >
          <span style={{ display: 'inline-flex', flexShrink: 0, color: 'var(--p)' }} aria-hidden="true">
            <PhoenixIcon name={action.icon} size={18} />
          </span>
          <span style={{ fontSize: '12.5px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {t(action.labelKey, lang)}
          </span>
        </button>
      ))}
    </div>
  );
}

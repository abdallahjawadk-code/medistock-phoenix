import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';

/**
 * UX-SMART-FILTERS-TIMELINE-A — a single smart-filter chip.
 *
 * The caller owns all filtering state and logic; this component is purely
 * presentational (active/onClick wiring only) so it can drive either a
 * single-select group (e.g. status) or independent toggle chips (e.g.
 * "recently updated") without any special-casing here.
 */
export interface SmartFilterChipItem {
  key: string;
  labelKey: string;
  icon?: string;
  active: boolean;
  onClick: () => void;
}

interface Props {
  items: SmartFilterChipItem[];
  ariaLabel: string;
}

export function SmartFilterChips({ items, ariaLabel }: Props) {
  const { lang } = useApp();

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="premium-smart-filter-chips"
      style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}
    >
      {items.map(item => (
        <button
          key={item.key}
          type="button"
          onClick={item.onClick}
          aria-pressed={item.active}
          className="premium-focus-ring premium-smart-filter-chip"
          style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '7px 12px', minHeight: '38px', borderRadius: 'var(--rpill)',
            border: item.active ? '1px solid var(--p)' : '1px solid var(--brd)',
            background: item.active ? 'var(--p2)' : 'var(--s)',
            color: item.active ? 'var(--pd)' : 'var(--t)',
            fontSize: '11.5px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
            transition: 'all 120ms',
          }}
        >
          {item.icon && <span aria-hidden="true">{item.icon}</span>}
          <span>{t(item.labelKey, lang)}</span>
        </button>
      ))}
    </div>
  );
}

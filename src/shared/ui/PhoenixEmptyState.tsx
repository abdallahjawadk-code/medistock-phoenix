import { PhoenixIcon, type PhoenixIconName } from './PhoenixIcon';

interface Props {
  icon?: string;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

const EMPTY_ICON_MAP: Record<string, PhoenixIconName> = {
  '📭': 'status',
  '📋': 'status',
  '🔒': 'lock',
  '🏢': 'warehouse',
  '🏬': 'warehouse',
  '📦': 'warehouse',
  '🏛️': 'institutions',
  '🏛': 'institutions',
  '🧩': 'scope',
  '🔔': 'alerts',
  '🔎': 'search',
  '🔍': 'search',
  '👥': 'users',
  '🗺️': 'network',
  '🗺': 'network',
  '💊': 'outlet',
  '✅': 'check',
};

export function PhoenixEmptyState({ icon = '📭', title, description, action }: Props) {
  const iconName = EMPTY_ICON_MAP[icon];

  return (
    <div className="nexus-empty anim-fs">
      <div className="premium-empty-icon nexus-empty__icon">
        {iconName ? <PhoenixIcon name={iconName} size={28} /> : <span aria-hidden="true">{icon}</span>}
      </div>
      <div className="nexus-empty__title">{title}</div>
      {description && <p>{description}</p>}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="premium-focus-ring premium-action-button nexus-empty__action"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

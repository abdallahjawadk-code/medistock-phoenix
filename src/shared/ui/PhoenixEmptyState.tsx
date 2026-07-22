import { PhoenixIcon, type PhoenixIconName } from './PhoenixIcon';

interface Props {
  /** A canonical PhoenixIconName (preferred). Legacy emoji keys are still
      accepted and mapped to an SVG glyph for backward compatibility. */
  icon?: PhoenixIconName | string;
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
  '🔀': 'route',
  '🧭': 'scope',
  '🕘': 'clock',
  '🕒': 'clock',
  '⏳': 'clock',
};

export function PhoenixEmptyState({ icon = 'status', title, description, action }: Props) {
  // Every empty state renders a deterministic SVG glyph. A canonical
  // lowercase-ascii PhoenixIconName is used directly; a legacy emoji key is
  // mapped; anything unknown falls back to the neutral 'status' icon — never a
  // raw emoji.
  const iconName: PhoenixIconName = /^[a-z]+$/.test(icon)
    ? (icon as PhoenixIconName)
    : (EMPTY_ICON_MAP[icon] ?? 'status');

  return (
    <div className="nexus-empty anim-fs">
      <div className="premium-empty-icon nexus-empty__icon">
        <PhoenixIcon name={iconName} size={28} />
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

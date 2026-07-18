import { PhoenixIcon, type PhoenixIconName } from './PhoenixIcon';

interface Props {
  icon?: PhoenixIconName;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

export function PhoenixEmptyState({ icon = 'status', title, description, action }: Props) {
  return (
    <div className="nexus-empty anim-fs">
      <div className="premium-empty-icon nexus-empty__icon">
        <PhoenixIcon name={icon} size={28} />
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

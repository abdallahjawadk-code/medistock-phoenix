interface Props {
  icon?: string;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

export function PhoenixEmptyState({ icon = '📭', title, description, action }: Props) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--t2)' }}>
      <div style={{ fontSize: '36px', marginBottom: '12px' }}>{icon}</div>
      <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--t)', marginBottom: description ? '6px' : undefined }}>{title}</div>
      {description && <p style={{ fontSize: '12.5px', color: 'var(--t2)', maxWidth: '320px', margin: '0 auto' }}>{description}</p>}
      {action && (
        <button
          onClick={action.onClick}
          style={{
            marginTop: '16px', padding: '9px 18px',
            borderRadius: 'var(--r2)', border: 'none',
            background: 'var(--p)', color: '#fff',
            fontSize: '13px', fontWeight: 600, cursor: 'pointer',
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

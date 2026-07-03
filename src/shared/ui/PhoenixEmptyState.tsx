interface Props {
  icon?: string;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

export function PhoenixEmptyState({ icon = '📭', title, description, action }: Props) {
  return (
    <div className="anim-fs" style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--t2)' }}>
      <div
        className="premium-empty-icon"
        style={{
          width: '64px', height: '64px', margin: '0 auto 14px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '30px', borderRadius: 'var(--r5)',
          background: 'linear-gradient(145deg, var(--p2), color-mix(in srgb, var(--sec2) 55%, var(--p2)))',
        }}
      >
        {icon}
      </div>
      <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--t)', marginBottom: description ? '6px' : undefined }}>{title}</div>
      {description && <p style={{ fontSize: '12.5px', color: 'var(--t2)', maxWidth: '320px', margin: '0 auto' }}>{description}</p>}
      {action && (
        <button
          onClick={action.onClick}
          className="premium-focus-ring premium-action-button"
          style={{
            marginTop: '16px', padding: '10px 20px', minHeight: '42px',
            borderRadius: 'var(--r2)', border: 'none',
            background: 'linear-gradient(145deg, var(--p), var(--pd))', color: '#fff',
            fontSize: '13px', fontWeight: 600, cursor: 'pointer',
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

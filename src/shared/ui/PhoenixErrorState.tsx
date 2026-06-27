interface Props {
  title?: string;
  message: string;
  onRetry?: () => void;
}

export function PhoenixErrorState({ title = 'Error', message, onRetry }: Props) {
  return (
    <div style={{
      background: 'var(--err2)', border: '1px solid var(--err)',
      borderRadius: 'var(--r3)', padding: '20px 24px',
      color: 'var(--err)', textAlign: 'center',
    }}>
      <div style={{ fontSize: '24px', marginBottom: '8px' }}>⚠️</div>
      <div style={{ fontWeight: 700, marginBottom: '6px' }}>{title}</div>
      <p style={{ fontSize: '12.5px', opacity: .85 }}>{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          style={{
            marginTop: '14px', padding: '7px 16px',
            borderRadius: 'var(--r2)', border: '1px solid var(--err)',
            background: 'transparent', color: 'var(--err)',
            fontSize: '12px', fontWeight: 600, cursor: 'pointer',
          }}
        >
          Retry / إعادة المحاولة
        </button>
      )}
    </div>
  );
}

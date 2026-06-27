interface Props { message: string; }

export function PhoenixToast({ message }: Props) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 'calc(var(--bnh) + 12px)',
        insetInlineStart: '50%',
        transform: 'translateX(-50%)',
        padding: '12px 20px',
        borderRadius: 'var(--rpill)',
        background: 'var(--t)',
        color: 'var(--bg)',
        fontSize: '13px',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        boxShadow: 'var(--sh-lg)',
        zIndex: 400,
        animation: 'ti .3s ease',
      }}
    >
      ✅ {message}
    </div>
  );
}

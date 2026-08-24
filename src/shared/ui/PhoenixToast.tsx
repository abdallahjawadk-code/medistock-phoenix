import { PhoenixIcon } from './PhoenixIcon';

interface Props { message: string; }

export function PhoenixToast({ message }: Props) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 'calc(var(--bnh) + 12px + env(safe-area-inset-bottom, 0px))',
        insetInlineStart: '50%',
        transform: 'translateX(-50%)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        padding: '12px 20px',
        borderRadius: 'var(--rpill)',
        background: 'var(--t)',
        color: 'var(--bg)',
        fontSize: '13px',
        fontWeight: 600,
        maxWidth: 'min(640px, calc(100vw - 24px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)))',
        whiteSpace: 'normal',
        textAlign: 'start',
        overflowWrap: 'anywhere',
        boxShadow: 'var(--sh-lg)',
        zIndex: 400,
        animation: 'ti .3s ease',
      }}
    >
      <PhoenixIcon name="check" size={16} inline />
      <span>{message}</span>
    </div>
  );
}

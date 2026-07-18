import { ReactNode, useEffect, useId } from 'react';
import { PhoenixIcon } from './PhoenixIcon';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  maxWidth?: number;
}

export function PhoenixDialog({ open, onClose, title, children, maxWidth = 420 }: Props) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="nexus-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        className="nexus-dialog__backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className="premium-dialog-panel"
        style={{
          position: 'relative',
          background: 'var(--s)',
          borderRadius: 'var(--r5)',
          boxShadow: 'var(--sh-xl)',
          padding: '28px',
          width: '100%',
          maxWidth,
          border: '1px solid var(--brd)',
          animation: 'su .25s ease',
          maxHeight: '90dvh',
          overflowY: 'auto',
        }}
      >
        <div className="nexus-dialog__header">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="nexus-dialog__close premium-focus-ring"
            onClick={onClose}
            aria-label="Close / إغلاق"
          >
            <PhoenixIcon name="close" size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

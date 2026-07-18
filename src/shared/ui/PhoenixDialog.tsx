import { ReactNode, useEffect, useId, useRef } from 'react';
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
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const frame = window.requestAnimationFrame(() => {
      const firstFocusable = panelRef.current?.querySelector<HTMLElement>(focusableSelector);
      (firstFocusable ?? panelRef.current)?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) {
        e.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey);
      previousFocus?.focus();
    };
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
        ref={panelRef}
        tabIndex={-1}
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

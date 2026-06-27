import { ReactNode, useEffect } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  maxWidth?: number;
}

export function PhoenixDialog({ open, onClose, title, children, maxWidth = 420 }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
    >
      <div
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(2px)' }}
      />
      <div
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
        <h2 id="dialog-title" style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px' }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

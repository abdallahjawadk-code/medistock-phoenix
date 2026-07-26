import { ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  maxWidth?: number;
}

/** Selector for elements a focus trap should cycle between — matches every
 *  control PhoenixDialog's various consumers actually render (buttons,
 *  text/number inputs, checkboxes, selects, links). */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function PhoenixDialog({ open, onClose, title, children, maxWidth = 420 }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Focus trap: on open, move focus INTO the dialog and remember what had it;
  // on close, give focus back. While open, Tab/Shift+Tab cycle only among the
  // panel's own focusable elements — they never leak to the page behind the
  // overlay. Presentational only: no dialog's onConfirm/onCancel logic is
  // touched, this only owns where keyboard focus is allowed to land.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = () => (panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : []);
    const first = focusables()[0];
    (first ?? panel)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !panel) return;
      const items = focusables();
      if (items.length === 0) { e.preventDefault(); return; }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === firstEl || !panel.contains(active)) { e.preventDefault(); lastEl.focus(); }
      } else if (active === lastEl || !panel.contains(active)) {
        e.preventDefault(); firstEl.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  // PHOENIX-DIALOG-PORTAL-STACKING-FIX: a real, reproducible bug an
  // authenticated E2E session found — .premium-main's own entrance
  // animation (nexus-page-enter, animating opacity/transform/filter) forces
  // a NEW CSS stacking context on each of .premium-main's direct children
  // for the animation's ~0.4s duration (any element animating those
  // properties does, per spec). A dialog rendered INLINE inside one of
  // those children has its z-index:300 scoped to that temporary, isolated
  // stacking context — it can't out-rank a LATER sibling of that same
  // ancestor (e.g. the page's own copyright <footer>, which paints after
  // the content wrapper in DOM order) using z-index alone, because that
  // comparison never reaches the document root while the animation is
  // active. Concretely: opening this dialog within ~0.4s of the underlying
  // screen (re-)rendering could make its own page footer visually and
  // POINTER-EVENTS-intercept on top of the dialog's own controls.
  //
  // Rendering via a portal straight to document.body removes the dialog
  // from that DOM subtree entirely, so its stacking is never subject to
  // any ancestor's transient animation — the standard, correct fix for
  // this whole class of bug, and why virtually every modal implementation
  // uses a portal. React context still propagates normally through a
  // portal (it follows the component tree, not the DOM tree), so nothing
  // any of this dialog's 22 real consumers rely on changes.
  return createPortal(
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
          outline: 'none',
        }}
      >
        <h2 id="dialog-title" style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px' }}>{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

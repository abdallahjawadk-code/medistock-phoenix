import { useEffect } from 'react';

/** Every control the guide's own panels actually render. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * INTERACTIVE-GUIDE-IG1 — keep Tab inside the guide, and let Escape out.
 *
 * Deliberately the same trap shape as PhoenixDialog and PhoenixMobileDrawer,
 * because a third, subtly different keyboard contract in the same shell is how
 * one of them ends up wrong. Focus enters on mount and the CALLER restores it
 * on close (GuideHost owns the opener; see the note there about the mobile
 * drawer unmounting behind the guide).
 */
export function useGuideFocusTrap(
  panel: HTMLElement | null,
  onEscape: () => void,
  /** Re-run entry focus when the step changes, so a new card is reachable. */
  focusKey: string,
): void {
  useEffect(() => {
    if (!panel) return;
    const focusables = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    (focusables()[0] ?? panel).focus();
  }, [panel, focusKey]);

  useEffect(() => {
    if (!panel) return;
    const focusables = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [panel, onEscape]);
}

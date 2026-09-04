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
  /**
   * Re-run entry focus when this changes. It is the tour and STEP identity —
   * deliberately not the language.
   *
   * A language change re-renders the same card in place: React keeps the very
   * same DOM nodes and only swaps their text, so focus survives on its own and
   * stays on whatever the operator was using — including the guide's own
   * language control, which is the element they just activated. Adding the
   * language here would yank focus away from it on every switch.
   */
  focusKey: string,
  /**
   * Where entry focus should land, if present. Without it, focus goes to the
   * first focusable element, which is the language control in the card header
   * — correct as a tab stop, wrong as the thing a new step opens on. The
   * primary action is what an operator wants under their hands.
   */
  preferredSelector?: string,
): void {
  useEffect(() => {
    if (!panel) return;
    const focusables = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    const preferred = preferredSelector
      ? panel.querySelector<HTMLElement>(preferredSelector)
      : null;
    (preferred ?? focusables()[0] ?? panel).focus();
    // Deliberately keyed on the step alone. `preferredSelector` is a constant
    // at every call site, and re-running entry focus on anything else — the
    // language, most of all — is exactly what the note above rules out.
  }, [panel, focusKey, preferredSelector]);

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

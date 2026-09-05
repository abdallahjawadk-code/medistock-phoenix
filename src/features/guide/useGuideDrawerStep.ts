import { useEffect, useRef } from 'react';

/**
 * INTERACTIVE-GUIDE-IG1.1 — the shell's OWN drawer, borrowed and given back.
 *
 * Two steps need the mobile drawer open to have anything to point at: the
 * authorized screen list, and Guide & Help itself, which lives inside the
 * drawer on a phone. Owner acceptance saw the second one render its
 * missing-target fallback for exactly this reason.
 *
 * The drawer is opened through `PhoenixAppShell`'s existing `sidebarOpen`
 * state and its existing setter — never a synthesised click, and never a
 * second copy of that state. The guide is a reader of the shell's UI state
 * with permission to set it, not an owner of a parallel one.
 */
export interface GuideDrawerController {
  /**
   * True only where the shell actually renders a drawer — the phone layout.
   * On desktop every method below is a deliberate no-op, so a step may declare
   * `requiresDrawer` once and behave correctly at both viewports.
   */
  isAvailable: boolean;
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

/**
 * Hold the drawer open for the steps that need it, and restore what was there
 * before on EVERY way out.
 *
 * `openedByGuide` is the whole contract. If the operator already had the
 * drawer open when a guide-owned step arrived, the guide leaves it open when
 * it moves on — closing it would be the guide undoing a choice that was not
 * its own. Only a drawer the guide opened is a drawer the guide closes.
 *
 * The cleanup covers every exit path at once, because they all end in the same
 * place: Back, Skip, Finish, Escape, Restart, closing the Help Center, losing
 * the session, swapping tours, a target vanishing, or a crash all either move
 * to a step that does not need the drawer (first effect) or unmount the
 * overlay (second effect). None of this is persisted — it is transient
 * presentation state and nothing else.
 */
export function useGuideDrawerStep(
  controller: GuideDrawerController,
  requiresDrawer: boolean,
): void {
  const openedByGuide = useRef(false);
  // Read at the moment an effect runs rather than captured when it was
  // scheduled, so cleanup always talks to the CURRENT shell state.
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  const { isAvailable, isOpen } = controller;

  useEffect(() => {
    const drawer = controllerRef.current;
    if (!drawer.isAvailable) return;

    if (requiresDrawer) {
      if (!drawer.isOpen) {
        openedByGuide.current = true;
        drawer.open();
      }
      return;
    }

    if (openedByGuide.current) {
      openedByGuide.current = false;
      drawer.close();
    }
  }, [requiresDrawer, isAvailable, isOpen]);

  useEffect(() => () => {
    const drawer = controllerRef.current;
    if (!openedByGuide.current) return;
    openedByGuide.current = false;
    drawer.close();
  }, []);
}

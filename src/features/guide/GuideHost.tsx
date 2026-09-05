import { lazy, Suspense, useCallback, useRef, useState } from 'react';

/**
 * INTERACTIVE-GUIDE-IG1 — the always-mounted, near-empty guide host.
 *
 * This is the ONLY guide code the shell links statically, and it is
 * deliberately trivial: an open/closed boolean, the element that opened the
 * guide, and a `lazy()` handle. Until an operator actually asks for help,
 * nothing of the engine, the overlay, the tour registry or the guide's CSS is
 * fetched — `import()` is not evaluated until the component is rendered
 * (AD-07).
 *
 * The opener is captured HERE rather than inside the engine because by the
 * time the engine's chunk has arrived the element may already be gone: the
 * mobile drawer's Help entry unmounts with the drawer it lives in. Capturing
 * at request time, and restoring on close, is what makes "focus returns to
 * whatever opened the guide" true on both surfaces (AD-08).
 */
const GuideEngine = lazy(() =>
  import('./GuideEngine').then(module => ({ default: module.GuideEngine })),
);

export interface GuideHostProps {
  /** The screen currently rendered by the shell. */
  currentScreen: number;
  /**
   * The shell's own screen switch. The guide only ever calls it for a screen
   * the application's canonical authorization already admits for this
   * operator — see guide.permissions.ts — and never as part of an action.
   */
  onNavigate: (screen: number) => void;
}

export interface GuideController {
  open: () => void;
}

/**
 * Owns "is the guide open". Returns the host element plus the single `open`
 * callback the shell hands to its Help entries, so no component other than
 * this one needs to know that the engine is lazy at all.
 */
export function useGuideHost({ currentScreen, onNavigate }: GuideHostProps): {
  controller: GuideController;
  host: React.ReactNode;
} {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);

  const openGuide = useCallback(() => {
    openerRef.current = (typeof document !== 'undefined'
      ? (document.activeElement as HTMLElement | null)
      : null);
    setOpen(true);
  }, []);

  const closeGuide = useCallback(() => {
    setOpen(false);
    // The opener may have unmounted while the guide was open (the mobile
    // drawer closes behind it). `isConnected` is the cheap, correct check;
    // focusing a detached node silently sends focus to <body>.
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener?.isConnected) opener.focus?.();
  }, []);

  return {
    controller: { open: openGuide },
    host: open ? (
      // No visible fallback: the Help Center's own shell renders the loading
      // state, so the operator never sees a full-screen flash between the
      // click and the chunk arriving.
      <Suspense fallback={null}>
        <GuideEngine
          currentScreen={currentScreen}
          onNavigate={onNavigate}
          onClose={closeGuide}
        />
      </Suspense>
    ) : null,
  };
}

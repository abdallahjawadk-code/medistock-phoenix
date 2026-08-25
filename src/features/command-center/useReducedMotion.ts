import { useEffect, useState } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function readSnapshot(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  }
  return false;
}

/**
 * RAC-3 — reactive reduced-motion preference.
 *
 * `prefersReducedMotion()` in shared/webgl already answers this, but it reads
 * once at call time: it cannot respond to the operator changing the setting
 * while a long-lived dashboard is open, and it lives beside the WebGL entry
 * point. This mirrors `useIsMobileViewport` instead — same matchMedia +
 * addEventListener shape, same older-WebView fallback — so a preference change
 * settles the counters immediately rather than at the next navigation.
 *
 * Motion is decoration here: every number this gates is also rendered as text,
 * so returning `true` removes animation without removing information.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readSnapshot);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    setReduced(media.matches);

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    }
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, []);

  return reduced;
}

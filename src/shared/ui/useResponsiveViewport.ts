import { useEffect, useState } from 'react';

export const MOBILE_VIEWPORT_MAX_PX = 767;
export const MOBILE_VIEWPORT_QUERY = `(max-width: ${MOBILE_VIEWPORT_MAX_PX}px)`;

function readMobileSnapshot(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia(MOBILE_VIEWPORT_QUERY).matches;
  }
  return window.innerWidth <= MOBILE_VIEWPORT_MAX_PX;
}

/**
 * Reactive layout capability, not a device/user-agent guess.
 *
 * Feature surfaces use the same 767px boundary as the CSS shell. matchMedia
 * emits on orientation and split-screen transitions; resize is the fallback
 * for older WebViews and test environments without matchMedia.
 */
export function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(readMobileSnapshot);

  useEffect(() => {
    if (typeof window.matchMedia === 'function') {
      const media = window.matchMedia(MOBILE_VIEWPORT_QUERY);
      const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
      setIsMobile(media.matches);

      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', onChange);
        return () => media.removeEventListener('change', onChange);
      }

      media.addListener(onChange);
      return () => media.removeListener(onChange);
    }

    const onResize = () => setIsMobile(window.innerWidth <= MOBILE_VIEWPORT_MAX_PX);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return isMobile;
}

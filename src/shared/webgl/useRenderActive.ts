/* ─── PHOENIX WEBGL — render-active gate ───────────────────────────────────────
   Centralises every reason to STOP feeding the frame governor: a hidden tab, a
   canvas scrolled out of view, a blurred window, and (on non-high devices) a
   focused text input so typing credentials never competes with the GPU. Returns
   a boolean the caller ANDs with its own lifecycle (e.g. "sequence finished").
   ─────────────────────────────────────────────────────────────────────────── */
import { useEffect, useRef, useState, type RefObject } from 'react';

interface Options {
  /** Pause while a text field is focused (used for medium/low tiers). */
  pauseOnInputFocus?: boolean;
}

export function useRenderActive(
  wrapRef: RefObject<HTMLElement | null>,
  { pauseOnInputFocus = false }: Options = {},
): boolean {
  const [active, setActive] = useState(true);
  const onScreen = useRef(true);
  const focused = useRef(false);
  const windowActive = useRef(true);

  useEffect(() => {
    const recompute = () => {
      setActive(
        !document.hidden &&
          onScreen.current &&
          windowActive.current &&
          !(pauseOnInputFocus && focused.current),
      );
    };

    const onVisibility = recompute;
    const onBlur = () => {
      windowActive.current = false;
      recompute();
    };
    const onFocus = () => {
      windowActive.current = true;
      recompute();
    };
    const isField = (el: EventTarget | null) =>
      el instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    const onFocusIn = (e: FocusEvent) => {
      if (!pauseOnInputFocus) return;
      if (isField(e.target)) {
        focused.current = true;
        recompute();
      }
    };
    const onFocusOut = (e: FocusEvent) => {
      if (!pauseOnInputFocus) return;
      if (isField(e.target)) {
        focused.current = false;
        recompute();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);

    let io: IntersectionObserver | null = null;
    if (wrapRef.current && 'IntersectionObserver' in window) {
      io = new IntersectionObserver(
        (entries) => {
          onScreen.current = entries[0]?.isIntersecting ?? true;
          recompute();
        },
        { threshold: 0.01 },
      );
      io.observe(wrapRef.current);
    }

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      io?.disconnect();
    };
  }, [wrapRef, pauseOnInputFocus]);

  return active;
}

/* ─── PHOENIX WEBGL — login entry (interaction-first) ──────────────────────────
   The ONLY module the login screen imports. It renders the approved 2D plate
   IMMEDIATELY and keeps three.js out of the critical path: the WebGL upgrade is
   fetched only when (a) the device is high-tier and the browser has gone idle
   for ~1.5s, or (b) the user signals login intent (focus/submit). Medium/low
   devices keep a cheap 2.5D parallax on the plate and never create a GL context
   for login. Once WebGL paints its first frame the plate is unmounted (the two
   never draw at once); on context-loss the plate returns. Decorative and
   aria-hidden throughout — the form is always usable.
   ─────────────────────────────────────────────────────────────────────────── */
import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PhoenixVariant } from './PhoenixScene';
import { resolveEffects, type ResolvedEffects } from './effectsMode';

const PhoenixCanvas = lazy(() => import('./PhoenixCanvas'));

/** Login screens fire this to pull the WebGL upgrade forward (focus/submit). */
export const LOGIN_INTENT_EVENT = 'phoenix:login-intent';
export function signalLoginIntent(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(LOGIN_INTENT_EVENT));
}

interface Props {
  variant: PhoenixVariant;
  /** Always-rendered 2D layer; also the permanent fallback when WebGL is off. */
  fallback: ReactNode;
  className?: string;
}

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export function PhoenixExperience({ variant, fallback, className }: Props) {
  // Resolve the render plan once, on the client (SSR/tests keep the 2D plate).
  const [effects] = useState<ResolvedEffects | null>(() =>
    typeof window === 'undefined' ? null : resolveEffects(),
  );
  const [enabled, setEnabled] = useState(false); // three chunk requested
  const [ready, setReady] = useState(false); // first WebGL frame painted
  const [failed, setFailed] = useState(false); // context lost → back to plate
  const parallaxRef = useRef<HTMLDivElement>(null);

  // Arm the deferred WebGL upgrade: idle-timer on high tier, plus login intent.
  useEffect(() => {
    if (!effects?.loginWebGL) return;
    const enable = () => setEnabled(true);

    const idle = window as IdleWindow;
    let idleHandle: number | undefined;
    let timeoutHandle: number | undefined;
    if (Number.isFinite(effects.loginIdleMs)) {
      if (idle.requestIdleCallback) {
        idleHandle = idle.requestIdleCallback(enable, { timeout: effects.loginIdleMs });
      } else {
        timeoutHandle = window.setTimeout(enable, effects.loginIdleMs);
      }
    }
    window.addEventListener(LOGIN_INTENT_EVENT, enable, { once: true });
    return () => {
      if (idleHandle !== undefined) idle.cancelIdleCallback?.(idleHandle);
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
      window.removeEventListener(LOGIN_INTENT_EVENT, enable);
    };
  }, [effects]);

  // Cheap 2.5D parallax on the plate for medium/low (no GL context).
  useEffect(() => {
    if (!effects?.loginParallax2D || ready) return;
    const el = parallaxRef.current;
    if (!el) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const x = (e.clientX / window.innerWidth - 0.5) * 2;
        const y = (e.clientY / window.innerHeight - 0.5) * 2;
        el.style.setProperty('--phoenix-px', x.toFixed(3));
        el.style.setProperty('--phoenix-py', y.toFixed(3));
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [effects, ready]);

  const showCanvas = Boolean(effects?.loginWebGL) && enabled && !failed;
  // Keep the plate until WebGL actually paints, then unmount it (no dual draw).
  const showFallback = !showCanvas || !ready;
  const dataEffects = showCanvas && ready ? 'webgl' : 'fallback';

  return (
    <div
      ref={parallaxRef}
      data-effects={dataEffects}
      data-parallax={effects?.loginParallax2D ? '2d' : undefined}
      style={{ display: 'contents' }}
    >
      {showFallback && fallback}
      {showCanvas && effects && (
        <Suspense fallback={null}>
          <PhoenixCanvas
            variant={variant}
            effects={effects}
            className={className}
            onReady={() => setReady(true)}
            onContextLost={() => {
              setFailed(true);
              setReady(false);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

export default PhoenixExperience;

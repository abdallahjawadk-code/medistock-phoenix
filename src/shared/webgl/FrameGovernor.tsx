/* ─── PHOENIX WEBGL — frame-rate governor ──────────────────────────────────────
   With `frameloop="demand"` the Canvas only renders when something calls
   invalidate(). This governor drives that invalidation at a capped rate, so a
   decorative backdrop never burns a full 60fps of GPU/main-thread time. When
   `active` is false it schedules nothing at all — the exact mechanism used to
   pause on hidden tab / offscreen / blur / focused input / finished sequence.
   Imports R3F, so it only ever ships inside the lazy WebGL chunk.
   ─────────────────────────────────────────────────────────────────────────── */
import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';

interface Props {
  fps: number;
  active: boolean;
  /** Fired once, after the first successful render, so callers can drop the 2D fallback. */
  onReady?: () => void;
}

export function FrameGovernor({ fps, active, onReady }: Props) {
  const invalidate = useThree((s) => s.invalidate);

  // Announce the first painted frame exactly once.
  useEffect(() => {
    if (!onReady) return;
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => onReady());
    });
    return () => cancelAnimationFrame(raf);
  }, [onReady]);

  useEffect(() => {
    if (!active) return;
    const interval = 1000 / Math.max(1, fps);
    let raf = 0;
    let last = -Infinity;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (t - last >= interval) {
        last = t;
        invalidate();
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [fps, active, invalidate]);

  return null;
}

export default FrameGovernor;

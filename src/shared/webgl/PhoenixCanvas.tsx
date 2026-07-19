/* ─── PHOENIX WEBGL — Canvas host (perf + resilience owner) ────────────────────
   Wraps the R3F <Canvas> and owns everything the scene must NOT: capped DPR,
   frameloop pausing when the tab is hidden or the canvas scrolls offscreen,
   WebGL context-loss handling (falls back to 2D instead of a blank canvas), and
   a static single-frame mode for prefers-reduced-motion. Imports three/R3F, so
   it is always loaded lazily by <PhoenixExperience>.
   ─────────────────────────────────────────────────────────────────────────── */
import { useEffect, useRef, useState } from 'react';
import { Canvas, type RootState } from '@react-three/fiber';
import { PhoenixScene, type PhoenixVariant } from './PhoenixScene';
import { deviceProfile, prefersReducedMotion } from './webglSupport';

interface Props {
  variant: PhoenixVariant;
  /** Rendered instead of the canvas if the GL context is lost and not restored. */
  onContextLost?: () => void;
  className?: string;
}

export function PhoenixCanvas({ variant, onContextLost, className }: Props) {
  const profile = useRef(deviceProfile()).current;
  const still = useRef(prefersReducedMotion()).current;
  // 'never' while hidden/offscreen; 'demand' for the static frame; else 'always'.
  const [frameloop, setFrameloop] = useState<'always' | 'never' | 'demand'>(
    still ? 'demand' : 'always',
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  const onScreen = useRef(true);
  const rootRef = useRef<RootState | null>(null);

  // Pause rendering when the document is hidden or the canvas leaves the viewport.
  useEffect(() => {
    if (still) return; // static frame: nothing to pause.
    const recompute = () => {
      const active = !document.hidden && onScreen.current;
      setFrameloop(active ? 'always' : 'never');
    };
    document.addEventListener('visibilitychange', recompute);

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
      document.removeEventListener('visibilitychange', recompute);
      io?.disconnect();
    };
  }, [still]);

  function handleCreated(state: RootState) {
    rootRef.current = state;
    const canvas = state.gl.domElement;
    const lost = (e: Event) => {
      e.preventDefault(); // allows a later restore
      onContextLost?.();
    };
    canvas.addEventListener('webglcontextlost', lost, false);
    // Draw the single composed frame for the reduced-motion path.
    if (still) state.invalidate();
    // Stash the remover on the state for cleanup by R3F on unmount.
    state.gl.domElement.addEventListener('webglcontextrestored', () => state.invalidate(), false);
    (state.gl as unknown as { __phoenixCleanup?: () => void }).__phoenixCleanup = () =>
      canvas.removeEventListener('webglcontextlost', lost, false);
  }

  return (
    <div ref={wrapRef} className={className} aria-hidden="true">
      <Canvas
        frameloop={frameloop}
        dpr={[1, profile.dprCap]}
        camera={{ position: [0, 0, 5.2], fov: 42, near: 0.1, far: 40 }}
        gl={{ antialias: !profile.lowPower, alpha: false, powerPreference: 'high-performance' }}
        onCreated={handleCreated}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      >
        <PhoenixScene
          variant={variant}
          particleCount={profile.particleCount}
          still={still}
          parallax={profile.isMobile ? 0 : 0.9}
        />
      </Canvas>
    </div>
  );
}

export default PhoenixCanvas;

/* ─── PHOENIX WEBGL — Canvas host (perf + resilience owner) ────────────────────
   Wraps the R3F <Canvas> and owns everything the scene must NOT: capped DPR, a
   frame-capped `demand` loop (never a free-running 60fps for a login backdrop),
   pausing when the tab is hidden / the canvas scrolls offscreen / the window
   blurs / a field is focused on non-high devices, WebGL context-loss handling
   (falls back to 2D instead of a blank canvas), and a first-frame `onReady`
   signal so the caller can drop the 2D plate (never draw both at once). Imports
   three/R3F, so it is always loaded lazily by <PhoenixExperience>.
   ─────────────────────────────────────────────────────────────────────────── */
import { useRef } from 'react';
import { Canvas, type RootState } from '@react-three/fiber';
import { PhoenixScene, type PhoenixVariant } from './PhoenixScene';
import { FrameGovernor } from './FrameGovernor';
import { useRenderActive } from './useRenderActive';
import type { ResolvedEffects } from './effectsMode';

interface Props {
  variant: PhoenixVariant;
  effects: ResolvedEffects;
  /** Fired after the first painted WebGL frame — the cue to unmount the 2D plate. */
  onReady?: () => void;
  /** Rendered instead of the canvas if the GL context is lost and not restored. */
  onContextLost?: () => void;
  className?: string;
}

// A login backdrop is decorative parallax — 30fps is plenty and stays calm.
const LOGIN_FPS = 30;

export function PhoenixCanvas({ variant, effects, onReady, onContextLost, className }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // On non-high devices, pause while the user is typing credentials.
  const active = useRenderActive(wrapRef, { pauseOnInputFocus: effects.tier !== 'high' });

  function handleCreated(state: RootState) {
    const canvas = state.gl.domElement;
    const lost = (e: Event) => {
      e.preventDefault(); // allows a later restore
      onContextLost?.();
    };
    canvas.addEventListener('webglcontextlost', lost, false);
    canvas.addEventListener('webglcontextrestored', () => state.invalidate(), false);
    (state.gl as unknown as { __phoenixCleanup?: () => void }).__phoenixCleanup = () =>
      canvas.removeEventListener('webglcontextlost', lost, false);
  }

  return (
    <div ref={wrapRef} className={className} aria-hidden="true">
      <Canvas
        frameloop="demand"
        dpr={[1, effects.dprCap]}
        camera={{ position: [0, 0, 5.2], fov: 42, near: 0.1, far: 40 }}
        gl={{ antialias: effects.antialias, alpha: false, powerPreference: 'high-performance' }}
        onCreated={handleCreated}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      >
        <FrameGovernor fps={LOGIN_FPS} active={active} onReady={onReady} />
        <PhoenixScene
          variant={variant}
          particleCount={effects.particleCount}
          still={false}
          parallax={effects.profile.isMobile ? 0 : 0.9}
        />
      </Canvas>
    </div>
  );
}

export default PhoenixCanvas;

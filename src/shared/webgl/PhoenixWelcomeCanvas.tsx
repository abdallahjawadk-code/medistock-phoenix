/* ─── PHOENIX WEBGL — rebirth Canvas host ──────────────────────────────────────
   Hosts the short rebirth sequence. Runs a frame-capped `demand` loop (24–45fps
   by tier — never a free 60), caps DPR/particles/antialias by device, reports
   the first painted frame via onReady (so the caller can drop a stalled scene at
   500ms), pauses when the tab is hidden or the window blurs, and on context loss
   reports upward so the welcome finishes on the CSS fallback instead of a blank
   canvas. Lazy-loaded so three.js never ships to the reduced-motion / off path.
   ─────────────────────────────────────────────────────────────────────────── */
import { useRef } from 'react';
import { Canvas, type RootState } from '@react-three/fiber';
import { PhoenixWelcomeScene } from './PhoenixWelcomeScene';
import { FrameGovernor } from './FrameGovernor';
import { useRenderActive } from './useRenderActive';
import type { ResolvedEffects } from './effectsMode';

interface Props {
  durationMs: number;
  effects: ResolvedEffects;
  onDone: () => void;
  onReady?: () => void;
  onContextLost?: () => void;
}

export function PhoenixWelcomeCanvas({ durationMs, effects, onDone, onReady, onContextLost }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const active = useRenderActive(wrapRef);

  function handleCreated(state: RootState) {
    const canvas = state.gl.domElement;
    canvas.addEventListener(
      'webglcontextlost',
      (e) => {
        e.preventDefault();
        onContextLost?.();
      },
      false,
    );
  }

  return (
    <div ref={wrapRef} className="nexus-welcome__webgl" aria-hidden="true">
      <Canvas
        frameloop="demand"
        dpr={[1, effects.dprCap]}
        camera={{ position: [0, -0.5, 8.2], fov: 44, near: 0.1, far: 50 }}
        gl={{ antialias: effects.antialias, alpha: false, powerPreference: 'high-performance' }}
        onCreated={handleCreated}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      >
        <FrameGovernor fps={effects.welcomeFps} active={active} onReady={onReady} />
        <PhoenixWelcomeScene
          particleCount={effects.welcomeParticles}
          durationMs={durationMs}
          onDone={onDone}
        />
      </Canvas>
    </div>
  );
}

export default PhoenixWelcomeCanvas;

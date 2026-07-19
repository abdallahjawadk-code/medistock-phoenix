/* ─── PHOENIX WEBGL — rebirth Canvas host ──────────────────────────────────────
   Hosts the rebirth scene. Runs frameloop="always" for the short sequence
   duration, caps DPR by device, and on WebGL context loss reports upward so the
   welcome finishes gracefully instead of stalling on a blank canvas. Lazy-loaded
   by PhoenixWelcomeExperience so three.js is never fetched on the reduced-motion
   / no-WebGL path.
   ─────────────────────────────────────────────────────────────────────────── */
import { useRef } from 'react';
import { Canvas, type RootState } from '@react-three/fiber';
import { PhoenixWelcomeScene } from './PhoenixWelcomeScene';
import { deviceProfile } from './webglSupport';

interface Props {
  durationMs: number;
  onDone: () => void;
  onContextLost?: () => void;
}

export function PhoenixWelcomeCanvas({ durationMs, onDone, onContextLost }: Props) {
  const profile = useRef(deviceProfile()).current;

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
    <div className="nexus-welcome__webgl" aria-hidden="true">
      <Canvas
        frameloop="always"
        dpr={[1, profile.dprCap]}
        camera={{ position: [0, -0.5, 8.2], fov: 44, near: 0.1, far: 50 }}
        gl={{ antialias: !profile.lowPower, alpha: false, powerPreference: 'high-performance' }}
        onCreated={handleCreated}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      >
        <PhoenixWelcomeScene
          particleCount={Math.round(profile.particleCount * 1.15)}
          durationMs={durationMs}
          onDone={onDone}
        />
      </Canvas>
    </div>
  );
}

export default PhoenixWelcomeCanvas;

/* ─── PHOENIX WEBGL — rebirth stage (lazy boundary) ────────────────────────────
   Thin Suspense/lazy wrapper the welcome screen renders ONLY after it has
   decided WebGL is available and motion is allowed. Keeps the three.js chunk out
   of the reduced-motion / no-WebGL / off path entirely.
   ─────────────────────────────────────────────────────────────────────────── */
import { Suspense, lazy } from 'react';
import type { ResolvedEffects } from './effectsMode';

const PhoenixWelcomeCanvas = lazy(() => import('./PhoenixWelcomeCanvas'));

interface Props {
  durationMs: number;
  effects: ResolvedEffects;
  onDone: () => void;
  onReady?: () => void;
  onContextLost?: () => void;
}

export function PhoenixWelcomeStage({ durationMs, effects, onDone, onReady, onContextLost }: Props) {
  return (
    <Suspense fallback={null}>
      <PhoenixWelcomeCanvas
        durationMs={durationMs}
        effects={effects}
        onDone={onDone}
        onReady={onReady}
        onContextLost={onContextLost}
      />
    </Suspense>
  );
}

export default PhoenixWelcomeStage;

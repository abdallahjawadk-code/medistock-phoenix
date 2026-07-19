/* ─── PHOENIX WEBGL — rebirth stage (lazy boundary) ────────────────────────────
   Thin Suspense/lazy wrapper the welcome screen renders ONLY after it has
   decided WebGL is available and motion is allowed. Keeps the three.js chunk out
   of the reduced-motion / no-WebGL path entirely.
   ─────────────────────────────────────────────────────────────────────────── */
import { Suspense, lazy } from 'react';

const PhoenixWelcomeCanvas = lazy(() => import('./PhoenixWelcomeCanvas'));

interface Props {
  durationMs: number;
  onDone: () => void;
  onContextLost?: () => void;
}

export function PhoenixWelcomeStage({ durationMs, onDone, onContextLost }: Props) {
  return (
    <Suspense fallback={null}>
      <PhoenixWelcomeCanvas durationMs={durationMs} onDone={onDone} onContextLost={onContextLost} />
    </Suspense>
  );
}

export default PhoenixWelcomeStage;

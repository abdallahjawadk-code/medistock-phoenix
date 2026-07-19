/* ─── PHOENIX WEBGL — top-level entry with real 2D fallback ────────────────────
   The ONLY module screens import. It decides — before any three code is fetched
   — whether the device may render the 3D scene. If yes, it lazy-loads
   <PhoenixCanvas> (a separate chunk, so three.js never ships to the 2D path). If
   WebGL is unsupported, Save-Data is on, or the GL context is later lost, it
   renders the caller's 2D `fallback` (the approved plate / CSS atmosphere). The
   scene is decorative and aria-hidden; the surrounding UI is always usable.
   ─────────────────────────────────────────────────────────────────────────── */
import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react';
import type { PhoenixVariant } from './PhoenixScene';
import { shouldRenderWebGL } from './webglSupport';

const PhoenixCanvas = lazy(() => import('./PhoenixCanvas'));

interface Props {
  variant: PhoenixVariant;
  /** Always-rendered 2D layer; also the fallback when WebGL is unavailable. */
  fallback: ReactNode;
  className?: string;
}

export function PhoenixExperience({ variant, fallback, className }: Props) {
  // Decide on the client only (SSR/tests fall back to 2D). Starting false keeps
  // the very first paint on the cheap 2D layer, then upgrades if capable.
  const [enabled, setEnabled] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (shouldRenderWebGL()) setEnabled(true);
  }, []);

  const showCanvas = enabled && !failed;

  return (
    <>
      {/* The 2D fallback always occupies the layer; the canvas overlays it when
          active so there is never a blank frame during lazy load or on loss. */}
      {fallback}
      {showCanvas && (
        <Suspense fallback={null}>
          <PhoenixCanvas
            variant={variant}
            className={className}
            onContextLost={() => setFailed(true)}
          />
        </Suspense>
      )}
    </>
  );
}

export default PhoenixExperience;

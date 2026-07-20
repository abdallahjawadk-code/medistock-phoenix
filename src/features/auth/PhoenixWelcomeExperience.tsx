import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useApp } from '@/app/AppContext';
import { PhoenixMark } from '@/shared/ui/PhoenixMark';
import { PhoenixWelcomeStage, resolveEffects, prefersReducedMotion } from '@/shared/webgl';

interface Props {
  onComplete: () => void;
}

const SEQUENCE_MS = 5200;
const REDUCED_MS = 900;
// If the first WebGL frame has not landed this fast, drop to the CSS fallback so
// the sequence never stalls waiting on the three.js chunk.
const WEBGL_READY_BUDGET_MS = 500;

/**
 * Phoenix rebirth welcome. When WebGL is available and motion is allowed, a real
 * 3D rebirth sequence plays (ash → burst → re-form → ignite → rise, ~5.2s) and
 * drives completion. On reduced-motion / no-WebGL / context-loss it degrades to
 * the CSS atmosphere with a short static hold. The credits are always live React
 * text — never baked into a texture. Skip is always available; the sequence
 * shows once per session (gated by the caller).
 */
export function PhoenixWelcomeExperience({ onComplete }: Props) {
  const { lang } = useApp();
  const [phase, setPhase] = useState<'ember' | 'rise'>('ember');
  // Resolve the render plan once, on the client, at mount.
  const [effects] = useState(() => resolveEffects());
  const useWebGL = effects.welcomeWebGL;
  const [webglFailed, setWebglFailed] = useState(false);
  const [ready, setReady] = useState(false);
  // Once true the Canvas is unmounted immediately (dispose) — used by skip/done.
  const [stopped, setStopped] = useState(false);
  const completed = useRef(false);

  const finish = useCallback(() => {
    // Tear down the GL scene first so dispose runs before the overlay unmounts.
    setStopped(true);
    if (completed.current) return;
    completed.current = true;
    onComplete();
  }, [onComplete]);

  useEffect(() => {
    const reducedMotion = prefersReducedMotion();
    // CSS "ember → rise" pacing for the 2D path / overlay copy reveal.
    const riseTimer = window.setTimeout(() => setPhase('rise'), reducedMotion ? 60 : 780);
    // Safety net: always finish even if the WebGL onDone never fires (e.g. the
    // tab was backgrounded and rAF stalled). Slightly longer than the sequence.
    const total = reducedMotion ? REDUCED_MS : useWebGL ? SEQUENCE_MS + 900 : SEQUENCE_MS;
    const finishTimer = window.setTimeout(finish, total);
    return () => {
      window.clearTimeout(riseTimer);
      window.clearTimeout(finishTimer);
    };
  }, [finish, useWebGL]);

  // Don't let a slow three.js chunk hold the sequence hostage: fall back to the
  // CSS atmosphere if the first frame misses the budget.
  useEffect(() => {
    if (!useWebGL || ready) return;
    const t = window.setTimeout(() => {
      if (!ready) setWebglFailed(true);
    }, WEBGL_READY_BUDGET_MS);
    return () => window.clearTimeout(t);
  }, [useWebGL, ready]);

  const webglActive = useWebGL && !webglFailed && !stopped;

  return (
    <div
      className="nexus-welcome"
      data-phase={phase}
      data-webgl={webglActive ? 'on' : 'off'}
      role="dialog"
      aria-modal="true"
      aria-label={lang === 'ar' ? 'مرحبًا بك في ميدي ستوك فينيكس' : 'Welcome to MediStock Phoenix'}
    >
      {/* Real 3D rebirth layer. The CSS atmosphere below is the 2D fallback. */}
      {webglActive && (
        <PhoenixWelcomeStage
          durationMs={SEQUENCE_MS}
          effects={effects}
          onDone={finish}
          onReady={() => setReady(true)}
          onContextLost={() => setWebglFailed(true)}
        />
      )}

      <div className="nexus-welcome__atmosphere" aria-hidden="true">
        <div className="nexus-welcome__aurora nexus-welcome__aurora--one" />
        <div className="nexus-welcome__aurora nexus-welcome__aurora--two" />
        <div className="nexus-welcome__grid" />
        <div className="nexus-welcome__horizon" />
        {Array.from({ length: 24 }, (_, index) => (
          <span
            key={index}
            className="nexus-welcome__particle"
            style={{ '--particle-index': index } as CSSProperties}
          />
        ))}
      </div>

      <button type="button" className="nexus-welcome__skip nexus-control" onClick={finish}>
        {lang === 'ar' ? 'تخطي المشهد' : 'Skip sequence'}
      </button>

      <div className="nexus-welcome__content">
        {/* The CSS sigil is decorative fallback art; hide it when the real 3D
            phoenix is on screen so the two never overlap. */}
        {!webglActive && (
          <div className="nexus-welcome__sigil" aria-hidden="true">
            <div className="nexus-welcome__orbit nexus-welcome__orbit--outer" />
            <div className="nexus-welcome__orbit nexus-welcome__orbit--inner" />
            <div className="nexus-welcome__flare" />
            <PhoenixMark className="nexus-welcome__phoenix" size="100%" title="" />
          </div>
        )}

        <div className="nexus-welcome__copy">
          <div className="nexus-welcome__kicker">MEDISTOCK PHOENIX</div>
          <h1 className="nexus-welcome__title" dir="rtl">دائرة صحة بابل — قسم الصيدلة</h1>
          <p className="nexus-welcome__department">
            {lang === 'ar' ? 'منظومة الإمداد الدوائي الذكية' : 'Intelligent medicine supply network'}
          </p>

          {/* Issuance & supervision credits — the exact approved Arabic text,
              verbatim from the approved design source. Always rendered in
              Arabic (dir=rtl) so the official credit is never re-translated,
              regardless of the UI language. */}
          <div className="nexus-welcome__credits" dir="rtl">
            <div className="nexus-welcome__credits-label">إصدار وإشراف</div>
            <div className="nexus-welcome__credits-name">الصيدلاني عبدالله جواد كاظم</div>
            <div className="nexus-welcome__credits-rule" aria-hidden="true" />
            <div className="nexus-welcome__credits-sup">بإشراف الصيدلاني باسم كاظم رمح</div>
          </div>
        </div>

        <div className="nexus-welcome__progress" aria-hidden="true">
          <span />
        </div>
      </div>
    </div>
  );
}

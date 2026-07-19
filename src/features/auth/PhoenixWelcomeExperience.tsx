import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useApp } from '@/app/AppContext';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixMark } from '@/shared/ui/PhoenixMark';
import { PhoenixWelcomeStage, shouldRenderWebGL, prefersReducedMotion } from '@/shared/webgl';

interface Props {
  onComplete: () => void;
}

const SEQUENCE_MS = 5200;
const REDUCED_MS = 900;

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
  // Decide the render path once, on the client, at mount.
  const [useWebGL] = useState(() => shouldRenderWebGL() && !prefersReducedMotion());
  const [webglFailed, setWebglFailed] = useState(false);
  const completed = useRef(false);

  const finish = useCallback(() => {
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

  const webglActive = useWebGL && !webglFailed;

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
          onDone={finish}
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
          <div className="nexus-welcome__kicker">
            <span className="nexus-welcome__pulse" />
            {lang === 'ar' ? 'منظومة الإمداد الدوائي الذكية' : 'INTELLIGENT MEDICINE SUPPLY NETWORK'}
          </div>
          <h1>MediStock Phoenix</h1>
          <p className="nexus-welcome__department">
            {lang === 'ar' ? 'دائرة صحة بابل · قسم الصيدلة' : 'Babil Health Directorate · Pharmacy Department'}
          </p>

          <div className="nexus-welcome__credits">
            <div>
              <PhoenixIcon name="check" size={15} />
              <span>
                {lang === 'ar'
                  ? 'تم إصدار هذا النظام بواسطة الصيدلاني عبدالله جواد كاظم'
                  : 'System issued by Pharmacist Abdallah Jawad Kadhim'}
              </span>
            </div>
            <div>
              <PhoenixIcon name="role" size={15} />
              <span>
                {lang === 'ar'
                  ? 'بإشراف الصيدلاني باسم كاظم رمح'
                  : 'Supervised by Pharmacist Basim Kadhim Rumaih'}
              </span>
            </div>
          </div>
        </div>

        <div className="nexus-welcome__progress" aria-hidden="true">
          <span />
        </div>
      </div>
    </div>
  );
}

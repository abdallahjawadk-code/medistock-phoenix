import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useApp } from '@/app/AppContext';
import { prefersReducedMotion } from '@/shared/webgl';

interface Props {
  onComplete: () => void;
}

const SEQUENCE_MS = 6000;
const REDUCED_MS = 900;

/**
 * Phoenix rebirth welcome. The approved clean-plate master IS the dominant
 * full-screen artwork (obsidian, no white overexposure) — it is never replaced
 * by a WebGL reconstruction. Motion is a controlled cinematic reveal: a gentle
 * fade-in, a slow camera push, and drifting embers over the plate. The title and
 * the exact issuance/supervision credits are always live React text — never baked
 * into the texture. Skip is available from the first frame; the sequence shows
 * once per session (gated by the caller). On reduced-motion it holds the still
 * keyframe with only a short fade.
 */
export function PhoenixWelcomeExperience({ onComplete }: Props) {
  const { lang } = useApp();
  const [phase, setPhase] = useState<'ember' | 'rise'>('ember');
  const completed = useRef(false);

  const finish = useCallback(() => {
    if (completed.current) return;
    completed.current = true;
    onComplete();
  }, [onComplete]);

  useEffect(() => {
    const reduced = prefersReducedMotion();
    // ash → rise reveal pacing for the plate + copy.
    const riseTimer = window.setTimeout(() => setPhase('rise'), reduced ? 60 : 700);
    // Always finish, even if the tab is backgrounded and rAF stalls.
    const finishTimer = window.setTimeout(finish, reduced ? REDUCED_MS : SEQUENCE_MS);
    return () => {
      window.clearTimeout(riseTimer);
      window.clearTimeout(finishTimer);
    };
  }, [finish]);

  return (
    <div
      className="nexus-welcome"
      data-phase={phase}
      role="dialog"
      aria-modal="true"
      aria-label={lang === 'ar' ? 'مرحبًا بك في ميدي ستوك فينيكس' : 'Welcome to MediStock Phoenix'}
    >
      {/* Dominant full-screen approved Phoenix (clean-plate master, AVIF→WebP). */}
      <div className="nexus-welcome__stage" aria-hidden="true">
        <picture>
          <source srcSet="/assets/phoenix/runtime/phoenix-welcome-clean.avif" type="image/avif" />
          <source srcSet="/assets/phoenix/runtime/phoenix-welcome-clean.webp" type="image/webp" />
          <img
            className="nexus-welcome__plate"
            src="/assets/phoenix/runtime/phoenix-welcome-clean.webp"
            alt=""
            width={1680}
            height={941}
            decoding="async"
            loading="eager"
          />
        </picture>
        <div className="nexus-welcome__scrim" />
        <div className="nexus-welcome__embers">
          {Array.from({ length: 18 }, (_, i) => (
            <span
              key={i}
              className="nexus-welcome__particle"
              style={{ '--particle-index': i } as CSSProperties}
            />
          ))}
        </div>
      </div>

      <button type="button" className="nexus-welcome__skip nexus-control" onClick={finish}>
        {lang === 'ar' ? 'تخطي' : 'Skip'}
      </button>

      <header className="nexus-welcome__masthead">
        <div className="nexus-welcome__kicker">MEDISTOCK PHOENIX</div>
        <h1 className="nexus-welcome__title" dir="rtl">دائرة صحة بابل - قسم الصيدلة</h1>
      </header>

      {/* Approved issuance credit — the EXACT approved Arabic text, verbatim
          per the authoritative handoff. Do not paraphrase.
          PHASE3-LIVING-INTERFACE-CREDIT-REMOVAL-A: the separate supervision
          credit line naming the supervising pharmacist, and its divider rule,
          were intentionally removed — a later, explicit product decision that
          supersedes the prior "verbatim per the authoritative handoff" note
          for that line specifically. Always rendered in Arabic (dir=rtl)
          regardless of the UI language. */}
      <div className="nexus-welcome__credits" dir="rtl">
        <div className="nexus-welcome__credits-name">تم إصدار هذا النظام بواسطة الصيدلاني عبدالله جواد كاظم</div>
        {/* RIGHTS-SEAL-SCOPE: no MASAR seal on the welcome experience — the
            single seal lives in the authenticated shell footer. */}
      </div>
    </div>
  );
}

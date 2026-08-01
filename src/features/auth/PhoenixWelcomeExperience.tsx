import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useApp } from '@/app/AppContext';
import { prefersReducedMotion } from '@/shared/webgl';
import { InstitutionalSupplyMotif } from '@/shared/ui/InstitutionalSupplyMotif';

interface Props {
  onComplete: () => void;
}

const SEQUENCE_MS = 6000;
const REDUCED_MS = 900;

/**
 * Premium living welcome (A7.2). A bounded institutional hero — an original
 * supply-network illustration, never a Phoenix-bird photograph or a WebGL
 * reconstruction — with a calm ember→rise reveal for the title/credits below
 * it. The title and the exact issuance/supervision credits are always live
 * React text — never baked into an image. Skip is available from the first
 * frame; the sequence shows once per session (gated by the caller). On
 * reduced-motion it holds the still keyframe with only a short fade.
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
      {/* Bounded institutional hero — original supply-network illustration,
          never a Phoenix-bird photograph. */}
      <div className="nexus-welcome__stage" aria-hidden="true">
        <InstitutionalSupplyMotif />
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
          STAGE1-SUPERVISION-ATTRIBUTION-A: the supervision credit line naming
          the supervising pharmacist, and its divider rule, are reinstated here
          on the welcome/splash experience by an explicit, later instruction
          that supersedes PHASE3-LIVING-INTERFACE-CREDIT-REMOVAL-A for this
          surface only — the login screen stays without it. Both lines are
          always rendered in Arabic (dir=rtl) regardless of the UI language,
          so neither takes an i18n key and neither has an English
          transliteration. The supervision line is deliberately subordinate:
          smaller and dimmer than the issuance line (see
          .nexus-welcome__credits-sup). */}
      <div className="nexus-welcome__credits" dir="rtl">
        <div className="nexus-welcome__credits-name">تم إصدار هذا النظام بواسطة الصيدلاني عبدالله جواد كاظم</div>
        <div className="nexus-welcome__credits-rule" aria-hidden="true" />
        <div className="nexus-welcome__credits-sup">بإشراف الصيدلاني باسم كاظم رمح</div>
        {/* RIGHTS-SEAL-SCOPE: no MASAR seal on the welcome experience — the
            single seal lives in the authenticated shell footer. */}
      </div>
    </div>
  );
}

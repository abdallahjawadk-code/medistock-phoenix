import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useApp } from '@/app/AppContext';
import { prefersReducedMotion } from '@/shared/webgl';
import { MediStockMark } from '@/shared/ui/MediStockMark';
import { AuthSupplyHero } from '@/shared/ui/AuthSupplyHero';

interface Props {
  onComplete: () => void;
}

const SEQUENCE_MS = 6000;
const REDUCED_MS = 900;

/**
 * Premium living welcome (A7.2.2). A bounded institutional hero — the
 * original pharmaceutical-supply scene, never a Phoenix-bird photograph, a
 * fire/ember identity or a WebGL reconstruction — with a calm reveal for the
 * masthead/credits beneath it and a progress rail paced by this file's own
 * SEQUENCE_MS. The title, lede and the exact issuance/supervision credits
 * are always live React text — never baked into an image. Skip is available
 * from the first frame; the sequence shows once per session (gated by the
 * caller). On reduced-motion it holds the still keyframe with only a short
 * fade.
 *
 * Behaviour is unchanged from A7.2: same timing constants, same finish
 * callback, same once-per-session gating, same reduced-motion path — this
 * pass changed presentation only.
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
      {/* Full-bleed institutional hero — the production pharmaceutical-supply
          photography, never a Phoenix-bird photograph and never a fire/ember
          identity. The scrim is what makes the live text over it legible in
          both themes without baking any text into the artwork. */}
      <div className="nexus-welcome__stage" aria-hidden="true">
        <AuthSupplyHero className="nexus-welcome__hero" />
        <div className="nexus-welcome__scrim" />
      </div>

      <button type="button" className="nexus-welcome__skip nexus-control" onClick={finish}>
        {lang === 'ar' ? 'تخطي' : 'Skip'}
      </button>

      <div className="nexus-welcome__content">
      <header className="nexus-welcome__masthead">
        <div className="nexus-welcome__brand">
          <MediStockMark size={88} className="nexus-welcome__emblem" title="" />
          <div className="nexus-welcome__kicker">MEDISTOCK PHOENIX</div>
        </div>
        <h1 className="nexus-welcome__title" dir="rtl">دائرة صحة بابل - قسم الصيدلة</h1>
        <p className="nexus-welcome__lede" dir="auto">
          {lang === 'ar'
            ? 'منظومة الإمداد الدوائي — من قسم الصيدلة إلى منفذ الصرف.'
            : 'Medication Supply Network — From the Pharmacy Department to the Dispensing Point.'}
        </p>
      </header>

      {/* Calm progress rail. Presentation only: its duration is read from the
          SAME SEQUENCE_MS the completion timer uses, so it can never drift
          from the real sequence, and the phase's global reduced-motion rule
          collapses it exactly like every other animation. */}
      <div
        className="nexus-welcome__progress"
        aria-hidden="true"
        style={{ '--welcome-duration': `${SEQUENCE_MS}ms` } as CSSProperties}
      >
        <span className="nexus-welcome__progress-fill" />
      </div>

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
    </div>
  );
}

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useApp } from '@/app/AppContext';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixMark } from '@/shared/ui/PhoenixMark';

interface Props {
  onComplete: () => void;
}

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
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const riseTimer = window.setTimeout(() => setPhase('rise'), reducedMotion ? 80 : 780);
    const finishTimer = window.setTimeout(finish, reducedMotion ? 950 : 5200);
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
        <div className="nexus-welcome__sigil" aria-hidden="true">
          <div className="nexus-welcome__orbit nexus-welcome__orbit--outer" />
          <div className="nexus-welcome__orbit nexus-welcome__orbit--inner" />
          <div className="nexus-welcome__flare" />
          <PhoenixMark className="nexus-welcome__phoenix" size="100%" title="" />
        </div>

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

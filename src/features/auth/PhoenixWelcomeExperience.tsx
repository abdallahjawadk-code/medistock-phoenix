import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixMark } from '@/shared/ui/PhoenixMark';

interface Props {
  onComplete: () => void;
}

type WelcomePhase = 'ignite' | 'burn' | 'ash' | 'rebirth' | 'reveal' | 'depart';
type RenderTier = 'full' | 'compact';

const PHASE_SCHEDULE: ReadonlyArray<readonly [WelcomePhase, number]> = [
  ['burn', 520],
  ['ash', 1740],
  ['rebirth', 2720],
  ['reveal', 4180],
  ['depart', 6550],
];

const PHASE_COPY: Record<WelcomePhase, string> = {
  ignite: 'phoenix_welcome_phase_ignite',
  burn: 'phoenix_welcome_phase_burn',
  ash: 'phoenix_welcome_phase_ash',
  rebirth: 'phoenix_welcome_phase_rebirth',
  reveal: 'phoenix_welcome_phase_reveal',
  depart: 'phoenix_welcome_phase_depart',
};

const EMBERS = Array.from({ length: 40 }, (_, index) => index);
const ASH = Array.from({ length: 22 }, (_, index) => index);
const STARS = Array.from({ length: 28 }, (_, index) => index);

type NavigatorHints = Navigator & {
  deviceMemory?: number;
  connection?: { saveData?: boolean };
};

function detectRenderTier(): RenderTier {
  if (typeof navigator === 'undefined') return 'compact';
  const hints = navigator as NavigatorHints;
  if (
    hints.connection?.saveData ||
    (hints.deviceMemory !== undefined && hints.deviceMemory <= 4) ||
    (hints.hardwareConcurrency !== undefined && hints.hardwareConcurrency <= 4)
  ) return 'compact';
  return 'full';
}

function particleStyle(index: number, family: 'ember' | 'ash' | 'star'): CSSProperties {
  const multiplier = family === 'ember' ? 47 : family === 'ash' ? 61 : 73;
  const x = (index * multiplier + 11) % 100;
  const y = (index * (multiplier - 13) + 7) % 100;
  const drift = ((index % 9) - 4) * (family === 'star' ? 3 : 7);
  const delay = -((index * 0.19) % 4.6);
  const duration = 3.4 + (index % 7) * 0.36;
  const scale = 0.55 + (index % 5) * 0.18;

  return {
    '--particle-x': String(x) + '%',
    '--particle-y': String(y) + '%',
    '--particle-drift': String(drift) + 'px',
    '--particle-delay': String(delay) + 's',
    '--particle-duration': String(duration) + 's',
    '--particle-scale': String(scale),
  } as CSSProperties;
}

export function PhoenixWelcomeExperience({ onComplete }: Props) {
  const { lang } = useApp();
  const [phase, setPhase] = useState<WelcomePhase>('ignite');
  const [renderTier] = useState<RenderTier>(detectRenderTier);
  const [reducedMotion, setReducedMotion] = useState(false);
  const completed = useRef(false);
  const onCompleteRef = useRef(onComplete);
  const skipRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  const finish = useCallback(() => {
    if (completed.current) return;
    completed.current = true;
    onCompleteRef.current();
  }, []);

  useEffect(() => {
    const timers: number[] = [];
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const reduce = media.matches;
    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    document.body.style.overflow = 'hidden';
    setReducedMotion(reduce);

    if (reduce) {
      setPhase('reveal');
      timers.push(window.setTimeout(finish, 1800));
    } else {
      for (const [nextPhase, delay] of PHASE_SCHEDULE) {
        timers.push(window.setTimeout(() => setPhase(nextPhase), delay));
      }
      timers.push(window.setTimeout(finish, 7300));
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish();
    };
    window.addEventListener('keydown', onKeyDown);

    const focusFrame = window.requestAnimationFrame(() => {
      skipRef.current?.focus({ preventScroll: true });
    });

    return () => {
      timers.forEach(timer => window.clearTimeout(timer));
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, [finish]);

  const emberCount = renderTier === 'compact' ? 18 : EMBERS.length;
  const ashCount = renderTier === 'compact' ? 10 : ASH.length;
  const starCount = renderTier === 'compact' ? 14 : STARS.length;

  return (
    <div
      className="nexus-welcome"
      data-phase={phase}
      data-render-tier={renderTier}
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      role="dialog"
      aria-modal="true"
      aria-labelledby="phoenix-welcome-title"
      aria-describedby="phoenix-welcome-credits"
    >
      <div className="nexus-welcome__atmosphere" aria-hidden="true">
        <div className="nexus-welcome__aurora nexus-welcome__aurora--ember" />
        <div className="nexus-welcome__aurora nexus-welcome__aurora--cyan" />
        <div className="nexus-welcome__grid" />
        <div className="nexus-welcome__horizon" />
        <div className="nexus-welcome__vignette" />
        <div className="nexus-welcome__grain" />

        <div className="nexus-welcome__stars">
          {STARS.slice(0, starCount).map(index => (
            <span
              key={index}
              className="nexus-welcome__star"
              style={particleStyle(index, 'star')}
            />
          ))}
        </div>

        <div className="nexus-welcome__ember-field">
          {EMBERS.slice(0, emberCount).map(index => (
            <span
              key={index}
              className="nexus-welcome__ember"
              style={particleStyle(index, 'ember')}
            />
          ))}
        </div>

        <div className="nexus-welcome__ash-field">
          {ASH.slice(0, ashCount).map(index => (
            <span
              key={index}
              className="nexus-welcome__ash"
              style={particleStyle(index, 'ash')}
            />
          ))}
        </div>

        <div className="nexus-welcome__cinema-bar nexus-welcome__cinema-bar--top" />
        <div className="nexus-welcome__cinema-bar nexus-welcome__cinema-bar--bottom" />
      </div>

      <button
        ref={skipRef}
        type="button"
        className="nexus-welcome__skip nexus-control premium-focus-ring"
        onClick={finish}
        aria-label={t('phoenix_welcome_skip', lang)}
      >
        <span>{t('phoenix_welcome_skip', lang)}</span>
        <PhoenixIcon name="close" size={16} />
      </button>

      <main className="nexus-welcome__scene">
        <div className="nexus-welcome__sigil" aria-hidden="true">
          <div className="nexus-welcome__energy-rail nexus-welcome__energy-rail--left" />
          <div className="nexus-welcome__energy-rail nexus-welcome__energy-rail--right" />

          <div className="nexus-welcome__orbit nexus-welcome__orbit--outer">
            <i /><i /><i />
          </div>
          <div className="nexus-welcome__orbit nexus-welcome__orbit--middle" />
          <div className="nexus-welcome__orbit nexus-welcome__orbit--inner" />

          <div className="nexus-welcome__shockwave nexus-welcome__shockwave--one" />
          <div className="nexus-welcome__shockwave nexus-welcome__shockwave--two" />
          <div className="nexus-welcome__shockwave nexus-welcome__shockwave--three" />
          <div className="nexus-welcome__rebirth-flash" />
          <div className="nexus-welcome__solar-core" />

          <PhoenixMark className="nexus-welcome__phoenix nexus-welcome__phoenix--ghost" size="100%" title="" />
          <PhoenixMark className="nexus-welcome__phoenix nexus-welcome__phoenix--burn" size="100%" title="" />
          <PhoenixMark className="nexus-welcome__phoenix nexus-welcome__phoenix--reborn" size="100%" title="" />

          <span className="nexus-welcome__wing-trace nexus-welcome__wing-trace--left" />
          <span className="nexus-welcome__wing-trace nexus-welcome__wing-trace--right" />
          <span className="nexus-welcome__crown-light" />
        </div>

        <section className="nexus-welcome__copy">
          <div className="nexus-welcome__kicker">
            <span className="nexus-welcome__pulse" />
            {t('phoenix_welcome_kicker', lang)}
          </div>

          <h1 id="phoenix-welcome-title">{t('phoenix_welcome_title', lang)}</h1>
          <p className="nexus-welcome__department">{t('phoenix_welcome_department', lang)}</p>

          <div id="phoenix-welcome-credits" className="nexus-welcome__credits">
            <div>
              <span className="nexus-welcome__credit-icon"><PhoenixIcon name="check" size={15} /></span>
              <span>{t('phoenix_welcome_issued_by', lang)}</span>
            </div>
            <div>
              <span className="nexus-welcome__credit-icon"><PhoenixIcon name="role" size={15} /></span>
              <span>{t('phoenix_welcome_supervised_by', lang)}</span>
            </div>
          </div>

          <div className="nexus-welcome__progress" aria-hidden="true">
            <span><i /></span>
          </div>
          <div className="nexus-welcome__sequence-note">
            <PhoenixIcon name={reducedMotion ? 'eye' : 'sparkle'} size={13} />
            {t(reducedMotion ? 'phoenix_welcome_reduced' : 'phoenix_welcome_entering', lang)}
          </div>
        </section>
      </main>

      <div className="nexus-welcome__sr" aria-live="polite" aria-atomic="true">
        {t(PHASE_COPY[phase], lang)}
      </div>
    </div>
  );
}

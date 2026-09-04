import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { GUIDE_REGISTRY } from './guide.registry';
import { canGuideNavigateTo, permittedTours, type GuideAudience } from './guide.permissions';
import {
  clearGuideProgress,
  readGuideProgress,
  rememberClosed,
  rememberCompletion,
  rememberPosition,
  writeGuideProgress,
  type GuideProgress,
} from './guide.progress';
import { guideText, type GuideStep, type GuideTour } from './guide.types';
import { GuideTourOverlay } from './GuideTourOverlay';
import { useGuideBackgroundInert } from './useGuideBackgroundInert';
import { useGuideFocusTrap } from './useGuideFocusTrap';
// Imported here and nowhere else, so Vite emits the guide's stylesheet as part
// of THIS lazily-fetched chunk rather than adding it to the CSS every operator
// downloads at login (AD-07).
import './guide.css';

interface Props {
  currentScreen: number;
  onNavigate: (screen: number) => void;
  onClose: () => void;
}

type Mode =
  | { kind: 'center' }
  | { kind: 'tour'; tourId: string; stepIndex: number };

/**
 * INTERACTIVE-GUIDE-IG1 — the lazily-loaded guide engine.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE MAY NOT DO, and how that is kept true
 *
 * It imports no service, no Supabase client and no RPC wrapper, and it holds
 * no submit handler. That is not a convention: `guide-safety.test.ts` reads
 * this directory's own source and fails the build if such an import appears,
 * and a runtime test drives a whole tour with a spy on the client proving zero
 * calls (AD-04). The one effect the guide has on the outside world is moving
 * the viewport, and — when the operator explicitly asks — switching to a
 * screen their own authorization already admits.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function GuideEngine({ currentScreen, onNavigate, onClose }: Props) {
  const { lang, dir, role, myPermissions, authStatus, session } = useApp();
  const [progress, setProgress] = useState<GuideProgress>(readGuideProgress);
  const [mode, setMode] = useState<Mode>({ kind: 'center' });
  const [resetNotice, setResetNotice] = useState(false);
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);

  const audience = useMemo<GuideAudience>(
    () => ({ role, permissions: myPermissions }),
    [role, myPermissions],
  );

  /**
   * Tours this operator may see, each already narrowed to its permitted steps.
   *
   * Recomputed whenever effective permissions change, so a permission revoked
   * while the guide is open removes its steps rather than leaving a stale tour
   * pointing at a surface the operator no longer holds.
   */
  const available = useMemo(
    () => permittedTours(GUIDE_REGISTRY.tours, audience),
    [audience],
  );

  /**
   * Losing the session closes the guide.
   *
   * An overlay left painted over a login screen would be both wrong and
   * confusing, and the guide has nothing to say to an unauthenticated
   * visitor. Closing is enough: nothing here holds data to discard.
   */
  useEffect(() => {
    if (!session || authStatus !== 'authenticated') onClose();
  }, [session, authStatus, onClose]);

  const persist = useCallback((next: GuideProgress) => {
    setProgress(next);
    writeGuideProgress(next);
  }, []);

  const startTour = useCallback((entry: { tour: GuideTour; steps: GuideStep[] }, stepIndex: number) => {
    const index = Math.min(Math.max(stepIndex, 0), entry.steps.length - 1);
    const step = entry.steps[index];
    /**
     * The one programmatic navigation the guide performs, and only when the
     * operator has just asked for this tour.
     *
     * It is gated on the application's own canonical screen decision, so the
     * guide can never place someone on a screen a click would have been
     * refused, and it is a screen switch — not an action, not a form, not a
     * submission (AD-04).
     */
    if (step?.screen !== undefined
      && step.screen !== currentScreen
      && canGuideNavigateTo(step.screen, audience)) {
      onNavigate(step.screen);
    }
    setMode({ kind: 'tour', tourId: entry.tour.id, stepIndex: index });
    persist(rememberPosition(progress, entry.tour.id, step.id));
  }, [audience, currentScreen, onNavigate, persist, progress]);

  const activeEntry = mode.kind === 'tour'
    ? available.find(entry => entry.tour.id === mode.tourId) ?? null
    : null;

  /**
   * A tour whose steps all disappeared mid-flight returns to the Help Center
   * rather than rendering an empty overlay. This is reachable in practice: a
   * permission reload can narrow the set while the tour is open.
   */
  useEffect(() => {
    if (mode.kind === 'tour' && !activeEntry) setMode({ kind: 'center' });
  }, [mode, activeEntry]);

  const onStepIndexChange = useCallback((index: number) => {
    if (mode.kind !== 'tour' || !activeEntry) return;
    const bounded = Math.min(Math.max(index, 0), activeEntry.steps.length - 1);
    const step = activeEntry.steps[bounded];
    if (step.screen !== undefined
      && step.screen !== currentScreen
      && canGuideNavigateTo(step.screen, audience)) {
      onNavigate(step.screen);
    }
    setMode({ kind: 'tour', tourId: activeEntry.tour.id, stepIndex: bounded });
    persist(rememberPosition(progress, activeEntry.tour.id, step.id));
  }, [mode, activeEntry, currentScreen, audience, onNavigate, persist, progress]);

  const onFinish = useCallback(() => {
    if (!activeEntry) return;
    persist(rememberCompletion(progress, activeEntry.tour.id));
    setMode({ kind: 'center' });
  }, [activeEntry, persist, progress]);

  const onExitTour = useCallback(() => {
    persist(rememberClosed(progress));
    setMode({ kind: 'center' });
  }, [persist, progress]);

  const onResetProgress = useCallback(() => {
    clearGuideProgress();
    setProgress(readGuideProgress());
    setResetNotice(true);
  }, []);

  useGuideBackgroundInert(mode.kind === 'center' ? panel?.parentElement ?? null : null);
  useGuideFocusTrap(mode.kind === 'center' ? panel : null, onClose, `center:${lang}`);

  if (mode.kind === 'tour' && activeEntry) {
    return (
      <GuideTourOverlay
        tour={activeEntry.tour}
        steps={activeEntry.steps}
        stepIndex={Math.min(mode.stepIndex, activeEntry.steps.length - 1)}
        onStepIndexChange={onStepIndexChange}
        onFinish={onFinish}
        onExit={onExitTour}
      />
    );
  }

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="guide-layer"
      dir={dir}
      data-guide-surface="center"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
    >
      <div className="guide-blocker guide-blocker--plain" aria-hidden="true" onClick={onClose} />
      <div
        ref={setPanel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-center-title"
        className="guide-center__panel"
      >
        <div className="guide-center__head">
          <h2 id="guide-center-title" className="guide-center__title">{t('guide_center_title', lang)}</h2>
          <button
            type="button"
            className="guide-btn guide-btn--quiet"
            onClick={onClose}
            aria-label={t('guide_close', lang)}
          >
            <PhoenixIcon name="close" size={18} />
          </button>
        </div>

        <p className="guide-center__intro">{t('guide_center_intro', lang)}</p>

        {available.length === 0 ? (
          /* No tour survived permission filtering. Said as a plain statement
             about availability — it names no tour, no screen and no missing
             permission, because doing so would disclose what exists. */
          <p className="guide-center__empty">{t('guide_no_tours', lang)}</p>
        ) : (
          <div className="guide-center__tours">
            {available.map(entry => {
              const completed = progress.completedTourIds.includes(entry.tour.id);
              const resumable = progress.tourId === entry.tour.id && progress.stepId !== null;
              const resumeIndex = resumable
                ? entry.steps.findIndex(step => step.id === progress.stepId)
                : -1;
              return (
                <article key={entry.tour.id} className="guide-tour-card">
                  <h3 className="guide-tour-card__title">
                    {guideText(entry.tour.title, lang)}
                    {completed && (
                      <span className="guide-tour-card__badge">{t('guide_completed', lang)}</span>
                    )}
                  </h3>
                  <p className="guide-tour-card__desc">{guideText(entry.tour.description, lang)}</p>
                  <div className="guide-tour-card__actions">
                    {/* Resume is offered only when the remembered step still
                        exists in the CURRENT permitted set — a step filtered
                        out since the tour was left must not be resumed into. */}
                    {resumeIndex >= 0 && (
                      <button
                        type="button"
                        className="guide-btn guide-btn--primary"
                        onClick={() => startTour(entry, resumeIndex)}
                      >
                        {t('guide_resume', lang)}
                      </button>
                    )}
                    <button
                      type="button"
                      className={`guide-btn${resumeIndex >= 0 ? '' : ' guide-btn--primary'}`}
                      onClick={() => startTour(entry, 0)}
                    >
                      {resumeIndex >= 0 || completed ? t('guide_restart', lang) : t('guide_start', lang)}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        <div className="guide-center__footer">
          {/* Reset is permanently available, not hidden behind a completed
              tour: it is the operator's way to make the guide forget them on a
              shared workstation (AD-06). */}
          <button type="button" className="guide-btn" onClick={onResetProgress}>
            {t('guide_reset_progress', lang)}
          </button>
          <span className="guide-card__spacer" />
          {resetNotice && (
            <p className="guide-center__status" role="status">{t('guide_reset_done', lang)}</p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

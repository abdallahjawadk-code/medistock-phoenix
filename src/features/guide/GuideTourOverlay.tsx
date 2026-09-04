import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
// Reuse, not re-implement: this is the same reactive `prefers-reduced-motion`
// hook the Command Center already ships. A second copy in this feature would
// give the shell two answers to one browser preference.
import { usePrefersReducedMotion } from '@/features/command-center/useReducedMotion';
import { guideAnchorSelector } from './guide.anchors';
import { guideText, type GuideStep, type GuideTour } from './guide.types';
import {
  isUsableTarget,
  positionGuideCard,
  type PositionedCard,
  type Rect,
} from './guide.position';
import { useGuideBackgroundInert } from './useGuideBackgroundInert';
import { useGuideFocusTrap } from './useGuideFocusTrap';

interface Props {
  tour: GuideTour;
  /** Already narrowed to what this operator may see (guide.permissions.ts). */
  steps: readonly GuideStep[];
  stepIndex: number;
  onStepIndexChange: (index: number) => void;
  onFinish: () => void;
  onExit: () => void;
}

function rectOf(element: Element): Rect {
  const box = element.getBoundingClientRect();
  return { top: box.top, left: box.left, width: box.width, height: box.height };
}

/**
 * Resolve the first anchor of `step` that is usable right now.
 *
 * "Present in the DOM" is not the test — a collapsed panel, a hidden
 * responsive variant and a zero-sized element are all present. The first
 * candidate that is present AND has a usable box wins; if none does, the step
 * renders centred, which is the same treatment a missing anchor gets. The
 * fallback never names the element it could not find (AD-05).
 */
function resolveTarget(step: GuideStep, viewport: { width: number; height: number }): Element | null {
  for (const anchor of step.anchors) {
    const element = document.querySelector(guideAnchorSelector(anchor));
    if (!element) continue;
    if (isUsableTarget(rectOf(element), viewport)) return element;
  }
  return null;
}

export function GuideTourOverlay({
  tour, steps, stepIndex, onStepIndexChange, onFinish, onExit,
}: Props) {
  const { lang, dir } = useApp();
  const reducedMotion = usePrefersReducedMotion();
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [cardNode, setCardNode] = useState<HTMLDivElement | null>(null);
  const measureRef = useRef<() => void>(() => undefined);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [card, setCard] = useState<PositionedCard | null>(null);

  const step = steps[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === steps.length - 1;

  useGuideBackgroundInert(layer);
  // The language is part of the focus key on purpose: switching it re-renders
  // the copy inside the SAME step, and focus must stay on the card rather than
  // fall back to <body>.
  useGuideFocusTrap(cardNode, onExit, `${tour.id}:${step?.id ?? ''}:${lang}`);

  /**
   * Measure the target and place the card.
   *
   * Re-runs on resize, on scroll (captured, so a nested scroller counts too)
   * and whenever the direction, the step or the language changes — the ways a
   * correct placement silently becomes wrong. RTL and LTR go through the SAME
   * function with `dir` as an argument, so the card opens on the same semantic
   * side in both.
   */
  const measure = useCallback(() => {
    if (!step) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const element = resolveTarget(step, viewport);
    if (!element) {
      setTargetRect(null);
      setCard(null);
      return;
    }
    const rect = rectOf(element);
    setTargetRect(rect);

    const size = cardNode
      ? { width: cardNode.offsetWidth, height: cardNode.offsetHeight }
      : { width: 360, height: 220 };
    setCard(positionGuideCard(rect, size, viewport, dir));
  }, [step, dir, cardNode]);

  measureRef.current = measure;

  useLayoutEffect(() => {
    measure();
  }, [measure, lang]);

  useEffect(() => {
    const onChange = () => measureRef.current();
    window.addEventListener('resize', onChange);
    window.addEventListener('orientationchange', onChange);
    // Capture phase: a scroll inside `.premium-main` never bubbles to window.
    document.addEventListener('scroll', onChange, true);
    return () => {
      window.removeEventListener('resize', onChange);
      window.removeEventListener('orientationchange', onChange);
      document.removeEventListener('scroll', onChange, true);
    };
  }, []);

  /**
   * Bring an off-screen target into view once per step.
   *
   * Scrolling is the only thing the guide does to the page, and it is inert:
   * it moves the viewport, never the data. Smooth behaviour is dropped when
   * the operator has asked for reduced motion.
   */
  useEffect(() => {
    if (!step) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    for (const anchor of step.anchors) {
      const element = document.querySelector(guideAnchorSelector(anchor));
      if (!element) continue;
      if (isUsableTarget(rectOf(element), viewport)) return;
      element.scrollIntoView({
        behavior: reducedMotion ? 'auto' : 'smooth',
        block: 'center',
        inline: 'center',
      });
      return;
    }
  }, [step, reducedMotion]);

  const positionLabel = useMemo(
    () => t('guide_step_position', lang)
      .replace('{current}', String(stepIndex + 1))
      .replace('{total}', String(steps.length)),
    [lang, stepIndex, steps.length],
  );

  if (!step || typeof document === 'undefined') return null;

  const centred = card === null || card.placement === 'center';
  const cardStyle = centred ? undefined : { top: `${card.top}px`, left: `${card.left}px` };

  const titleId = 'guide-step-title';
  const bodyId = 'guide-step-body';

  return createPortal(
    <div
      ref={setLayer}
      className="guide-layer"
      dir={dir}
      data-guide-tour={tour.id}
      data-guide-step={step.id}
      data-guide-placement={centred ? 'center' : card.placement}
    >
      {/* Covers the viewport INCLUDING the highlighted element, so the control
          the guide describes cannot be activated by pointer while it is being
          described. Clicking here is deliberately inert rather than a close: a
          stray tap must not throw an operator out of the step they are
          reading, and Escape plus the explicit control are the ways out. */}
      <div className={`guide-blocker${targetRect ? '' : ' guide-blocker--plain'}`} aria-hidden="true" />

      {targetRect && (
        <div
          className="guide-ring"
          aria-hidden="true"
          style={{
            top: `${targetRect.top - 4}px`,
            left: `${targetRect.left - 4}px`,
            width: `${targetRect.width + 8}px`,
            height: `${targetRect.height + 8}px`,
            transition: reducedMotion ? 'none' : undefined,
          }}
        />
      )}

      <div
        ref={setCardNode}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className={`guide-card${centred ? ' guide-card--center' : ''}`}
        style={cardStyle}
      >
        <p className="guide-card__position">{positionLabel}</p>
        <h2 id={titleId} className="guide-card__title">{guideText(step.title, lang)}</h2>
        <p id={bodyId} className="guide-card__body">{guideText(step.body, lang)}</p>

        {/* Said only when the step genuinely could not be anchored, and it
            names nothing: the operator learns that the element is not on this
            screen, not what it is or where it lives. */}
        {centred && step.anchors.length > 0 && (
          <p className="guide-card__note">{t('guide_target_offscreen', lang)}</p>
        )}
        <p className="guide-card__note">{t('guide_view_only', lang)}</p>

        <div className="guide-card__actions">
          <button
            type="button"
            className="guide-btn"
            onClick={() => onStepIndexChange(stepIndex - 1)}
            disabled={isFirst}
          >
            {t('guide_back', lang)}
          </button>
          <button
            type="button"
            className="guide-btn guide-btn--primary"
            onClick={() => (isLast ? onFinish() : onStepIndexChange(stepIndex + 1))}
          >
            {isLast ? t('guide_finish', lang) : t('guide_next', lang)}
          </button>
          <span className="guide-card__spacer" />
          <button type="button" className="guide-btn guide-btn--quiet" onClick={onExit}>
            {t('guide_skip', lang)}
          </button>
        </div>
      </div>

      {/* Step changes are announced politely rather than asserted, so a screen
          reader finishes its current phrase instead of being interrupted on
          every Next. */}
      <div className="guide-sr-only" role="status" aria-live="polite">
        {`${positionLabel} — ${guideText(step.title, lang)}`}
      </div>
    </div>,
    document.body,
  );
}

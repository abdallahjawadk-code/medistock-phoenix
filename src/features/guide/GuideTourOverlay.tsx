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
import { GuideLanguageControl } from './GuideLanguageControl';
import { useGuideDrawerStep, type GuideDrawerController } from './useGuideDrawerStep';

interface Props {
  tour: GuideTour;
  /** Already narrowed to what this operator may see (guide.permissions.ts). */
  steps: readonly GuideStep[];
  stepIndex: number;
  /** IG-1.1 — the shell's own mobile drawer; see useGuideDrawerStep. */
  drawer: GuideDrawerController;
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
function resolveTarget(
  step: GuideStep,
  viewport: { width: number; height: number },
): { element: Element; anchor: string } | null {
  for (const anchor of step.anchors) {
    const element = document.querySelector(guideAnchorSelector(anchor));
    if (!element) continue;
    if (isUsableTarget(rectOf(element), viewport)) return { element, anchor };
  }
  return null;
}

export function GuideTourOverlay({
  tour, steps, stepIndex, drawer, onStepIndexChange, onFinish, onExit,
}: Props) {
  const { lang, dir } = useApp();
  const reducedMotion = usePrefersReducedMotion();
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const [cardNode, setCardNode] = useState<HTMLDivElement | null>(null);
  const measureRef = useRef<() => void>(() => undefined);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [card, setCard] = useState<PositionedCard | null>(null);
  /**
   * Which anchor is currently resolved, or 'none'.
   *
   * IG-1.1 makes this load-bearing rather than incidental. A drawer-backed
   * target does not exist at the instant its step becomes current: the guide
   * asks the shell to open the drawer, React renders it, and only then does
   * the anchor appear. Naming the resolved anchor gives the rest of the
   * component something to react to when that happens.
   */
  const [resolvedAnchor, setResolvedAnchor] = useState('none');
  /**
   * Which step `targetRect` was measured for.
   *
   * On a step change the previous step's rectangle is still in state for one
   * render, so a ring drawn from it would briefly highlight the element the
   * card has just stopped describing — and, because the ring transitions its
   * geometry, would then slide across the screen to the new one. Holding the
   * ring back until it has been measured for the CURRENT step means it only
   * ever appears over the thing being explained.
   */
  const [measuredStep, setMeasuredStep] = useState('');

  const step = steps[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === steps.length - 1;

  /**
   * IG-1.1 — hold the shell's drawer open for the steps that live inside it,
   * and put it back exactly as it was on every way out. A no-op on desktop.
   */
  useGuideDrawerStep(drawer, step?.requiresDrawer === true);

  useGuideBackgroundInert(layer);
  /**
   * The focus key is the tour and STEP, deliberately without the language.
   *
   * A language switch re-renders this same card in place, so focus stays
   * exactly where the operator left it — on the guide's own language control,
   * if that is what they just used. Entry focus for a NEW step goes to the
   * primary action rather than to the first tab stop.
   */
  useGuideFocusTrap(
    cardNode,
    onExit,
    // The resolved anchor is part of the key so that when a drawer-backed
    // target finally mounts — and the drawer's own focus management has just
    // run — focus is re-asserted into the guide card rather than left wherever
    // the newly mounted panel put it.
    `${tour.id}:${step?.id ?? ''}:${resolvedAnchor}`,
    '[data-guide-primary]',
  );

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
    const resolved = resolveTarget(step, viewport);
    setMeasuredStep(step.id);
    if (!resolved) {
      setTargetRect(null);
      setCard(null);
      setResolvedAnchor('none');
      return;
    }
    setResolvedAnchor(resolved.anchor);
    const rect = rectOf(resolved.element);
    setTargetRect(rect);

    const size = cardNode
      ? { width: cardNode.offsetWidth, height: cardNode.offsetHeight }
      : { width: 360, height: 220 };
    setCard(positionGuideCard(rect, size, viewport, dir));
  }, [step, dir, cardNode]);

  measureRef.current = measure;

  useLayoutEffect(() => {
    measure();
    // `drawer.isOpen` is a dependency because opening the drawer is precisely
    // what brings a drawer-backed anchor into existence; without it the step
    // would measure once, find nothing, and fall back to a centred card for
    // the rest of its life.
  }, [measure, lang, drawer.isOpen]);

  /**
   * Follow the target until it stops moving.
   *
   * A step's target is not necessarily where it will end up at the moment the
   * step becomes current. The mobile drawer slides in over ~200ms, so a single
   * measurement taken a frame or two after it opens captures the panel
   * MID-ANIMATION and leaves the highlight permanently offset — measured at
   * ~6px horizontally on a 375px phone, and worse on a slower device, because
   * nothing afterwards re-measures. The same applies to any entrance
   * animation, on any target, which is why this is not special-cased to the
   * drawer.
   *
   * So: re-measure on each frame in which the target's box actually CHANGED,
   * stop once it has been still for three frames, and give up after a second
   * rather than polling forever. Measuring only on change keeps this to a
   * handful of renders instead of one per frame.
   */
  useEffect(() => {
    if (!step) return;
    let raf = 0;
    let previous = '';
    let stableFrames = 0;
    const deadline = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 1000;

    const tick = () => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const resolved = resolveTarget(step, viewport);
      const signature = resolved
        ? JSON.stringify(rectOf(resolved.element))
        : 'none';

      if (signature !== previous) {
        previous = signature;
        stableFrames = 0;
        measureRef.current();
      } else {
        stableFrames += 1;
      }

      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (stableFrames < 3 && now < deadline) raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [step, drawer.isOpen]);

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
      /* IG-2 — which of the step's candidate anchors actually won, or 'none'.
         A step that declares a precise anchor and a region fallback is
         correct in either case, and this is what makes WHICH one it landed on
         observable instead of inferred from placement. Inert: an id from the
         guide's own vocabulary, carrying no data and no record identity. */
      data-guide-anchor={resolvedAnchor}
      data-guide-placement={centred ? 'center' : card.placement}
    >
      {/* Covers the viewport INCLUDING the highlighted element, so the control
          the guide describes cannot be activated by pointer while it is being
          described. Clicking here is deliberately inert rather than a close: a
          stray tap must not throw an operator out of the step they are
          reading, and Escape plus the explicit control are the ways out. */}
      <div className={`guide-blocker${targetRect ? '' : ' guide-blocker--plain'}`} aria-hidden="true" />

      {targetRect && measuredStep === step.id && (
        <div
          /**
           * Keyed by step so React MOUNTS a fresh ring for each one.
           *
           * `.guide-ring` transitions top/left/width/height, which is right
           * while a single step's target moves — a scroll, a resize, an
           * RTL/LTR flip. Across a step change it was wrong: the ring spent
           * 150ms travelling from the previous element, so for that window it
           * highlighted something the card was no longer describing. A new
           * element has no previous value to interpolate from, so it simply
           * appears on its target.
           */
          key={step.id}
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
        {/* The card's header row. The language control lives HERE, inside the
            guide's own surface, because the blocking layer deliberately makes
            the topbar's copy of it unreachable while a tour runs. It changes
            the APPLICATION language through AppContext's canonical setter —
            see GuideLanguageControl for why that is not a second selector. */}
        <div className="guide-card__head">
          <p className="guide-card__position">{positionLabel}</p>
          <GuideLanguageControl />
        </div>
        <h2 id={titleId} className="guide-card__title">{guideText(step.title, lang)}</h2>
        <p id={bodyId} className="guide-card__body">{guideText(step.body, lang)}</p>

        {/**
          * Said only when the step genuinely could not be anchored, and it
          * names nothing: the operator learns that the element is not on this
          * screen, not what it is or where it lives.
          *
          * IG-1.1 — keyed on the TARGET, not on the placement. A centred card
          * has two quite different causes: no target was found, or a target
          * was found and is being highlighted but is too large to fit a card
          * beside it. The phone's drawer navigation list is the second case —
          * 217x535 inside a 375x812 viewport leaves no side free — and showing
          * "not visible on the current screen" while the ring sits over it is
          * simply a lie to the operator.
          */}
        {!targetRect && measuredStep === step.id && step.anchors.length > 0 && (
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
            data-guide-primary=""
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

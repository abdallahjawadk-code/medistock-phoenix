/**
 * INTERACTIVE-GUIDE-IG1 — safe popover placement (AD-08).
 *
 * A pure function over plain rectangles, with no DOM access, so the whole
 * placement contract — including its RTL behaviour and its refusal to leave
 * the viewport — is unit-testable without a browser.
 *
 * The rule is simple and deliberately not clever: try below the target, then
 * above, then after it in the reading direction, then before it. Take the
 * first side the card actually fits on, clamp it into the viewport, and if no
 * side fits, say so — the caller then renders the SAME step as a centred card
 * rather than pushing a half-visible popover off screen.
 */

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export type GuidePlacement = 'below' | 'above' | 'after' | 'before' | 'center';

export interface PositionedCard {
  placement: GuidePlacement;
  top: number;
  left: number;
}

/** Space between the highlighted element and the card. */
export const GUIDE_CARD_GAP = 12;
/** Minimum breathing room between the card and the viewport edge. */
export const GUIDE_VIEWPORT_MARGIN = 8;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Place `card` relative to `target`.
 *
 * `dir` is the document direction: 'after' means below-the-reading-flow side,
 * i.e. to the RIGHT in LTR and to the LEFT in RTL. That is why direction is a
 * parameter and not a hard-coded left/right — an Arabic operator's popover
 * must open on the same SEMANTIC side as an English one.
 */
export function positionGuideCard(
  target: Rect,
  card: { width: number; height: number },
  viewport: Viewport,
  dir: 'rtl' | 'ltr',
): PositionedCard {
  const minLeft = GUIDE_VIEWPORT_MARGIN;
  const maxLeft = viewport.width - card.width - GUIDE_VIEWPORT_MARGIN;
  const minTop = GUIDE_VIEWPORT_MARGIN;
  const maxTop = viewport.height - card.height - GUIDE_VIEWPORT_MARGIN;

  // A viewport too small for the card on any side: one centred card is the
  // only honest answer, and is what the caller renders.
  if (maxLeft < minLeft || maxTop < minTop) {
    return { placement: 'center', top: minTop, left: minLeft };
  }

  const centredLeft = clamp(
    target.left + target.width / 2 - card.width / 2,
    minLeft,
    maxLeft,
  );
  const centredTop = clamp(
    target.top + target.height / 2 - card.height / 2,
    minTop,
    maxTop,
  );

  const belowTop = target.top + target.height + GUIDE_CARD_GAP;
  if (belowTop + card.height + GUIDE_VIEWPORT_MARGIN <= viewport.height) {
    return { placement: 'below', top: belowTop, left: centredLeft };
  }

  const aboveTop = target.top - GUIDE_CARD_GAP - card.height;
  if (aboveTop >= GUIDE_VIEWPORT_MARGIN) {
    return { placement: 'above', top: aboveTop, left: centredLeft };
  }

  // Inline sides, expressed in reading order rather than in raw left/right.
  const afterLeft = dir === 'rtl'
    ? target.left - GUIDE_CARD_GAP - card.width
    : target.left + target.width + GUIDE_CARD_GAP;
  const afterFits = dir === 'rtl'
    ? afterLeft >= GUIDE_VIEWPORT_MARGIN
    : afterLeft + card.width + GUIDE_VIEWPORT_MARGIN <= viewport.width;
  if (afterFits) {
    return { placement: 'after', top: centredTop, left: afterLeft };
  }

  const beforeLeft = dir === 'rtl'
    ? target.left + target.width + GUIDE_CARD_GAP
    : target.left - GUIDE_CARD_GAP - card.width;
  const beforeFits = dir === 'rtl'
    ? beforeLeft + card.width + GUIDE_VIEWPORT_MARGIN <= viewport.width
    : beforeLeft >= GUIDE_VIEWPORT_MARGIN;
  if (beforeFits) {
    return { placement: 'before', top: centredTop, left: beforeLeft };
  }

  return { placement: 'center', top: minTop, left: minLeft };
}

/**
 * Is this element usable as a highlight target right now?
 *
 * "Present in the DOM" is not enough: a zero-sized, `display:none` or
 * off-screen element would be highlighted as an invisible rectangle. A target
 * that fails this check makes its step fall back to a centred card, which is
 * the same behaviour as a target that is missing outright.
 */
export function isUsableTarget(rect: Rect, viewport: Viewport): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (rect.top >= viewport.height || rect.left >= viewport.width) return false;
  if (rect.top + rect.height <= 0 || rect.left + rect.width <= 0) return false;
  return true;
}

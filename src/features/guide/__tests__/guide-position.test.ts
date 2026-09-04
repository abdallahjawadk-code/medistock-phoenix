import { describe, expect, it } from 'vitest';
import {
  GUIDE_CARD_GAP,
  GUIDE_VIEWPORT_MARGIN,
  isUsableTarget,
  positionGuideCard,
  type Rect,
} from '../guide.position';

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };
const CARD = { width: 360, height: 220 };

const rect = (top: number, left: number, width = 120, height = 44): Rect =>
  ({ top, left, width, height });

/** The card must never poke outside the viewport, in any placement. */
function assertInsideViewport(
  placed: { top: number; left: number },
  card: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  expect(placed.left).toBeGreaterThanOrEqual(GUIDE_VIEWPORT_MARGIN);
  expect(placed.top).toBeGreaterThanOrEqual(GUIDE_VIEWPORT_MARGIN);
  expect(placed.left + card.width).toBeLessThanOrEqual(viewport.width - GUIDE_VIEWPORT_MARGIN);
  expect(placed.top + card.height).toBeLessThanOrEqual(viewport.height - GUIDE_VIEWPORT_MARGIN);
}

describe('guide card placement — preference order', () => {
  it('prefers below when there is room beneath the target', () => {
    const target = rect(100, 600);
    const placed = positionGuideCard(target, CARD, DESKTOP, 'ltr');
    expect(placed.placement).toBe('below');
    expect(placed.top).toBe(target.top + target.height + GUIDE_CARD_GAP);
    assertInsideViewport(placed, CARD, DESKTOP);
  });

  it('falls back to above when the target sits near the bottom', () => {
    const target = rect(800, 600);
    const placed = positionGuideCard(target, CARD, DESKTOP, 'ltr');
    expect(placed.placement).toBe('above');
    expect(placed.top + CARD.height + GUIDE_CARD_GAP).toBe(target.top);
    assertInsideViewport(placed, CARD, DESKTOP);
  });

  it('falls back to an inline side when neither below nor above fits', () => {
    // A tall target filling the viewport height leaves no room either way.
    const target = rect(10, 600, 120, 860);
    const placed = positionGuideCard(target, CARD, DESKTOP, 'ltr');
    expect(placed.placement).toBe('after');
    assertInsideViewport(placed, CARD, DESKTOP);
  });

  it('uses "before" when "after" would leave the viewport', () => {
    // Tall target hard against the right edge: "after" (right, in LTR) cannot fit.
    const target = rect(10, DESKTOP.width - 130, 120, 860);
    const placed = positionGuideCard(target, CARD, DESKTOP, 'ltr');
    expect(placed.placement).toBe('before');
    assertInsideViewport(placed, CARD, DESKTOP);
  });

  it('gives up and centres when no side fits at all', () => {
    // A target that fills the viewport in both axes.
    const target = rect(0, 0, DESKTOP.width, DESKTOP.height);
    expect(positionGuideCard(target, CARD, DESKTOP, 'ltr').placement).toBe('center');
  });

  it('centres rather than overflowing a viewport smaller than the card', () => {
    const tiny = { width: 300, height: 180 };
    expect(positionGuideCard(rect(10, 10), CARD, tiny, 'ltr').placement).toBe('center');
    expect(positionGuideCard(rect(10, 10), CARD, tiny, 'rtl').placement).toBe('center');
  });
});

describe('guide card placement — direction', () => {
  /**
   * The RTL contract. "after" means the side the reading flow continues on,
   * which is the LEFT in Arabic and the RIGHT in English. Getting this wrong
   * is invisible in one language and obviously broken in the other.
   */
  it('opens "after" on opposite physical sides in RTL and LTR', () => {
    const target = rect(10, 600, 120, 860);
    const ltr = positionGuideCard(target, CARD, DESKTOP, 'ltr');
    const rtl = positionGuideCard(target, CARD, DESKTOP, 'rtl');
    expect(ltr.placement).toBe('after');
    expect(rtl.placement).toBe('after');
    expect(ltr.left).toBeGreaterThan(target.left);
    expect(rtl.left).toBeLessThan(target.left);
    assertInsideViewport(ltr, CARD, DESKTOP);
    assertInsideViewport(rtl, CARD, DESKTOP);
  });

  it('mirrors the "before" fallback too', () => {
    // Tall target hard against the LEFT edge: in RTL, "after" (left) cannot fit.
    const target = rect(10, 10, 120, 860);
    const rtl = positionGuideCard(target, CARD, DESKTOP, 'rtl');
    expect(rtl.placement).toBe('before');
    expect(rtl.left).toBeGreaterThan(target.left);
    assertInsideViewport(rtl, CARD, DESKTOP);
  });

  it('places below identically in both directions, since below has no side', () => {
    const target = rect(100, 600);
    const ltr = positionGuideCard(target, CARD, DESKTOP, 'ltr');
    const rtl = positionGuideCard(target, CARD, DESKTOP, 'rtl');
    expect(rtl).toEqual(ltr);
  });
});

describe('guide card placement — clamping', () => {
  it('keeps a card beside an edge-hugging target inside the viewport', () => {
    for (const left of [0, DESKTOP.width - 120]) {
      const placed = positionGuideCard(rect(100, left), CARD, DESKTOP, 'ltr');
      assertInsideViewport(placed, CARD, DESKTOP);
    }
  });

  it('works on a small phone viewport', () => {
    const card = { width: 351, height: 240 };
    for (const target of [rect(60, 8), rect(60, 320, 40, 40), rect(700, 160)]) {
      const placed = positionGuideCard(target, card, PHONE, 'rtl');
      if (placed.placement !== 'center') assertInsideViewport(placed, card, PHONE);
    }
  });
});

describe('target usability', () => {
  it('rejects a zero-sized element', () => {
    expect(isUsableTarget(rect(10, 10, 0, 0), DESKTOP)).toBe(false);
    expect(isUsableTarget(rect(10, 10, 120, 0), DESKTOP)).toBe(false);
  });

  it('rejects an element scrolled entirely out of view', () => {
    expect(isUsableTarget(rect(-100, 10, 120, 44), DESKTOP)).toBe(false);
    expect(isUsableTarget(rect(10, -200, 120, 44), DESKTOP)).toBe(false);
    expect(isUsableTarget(rect(DESKTOP.height + 10, 10), DESKTOP)).toBe(false);
    expect(isUsableTarget(rect(10, DESKTOP.width + 10), DESKTOP)).toBe(false);
  });

  it('accepts a partially visible element', () => {
    expect(isUsableTarget(rect(-10, 10, 120, 44), DESKTOP)).toBe(true);
    expect(isUsableTarget(rect(10, 10, 120, 44), DESKTOP)).toBe(true);
  });
});

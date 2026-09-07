import type { Lang } from '@/shared/lib/types';
import type { GuideAnchorId } from './guide.anchors';
import type { GuideViewport } from './guide.viewport';

/**
 * INTERACTIVE-GUIDE-IG1 — the typed tour contract (AD-03).
 *
 * Bilingual copy is a `{ ar, en }` pair, the exact shape the canonical i18n
 * registry (`src/shared/i18n/strings.ts`) uses for every other string in the
 * application. It is spelled out here rather than imported from there because
 * the guide's OWN copy must not be linked into the main bundle: `strings.ts`
 * is imported by the shell, so a tour written into it would ship to every
 * operator who never opens the guide. Same authoring system, same resolution
 * rule, different (lazily fetched) module — see AD-07.
 */
export interface GuideText {
  ar: string;
  en: string;
}

/** Resolve bilingual copy for the CURRENT application language. */
export function guideText(text: GuideText, lang: Lang): string {
  return text[lang];
}

/**
 * How a step is presented when it has no usable target.
 *
 * `central` — show the step's own copy in a centred card. Correct when the
 *             operator IS authorized for the concept but the element is not on
 *             screen right now (wrong screen, collapsed panel, narrow layout).
 * Steps the operator is NOT authorized for never reach this decision: they are
 * removed from the tour before it starts (see guide.permissions.ts), so no
 * fallback can disclose the existence of a screen or action they may not use.
 */
export type GuideFallback = 'central';

export interface GuideStep {
  /** Unique within its tour. Language-neutral, and never contains translated text. */
  id: string;
  title: GuideText;
  body: GuideText;
  /**
   * Candidate anchors, most specific first. The first one PRESENT in the
   * document wins; if none is present the step renders as a centred card.
   *
   * A list rather than a single id because one concept legitimately has
   * different owners per layout — the navigation rail on desktop, the drawer
   * or the bottom bar on a phone — and picking between them is a runtime fact
   * about the current viewport, not something a registry can hard-code.
   *
   * An empty list means the step is intentionally centred (an opening or
   * closing card that points at nothing).
   */
  anchors: readonly GuideAnchorId[];
  /**
   * Effective-permission keys the operator must hold for this step to exist.
   * Read through the application's existing effective permissions — never a
   * role name (AD-05).
   */
  requiresPermissions?: readonly string[];
  /**
   * INTERACTIVE-GUIDE-IG1.1 — the viewports whose layout actually contains
   * this step's subject. Omitted means viewport-neutral.
   *
   * The phone and the desktop do not offer the same navigation surfaces, so a
   * single "how you move around" step could only ever be right on one of them.
   * Declaring the surface here lets the filtered tour describe what the
   * operator can actually see — and lets the step COUNT differ per viewport,
   * which is why nothing may assume a fixed number of steps.
   */
  viewports?: readonly GuideViewport[];
  /**
   * INTERACTIVE-GUIDE-IG2 — capability names this step needs, answered by the
   * component that already computed them (guide.surface.tsx).
   *
   * Separate from `requiresPermissions` on purpose. That reads the GLOBAL
   * effective key set, which is the right question for a screen-level gate and
   * the wrong one for a per-warehouse or per-outlet decision — those are
   * asynchronous, scoped answers the guide must consume rather than re-derive.
   */
  requiresCapabilities?: readonly string[];
  /**
   * INTERACTIVE-GUIDE-IG2 — element-presence names this step needs, declared by
   * the panel that renders (or does not render) them.
   *
   * A THIRD, independent axis, and the reason it is not folded into either of
   * the two above: an empty quarantine list is neither a refusal nor a missing
   * permission, it is simply nothing to point at. A step about "this row" must
   * be REMOVED when the list has no row — not shown as a centred card, which
   * would describe a record the operator cannot see and would let a genuine
   * anchoring defect hide behind the fallback.
   *
   * `central` fallback keeps its original meaning and stays correct for the
   * case it was written for: the operator is authorized AND the element exists
   * in this panel's vocabulary, but the current layout is not showing it.
   */
  requiresPresence?: readonly string[];
  /**
   * INTERACTIVE-GUIDE-IG2 — the tab within `screen` this step describes.
   *
   * The guide never switches tabs: switching unmounts the panel and would
   * discard an operator's half-filled form. A step that names a tab is offered
   * only while that tab is already open, which is what makes these tours
   * contextual rather than navigational.
   */
  tab?: string;
  /**
   * INTERACTIVE-GUIDE-IG1.1 — this step points at something inside the shell's
   * mobile drawer, so the drawer must be open for it to have a target.
   *
   * The guide opens it through the shell's own state and closes it again on
   * the way out, unless the operator had already opened it themselves. A no-op
   * wherever the shell renders no drawer, which is why a step shared by both
   * viewports can declare it safely.
   */
  requiresDrawer?: boolean;
  /**
   * A screen this step describes. Used for two things only:
   *   • the guide offers a SAFE programmatic jump to it, and
   *   • the step is filtered out entirely when the app's own screen
   *     authorization refuses that screen to this operator.
   * The guide never navigates anywhere the application would not already let
   * this operator navigate by clicking (AD-04).
   */
  screen?: number;
}

export interface GuideTour {
  /** Unique across the registry. Language-neutral. */
  id: string;
  title: GuideText;
  description: GuideText;
  /**
   * INTERACTIVE-GUIDE-IG2 — eligibility for the TOUR ITSELF.
   *
   * Filtering steps alone is not enough: a tour titled «الحجر الصحي» listed in
   * the Help Center already tells an unauthorized operator that the surface
   * exists. A tour whose requirements are unmet is absent entirely — no title,
   * no description, no disabled row.
   */
  requiresCapabilities?: readonly string[];
  /** The screen this tour belongs to; it is not offered anywhere else. */
  screen?: number;
  /** The tab this tour belongs to; it is not offered on any other tab. */
  tab?: string;
  steps: readonly GuideStep[];
}

export interface GuideRegistry {
  /** Bumped when the tour/step vocabulary changes incompatibly. */
  version: number;
  tours: readonly GuideTour[];
}

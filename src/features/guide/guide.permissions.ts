import { isScreenAuthorized } from '@/shared/authz/screen-access';
import { isStepForViewport, type GuideViewport } from './guide.viewport';
import type { GuideSurface } from './guide.surface';
import type { GuideStep, GuideTour } from './guide.types';

/**
 * INTERACTIVE-GUIDE-IG1 — permission-aware filtering (AD-05).
 *
 * Two rules, and only two:
 *   1. every key in `requiresPermissions` must be present in the operator's
 *      EFFECTIVE permissions — the same `myPermissions` set the navigation,
 *      the command palette and the route guard already read, never a role
 *      name; and
 *   2. a step that describes a screen must pass `isScreenAuthorized`, the
 *      application's own canonical screen decision.
 *
 * Filtering happens BEFORE a tour starts, and a refused step is REMOVED — it
 * is not greyed out, not replaced by a placeholder, and never rendered as a
 * "you do not have access to X" card. Naming a screen or an action in order to
 * refuse it would disclose the existence of both, which is precisely the leak
 * this filter exists to prevent.
 */

export interface GuideAudience {
  role: string | null | undefined;
  permissions: ReadonlySet<string>;
  /**
   * IG-2 — scoped answers published by the components that computed them.
   * Absent reads as false; see guide.surface.tsx.
   */
  capabilities?: Readonly<Record<string, boolean>>;
  /** IG-2 — where the operator actually is. */
  surface?: GuideSurface;
  /**
   * IG-2 — which anchored elements the panels actually rendered.
   *
   * Kept apart from `capabilities` on purpose: presence answers "is it on
   * screen", never "may this operator use it". Neither substitutes for the
   * other, and an absent presence key reads as false exactly like an absent
   * capability — but for a different reason and with a different consequence.
   */
  presence?: Readonly<Record<string, boolean>>;
}

/**
 * IG-2 — does the audience hold every scoped capability this thing declares?
 *
 * A capability is present ONLY when some publisher that had SETTLED said yes:
 * `guide.surface.tsx` builds this map from ready sources alone, so a check
 * still in flight — or one that failed — contributes nothing and reads as
 * false. That is the fail-closed direction, and it is the whole rule.
 *
 * WHY THERE IS NO LONGER A GLOBAL "everything must be ready" VETO. There was
 * one, and it was wrong: capability answers come from SEPARATE sources with
 * separate lifetimes, and one aggregate state cannot describe them. A
 * quarantine ACTION check that failed would cancel the read affordance too —
 * an independently established, synchronous decision that owed nothing to that
 * round trip — and the operator would be told nothing at all about a list they
 * were plainly allowed to look at. Whereas a per-source rule refuses exactly
 * what failed: the reading steps survive, the action steps do not.
 *
 * The aggregate state still exists on the context, where it belongs — as part
 * of the context key that invalidates an open tour — but it decides no grant.
 */
function holdsCapabilities(
  required: readonly string[] | undefined,
  audience: GuideAudience,
): boolean {
  if (!required || required.length === 0) return true;
  const held = audience.capabilities ?? {};
  return required.every(key => held[key] === true);
}

/**
 * IG-2 — are the elements this step points at actually rendered?
 *
 * Unlike {@link holdsCapabilities} this has NO loading concept of its own. A
 * panel that has not finished loading simply has not declared these keys, so
 * they read as absent — the same answer, reached honestly, without inventing a
 * second notion of "pending" that could drift from the first.
 */
function hasPresence(
  required: readonly string[] | undefined,
  audience: GuideAudience,
): boolean {
  if (!required || required.length === 0) return true;
  const present = audience.presence ?? {};
  return required.every(key => present[key] === true);
}

/** IG-2 — is this thing's screen/tab the one currently open? */
function matchesSurface(
  target: { screen?: number; tab?: string },
  audience: GuideAudience,
): boolean {
  if (target.screen === undefined && target.tab === undefined) return true;
  const surface = audience.surface;
  if (!surface) return false;
  if (target.screen !== undefined && surface.screen !== target.screen) return false;
  if (target.tab !== undefined && surface.tab !== target.tab) return false;
  return true;
}

/** Does this operator hold every permission the step declares? */
export function isStepPermitted(step: GuideStep, audience: GuideAudience): boolean {
  const required = step.requiresPermissions ?? [];
  for (const key of required) {
    if (!audience.permissions.has(key)) return false;
  }
  if (step.screen !== undefined
    && !isScreenAuthorized(step.screen, audience.role, audience.permissions)) {
    return false;
  }
  if (!holdsCapabilities(step.requiresCapabilities, audience)) return false;
  // Presence is checked AFTER authorization and never instead of it, so a
  // rendered element can never stand in for a permission the operator lacks.
  if (!hasPresence(step.requiresPresence, audience)) return false;
  // A step naming a tab describes something only that tab renders, so it is
  // shown only while that tab is open — never as an off-screen explanation.
  if (step.tab !== undefined && !matchesSurface({ tab: step.tab }, audience)) return false;
  return true;
}

/**
 * The steps of `tour` this operator may see, in registry order.
 *
 * TWO independent narrowings, deliberately kept as separate predicates and
 * composed here at the single place the engine calls:
 *
 *   • authorization — what this operator is allowed to be told about, and
 *   • layout — which navigation surfaces this viewport actually renders.
 *
 * They must not be conflated. A step hidden because the phone has no sidebar
 * is not a permission decision, and a step hidden because the operator lacks a
 * capability must never be reintroduced by a wider window.
 */
export function permittedSteps(
  tour: GuideTour,
  audience: GuideAudience,
  viewport?: GuideViewport,
): GuideStep[] {
  return tour.steps.filter(step => isStepPermitted(step, audience)
    && (viewport === undefined || isStepForViewport(step, viewport)));
}

/**
 * The tours worth offering, each already narrowed to its permitted steps.
 *
 * A tour whose every step was refused is dropped entirely rather than listed
 * as an empty or disabled entry, for the same non-disclosure reason.
 */
export function permittedTours(
  tours: readonly GuideTour[],
  audience: GuideAudience,
  viewport?: GuideViewport,
): { tour: GuideTour; steps: GuideStep[] }[] {
  return tours
    // The TOUR's own eligibility first: an ineligible tour is absent, so its
    // title never discloses a surface this operator may not reach.
    .filter(tour => holdsCapabilities(tour.requiresCapabilities, audience)
      && matchesSurface({ screen: tour.screen, tab: tour.tab }, audience))
    .map(tour => ({ tour, steps: permittedSteps(tour, audience, viewport) }))
    .filter(entry => entry.steps.length > 0);
}

/**
 * May the guide programmatically move this operator to `screen`?
 *
 * Delegates to the application's canonical decision rather than re-deriving
 * one, so the guide can never reach a screen the route guard would refuse. It
 * grants nothing: it only asks whether an ordinary click would have been
 * allowed to go there.
 */
export function canGuideNavigateTo(screen: number, audience: GuideAudience): boolean {
  return isScreenAuthorized(screen, audience.role, audience.permissions);
}

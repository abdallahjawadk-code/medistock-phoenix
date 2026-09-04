import { isScreenAuthorized } from '@/shared/authz/screen-access';
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
  return true;
}

/** The steps of `tour` this operator may see, in registry order. */
export function permittedSteps(tour: GuideTour, audience: GuideAudience): GuideStep[] {
  return tour.steps.filter(step => isStepPermitted(step, audience));
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
): { tour: GuideTour; steps: GuideStep[] }[] {
  return tours
    .map(tour => ({ tour, steps: permittedSteps(tour, audience) }))
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

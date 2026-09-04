/**
 * INTERACTIVE-GUIDE-IG1 — the stable anchor vocabulary (AD-03).
 *
 * These identifiers are the ONLY contract between a guide step and the UI it
 * points at. They are language-neutral by construction, so switching the app
 * between Arabic and English cannot move, break or re-resolve a target.
 *
 * Why a dedicated attribute rather than reusing something that already exists:
 *   • visible text  — changes with the language, and with any copy edit;
 *   • `data-testid` — belongs to the tests, which are free to renumber and
 *                     re-scope it; a guide that depended on it would break
 *                     silently every time a test was refactored;
 *   • CSS classes   — presentational, shared by many nodes, and reshuffled by
 *                     every visual pass.
 *
 * `data-guide-id` is therefore owned by the guide and by nothing else. It is
 * inert: it carries no behaviour, no data, and no record identity.
 *
 * Naming is `guide.<module>.<concept>.<element>`. This module is deliberately
 * tiny and free of copy, because the shell components that place the anchors
 * import it and it therefore lives in the main chunk; every tour, every step
 * and every translated string lives in the lazily-loaded registry instead.
 */

export const GUIDE_ANCHOR_ATTRIBUTE = 'data-guide-id';

export const GUIDE_ANCHORS = {
  /* ── Application shell ── */
  shellNavigationRail:      'guide.shell.navigation.rail',
  shellNavigationDrawer:    'guide.shell.navigation.drawer',
  shellNavigationBottom:    'guide.shell.navigation.bottom',
  shellTopbarLanguage:      'guide.shell.topbar.language',
  shellTopbarNotifications: 'guide.shell.topbar.notifications',
  shellTopbarHelp:          'guide.shell.topbar.help',
  shellDrawerHelp:          'guide.shell.drawer.help',

  /* ── Command Center (Dashboard pilot) ── */
  dashboardContextHeader:   'guide.dashboard.context.header',
  dashboardOverviewKpis:    'guide.dashboard.overview.kpis',
  dashboardSignalsPanel:    'guide.dashboard.signals.panel',
} as const;

export type GuideAnchorId = (typeof GUIDE_ANCHORS)[keyof typeof GUIDE_ANCHORS];

/**
 * Spread onto the element that OWNS the concept, e.g.
 * `<nav {...guideAnchor(GUIDE_ANCHORS.shellNavigationRail)}>`.
 *
 * A helper rather than a hand-written attribute so the attribute name exists
 * once, and so no call site can quietly invent an id outside this vocabulary.
 */
export function guideAnchor(id: GuideAnchorId): Record<string, string> {
  return { [GUIDE_ANCHOR_ATTRIBUTE]: id };
}

/** CSS.escape-free selector for an anchor — ids are dotted ASCII by construction. */
export function guideAnchorSelector(id: string): string {
  return `[${GUIDE_ANCHOR_ATTRIBUTE}="${id}"]`;
}

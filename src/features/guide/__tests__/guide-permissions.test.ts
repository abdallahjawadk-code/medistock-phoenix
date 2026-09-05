import { describe, expect, it } from 'vitest';
import { COMMAND_CENTER_SCREEN, DASHBOARD_VIEW_PERMISSION } from '@/shared/authz/screen-access';
import { GUIDE_REGISTRY } from '../guide.registry';
import {
  canGuideNavigateTo,
  isStepPermitted,
  permittedSteps,
  permittedTours,
  type GuideAudience,
} from '../guide.permissions';
import type { GuideStep, GuideTour } from '../guide.types';

const ORIENTATION = GUIDE_REGISTRY.tours[0];

function audience(role: string, permissions: string[]): GuideAudience {
  return { role, permissions: new Set(permissions) };
}

/** An actor who may open the Command Center. */
const DASHBOARD_ACTOR = audience('super_admin', [DASHBOARD_VIEW_PERMISSION]);
/** The same role WITHOUT the capability — a per-profile override is honoured. */
const NO_DASHBOARD_ACTOR = audience('super_admin', []);
/**
 * The facility-scoped role (migration 182). `isScreenAuthorized` confines it
 * to FACILITY_SAFE_SCREENS whatever permissions it holds — this actor
 * deliberately carries `dashboard.view` so the test proves the SCREEN
 * decision, not the permission, is what refuses it.
 */
const FACILITY_ACTOR = audience('health_center_manager', [DASHBOARD_VIEW_PERMISSION]);

const step = (over: Partial<GuideStep> = {}): GuideStep => ({
  id: 'x',
  title: { ar: 'ع', en: 'e' },
  body: { ar: 'ع', en: 'e' },
  anchors: [],
  ...over,
});

describe('guide permissions — per-step decisions', () => {
  it('admits a step with no requirements to everyone', () => {
    expect(isStepPermitted(step(), NO_DASHBOARD_ACTOR)).toBe(true);
    expect(isStepPermitted(step(), FACILITY_ACTOR)).toBe(true);
  });

  it('requires EVERY declared permission, not just one of them', () => {
    const s = step({ requiresPermissions: ['a.view', 'b.view'] });
    expect(isStepPermitted(s, audience('super_admin', ['a.view']))).toBe(false);
    expect(isStepPermitted(s, audience('super_admin', ['a.view', 'b.view']))).toBe(true);
  });

  it('reads the capability, never the role name', () => {
    const s = step({ requiresPermissions: [DASHBOARD_VIEW_PERMISSION] });
    // Same role, opposite answers — because the permission, not the role, decides.
    expect(isStepPermitted(s, DASHBOARD_ACTOR)).toBe(true);
    expect(isStepPermitted(s, NO_DASHBOARD_ACTOR)).toBe(false);
  });

  it('defers to the application canonical screen decision', () => {
    const s = step({ screen: COMMAND_CENTER_SCREEN });
    expect(isStepPermitted(s, DASHBOARD_ACTOR)).toBe(true);
    // A facility-scoped role is confined by isScreenAuthorized regardless of
    // the permission it holds — the guide inherits that refusal rather than
    // re-deriving a weaker one of its own.
    expect(isStepPermitted(s, FACILITY_ACTOR)).toBe(false);
  });
});

describe('guide permissions — tour filtering', () => {
  it('keeps every orientation step for an authorized actor', () => {
    expect(permittedSteps(ORIENTATION, DASHBOARD_ACTOR)).toHaveLength(ORIENTATION.steps.length);
  });

  it('REMOVES the Command Center steps for an actor without dashboard.view', () => {
    const visible = permittedSteps(ORIENTATION, NO_DASHBOARD_ACTOR);
    expect(visible.length).toBeLessThan(ORIENTATION.steps.length);
    expect(visible.some(s => s.id.startsWith('dashboard.'))).toBe(false);
  });

  it('leaks nothing about a refused step — no placeholder, no name, no screen', () => {
    /**
     * The disclosure test. A refused step must be absent, not present-and-
     * disabled: nothing in what a restricted operator can see may reveal that
     * a Command Center step exists, name it, or carry its screen number.
     */
    const visible = permittedSteps(ORIENTATION, NO_DASHBOARD_ACTOR);
    const serialised = JSON.stringify(visible);
    expect(serialised).not.toMatch(/dashboard/i);
    expect(serialised).not.toMatch(/command center/i);
    expect(serialised).not.toMatch(/مركز القيادة/);
    // ...nor the user-facing name IG-1.1 replaced it with.
    expect(serialised).not.toMatch(/الإحصائيات/);
    expect(serialised).not.toMatch(/Statistics/i);
    expect(visible.every(s => s.screen === undefined)).toBe(true);
    // And the shell steps this actor IS entitled to are still all there.
    expect(visible.map(s => s.id)).toContain('shell.language');
    expect(visible.map(s => s.id)).toContain('help.entry');
  });

  it('preserves registry order in the narrowed set', () => {
    const visible = permittedSteps(ORIENTATION, DASHBOARD_ACTOR).map(s => s.id);
    expect(visible).toEqual(ORIENTATION.steps.map(s => s.id));
  });

  it('drops a tour whose every step was refused rather than listing it empty', () => {
    const gated: GuideTour = {
      id: 'guide.tour.gated',
      title: { ar: 'ع', en: 'e' },
      description: { ar: 'ع', en: 'e' },
      steps: [step({ id: 'only', requiresPermissions: ['nobody.has.this'] })],
    };
    expect(permittedTours([gated], DASHBOARD_ACTOR)).toEqual([]);
  });

  it('still offers the orientation tour to a restricted actor, minus its gated steps', () => {
    const offered = permittedTours(GUIDE_REGISTRY.tours, NO_DASHBOARD_ACTOR);
    expect(offered).toHaveLength(1);
    expect(offered[0].steps.length).toBeGreaterThan(0);
    expect(offered[0].steps.some(s => s.id.startsWith('dashboard.'))).toBe(false);
  });
});

describe('guide navigation gate', () => {
  it('permits only what the application would already permit', () => {
    expect(canGuideNavigateTo(COMMAND_CENTER_SCREEN, DASHBOARD_ACTOR)).toBe(true);
    expect(canGuideNavigateTo(COMMAND_CENTER_SCREEN, NO_DASHBOARD_ACTOR)).toBe(false);
    expect(canGuideNavigateTo(COMMAND_CENTER_SCREEN, FACILITY_ACTOR)).toBe(false);
  });

  it('refuses an organization-level screen to a facility-scoped role', () => {
    // Screen 14 (user management) is not in the facility-safe allow-list.
    expect(canGuideNavigateTo(14, FACILITY_ACTOR)).toBe(false);
  });

  it('admits a facility-safe screen to that same role', () => {
    // Screen 18 IS facility-safe: the gate narrows, it does not blanket-refuse.
    expect(canGuideNavigateTo(18, FACILITY_ACTOR)).toBe(true);
  });
});

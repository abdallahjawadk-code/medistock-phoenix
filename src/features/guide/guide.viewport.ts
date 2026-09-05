import { useIsMobileViewport } from '@/shared/ui/useResponsiveViewport';
import type { GuideStep } from './guide.types';

/**
 * INTERACTIVE-GUIDE-IG1.1 — which navigation surfaces actually exist right now.
 *
 * Owner acceptance on a real phone found the guide teaching a navigation model
 * the screen did not have: it described the bottom bar as though it were the
 * only way to move around, while the phone also carries a side drawer holding
 * the complete authorized screen list. A guide that describes a surface the
 * operator cannot see, or omits one they can, is wrong in the only way that
 * matters.
 *
 * The boundary here is NOT a new breakpoint. It is `useIsMobileViewport`, the
 * same 767px decision `PhoenixAppShell` itself uses to choose between the
 * sidebar and the drawer-plus-bottom-bar pair. Deriving from the shell's own
 * predicate is what guarantees the guide can never describe a surface the
 * shell did not render — including at tablet widths, where the shell shows the
 * desktop sidebar and the guide therefore teaches the sidebar.
 */
export type GuideViewport = 'phone' | 'desktop';

/** The viewport the SHELL is currently laid out for, not a device guess. */
export function useGuideViewport(): GuideViewport {
  return useIsMobileViewport() ? 'phone' : 'desktop';
}

/**
 * Is this step about a surface that exists at `viewport`?
 *
 * A step with no `viewports` is viewport-neutral and always shown; only steps
 * that point at a layout-specific control declare one.
 */
export function isStepForViewport(step: GuideStep, viewport: GuideViewport): boolean {
  if (!step.viewports) return true;
  return step.viewports.includes(viewport);
}

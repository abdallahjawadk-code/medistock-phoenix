/**
 * UX-1 — the Annual Needs workflow navigator.
 *
 * PRESENTATION ONLY. This module holds no business truth, reads no service,
 * and decides no authorization. It exists so the six workflow stages are
 * declared ONCE, in order, and the navigator and the workspace sections are
 * driven by that same declaration — a stage can therefore never appear in the
 * rail and be missing from the page, or drift out of order between the two.
 *
 * WHY IT NAVIGATES RATHER THAN SWITCHES. Every stage stays mounted; this rail
 * scrolls and focuses, it does not swap content in and out. Conditional
 * unmounting would change which data each panel loads and when, which is a
 * behavioural change this UX pass is deliberately not making. Reaching a stage
 * is a scroll, never a route — application routing is untouched.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { t, type Lang } from '@/shared/i18n/strings';
import { PhoenixIcon, type PhoenixIconName } from '@/shared/ui/PhoenixIcon';

export type CentralNeedsStageId =
  | 'plan'
  | 'source'
  | 'review'
  | 'beneficiaries'
  | 'need-lines'
  | 'readiness';

export interface CentralNeedsStage {
  readonly id: CentralNeedsStageId;
  /** An explicit dictionary key, never a composed one, so the bilingual
   *  completeness check can see every label this surface can render. */
  readonly titleKey: string;
  readonly icon: PhoenixIconName;
}

/**
 * THE six stages, in the order of the trust story the screen tells:
 * SOURCE → PARSER EVIDENCE → CANONICAL MAPPING → MANUAL OVERRIDE → REVIEW
 * STATE. Plan first because nothing can be imported into a revision that was
 * never opened; readiness last because the server computes it from everything
 * above it.
 */
export const CENTRAL_NEEDS_STAGES: readonly CentralNeedsStage[] = [
  { id: 'plan', titleKey: 'cn2b_stage_plan', icon: 'reports' },
  { id: 'source', titleKey: 'cn2b_stage_source', icon: 'warehouse' },
  { id: 'review', titleKey: 'cn2b_stage_review', icon: 'editor' },
  { id: 'beneficiaries', titleKey: 'cn2b_stage_beneficiaries', icon: 'hospital' },
  { id: 'need-lines', titleKey: 'cn2b_stage_need_lines', icon: 'clipboard' },
  { id: 'readiness', titleKey: 'cn2b_stage_readiness', icon: 'check' },
];

/** The DOM id of a stage section — one spelling, shared by the rail and the page. */
export function stageDomId(id: CentralNeedsStageId): string {
  return `cn2b-stage-${id}`;
}

/** The DOM id of a stage's heading, for `aria-labelledby`. */
export function stageTitleDomId(id: CentralNeedsStageId): string {
  return `${stageDomId(id)}-title`;
}

/**
 * Marks whichever stage currently occupies the top of the reading area.
 *
 * Deliberately guarded rather than required: IntersectionObserver is absent in
 * the jsdom test environment and in any non-browser render, and a navigator
 * that throws there would be a worse outcome than one that simply highlights
 * the stage last chosen. Clicking always sets the active stage directly, so
 * the indicator is correct with or without the observer.
 */
function useActiveStage(): [CentralNeedsStageId, (id: CentralNeedsStageId) => void] {
  const [active, setActive] = useState<CentralNeedsStageId>(CENTRAL_NEEDS_STAGES[0].id);
  /** Set by a click; suppresses observer churn while a smooth scroll is in flight. */
  const pinnedUntil = useRef(0);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || typeof document === 'undefined') return;
    const sections = CENTRAL_NEEDS_STAGES
      .map((stage) => document.getElementById(stageDomId(stage.id)))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (Date.now() < pinnedUntil.current) return;
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!visible) return;
        const id = visible.target.id.replace('cn2b-stage-', '') as CentralNeedsStageId;
        if (CENTRAL_NEEDS_STAGES.some((s) => s.id === id)) setActive(id);
      },
      // Bias towards the top of the reading area: a stage counts as current
      // once its heading reaches the upper third, not when its last row leaves.
      { rootMargin: '0px 0px -66% 0px', threshold: 0 },
    );
    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, []);

  const choose = useCallback((id: CentralNeedsStageId) => {
    pinnedUntil.current = Date.now() + 900;
    setActive(id);
  }, []);

  return [active, choose];
}

/**
 * The six-stage rail. Horizontal on desktop, horizontally scrollable on a
 * phone — never wider than its container, so the document itself never gains a
 * horizontal scrollbar.
 */
export function CentralNeedsWorkflowNav({ lang }: { lang: Lang }) {
  const [active, choose] = useActiveStage();

  const goToStage = useCallback((id: CentralNeedsStageId) => {
    choose(id);
    if (typeof document === 'undefined') return;
    const section = document.getElementById(stageDomId(id));
    if (!section) return;
    // Focus first, so a keyboard user lands in the stage they asked for; the
    // section carries tabIndex -1 for exactly this reason and is not a tab stop.
    section.focus?.({ preventScroll: true });
    section.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [choose]);

  return (
    <nav className="cn2b-workflow" aria-label={t('cn2b_workflow_label', lang)}>
      <ol className="cn2b-workflow__list">
        {CENTRAL_NEEDS_STAGES.map((stage, index) => (
          <li key={stage.id} className="cn2b-workflow__item">
            <button
              type="button"
              className="cn2b-stagelink"
              data-stage={stage.id}
              data-active={stage.id === active}
              aria-current={stage.id === active ? 'step' : undefined}
              onClick={() => goToStage(stage.id)}
            >
              <span className="cn2b-stagelink__ordinal" aria-hidden="true">{index + 1}</span>
              <span className="cn2b-stagelink__icon" aria-hidden="true">
                <PhoenixIcon name={stage.icon} size={14} />
              </span>
              <span className="cn2b-stagelink__label">{t(stage.titleKey, lang)}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * UX-3R Package B — controlled Annual Needs task navigator.
 *
 * The parent owns the selected/open stage. The rail never decides progress,
 * authorization, or readiness: it only renders the server-backed presentation
 * state supplied by CentralNeedsScreen.
 *
 * All six stage subtrees stay mounted in the page. Only the selected stage is
 * visually/semantically active; switching stages is presentation state, never
 * a route and never business completion.
 */
import { useCallback, useState } from 'react';
import { t, type Lang } from '@/shared/i18n/strings';
import { PhoenixIcon, type PhoenixIconName } from '@/shared/ui/PhoenixIcon';
import type { CentralNeedsStageProgressMap } from './CentralNeedsWorkspaceState';
import { stageProgressLabelKey } from './CentralNeedsWorkspaceState';

export type CentralNeedsStageId =
  | 'plan'
  | 'source'
  | 'review'
  | 'beneficiaries'
  | 'need-lines'
  | 'readiness';

export interface CentralNeedsStage {
  readonly id: CentralNeedsStageId;
  readonly titleKey: string;
  readonly icon: PhoenixIconName;
}

export const CENTRAL_NEEDS_STAGES: readonly CentralNeedsStage[] = [
  { id: 'plan', titleKey: 'cn2b_stage_plan', icon: 'reports' },
  { id: 'source', titleKey: 'cn2b_stage_source', icon: 'warehouse' },
  { id: 'review', titleKey: 'cn2b_stage_review', icon: 'editor' },
  { id: 'beneficiaries', titleKey: 'cn2b_stage_beneficiaries', icon: 'hospital' },
  { id: 'need-lines', titleKey: 'cn2b_stage_need_lines', icon: 'clipboard' },
  { id: 'readiness', titleKey: 'cn2b_stage_readiness', icon: 'check' },
];

export function stageDomId(id: CentralNeedsStageId): string {
  return `cn2b-stage-${id}`;
}

export function stageTitleDomId(id: CentralNeedsStageId): string {
  return `${stageDomId(id)}-title`;
}

interface Props {
  lang: Lang;
  activeStage: CentralNeedsStageId | null;
  stageProgress: CentralNeedsStageProgressMap;
  busyStage?: CentralNeedsStageId | null;
  resultStage?: CentralNeedsStageId | null;
  onStageChange: (id: CentralNeedsStageId) => void;
}

export function CentralNeedsWorkflowNav({
  lang,
  activeStage,
  stageProgress,
  busyStage = null,
  resultStage = null,
  onStageChange,
}: Props) {
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const activeIndex = CENTRAL_NEEDS_STAGES.findIndex((stage) => stage.id === activeStage);
  const active = CENTRAL_NEEDS_STAGES[activeIndex] ?? CENTRAL_NEEDS_STAGES[0];

  const focusStage = useCallback((id: CentralNeedsStageId) => {
    if (typeof document === 'undefined') return;
    const run = () => document.getElementById(stageDomId(id))?.focus?.({ preventScroll: true });
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else queueMicrotask(run);
  }, []);

  const choose = useCallback((id: CentralNeedsStageId) => {
    onStageChange(id);
    setMobileExpanded(false);
    focusStage(id);
  }, [focusStage, onStageChange]);

  return (
    <nav className="cn2b-workflow" aria-label={t('cn2b_workflow_label', lang)}>
      <button
        type="button"
        className="cn2b-workflow__mobile-toggle"
        aria-label={mobileExpanded ? t('cn2b_hide_stages', lang) : t('cn2b_show_stages', lang)}
        aria-expanded={mobileExpanded}
        aria-controls="cn2b-workflow-stages"
        onClick={() => setMobileExpanded((value) => !value)}
      >
        {activeStage === null ? (
          /* §7.2 - no stage is chosen yet, so the toggle must not announce one. */
          <strong>{t('cn2b_workspace_loading', lang)}</strong>
        ) : (
          <>
            <span>{t('cn2b_stage_of', lang)} {activeIndex + 1}/{CENTRAL_NEEDS_STAGES.length}</span>
            <strong>{t(active.titleKey, lang)}</strong>
          </>
        )}
        <span>{mobileExpanded ? t('cn2b_hide_stages', lang) : t('cn2b_show_stages', lang)}</span>
      </button>

      <ol
        id="cn2b-workflow-stages"
        className="cn2b-workflow__list"
        data-mobile-expanded={mobileExpanded}
      >
        {CENTRAL_NEEDS_STAGES.map((stage, index) => {
          const isActive = activeStage !== null && stage.id === activeStage;
          const progress = stageProgress[stage.id];
          const operationRunning = busyStage === stage.id;
          const hasNewResult = resultStage === stage.id && !operationRunning;
          return (
            <li key={stage.id} className="cn2b-workflow__item">
              <button
                type="button"
                className="cn2b-stagelink"
                data-stage={stage.id}
                data-active={isActive}
                data-progress={progress}
                data-operation={operationRunning ? 'running' : hasNewResult ? 'result' : undefined}
                aria-current={isActive ? 'step' : undefined}
                onClick={() => choose(stage.id)}
              >
                <span className="cn2b-stagelink__ordinal" aria-hidden="true">{index + 1}</span>
                <span className="cn2b-stagelink__icon" aria-hidden="true">
                  <PhoenixIcon name={stage.icon} size={14} />
                </span>
                <span className="cn2b-stagelink__copy">
                  <span className="cn2b-stagelink__label">{t(stage.titleKey, lang)}</span>
                  <span className="cn2b-stagelink__progress">
                    {operationRunning
                      ? t('cn2b_stage_operation_running', lang)
                      : hasNewResult
                        ? t('cn2b_stage_result_new', lang)
                        : t(stageProgressLabelKey(progress), lang)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

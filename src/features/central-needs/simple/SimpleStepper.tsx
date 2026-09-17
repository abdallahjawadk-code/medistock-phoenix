/**
 * Annual Needs — Simple Mode six-step progress indicator.
 *
 * PRESENTATION ONLY. It renders the step the workspace has ALREADY derived
 * from current props (see `derivedStep` in CentralNeedsSimpleWorkspace) and
 * never decides, stores or navigates anything itself — there is no click
 * target here, deliberately: the step is a consequence of the data on
 * screen, not a tab the human can jump to. It answers "where am I?" only.
 *
 * Six steps, always in this order, always all six rendered, so the human can
 * see how far along the whole task they are without six workspaces being
 * shown at once (owner task section 10).
 */
import { t } from '@/shared/i18n/strings';
import type { SimpleStep } from './CentralNeedsSimpleWorkspace';

export const SIMPLE_STEPS: ReadonlyArray<{ id: SimpleStep; titleKey: string }> = [
  { id: 'upload', titleKey: 'cn2b_simple_step_upload' },
  { id: 'analyzing', titleKey: 'cn2b_simple_step_analyzing' },
  { id: 'summary', titleKey: 'cn2b_simple_step_summary' },
  { id: 'review-institution', titleKey: 'cn2b_simple_step_institutions' },
  { id: 'review-material', titleKey: 'cn2b_simple_step_materials' },
  { id: 'pending', titleKey: 'cn2b_simple_step_outcome' },
];

export function simpleStepNumber(step: SimpleStep): number {
  return SIMPLE_STEPS.findIndex((s) => s.id === step) + 1;
}

export function SimpleStepper({ lang, step }: { lang: 'ar' | 'en'; step: SimpleStep }) {
  const current = simpleStepNumber(step);
  const currentTitle = SIMPLE_STEPS[current - 1]?.titleKey ?? 'cn2b_simple_step_upload';
  return (
    <nav className="cn2b-simple-stepper" aria-label={t('cn2b_simple_progress_label', lang)} data-testid="cn2b-simple-stepper" data-current={current}>
      <p className="cn2b-simple-stepper__summary">
        <span className="cn2b-simple-stepper__count" data-testid="cn2b-simple-step-count">
          {t('cn2b_simple_step_of', lang).replace('__N__', String(current))}
        </span>
        <span className="cn2b-simple-stepper__sep" aria-hidden="true">·</span>
        <span className="cn2b-simple-stepper__current" data-testid="cn2b-simple-step-title">
          {t(currentTitle, lang)}
        </span>
      </p>
      <ol className="cn2b-simple-stepper__list">
        {SIMPLE_STEPS.map((s, index) => {
          const n = index + 1;
          const state = n < current ? 'done' : n === current ? 'current' : 'todo';
          return (
            <li
              key={s.id}
              className="cn2b-simple-stepper__item"
              data-state={state}
              aria-current={state === 'current' ? 'step' : undefined}
            >
              <span className="cn2b-simple-stepper__bar" aria-hidden="true" />
              <span className="cn2b-simple-stepper__label">
                <span className="cn2b-simple-stepper__num" aria-hidden="true">{n}</span>
                <span className="cn2b-simple-stepper__text">{t(s.titleKey, lang)}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

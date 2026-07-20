/**
 * MOVEMENT-COMPOSER-A — the three-step shell shared by supply and return.
 *
 * Parties → Materials → Review. Nothing is persisted until the operator
 * confirms on the review step, and the shell states that explicitly so
 * "Cancel" is never a leap of faith.
 */
import type { ReactNode } from 'react';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { t } from '@/shared/i18n/strings';
import type { Lang } from '@/shared/lib/types';

export type ComposerStep = 'parties' | 'materials' | 'review';

const STEP_ORDER: ComposerStep[] = ['parties', 'materials', 'review'];
const STEP_KEY: Record<ComposerStep, string> = {
  parties: 'mv_step_parties',
  materials: 'mv_step_materials',
  review: 'mv_step_review',
};

interface Props {
  lang: Lang;
  dir: 'rtl' | 'ltr';
  title: string;
  step: ComposerStep;
  onStep: (step: ComposerStep) => void;
  canAdvance: boolean;
  /** True until the confirm RPC sequence has begun. */
  nothingPersistedYet: boolean;
  onCancel: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function MovementComposerShell({
  lang, dir, title, step, onStep, canAdvance, nothingPersistedYet, onCancel, children, footer,
}: Props) {
  const index = STEP_ORDER.indexOf(step);

  return (
    <div dir={dir} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: '16px', fontWeight: 700 }}>{title}</h3>
        <PhoenixButton variant="ghost" onClick={onCancel}>{t('mv_cancel', lang)}</PhoenixButton>
      </div>

      {/* Steps are clickable BACKWARDS only: an operator may revisit what they
          entered, but cannot skip a step they have not completed. */}
      <div role="tablist" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {STEP_ORDER.map((s, i) => {
          const active = s === step;
          const reachable = i <= index;
          return (
            <button
              key={s}
              role="tab"
              aria-selected={active}
              disabled={!reachable}
              onClick={() => reachable && onStep(s)}
              style={{
                padding: '8px 14px', minHeight: '44px', borderRadius: 'var(--r3)',
                border: '1px solid var(--brd)', fontSize: '12.5px', fontWeight: 600,
                cursor: reachable ? 'pointer' : 'not-allowed',
                background: active ? 'var(--p2)' : 'var(--s)',
                color: active ? 'var(--pd)' : 'var(--t2)',
                opacity: reachable ? 1 : 0.55,
              }}
            >
              {i + 1}. {t(STEP_KEY[s], lang)}
            </button>
          );
        })}
      </div>

      {nothingPersistedYet && (
        <div
          data-testid="movement-nothing-persisted"
          style={{
            background: 'var(--p2)', border: '1px solid var(--p)', borderRadius: 'var(--r3)',
            padding: '10px 14px', fontSize: '12px', color: 'var(--pd)',
          }}
        >
          {t('mv_nothing_created_yet', lang)}
        </div>
      )}

      <PhoenixCard>{children}</PhoenixCard>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        {index > 0 && (
          <PhoenixButton variant="secondary" onClick={() => onStep(STEP_ORDER[index - 1])}>
            {t('ocr_back_to_review', lang)}
          </PhoenixButton>
        )}
        {index < STEP_ORDER.length - 1 && (
          <PhoenixButton disabled={!canAdvance} onClick={() => onStep(STEP_ORDER[index + 1])}>
            {t(STEP_KEY[STEP_ORDER[index + 1]], lang)}
          </PhoenixButton>
        )}
        {footer}
      </div>
    </div>
  );
}

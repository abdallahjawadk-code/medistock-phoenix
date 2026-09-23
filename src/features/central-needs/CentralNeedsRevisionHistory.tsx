/**
 * C2 — the lifecycle history of ONE plan year, read on request from the narrow
 * `phoenix_central_needs_revision_lifecycle` RPC (central_needs.view).
 *
 * It answers the questions the governed correction lifecycle must keep
 * answerable: which revision was corrected, which successor was created, which
 * revision is effective, who acted, when, and why. Read-only; nothing here can
 * change a revision. Loaded only when the person asks, so rendering the plan
 * panel never issues a request.
 *
 * C4 — the "effective (approved)" mark shown here is a DISPLAY label only. It
 * is shown only when the plan holds exactly one approved revision; more than
 * one, or a lifecycle refusal as ambiguous, shows "ambiguous" and marks nothing.
 */
import { useCallback, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import {
  CentralNeedsError,
  fetchRevisionLifecycle,
  type RevisionLifecycle,
  type RevisionLifecycleEvent,
} from './central-needs.service';
import { centralNeedsErrorText } from './central-needs.i18n';
import { effectiveLabelOf } from './central-needs.revision-open';

type Lang = 'ar' | 'en';

interface Props {
  lang: Lang;
  organizationId: string;
  planYear: number;
}

function eventText(e: RevisionLifecycleEvent, numberOf: (id: string | null) => string, lang: Lang): string {
  const n = e.revisionNumber === null ? '—' : String(e.revisionNumber);
  const fill = (key: string) => t(key, lang)
    .replace('__N__', n)
    .replace('__AFTER__', numberOf(e.openedAfterRevisionId))
    .replace('__BY__', numberOf(e.supersededByRevisionId))
    .replace('__PREV__', numberOf(e.predecessorRevisionId));
  switch (e.action) {
    case 'open': return fill('cn2b_history_open');
    case 'open_correction': return fill('cn2b_history_open_correction');
    case 'submit': return fill('cn2b_history_submit');
    case 'approve': return fill(e.predecessorRevisionId ? 'cn2b_history_approve_replaces' : 'cn2b_history_approve');
    case 'reject': return fill('cn2b_history_reject');
    case 'supersede': return fill('cn2b_history_supersede');
    default: return e.action;
  }
}

export function CentralNeedsRevisionHistory({ lang, organizationId, planYear }: Props) {
  const [state, setState] = useState<
    { phase: 'idle' } | { phase: 'loading' } | { phase: 'done'; history: RevisionLifecycle } | { phase: 'failed'; code: string }
  >({ phase: 'idle' });

  const load = useCallback(async () => {
    setState({ phase: 'loading' });
    try {
      setState({ phase: 'done', history: await fetchRevisionLifecycle(organizationId, planYear) });
    } catch (e: unknown) {
      setState({ phase: 'failed', code: e instanceof CentralNeedsError ? e.code : 'load_failed' });
    }
  }, [organizationId, planYear]);

  // The event rows carry revision ids; the person reads revision numbers.
  const numberOf = (history: RevisionLifecycle) => (id: string | null): string => {
    if (id === null) return '—';
    const hit = history.events.find((ev) => ev.revisionId === id && ev.revisionNumber !== null);
    return hit ? String(hit.revisionNumber) : '—';
  };

  return (
    <section className="cn2b-history" data-testid="cn2b-revision-history" aria-label={t('cn2b_history_title', lang).replace('__YEAR__', String(planYear))}>
      <div className="cn2b-actions">
        <button type="button" className="cn2b-btn" onClick={() => void load()} disabled={state.phase === 'loading'}>
          {t(state.phase === 'done' ? 'cn2b_history_refresh' : 'cn2b_history_show', lang)}
        </button>
      </div>
      {state.phase === 'loading' && <p className="cn2b-hint" role="status">{t('cn2b_history_loading', lang)}</p>}
      {state.phase === 'failed' && <p className="cn2b-hint" role="alert">{centralNeedsErrorText(state.code, lang)}</p>}
      {state.phase === 'failed' && state.code === 'central_needs_lifecycle_state_ambiguous' && (
        <p className="cn2b-hint" data-testid="cn4-effective-label" data-effective="ambiguous">{t('cn4_effective_ambiguous', lang)}</p>
      )}
      {state.phase === 'done' && (() => {
        const label = effectiveLabelOf(state.history);
        if (label.kind === 'ambiguous') {
          return <p className="cn2b-hint" data-testid="cn4-effective-label" data-effective="ambiguous">{t('cn4_effective_ambiguous', lang)}</p>;
        }
        if (label.kind === 'effective') {
          return (
            <p className="cn2b-hint" data-testid="cn4-effective-label" data-effective={label.revisionId}>
              {t('cn4_effective_revision', lang).replace('__N__', String(label.revisionNumber))}
            </p>
          );
        }
        return <p className="cn2b-hint" data-testid="cn4-effective-label" data-effective="none">{t('cn4_effective_none', lang)}</p>;
      })()}
      {state.phase === 'done' && (
        state.history.events.length === 0
          ? <p className="cn2b-hint">{t('cn2b_history_empty', lang)}</p>
          : (
            <ol className="cn2b-history__list">
              {state.history.events.map((e, i) => (
                <li key={`${e.revisionId}:${e.action}:${i}`} data-action={e.action} data-revision={e.revisionNumber ?? ''}>
                  <time dateTime={e.occurredAt}>{new Date(e.occurredAt).toLocaleString(lang === 'ar' ? 'ar' : 'en')}</time>
                  {' — '}
                  <span>{eventText(e, numberOf(state.history), lang)}</span>
                  {e.reason !== null && (
                    <>
                      {' — '}
                      <span>{t('cn2b_history_reason', lang).replace('__REASON__', e.reason)}</span>
                    </>
                  )}
                </li>
              ))}
            </ol>
          )
      )}
    </section>
  );
}

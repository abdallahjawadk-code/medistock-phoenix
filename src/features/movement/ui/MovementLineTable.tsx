/**
 * MOVEMENT-COMPOSER-A — the composed draft lines, shared by supply and return.
 *
 * Purely local: editing here touches no RPC. Validation issues are shown per
 * line so an operator sees exactly which row blocks confirmation rather than a
 * single unhelpful "invalid request".
 */
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { t } from '@/shared/i18n/strings';
import type { Lang } from '@/shared/lib/types';
import type { DraftLine, DraftLineIssue } from '../composer-model';

const dash = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? '—' : v);

interface Props {
  lang: Lang;
  lines: readonly DraftLine[];
  issues: readonly DraftLineIssue[];
  onChangeQuantity: (idempotencyKey: string, quantity: number) => void;
  onRemove: (idempotencyKey: string) => void;
  /** Per-line commit state, once a commit has been attempted. */
  lineStates?: Record<string, { state: 'pending' | 'succeeded' | 'failed'; error: string | null }>;
  readOnly?: boolean;
}

export function MovementLineTable({
  lang, lines, issues, onChangeQuantity, onRemove, lineStates, readOnly,
}: Props) {
  if (lines.length === 0) {
    return <PhoenixEmptyState icon="package" title={t('mv_no_lines', lang)} />;
  }

  return (
    <div style={{ display: 'grid', gap: '10px' }} data-testid="movement-line-table">
      {lines.map((line, index) => {
        const lineIssues = issues.filter(i => i.idempotencyKey === line.idempotencyKey);
        const state = lineStates?.[line.idempotencyKey];

        return (
          <PhoenixCard key={line.idempotencyKey}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '13px', fontWeight: 700 }}>
                  {index + 1}. {line.scientificName}
                  {state && (
                    <span style={{
                      marginInlineStart: '8px', fontSize: '10px', fontWeight: 700,
                      padding: '2px 8px', borderRadius: 'var(--rpill)',
                      background: state.state === 'succeeded' ? 'var(--ok2)' : state.state === 'failed' ? 'var(--err2)' : 'var(--s)',
                      color: state.state === 'succeeded' ? 'var(--ok)' : state.state === 'failed' ? 'var(--err)' : 'var(--t2)',
                    }}>
                      {t(state.state === 'succeeded' ? 'mv_line_succeeded' : state.state === 'failed' ? 'mv_line_failed' : 'mv_ev_created', lang)}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>
                  {dash(line.concentration)} · {dash(line.dosageForm)} · {dash(line.unit)} ·{' '}
                  {t('mv_f_batch_number', lang)}: {dash(line.batchNumber)} ·{' '}
                  {t('mv_f_expiry_date', lang)}: {dash(line.expiryDate)}
                </div>
                {line.reasonCode && (
                  <div style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
                    {t('mv_f_return_reason', lang)}: {line.reasonCode}
                  </div>
                )}
                {lineIssues.map(issue => (
                  <div key={issue.code} style={{ fontSize: '11.5px', color: 'var(--err)', fontWeight: 700, marginTop: '3px' }}>
                    {t(`mv_e_${issue.code}`, lang)}{issue.detail ? ` (${issue.detail})` : ''}
                  </div>
                ))}
                {state?.error && (
                  <div style={{ fontSize: '11.5px', color: 'var(--err)', marginTop: '3px' }}>{state.error}</div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                <PhoenixInput
                  label={t('inv_quantity_received', lang)}
                  value={String(line.quantity)}
                  inputMode="numeric"
                  disabled={readOnly}
                  onChange={e => onChangeQuantity(line.idempotencyKey, Number(e.target.value))}
                  style={{ maxWidth: '110px' }}
                />
                <span style={{ fontSize: '11px', color: 'var(--t2)', paddingBottom: '12px' }}>
                  / {line.maxQuantity}
                </span>
                {!readOnly && (
                  <PhoenixButton variant="ghost" onClick={() => onRemove(line.idempotencyKey)}>
                    {t('mv_remove_line', lang)}
                  </PhoenixButton>
                )}
              </div>
            </div>
          </PhoenixCard>
        );
      })}
    </div>
  );
}

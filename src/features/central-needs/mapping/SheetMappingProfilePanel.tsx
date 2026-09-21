/**
 * E2-B — the Sheet Mapping Profile panel.
 *
 * Where the HUMAN declares, for the sheet they are looking at in the trusted
 * source viewer, which whole physical column holds the National Code and which
 * holds the Material. Presentational: it renders the state held by
 * `useSheetMappingProfile` and reports which role button was pressed — never a
 * coordinate. The column comes only from E2-A's trusted selection.
 *
 * NOTHING IS INFERRED. The panel receives no workbook data at all: no cell,
 * header or value reaches it, so it cannot propose, pre-select or check a role
 * from content, a sheet name, a file name or a column's position. The sheet
 * name and the column letter are shown as labels of what the human selected.
 *
 * The E1 viewer stays a generic physical evidence and selection surface; this
 * panel sits beside it and owns every word about roles.
 */
import { useId, useRef } from 'react';
import { t, type Lang } from '@/shared/i18n/strings';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { columnLetters } from '../excel-first/excelViewerModel';
import {
  MAPPING_ROLES,
  roleColumn,
  type MappingOutcome,
  type MappingRole,
  type SheetMappingState,
} from './sheetMappingProfile';
import type { WorkbookSelection } from '../excel-first/workbookSelection';

interface Props {
  lang: Lang;
  state: SheetMappingState;
  onAssign: (role: MappingRole) => void;
  onClear: (role: MappingRole) => void;
}

const ROLE_LABEL: Record<MappingRole, string> = {
  national_code: 'cn2b_map_role_national_code',
  material: 'cn2b_map_role_material',
};
const USE_LABEL: Record<MappingRole, string> = {
  national_code: 'cn2b_map_use_national_code',
  material: 'cn2b_map_use_material',
};
const USE_LABEL_IDLE: Record<MappingRole, string> = {
  national_code: 'cn2b_map_use_national_code_idle',
  material: 'cn2b_map_use_material_idle',
};
const OTHER_ROLE: Record<MappingRole, MappingRole> = { national_code: 'material', material: 'national_code' };

/** Each new outcome object gets its own id, so a repeated message is announced again. */
const outcomeIds = new WeakMap<MappingOutcome, number>();
let lastOutcomeId = 0;
function outcomeId(outcome: MappingOutcome): number {
  let id = outcomeIds.get(outcome);
  if (id === undefined) {
    lastOutcomeId += 1;
    id = lastOutcomeId;
    outcomeIds.set(outcome, id);
  }
  return id;
}

const columnText = (col: number, lang: Lang) => t('cn2b_map_column', lang).replace('__COL__', columnLetters(col));

function selectionText(selection: WorkbookSelection, lang: Lang): string {
  if (selection.kind === 'column') return columnText(selection.columnIndex, lang);
  if (selection.kind === 'cell') return t('cn2b_map_cell', lang).replace('__REF__', selection.a1);
  return t('cn2b_map_range', lang).replace('__REF__', selection.a1Range);
}

function outcomeMessage(outcome: MappingOutcome, lang: Lang): { tone: 'status' | 'alert'; text: string } {
  const role = (r: MappingRole) => t(ROLE_LABEL[r], lang);
  switch (outcome.kind) {
    case 'assigned':
      return {
        tone: 'status',
        text: t('cn2b_map_done_assigned', lang)
          .replace('__COL__', columnLetters(outcome.columnIndex))
          .replace('__ROLE__', role(outcome.role)),
      };
    case 'cleared':
      return { tone: 'status', text: t('cn2b_map_done_cleared', lang).replace('__ROLE__', role(outcome.role)) };
    case 'reset':
      return { tone: 'status', text: t('cn2b_map_done_reset', lang) };
    case 'refused':
      if (outcome.reason === 'ROLE_CONFLICT' && outcome.columnIndex !== undefined) {
        return {
          tone: 'alert',
          text: t('cn2b_map_err_conflict', lang)
            .replace('__COL__', columnLetters(outcome.columnIndex))
            .replace('__OTHER__', role(OTHER_ROLE[outcome.role])),
        };
      }
      if (outcome.reason === 'NOT_COLUMN_SELECTION' || outcome.reason === 'NO_TRUSTED_SELECTION') {
        return { tone: 'alert', text: t('cn2b_map_err_not_column', lang) };
      }
      return { tone: 'alert', text: t('cn2b_map_err_refused', lang) };
  }
}

export function SheetMappingProfilePanel({ lang, state, onAssign, onClear }: Props) {
  const idPrefix = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const { profile, selection, outcome } = state;
  const ready = profile !== null && selection !== null;
  const selectedColumn = ready && selection.kind === 'column' ? selection.columnIndex : null;
  const message = outcome ? outcomeMessage(outcome, lang) : null;
  const titleId = `${idPrefix}-title`;
  const hintId = `${idPrefix}-hint`;

  function clearRole(role: MappingRole) {
    onClear(role);
    // The Clear button disappears with the assignment; keep focus on a live control.
    const assign = sectionRef.current?.querySelector<HTMLButtonElement>(`[data-testid="cn2b-map-assign-${role}"]`);
    if (assign && !assign.disabled) assign.focus();
    else titleRef.current?.focus();
  }

  return (
    <section
      ref={sectionRef}
      className="cn2b-map"
      aria-labelledby={titleId}
      lang={lang}
      dir={lang === 'ar' ? 'rtl' : 'ltr'}
      data-testid="cn2b-map-panel"
      data-mapping-state={ready ? 'ready' : 'unavailable'}
    >
      <p className="cn2b-map__eyebrow">
        <PhoenixIcon name="lock" size={14} inline aria-hidden="true" /> {t('cn2b_map_eyebrow', lang)}
      </p>
      <h2 className="cn2b-map__title" id={titleId} ref={titleRef} tabIndex={-1}>{t('cn2b_map_title', lang)}</h2>
      <p className="cn2b-map__lead">{t('cn2b_map_lead', lang)}</p>

      {ready ? (
        <dl className="cn2b-map__context">
          <div className="cn2b-map__pair">
            <dt>{t('cn2b_xl_sheet', lang)}</dt>
            <dd data-testid="cn2b-map-sheet"><bdi>{profile.sheetName}</bdi></dd>
          </div>
          <div className="cn2b-map__pair">
            <dt>{t('cn2b_map_selected', lang)}</dt>
            <dd data-testid="cn2b-map-selected" data-selection-kind={selection.kind}><bdi>{selectionText(selection, lang)}</bdi></dd>
          </div>
        </dl>
      ) : (
        <p className="cn2b-map__hint" id={hintId} role="status" data-testid="cn2b-map-unavailable">
          {t('cn2b_map_unavailable', lang)}
        </p>
      )}

      {ready && selectedColumn === null && (
        <p className="cn2b-map__hint" id={hintId} data-testid="cn2b-map-column-required">{t('cn2b_map_column_required', lang)}</p>
      )}

      <div className="cn2b-map__actions" role="group" aria-label={t('cn2b_map_actions', lang)}>
        {MAPPING_ROLES.map((role) => (
          <PhoenixButton
            key={role}
            type="button"
            variant="secondary"
            disabled={selectedColumn === null}
            aria-describedby={selectedColumn === null ? hintId : undefined}
            onClick={() => onAssign(role)}
            data-testid={`cn2b-map-assign-${role}`}
            style={{ whiteSpace: 'normal', textAlign: 'start' }}
          >
            {selectedColumn === null
              ? t(USE_LABEL_IDLE[role], lang)
              : t(USE_LABEL[role], lang).replace('__COL__', columnLetters(selectedColumn))}
          </PhoenixButton>
        ))}
      </div>

      <dl className="cn2b-map__roles" aria-label={t('cn2b_map_roles', lang)} data-testid="cn2b-map-roles">
        {MAPPING_ROLES.map((role) => {
          const col = profile ? roleColumn(profile, role) : null;
          return (
            <div
              key={role}
              className="cn2b-map__role"
              data-testid={`cn2b-map-role-${role}`}
              data-column-index={col === null ? '' : String(col)}
            >
              <dt className="cn2b-map__role-name">{t(ROLE_LABEL[role], lang)}</dt>
              <dd className="cn2b-map__role-value">
                {col === null ? (
                  <span className="cn2b-map__unassigned">{t('cn2b_map_not_assigned', lang)}</span>
                ) : (
                  <>
                    <bdi>{columnText(col, lang)}</bdi>
                    <PhoenixButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => clearRole(role)}
                      aria-label={t('cn2b_map_clear_label', lang)
                        .replace('__ROLE__', t(ROLE_LABEL[role], lang))
                        .replace('__COL__', columnLetters(col))}
                      data-testid={`cn2b-map-clear-${role}`}
                    >
                      {t('cn2b_map_clear', lang)}
                    </PhoenixButton>
                  </>
                )}
              </dd>
            </div>
          );
        })}
      </dl>

      <p className="cn2b-map__status" role="status" data-testid="cn2b-map-status">
        {message?.tone === 'status' && outcome ? <span key={outcomeId(outcome)}>{message.text}</span> : null}
      </p>
      {message?.tone === 'alert' && outcome && (
        <p key={outcomeId(outcome)} className="cn2b-map__alert" role="alert" data-testid="cn2b-map-alert">
          <PhoenixIcon name="warning" size={15} inline aria-hidden="true" /> {message.text}
        </p>
      )}
    </section>
  );
}

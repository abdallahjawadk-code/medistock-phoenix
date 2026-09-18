/**
 * E1 — the cell inspector of the read-only original-workbook viewer.
 *
 * It states, for the selected coordinate, exactly what the parser recorded
 * and nothing more:
 *  - the coordinate, always in A1 form;
 *  - which of the three presence states applies — no cell in the file, a
 *    cell with no value, or a value (a numeric zero is a value);
 *  - the ORIGINAL value, verbatim, beside (never replaced by) the workbook's
 *    formatted text;
 *  - a formula as text only, with the value the file itself saved for it —
 *    this viewer never calculates anything;
 *  - an error code, a comment, and the merged range the cell anchors, with
 *    any values Excel hides inside that range disclosed rather than dropped.
 *
 * Technical detail (the evidence record itself, the file fingerprint) lives
 * in a collapsed audit section, so everyday users are not shown parser terms.
 * Everything is rendered as React text; nothing here can execute cell content.
 */
import { useId, type ReactNode } from 'react';
import { t, type Lang } from '@/shared/i18n/strings';
import type { CellEvidence, FileParseResult, SheetEvidence } from '../import/contract.ts';
import {
  a1Address,
  hiddenValuesInMerge,
  rawValueText,
  type GridPoint,
  type SheetGridModel,
} from './excelViewerModel';

interface Props {
  lang: Lang;
  model: SheetGridModel;
  file: FileParseResult;
  selected: GridPoint | null;
}

function presenceKey(cell: CellEvidence | undefined): string {
  if (!cell) return 'cn2b_xl_presence_missing';
  return cell.presence === 'blank' ? 'cn2b_xl_presence_blank' : 'cn2b_xl_presence_value';
}

function visibilityKey(sheet: SheetEvidence): string {
  if (sheet.hidden === 'very_hidden') return 'cn2b_xl_sheet_very_hidden';
  if (sheet.hidden === 'hidden') return 'cn2b_xl_sheet_hidden';
  return 'cn2b_xl_sheet_visible';
}

function Item({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <div className="cn2b-xl-inspector__item" data-testid={testId}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function ExcelCellInspector({ lang, model, file, selected }: Props) {
  const titleId = useId();
  if (!selected) {
    return (
      <section className="cn2b-xl-inspector" aria-labelledby={titleId} data-testid="cn2b-xl-inspector">
        <h4 className="cn2b-xl-inspector__title" id={titleId}>{t('cn2b_xl_cell_details', lang)}</h4>
        <p className="cn2b-xl-inspector__hint">{t('cn2b_xl_pick_cell', lang)}</p>
      </section>
    );
  }

  const cell = model.cellAt(selected.row, selected.col);
  const a1 = a1Address(selected.row, selected.col);
  const region = model.mergeAt(selected.row, selected.col);
  const hidden = region ? hiddenValuesInMerge(model, region) : null;
  const hasValue = cell?.presence === 'value';

  return (
    <section
      className="cn2b-xl-inspector"
      aria-labelledby={titleId}
      aria-live="polite"
      data-testid="cn2b-xl-inspector"
      data-a1={a1}
    >
      <h4 className="cn2b-xl-inspector__title" id={titleId}>{t('cn2b_xl_cell_details', lang)}</h4>
      <dl className="cn2b-xl-inspector__list">
        <Item label={t('cn2b_xl_cell', lang)} testId="cn2b-xl-inspect-a1">
          <bdi className="cn2b-xl-inspector__coord">{a1}</bdi>
          {' · '}
          <bdi>{model.sheet.name}</bdi>
        </Item>
        <Item label={t('cn2b_xl_state', lang)} testId="cn2b-xl-inspect-presence">
          {t(presenceKey(cell), lang)}
        </Item>
        <Item label={t('cn2b_xl_raw_value', lang)} testId="cn2b-xl-inspect-raw">
          {hasValue
            ? <code className="cn2b-xl-inspector__value" dir="auto">{rawValueText(cell.rawValue)}</code>
            : <span className="cn2b-xl-inspector__none">—</span>}
        </Item>
        {hasValue && cell.valueType && (
          <Item label={t('cn2b_xl_value_type', lang)} testId="cn2b-xl-inspect-type">
            {t(`cn2b_xl_type_${cell.valueType}`, lang)}
          </Item>
        )}
        {cell?.formattedText !== undefined && (
          <Item label={t('cn2b_xl_formatted', lang)} testId="cn2b-xl-inspect-formatted">
            <code className="cn2b-xl-inspector__value" dir="auto">{cell.formattedText}</code>
          </Item>
        )}
        {cell?.isFormula && (
          <Item label={t('cn2b_xl_formula', lang)} testId="cn2b-xl-inspect-formula">
            <code className="cn2b-xl-inspector__value" dir="ltr">{cell.formula ?? ''}</code>
            <span className="cn2b-xl-inspector__hint">
              {t('cn2b_formula_not_evaluated', lang)} {hasValue ? t('cn2b_xl_formula_cached_note', lang) : ''}
            </span>
          </Item>
        )}
        {cell?.valueType === 'error' && (
          <Item label={t('cn2b_xl_error', lang)} testId="cn2b-xl-inspect-error">
            <code className="cn2b-xl-inspector__value" dir="ltr">{cell.errorCode ?? rawValueText(cell.rawValue)}</code>
          </Item>
        )}
        {cell?.hasComment && (
          <Item label={t('cn2b_xl_comment', lang)} testId="cn2b-xl-inspect-comment">
            <span className="cn2b-xl-inspector__value" dir="auto">{cell.commentText ?? ''}</span>
          </Item>
        )}
        {region && hidden && (
          <Item label={t('cn2b_xl_merged', lang)} testId="cn2b-xl-inspect-merged">
            <bdi className="cn2b-xl-inspector__coord">{region.range}</bdi>
            {hidden.total !== null && hidden.total > 0 && (
              <span className="cn2b-xl-inspector__hint" data-testid="cn2b-xl-inspect-merged-hidden">
                {t('cn2b_xl_merged_hidden_values', lang).replace('__N__', String(hidden.total))}
                {' '}
                {hidden.cells.map((c) => (
                  <bdi key={c.coordinate.a1} className="cn2b-xl-inspector__hidden-cell">
                    {c.coordinate.a1}: {rawValueText(c.rawValue)}
                  </bdi>
                ))}
              </span>
            )}
            {!hidden.scanComplete && (
              <span className="cn2b-xl-inspector__hint" data-testid="cn2b-xl-inspect-merged-limited">
                {t('cn2b_xl_merged_scan_limited', lang).replace('__N__', String(hidden.scannedEvidenceCount))}
                {' '}
                {hidden.cells.map((c) => (
                  <bdi key={c.coordinate.a1} className="cn2b-xl-inspector__hidden-cell">
                    {c.coordinate.a1}: {rawValueText(c.rawValue)}
                  </bdi>
                ))}
              </span>
            )}
          </Item>
        )}
      </dl>

      <details className="cn2b-xl-audit" data-testid="cn2b-xl-audit">
        <summary>{t('cn2b_xl_audit', lang)}</summary>
        <dl className="cn2b-xl-inspector__list">
          <Item label={t('cn2b_xl_sheet', lang)} testId="cn2b-xl-audit-sheet">
            <bdi>{model.sheet.name}</bdi> · #{model.sheet.index + 1} · {t(visibilityKey(model.sheet), lang)}
          </Item>
          <Item label={t('cn2b_xl_file', lang)} testId="cn2b-xl-audit-file">
            <bdi>{file.input.archiveEntryPath ?? file.input.originalFilename}</bdi>
          </Item>
          <Item label={t('cn2b_xl_fingerprint', lang)} testId="cn2b-xl-audit-sha">
            <code className="cn2b-xl-inspector__value" dir="ltr">{file.input.sha256}</code>
          </Item>
        </dl>
        <pre className="cn2b-xl-audit__record" dir="ltr" data-testid="cn2b-xl-audit-record">
          {cell ? JSON.stringify(cell, null, 2) : `${a1}: null`}
        </pre>
      </details>
    </section>
  );
}

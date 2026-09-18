/**
 * E1 — Excel-First: the read-only ORIGINAL WORKBOOK viewer.
 *
 * Shows the workbook the user just chose, inside MediStock, as the CN-2A
 * parser already read it: its sheets in their own order, its cells at their
 * own coordinates, and — for any selected cell — the exact evidence recorded
 * for it.
 *
 * ONE PARSE. The input is the `FileParseResult`/`ArchiveParseResult` the
 * existing browser preview (`useCentralNeedsPreview`) already produced. This
 * component starts no Worker, calls no parser and imports no spreadsheet
 * library; switching workbook, sheet or cell only changes what is displayed.
 *
 * READ-ONLY AND NON-AUTHORITATIVE. It has no write path: no service call, no
 * RPC, no storage access. It maps nothing, allocates nothing and infers
 * nothing — it is a window onto source evidence, not a decision surface.
 *
 * ZIP. An archive preview already carries one per-workbook result per entry,
 * so the only archive-specific behaviour here is choosing which of those
 * already-parsed workbooks to look at. An entry the parser rejected is listed
 * and labelled as unreadable, never hidden.
 */
import { useId, useMemo, useState, type ChangeEvent } from 'react';
import { t, type Lang } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import type { ArchiveParseResult, FileParseResult } from '../import/contract.ts';
import { ExcelCellInspector } from './ExcelCellInspector';
import { ExcelSheetGrid } from './ExcelSheetGrid';
import { ExcelSheetTabs } from './ExcelSheetTabs';
import {
  buildSheetGridModel,
  initialSheetIndex,
  initialWorkbookIndex,
  listViewerWorkbooks,
  type GridPoint,
} from './excelViewerModel';

interface Props {
  lang: Lang;
  kind: 'file' | 'archive';
  result: FileParseResult | ArchiveParseResult;
}

interface ViewState {
  /** The result this state belongs to — a new preview starts from a fresh view. */
  result: FileParseResult | ArchiveParseResult;
  workbookIndex: number;
  sheetIndex: number;
  selected: GridPoint | null;
}

function freshView(result: FileParseResult | ArchiveParseResult, files: FileParseResult[]): ViewState {
  const workbookIndex = initialWorkbookIndex(files);
  return { result, workbookIndex, sheetIndex: initialSheetIndex(files[workbookIndex]), selected: null };
}

function workbookLabel(file: FileParseResult): string {
  return file.input.archiveEntryPath ?? file.input.originalFilename;
}

export function ExcelWorkbookViewer({ lang, kind, result }: Props) {
  const idPrefix = useId();
  const files = useMemo(() => listViewerWorkbooks(kind, result), [kind, result]);
  const [stored, setStored] = useState<ViewState>(() => freshView(result, files));
  const view = stored.result === result ? stored : freshView(result, files);
  if (view !== stored) setStored(view);

  const file = files[view.workbookIndex];
  const sheets = file?.workbook?.sheets ?? [];
  const sheet = sheets[view.sheetIndex];
  const model = useMemo(() => (sheet ? buildSheetGridModel(sheet) : null), [sheet]);

  const archiveName = kind === 'archive' && 'archive' in result ? result.archive.originalFilename : null;
  const titleId = `${idPrefix}-title`;
  const panelId = `${idPrefix}-panel`;
  const tabId = (index: number) => `${idPrefix}-tab-${index}`;

  function chooseWorkbook(event: ChangeEvent<HTMLSelectElement>) {
    const workbookIndex = Number(event.target.value);
    setStored({ result, workbookIndex, sheetIndex: initialSheetIndex(files[workbookIndex]), selected: null });
  }

  function chooseSheet(sheetIndex: number) {
    setStored({ ...view, sheetIndex, selected: null });
  }

  function chooseCell(point: GridPoint) {
    setStored({ ...view, selected: point });
  }

  return (
    <section className="cn2b-xl" aria-labelledby={titleId} data-testid="cn2b-xl-viewer">
      <header className="cn2b-xl__head">
        <div className="cn2b-xl__identity">
          <h3 className="cn2b-xl__title" id={titleId}>{t('cn2b_xl_title', lang)}</h3>
          <p className="cn2b-xl__file" data-testid="cn2b-xl-filename">
            <PhoenixIcon name="file" size={15} inline aria-hidden="true" />{' '}
            <bdi>{archiveName ?? (file ? workbookLabel(file) : '')}</bdi>
          </p>
        </div>
        <span className="cn2b-xl__badge" data-testid="cn2b-xl-readonly">
          <PhoenixIcon name="lock" size={14} inline aria-hidden="true" /> {t('cn2b_xl_read_only', lang)}
        </span>
      </header>
      <p className="cn2b-xl__note">{t('cn2b_xl_note', lang)}</p>

      {kind === 'archive' && files.length > 0 && (
        <label className="cn2b-xl__workbook">
          <span className="cn2b-xl__workbook-label">{t('cn2b_xl_workbook', lang)}</span>
          <select
            className="cn2b-xl__select"
            value={view.workbookIndex}
            onChange={chooseWorkbook}
            data-testid="cn2b-xl-workbook-select"
          >
            {files.map((f, i) => (
              <option key={`${i}:${f.input.sha256}`} value={i}>
                {workbookLabel(f)}{f.workbook === null ? ` — ${t('cn2b_xl_workbook_unreadable_short', lang)}` : ''}
              </option>
            ))}
          </select>
        </label>
      )}

      {files.length === 0 && (
        <p className="cn2b-xl__empty" role="status" data-testid="cn2b-xl-no-workbooks">{t('cn2b_xl_no_workbooks', lang)}</p>
      )}

      {file && file.workbook === null && (
        <p className="cn2b-xl__empty" role="status" data-testid="cn2b-xl-unreadable">{t('cn2b_xl_workbook_unreadable', lang)}</p>
      )}

      {sheets.length > 0 && (
        <ExcelSheetTabs
          lang={lang}
          sheets={sheets}
          activeIndex={view.sheetIndex}
          onSelect={chooseSheet}
          tabId={tabId}
          panelId={panelId}
        />
      )}

      {sheet && file && model && (
        <div className="cn2b-xl__panel" role="tabpanel" id={panelId} aria-labelledby={tabId(view.sheetIndex)}>
          {sheet.hidden !== 'visible' && (
            <p className="cn2b-xl__hidden-notice" role="note" data-testid="cn2b-xl-hidden-notice">
              <PhoenixIcon name="warning" size={15} inline aria-hidden="true" />{' '}
              {t(sheet.hidden === 'very_hidden' ? 'cn2b_xl_sheet_very_hidden_notice' : 'cn2b_xl_sheet_hidden_notice', lang)}
            </p>
          )}
          {model.mergeSafety.limited && (
            <p className="cn2b-xl__hidden-notice" role="note" data-testid="cn2b-xl-merge-safety-notice">
              <PhoenixIcon name="warning" size={15} inline aria-hidden="true" />{' '}
              {t('cn2b_xl_merge_display_limited', lang)
                .replace('__N__', String(model.mergeSafety.safetySuppressedMergeCount))
                .replace('__TOTAL__', String(model.mergeSafety.sourceMergeCount))}
            </p>
          )}
          {model.mergeSafety.outOfExtentMergeCount > 0 && (
            <p className="cn2b-xl__hidden-notice" role="note" data-testid="cn2b-xl-merge-outside-notice">
              <PhoenixIcon name="warning" size={15} inline aria-hidden="true" />{' '}
              {t('cn2b_xl_merge_outside_used_area', lang)
                .replace('__N__', String(model.mergeSafety.outOfExtentMergeCount))}
            </p>
          )}
          {model.extent ? (
            <ExcelSheetGrid
              key={`${file.input.sha256}:${view.workbookIndex}:${view.sheetIndex}`}
              model={model}
              extent={model.extent}
              selected={view.selected}
              onSelect={chooseCell}
              label={`${t('cn2b_xl_grid_label', lang)} — ${sheet.name}`}
              idPrefix={`${idPrefix}-cell`}
            />
          ) : (
            <p className="cn2b-xl__empty" data-testid="cn2b-xl-empty-sheet">{t('cn2b_xl_sheet_empty', lang)}</p>
          )}
          {model.extent && <ExcelCellInspector lang={lang} model={model} file={file} selected={view.selected} />}
        </div>
      )}
    </section>
  );
}

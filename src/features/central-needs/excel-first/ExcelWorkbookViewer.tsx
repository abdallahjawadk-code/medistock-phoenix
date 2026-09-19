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
 *
 * E2-A (opt-in `selection`). A caller that holds TRUSTED source identities —
 * proven by `sourceIdentityBridge.ts` — may observe the human's physical
 * selection (cell, column, rectangle) as a `WorkbookSelection`. Without that
 * prop, or when the displayed workbook has no proven identity, the viewer is
 * exactly the E1 viewer and reports nothing. A selection never survives a
 * change of result, workbook, sheet or source identity, and it lives only in
 * this component's memory.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
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
  moveSelection,
  type GridPoint,
} from './excelViewerModel';
import {
  selectionKey,
  shapeRect,
  toWorkbookSelection,
  type GridSelectionShape,
  type WorkbookSelection,
  type WorkbookSourceIdentity,
} from './workbookSelection';

/** E2-A: trusted identities (one per workbook index) and the listener for the physical selection. */
export interface ViewerSelectionOptions {
  identities: readonly WorkbookSourceIdentity[];
  onChange: (selection: WorkbookSelection | null) => void;
}

interface Props {
  lang: Lang;
  kind: 'file' | 'archive';
  result: FileParseResult | ArchiveParseResult;
  /** E2-A, optional. Absent = the read-only E1 viewer, reporting nothing. */
  selection?: ViewerSelectionOptions;
}

interface ViewState {
  /** The result this state belongs to — a new preview starts from a fresh view. */
  result: FileParseResult | ArchiveParseResult;
  /** The source identities this state belongs to — new identities clear the selection. */
  identityKey: string;
  workbookIndex: number;
  sheetIndex: number;
  selected: GridPoint | null;
  shape: GridSelectionShape;
}

const CELL_SHAPE: GridSelectionShape = { kind: 'cell' };

function freshView(result: FileParseResult | ArchiveParseResult, files: FileParseResult[], identityKey: string): ViewState {
  const workbookIndex = initialWorkbookIndex(files);
  return {
    result, identityKey, workbookIndex, sheetIndex: initialSheetIndex(files[workbookIndex]), selected: null, shape: CELL_SHAPE,
  };
}

function identitiesKey(options: ViewerSelectionOptions | undefined): string {
  if (!options) return '';
  return options.identities
    .map((i) => `${i.workbookIndex}|${i.batchId}|${i.entryId}|${i.entryOrdinal}|${i.entrySha256}|${i.importSessionId}`)
    .join(';') || 'none';
}

function workbookLabel(file: FileParseResult): string {
  return file.input.archiveEntryPath ?? file.input.originalFilename;
}

export function ExcelWorkbookViewer({ lang, kind, result, selection }: Props) {
  const idPrefix = useId();
  const files = useMemo(() => listViewerWorkbooks(kind, result), [kind, result]);
  const identityKey = identitiesKey(selection);
  const [stored, setStored] = useState<ViewState>(() => freshView(result, files, identityKey));
  let view = stored.result === result ? stored : freshView(result, files, identityKey);
  if (view.identityKey !== identityKey) view = { ...view, identityKey, selected: null, shape: CELL_SHAPE };
  if (view !== stored) setStored(view);

  const file = files[view.workbookIndex];
  const sheets = file?.workbook?.sheets ?? [];
  const sheet = sheets[view.sheetIndex];
  const model = useMemo(() => (sheet ? buildSheetGridModel(sheet) : null), [sheet]);

  // E2-A: exactly one proven identity for the displayed workbook, or no selection at all.
  const matches = selection ? selection.identities.filter((i) => i.workbookIndex === view.workbookIndex) : [];
  const identity = matches.length === 1 ? matches[0] : null;
  const selectable = identity !== null && !!sheet && !!model?.extent;
  const current = selectable && model
    ? toWorkbookSelection(identity, sheet, view.selected, view.shape, model.mergeAt)
    : null;
  const currentKey = current ? selectionKey(current) : '';
  const rect = selectable && model?.extent
    ? shapeRect(view.selected, view.shape, model.mergeAt, {
      first: model.extent.originRow, last: model.extent.originRow + model.extent.rowCount - 1,
    })
    : null;

  // Report the physical selection to the caller, once per change (null included).
  const listener = useRef<ViewerSelectionOptions['onChange'] | undefined>(selection?.onChange);
  useLayoutEffect(() => {
    listener.current = selection?.onChange;
  });
  const reported = useRef<string | null>(null);
  const enabled = selection !== undefined;
  useEffect(() => {
    if (!enabled) {
      reported.current = null;
      return;
    }
    if (reported.current === currentKey) return;
    reported.current = currentKey;
    // `current` is fully described by `currentKey`, so it is not a separate dependency.
    listener.current?.(current);
  }, [enabled, currentKey]);
  useEffect(() => () => {
    if (reported.current) listener.current?.(null);
  }, []);

  const archiveName = kind === 'archive' && 'archive' in result ? result.archive.originalFilename : null;
  const titleId = `${idPrefix}-title`;
  const panelId = `${idPrefix}-panel`;
  const tabId = (index: number) => `${idPrefix}-tab-${index}`;

  function chooseWorkbook(event: ChangeEvent<HTMLSelectElement>) {
    const workbookIndex = Number(event.target.value);
    setStored({
      result, identityKey, workbookIndex, sheetIndex: initialSheetIndex(files[workbookIndex]), selected: null, shape: CELL_SHAPE,
    });
  }

  function chooseSheet(sheetIndex: number) {
    setStored({ ...view, sheetIndex, selected: null, shape: CELL_SHAPE });
  }

  function chooseCell(point: GridPoint) {
    setStored({ ...view, selected: point, shape: CELL_SHAPE });
  }

  /** Shift+click / Shift+Arrow: the anchor stays, the active cell moves. */
  function extendTo(point: GridPoint) {
    if (!selectable || view.selected === null) {
      chooseCell(point);
      return;
    }
    const anchor = view.shape.kind === 'range' ? view.shape.anchor : view.selected;
    setStored({ ...view, selected: point, shape: { kind: 'range', anchor } });
  }

  /** Header button / Ctrl+Space: one physical column. The active cell moves to its top if it was elsewhere. */
  function chooseColumn(col: number) {
    if (!selectable || !model?.extent) return;
    const active = view.selected !== null && view.selected.col === col
      ? view.selected
      : moveSelection(model, { row: model.extent.originRow, col }, 0, 0);
    setStored({ ...view, selected: active, shape: { kind: 'column', col } });
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
              selectable={selectable}
              selectionRect={rect}
              selectedColumn={selectable && view.shape.kind === 'column' ? view.shape.col : null}
              onExtend={extendTo}
              onSelectColumn={chooseColumn}
              columnButtonLabel={(letters) => t('cn2b_xl_select_column', lang).replace('__COL__', letters)}
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

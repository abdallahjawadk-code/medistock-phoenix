/**
 * R1-A3/A4 — optional medicine-identity help from a workbook, reached ONLY through the A3 package entry (`runIdentityAssist`).
 *
 * The person must CONFIRM the header row first; until then nothing is read from the workbook and no lookup is made. After
 * confirmation only the header row and the identity columns are read (the lazy adapter hands over nothing else), a quantity is
 * never read, never shown in the results and never sent anywhere. A suggestion is a suggestion: the person chooses the registered
 * material or files a registration request. The workbook is parsed in the browser by the existing preview; nothing is uploaded.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { runIdentityAssist, lazySheetCells, MAX_IDENTITY_LOOKUPS, type IdentityAssistResult } from '../excel-identity';
import type { PreviewState } from '../useCentralNeedsPreview';
import type { FileParseResult, SheetEvidence } from '../import/contract';
import type { CatalogOption, JourneyApi } from './manual-journey.service';
import type { RegistrationPrefill } from './MaterialRegistrationPanel';
import { MATERIAL_UNITS, type MaterialUnit } from './material-registration.service';
import { jt, type JourneyKey, type JourneyLang } from './manual-journey.i18n';

export interface IdentityPreviewHandle { state: PreviewState; parse: (file: File) => void; reset: () => void }

interface Props {
  lang: JourneyLang;
  scopeKey: string;
  preview: IdentityPreviewHandle;
  resolve: JourneyApi['resolveForIdentity'];
  onUseItem: (item: CatalogOption) => void;
  onRequestRegistration: (prefill: RegistrationPrefill) => void;
}

const SHOW_ROWS = 15;          // rows offered as quick choices; any other row is chosen by its number
const MAX_SHEET_ROWS = 5000;    // the A3 extractor refuses larger sheets anyway

/**
 * How many rows the sheet has - from its declared used range and the cells' COORDINATES only. No cell value, type, presence or
 * formatted text is accessed: the only properties read are `sheet.usedRange` and `cell.coordinate.row`.
 */
function sheetRowCount(sheet: SheetEvidence): number {
  let maxRow = sheet.usedRange ? sheet.usedRange.endRow : -1;
  for (const cell of sheet.cells) if (cell.coordinate.row > maxRow) maxRow = cell.coordinate.row;
  return Math.min(maxRow + 1, MAX_SHEET_ROWS);
}

export function IdentityAssistPanel({ lang, scopeKey, preview, resolve, onUseItem, onRequestRegistration }: Props) {
  const [sheetIndex, setSheetIndex] = useState(0);
  const [headerRow, setHeaderRow] = useState<number | undefined>(undefined);       // NOT confirmed until the person chooses it
  const [rowText, setRowText] = useState('');
  const [result, setResult] = useState<IdentityAssistResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);

  /**
   * ANY change of what a lookup was computed for (header row, typed row, sheet, file, scope, or a new parse) supersedes the request in
   * flight: its answer is ignored (epoch), its remaining lookups are not issued (guarded resolver below), and the panel is neither left
   * busy nor showing a result or a failure that belongs to the previous selection.
   */
  const invalidate = () => {
    epoch.current += 1;
    setBusy(false); setFailed(false); setResult(null);
  };

  useEffect(() => {
    invalidate();
    setSheetIndex(0); setHeaderRow(undefined); setRowText('');
    preview.reset();
  }, [scopeKey]);

  const parsed = preview.state.phase === 'ready' ? preview.state.outcome : null;
  const fileResult = parsed && parsed.kind === 'file' ? (parsed.result as FileParseResult) : null;
  const sheets = useMemo(() => (fileResult?.workbook?.sheets ?? []).filter((s) => s.hidden === 'visible'), [fileResult]);
  const sheet = sheets.find((s) => s.index === sheetIndex) ?? sheets[0] ?? null;
  const rowCount = useMemo(() => (sheet ? sheetRowCount(sheet) : 0), [sheet]);

  // a different parse result (a new file, or the preview was reset elsewhere) is a different selection space
  useEffect(() => {
    invalidate();
    setHeaderRow(undefined); setRowText('');
  }, [fileResult]);

  const onFile = (file: File | undefined) => {
    invalidate();
    setHeaderRow(undefined); setRowText(''); setSheetIndex(0);
    if (file) preview.parse(file);
  };

  const confirm = async () => {
    if (!sheet || !fileResult || headerRow === undefined) return;
    invalidate();                                   // supersede any earlier request; this one owns the new epoch
    const mine = epoch.current;
    // a superseded run stops reaching the network: once the epoch moved on, the remaining lookups resolve to nothing, locally
    const guarded: typeof resolve = async (q) => (epoch.current === mine ? resolve(q) : []);
    setBusy(true);
    try {
      const r = await runIdentityAssist({ sheet: lazySheetCells(sheet), sheetIndex: sheet.index, confirmedHeaderRow: headerRow, resolve: guarded });
      if (epoch.current !== mine) return;
      setResult(r);
    } catch {
      if (epoch.current !== mine) return;
      setFailed(true);
    } finally {
      if (epoch.current === mine) setBusy(false);
    }
  };

  const requestFor = (item: IdentityAssistResult['items'][number]) => {
    if (!fileResult) return;
    const c = item.candidate;
    const unit = (MATERIAL_UNITS as readonly string[]).includes((c.unit ?? '').toLowerCase()) ? ((c.unit as string).toLowerCase() as MaterialUnit) : undefined;
    onRequestRegistration({
      descriptor: { scientificName: c.name, tradeName: c.tradeName, strength: c.strength, dosageForm: c.form, unit, barcode: null },
      pointer: { sheet_index: c.sheetIndex, row: c.row, ...(c.columns.name !== undefined ? { column: c.columns.name } : {}), file_hash: fileResult.input.sha256 },
    });
  };

  return (
    <section aria-labelledby="ia-title" data-testid="identity-assist-panel">
      <h3 id="ia-title">{jt('ia_title', lang)}</h3>
      <p>{jt('ia_explain', lang)}</p>
      <label>{jt('ia_choose_file', lang)}
        <input type="file" accept=".xlsx,.xls,.xlsm" onChange={(e) => onFile(e.target.files?.[0])} />
      </label>

      {preview.state.phase === 'parsing' && <p role="status">{jt('loading', lang)}</p>}
      {preview.state.phase === 'failed' && <p role="alert">{jt('ia_parse_failed', lang)}</p>}
      {parsed && parsed.kind === 'archive' && <p role="alert">{jt('ia_archive_unsupported', lang)}</p>}

      {fileResult && sheet && (
        <div>
          {sheets.length > 1 && (
            <label>{jt('ia_sheet', lang)}
              <select value={sheet.index} onChange={(e) => { invalidate(); setSheetIndex(Number(e.target.value)); setHeaderRow(undefined); setRowText(''); }}>
                {sheets.map((s) => <option key={s.index} value={s.index}>{s.name}</option>)}
              </select>
            </label>
          )}
          <fieldset>
            <legend>{jt('ia_pick_header', lang)}</legend>
            <p>{jt('ia_header_required', lang)}</p>
            <p role="note">{jt('ia_rows_only_note', lang)}</p>
            <div role="radiogroup" aria-label={jt('ia_pick_header_group', lang)}>
              {Array.from({ length: Math.min(SHOW_ROWS, rowCount) }, (_, r) => r).map((r) => (
                <label key={r}>
                  <input type="radio" name="ia-header-row" checked={headerRow === r}
                    onChange={() => { invalidate(); setHeaderRow(r); setRowText(String(r + 1)); }}
                    aria-label={jt('ia_row_n', lang).replace('__N__', String(r + 1))} />
                  {r + 1}
                </label>
              ))}
            </div>
            <label>{jt('ia_header_row_number', lang)}
              <input dir="ltr" inputMode="numeric" value={rowText} aria-invalid={rowText !== '' && headerRow === undefined}
                onChange={(e) => {
                  const t = e.target.value.trim();
                  invalidate();
                  setRowText(e.target.value);
                  const n = /^\d{1,4}$/.test(t) ? Number(t) : NaN;
                  setHeaderRow(Number.isInteger(n) && n >= 1 && n <= rowCount ? n - 1 : undefined);
                }} />
            </label>
            <button type="button" disabled={headerRow === undefined || busy} onClick={() => void confirm()}>{jt('ia_confirm_header', lang)}</button>
          </fieldset>
        </div>
      )}

      <div role="status" aria-live="polite">
        {failed && <span role="alert">{jt('failed', lang)}</span>}
        {result && result.extraction.warnings.map((w) => <p key={w}>{jt(`ia_warning_${w}` as JourneyKey, lang)}</p>)}
        {result && result.extraction.candidates.length === 0 && result.extraction.warnings.length === 0 && <p>{jt('ia_no_candidates', lang)}</p>}
        {result?.truncated && <p>{jt('ia_truncated', lang).replace('__N__', String(MAX_IDENTITY_LOOKUPS))}</p>}
      </div>

      {result && result.items.length > 0 && (
        <table aria-label={jt('ia_title', lang)}>
          <tbody>
            {result.items.map((it) => (
              <tr key={`${it.candidate.sheetIndex}:${it.candidate.row}`} data-kind={it.suggestion.kind}>
                <td dir="auto">{it.candidate.name}</td>
                <td dir="ltr">{[it.candidate.strength, it.candidate.form, it.candidate.unit].filter(Boolean).join(' · ')}</td>
                <td>{jt(`ia_kind_${it.suggestion.kind}` as JourneyKey, lang)}</td>
                <td>
                  {it.suggestion.options.map((o) => (
                    <button key={o.centralItemId} type="button"
                      onClick={() => onUseItem({ id: o.centralItemId, name: o.scientificName, nameAr: o.nameAr, concentration: o.concentration, dosageForm: o.dosageForm, unit: o.unit ?? 'box' })}>
                      {jt('ia_use_item', lang)}: {o.scientificName} {o.conflicts.length > 0 ? `(${o.conflicts.join('/')})` : ''}
                    </button>
                  ))}
                  {(it.suggestion.kind === 'none' || it.suggestion.kind === 'conflict') && (
                    <button type="button" onClick={() => requestFor(it)}>{jt('ia_request_registration', lang)}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

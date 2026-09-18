/**
 * E1 Excel-First — static boundary guards for the read-only viewer.
 *
 * Like `cn2b-trusted-server-and-ui.test.ts` and the Simple Mode contract,
 * these read SOURCE with comments stripped, so prose can neither satisfy nor
 * hide a violation. They pin the E1 boundaries that a runtime test cannot
 * prove exhaustively:
 *   - ONE PARSE: the viewer imports no spreadsheet library, no parser, no
 *     Worker — it only consumes the existing evidence contract;
 *   - READ-ONLY: no service, no Supabase, no network, no storage;
 *   - UNTRUSTED CONTENT: no HTML sinks, no code evaluation, no links, no
 *     editable surface, no stylesheet built from workbook text.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const DIR = 'src/features/central-needs/excel-first';
const viewerFiles = readdirSync(join(ROOT, DIR))
  .filter((name) => /\.(ts|tsx)$/.test(name))
  .map((name) => `${DIR}/${name}`);

/** Everything the viewer is allowed to depend on. Anything else is a scope change. */
const ALLOWED_IMPORTS = new Set([
  'react',
  '@/shared/i18n/strings',
  '@/shared/ui/PhoenixIcon',
  '../import/contract.ts',
  './excelViewerModel',
  './ExcelCellInspector',
  './ExcelSheetGrid',
  './ExcelSheetTabs',
]);

describe('E1 viewer — ONE PARSE: it consumes evidence and parses nothing', () => {
  it('has the expected production files', () => {
    expect(viewerFiles.sort()).toEqual([
      `${DIR}/ExcelCellInspector.tsx`,
      `${DIR}/ExcelSheetGrid.tsx`,
      `${DIR}/ExcelSheetTabs.tsx`,
      `${DIR}/ExcelWorkbookViewer.tsx`,
      `${DIR}/excelViewerModel.ts`,
    ]);
  });

  it('imports only from an allow-list — no spreadsheet library, parser, service or new dependency', () => {
    for (const file of viewerFiles) {
      const specifiers = [...code(file).matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      expect(specifiers.length, file).toBeGreaterThan(0);
      for (const spec of specifiers) expect(ALLOWED_IMPORTS.has(spec), `${file} imports ${spec}`).toBe(true);
      expect(code(file), file).not.toMatch(/\bimport\s*\(/);
      expect(code(file), file).not.toMatch(/\brequire\s*\(/);
    }
  });

  it('the contract is imported for its types only', () => {
    for (const file of viewerFiles) {
      const src = code(file);
      if (!src.includes("'../import/contract.ts'")) continue;
      expect(src, file).toMatch(/import type \{[^}]*\} from '\.\.\/import\/contract\.ts'/);
    }
  });

  it('never names a parser entry point or starts a Worker', () => {
    for (const file of viewerFiles) {
      const src = code(file);
      for (const forbidden of [/\bparseWorkbookBytes\b/, /\bparseArchiveBytes\b/, /\bnew\s+Worker\b/, /\bXLSX\b/, /\bExcelJS\b/]) {
        expect(src, `${file} ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });
});

describe('E1 viewer — READ-ONLY: no write path of any kind', () => {
  it('reaches no service, database, network or persistent storage', () => {
    for (const file of viewerFiles) {
      const src = code(file);
      for (const forbidden of [
        /\.rpc\(/, /\bsupabase\b/, /central-needs\.service/, /\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/,
        /sendBeacon/, /localStorage/, /sessionStorage/, /indexedDB/, /\bsetNeedLine\b/,
      ]) expect(src, `${file} ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it('offers no editable surface for worksheet values', () => {
    for (const file of viewerFiles) {
      const src = code(file);
      expect(src, file).not.toMatch(/contentEditable|contenteditable/);
      expect(src, file).not.toMatch(/<input\b/);
      expect(src, file).not.toMatch(/<textarea\b/);
    }
    // The only form control is the archive workbook chooser; it selects, never edits.
    expect([...code(`${DIR}/ExcelWorkbookViewer.tsx`).matchAll(/<select\b/g)]).toHaveLength(1);
    expect(code(`${DIR}/ExcelSheetGrid.tsx`)).toMatch(/aria-readonly="true"/);
  });
});

describe('E1 viewer — UNTRUSTED workbook content can never execute', () => {
  it('has no HTML sink and evaluates no code', () => {
    for (const file of viewerFiles) {
      const src = code(file);
      for (const forbidden of [
        /dangerouslySetInnerHTML/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/,
        /\beval\s*\(/, /new\s+Function\b/, /\bFunction\s*\(/, /createElement\s*\(/, /DOMParser/,
      ]) expect(src, `${file} ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it('creates no link, frame or navigation from cell text', () => {
    for (const file of viewerFiles) {
      const src = code(file);
      for (const forbidden of [/<a\b/, /\bhref\b/, /<iframe\b/, /<object\b/, /<embed\b/, /window\.open/, /\blocation\./, /srcDoc/]) {
        expect(src, `${file} ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it('builds no stylesheet from workbook text — inline styles are geometry only', () => {
    for (const file of viewerFiles) {
      const src = code(file);
      expect(src, file).not.toMatch(/<style\b/);
      expect(src, file).not.toMatch(/cssText|setProperty\(|insertRule/);
    }
    const grid = code(`${DIR}/ExcelSheetGrid.tsx`);
    const styleBlocks = [...grid.matchAll(/style=\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]);
    expect(styleBlocks.length).toBeGreaterThan(0);
    for (const block of styleBlocks) {
      expect(block).not.toMatch(/\btext\b|rawValue|formattedText|\bcell\b|\.name\b/);
    }
  });

  it('keeps hostile merge geometry out of the scroll-time linear path', () => {
    const grid = code(`${DIR}/ExcelSheetGrid.tsx`);
    const model = code(`${DIR}/excelViewerModel.ts`);
    expect(grid).toMatch(/model\.mergesInWindow\(win\)/);
    expect(grid).not.toMatch(/model\.merges\.filter/);
    expect(model).toMatch(/MERGE_PROCESS_LIMIT\s*=\s*10_000/);
    expect(model).toMatch(/MERGE_INSPECT_SCAN_LIMIT\s*=\s*4_096/);
    expect(model).toMatch(/safetySuppressedMergeCount/);
  });

  it('keeps the grid in stable spreadsheet orientation, and cell text direction automatic', () => {
    const grid = code(`${DIR}/ExcelSheetGrid.tsx`);
    expect(grid).toMatch(/className="cn2b-xl-grid"\s+dir="ltr"/);
    expect(grid).toMatch(/className="cn2b-xl-cell__text" dir="auto"/);
    // The viewer chrome inherits the page direction instead of hard-coding one.
    expect(code(`${DIR}/ExcelWorkbookViewer.tsx`)).not.toMatch(/\bdir=/);
  });
});

describe('E1 viewer — integration and dictionary', () => {
  it('Simple Mode mounts it from the existing preview result, inside the ready state, with no new state or props', () => {
    const workspace = code('src/features/central-needs/simple/CentralNeedsSimpleWorkspace.tsx');
    expect(workspace).toMatch(/import \{ ExcelWorkbookViewer \} from '\.\.\/excel-first\/ExcelWorkbookViewer';/);
    expect(workspace).toMatch(
      /preview\.phase === 'ready' && \(\s*<ExcelWorkbookViewer lang=\{lang\} kind=\{preview\.outcome\.kind\} result=\{preview\.outcome\.result\} \/>/,
    );
    expect(workspace).not.toMatch(/\.parse\(/);
    expect(workspace.match(/<ExcelWorkbookViewer\b/g)).toHaveLength(1);
  });

  it('Advanced Mode is untouched by E1', () => {
    expect(code('src/features/central-needs/CentralNeedsScreen.tsx')).not.toMatch(/ExcelWorkbookViewer|excel-first/);
  });

  it('every label the viewer uses exists in Arabic and English', () => {
    const strings = read('src/shared/i18n/strings.ts');
    const keys = new Set<string>();
    for (const file of viewerFiles) {
      for (const m of read(file).matchAll(/'(cn2b_[a-z0-9_]+)'/g)) keys.add(m[1]);
    }
    for (const type of ['number', 'string', 'boolean', 'date', 'error']) keys.add(`cn2b_xl_type_${type}`);
    expect(keys.size).toBeGreaterThan(30);
    for (const key of keys) {
      const line = strings.match(new RegExp(`^\\s{2}${key}:\\s*\\{[^}]*\\}`, 'm'));
      expect(line, key).not.toBeNull();
      expect((line as RegExpMatchArray)[0], key).toMatch(/ar:\s*'[^']+'/);
      expect((line as RegExpMatchArray)[0], key).toMatch(/en:\s*'[^']+'/);
    }
  });

  it('ordinary labels carry no parser vocabulary', () => {
    const strings = read('src/shared/i18n/strings.ts');
    const xl = strings.match(/^\s{2}cn2b_xl_[a-z0-9_]+:\s*\{[^}]*\}/gm) ?? [];
    expect(xl.length).toBeGreaterThan(30);
    for (const line of xl) {
      // The visible text only — the key names are code, not copy.
      const visible = [...line.matchAll(/(?:ar|en):\s*'([^']*)'/g)].map((m) => m[1]).join(' | ');
      expect(visible.length, line).toBeGreaterThan(0);
      expect(visible).not.toMatch(/Evidence|parser|SourceRecord|rawValue|presence|SheetJS/i);
    }
  });
});

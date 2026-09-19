/**
 * E2-A.7 — static security and scope guards for the Selection Foundation.
 *
 * Source is read with comments stripped, so prose can neither satisfy nor hide
 * a violation. Pinned here:
 *   - NO WRITE SURFACE: no table write, RPC, Storage mutation, network write
 *     verb or browser persistence anywhere E2-A touched; the one new data call
 *     is `listBatchEntries`, a SELECT;
 *   - PURE CONTRACT AND BRIDGE: no React, no service, no network;
 *   - AUTHORITY: the bridge matches on ordinal + SHA-256 + archive path only —
 *     never a file name, sheet name, title, cell or header text, family;
 *   - PHYSICAL != SEMANTIC: no business vocabulary, no role on a selection,
 *     no E2-B surface, and the provisional upload preview is never selectable.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const XL = 'src/features/central-needs/excel-first';
const CONTRACT = `${XL}/workbookSelection.ts`;
const BRIDGE = `${XL}/sourceIdentityBridge.ts`;
const GRID = `${XL}/ExcelSheetGrid.tsx`;
const VIEWER = `${XL}/ExcelWorkbookViewer.tsx`;
const PANEL = 'src/features/central-needs/simple/StoredWorkbookPanel.tsx';
const WORKSPACE = 'src/features/central-needs/simple/CentralNeedsSimpleWorkspace.tsx';
const E2A_FILES = [CONTRACT, BRIDGE, GRID, VIEWER, PANEL];

describe('E2-A.7 — no write surface anywhere E2-A touched', () => {
  it('no table write, RPC, Storage mutation or network write verb', () => {
    for (const file of E2A_FILES) {
      const src = code(file);
      expect(src, file).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
      expect(src, file).not.toMatch(/\.rpc\s*\(/);
      expect(src, file).not.toMatch(/\.storage\b/);
      expect(src, file).not.toMatch(/\.(upload|uploadToSignedUrl|createSignedUploadUrl|remove|move|copy)\s*\(/);
      expect(src, file).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
      expect(src, file).not.toMatch(/\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b|\bEventSource\b/);
      expect(src, file).not.toMatch(/\bsupabase\b|@\/shared\/supabase/);
    }
  });

  it('no browser persistence of any kind', () => {
    for (const file of E2A_FILES) {
      const src = code(file);
      expect(src, file).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\b/);
      expect(src, file).not.toMatch(/document\.cookie|\bcaches\s*\.|\bserviceWorker\b|\bcreateObjectURL\b|\bBroadcastChannel\b/);
    }
  });

  it('the only new data call is listBatchEntries — a SELECT of one batch\'s own entries', () => {
    const panel = code(PANEL);
    expect([...panel.matchAll(/\blistBatchEntries\s*\(/g)]).toHaveLength(1);
    expect(panel).toMatch(/listBatchEntries\(batch\.id\)/);
    expect([...panel.matchAll(/\brequestSourceDownload\s*\(/g)]).toHaveLength(1);
    expect([...panel.matchAll(/\bfetch\s*\(/g)]).toHaveLength(1);
    const service = code('src/features/central-needs/central-needs.service.ts');
    const body = service.match(/export async function listBatchEntries\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(body).toMatch(/\.from\('central_needs_import_batch_entries'\)\s*\.select\(/);
    expect(body).not.toMatch(/\.(insert|update|upsert|delete|rpc)\s*\(|\.storage\b/);
    // The grid, viewer, contract and bridge call no service at all.
    for (const file of [CONTRACT, BRIDGE, GRID, VIEWER]) expect(code(file), file).not.toMatch(/central-needs\.service/);
  });
});

describe('E2-A.1/2 — the contract and the bridge are pure', () => {
  it('import only types from the parser contract and helpers from the viewer model / each other', () => {
    const allowed = new Set(['./excelViewerModel', './workbookSelection', '../import/contract.ts']);
    for (const file of [CONTRACT, BRIDGE]) {
      const src = code(file);
      const specifiers = [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of specifiers) expect(allowed.has(spec), `${file} imports ${spec}`).toBe(true);
      expect(src, file).not.toMatch(/from 'react'|\buse[A-Z]\w*\(/);
      expect(src, file).not.toMatch(/\bfetch\s*\(|\bnew\s+Worker\b|\bparseWorkbookBytes\b|\bparseArchiveBytes\b/);
    }
  });
});

describe('E2-A.2 — the bridge\'s authority is ordinal + SHA-256 + archive path, nothing else', () => {
  it('uses the three authoritative facts', () => {
    const bridge = code(BRIDGE);
    expect(bridge).toMatch(/entryOrdinal/);
    expect(bridge).toMatch(/entrySha256/);
    expect(bridge).toMatch(/archiveEntryPath/);
    expect(bridge).toMatch(/containerSha256/);
  });

  it('never reads a file name, sheet name, title, cell or header content, family or source records', () => {
    const bridge = code(BRIDGE);
    for (const forbidden of [
      /originalFilename/, /containerFilename/, /\.name\b/, /\bsheets\b/, /\bcells\b/, /formattedText/, /rawValue/,
      /headerText|columnHeaderEvidence|duplicateHeaderGroups/, /\bfamily\b/, /sourceRecords/, /basename|split\('\/'\)/,
      /\bincludes\(|\bstartsWith\(|\bendsWith\(|localeCompare|toLowerCase\(\)\s*\.includes/,
    ]) expect(bridge, String(forbidden)).not.toMatch(forbidden);
  });

  it('has no fallback: every failure returns ok:false, and identities exist only on success', () => {
    const bridge = code(BRIDGE);
    expect(bridge).toMatch(/return \{ ok: true, identities \};/);
    expect([...bridge.matchAll(/ok: true/g)]).toHaveLength(2); // the type and the single success return
  });
});

describe('PHYSICAL SELECTION != BUSINESS SEMANTICS', () => {
  const SEMANTIC = /national[_ ]?code|nationalCode|\bmaterial|institution|beneficiar|need[_ ]?line|needLine|annual[_ ]?need|quantity|\bunit\b/i;

  it('no business vocabulary in any E2-A contract, bridge, grid or viewer code', () => {
    for (const file of [CONTRACT, BRIDGE, GRID, VIEWER]) expect(code(file), file).not.toMatch(SEMANTIC);
  });

  it('a selection has no role, meaning or classification field — only kind, source and geometry', () => {
    const contract = code(CONTRACT);
    expect(contract).not.toMatch(/\b(role|semantic|meaning|purpose|classification|mapping|decision)\s*[?]?:/);
    expect(contract).toMatch(/kind: 'cell'/);
    expect(contract).toMatch(/kind: 'column'/);
    expect(contract).toMatch(/kind: 'range'/);
    expect(contract).toMatch(/export type WorkbookSelection = CellSelection \| ColumnSelection \| RangeSelection;/);
  });

  it('E2-A adds exactly one label — "select column", a coordinate — and no E2-B surface', () => {
    const strings = read('src/shared/i18n/strings.ts');
    const selectKeys = [...strings.matchAll(/^\s{2}(cn2b_xl_select_[a-z0-9_]+):/gm)].map((m) => m[1]);
    expect(selectKeys).toEqual(['cn2b_xl_select_column']);
    const line = strings.match(/^\s{2}cn2b_xl_select_column:.*$/m)?.[0] ?? '';
    expect(line).toMatch(/'تحديد العمود __COL__'/);
    expect(line).toMatch(/'Select column __COL__'/);
    for (const file of E2A_FILES) {
      expect(code(file), file).not.toMatch(/Select (National Code|Material|Institution|Need)|select_(national|material|institution|need)/i);
    }
  });

  it('the provisional upload preview is mounted without selection; only the stored source viewer gets it', () => {
    const workspace = code(WORKSPACE);
    expect(workspace).toMatch(/<ExcelWorkbookViewer lang=\{lang\} kind=\{preview\.outcome\.kind\} result=\{preview\.outcome\.result\} \/>/);
    expect(workspace).not.toMatch(/selection=\{/);
    expect(workspace).not.toMatch(/onSelectionChange/);
    const panel = code(PANEL);
    expect(panel).toMatch(/selection=\{viewerSelection\}/);
    expect(panel).toMatch(/identities \? \{ identities, onChange: forwardSelection \} : undefined/);
  });

  it('the grid offers selection gestures only when the caller opts in', () => {
    const grid = code(GRID);
    expect(grid).toMatch(/selectable = false/);
    expect(grid).toMatch(/if \(selectable && onSelectColumn && event\.ctrlKey/);
    expect(grid).toMatch(/if \(selectable && onExtend && event\.shiftKey && event\.key in NAV_KEYS\)/);
    expect(grid).toMatch(/\{selectable \? \(/);
  });
});

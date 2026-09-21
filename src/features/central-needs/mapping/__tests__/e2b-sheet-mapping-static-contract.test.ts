/**
 * E2-B.13 — static security and scope guards for the Sheet Mapping Profile.
 *
 * Source is read with comments stripped, so prose can neither satisfy nor hide
 * a violation. Pinned here:
 *   - NO WRITE SURFACE: E2-B references no service function at all (read or
 *     write — the list is taken from the service file itself), no Supabase,
 *     no network, no RPC;
 *   - MEMORY ONLY: no browser storage, cookie, cache or URL persistence;
 *   - NO NEW PARSER: no parser, worker, preview hook or spreadsheet library;
 *   - NO INFERENCE: E2-B receives no cell evidence, never pattern-matches text,
 *     and a role is assigned only by the human's button;
 *   - SCOPE: exactly two roles; no E2-C vocabulary; E2-A files untouched by E2-B.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const XL = 'src/features/central-needs/excel-first';
const MAP = 'src/features/central-needs/mapping';
const DOMAIN = `${MAP}/sheetMappingProfile.ts`;
const HOOK = `${MAP}/useSheetMappingProfile.ts`;
const PANEL = `${MAP}/SheetMappingProfilePanel.tsx`;
const WRAPPER = 'src/features/central-needs/simple/StoredWorkbookMapping.tsx';
const WORKSPACE = 'src/features/central-needs/simple/CentralNeedsSimpleWorkspace.tsx';
const E2B_FILES = [DOMAIN, HOOK, PANEL, WRAPPER];
const E2A_FILES = [
  `${XL}/workbookSelection.ts`,
  `${XL}/sourceIdentityBridge.ts`,
  `${XL}/ExcelSheetGrid.tsx`,
  `${XL}/ExcelWorkbookViewer.tsx`,
  'src/features/central-needs/simple/StoredWorkbookPanel.tsx',
];

const importsOf = (src: string) => [...src.matchAll(/^\s*import\s[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]);

describe('E2-B.13 — no write surface', () => {
  it('references no Central Needs service function — neither a writer nor a reader', () => {
    const service = code('src/features/central-needs/central-needs.service.ts');
    const exported = [...service.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
    for (const writer of ['setNeedLine', 'deleteNeedLine', 'setBeneficiaryColumns', 'setRecordDisposition', 'recordFieldOverride', 'finalizeImport']) {
      expect(exported).toContain(writer);
    }
    for (const file of E2B_FILES) {
      const src = code(file);
      expect(importsOf(src).some((p) => /central-needs\.service/.test(p)), file).toBe(false);
      for (const name of exported) expect(src, `${file} → ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('no Supabase, RPC, Storage mutation, network call or write verb', () => {
    for (const file of E2B_FILES) {
      const src = code(file);
      expect(src, file).not.toMatch(/\bsupabase\b|@\/shared\/supabase/);
      expect(src, file).not.toMatch(/\.rpc\s*\(|phoenix_central_needs_/);
      expect(src, file).not.toMatch(/\.(insert|update|upsert)\s*\(/);
      expect(src, file).not.toMatch(/\.storage\b/);
      expect(src, file).not.toMatch(/\bfetch\s*\(|authorizedFetch|method:\s*'(POST|PUT|PATCH|DELETE)'/);
      expect(src, file).not.toMatch(/\bXMLHttpRequest\b|\bsendBeacon\b|\bWebSocket\b|\bEventSource\b/);
    }
  });
});

describe('E2-B.14 — memory only', () => {
  it('no browser storage, cookie, cache, service worker or URL persistence', () => {
    for (const file of E2B_FILES) {
      const src = code(file);
      expect(src, file).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\b/);
      expect(src, file).not.toMatch(/document\.cookie|\bcaches\s*\.|\bserviceWorker\b|\bcreateObjectURL\b|\bBroadcastChannel\b/);
      expect(src, file).not.toMatch(/\bhistory\s*\.\s*(pushState|replaceState)|\blocation\s*\.\s*(hash|search|href|assign|replace)|URLSearchParams/);
    }
  });

  it('the draft is React memory under the revision key, fed only by the E2-A bridge', () => {
    const hook = code(HOOK);
    expect(hook).toMatch(/useReducer\(sheetMappingReducer, INITIAL_SHEET_MAPPING_STATE\)/);
    const wrapper = code(WRAPPER);
    expect(wrapper).toMatch(/onSelectionChange=\{mapping\.observeSelection\}/);
    const workspace = code(WORKSPACE);
    expect(workspace).toMatch(/<StoredWorkbookMapping key=\{revision\.id\}/);
    // The workspace itself still wires no selection (E2-A.6): only the stored source is selectable.
    expect(workspace).not.toMatch(/onSelectionChange|observeSelection/);
  });
});

describe('E2-B.15 — no new parser, no inference', () => {
  it('imports no parser, worker, preview hook or spreadsheet library', () => {
    for (const file of E2B_FILES) {
      const imports = importsOf(code(file));
      for (const path of imports) {
        expect(path, file).not.toMatch(/\/import\/|parser|worker|useCentralNeedsPreview|^xlsx$|exceljs|sheetjs/i);
      }
      expect(code(file), file).not.toMatch(/new\s+Worker\s*\(/);
    }
  });

  it('E2-B receives no cell evidence and never pattern-matches text', () => {
    for (const file of E2B_FILES) {
      const src = code(file);
      expect(src, file).not.toMatch(/\b(cells|rawValue|formattedText|cellDisplayText|rawValueText|SheetEvidence|buildSheetGridModel|mergeAt|workbook\.sheets)\b/);
      expect(src, file).not.toMatch(/new RegExp|\.test\(|\.match\(|\.search\(|\.includes\(\s*['"]|toLowerCase|toUpperCase|localeCompare/);
      expect(src, file).not.toMatch(/sheetName\s*\.\s*[a-zA-Z]+\s*\(/);
    }
    // The only helper E2-B takes from the viewer model is the column-letter label.
    const panelImports = code(PANEL).match(/import \{([^}]*)\} from '\.\.\/excel-first\/excelViewerModel'/);
    expect(panelImports?.[1].trim()).toBe('columnLetters');
  });

  it('a role is assigned only by the human pressing that role\'s button', () => {
    const domain = code(DOMAIN);
    expect([...domain.matchAll(/\bassignRole\s*\(/g)]).toHaveLength(2); // its definition + the reducer's 'assign' case
    expect(domain).toMatch(/case 'assign': \{[\s\S]*?assignRole\(state\.profile, action\.role, state\.selection\)/);
    const hook = code(HOOK);
    expect([...hook.matchAll(/type: 'assign'/g)]).toHaveLength(1);
    expect(hook).toMatch(/const assign = useCallback\(\(role: MappingRole\) => dispatch\(\{ type: 'assign', role \}\), \[\]\)/);
    const panel = code(PANEL);
    expect([...panel.matchAll(/\bonAssign\s*\(/g)]).toHaveLength(1);
    expect(panel).toMatch(/onClick=\{\(\) => onAssign\(role\)\}/);
    // The action carries a role, never a coordinate.
    expect(domain).toMatch(/\| \{ type: 'assign'; role: MappingRole \}/);
  });
});

describe('E2-B.16 — scope', () => {
  it('exactly two roles, and no E2-C vocabulary anywhere in E2-B', () => {
    const domain = code(DOMAIN);
    expect(domain).toMatch(/export type MappingRole = 'national_code' \| 'material';/);
    // E2-C: the wrapper now composes both panels (see e2c-institution-mapping-static-contract);
    // E2-B's own domain, hook and panel still name no E2-C concept.
    for (const file of [DOMAIN, HOOK, PANEL]) {
      expect(code(file), file).not.toMatch(/institution|beneficiar|need_?line|needColumn|care_?facility|\bM213\b|anchor/i);
    }
  });

  it('the domain is pure: no React, no service, only the E2-A contract', () => {
    expect(importsOf(code(DOMAIN))).toEqual(['../excel-first/workbookSelection']);
  });

  it('E2-B lives in its own folder: the E1 viewer folder stays a generic physical evidence surface', () => {
    const viewerFolder = readdirSync(join(ROOT, XL));
    expect(viewerFolder.filter((f) => /mapping|Mapping/.test(f))).toEqual([]);
    for (const file of [DOMAIN, HOOK, PANEL]) expect(file.startsWith(`${MAP}/`)).toBe(true);
    // One-way dependency: E2-B reads the E2-A contract; nothing in excel-first/ imports mapping/.
    for (const f of viewerFolder.filter((n) => /\.(ts|tsx)$/.test(n))) {
      expect(importsOf(code(`${XL}/${f}`)).some((p) => /mapping/.test(p)), f).toBe(false);
    }
  });

  it('E2-A files do not know E2-B exists', () => {
    for (const file of E2A_FILES) {
      expect(code(file), file).not.toMatch(/sheetMappingProfile|SheetMappingProfile|MappingRole|national_code|nationalCode|materialColumn/);
    }
  });

  it('bilingual copy for every E2-B key, none naming an E2-C concept', () => {
    const strings = read('src/shared/i18n/strings.ts');
    const lines = [...strings.matchAll(/^\s{2}(cn2b_map_[a-z0-9_]+):\s*(\{[^\n]*\}),?$/gm)];
    expect(lines.length).toBeGreaterThanOrEqual(20);
    for (const [, key, body] of lines) {
      expect(body, key).toMatch(/ar:\s*'[^']+'/);
      expect(body, key).toMatch(/en:\s*'(?:[^'\\]|\\.)+'/);
      expect(key).not.toMatch(/institution|beneficiar|need/);
    }
    const panel = code(PANEL);
    for (const [key] of panel.matchAll(/'cn2b_map_[a-z0-9_]+'/g)) {
      expect(strings, key).toContain(`  ${key.slice(1, -1)}:`);
    }
  });

  it('an auxiliary block of its own — never a Simple task card', () => {
    const panel = code(PANEL);
    expect(panel).toMatch(/className="cn2b-map"/);
    expect(panel).not.toMatch(/cn2b-simple-card/);
    expect(read('src/shared/lib/central-needs.css')).toMatch(/^\.cn2b-map \{/m);
  });
});

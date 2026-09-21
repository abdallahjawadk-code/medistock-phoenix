/**
 * E2-C.17 — static security, identity and scope guards for Multi-Institution
 * Mapping.
 *
 * Source is read with comments stripped, so prose can neither satisfy nor hide
 * a violation. Pinned here:
 *   - NO WRITE SURFACE: no Central Needs service function (the list is taken
 *     from the service file itself), no Supabase, no RPC, no network;
 *   - MEMORY ONLY: no browser storage, cookie, cache or URL persistence;
 *   - NO NEW PARSER and NO CELL EVIDENCE: E2-C never receives workbook content;
 *   - NO INFERENCE: no text matching, no suggestion engine, no name-based
 *     identity; a beneficiary is set only by the human's list choice;
 *   - IDENTITY: the plan owner's organization never reaches E2-C;
 *   - BLANK ≠ ZERO and NATIONAL CODE STAYS TEXT: no numeric coercion, rounding
 *     or zero default anywhere in E2-C;
 *   - SCOPE: E2-B is extended through its exports only; E2-A stays unaware.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const MAP = 'src/features/central-needs/mapping';
const XL = 'src/features/central-needs/excel-first';
const DOMAIN = `${MAP}/institutionMapping.ts`;
const HOOK = `${MAP}/useInstitutionMapping.ts`;
const PANEL = `${MAP}/InstitutionMappingPanel.tsx`;
const WRAPPER = 'src/features/central-needs/simple/StoredWorkbookMapping.tsx';
const WORKSPACE = 'src/features/central-needs/simple/CentralNeedsSimpleWorkspace.tsx';
const E2C_FILES = [DOMAIN, HOOK, PANEL];
const E2B_OWN = [`${MAP}/sheetMappingProfile.ts`, `${MAP}/useSheetMappingProfile.ts`, `${MAP}/SheetMappingProfilePanel.tsx`];
const E2A_FILES = [
  `${XL}/workbookSelection.ts`,
  `${XL}/sourceIdentityBridge.ts`,
  `${XL}/ExcelSheetGrid.tsx`,
  `${XL}/ExcelWorkbookViewer.tsx`,
  'src/features/central-needs/simple/StoredWorkbookPanel.tsx',
];

const importsOf = (src: string) => [...src.matchAll(/^\s*import\s[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]);

const TEXT_MATCHING = /new RegExp|\.test\(|\.match\(|\.search\(|\.includes\(\s*['"`]|toLowerCase|toUpperCase|localeCompare|\.normalize\(|startsWith|endsWith/;
const PLAN_OWNER = /\borganizationId\b|organization_id|activeOrgId|PlanRevision|\brevision\b|planRevisionId/;
const NUMERIC_COERCION = /\bNumber\s*\(|\bparseInt\b|\bparseFloat\b|\bBigInt\s*\(|\.toFixed\(|\.toPrecision\(|\bMath\.(round|floor|ceil|trunc)\b/;
const ZERO_DEFAULT = /\?\?\s*0\b|\|\|\s*0\b|:\s*0\s*\)/;

describe('E2-C.17 — no write surface', () => {
  it('references no Central Needs service function — neither a writer nor a reader', () => {
    const service = code('src/features/central-needs/central-needs.service.ts');
    const exported = [...service.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
    for (const writer of ['setNeedLine', 'deleteNeedLine', 'setBeneficiaryColumns', 'setRecordDisposition', 'recordFieldOverride', 'finalizeImport']) {
      expect(exported).toContain(writer);
    }
    for (const file of [...E2C_FILES, WRAPPER]) {
      const src = code(file);
      expect(importsOf(src).some((p) => /central-needs\.service|organizations\.service/.test(p)), file).toBe(false);
      for (const name of exported) expect(src, `${file} → ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('no Supabase, RPC, Storage mutation, network call or write verb', () => {
    for (const file of [...E2C_FILES, WRAPPER]) {
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

describe('E2-C.18 — memory only', () => {
  it('no browser storage, cookie, cache, service worker or URL persistence', () => {
    for (const file of [...E2C_FILES, WRAPPER]) {
      const src = code(file);
      expect(src, file).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\b/);
      expect(src, file).not.toMatch(/document\.cookie|\bcaches\s*\.|\bserviceWorker\b|\bcreateObjectURL\b|\bBroadcastChannel\b/);
      expect(src, file).not.toMatch(/\bhistory\s*\.\s*(pushState|replaceState)|\blocation\s*\.\s*(hash|search|href|assign|replace)|URLSearchParams/);
    }
  });

  it('the draft is React memory, fed by the ONE E2-A bridge shared with E2-B, under the revision key', () => {
    const hook = code(HOOK);
    expect(hook).toMatch(/useReducer\(institutionMappingReducer, INITIAL_INSTITUTION_MAPPING_STATE\)/);
    // One feed, both drafts, same call — E2-B's own hook is reused unchanged.
    expect(hook).toMatch(/const sheet = useSheetMappingProfile\(\);/);
    expect(hook).toMatch(/observeSheet\(selection\);\s*observeInstitutions\(selection\);/);
    const wrapper = code(WRAPPER);
    expect(wrapper).toMatch(/const mapping = useWorkbookMapping\(\);/);
    expect(wrapper).toMatch(/onSelectionChange=\{mapping\.observeSelection\}/);
    expect([...wrapper.matchAll(/onSelectionChange=/g)]).toHaveLength(1);
    // E2-D adds the revision id (identity only) for the local mapping approval; see e2d-mapping-approval-static-contract.
    expect(code(WORKSPACE)).toMatch(/<StoredWorkbookMapping key=\{revision\.id\} lang=\{lang\} batches=\{batches\} careInstitutions=\{careInstitutions\} planRevisionId=\{revision\.id\} \/>/);
  });

  it('no hidden mutable module state in E2-C', () => {
    for (const file of E2C_FILES) {
      const src = code(file);
      expect(src, file).not.toMatch(/^\s*let\s/m);
      expect(src, file).not.toMatch(/\bnew\s+(WeakMap|Map)\s*\([^)]*\)\s*;\s*$/m);
    }
  });
});

describe('E2-C.19 — no new parser, no cell evidence, no inference', () => {
  it('imports no parser, worker, preview hook or spreadsheet library', () => {
    for (const file of [...E2C_FILES, WRAPPER]) {
      for (const path of importsOf(code(file))) {
        expect(path, file).not.toMatch(/\/import\/|parser|worker|useCentralNeedsPreview|^xlsx$|exceljs|sheetjs/i);
      }
      expect(code(file), file).not.toMatch(/new\s+Worker\s*\(/);
    }
  });

  it('E2-C receives no cell evidence: no cell, header, value or sheet content', () => {
    for (const file of E2C_FILES) {
      const src = code(file);
      expect(src, file).not.toMatch(/\b(cells|rawValue|formattedText|cellDisplayText|rawValueText|SheetEvidence|buildSheetGridModel|mergeAt|workbook\.sheets|sourceFieldName|originalFilename)\b/);
    }
    // From the viewer model E2-C takes coordinate labels only.
    const panelImports = code(PANEL).match(/import \{([^}]*)\} from '\.\.\/excel-first\/excelViewerModel'/);
    expect(panelImports?.[1].split(',').map((s) => s.trim()).sort()).toEqual(['a1Address', 'columnLetters']);
  });

  it('no text matching, no suggestion engine, no fuzzy or name-based identity', () => {
    for (const file of E2C_FILES) {
      const src = code(file);
      expect(src, file).not.toMatch(TEXT_MATCHING);
      expect(src, file).not.toMatch(/exactMatchSuggestion|suggest|fuzzy|similar|levenshtein|guess|infer/i);
      expect(importsOf(src).some((p) => /CentralNeedsBeneficiaryColumnPanel|SimpleInstitutionCard/.test(p)), file).toBe(false);
    }
    // The domain decides by ids and coordinates only; names and codes are display, in the panel.
    for (const file of [DOMAIN, HOOK]) {
      expect(code(file), file).not.toMatch(/\.(name|name_ar|code)\b/);
    }
  });

  it('a beneficiary is set only by the human\'s list choice; capture actions carry no coordinate', () => {
    const domain = code(DOMAIN);
    expect(domain).toMatch(/\| \{ type: 'capture_anchor' \}\r?\n/);
    expect(domain).toMatch(/\| \{ type: 'capture_need' \}\r?\n/);
    expect(domain).toMatch(/\| \{ type: 'choose_beneficiary'; beneficiaryOrganizationId: string \| null \}/);
    // The draft's beneficiary is written from the human's choice in exactly one place (an edit
    // only reloads an existing entry's own id, and the empty draft holds none).
    expect([...domain.matchAll(/beneficiaryOrganizationId: chosen\b/g)]).toHaveLength(1);
    expect(domain).toMatch(/case 'choose_beneficiary': \{[\s\S]*?action\.beneficiaryOrganizationId[\s\S]*?beneficiaryOrganizationId: chosen/);
    const captureCase = domain.match(/case 'capture_anchor':[\s\S]*?(?=case 'choose_beneficiary')/)?.[0] ?? '';
    expect(captureCase).toMatch(/anchorFromSelection\(state\.context, state\.selection\)/);
    expect(captureCase).not.toMatch(/beneficiary/i);
    // The panel's picker offers the trusted rows only, and starts on "choose".
    const panel = code(PANEL);
    expect(panel).toMatch(/\{ value: '', label: t\('cn2b_inst_choose', lang\) \}/);
    expect(panel).toMatch(/\.\.\.beneficiaries\.map\(\(b\) => \(\{ value: b\.id,/);
    expect(panel).toMatch(/value=\{draft\.beneficiaryOrganizationId \?\? ''\}/);
    expect([...panel.matchAll(/controller\.chooseBeneficiary\(/g)]).toHaveLength(1);
  });
});

describe('E2-C.20 — beneficiary identity is never the plan owner', () => {
  it('E2-C has no input for, and no reference to, the plan owner organization', () => {
    for (const file of E2C_FILES) expect(code(file), file).not.toMatch(PLAN_OWNER);
    // E2-D: the wrapper now carries the revision id for the LOCAL mapping approval — never any plan-owner
    // organization — and hands it to E2-D only, never to an E2-C panel or hook.
    const wrapper = code(WRAPPER);
    expect(wrapper).not.toMatch(/\borganizationId\b|organization_id|activeOrgId|\bPlanRevision\b/);
    expect(wrapper).not.toMatch(/<InstitutionMappingPanel[^>]*planRevisionId|useWorkbookMapping\([^)]*planRevisionId/);
  });

  it('the workspace hands E2-C its care institutions — the list the institution card already uses — and nothing else', () => {
    const workspace = code(WORKSPACE);
    const mount = workspace.match(/<StoredWorkbookMapping[^>]*\/>/)?.[0] ?? '';
    expect(mount).toMatch(/careInstitutions=\{careInstitutions\}/);
    expect(mount).not.toMatch(/organizationId|revision\.(?!id)/);
    expect(workspace).toMatch(/activeCareInstitutions=\{careInstitutions\}/);
    const screenSrc = code('src/features/central-needs/CentralNeedsScreen.tsx');
    expect(screenSrc).toMatch(/setCareInstitutions\(rows\.filter\(\(o\) => o\.organizationKind === 'care_institution' && o\.status === 'active'\)\)/);
  });
});

describe('E2-C.21 — blank is not zero; the National Code stays a column identity', () => {
  it('no numeric coercion, rounding or zero default anywhere in E2-C', () => {
    for (const file of E2C_FILES) {
      const src = code(file);
      expect(src, file).not.toMatch(NUMERIC_COERCION);
      expect(src, file).not.toMatch(ZERO_DEFAULT);
      expect(src, file).not.toMatch(/quantit(y|ies)\s*[:=]|\bamount\b|\bneedValue\b/i);
    }
  });

  it('the guards are precise: each catches the violation it names and allows what E2-C legitimately does', () => {
    for (const bad of ['Number(cell.rawValue)', 'parseFloat(text)', 'Math.round(q)', 'q.toFixed(2)', "BigInt('12')"]) {
      expect(bad).toMatch(NUMERIC_COERCION);
    }
    for (const bad of ['value ?? 0', 'value || 0', "blank ? '' : 0)"]) expect(bad).toMatch(ZERO_DEFAULT);
    for (const bad of ['revision.organizationId', 'profile.organization_id', 'activeOrgId', 'planRevisionId']) expect(bad).toMatch(PLAN_OWNER);
    for (const bad of ["label.includes('مستشفى')", 'name.toLowerCase()', 'a.localeCompare(b)', '/x/.test(label)']) expect(bad).toMatch(TEXT_MATCHING);
    // What E2-C does use: integer checks, an infinite row bound, zero-based coordinates, id membership.
    for (const good of ['Number.isInteger(i)', 'Number.POSITIVE_INFINITY', 'startRow: 0,', 'ids.includes(candidate.beneficiaryOrganizationId)']) {
      expect(good).not.toMatch(NUMERIC_COERCION);
      expect(good).not.toMatch(ZERO_DEFAULT);
      expect(good).not.toMatch(TEXT_MATCHING);
    }
    expect('beneficiaryOrganizationId').not.toMatch(PLAN_OWNER);
  });

  it('the National Code role is read only as E2-B\'s column index', () => {
    const domain = code(DOMAIN);
    expect([...domain.matchAll(/roleColumn\(profile, 'national_code'\)/g)]).toHaveLength(1);
    for (const file of E2C_FILES) {
      expect(code(file), file).not.toMatch(/nationalCodeColumn|materialColumn|nationalCode\s*[:=]/);
    }
  });
});

describe('E2-C.23 — review corrections stay corrected (E2C-SEM-001 / E2C-SEM-002)', () => {
  it('SEM-001: no one-entry-per-beneficiary rule exists; beneficiary equality never refuses an entry on its own', () => {
    for (const file of [...E2C_FILES, 'src/shared/i18n/strings.ts']) {
      expect(read(file), file).not.toMatch(/BENEFICIARY_ALREADY_MAPPED|cn2b_inst_why_beneficiary_twice/);
    }
    const domain = code(DOMAIN);
    // The only equality on beneficiaries is inside the exact-duplicate test, together with anchor AND need.
    expect(domain).toMatch(/const sameDeclaration = \(a: InstitutionMapping, b: InstitutionMapping\): boolean =>\s*a\.beneficiaryOrganizationId === b\.beneficiaryOrganizationId && sameShape\(a\.anchor, b\.anchor\) && sameShape\(a\.need, b\.need\);/);
    expect(domain).not.toMatch(/o\.beneficiaryOrganizationId === candidate\.beneficiaryOrganizationId/);
    // A shared name cell is refused only between DIFFERENT beneficiaries.
    expect(domain).toMatch(/\['ANCHOR_OVERLAP', \(o\) => o\.beneficiaryOrganizationId !== candidate\.beneficiaryOrganizationId && /);
  });

  it('SEM-002: a Need range keeps all four E2-A coordinates and is never narrowed to one column', () => {
    for (const file of [...E2C_FILES, 'src/shared/i18n/strings.ts']) {
      expect(read(file), file).not.toMatch(/NEED_RANGE_MULTI_COLUMN|cn2b_inst_why_need_multi/);
    }
    const domain = code(DOMAIN);
    expect(domain).toMatch(/export type NeedSource =\s*\| \{ kind: 'column'; columnIndex: number \}\s*\| \{ kind: 'range'; startRow: number; endRow: number; startColumn: number; endColumn: number \};/);
    expect(domain).toMatch(/startColumn: trusted\.startColumn,\s*endColumn: trusted\.endColumn,/);
    // Collisions with E2-B's roles test the whole rectangle, not one column.
    expect(domain).toMatch(/coversColumn\(candidate\.need, roleColumn\(profile, 'national_code'\)\)/);
    expect(domain).toMatch(/coversColumn\(candidate\.need, roleColumn\(profile, 'material'\)\)/);
    expect(code(PANEL)).toMatch(/rangeRef\(need\.startRow, need\.startColumn, need\.endRow, need\.endColumn\)/);
  });
});

describe('E2-C.22 — scope', () => {
  it('the domain is pure: no React, only the E2-A contract and E2-B\'s exported rules', () => {
    expect(importsOf(code(DOMAIN))).toEqual(['../excel-first/workbookSelection', './sheetMappingProfile']);
    expect(code(DOMAIN)).not.toMatch(/from 'react'|\buse[A-Z]\w*\(/);
    // Trusted input is E2-B's, not a second copy of the rule.
    expect(code(DOMAIN)).toMatch(/canonicalSelection\(action\.selection\)/);
    expect(code(`${MAP}/sheetMappingProfile.ts`)).toMatch(/^export function canonicalSelection\(input: unknown\)/m);
  });

  it('E2-B\'s own files and E2-A\'s files do not know E2-C exists', () => {
    for (const file of [...E2B_OWN, ...E2A_FILES]) {
      expect(code(file), file).not.toMatch(/institutionMapping|InstitutionMapping|useWorkbookMapping|cn2b-instmap|cn2b_inst_/);
    }
    for (const file of E2A_FILES) expect(importsOf(code(file)).some((p) => /mapping/.test(p)), file).toBe(false);
  });

  it('bilingual copy for every E2-C key, and every key the panel uses exists', () => {
    const strings = read('src/shared/i18n/strings.ts');
    const lines = [...strings.matchAll(/^\s{2}(cn2b_inst_[a-z0-9_]+):\s*(\{[^\n]*\}),?\r?$/gm)];
    expect(lines.length).toBeGreaterThanOrEqual(60);
    for (const [, key, body] of lines) {
      expect(body, key).toMatch(/ar:\s*'[^']+'/);
      expect(body, key).toMatch(/en:\s*'(?:[^'\\]|\\.)+'/);
    }
    for (const [key] of code(PANEL).matchAll(/'cn2b_(?:inst|map|xl)_[a-z0-9_]+'/g)) {
      expect(strings, key).toMatch(new RegExp(`^  ${key.slice(1, -1)}:`, 'm'));
    }
  });

  it('an auxiliary block of its own — never a Simple task card — written in logical CSS properties', () => {
    const panel = code(PANEL);
    expect(panel).toMatch(/className="cn2b-instmap"/);
    expect(panel).not.toMatch(/cn2b-simple-card/);
    const css = read('src/shared/lib/central-needs.css');
    const block = css.slice(css.indexOf('.cn2b-instmap {'), css.indexOf('/* ── The quiet Advanced entry'));
    expect(block.length).toBeGreaterThan(100);
    expect(block).not.toMatch(/(^|[\s;{])(margin-left|margin-right|padding-left|padding-right|left|right|text-align)\s*:/m);
  });

  it('the IG-2 acceptance test is not part of E2-C', () => {
    for (const file of [...E2C_FILES, WRAPPER]) expect(code(file), file).not.toMatch(/interactive-guide|data-guide/);
  });
});

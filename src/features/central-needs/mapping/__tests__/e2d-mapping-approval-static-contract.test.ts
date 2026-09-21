/**
 * E2-D.10 — static security and scope guards for the Mapping Approval Gate.
 *
 * Source is read with comments stripped. Pinned here:
 *   - NO WRITE / NO NETWORK / MEMORY ONLY: no Supabase, RPC, fetch, write verb,
 *     browser storage, cookie, cache or URL state; no service import at all;
 *   - NOT SERVER APPROVAL: no plan submit/approve/reject, no review readiness,
 *     no revision status read or write;
 *   - REAL SHA-256 ONLY: Web Crypto digest, no crypto library, no weak fallback,
 *     no time or randomness in the evidence;
 *   - IDENTITY: no plan-owner organization anywhere in E2-D; the wrapper hands
 *     the revision id to E2-D only;
 *   - ONE TRUTH: validation delegates to E2-B/E2-C functions;
 *   - WORDING: never a bare "approved"; the Owner's exact mapping-local phrases.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const importsOf = (src: string) => [...src.matchAll(/^\s*import\s[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]);

const MAP = 'src/features/central-needs/mapping';
const DOMAIN = `${MAP}/mappingApprovalGate.ts`;
const HOOK = `${MAP}/useMappingApprovalGate.ts`;
const PANEL = `${MAP}/MappingApprovalGatePanel.tsx`;
const WRAPPER = 'src/features/central-needs/simple/StoredWorkbookMapping.tsx';
const WORKSPACE = 'src/features/central-needs/simple/CentralNeedsSimpleWorkspace.tsx';
const E2D_FILES = [DOMAIN, HOOK, PANEL];
const EARLIER_STAGES = [
  `${MAP}/sheetMappingProfile.ts`, `${MAP}/useSheetMappingProfile.ts`, `${MAP}/SheetMappingProfilePanel.tsx`,
  `${MAP}/institutionMapping.ts`, `${MAP}/useInstitutionMapping.ts`, `${MAP}/InstitutionMappingPanel.tsx`,
  'src/features/central-needs/excel-first/workbookSelection.ts', 'src/features/central-needs/simple/StoredWorkbookPanel.tsx',
];

const NETWORK_OR_STORAGE = /\bsupabase\b|@\/shared\/supabase|\.rpc\s*\(|\bfetch\s*\(|authorizedFetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\b(localStorage|sessionStorage|indexedDB)\b|document\.cookie|\bcaches\s*\.|serviceWorker|BroadcastChannel|createObjectURL|history\s*\.\s*(pushState|replaceState)|URLSearchParams|\.(insert|update|upsert)\s*\(/;
const SERVER_APPROVAL = /submitRevision|approveRevision|rejectRevision|fetchReviewReadiness|openPlanRevision|ReviewReadiness|RevisionStatus|revision\.status|\.status\s*=[^=]|'submitted'|'rejected'|setNeedLine|setBeneficiaryColumns|setRecordDisposition|finalizeImport/;
const WEAK_OR_TIME = /Math\.random|Date\.now|new Date\b|performance\.now|crypto-js|js-sha256|node:crypto|from 'crypto'|randomUUID|getRandomValues/;
const PLAN_OWNER = /\borganizationId\b|organization_id|activeOrgId|\bPlanRevision\b/;

describe('E2-D.10 — no write, no network, memory only', () => {
  it('E2-D product files touch no Supabase, RPC, network, storage, URL state or write verb', () => {
    for (const file of E2D_FILES) expect(code(file), file).not.toMatch(NETWORK_OR_STORAGE);
  });

  it('contains no literal U+0000 byte in any E2-D file (git would treat it as binary)', () => {
    for (const file of [...E2D_FILES, WRAPPER, 'src/features/central-needs/mapping/__tests__/e2d-mapping-approval-static-contract.test.ts']) {
      expect(readFileSync(join(ROOT, file)).includes(0), file).toBe(false);
    }
  });

  it('E2-D imports no service at all — only E2-B/E2-C contracts, React and shared UI', () => {
    for (const file of E2D_FILES) {
      for (const path of importsOf(code(file))) {
        expect(path, file).toMatch(/^(react|@\/shared\/i18n\/strings|@\/shared\/ui\/Phoenix(Button|Icon)|\.\/(institutionMapping|sheetMappingProfile|mappingApprovalGate|useMappingApprovalGate))$/);
      }
    }
    expect(importsOf(code(DOMAIN))).toEqual(['./institutionMapping', './sheetMappingProfile']);
  });
});

describe('E2-D.11 — this is NOT the server plan approval', () => {
  it('no plan submit/approve/reject, no review readiness, no revision status in E2-D', () => {
    for (const file of E2D_FILES) expect(code(file), file).not.toMatch(SERVER_APPROVAL);
  });

  it('the wrapper reads the revision id only, passes it to E2-D only, and never a plan-owner organization', () => {
    const wrapper = code(WRAPPER);
    expect(wrapper).not.toMatch(SERVER_APPROVAL);
    expect(wrapper).not.toMatch(PLAN_OWNER);
    expect([...wrapper.matchAll(/\bplanRevisionId\b/g)].length).toBeGreaterThan(0);
    expect(wrapper).toMatch(/useMappingApprovalGate\(\{\s*planRevisionId,/);
    expect(wrapper).not.toMatch(/<(InstitutionMappingPanel|SheetMappingProfilePanel|StoredWorkbookPanel)[^>]*planRevisionId/);
    expect(code(WORKSPACE)).toMatch(/planRevisionId=\{revision\.id\}/);
    for (const file of E2D_FILES) expect(code(file), file).not.toMatch(PLAN_OWNER);
  });
});

describe('E2-D.12 — a real SHA-256 over deterministic evidence', () => {
  it('the fingerprint is Web Crypto SHA-256 — once, with no library and no fallback', () => {
    const domain = code(DOMAIN);
    expect([...domain.matchAll(/\.digest\(/g)]).toHaveLength(1);
    expect(domain).toMatch(/const subtle = globalThis\.crypto\?\.subtle;/);
    expect(domain).toMatch(/subtle\.digest\('SHA-256', new TextEncoder\(\)\.encode\(canonicalJson\)\)/);
    expect(domain).toMatch(/throw new Error\('fingerprint_unavailable'\)/);
    for (const file of E2D_FILES) expect(code(file), file).not.toMatch(WEAK_OR_TIME);
  });

  it('the evidence builder reads no selection, outcome, UI text or display name', () => {
    const builder = code(DOMAIN).match(/export function buildMappingApprovalEvidence[\s\S]*?\n\}/)?.[0] ?? '';
    expect(builder.length).toBeGreaterThan(200);
    expect(builder).not.toMatch(/selection|outcome|outcomeSeq|\blang\b|\bname_ar\b|\.name\b|\.code\b|\bt\(/);
    expect(code(DOMAIN)).toMatch(/Object\.keys\(record\)[\s\S]*?\.sort\(\)/);
  });

  it('approval requires ready + a valid fingerprint + an exact match, and is never persisted', () => {
    const domain = code(DOMAIN);
    expect(domain).toMatch(/return validation\.ready\s*&& isSha256Hex\(currentFingerprint\)\s*&& approval\.approvedFingerprint !== null\s*&& approval\.approvedFingerprint === currentFingerprint;/);
    const hook = code(HOOK);
    expect(hook).toMatch(/useReducer\(localApprovalReducer, INITIAL_LOCAL_APPROVAL\)/);
    expect(hook).toMatch(/if \(approval\.approvedFingerprint !== null && !approved\) dispatch\(\{ type: 'revoke' \}\);/);
    expect([...hook.matchAll(/type: 'approve'/g)]).toHaveLength(1);
    const panel = code(PANEL);
    expect([...panel.matchAll(/approval\.approve\b/g)]).toHaveLength(1);
    expect(panel).toMatch(/onClick=\{approval\.approve\}/);
  });
});

describe('E2-D.13 — one truth: validation delegates to E2-B and E2-C', () => {
  it('uses E2-B/E2-C functions and re-implements no geometry', () => {
    const domain = code(DOMAIN);
    for (const fn of ['isValidProfile', 'sameProfileIdentity', 'isValidContext', 'isValidInstitutionMapping', 'evaluateInstitutionMappings']) {
      expect(domain, fn).toMatch(new RegExp(`\\b${fn}\\(`));
    }
    expect(domain).not.toMatch(/overlaps|anchorArea|needArea|startRow\s*<=|startColumn\s*<=|coversColumn/);
  });

  it('E2-A/E2-B/E2-C files do not know E2-D exists', () => {
    for (const file of EARLIER_STAGES) {
      expect(code(file), file).not.toMatch(/mappingApprovalGate|MappingApproval|useMappingApprovalGate|cn2b_approve_|cn2b-approve/);
    }
  });
});

describe('E2-D.14 — wording and layout', () => {
  const strings = read('src/shared/i18n/strings.ts');
  const keyLines = [...strings.matchAll(/^\s{2}(cn2b_approve_[a-z0-9_]+):\s*(\{[^\n]*\}),?\r?$/gm)];

  it('every E2-D key is bilingual; every key the panel uses exists', () => {
    expect(keyLines.length).toBeGreaterThanOrEqual(35);
    for (const [, key, body] of keyLines) {
      expect(body, key).toMatch(/ar:\s*'[^']+'/);
      expect(body, key).toMatch(/en:\s*'(?:[^'\\]|\\.)+'/);
    }
    for (const [key] of code(PANEL).matchAll(/'cn2b_(?:approve|map)_[a-z0-9_]+'/g)) {
      expect(strings, key).toMatch(new RegExp(`^  ${key.slice(1, -1)}:`, 'm'));
    }
  });

  it('never a bare "approved": every English "approved" is local or negated', () => {
    for (const [, key, body] of keyLines) {
      const en = body.match(/en:\s*'((?:[^'\\]|\\.)+)'/)?.[1] ?? '';
      if (/\bapproved\b/i.test(en)) expect(en, key).toMatch(/approved locally|not submitted or approved|cannot be approved/);
      expect(en, key).not.toMatch(/^(Approved|Plan approved|Annual needs approved)\b/i);
    }
  });

  it('the Owner\'s exact phrases are present, and the disclaimer is rendered unconditionally', () => {
    const exact: Array<[string, string, string]> = [
      ['cn2b_approve_action', 'اعتماد تعيينات الملف', 'Approve file mappings'],
      ['cn2b_approve_approved_locally', 'تعيينات الملف معتمدة محليًا', 'File mappings approved locally'],
      ['cn2b_approve_disclaimer', 'هذا الاعتماد يثبت مراجعة التعيينات فقط ولا يرسل الخطة للاعتماد.', 'This approval covers mapping review only and does not submit or approve the Annual Needs revision.'],
    ];
    for (const [key, ar, en] of exact) {
      const body = keyLines.find(([, k]) => k === key)?.[2] ?? '';
      expect(body, key).toContain(`ar: '${ar}'`);
      expect(body, key).toContain(`en: '${en}'`);
    }
    const panel = code(PANEL);
    const disclaimer = panel.indexOf("t('cn2b_approve_disclaimer', lang)");
    expect(disclaimer).toBeGreaterThan(0);
    // Not inside any conditional block: the nearest preceding JSX conditional is before the title.
    expect(panel.lastIndexOf('&& (', disclaimer)).toBeLessThan(panel.indexOf("t('cn2b_approve_title', lang)"));
  });

  it('an auxiliary block of its own — never a Simple task card — in logical CSS properties', () => {
    expect(code(PANEL)).toMatch(/className="cn2b-approve"/);
    expect(code(PANEL)).not.toMatch(/cn2b-simple-card/);
    const css = read('src/shared/lib/central-needs.css');
    const block = css.slice(css.indexOf('.cn2b-approve {'), css.indexOf('/* ── The quiet Advanced entry'));
    expect(block.length).toBeGreaterThan(200);
    expect(block).not.toMatch(/(^|[\s;{])(margin-left|margin-right|padding-left|padding-right|left|right|text-align)\s*:/m);
  });
});

describe('E2-D.15 — the guards are precise', () => {
  it('each catches what it names and allows what E2-D does', () => {
    for (const bad of ["supabase.rpc('x')", 'fetch(url)', 'localStorage.setItem(k, v)', "import { x } from '@/shared/supabase/client'"]) expect(bad).toMatch(NETWORK_OR_STORAGE);
    for (const bad of ['await approveRevision(id)', 'submitRevision(id)', 'revision.status', "status: 'submitted'", 'readiness: ReviewReadiness']) expect(bad).toMatch(SERVER_APPROVAL);
    for (const bad of ['Math.random()', 'Date.now()', "import sha from 'js-sha256'", "import { createHash } from 'node:crypto'"]) expect(bad).toMatch(WEAK_OR_TIME);
    for (const bad of ['revision.organizationId', 'organization_id', 'type PlanRevision']) expect(bad).toMatch(PLAN_OWNER);
    for (const good of ["globalThis.crypto?.subtle", "subtle.digest('SHA-256', bytes)", 'planRevisionId', "status: 'approved'", 'data-approval-status']) {
      expect(good).not.toMatch(NETWORK_OR_STORAGE);
      expect(good).not.toMatch(WEAK_OR_TIME);
      expect(good).not.toMatch(PLAN_OWNER);
    }
    expect("status: 'approved'").not.toMatch(SERVER_APPROVAL);
  });
});

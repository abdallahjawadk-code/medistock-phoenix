/**
 * C4 — static guard over the client region boundary (comment-stripped source,
 * so prose can never satisfy a check).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../../../..');
const code = (p: string) => readFileSync(join(ROOT, p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const F = 'src/features/central-needs';
const LAYER = `${F}/regions/BeneficiaryRegionLayer.tsx`;
const RULES = `${F}/regions/beneficiaryRegions.ts`;
const CONTEXT = `${F}/regions/RegionWorkspace.tsx`;
const SERVICE = `${F}/central-needs.service.ts`;
const REGION_FILES = [LAYER, RULES, CONTEXT];

const fnBody = (src: string, name: string) => {
  // Up to the function's own closing brace at column 0 (its input type closes with "})").
  const m = src.match(new RegExp(`export async function ${name}\\([\\s\\S]*?\\n\\}\\n`));
  expect(m, name).not.toBeNull();
  return (m as RegExpMatchArray)[0];
};

describe('C4 client — the region read ends only on an empty page and fails closed', () => {
  for (const name of ['listBeneficiaryRegions', 'listScopeColumnMappings']) {
    it(`${name}: empty-page termination, advance by rows returned, no short-page stop`, () => {
      const body = fnBody(code(SERVICE), name);
      expect(body).toMatch(/if \(batch\.length === 0\) break;/);
      expect(body).toMatch(/offset \+= batch\.length;/);
      expect(body).not.toMatch(/batch\.length\s*<\s*REGION_PAGE_SIZE/);
      expect(body).toMatch(/\.range\(offset, offset \+ REGION_PAGE_SIZE - 1\)/);
      expect(body).toMatch(/beneficiary_regions_read_inconsistent/);
    });
  }

  it('the working view is ACTIVE versions only', () => {
    expect(fnBody(code(SERVICE), 'listBeneficiaryRegions')).toMatch(/\.is\('retired_at', null\)/);
  });
});

describe('C4 client — one write path, never retried, never local truth', () => {
  it('the only region writer is the one RPC; the service performs no direct table write', () => {
    const service = code(SERVICE);
    expect(service.match(/phoenix_central_needs_set_beneficiary_regions/g)).toHaveLength(1);
    expect(service).not.toMatch(/\.from\('central_needs_beneficiary_regions'\)[\s\S]{0,200}\.(insert|update|upsert|delete)\(/);
  });

  it('the layer calls setBeneficiaryRegions from one place, with no loop around it (no automatic retry)', () => {
    const layer = code(LAYER);
    expect(layer.match(/await setBeneficiaryRegions\(/g)).toHaveLength(1);
    const send = layer.slice(layer.indexOf('async function send('), layer.indexOf('function confirmPending('));
    expect(send).not.toMatch(/\bwhile\s*\(|setTimeout|setInterval|\bretry\b/i);
    // The only loop is the removal of the drafts the confirmed call just saved.
    expect(send.match(/\bfor\s*\(/g)).toHaveLength(1);
    expect(send).toMatch(/for \(const id of savedDraftIds\) institutions\.remove\(id\);/);
    expect(send.indexOf('await setBeneficiaryRegions(')).toBeLessThan(send.indexOf('for (const id of savedDraftIds)'));
  });

  it('no browser storage, URL persistence or audit read anywhere in the region code', () => {
    for (const file of [...REGION_FILES, `${F}/central-needs.revision-open.ts`]) {
      const src = code(file);
      expect(src, file).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\b/);
      expect(src, file).not.toMatch(/history\s*\.\s*(pushState|replaceState)|URLSearchParams|document\.cookie/);
      expect(src, file).not.toMatch(/audit_logs/);
    }
    expect(code(SERVICE)).not.toMatch(/from\('audit_logs'\)/);
  });

  it('server regions are never turned into E2-C drafts: the layer only removes drafts it just saved', () => {
    const layer = code(LAYER);
    for (const verb of ['commit', 'captureNeed', 'captureAnchor', 'chooseBeneficiary', 'edit', 'confirmReset']) {
      expect(layer, verb).not.toMatch(new RegExp(`institutions\\.${verb}\\(`));
    }
    expect(layer).toMatch(/for \(const id of savedDraftIds\) institutions\.remove\(id\);/);
  });

  it('a conversion copies nothing from the M213 row into a region', () => {
    const rules = code(RULES);
    const conv = rules.slice(rules.indexOf('export function conversionOf'), rules.indexOf('export function conversionsWithoutRegion'));
    expect(conv).not.toMatch(/rowStart|columnStart|op: 'add'/);
  });

  it('no copy suggests importing a modified workbook as a remedy', () => {
    const strings = readFileSync(join(ROOT, 'src/shared/i18n/strings.ts'), 'utf8');
    const c4 = strings.split('\n').filter((l) => /^\s+(cn4_|cn2b_err_beneficiary_region|cn2b_blocker_beneficiary_region)/.test(l));
    expect(c4.length).toBeGreaterThan(30);
    for (const line of c4) expect(line, line.slice(0, 60)).not.toMatch(/re-?import|upload (a|the) (modified|new|changed)|أعد (رفع|استيراد)/i);
  });
});

describe('C4 client — the screen opens by identity and reads regions fail-closed', () => {
  it('the rows[0] default is gone', () => {
    const screen = code(`${F}/CentralNeedsScreen.tsx`);
    expect(screen).not.toMatch(/rows\[0\]\?\.id/);
    expect(screen).toMatch(/setRevisionId\(\(current\) => revisionToOpen\(rows, current\)\)/);
  });

  it('a region read failure becomes "unavailable", never an empty "ready" layer', () => {
    const screen = code(`${F}/CentralNeedsScreen.tsx`);
    expect(screen).toMatch(/listBeneficiaryRegions\(\{ planRevisionId: id \}\)/);
    expect(screen).toMatch(/phase: 'unavailable'/);
    expect(screen).toMatch(/const REGIONS_NOT_LOADED: RegionReadState = \{ phase: 'unavailable'/);
  });
});

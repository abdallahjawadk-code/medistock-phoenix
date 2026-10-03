/**
 * CN-UI-S1 HC1.3 — the SOURCE-LEVEL rules of the head-aware derivation (H1_3_02, H1_3_11, scope).
 *
 * The behaviour is proven in `cn-ui-s1-hc1-3-lineage-head.test.ts` and, through the real
 * screen, in `cn-ui-s1-hc1-3-screen.runtime.test.tsx`. This file pins only what behaviour
 * cannot show: that there is ONE implementation of the current-head decision (no second
 * head rule, no second numeric rule, no second DETAIL parser) and that the derivation stays
 * a pure projection (no read, no write, no re-sort).
 *
 * A rule is judged on the code that runs, with comments removed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const codeOf = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SRC = 'src/features/central-needs/simple/simpleReadiness.ts';

describe('HC1.3 — ONE implementation of the current-head decision', () => {
  it('the head, the pinnability rule and the DETAIL parser are each used exactly once, and both head-dependent reasons reach them only through `head_dependent`', () => {
    const src = codeOf(SRC);
    expect(src.match(/overrideHeads\(/g)).toHaveLength(1);
    expect(src.match(/numericOverrideLexeme\(/g)).toHaveLength(1); // HC1.4: was `isNumericOverride(` — "is a number" became "can really be pinned"
    expect(src.match(/sourceRecordOf\(/g)).toHaveLength(1);
    expect(src.match(/currentNumericHeadRemedyOf\(/g)).toHaveLength(3); // its definition, the HC1.2 wrapper, and the single call in noteRemedy
    // Both reasons are `head_dependent` in the table; no branch names either reason anywhere else but the three vocabulary tables.
    const table = (src.match(/const LINEAGE_REMEDY_BY_REASON[\s\S]*?\n\};/) as RegExpMatchArray)[0];
    expect(table).toContain("source_quantity_requires_explicit_numeric_override: { route: 'head_dependent' },");
    expect(table).toContain("source_quantity_override_binding_invalid: { route: 'head_dependent' },");
    const outsideTables = src
      .replace(/export const M217_LINEAGE_REASONS[\s\S]*?\] as const;/, '')
      .replace(/const LINEAGE_MESSAGE_KEY_BY_REASON[\s\S]*?\n\];/, '')
      .replace(/const LINEAGE_REMEDY_BY_REASON[\s\S]*?\n\};/, '');
    expect(outsideTables).not.toContain('source_quantity_requires_explicit_numeric_override');
    expect(outsideTables).not.toContain('source_quantity_override_binding_invalid');
    // The shared helper is the only thing that reads the chain.
    expect(src).toContain('const head = overrideHeads(context.overrides).get(record);');
    expect(src).toContain('return head !== undefined && numericOverrideLexeme(head) !== null ? SIMPLE_REMEDY : NEEDS_NUMERIC_CORRECTION;');
    expect(src).toContain('noteRemedy(found, currentNumericHeadRemedyOf(detail, context), detail, context);');
  });

  it('the exported HC1.2 helper is a one-line delegation to the shared decision, with no head logic of its own', () => {
    const src = codeOf(SRC);
    const wrapper = (src.match(/export function bindingInvalidRemedyOf[\s\S]*?\n\}/) as RegExpMatchArray)[0];
    expect(wrapper).toContain('return currentNumericHeadRemedyOf(detail, context);');
    expect(wrapper).not.toMatch(/overrideHeads|numericOverrideLexeme|isNumericOverride|sourceRecordOf|route|HEAD_UNPROVEN|SIMPLE_REMEDY|NEEDS_NUMERIC_CORRECTION/);
  });

  it('the chain is read in the order the server sent it: no sort, no re-order, no date parsing anywhere in the derivation', () => {
    const src = codeOf(SRC);
    expect(src).not.toMatch(/\.sort\(|\.toSorted\(|\.reverse\(|createdAt|localeCompare|Date\.parse|new Date/);
    // No second numeric rule and no second head rule are written here.
    expect(src).not.toMatch(/typeof [a-z.]*finalValue|Number\.isFinite|>= 0|new Map\(\)/);
  });
});

describe('HC1.3 — the derivation stays a pure projection of what the screen already holds', () => {
  it('it imports only the shared vocabulary, the canonical lineage helpers and the reason / record parsers — no service call, no read, no write, no browser global', () => {
    const src = read(SRC);
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['../CentralNeedsWorkspaceState', '../central-needs.lineage', '../central-needs.service', '../central-needs.service']);
    const code = codeOf(SRC);
    expect(code).not.toMatch(/supabase|\.rpc\(|fetch\(|window|document|localStorage|await |async |listOverrides|fetchReviewReadiness|recordFieldOverride|setNeedLine/);
    // The only values taken from the service are the two DETAIL parsers; from the lineage module, the two canonical helpers.
    expect(code).toContain("import { numericOverrideLexeme, overrideHeads } from '../central-needs.lineage';"); // HC1.4
    expect(code).toContain("import { reasonOf, sourceRecordOf } from '../central-needs.service';");
  });

  it('it names no permission and no capability: who may act on an escape is decided elsewhere, unchanged', () => {
    expect(codeOf(SRC)).not.toMatch(/central_needs\.|canWrite|canImport|canEdit|permission/i);
  });
});

describe('HC1.4 — the ONLY quantity-pinnability authority is the canonical `numericOverrideLexeme`', () => {
  it('the derivation re-implements none of what that helper owns: no 256 ceiling, no decimal grammar, no finalValueText preference, no JSON-number test, no normalization', () => {
    const code = codeOf(SRC);
    // The bare numeric test that HC1.3 used is gone from the code (a number is not necessarily a PINNABLE number)…
    expect(code).not.toMatch(/isNumericOverride/);
    // …and none of the helper's internals is copied: the ceiling, the grammar, the canonical-quantity check, the text preference, the normalizer.
    expect(code).not.toMatch(/MAX_QUANTITY_LEXEME_LENGTH|SERVER_DECIMAL|CANONICAL_INTEGER|isCanonicalQuantity|canonicalDecimalText|prefillQuantity/);
    expect(code).not.toMatch(/finalValueText|finalValue\b|\b256\b|\.length\b|parseFloat|parseInt|Number\(|String\(|BigInt|\.test\(|Math\./);
    // The one call site decides on the helper's own answer, nothing else.
    expect(code).toContain('numericOverrideLexeme(head) !== null');
  });

  it('the canonical lineage module and the service are consumed, not edited or shadowed: the derivation imports exactly their existing exports', () => {
    const src = read(SRC);
    expect(src).toMatch(/import \{ numericOverrideLexeme, overrideHeads \} from '\.\.\/central-needs\.lineage';/);
    const lineage = read('src/features/central-needs/central-needs.lineage.ts');
    // The helper this relies on exists with the contract it relies on (so a rename or removal cannot silently turn this into dead code).
    expect(lineage).toMatch(/export function numericOverrideLexeme\(o: FieldOverride\): string \| null \{/);
    expect(lineage).toMatch(/if \(!isNumericOverride\(o\)\) return null;/);
    expect(lineage).toMatch(/return isCanonicalQuantity\(text\) \? text : null;/);
    expect(lineage).toMatch(/export const MAX_QUANTITY_LEXEME_LENGTH = 256;/);
  });
});

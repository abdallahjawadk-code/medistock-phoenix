/**
 * CN-UI-S1 HC1.5 — the SOURCE-LEVEL rules of the canonical panel's pinnability alignment (H1_5_10 and the scope pins).
 *
 * The behaviour is proven in `cn-ui-s1-hc1-5-panel-pinnability.runtime.test.tsx` (the real panel) and
 * `cn-ui-s1-hc1-5-screen.runtime.test.tsx` (the real screen). This file pins only what behaviour cannot show:
 *
 *   * the successful pin path takes its quantity from the canonical lexeme DIRECTLY — there is no
 *     `numericOverrideLexeme(o) ?? current.quantity` (or any equivalent) fallback;
 *   * the panel asks ONE gate — `pinnableLexemeOf` — for the pin control, the pin itself and the stale-pin check,
 *     and that gate is the exact-current-head identity plus `numericOverrideLexeme`, nothing else;
 *   * the bare numeric test is presentation metadata only, and no quantity grammar is written in the panel's
 *     pinnability path (the canonical helper is its only authority);
 *   * the panel gained no import, no backend reach, no browser global; the canonical helper is consumed, not edited.
 *
 * A rule is judged on the code that runs, with comments removed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { T } from '@/shared/i18n/strings';

const ROOT = join(__dirname, '../../../..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const codeOf = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const PANEL = 'src/features/central-needs/CentralNeedsNeedLinePanel.tsx';
const LINEAGE = 'src/features/central-needs/central-needs.lineage.ts';

/** The code of one declaration, from its opening up to the first closing brace at the same indentation. */
function declaration(code: string, opening: string, indent: string): string {
  const start = code.indexOf(opening);
  if (start < 0) throw new Error(`not found: ${opening}`);
  const rest = code.slice(start);
  const end = rest.search(new RegExp(`\\n${indent}\\}\\n`));
  if (end < 0) throw new Error(`no closing brace for: ${opening}`);
  return rest.slice(0, end + indent.length + 2);
}

describe('H1_5_10 — the successful pin path has NO fallback: the quantity IS the canonical lexeme', () => {
  const code = codeOf(PANEL);
  const useOverride = declaration(code, '  function useOverride(', '  ');

  it('useOverride takes the lexeme from the gate, returns before any state change when there is none, and pins with exactly that lexeme', () => {
    const body = flat(useOverride);
    expect(body).toContain('const lexeme = on ? pinnableLexemeOf(headByRecord, record.id, o.id) : null;');
    expect(body).toContain('if (on && lexeme === null) return;');
    expect(body).toContain('{ quantity: lexeme, overrideId: o.id }');
    // the guard comes BEFORE the state change
    expect(body.indexOf('if (on && lexeme === null) return;')).toBeLessThan(body.indexOf('setDesignated('));
    // un-ticking keeps what was typed and drops only the pin
    expect(body).toContain('{ quantity: current.quantity, overrideId: null }');
  });

  it('no `numericOverrideLexeme(o) ?? current.quantity` — and no equivalent fallback — anywhere in the panel', () => {
    expect(code).not.toMatch(/numericOverrideLexeme\([^)]*\)\s*\?\?/);
    expect(code).not.toMatch(/\?\?\s*current\.quantity/);
    expect(code).not.toMatch(/lexeme\s*\?\?|\?\?\s*lexeme/);
    expect(code).not.toMatch(/\|\|\s*current\.quantity/);
    // useOverride in particular: no `??` / `||` default, and none of the bare numeric test or any quantity grammar
    expect(useOverride).not.toMatch(/\?\?|\|\|/);
    expect(useOverride).not.toMatch(/isNumericOverride|numericOverrideLexeme|isCanonicalQuantity|SERVER_DECIMAL|finalValue|\b256\b|\.length\b|String\(|Number\(|parseFloat|\.trim\(/);
  });
});

describe('HC1.5 — the panel asks ONE gate (pinnableLexemeOf) for the control, the pin and the stale-pin check', () => {
  const code = codeOf(PANEL);

  it('the gate is the exact-current-head identity plus the canonical helper, and nothing else', () => {
    const gate = flat(declaration(code, 'export function pinnableLexemeOf(', ''));
    expect(gate).toContain('const head = heads.get(recordId); return head !== undefined && head.id === overrideId ? numericOverrideLexeme(head) : null; }');
    expect(gate).not.toMatch(/isNumericOverride|isCanonicalQuantity|SERVER_DECIMAL|finalValue|\b256\b|\.length\b|String\(|Number\(|parseFloat|\.trim\(|\.sort\(|createdAt/);
  });

  it('every pinnability decision in the panel goes through it: the canonical helper is called once (inside the gate), the gate is used by the control, the pin and the stale check', () => {
    expect(code.match(/numericOverrideLexeme\(/g)).toHaveLength(1); // the gate's body
    expect(code.match(/pinnableLexemeOf\(/g)).toHaveLength(4); // its declaration + the control + useOverride + the stale-pin check
    expect(code).toContain("const pinnableHead = o ? pinnableLexemeOf(headByRecord, r.id, o.id) !== null : false;");
    expect(flat(code)).toContain('d.overrideId !== null && pinnableLexemeOf(headByRecord, id, d.overrideId) === null');
    // the HC1.4-era stale rule (identity only) is gone: a pin is stale if it is not the current head OR cannot be pinned
    expect(code).not.toMatch(/headByRecord\.get\(id\)\?\.id\s*!==\s*d\.overrideId/);
  });

  it('the bare numeric test survives only as presentation metadata (`data-numeric` and the "not a number" branch) — it never decides the control', () => {
    expect(code.match(/isNumericOverride\(/g)).toHaveLength(1);
    expect(code).toContain('const numericHead = o ? isNumericOverride(o) : false;');
    const flatCode = flat(code);
    // the pin control is shown on `pinnableHead` (and its label is the established one) …
    expect(flatCode).toContain('{pinnableHead ? ( <label className="cn2b-nl-contrib__override">');
    expect(flatCode).toContain("useOverride(r, o, e.target.checked)");
    expect(flatCode).toContain("{t('cn2b_nl_use_override', lang)} </label>");
    // … a NUMBER that cannot be pinned gets its own note …
    expect(flatCode).toContain(") : numericHead ? ( <span className=\"cn2b-nl-row__meta\" data-testid=\"cn2b-nl-override-not-pinnable\">{t('cn2b_nl_override_not_pinnable', lang)}</span> )");
    // … and only what is not a number at all keeps the established "not a number" note.
    expect(flatCode).toContain("<span className=\"cn2b-nl-row__meta\" data-testid=\"cn2b-nl-override-not-numeric\">{t('cn2b_nl_override_not_numeric', lang)}</span>");
    // the control is never gated on the numeric test
    expect(flatCode).not.toMatch(/\{numericHead \? \( <label className="cn2b-nl-contrib__override">/);
    // the evidence row reports the two facts separately
    expect(flatCode).toContain("data-numeric={numericHead ? 'true' : 'false'} data-pinnable={pinnableHead ? 'true' : 'false'}");
    // the "contribution based on the recorded override" note is shown only for a pin that can exist
    expect(flatCode).toContain('{picked.overrideId === o.id && pinnableHead && (');
  });

  it('a stale pin withholds saving in the SAME render (before the reconcile effect runs): everyPinCurrent feeds canSave and the stale-pin blocker — a window no runtime assertion can observe once effects flush', () => {
    const flatCode = flat(code);
    expect(flatCode).toContain('const everyPinCurrent = stalePinIds.length === 0;');
    expect(flatCode).toContain('const canSave = editable && overridesReadable && regionEvidence.usable && everyPinCurrent');
    expect(flatCode).toContain("!everyPinCurrent && 'cn2b_nl_block_stale_pin'");
    // openPreview and commit both refuse when canSave is false (they are the only ways to a write)
    expect(flat(declaration(code, '  function openPreview(', '  '))).toContain('if (!canSave) return;');
    expect(flat(declaration(code, '  async function commit(', '  '))).toContain('if (!preview || previewStale || !canSave) return;');
    expect(code.match(/\bsetNeedLine\(/g)).toHaveLength(1); // …and commit() is the one place the write is made
  });

  it('the pinnability path writes no quantity grammar: no 256, no decimal regex, no finalValueText, no JSON-number test, no normalization', () => {
    const gate = declaration(code, 'export function pinnableLexemeOf(', '');
    const pinPath = [
      gate,
      declaration(code, '  function useOverride(', '  '),
      // the stale-pin predicate (only the `.filter(...)` — the surrounding effect legitimately tests `.length > 0`)
      code.slice(code.indexOf('.filter(([id, d]) => d.overrideId !== null'), code.indexOf('.map(([id]) => id)')),
      code.slice(code.indexOf('const numericHead ='), code.indexOf('const pinCleared')),
    ].join('\n');
    expect(pinPath).not.toMatch(/MAX_QUANTITY|SERVER_DECIMAL|CANONICAL_INTEGER|isCanonicalQuantity|canonicalDecimalText|prefillQuantity/);
    expect(pinPath).not.toMatch(/finalValueText|finalValue\b|\b256\b|\.length\b|parseFloat|parseInt|Number\(|String\(|BigInt|\.test\(|Math\.|\.trim\(/);
  });
});

describe('HC1.5 — scope: no new import, no backend reach, no browser global; the canonical helper is consumed, not edited', () => {
  it('the panel imports exactly what it did (this is the HC1.5 scope pin: no new reach), and takes the same seven names from the canonical lineage module', () => {
    const src = read(PANEL);
    const modules = [...src.matchAll(/from '([^']+)';$/gm)].map((m) => m[1]);
    expect(modules).toEqual([
      'react', '@/shared/i18n/strings', '@/shared/ui/PhoenixCard', '@/shared/ui/PhoenixInput', '@/shared/ui/PhoenixButton',
      '@/shared/supabase/services/organizations.service', '@/shared/supabase/services/warehouses.service',
      './central-needs.service', './central-needs.i18n', './central-needs.lineage', './regions/beneficiaryRegions',
    ]);
    expect(flat(src)).toContain("import { SERVER_DECIMAL, isCanonicalQuantity, isNumericOverride, numericOverrideLexeme, overrideHeads, overrideValueText, prefillQuantity, } from './central-needs.lineage';");
  });

  it('it reads and writes nothing new: no fetch, no RPC, no table read, no browser global, no override read of its own', () => {
    const code = codeOf(PANEL);
    expect(code).not.toMatch(/fetch\(|\.rpc\(|\.from\(|supabase\.|window\.|document\.|localStorage|sessionStorage|XMLHttpRequest/);
    expect(code).not.toMatch(/listOverrides|fetchReviewReadiness|recordFieldOverride/);
    // the only service calls remain the two need-line writes
    expect(code.match(/\bsetNeedLine\(/g)).toHaveLength(1);
    expect(code.match(/\bdeleteNeedLine\(/g)).toHaveLength(1);
  });

  it('the canonical helper this relies on exists with the contract it relies on (so a rename or removal cannot silently turn this into dead code)', () => {
    const lineage = read(LINEAGE);
    expect(lineage).toMatch(/export function numericOverrideLexeme\(o: FieldOverride\): string \| null \{/);
    expect(lineage).toMatch(/if \(!isNumericOverride\(o\)\) return null;/);
    expect(lineage).toMatch(/return isCanonicalQuantity\(text\) \? text : null;/);
    expect(lineage).toMatch(/export function overrideHeads\(/);
  });
});

describe('HC1.5 — copy: the new note is its own sentence, the "not a number" sentence is untouched', () => {
  it('cn2b_nl_override_not_pinnable exists in both languages, says "a number … cannot be used", and carries no implementation jargon', () => {
    expect(T.cn2b_nl_override_not_pinnable.en).toBe('This override is a number, but it cannot be used as a canonical quantity.');
    expect(T.cn2b_nl_override_not_pinnable.ar).toBe('هذا التعديل رقمي، لكنه غير صالح للاستخدام ككمية معيارية.');
    for (const lang of ['en', 'ar'] as const) {
      expect(T.cn2b_nl_override_not_pinnable[lang]).not.toMatch(/256|lexeme|JSON|exponent|character|حرف|رمز/i);
    }
  });

  it('the established nonnumeric sentence is byte-identical to HC1.4 (HC1.5 does not reuse or reword it)', () => {
    expect(T.cn2b_nl_override_not_numeric.en).toBe('This override is not a number, so it cannot stand for a quantity.');
    expect(T.cn2b_nl_override_not_numeric.ar).toBe('هذا التعديل ليس رقمًا، فلا يمكن أن يمثّل كمية.');
    expect(T.cn2b_nl_use_override.en).toBe('Base it on the recorded override');
    expect(T.cn2b_nl_use_override.ar).toBe('اعتمد القيمة المعدّلة المسجّلة');
  });
});

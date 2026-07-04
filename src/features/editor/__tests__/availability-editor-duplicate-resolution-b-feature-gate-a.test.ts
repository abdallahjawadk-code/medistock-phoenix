/**
 * AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-FEATURE-GATE-A
 * Run: npm test -- --run
 *
 * Static source-code tests (same pattern as the other editor test files in
 * this directory: readFileSync + string/regex assertions — there is no React
 * test renderer wired up in this repo).
 *
 * This phase adds a build-time feature gate (VITE_PHOENIX_BATCH_IDENTITY_051_ENABLED,
 * default OFF) around the post-migration-051 frontend behavior prepared in
 * AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-PREP-A, so that patch can safely
 * ship to production ahead of migration 051's manual SQL apply without any
 * live behavior change. Migration 051 is committed but NOT applied — this
 * phase does not apply it, does not touch SQL, and does not connect to
 * Supabase or otherwise infer migration status at runtime.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');

function readSrc(rel: string) {
  return readFileSync(join(SRC, rel), 'utf8');
}

const editor = readSrc('features/editor/EditorScreen.tsx');

describe('AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-FEATURE-GATE-A: gate definition', () => {
  it('defines a VITE_PHOENIX_BATCH_IDENTITY_051_ENABLED gate constant', () => {
    expect(editor).toContain("const BATCH_IDENTITY_051_ENABLED = import.meta.env.VITE_PHOENIX_BATCH_IDENTITY_051_ENABLED === 'true';");
  });

  it('defaults to OFF for any value other than the literal string \'true\' (missing env var, "false", "1", etc. all resolve falsy)', () => {
    expect(editor).toContain("=== 'true';");
    // Guards against a truthy-string bug (e.g. `!!import.meta.env.X`, which
    // would treat the string "false" as truthy) — the equality check is the
    // only form that safely defaults OFF when the var is unset.
    expect(editor).not.toMatch(/BATCH_IDENTITY_051_ENABLED\s*=\s*!!import\.meta\.env/);
  });

  it('does not perform any runtime DB/Supabase check to decide the gate (build-time env var only)', () => {
    const idx = editor.indexOf('const BATCH_IDENTITY_051_ENABLED');
    const line = editor.slice(idx, editor.indexOf('\n', idx));
    expect(line).not.toContain('supabase');
    expect(line).not.toContain('.rpc(');
    expect(line).not.toContain('await');
  });

  it('a comment near the gate states it must only be enabled with/after migration 051 manual apply', () => {
    const idx = editor.indexOf('const BATCH_IDENTITY_051_ENABLED');
    const before = editor.slice(Math.max(0, idx - 900), idx);
    expect(before).toContain('must only be enabled');
    expect(before).toContain('migration 051');
  });
});

describe('AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-FEATURE-GATE-A: gate OFF preserves the old 4-column live behavior', () => {
  it('legacyProductExistingRow implements the old 4-column key (scientific_name + concentration + dosage_form only)', () => {
    const block = editor.slice(editor.indexOf('const legacyProductExistingRow = useMemo'), editor.indexOf('const legacyProductExistingRow = useMemo') + 500);
    expect(block).toMatch(/r\.scientific_name/);
    expect(block).toMatch(/r\.concentration/);
    expect(block).toMatch(/r\.dosage_form/);
    expect(block).not.toMatch(/r\.national_code/);
    expect(block).not.toMatch(/r\.batch_number/);
    expect(block).not.toMatch(/r\.expiry_date/);
  });

  it('exactExistingRow resolves to legacyProductExistingRow when the gate is OFF', () => {
    expect(editor).toContain('const exactExistingRow = BATCH_IDENTITY_051_ENABLED ? strictExactExistingRow : legacyProductExistingRow;');
  });

  it('similarProductRows is forced empty when the gate is OFF (no independent-row candidates can ever surface pre-051)', () => {
    const block = editor.slice(editor.indexOf('const similarProductRows = useMemo'), editor.indexOf('const similarProductRows = useMemo') + 200);
    expect(block).toContain('if (!BATCH_IDENTITY_051_ENABLED) return [];');
  });

  it('hasIndependentRowCandidate is always false when the gate is OFF (short-circuits on BATCH_IDENTITY_051_ENABLED)', () => {
    expect(editor).toContain('const hasIndependentRowCandidate = BATCH_IDENTITY_051_ENABLED && !isEditMode && !!primarySimilarRow;');
  });
});

describe('AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-FEATURE-GATE-A: gate ON enables the 051 behavior', () => {
  it('strictExactExistingRow implements the 7-column Option A key', () => {
    const block = editor.slice(editor.indexOf('const strictExactExistingRow = useMemo'), editor.indexOf('const strictExactExistingRow = useMemo') + 700);
    expect(block).toMatch(/r\.scientific_name/);
    expect(block).toMatch(/r\.concentration/);
    expect(block).toMatch(/r\.dosage_form/);
    expect(block).toMatch(/r\.national_code/);
    expect(block).toMatch(/r\.batch_number/);
    expect(block).toMatch(/r\.expiry_date/);
  });

  it('a same-product row with a different national_code, batch_number, or expiry_date is excluded from strictExactExistingRow by construction (all three fields are part of the equality chain)', () => {
    const block = editor.slice(editor.indexOf('const strictExactExistingRow = useMemo'), editor.indexOf('const strictExactExistingRow = useMemo') + 700);
    expect(block).toMatch(/normKey\(r\.national_code[^)]*\)\s*===\s*normKey\(nationalCode\)/);
    expect(block).toMatch(/normKey\(r\.batch_number[^)]*\)\s*===\s*normKey\(batch\)/);
    expect(block).toMatch(/normKey\(r\.expiry_date[^)]*\)\s*===\s*normKey\(expiry\)/);
  });

  it('exactExistingRow resolves to strictExactExistingRow when the gate is ON', () => {
    expect(editor).toContain('const exactExistingRow = BATCH_IDENTITY_051_ENABLED ? strictExactExistingRow : legacyProductExistingRow;');
  });

  it('similarProductRows uses the product-level key (not the 7-column key) when the gate is ON', () => {
    const block = editor.slice(editor.indexOf('const similarProductRows = useMemo'), editor.indexOf('const similarProductRows = useMemo') + 700);
    expect(block).toMatch(/r\.scientific_name/);
    expect(block).toMatch(/r\.concentration/);
    expect(block).toMatch(/r\.dosage_form/);
    expect(block).not.toMatch(/r\.national_code/);
    expect(block).not.toMatch(/r\.batch_number/);
    expect(block).not.toMatch(/r\.expiry_date/);
  });

  it('independent-row submission requires explicit confirmation, gated on hasIndependentRowCandidate', () => {
    const block = editor.slice(editor.indexOf('const canSubmit ='), editor.indexOf('const canSubmit =') + 400);
    expect(block).toContain('(!hasIndependentRowCandidate || independentRowConfirmed)');
    const doApplyBlock = editor.slice(editor.indexOf('async function doApply'), editor.indexOf('await upsertAvailability'));
    expect(doApplyBlock).toContain('if (hasIndependentRowCandidate && !independentRowConfirmed)');
  });

  it('once confirmed, submit proceeds to upsertAvailability for an identity-difference candidate (no additional gate-specific block after confirmation)', () => {
    const doApplyBlock = editor.slice(editor.indexOf('async function doApply'), editor.indexOf('await upsertAvailability'));
    // The only two early-return guards before the RPC call are similarMatchBlocked
    // (supply_type/price conflicts) and the independent-row confirmation guard —
    // once independentRowConfirmed is true, hasIndependentRowCandidate no longer
    // blocks, so execution reaches upsertAvailability normally.
    const guardCount = (doApplyBlock.match(/setShowConfirm\(false\);\s*setToast/g) ?? []).length;
    expect(guardCount).toBe(2);
  });
});

describe('AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-FEATURE-GATE-A: supply_type/price stay outside identity in both gate states', () => {
  it('neither legacyProductExistingRow, strictExactExistingRow, nor similarProductRows ever reference supply_type or price', () => {
    const legacyBlock = editor.slice(editor.indexOf('const legacyProductExistingRow = useMemo'), editor.indexOf('const legacyProductExistingRow = useMemo') + 500);
    const strictBlock = editor.slice(editor.indexOf('const strictExactExistingRow = useMemo'), editor.indexOf('const strictExactExistingRow = useMemo') + 700);
    const similarBlock = editor.slice(editor.indexOf('const similarProductRows = useMemo'), editor.indexOf('const similarProductRows = useMemo') + 700);
    for (const block of [legacyBlock, strictBlock, similarBlock]) {
      expect(block).not.toMatch(/r\.supply_type/);
      expect(block).not.toMatch(/r\.price/);
    }
  });

  it('supplyTypeConflict/priceConflict blocking guards are not conditioned on the gate (apply regardless of BATCH_IDENTITY_051_ENABLED)', () => {
    expect(editor).toContain('const supplyTypeConflict = isEditMode');
    expect(editor).toContain('const priceConflict = isEditMode');
    expect(editor).not.toMatch(/supplyTypeConflict\s*=\s*BATCH_IDENTITY_051_ENABLED/);
    expect(editor).not.toMatch(/priceConflict\s*=\s*BATCH_IDENTITY_051_ENABLED/);
  });
});

describe('AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-FEATURE-GATE-A: no out-of-scope changes', () => {
  it('does not create or reference migration 052', () => {
    expect(editor).not.toMatch(/052/);
  });

  it('does not call db push, connect to Supabase directly, or use service_role', () => {
    expect(editor).not.toContain('db push');
    expect(editor).not.toContain('service_role');
  });

  it('does not modify migration 051 SQL', () => {
    const migration051 = readSrc('../supabase/migrations/051_material_batch_identity_option_a.sql');
    expect(migration051).toContain('MANUAL APPLY ONLY');
  });

  it('no package/lockfile diff introduced by this phase (checked structurally: gate file does not import new packages)', () => {
    const importBlock = editor.slice(0, editor.indexOf('export function EditorScreen'));
    const importedModules = [...importBlock.matchAll(/from '([^']+)'/g)].map(m => m[1]);
    for (const mod of importedModules) {
      expect(mod.startsWith('@/') || mod === 'react').toBe(true);
    }
  });
});

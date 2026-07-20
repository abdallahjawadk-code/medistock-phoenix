/**
 * AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-PREP-A
 * Run: npm test -- --run
 *
 * Static source-code tests (same pattern as the other editor test files in
 * this directory: source read + string/regex assertions on EditorScreen.tsx
 * and strings.ts — there is no React test renderer wired up in this repo).
 *
 * IMPORTANT — this phase prepares frontend sync for migration 051 (7-column
 * Option A identity key: distribution_point_id + scientific_name +
 * concentration + dosage_form + national_code + batch_number + expiry_date).
 * Migration 051 is committed but NOT applied. AVAILABILITY-EDITOR-DUPLICATE-
 * RESOLUTION-B-FEATURE-GATE-A (see availability-editor-duplicate-resolution-
 * b-feature-gate-a.test.ts) subsequently gated this behavior behind
 * BATCH_IDENTITY_051_ENABLED (default OFF) — the assertions below describe
 * the 7-column logic itself (now named strictExactExistingRow), which is
 * exercised only when that gate is explicitly turned on.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import {
  readSourceFile,
  balancedBlockAt,
  statementContaining,
  functionBodyAt,
  statementAt,
  blockBetween,
  enclosingJsxTag,
  precedingComment,
} from '../../../shared/__tests__/helpers/source-extract';

const SRC = join(__dirname, '../../../');

function readSrc(rel: string) {
  return readSourceFile(join(SRC, rel));
}

const editor = readSrc('features/editor/EditorScreen.tsx');
const strings = readSrc('shared/i18n/strings.ts');

describe('AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-PREP-A: strictExactExistingRow (7-column Option A key) exists behind the gate', () => {
  it('strictExactExistingRow checks scientific_name, concentration, and dosage_form (product key)', () => {
    const block = balancedBlockAt(editor, 'const strictExactExistingRow = useMemo');
    expect(block).toMatch(/r\.scientific_name/);
    expect(block).toMatch(/r\.concentration/);
    expect(block).toMatch(/r\.dosage_form/);
  });

  it('strictExactExistingRow additionally checks national_code, batch_number, and expiry_date (the 3 fields migration 051 adds to identity)', () => {
    const block = balancedBlockAt(editor, 'const strictExactExistingRow = useMemo');
    expect(block).toMatch(/r\.national_code/);
    expect(block).toMatch(/r\.batch_number/);
    expect(block).toMatch(/r\.expiry_date/);
  });

  it('a comment near the new matching logic flags the migration-051 deployment dependency', () => {
    const before = precedingComment(editor, 'const strictExactExistingRow = useMemo');
    expect(before).toContain('Must only be deployed/enabled with/after migration 051');
    expect(before).toContain('manual apply');
  });

  it('exactExistingRow is selected by the gate between strictExactExistingRow and legacyProductExistingRow', () => {
    expect(editor).toContain('const exactExistingRow = BATCH_IDENTITY_051_ENABLED ? strictExactExistingRow : legacyProductExistingRow;');
  });

  it('existingRow/isEditMode remain as backward-compatible aliases of exactExistingRow', () => {
    expect(editor).toContain('const existingRow = exactExistingRow;');
    expect(editor).toContain('const isEditMode = !!existingRow;');
  });
});

describe('AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-PREP-A: similar-product detection', () => {
  it('similarProductRows matches on product key only and excludes the exact match by id', () => {
    const block = balancedBlockAt(editor, 'const similarProductRows = useMemo');
    expect(block).toMatch(/r\.scientific_name/);
    expect(block).toMatch(/r\.concentration/);
    expect(block).toMatch(/r\.dosage_form/);
    expect(block).toContain('r.id !== exactExistingRow?.id');
    expect(block).not.toMatch(/r\.national_code/);
    expect(block).not.toMatch(/r\.batch_number/);
    expect(block).not.toMatch(/r\.expiry_date/);
  });

  it('primarySimilarRow picks the first similarProductRows entry', () => {
    expect(editor).toContain('const primarySimilarRow = similarProductRows[0] ?? null;');
  });

  it('hasIndependentRowCandidate requires the gate on, no exact match (isEditMode false), plus a similar row', () => {
    expect(editor).toContain('const hasIndependentRowCandidate = BATCH_IDENTITY_051_ENABLED && !isEditMode && !!primarySimilarRow;');
  });
});

describe('AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-PREP-A: independent-row confirmation', () => {
  it('an explicit confirmation state exists and resets when the candidate row changes', () => {
    expect(editor).toContain('const [independentRowConfirmed, setIndependentRowConfirmed] = useState(false);');
    // The reset lives in the effect declared immediately after the state, so it
    // is located by searching forward from the declaration rather than by a
    // character window that happened to span both.
    const resetEffect = statementContaining(
      editor,
      'useEffect(',
      'setIndependentRowConfirmed(false);',
    );
    expect(resetEffect).toContain('setIndependentRowConfirmed(false);');
    expect(resetEffect).toContain('[primarySimilarRow?.id]');
  });

  it('canSubmit requires confirmation when an independent-row candidate exists', () => {
    const block = statementAt(editor, 'const canSubmit =');
    expect(block).toContain('(!hasIndependentRowCandidate || independentRowConfirmed)');
  });

  it('doApply re-checks the confirmation guard before calling upsertAvailability', () => {
    const doApplyBlock = blockBetween(editor, 'async function doApply', 'await upsertAvailability');
    expect(doApplyBlock).toContain('if (hasIndependentRowCandidate && !independentRowConfirmed)');
    expect(doApplyBlock).toContain("t('avail_independent_row_confirm_required', lang)");
  });

  it('the panel renders a checkbox bound to independentRowConfirmed', () => {
    const block = balancedBlockAt(editor, '{hasIndependentRowCandidate && (');
    expect(block).toContain('type="checkbox"');
    expect(block).toContain('checked={independentRowConfirmed}');
    expect(block).toContain('onChange={e => setIndependentRowConfirmed(e.target.checked)}');
  });

  it('independentRowConfirmed resets after a successful save', () => {
    const applyBlock = blockBetween(editor, 'async function doApply', '} catch (e)');
    expect(applyBlock).toContain('setIndependentRowConfirmed(false)');
  });
});

describe('AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-PREP-A: panel UI and i18n', () => {
  it('panel only renders when hasIndependentRowCandidate is true', () => {
    expect(editor).toContain('{hasIndependentRowCandidate && (');
  });

  it('panel shows the bilingual forward-looking message', () => {
    expect(editor).toContain("t('avail_independent_row_note', lang)");
    expect(strings).toContain('avail_independent_row_note');
    expect(strings).toContain('سيتم إنشاء سجل مادة/دفعة مستقل بعد تفعيل هوية الدفعات.');
    expect(strings).toContain('This will create a new independent material/batch row after batch identity is enabled.');
  });

  it('checkbox label matches the required confirmation text exactly', () => {
    expect(strings).toContain('avail_independent_row_confirm_label');
    expect(strings).toContain('أفهم أن هذا سيُنشئ سجلاً مستقلاً جديداً.');
    expect(strings).toContain('I understand this will create a new independent row.');
  });

  it('a bilingual toast message exists for the blocked-without-confirmation case', () => {
    expect(strings).toContain('avail_independent_row_confirm_required');
  });
});

describe('AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-PREP-A: quantity lock applies only to the exact match', () => {
  it('the quantity input is still keyed on isEditMode (exactExistingRow), not on similarProductRows/primarySimilarRow', () => {
    const qtyBlock = enclosingJsxTag(editor, 'id="ed-qty"');
    expect(qtyBlock).toContain('disabled={isEditMode}');
    expect(qtyBlock).toContain('readOnly={isEditMode}');
    expect(qtyBlock).not.toContain('similarProductRows');
    expect(qtyBlock).not.toContain('primarySimilarRow');
    expect(qtyBlock).not.toContain('hasIndependentRowCandidate');
  });

  it('doApply still resends existingRow (exact match) quantity, never a similar row\'s quantity', () => {
    const applyFn = functionBodyAt(editor, 'async function doApply');
    expect(applyFn).toMatch(/quantity:\s*isEditMode \? existingRow!\.quantity : qty/);
    expect(applyFn).not.toContain('primarySimilarRow!.quantity');
  });
});

describe('AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-PREP-A: supply_type/price stay outside independent-row identity', () => {
  it('legacyProductExistingRow / strictExactExistingRow / similarProductRows keys never reference supply_type or price', () => {
    const legacyBlock = balancedBlockAt(editor, 'const legacyProductExistingRow = useMemo');
    const strictBlock = balancedBlockAt(editor, 'const strictExactExistingRow = useMemo');
    const similarBlock = balancedBlockAt(editor, 'const similarProductRows = useMemo');
    expect(legacyBlock).not.toMatch(/r\.supply_type/);
    expect(legacyBlock).not.toMatch(/r\.price/);
    expect(strictBlock).not.toMatch(/r\.supply_type/);
    expect(strictBlock).not.toMatch(/r\.price/);
    expect(similarBlock).not.toMatch(/r\.supply_type/);
    expect(similarBlock).not.toMatch(/r\.price/);
  });

  it('supplyTypeConflict / priceConflict guards are preserved unchanged for the exact-match path', () => {
    expect(editor).toContain('const supplyTypeConflict = isEditMode');
    expect(editor).toContain('const priceConflict = isEditMode');
    expect(editor).toContain('const similarMatchBlocked = isEditMode\n    && (nationalCodeConflict || batchNumberConflict || expiryDateConflict || supplyTypeConflict || priceConflict);');
  });
});

describe('AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-PREP-A: no silent clearing of identity fields', () => {
  it('the auto-populate effect still seeds national_code/batch_number/expiry_date from the exact match only', () => {
    expect(editor).toContain("setNationalCode(existingRow.national_code ?? '')");
    expect(editor).toContain("setBatch(existingRow.batch_number ?? '')");
    expect(editor).toContain("setExpiry(existingRow.expiry_date ?? '')");
  });

  it('the independent-row candidate panel does not auto-populate fields from primarySimilarRow', () => {
    expect(editor).not.toMatch(/setNationalCode\(primarySimilarRow/);
    expect(editor).not.toMatch(/setBatch\(primarySimilarRow/);
    expect(editor).not.toMatch(/setExpiry\(primarySimilarRow/);
  });
});

describe('AVAILABILITY-EDITOR-DUPLICATE-RESOLUTION-B-PREP-A: no out-of-scope changes', () => {
  it('does not create or reference migration 052', () => {
    expect(editor).not.toMatch(/052/);
  });

  it('does not call db push, connect to Supabase directly, or use service_role', () => {
    expect(editor).not.toContain('db push');
    expect(editor).not.toContain('service_role');
  });

  it('does not introduce a new RPC or movement call', () => {
    expect(editor).not.toContain('applyAvailabilityMovement');
    expect(editor).not.toContain('phoenix_apply_availability_movement');
  });

  it('does not modify migration 051 SQL (frontend-only phase)', () => {
    const migration051 = readSrc('../supabase/migrations/051_material_batch_identity_option_a.sql');
    expect(migration051).toContain('MANUAL APPLY ONLY');
    expect(migration051).toContain('Does NOT modify any frontend file');
  });
});

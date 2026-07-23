/**
 * FEFO-REASONED-OVERRIDE (097/102) — frontend contract tests for
 * FefoOverrideDialog, dispatch.service's FEFO wiring, and
 * OutletDispatchComposer's pick/commit/retry flow.
 *
 * Static source-code scans, matching this repo's established convention (no
 * @testing-library/react rendering anywhere in this codebase). No live DB/RPC.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const dialog = readSrc('features/outlet/FefoOverrideDialog.tsx');
const dispatchService = readSrc('features/outlet/dispatch.service.ts');
const composer = readSrc('features/outlet/OutletDispatchComposer.tsx');
const permHook = readSrc('features/inventory/useFefoOverridePermission.ts');
const strings = readSrc('shared/i18n/strings.ts');

describe('A) getFefoAlternatives / addDispatchLine map to the exact 072/097 RPCs', () => {
  it('getFefoAlternatives calls phoenix_inventory_fefo_batches with the exact 072 params', () => {
    expect(dispatchService).toContain("supabase.rpc('phoenix_inventory_fefo_batches'");
    expect(dispatchService).toContain('p_organization_id: organizationId');
    expect(dispatchService).toContain("p_scope_kind: 'warehouse'");
    expect(dispatchService).toContain('p_scope_id: warehouseId');
    expect(dispatchService).toContain('p_scientific_name: scientificName');
    expect(dispatchService).toContain('p_national_code: nationalCode');
  });

  it('addDispatchLine calls phoenix_add_dispatch_line_fefo_guarded with the exact 097 params, never the raw 070 RPC', () => {
    expect(dispatchService).toContain("callRpc('phoenix_add_dispatch_line_fefo_guarded'");
    expect(dispatchService).toContain('p_fefo_override: input.fefoOverride ?? false');
    expect(dispatchService).toContain('p_override_reason: input.overrideReason ?? null');
    // The ONLY add-line call site — the legacy unguarded RPC name must not
    // appear as an actual call anywhere in this file.
    expect(dispatchService).not.toMatch(/callRpc\('phoenix_add_dispatch_line'\)/);
  });
});

describe('B) Earliest-expiry batch is what the dialog and the pick flow treat as canonical', () => {
  it('the dialog derives "earliest" as alternatives[0] — the FIRST entry of the FEFO-ordered list', () => {
    expect(dialog).toContain('const earliest = alternatives[0] ?? null;');
  });

  it('getFefoAlternatives documents/relies on the SAME server order (expiry_date ASC NULLS LAST, id ASC) 097/102 compares against', () => {
    expect(dispatchService).toMatch(/expiry_date ASC NULLS LAST/);
  });

  it('handlePick treats a pick as compliant ONLY when it equals the earliest alternative, prompting otherwise', () => {
    const handlePick = composer.slice(composer.indexOf('const handlePick ='), composer.indexOf('const handleFefoConfirmOverride ='));
    expect(handlePick).toContain('const earliest = alternatives[0] ?? null;');
    expect(handlePick).toContain('if (!earliest || earliest.stockId === candidate.warehouseStockId) {');
  });
});

describe('C) Default behavior fails closed: a non-earliest pick is never silently added', () => {
  it('a non-compliant pick opens the dialog instead of pushing straight to lines', () => {
    const handlePick = composer.slice(composer.indexOf('const handlePick ='), composer.indexOf('const handleFefoConfirmOverride ='));
    expect(handlePick).toContain('setFefoPrompt({ candidate, quantity, alternatives });');
    // The compliant branch pushes to `lines`; the non-compliant branch must
    // NOT also push to `lines` in the same pass — only setFefoPrompt.
    const elseBranch = handlePick.slice(handlePick.indexOf('} else {'));
    expect(elseBranch).not.toContain('setLines(previous => [...previous, draftLineFromStock');
  });

  it('a failed FEFO compliance READ fails closed too — it never falls through to a silent add', () => {
    const handlePick = composer.slice(composer.indexOf('const handlePick ='), composer.indexOf('const handleFefoConfirmOverride ='));
    expect(handlePick).toContain('} catch {');
    const catchBlock = handlePick.slice(handlePick.indexOf('} catch {'));
    expect(catchBlock).not.toContain('setLines(previous => [...previous, draftLineFromStock');
    expect(catchBlock).toContain("setError(t('err_generic', lang));");
  });

  it('the server itself fails closed by default: 097 raises fefo_override_required unless p_fefo_override is explicitly true', () => {
    const migration = readFileSync(join(SRC, '../supabase/migrations/097_phoenix_fefo_reasoned_override.sql'), 'utf8');
    expect(migration).toContain("IF NOT p_fefo_override THEN");
    expect(migration).toContain("RAISE EXCEPTION 'fefo_override_required'");
  });
});

describe('D) The override affordance is gated on inventory.fefo_override, never shown to a denied profile', () => {
  it('useFefoOverridePermission asks the exact scoped permission the RPC checks', () => {
    expect(permHook).toContain("permissionKey: 'inventory.fefo_override'");
    expect(permHook).toContain('warehouseId,');
  });

  it('the hook fails closed with no org, no warehouse, or no profile', () => {
    expect(permHook).toContain('if (!orgId || !warehouseId || !profile?.id) return false;');
  });

  it('the dialog hides the checkbox/reason entirely and shows a denial message when canOverride is false', () => {
    expect(dialog).toContain('{!canOverride ? (');
    expect(dialog).toContain("t('fefo_override_no_permission', lang)");
    const deniedBranch = dialog.slice(dialog.indexOf('{!canOverride ? ('), dialog.indexOf(') : ('));
    expect(deniedBranch).not.toContain('type="checkbox"');
  });

  it('the confirm-override button itself is only rendered when canOverride is true', () => {
    expect(dialog).toContain('{canOverride && (');
    expect(dialog).toContain("t('fefo_confirm_override', lang)");
  });
});

describe('E) Reason is mandatory and whitespace-only is rejected, client and server', () => {
  it('reasonValid requires a non-empty TRIMMED reason', () => {
    expect(dialog).toContain("const reasonValid = reason.trim() !== '';");
  });

  it('the confirm button is disabled until confirmed AND reasonValid', () => {
    expect(dialog).toContain('disabled={!confirmed || !reasonValid}');
  });

  it('handleConfirm refuses to fire the callback on an invalid reason, and trims before sending', () => {
    expect(dialog).toContain('if (!reasonValid) return;');
    expect(dialog).toContain('const r = reason.trim();');
    expect(dialog).toContain('onConfirmOverride(r);');
  });

  it('097 mirrors the same whitespace-only rejection server-side via NULLIF(btrim(...), \'\')', () => {
    const migration = readFileSync(join(SRC, '../supabase/migrations/097_phoenix_fefo_reasoned_override.sql'), 'utf8');
    expect(migration).toContain("v_reason       text := NULLIF(btrim(p_override_reason), '');");
    expect(migration).toContain("IF v_reason IS NULL THEN");
    expect(migration).toContain("RAISE EXCEPTION 'fefo_override_reason_required'");
  });
});

describe('F) Cancelling the dialog performs zero writes', () => {
  it('handleCancel only resets local state and calls onCancel — no RPC, no line push', () => {
    const cancelFn = dialog.slice(dialog.indexOf('function handleCancel()'), dialog.indexOf('function handleConfirm()'));
    expect(cancelFn).toContain('reset();');
    expect(cancelFn).toContain('onCancel();');
    expect(cancelFn).not.toMatch(/addDispatchLine|setLines/);
  });

  it("the composer's onCancel handler for the dialog only clears fefoPrompt — no line is added, no RPC called", () => {
    expect(composer).toContain('onCancel={() => setFefoPrompt(null)}');
  });

  it('closing via the dialog chrome (onClose) routes through the same handleCancel, not a bare onClose', () => {
    expect(dialog).toContain('onClose={handleCancel}');
  });
});

describe('G) Per-line idempotency key is stable across retry, fresh per distinct add', () => {
  it('a compliant pick and a confirmed override both mint the key ONCE via newKey() and reuse it for the override-reason lookup', () => {
    expect(composer).toContain('const key = newKey();');
    expect(composer).toContain('setLines(previous => [...previous, draftLineFromStock(fefoPrompt.candidate, fefoPrompt.quantity, key)]);');
    expect(composer).toContain('setLineOverrides(previous => ({ ...previous, [key]: reason }));');
  });

  it('the commit call reads the override for THIS line by its own idempotencyKey, not a global/last-used reason', () => {
    expect(composer).toContain('fefoOverride: line.idempotencyKey in lineOverrides');
    expect(composer).toContain('overrideReason: lineOverrides[line.idempotencyKey] ?? null');
  });

  it('retryUnsent replays the SAME idempotencyKey → override mapping, not a freshly re-derived one', () => {
    const retryFn = composer.slice(composer.indexOf('const retryUnsent ='), composer.indexOf('const lineStates ='));
    expect(retryFn).toContain('fefoOverride: line.idempotencyKey in lineOverrides');
    expect(retryFn).toContain('overrideReason: lineOverrides[line.idempotencyKey] ?? null');
  });

  it('DEFECT NOTE (documented, not silently accepted): phoenix_add_dispatch_line_fefo_guarded (097) itself takes no ' +
     'request/idempotency id — retry-safety here is ENTIRELY client-side, via movement-commit\'s planRetry ' +
     'content-match reconciliation against canonical server lines, the same documented pattern already used by ' +
     'every other movement composer in this codebase (see movement-commit.ts).', () => {
    const addLineFn = dispatchService.slice(
      dispatchService.indexOf('export function addDispatchLine'),
      dispatchService.indexOf('export interface FefoBatch'),
    );
    expect(addLineFn).not.toMatch(/p_request_id/);
    const movementCommit = readSrc('features/movement/movement-commit.ts');
    expect(movementCommit).toContain('`phoenix_add_*_line` has no idempotency token');
    expect(composer).toContain("import { commitDraft, planRetry");
  });
});

describe('H) Audit trail: 097 records before/after batch identity + actor/time on an override', () => {
  it('the RPC writes an audit_logs row only on the override path, with before/after stock and reason', () => {
    const migration = readFileSync(join(SRC, '../supabase/migrations/097_phoenix_fefo_reasoned_override.sql'), 'utf8');
    expect(migration).toContain("'inventory.fefo_overridden'");
    expect(migration).toContain('before_fefo_stock_id');
    expect(migration).toContain('after_chosen_stock_id');
    expect(migration).toContain("'reason', v_reason");
  });

  it('the FEFO-compliant (no override) path is explicitly audit-silent — no forced audit_logs write', () => {
    const migration = readFileSync(join(SRC, '../supabase/migrations/097_phoenix_fefo_reasoned_override.sql'), 'utf8');
    expect(migration).toContain('no override machinery, no audit noise');
  });
});

describe('I) AR/EN and RTL/LTR rendering', () => {
  it('every fefo_* string key has both an ar and an en translation', () => {
    const keys = [
      'fefo_override_title', 'fefo_override_warning', 'fefo_picked_batch', 'fefo_alternatives_title',
      'fefo_no_alternatives', 'fefo_use_this_batch', 'fefo_override_no_permission',
      'fefo_confirm_override_checkbox', 'fefo_override_reason_label', 'fefo_override_reason_required',
      'fefo_confirm_override',
    ];
    for (const key of keys) {
      const re = new RegExp(`${key}:\\s*\\{[^}]*ar:[^}]*en:[^}]*\\}`);
      expect(strings, `missing bilingual entry for ${key}`).toMatch(re);
    }
  });

  it('material identity (scientific name, reason input) is dir="auto" — language-direction follows content', () => {
    expect(dialog).toMatch(/dir="auto">\{picked\.scientificName\}/);
    expect(dialog).toContain('id="fefo-reason" type="text" dir="auto"');
  });

  it('batch/expiry identifiers (numeric/date, not prose) are forced dir="ltr" regardless of UI language', () => {
    const pickedBatchBlock = dialog.slice(dialog.indexOf("{t('fefo_picked_batch'") - 80, dialog.indexOf("{t('fefo_picked_batch'"));
    expect(pickedBatchBlock).toContain('dir="ltr"');
    const alternativesBlock = dialog.slice(dialog.indexOf('data-testid="fefo-alternatives"'), dialog.indexOf('data-testid="fefo-alternatives"') + 400);
    expect(alternativesBlock).toContain('dir="ltr"');
  });
});

describe('J) Loading / error / denied / conflict states', () => {
  it('the material picker shows a busy state while the FEFO compliance check is in flight', () => {
    expect(composer).toContain('loading={stockLoading || fefoCheckBusy}');
    expect(composer).toContain('setFefoCheckBusy(true);');
    expect(composer).toContain('setFefoCheckBusy(false);');
  });

  it('handlePick refuses re-entry while a check is already busy (no overlapping picks)', () => {
    expect(composer).toContain('if (!activeOrgId || fefoCheckBusy) return;');
  });

  it('a failed compliance read surfaces the generic error banner distinctly from a denied/conflict state', () => {
    expect(composer).toContain("setError(t('err_generic', lang));");
  });

  it('denied state: canOverride=false renders fefo_override_no_permission, distinct from every other message', () => {
    expect(dialog).toContain("t('fefo_override_no_permission', lang)");
  });

  it('a conflict at commit time (server rejects despite a passed client preflight) is surfaced per-line via the existing partial-failure UI, not swallowed', () => {
    expect(composer).toContain('data-testid="outlet-dispatch-partial-failure"');
    expect(composer).toContain('result?.partial');
    expect(composer).toContain('lineStates={lineStates}');
  });
});

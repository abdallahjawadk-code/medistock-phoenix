/**
 * SECOND-PERSON-CORRECTION-APPROVAL (098 outlet, 101 warehouse) — frontend
 * contract tests for PendingCorrectionsPanel, the two request/approve/reject
 * service wrappers, and their wiring into InventoryCenterScreen.
 *
 * Static source-code scans, matching this repo's established convention (no
 * @testing-library/react rendering anywhere in this codebase — see
 * admin/__tests__/availability-cleanup-wizard.test.ts). No live DB/RPC.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { classifyCorrectionDecisionError } from '@/features/outlet/outlet-stock.service';
import { classifyIntakeError } from '@/features/inventory/warehouse-intake.service';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const panel = readSrc('features/inventory/PendingCorrectionsPanel.tsx');
const screen = readSrc('features/inventory/InventoryCenterScreen.tsx');
const outletService = readSrc('features/outlet/outlet-stock.service.ts');
const warehouseService = readSrc('features/inventory/warehouse-intake.service.ts');
const strings = readSrc('shared/i18n/strings.ts');

describe('A) Panel displays the full before/after/delta/reason/batch/source shape', () => {
  it('renders before, after, and variance for every row', () => {
    expect(panel).toMatch(/t\('cor_before', lang\)\}: \{row\.before\}/);
    expect(panel).toMatch(/t\('cor_after', lang\)\}: \{row\.after\}/);
    expect(panel).toMatch(/t\('cor_variance', lang\)\}: \{row\.variance\}/);
  });

  it('renders reason, batch/expiry, and who proposed it', () => {
    expect(panel).toContain("t('cor_reason', lang)");
    expect(panel).toContain('row.batchNumber, row.expiryDate');
    expect(panel).toContain("t('cor_proposed_by', lang)");
    expect(panel).toContain('row.proposedByName ?? row.proposedBy');
  });

  it('normalizes BOTH scopes (outlet 098, warehouse 101) into one shared shape and labels the source', () => {
    expect(panel).toContain("scope: 'outlet'");
    expect(panel).toContain("scope: 'warehouse'");
    expect(panel).toContain("t(row.scope === 'outlet' ? 'cor_scope_outlet' : 'cor_scope_warehouse', lang)");
  });
});

describe('B) Approve/reject are never available to the proposer themselves', () => {
  it('computes isOwnRequest by profile identity, not role', () => {
    expect(panel).toContain('const isOwnRequest = profile?.id === row.proposedBy;');
  });

  it('shows a notice instead of action buttons when isOwnRequest', () => {
    expect(panel).toMatch(/isOwnRequest \? \(\s*<p[^>]*>\{t\('cor_own_request_notice', lang\)\}<\/p>/);
  });

  it('approve/reject buttons are only reachable in the non-own-request branch', () => {
    const ownBranch = panel.slice(panel.indexOf('isOwnRequest ? ('), panel.indexOf(') : rejectingId'));
    expect(ownBranch).not.toContain("onClick={() => void approve(row)}");
  });
});

describe('C) Approve/reject call the exact 098/101 RPCs and check ok before declaring success', () => {
  it('approveOutletStockCorrection calls phoenix_approve_outlet_stock_correction with generation guard', () => {
    expect(outletService).toContain("supabase.rpc('phoenix_approve_outlet_stock_correction'");
    expect(outletService).toContain('p_expected_generation: expectedGeneration');
  });

  it('rejectOutletStockCorrection calls phoenix_reject_outlet_stock_correction and requires a reason', () => {
    expect(outletService).toContain("supabase.rpc('phoenix_reject_outlet_stock_correction'");
    expect(outletService).toContain('p_decision_reason: decisionReason');
  });

  it('approveWarehouseStockCorrection / rejectWarehouseStockCorrection call the 101 RPCs', () => {
    expect(warehouseService).toContain("'phoenix_approve_warehouse_stock_correction'");
    expect(warehouseService).toContain("'phoenix_reject_warehouse_stock_correction'");
  });

  // Regression guard: outlet-stock.service throws on RPC failure, but
  // warehouse-intake.service's callRpc() RESOLVES { ok: false, error }
  // instead. The panel must check `.ok` explicitly on the warehouse branch
  // of BOTH approve and reject — an unchecked resolve would silently show
  // "approved"/"rejected" on a failed, self-authored, or stale decision.
  it('approve() checks result.ok before showing the success toast', () => {
    const approveBody = panel.slice(panel.indexOf('const approve = async'), panel.indexOf('const reject = async'));
    expect(approveBody).toContain('if (result.ok) {');
    expect(approveBody).toContain("showToast(t('cor_approved_ok', lang));");
  });

  it('reject() checks result.ok on the warehouse branch before showing the success toast', () => {
    const rejectBody = panel.slice(panel.indexOf('const reject = async'), panel.indexOf('if (loading && rows === null)'));
    expect(rejectBody).toContain('const result = await rejectWarehouseStockCorrection(');
    expect(rejectBody).toContain('if (!result.ok) {');
    // The unconditional-toast regression this guards against: showing
    // 'cor_rejected_ok' must be reachable only AFTER the ok-check above it,
    // not immediately after the two RPC calls.
    const okCheckIdx = rejectBody.indexOf('if (!result.ok) {');
    const successToastIdx = rejectBody.indexOf("t('cor_rejected_ok', lang)");
    expect(okCheckIdx).toBeGreaterThan(-1);
    expect(successToastIdx).toBeGreaterThan(okCheckIdx);
  });

  it('reject reason must be non-empty before the RPC is even attempted', () => {
    expect(panel).toContain("if (!rejectReason.trim()) return;");
    expect(panel).toContain('disabled={busy || !rejectReason.trim()}');
  });
});

describe('D) Stale-generation / self-approval / already-decided produce distinguishable messages', () => {
  it('outlet classifier distinguishes generation conflict, self-approval, forbidden, and not-pending', () => {
    expect(classifyCorrectionDecisionError({ code: '40001', message: 'outlet_stock_generation_conflict' }))
      .toBe('outlet_correct_generation_conflict');
    expect(classifyCorrectionDecisionError({ message: 'proposer_cannot_approve_own_correction' }))
      .toBe('correction_proposer_cannot_approve');
    expect(classifyCorrectionDecisionError({ message: 'forbidden_correction_approval' }))
      .toBe('correction_forbidden_approval');
    expect(classifyCorrectionDecisionError({ message: 'correction_request_not_pending' }))
      .toBe('correction_not_pending');
  });

  // Regression guard: before this pass, classifyIntakeError had no mapping
  // for the 101 approve/reject vocabulary at all — a self-approval or
  // already-decided failure on the WAREHOUSE scope fell through to the
  // generic message instead of a distinguishable one.
  it('warehouse classifier (classifyIntakeError) now distinguishes the same 101 vocabulary', () => {
    expect(classifyIntakeError('proposer_cannot_approve_own_correction')).toBe('correction_proposer_cannot_approve');
    expect(classifyIntakeError('forbidden_correction_approval')).toBe('correction_forbidden_approval');
    expect(classifyIntakeError('correction_request_not_pending')).toBe('correction_not_pending');
    expect(classifyIntakeError('correction_request_not_found')).toBe('correction_not_found');
    expect(classifyIntakeError('decision_reason_required')).toBe('correction_reason_required');
    expect(classifyIntakeError('warehouse_receipt_generation_conflict')).toBe('inv_err_generation_conflict');
  });

  it('every mapped key exists in the bilingual string table', () => {
    const tokens = [
      'proposer_cannot_approve_own_correction', 'forbidden_correction_approval',
      'correction_request_not_pending', 'correction_request_not_found', 'decision_reason_required',
    ];
    for (const token of tokens) {
      const key = classifyIntakeError(token);
      expect(strings, `missing i18n key ${key} for token ${token}`).toContain(`${key}:`);
    }
  });
});

describe('E) Cross-org isolation relies on RLS-scoped reads, never a client-side org filter', () => {
  it('listPendingOutletCorrections / listPendingWarehouseCorrections select with no organization_id filter — RLS is the only boundary', () => {
    const outletList = outletService.slice(
      outletService.indexOf('export async function listPendingOutletCorrections'),
      outletService.indexOf('export interface CorrectionDecisionResult'),
    );
    expect(outletList).toContain("from('phoenix_stock_correction_requests')");
    expect(outletList).not.toMatch(/\.eq\('organization_id'/);

    const warehouseList = warehouseService.slice(
      warehouseService.indexOf('export async function listPendingWarehouseCorrections'),
      warehouseService.indexOf('export interface CorrectionDecisionResult'),
    );
    expect(warehouseList).toContain("from('phoenix_warehouse_correction_requests')");
    expect(warehouseList).not.toMatch(/\.eq\('organization_id'/);
  });
});

describe('F) Permission gating is org-wide (098/101 check phoenix_status_center_authorized), never resource-scoped', () => {
  it('InventoryCenterScreen resolves both approval keys via useApproveCorrectionPermission and gates the tab on either', () => {
    expect(screen).toContain("useApproveCorrectionPermission(activeOrgId, 'outlet_stock.approve_correction')");
    expect(screen).toContain("useApproveCorrectionPermission(activeOrgId, 'warehouse_stock.approve_correction')");
    expect(screen).toContain('canApproveOutletCorrection || canApproveWarehouseCorrection');
    expect(screen).toContain("tab === 'corrections' && canApproveAnyCorrection");
  });

  it('the panel receives BOTH scoped booleans, not a single collapsed flag', () => {
    expect(screen).toMatch(/<PendingCorrectionsPanel\s+canApproveOutlet=\{canApproveOutletCorrection\}\s+canApproveWarehouse=\{canApproveWarehouseCorrection\}\s*\/>/);
  });
});

describe('G) No UI path mutates outlet_stock/warehouse_stock quantities outside request+approve', () => {
  it('InventoryCenterScreen never calls the bare guarded correction RPCs directly for movementType correction', () => {
    const correctionBlock = screen.slice(
      screen.indexOf("if (movementType === 'correction') {"),
      screen.indexOf("const result = await applyWarehouseStockMovement({"),
    );
    expect(correctionBlock).toContain('requestWarehouseStockCorrection(');
    expect(correctionBlock).not.toContain('phoenix_apply_warehouse_stock_movement_guarded');
  });

  it('neither service writes outlet_stock/warehouse_stock via a table client directly', () => {
    for (const source of [outletService, warehouseService, panel]) {
      expect(source).not.toMatch(/from\('warehouse_stock'\)\s*[\s\S]{0,120}\.(insert|update|upsert|delete)\(/);
      expect(source).not.toMatch(/from\('outlet_stock'\)\s*[\s\S]{0,120}\.(insert|update|upsert|delete)\(/);
    }
  });

  it('no source under src/ calls a correction-shaped RPC other than the 098/101 request/approve/reject set', () => {
    // A allow-list scan: any call site naming an *_stock_correction* or
    // *_correction_* RPC must be one of the six names 098/101 actually
    // define. A stray direct write (e.g. re-adding a call to the bare
    // guarded RPC for 'correction') would show up here as an unrecognized name.
    const allowed = new Set([
      'phoenix_request_outlet_stock_correction', 'phoenix_approve_outlet_stock_correction', 'phoenix_reject_outlet_stock_correction',
      'phoenix_request_warehouse_stock_correction', 'phoenix_approve_warehouse_stock_correction', 'phoenix_reject_warehouse_stock_correction',
      // Read-only SELECT tables, not RPCs — matched by the same regex, not a
      // mutation entry point.
      'phoenix_stock_correction_requests', 'phoenix_warehouse_correction_requests',
    ]);
    const root = join(SRC);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const text = readFileSync(full, 'utf8');
        const matches = text.match(/phoenix_\w*correction\w*/g) ?? [];
        for (const m of matches) {
          if (!allowed.has(m)) offenders.push(`${full}: ${m}`);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

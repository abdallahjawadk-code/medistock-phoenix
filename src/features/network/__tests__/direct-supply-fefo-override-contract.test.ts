/**
 * D1B-3 — FEFO-REASONED-OVERRIDE (097/102/150) frontend contract tests for
 * Route 1's (central warehouse -> institution warehouse) direct-supply send.
 *
 * 150's phoenix_send_direct_warehouse_transfer_line_fefo_guarded already
 * accepted p_fefo_override/p_override_reason server-side; before this phase
 * no frontend code ever called it or the routed sibling — every Route 1 send
 * called the BASE (non-guarded) RPC with no override path reachable at all.
 * This reuses Route 2's existing FefoOverrideDialog / useFefoOverridePermission
 * verbatim (both already generic, not outlet-specific) rather than building a
 * second override UI. Mirrors fefo-override-contract.test.ts's own category
 * structure, adapted for Route 1's dropdown+separate-send-button shape
 * (Route 2 prompts at PICK time; Route 1 prompts at SEND-click time, since
 * picking a batch from the dropdown commits nothing by itself).
 *
 * Static source-code scans, matching this repo's established convention (no
 * @testing-library/react rendering anywhere in this codebase). No live DB/RPC.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const networkService = readSrc('features/network/network.service.ts');
const screen = readSrc('features/network/DirectSupplyOperations.tsx');
const permHook = readSrc('features/inventory/useFefoOverridePermission.ts');

describe('A) sendDirectTransferLine calls the exact 150 guarded RPC, never the base one', () => {
  it('calls phoenix_send_direct_warehouse_transfer_line_fefo_guarded with p_fefo_override/p_override_reason', () => {
    expect(networkService).toContain("callRpc('phoenix_send_direct_warehouse_transfer_line_fefo_guarded'");
    expect(networkService).toContain('p_fefo_override: input.fefoOverride ?? false');
    expect(networkService).toContain('p_override_reason: input.overrideReason ?? null');
  });

  it('the base (unguarded) RPC name is never called anywhere in this file', () => {
    expect(networkService).not.toMatch(/callRpc\('phoenix_send_direct_warehouse_transfer_line'\)/);
  });

  it('every other RPC parameter is passed through unchanged from the pre-existing contract', () => {
    const fn = networkService.slice(networkService.indexOf('export function sendDirectTransferLine'));
    for (const p of ['p_request_id', 'p_transfer_request_id', 'p_warehouse_stock_id', 'p_quantity', 'p_transfer_number', 'p_transfer_request_line_id', 'p_document_number', 'p_notes']) {
      expect(fn.slice(0, fn.indexOf('});'))).toContain(p);
    }
  });
});

describe('B) Route 1 reuses Route 2s dialog and permission hook verbatim — no second override UI', () => {
  it('imports FefoOverrideDialog and useFefoOverridePermission from their existing outlet/inventory homes', () => {
    expect(screen).toContain("import { FefoOverrideDialog } from '@/features/outlet/FefoOverrideDialog';");
    expect(screen).toContain("import { useFefoOverridePermission } from '@/features/inventory/useFefoOverridePermission';");
  });

  it('imports getFefoAlternatives/FefoBatch from dispatch.service.ts rather than duplicating the 072 read', () => {
    expect(screen).toContain("import { getFefoAlternatives, type FefoBatch } from '@/features/outlet/dispatch.service';");
  });

  it('no second FEFO dialog component is defined in this file', () => {
    expect(screen).not.toMatch(/function\s+\w*FefoOverride\w*Dialog/);
  });
});

describe('C) Default behavior fails closed: a non-earliest pick is never silently sent', () => {
  it('handleSendClick checks alternatives and only sends directly when the pick IS the earliest', () => {
    const fn = screen.slice(screen.indexOf('const handleSendClick ='), screen.indexOf('return (', screen.indexOf('const handleSendClick =')));
    expect(fn).toContain('const earliest = alternatives[0] ?? null;');
    expect(fn).toContain("if (earliest !== null && earliest.stockId !== picked.id) {");
    expect(fn).toContain('setFefoPrompt({');
    // The non-compliant branch returns BEFORE reaching doSend — it must not
    // fall through to a send in the same pass.
    const nonCompliantBranch = fn.slice(fn.indexOf('if (earliest !== null'), fn.indexOf('await doSend(false, null);'));
    expect(nonCompliantBranch).toContain('return;');
    expect(nonCompliantBranch).not.toContain('doSend(');
  });

  it('a failed FEFO-alternatives read fails closed too — falls through to the servers own gate, never bypasses it client-side', () => {
    const fn = screen.slice(screen.indexOf('const handleSendClick ='), screen.indexOf('return (', screen.indexOf('const handleSendClick =')));
    expect(fn).toContain('} catch { /* fail open to the RPC');
    // Even on a failed read, doSend is called with fefoOverride=false — the
    // guarded RPC (150) itself still enforces FEFO server-side regardless.
    expect(fn).toContain('await doSend(false, null);');
  });

  it("150's own gate raises fefo_revalidation_required unless p_fefo_override is explicitly true", () => {
    const migration = readSrc('../supabase/migrations/150_phoenix_material_identity_fefo_provenance_hardening.sql');
    expect(migration).toContain("IF NOT COALESCE(p_fefo_override,false) THEN");
    expect(migration).toContain("RAISE EXCEPTION 'fefo_revalidation_required'");
  });
});

describe('D) The override affordance is gated on inventory.fefo_override, scoped to the SOURCE (central) warehouse', () => {
  it('useFefoOverridePermission is called with the transfer requests own source organization/warehouse', () => {
    expect(screen).toContain('useFefoOverridePermission(organizationId, warehouseId)');
  });

  it('organizationId/warehouseId are threaded down from the request (never a guessed/hardcoded id)', () => {
    expect(screen).toContain('organizationId={request.sourceOrganizationId} warehouseId={request.sourceWarehouseId}');
  });

  it('the permission hook asks the exact scoped key 150s guard checks, kind-agnostic (works for a central warehouse)', () => {
    expect(permHook).toContain("permissionKey: 'inventory.fefo_override'");
    expect(permHook).toContain('warehouseId,');
  });

  it('central_warehouse_manager (the Route 1 sender role) already defaults to allowed for this key (102)', () => {
    const migration102 = readSrc('../supabase/migrations/102_phoenix_transfer_send_fefo_guarded.sql');
    expect(migration102).toMatch(/central_warehouse_manager.*inventory\.fefo_override|inventory\.fefo_override.*central_warehouse_manager/s);
  });
});

describe('E) Reason is mandatory client and server side (dialog contract already proven in fefo-override-contract.test.ts)', () => {
  it('onConfirmOverride is wired straight to doSend(true, reason) — the dialog itself already refuses an empty/whitespace reason', () => {
    expect(screen).toContain("onConfirmOverride={(reason) => { setFefoPrompt(null); void doSend(true, reason); }}");
  });

  it("150's worker mirrors the same mandatory-reason rejection server-side", () => {
    const migration = readSrc('../supabase/migrations/150_phoenix_material_identity_fefo_provenance_hardening.sql');
    expect(migration).toContain("RAISE EXCEPTION 'fefo_override_reason_required'");
  });
});

describe('F) Cancelling the dialog performs zero writes', () => {
  it('onCancel only clears the local prompt state — no doSend call', () => {
    expect(screen).toContain('onCancel={() => setFefoPrompt(null)}');
  });

  it('onUseAlternative only switches the picker selection — it does not send by itself', () => {
    expect(screen).toContain("onUseAlternative={(stockIdToUse) => { setFefoPrompt(null); setStockId(stockIdToUse); }}");
  });
});

describe('G) doSend always forwards fefoOverride/overrideReason through the shared idempotent runner', () => {
  it('writeTransferSends payload type carries fefoOverride/overrideReason, folded into the derived token via canonicalIntent (stock-mutation-runner.ts)', () => {
    const writer = screen.slice(screen.indexOf('const writeTransferSend:'), screen.indexOf('const writeTransferReceive:'));
    expect(writer).toContain('fefoOverride?: boolean; overrideReason?: string | null;');
  });

  it('doSend passes fefoOverride/overrideReason as part of the mutation payload, not as separate untracked state', () => {
    const doSend = screen.slice(screen.indexOf('const doSend ='), screen.indexOf('const handleSendClick ='));
    expect(doSend).toContain('fefoOverride, overrideReason,');
  });

  it('the compliant (non-override) path explicitly passes fefoOverride=false, overrideReason=null — never omitted/undefined', () => {
    expect(screen).toContain('await doSend(false, null);');
  });
});

describe('H) Loading/busy state prevents overlapping FEFO checks or double-sends', () => {
  it('the Send button is disabled while a check/send is in flight', () => {
    const button = screen.slice(screen.indexOf("<PhoenixButton size=\"sm\" loading={busy} disabled={!canSend} onClick={() => void handleSendClick()}>"));
    expect(button.slice(0, 120)).toContain('loading={busy}');
  });

  it('handleSendClick sets busy around the async FEFO-alternatives read, not just around the eventual send', () => {
    const fn = screen.slice(screen.indexOf('const handleSendClick ='), screen.indexOf('return (', screen.indexOf('const handleSendClick =')));
    expect(fn).toContain('setBusy(true);');
    expect(fn.indexOf('setBusy(true);')).toBeLessThan(fn.indexOf('getFefoAlternatives('));
  });
});

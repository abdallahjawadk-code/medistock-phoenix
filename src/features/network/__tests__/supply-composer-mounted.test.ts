/**
 * W077-COMPOSER — the draft-first DirectSupplyComposer is the ONE reachable
 * forward create-authoring entry inside the already-mounted operational surface.
 *
 * This is a SURGICAL in-place replacement, not a parallel mount: the composer
 * owns the "new request" action, hands the created request off to the existing
 * lifecycle container (submit/review/send/receive is unchanged), and commits
 * through the SAME lifecycle RPCs — there is never a second writer.
 *
 * Static source assertions, matching the established repo convention (no React
 * test renderer is wired up in this project).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const NET = join(__dirname, '..');
const MOVE = join(__dirname, '..', '..', 'movement');
const read = (base: string, rel: string) => readFileSync(join(base, rel), 'utf8');

const operations = read(NET, 'DirectSupplyOperations.tsx');
const composer = read(MOVE, 'DirectSupplyComposer.tsx');
const returnComposer = read(MOVE, 'DirectReturnComposer.tsx');
const incoming = read(MOVE, 'InstitutionIncomingSupplies.tsx');

describe('composer is mounted as the forward create entry', () => {
  it('imports and renders DirectSupplyComposer in the operational surface', () => {
    expect(operations).toMatch(/import \{ DirectSupplyComposer \} from '@\/features\/movement\/DirectSupplyComposer'/);
    expect(operations).toMatch(/<DirectSupplyComposer/);
  });

  it('gates the composer behind the FORWARD_CREATE.draftFirst rollback switch', () => {
    expect(operations).toMatch(/const FORWARD_CREATE = \{ draftFirst: true \}/);
    expect(operations).toMatch(/creating && FORWARD_CREATE\.draftFirst/);
  });

  it('feeds the composer scoped central sources and institution destinations', () => {
    expect(operations).toMatch(/warehouseKind === 'central' && w\.status === 'active'/);
    expect(operations).toMatch(/warehouseKind === 'institution' && w\.status === 'active'/);
    expect(operations).toMatch(/sourceWarehouses=\{sourceWarehouses\}/);
    expect(operations).toMatch(/destinationWarehouses=\{destinationParties\}/);
  });
});

describe('exactly one reachable create path — no parallel/duplicate flow', () => {
  it('the legacy ForwardCreateForm is only reachable when the switch is OFF', () => {
    // The legacy form is retained for rollback, but never renders alongside the
    // composer: it is guarded by the negation of the same switch.
    expect(operations).toMatch(/creating && !FORWARD_CREATE\.draftFirst && \(\s*<ForwardCreateForm/);
    // And there is exactly one <ForwardCreateForm render site (the guarded one).
    expect(operations.match(/<ForwardCreateForm/g)?.length).toBe(1);
  });

  it('hands the created request to the existing lifecycle container (setOpenId)', () => {
    expect(operations).toMatch(/onCreated=\{\(requestId\) => \{/);
    expect(operations).toMatch(/setOpenId\(requestId\)/);
  });
});

describe('the composer commits through the SAME lifecycle RPCs (one writer)', () => {
  it('persists only via createDirectTransferRequest + addTransferRequestLine', () => {
    expect(composer).toMatch(/createDirectTransferRequest\(/);
    expect(composer).toMatch(/addTransferRequestLine\(/);
    // No direct stock-table writes and no privileged client.
    expect(composer).not.toMatch(/service_role/);
    expect(composer).not.toMatch(/\.from\(['"]warehouse_stock['"]\)/);
  });

  it('reads canonical central stock for the material picker (never invents it)', () => {
    expect(composer).toMatch(/getWarehouseStock\(/);
  });
});

describe('return composer is mounted as the return create entry (one writer)', () => {
  it('imports and renders DirectReturnComposer behind its rollback switch', () => {
    expect(operations).toMatch(/import \{ DirectReturnComposer \} from '@\/features\/movement\/DirectReturnComposer'/);
    expect(operations).toMatch(/<DirectReturnComposer/);
    expect(operations).toMatch(/const RETURN_CREATE = \{ draftFirst: true \}/);
    expect(operations).toMatch(/creating && RETURN_CREATE\.draftFirst/);
  });

  it('the legacy ReturnCreateForm is only reachable when the switch is OFF', () => {
    expect(operations).toMatch(/creating && !RETURN_CREATE\.draftFirst && \(\s*<ReturnCreateForm/);
    expect(operations.match(/<ReturnCreateForm/g)?.length).toBe(1);
  });

  it('hands the created return to the existing lifecycle container (setOpenId)', () => {
    expect(operations).toMatch(/onCreated=\{\(returnRequestId\) => \{/);
  });

  it('persists only via the return lifecycle RPCs and keeps BOTH modes', () => {
    expect(returnComposer).toMatch(/requestDirectReturn\(/);
    expect(returnComposer).toMatch(/recallDirectTransfer\(/);
    expect(returnComposer).toMatch(/addDirectReturnLine\(/);
  });

  it('anchors every line to original provenance — never free-text identity', () => {
    expect(returnComposer).toMatch(/originalTransferLineId: line\.originalTransferLineId as string/);
    expect(returnComposer).toMatch(/computeProvenanceCaps\(/);
    expect(returnComposer).not.toMatch(/service_role/);
  });
});

describe('receive section upgraded in place to InstitutionIncomingSupplies', () => {
  it('imports and renders InstitutionIncomingSupplies behind its rollback switch', () => {
    expect(operations).toMatch(/import \{ InstitutionIncomingSupplies \} from '@\/features\/movement\/InstitutionIncomingSupplies'/);
    expect(operations).toMatch(/<InstitutionIncomingSupplies/);
    expect(operations).toMatch(/const RECEIVE_UPGRADE = \{ enabled: true \}/);
    expect(operations).toMatch(/RECEIVE_UPGRADE\.enabled \?/);
  });

  it('legacy per-transfer IncomingTransferRow renders ONLY when the switch is OFF', () => {
    // Exactly one render site, inside the !enabled branch below the ternary.
    expect(operations.match(/<IncomingTransferRow/g)?.length).toBe(1);
  });

  it('the Network Supply tab is a READ-ONLY monitor — the sender cannot receive', () => {
    // §1: this tab is gated on warehouse_transfer.send; receiving belongs to the
    // institution officer, so here the incoming section can never mutate.
    expect(operations).toMatch(/const canReceive = false/);
    expect(operations).toMatch(/canReceive=\{canReceive\}/);
  });

  it('the incoming surface imports/renders NO material picker, OCR or create RPC', () => {
    // Assert the absence of real wiring (imports / JSX / RPC calls), not the
    // prose — the file's own docstring names these to say it deliberately omits them.
    expect(incoming).not.toMatch(/import[^\n]*StockMaterialPicker/);
    expect(incoming).not.toMatch(/<StockMaterialPicker/);
    expect(incoming).not.toMatch(/from '@\/features\/inventory\/ocr/);
    expect(incoming).not.toMatch(/addTransferRequestLine\(|createDirectTransferRequest\(/);
  });

  it('receives only via receiveTransferLine, under a DERIVED idempotency token', () => {
    expect(incoming).toMatch(/receiveTransferLine\(/);
    // A minted token makes each retry a new operation and double-posts stock
    // whenever a success response is lost; a derived one also survives the page
    // reload that most often prompts the retry. Behaviour is proven in
    // shared/lib/__tests__/stock-mutation-runner.test.ts.
    expect(incoming).not.toMatch(/requestId: newRequestId\(\)/);
    expect(incoming).toMatch(/runStockMutation\(writeReceive, RECEIVE_KIND/);
    expect(incoming).toMatch(/generation: line\.receivedQuantity \?\? 0/);
    // Stock is shown only after a canonical server reload — never optimistically.
    expect(incoming).toMatch(/await reload\(\)/);
  });
});

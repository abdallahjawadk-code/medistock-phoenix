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

/**
 * MOVEMENT-COMPOSER-A — structural contract of the Direct Supply composer.
 *
 * Source-scanned in the house style of this repo. The point is that the "no RPC
 * before confirmation" guarantee is verifiable by reading the file, not merely
 * by trusting a rendered click path: if a future edit moves a create/add-line
 * call out of the confirm handler, this fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const composer = readFileSync(join(ROOT, 'src', 'features', 'movement', 'DirectSupplyComposer.tsx'), 'utf8');
const picker = readFileSync(join(ROOT, 'src', 'features', 'movement', 'ui', 'StockMaterialPicker.tsx'), 'utf8');
const shell = readFileSync(join(ROOT, 'src', 'features', 'movement', 'ui', 'MovementComposerShell.tsx'), 'utf8');
const party = readFileSync(join(ROOT, 'src', 'features', 'movement', 'ui', 'MovementPartySelector.tsx'), 'utf8');

/** Body of a named function/arrow in the composer, for call-site scoping. */
function bodyOf(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `declaration not found: ${declaration}`).toBeGreaterThan(-1);
  return source.slice(start, start + 2600);
}

describe('no persistence before explicit confirmation', () => {
  it('calls createDirectTransferRequest exactly once in the file', () => {
    expect(composer.match(/createDirectTransferRequest\(/g) ?? []).toHaveLength(1);
  });

  it('that single create call lives inside confirmAndCreate', () => {
    expect(bodyOf(composer, 'const confirmAndCreate')).toContain('createDirectTransferRequest(');
  });

  it('confirmAndCreate refuses to run unless the draft is confirmable', () => {
    expect(bodyOf(composer, 'const confirmAndCreate')).toMatch(/if \(!confirmable \|\| committing\) return;/);
  });

  it('neither the parties nor the materials step can reach a create/add-line call', () => {
    // Everything before the confirm handler is composition only.
    const beforeConfirm = composer.slice(0, composer.indexOf('const confirmAndCreate'));
    expect(beforeConfirm).not.toContain('createDirectTransferRequest(');
    expect(beforeConfirm).not.toContain('addTransferRequestLine(');
  });

  it('the material picker performs NO writes at all', () => {
    for (const forbidden of ['createDirectTransferRequest', 'addTransferRequestLine', 'sendDirectTransferLine', 'receiveWarehouseStock', 'supabase']) {
      expect(picker, forbidden).not.toContain(forbidden);
    }
  });

  it('the shell and party selector perform NO writes at all', () => {
    for (const source of [shell, party]) {
      expect(source).not.toMatch(/supabase|\.rpc\(|createDirect|addTransfer|sendDirect/);
    }
  });

  it('cancel is wired to the caller and triggers no RPC of its own', () => {
    expect(composer).toContain('onCancel={onCancel}');
    expect(bodyOf(shell, 'export function MovementComposerShell')).not.toMatch(/\.rpc\(|createDirect|addTransfer/);
  });

  it('the composer never calls the OCR intake write path', () => {
    // receiveWarehouseStock belongs to the Inventory Center intake, not here.
    expect(composer).not.toContain('receiveWarehouseStock');
  });
});

describe('material identity is a stable id, never free text', () => {
  it('the picker exposes no free-text material identity input', () => {
    expect(picker).not.toMatch(/setScientificName|scientificName["']?\s*[=:]\s*(?:typed|input|query)/);
  });

  it('draft lines are built from an authoritative stock row', () => {
    expect(composer).toContain('draftLineFromStock(');
  });

  it('the composer carries centralItemId through to the RPC', () => {
    expect(bodyOf(composer, 'const confirmAndCreate')).toContain('centralItemId: line.centralItemId');
  });
});

describe('stale stock is revalidated before creation', () => {
  it('entering review re-fetches warehouse stock', () => {
    const body = bodyOf(composer, 'const enterReview');
    expect(body).toContain('getWarehouseStock(');
    expect(body).toContain('revalidateAgainstFreshStock(');
  });
});

describe('partial failure is recoverable and never duplicates', () => {
  it('retry reloads the canonical server lines before re-sending', () => {
    const body = bodyOf(composer, 'const retryUnsent');
    expect(body).toContain('getTransferRequestLines(');
    expect(body).toContain('planRetry(');
  });

  it('retry never creates a second header', () => {
    const body = bodyOf(composer, 'const retryUnsent');
    // The header factory resolves the EXISTING id rather than calling create.
    expect(body).toContain('createHeader: () => Promise.resolve({ ok: true, data: { id: result.requestId as string } })');
    expect(body).not.toContain('createDirectTransferRequest(');
  });

  it('a partial result is surfaced, not swallowed', () => {
    expect(composer).toContain('data-testid="supply-partial-failure"');
    expect(composer).toContain('mv_retry_unsent');
  });
});

describe('operator-typed numbers are never presented as serials', () => {
  it('the reference field is labelled as an external reference with its caveat', () => {
    expect(composer).toContain("t('mv_external_reference', lang)");
    expect(composer).toContain("t('mv_external_reference_hint', lang)");
  });

  it('the request number is the operator-typed value and nothing else', () => {
    // Exactly one assignment, and it is the typed external reference.
    const assignments = composer.match(/requestNumber:\s*[^,\n]+/g) ?? [];
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toContain('externalReference.trim()');
  });

  it('the composer derives no number from a count, a clock or randomness', () => {
    // Scoped to the confirm handler: newKey() legitimately uses Date.now() as a
    // per-line IDEMPOTENCY token, which is not a document number.
    const body = bodyOf(composer, 'const confirmAndCreate');
    expect(body).not.toMatch(/Math\.max|\.length \s*\+\s*1|Date\.now\(\)|Math\.random\(\)/);
  });
});

describe('institution and warehouse are always paired', () => {
  it('the review restates both parties through the shared paired label', () => {
    expect(composer).toContain('pairedPartyLabel(');
    expect((composer.match(/pairedPartyLabel\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('changing institution clears the previously selected warehouse', () => {
    expect(party).toContain("onSelectWarehouse('')");
  });

  it('only warehouses of the chosen institution are offered', () => {
    expect(party).toContain('warehouses.filter(w => w.organizationId === selectedOrganizationId)');
  });
});

/**
 * PHOENIX-DSO-1 — material identity must survive the whole compose path.
 *
 * The pre-existing test "the composer carries centralItemId through to the RPC"
 * scans confirmAndCreate for `centralItemId: line.centralItemId` and passes. It
 * always passed — including while the defect was live — because it verifies the
 * LAST link of the chain and says nothing about whether the line ever received
 * an identity. The defect lived two links earlier: getWarehouseStock did not
 * project the identity columns, so both StockCandidate mapping sites wrote
 * null, draftLineFromStock faithfully copied those nulls, and
 * _phoenix_150_send_direct_v1 then refused the line with
 * direct_request_line_material_mismatch.
 *
 * These tests pin the two mapping sites and the projection, so the chain cannot
 * be broken again at the point where it actually broke.
 */
describe('PHOENIX-DSO-1: material identity survives the compose path', () => {
  const service = readFileSync(join(ROOT, 'src', 'features', 'network', 'network.service.ts'), 'utf8');
  /** The fields _phoenix_150_send_direct_v1 matches stock to a request line on. */
  const IDENTITY = ['centralItemId', 'concentration', 'dosageForm', 'unit'] as const;

  /**
   * A BRACE-MATCHED body, unlike the fixed-width `bodyOf` above.
   *
   * `bodyOf` slices a constant 2600 characters forward, which for `loadStock`
   * runs several hundred characters past the start of `enterReview`. A test
   * named for one mapping site would then be reading both, and could pass
   * because the OTHER site satisfied it. That is precisely the weakness that
   * let the pre-existing "carries centralItemId through to the RPC" test stay
   * green for the entire life of this defect, so these tests do not reuse it.
   */
  function scopedBody(source: string, declaration: string): string {
    const start = source.indexOf(declaration);
    expect(start, `declaration not found: ${declaration}`).toBeGreaterThan(-1);
    const open = source.indexOf('{', start);
    expect(open, `no body found for: ${declaration}`).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    throw new Error(`unbalanced braces for: ${declaration}`);
  }

  it('scopedBody really does isolate one mapping site from the other', () => {
    // the guard on the guard: if this ever fails, every per-site test below is
    // silently reading the wrong function
    const load = scopedBody(composer, 'const loadStock');
    const review = scopedBody(composer, 'const enterReview');
    expect(load).not.toContain('const enterReview');
    expect(review).not.toContain('const loadStock');
    expect(load).toContain('setStockLoading');      // unique to loadStock
    expect(review).toContain('revalidateAgainstFreshStock'); // unique to enterReview
  });

  it('getWarehouseStock projects every field the send RPC matches on', () => {
    const select = /\.from\('warehouse_stock'\)\s*\.select\('([^']+)'\)/.exec(service);
    expect(select, 'getWarehouseStock select() not found').not.toBeNull();
    for (const column of ['central_item_id', 'concentration', 'dosage_form', 'unit', 'scientific_name']) {
      expect(select![1], `projection is missing ${column}`).toContain(column);
    }
  });

  it('WarehouseStockBatch carries every identity field', () => {
    const shape = bodyOf(service, 'export interface WarehouseStockBatch');
    for (const field of IDENTITY) {
      expect(shape, `WarehouseStockBatch is missing ${field}`).toContain(`${field}:`);
    }
  });

  it('the loadStock mapping site carries identity from the stock row', () => {
    const body = scopedBody(composer, 'const loadStock');
    for (const field of IDENTITY) {
      expect(body, `loadStock drops ${field}`).toContain(`${field}: b.${field}`);
    }
  });

  it('the enterReview re-fetch carries identity from the stock row', () => {
    const body = scopedBody(composer, 'const enterReview');
    for (const field of IDENTITY) {
      expect(body, `enterReview drops ${field}`).toContain(`${field}: b.${field}`);
    }
  });

  it('neither mapping site hard-codes an identity field back to null', () => {
    for (const declaration of ['const loadStock', 'const enterReview']) {
      const body = scopedBody(composer, declaration);
      for (const field of IDENTITY) {
        expect(body, `${declaration} nulls ${field}`).not.toContain(`${field}: null`);
      }
    }
  });

  it('no fallback value is substituted for a missing identity', () => {
    // A default would make a line that matches nothing look like one that
    // matches something, which is worse than the original defect.
    for (const declaration of ['const loadStock', 'const enterReview']) {
      const body = scopedBody(composer, declaration);
      for (const field of IDENTITY) {
        const assignment = `${field}: b.${field}`;
        const at = body.indexOf(assignment);
        expect(at, `${declaration} does not carry ${field}`).toBeGreaterThan(-1);
        const following = body.slice(at + assignment.length, at + assignment.length + 12);
        expect(following, `${declaration} defaults ${field}`).not.toContain('??');
        expect(following, `${declaration} defaults ${field}`).not.toContain('||');
      }
    }
  });

  it('the repair introduces no `as any` escape hatch', () => {
    expect(composer).not.toMatch(/as any/);
    expect(bodyOf(service, 'export async function getWarehouseStock')).not.toMatch(/as any/);
  });

  it('identity still travels from the line to the RPC unchanged', () => {
    // the pre-existing guarantee, kept explicit alongside the new ones
    const body = bodyOf(composer, 'const confirmAndCreate');
    for (const field of IDENTITY) {
      expect(body, `confirmAndCreate drops ${field}`).toContain(`${field}: line.${field}`);
    }
  });
});

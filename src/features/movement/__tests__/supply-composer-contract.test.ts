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

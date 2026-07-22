/**
 * MOVEMENT-COMPOSER-A — cross-cutting contracts that no single screen owns.
 *
 * These are the invariants that would be easiest to erode accidentally: a
 * composer quietly gaining a submit-and-approve shortcut, a receipt screen
 * gaining a material picker, or a document being built from local state instead
 * of the canonical server row.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const MOVEMENT = join(ROOT, 'src', 'features', 'movement');

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name) && !full.includes('__tests__')) out.push(full);
  }
  return out;
}

const files = walk(MOVEMENT).map(f => ({
  path: f.replace(ROOT, '.').replace(/\\/g, '/'),
  code: stripComments(readFileSync(f, 'utf8')),
}));

const byName = (name: string) => {
  const found = files.find(f => f.path.endsWith(name));
  expect(found, `missing ${name}`).toBeTruthy();
  return found!.code;
};

describe('the review/approval lifecycle is never bypassed', () => {
  it('no composer submits a request it just created', () => {
    // Submitting is a separate, separately-authorized operator decision.
    for (const file of files) {
      expect(file.code, file.path).not.toContain('submitTransferRequest(');
      expect(file.code, file.path).not.toContain('submitReturnRequest(');
    }
  });

  it('no composer reviews or approves anything', () => {
    for (const file of files) {
      expect(file.code, file.path).not.toContain('reviewTransferRequest(');
      expect(file.code, file.path).not.toContain('reviewReturnRequest(');
    }
  });

  it('no composer dispatches — creating a request never ships stock', () => {
    for (const file of files) {
      expect(file.code, file.path).not.toContain('sendDirectTransferLine(');
      expect(file.code, file.path).not.toContain('sendDirectReturnLine(');
    }
  });

  it('the only writers in the whole feature are the ones we intend', () => {
    const allowed = new Set([
      'createDirectTransferRequest', 'addTransferRequestLine',
      'requestDirectReturn', 'recallDirectTransfer', 'addDirectReturnLine',
      'receiveTransferLine',
    ]);
    const writerLike = /\b(create|add|send|receive|submit|review|recall|request|cancel|delete|update|upsert)[A-Z]\w*\(/g;
    for (const file of files) {
      for (const match of file.code.match(writerLike) ?? []) {
        const name = match.slice(0, -1);
        // Local state setters and pure helpers are not RPC writers.
        if (!/^(create|add|send|receive|submit|review|recall|request|cancel|delete|update|upsert)/.test(name)) continue;
        if (allowed.has(name)) continue;
        // Anything else must not be an imported service call.
        expect(file.code.includes(`${name},`) && file.code.includes('network.service'), `${file.path}: ${name}`).toBe(false);
      }
    }
  });

  it('the intake writer is never reachable from this feature', () => {
    // receiveWarehouseStock belongs to Inventory Center intake, and is the
    // shortcut a fake local-procurement writer would have taken.
    for (const file of files) {
      expect(file.code, file.path).not.toContain('receiveWarehouseStock');
    }
  });

  it('no service_role, admin auth or privileged key is referenced', () => {
    for (const file of files) {
      expect(file.code, file.path).not.toMatch(/service_role|auth\.admin|SERVICE_ROLE|serviceRole/);
    }
  });

  it('no direct stock-table write bypasses the ledger RPCs', () => {
    for (const file of files) {
      expect(file.code, file.path).not.toMatch(/\.from\(['"]warehouse_stock['"]\)\s*\.\s*(insert|update|upsert|delete)/);
      expect(file.code, file.path).not.toMatch(/\.from\(['"][a-z_]+['"]\)\s*\.\s*(insert|update|upsert|delete)/);
    }
  });
});

describe('the central stock picker exists only on the dispatch side', () => {
  it('StockMaterialPicker is imported by the supply composer alone', () => {
    const importers = files.filter(f => /import\s*\{[^}]*StockMaterialPicker/.test(f.code));
    expect(importers.map(f => f.path)).toEqual(['./src/features/movement/DirectSupplyComposer.tsx']);
  });

  it('the incoming and return screens never import it', () => {
    expect(byName('InstitutionIncomingSupplies.tsx')).not.toContain('StockMaterialPicker');
    expect(byName('DirectReturnComposer.tsx')).not.toContain('StockMaterialPicker');
  });

  it('the provenance picker is imported by the return composer alone', () => {
    const importers = files.filter(f => /import\s*\{[^}]*ProvenanceReturnPicker/.test(f.code));
    expect(importers.map(f => f.path)).toEqual(['./src/features/movement/DirectReturnComposer.tsx']);
  });
});

describe('OCR never touches supply, receipt or return', () => {
  it('no movement source imports any OCR module', () => {
    for (const file of files) {
      expect(file.code, file.path).not.toMatch(/from ['"].*\/ocr\//);
      expect(file.code, file.path).not.toMatch(/tesseract|extractPharmaFields|OcrIntakeFlow|OcrReviewWorkspace/);
    }
  });
});

describe('documents are built from canonical server data', () => {
  it('the receipt model is a pure shape with no local composer types', () => {
    const model = byName('receipt-model.ts');
    // A receipt must never be assembled from a DraftLine.
    expect(model).not.toContain('DraftLine');
    expect(model).not.toContain('StockCandidate');
  });

  it('the receipt HTML builder takes a ReceiptDocument and nothing draft-shaped', () => {
    const html = byName('receipt-html.ts');
    expect(html).not.toContain('DraftLine');
    expect(html).not.toContain('composer-model');
  });

  it('the XLSX builder takes a ReceiptDocument and nothing draft-shaped', () => {
    const xlsx = byName('receipt-xlsx.ts');
    expect(xlsx).not.toContain('DraftLine');
    expect(xlsx).not.toContain('composer-model');
  });

  it('neither document builder performs a write or a read of its own', () => {
    for (const name of ['receipt-html.ts', 'receipt-xlsx.ts']) {
      const code = byName(name);
      expect(code, name).not.toContain('supabase');
      expect(code, name).not.toContain('network.service');
    }
  });
});

describe('idempotency keys are stable and per line', () => {
  it('a draft line carries its own key, generated once at add time', () => {
    expect(byName('DirectSupplyComposer.tsx')).toContain('draftLineFromStock(candidate, quantity, newKey())');
    expect(byName('DirectReturnComposer.tsx')).toContain('idempotencyKey: newKey()');
  });

  it('dispatch reuses the ORIGINAL key on retry rather than minting a new one', () => {
    const commit = byName('movement-commit.ts');
    expect(commit).toContain('failed.has(i.idempotencyKey)');
    // retryableDispatchLines filters the original inputs; it never rebuilds them.
    expect(commit).not.toMatch(/retryableDispatchLines[\s\S]{0,400}idempotencyKey:\s*newKey/);
  });
});

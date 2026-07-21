/**
 * MOVEMENT-COMPOSER-A — the numbering guard.
 *
 * No atomic server-side allocator exists (see
 * docs/phoenix/proposals/sequential-document-numbers.md). The one thing that
 * must never happen in response to that gap is the frontend inventing a
 * sequence that LOOKS authoritative. This test makes that regression loud.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const MOVEMENT_DIR = join(ROOT, 'src', 'features', 'movement');

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

const sourceFiles = walk(MOVEMENT_DIR);
const sources = sourceFiles.map(f => ({ file: f.replace(ROOT, '.'), text: readFileSync(f, 'utf8') }));

describe('no client-side document-number sequence exists', () => {
  it('has movement source files to scan (the guard is not vacuous)', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it('never derives a document number from MAX()+1 or a row count', () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/Math\.max\([^)]*\)\s*\+\s*1/);
      expect(text, file).not.toMatch(/\.length\s*\+\s*1\s*[;,)]/);
      expect(text, file).not.toMatch(/last(Number|Value)\s*\+\s*1/i);
    }
  });

  it('never builds a document number from a timestamp or a random value', () => {
    for (const { file, text } of sources) {
      // Date.now()/random are fine for unrelated purposes, but must never be
      // adjacent to number/serial/reference construction in this feature.
      const numberish = /(?:requestNumber|transferNumber|returnNumber|shipmentNumber|documentNumber|serial)\s*[=:]\s*[^;\n]*(?:Date\.now\(\)|Math\.random\(\))/i;
      expect(text, file).not.toMatch(numberish);
    }
  });

  it('never persists or reads a counter from localStorage/sessionStorage', () => {
    for (const { file, text } of sources) {
      const storageCounter = /(?:localStorage|sessionStorage)[^;\n]*(?:number|serial|sequence|counter)/i;
      expect(text, file).not.toMatch(storageCounter);
    }
  });

  it('the QR trace key refuses anything that is not a uuid', async () => {
    const { buildMovementQrPayload } = await import('../movement-trace');
    // A formatted serial must never be accepted as the canonical trace key.
    expect(() => buildMovementQrPayload('supply_dispatch', 'SUP-DSP-2026-000001')).toThrow();
    expect(() => buildMovementQrPayload('supply_dispatch', '1')).toThrow();
  });

  it('operator-typed numbers are labelled as external references, not serials', () => {
    const strings = readFileSync(join(ROOT, 'src', 'shared', 'i18n', 'strings.ts'), 'utf8');
    expect(strings).toContain('mv_external_reference');
    expect(strings).toMatch(/External \/ operator reference/);
    expect(strings).toMatch(/مرجع خارجي/);
  });

  it('the migration proposal exists and is explicitly not applied', () => {
    const proposal = join(ROOT, 'docs', 'phoenix', 'proposals', 'sequential-document-numbers.md');
    expect(existsSync(proposal)).toBe(true);
    const text = readFileSync(proposal, 'utf8');
    expect(text).toMatch(/PROPOSAL ONLY/i);
    expect(text).toMatch(/not applied/i);
  });

  it('no migration file was added for document numbering', () => {
    const migrations = readdirSync(join(ROOT, 'supabase', 'migrations')).filter(f => f.endsWith('.sql'));
    // 080 (the guarded-receipt cutover) is the highest reviewed migration.
    // migration. It adds no document numbering; the point of this guard is that
    // no sequence/numbering migration appears, which the name check below pins.
    const beyond = migrations.filter(f => /^0*(081|09\d|[1-9]\d{2,})/.test(f));
    expect(beyond).toEqual([]);
    expect(migrations.some(f => /document_number|sequence/i.test(f))).toBe(false);
  });
});

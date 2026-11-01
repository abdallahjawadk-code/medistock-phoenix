import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { replay } = vi.hoisted(() => ({ replay: vi.fn() }));
vi.mock('../../../src/features/central-needs/import/node-replay.ts', () => ({ replayWorkbook: replay }));
import { createAnnualSourceComputer } from '../computation.ts';
import type { AnnualExtractionOriginal } from '../../../src/features/central-needs/annual-catalog/annual-extraction-core.ts';

function original(bytes: Uint8Array, filename: string): AnnualExtractionOriginal {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { origin: 'local_corpus_review', scope: { ownerOrgId: 'local-corpus-review', planningYear: 2026 },
    originalId: `corpus:${sha256}`, filename, sha256, byteSize: bytes.length, bytes };
}
beforeEach(() => replay.mockReset().mockResolvedValue({ outcome: 'rejected' }));
describe('C3 admission precedes either accepted parser pass', () => {
  it('never hands inconsistent local sizes to SheetJS, even under a renamed extension', async () => {
    const zip = new JSZip(); zip.file('part.xml', 'synthetic');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    new DataView(bytes.buffer).setUint32(22, 0x40000000, true);
    expect(await createAnnualSourceComputer([]).compute(original(bytes, 'renamed.xls')))
      .toEqual({ status: 'held', reason: 'parse_rejected' });
    expect(replay).not.toHaveBeenCalled();
  });
  it('refuses false source fingerprints before parsing', async () => {
    const input = original(new TextEncoder().encode('Name\nSynthetic'), 'source.csv'); input.sha256 = '0'.repeat(64);
    expect((await createAnnualSourceComputer([]).compute(input)).status).toBe('held');
    expect(replay).not.toHaveBeenCalled();
  });
  it('never sends a noncanonical PK prefix to the broader SheetJS ZIP dispatch', async () => {
    const zip = new JSZip(); zip.file('part.xml', 'synthetic');
    const bytes = await zip.generateAsync({ type: 'uint8array' }); bytes[2] = 0; bytes[3] = 0;
    expect((await createAnnualSourceComputer([]).compute(original(bytes, 'source.csv'))).status).toBe('held');
    expect(replay).not.toHaveBeenCalled();
  });
  it('parses the same captured bytes even if the caller mutates its buffer during admission', async () => {
    const bytes = new TextEncoder().encode('Name\nSynthetic'); const expected = Uint8Array.from(bytes);
    const task = createAnnualSourceComputer([]).compute(original(bytes, 'source.csv')); bytes.fill(0);
    await task; expect(replay).toHaveBeenCalledOnce(); expect(replay.mock.calls[0][0]).toEqual(expected);
  });
});

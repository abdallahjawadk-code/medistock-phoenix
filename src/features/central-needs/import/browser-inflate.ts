/**
 * CN-2A — browser-side DEFLATE decompression adapter (the one documented
 * per-runtime exception; see contract.ts "Runtime parity"). Uses the Web
 * `DecompressionStream` API, native to Workers — never imported by the Node
 * replay adapter.
 *
 * Output is consumed as a BOUNDED STREAM: emitted bytes are counted chunk by
 * chunk and the reader is cancelled the moment the running total exceeds the
 * ceiling, so a decompression bomb never accumulates in memory. The entry's
 * declared uncompressed size is deliberately NOT used as the bound — it is
 * attacker-controlled metadata. This mirrors what `maxOutputLength` does for
 * the Node adapter, so both runtimes enforce the same policy at the same
 * point (during decompression, not after it).
 */
import { InflateOutputLimitExceeded, type Inflate } from './zip-reader.ts';

export const browserInflate: Inflate = async (compressed, { maxOutputBytes }) => {
  const source = new Blob([compressed as unknown as BlobPart]).stream();
  const stream = source.pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxOutputBytes) {
        await reader.cancel();
        throw new InflateOutputLimitExceeded(maxOutputBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

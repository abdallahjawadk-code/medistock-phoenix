/**
 * CN-2A — Node-side DEFLATE decompression adapter (the one documented
 * per-runtime exception; see contract.ts "Runtime parity"). Node-only file —
 * never imported by the browser Worker adapter.
 *
 * The output ceiling is enforced by zlib itself via `maxOutputLength`, so a
 * decompression bomb is aborted inside the decompressor rather than after a
 * huge buffer has already been materialised. The entry's own declared
 * uncompressed size is deliberately NOT used as the bound — it is
 * attacker-controlled metadata.
 */
import { inflateRawSync } from 'node:zlib';
import { InflateOutputLimitExceeded, type Inflate } from './zip-reader.ts';

export const nodeInflate: Inflate = async (compressed, { maxOutputBytes }) => {
  try {
    return new Uint8Array(inflateRawSync(Buffer.from(compressed), { maxOutputLength: maxOutputBytes }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new InflateOutputLimitExceeded(maxOutputBytes);
    }
    throw err;
  }
};

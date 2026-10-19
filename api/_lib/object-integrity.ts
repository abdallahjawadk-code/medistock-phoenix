/**
 * R1 / ST-15 hardening — verify a permanent Storage object before a signed URL is
 * issued for it.
 *
 * Readiness blockers and the batch row are database-only: they cannot see
 * Storage. `source-download` therefore proves, at request time, that the object
 * the batch row points at exists and hashes to the recorded container SHA-256.
 * Any doubt (missing, unreadable, oversized, mismatching) denies.
 *
 * Cost note: this downloads the container (bounded by the transport limit) and
 * hashes it. It is a request-time integrity proof for an interactive, authorized
 * action, not a replacement for an offline reconciliation report.
 */
export type ObjectIntegrity =
  | { ok: true }
  | { ok: false; status: 404 | 409 | 413 | 502; code: string };

export interface StorageDownloader {
  download: (key: string) => Promise<{ data: { arrayBuffer: () => Promise<ArrayBuffer> } | null; error: unknown }>;
}

export async function verifyPermanentObject(
  storage: StorageDownloader,
  objectKey: string,
  expectedSha256: string,
  maxBytes: number,
  sha256Hex: (bytes: Uint8Array) => Promise<string>,
): Promise<ObjectIntegrity> {
  if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    return { ok: false, status: 409, code: 'source_object_expected_hash_invalid' };
  }
  let result;
  try {
    result = await storage.download(objectKey);
  } catch {
    return { ok: false, status: 502, code: 'source_object_unreadable' };
  }
  if (result.error || !result.data) return { ok: false, status: 404, code: 'source_object_missing' };

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await result.data.arrayBuffer());
  } catch {
    return { ok: false, status: 502, code: 'source_object_unreadable' };
  }
  if (bytes.byteLength > maxBytes) return { ok: false, status: 413, code: 'source_object_exceeds_limit' };
  if ((await sha256Hex(bytes)) !== expectedSha256) {
    return { ok: false, status: 409, code: 'source_object_hash_mismatch' };
  }
  return { ok: true };
}

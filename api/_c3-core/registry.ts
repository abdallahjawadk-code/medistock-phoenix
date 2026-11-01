/** Reviewed server configuration shared by discovery, read and commit routes.
 * Source definitions remain private review artifacts; no real or synthetic
 * registration is activated by the default deployment. */
import { createHash } from 'node:crypto';
import type { RegisteredAnnualLayout } from './computation.ts';

export const reviewedAnnualLayouts: readonly RegisteredAnnualLayout[] = Object.freeze([]);
export function snapshotReviewedLayouts(registrations: readonly RegisteredAnnualLayout[]) {
  if (registrations.length > 100) throw new Error('invalid_server_configuration');
  const seen = new Set<string>();
  return registrations.map(registration => {
    const serialized = JSON.stringify(registration);
    if (Buffer.byteLength(serialized) > 65536) throw new Error('invalid_server_configuration');
    const manifest = JSON.parse(serialized) as RegisteredAnnualLayout;
    const key = JSON.stringify([manifest.template.id, manifest.template.version]);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(manifest.template.id)
      || !Number.isSafeInteger(manifest.template.version) || manifest.template.version < 1 || seen.has(key)) {
      throw new Error('invalid_server_configuration');
    }
    seen.add(key);
    return { manifest, expectedSha256: createHash('sha256').update(serialized).digest('hex') };
  });
}

/**
 * CN-2B trusted server — private object keys.
 *
 * THE RULE: a user-controlled string never becomes part of an object key.
 * Not the workbook filename, not a ZIP entry path, not anything typed into
 * the browser. Every segment below is either a UUID this server generated or
 * read from the database, or a lowercase SHA-256 hex digest computed from
 * bytes. Both alphabets are closed and contain no `/`, no `\`, no `.` and no
 * control characters, which is why traversal is structurally impossible here
 * rather than filtered out afterwards.
 *
 * The original filename is preserved as METADATA — `central_needs_source_files
 * .original_filename` and `central_needs_import_batches.container_filename` —
 * which is where a human-readable name belongs.
 *
 * A ZIP member is NOT given its own object. The archive is stored once, whole
 * and immutable, and an entry is addressed by encoding its identity into the
 * locator (see `entryLocator`), so a hostile `archiveEntryPath` never touches
 * the storage layer at all.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export class UnsafePathSegmentError extends Error {
  constructor(kind: string) {
    super(`unsafe_path_segment: ${kind}`);
    this.name = 'UnsafePathSegmentError';
  }
}

export function assertUuid(value: string, kind: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new UnsafePathSegmentError(kind);
  return value;
}

export function assertSha256(value: string, kind: string): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) throw new UnsafePathSegmentError(kind);
  return value;
}

/** The two namespaces. Staging is disposable; permanent is immutable evidence. */
export const STAGING_PREFIX = 'staging';
export const PERMANENT_PREFIX = 'permanent';

export interface StagingIdentity {
  organizationId: string;
  planRevisionId: string;
  userId: string;
  uploadId: string;
}

/**
 * `staging/{organization}/{revision}/{user}/{upload}/…`
 *
 * Scoping by user as well as organization means one person's in-flight upload
 * is never addressable by another, even inside the same revision.
 */
export function stagingPrefix(identity: StagingIdentity): string {
  return [
    STAGING_PREFIX,
    assertUuid(identity.organizationId, 'organization_id'),
    assertUuid(identity.planRevisionId, 'plan_revision_id'),
    assertUuid(identity.userId, 'user_id'),
    assertUuid(identity.uploadId, 'upload_id'),
  ].join('/');
}

export function stagingSourceKey(identity: StagingIdentity): string {
  return `${stagingPrefix(identity)}/source.bin`;
}

export function stagingPreviewKey(identity: StagingIdentity): string {
  return `${stagingPrefix(identity)}/preview.json`;
}

/**
 * `permanent/{organization}/{revision}/{container_sha256}`
 *
 * Content-addressed, so the same bytes always land on the same key and a
 * re-upload is a no-op rather than a second copy. Organization and revision
 * stay in the path so lineage is legible from the locator alone, and so a
 * bucket policy can be written per organization if one is ever added.
 */
export function permanentSourceKey(
  organizationId: string,
  planRevisionId: string,
  containerSha256: string,
): string {
  return [
    PERMANENT_PREFIX,
    assertUuid(organizationId, 'organization_id'),
    assertUuid(planRevisionId, 'plan_revision_id'),
    assertSha256(containerSha256, 'container_sha256'),
  ].join('/');
}

/**
 * The opaque locator persisted on a source file / batch row.
 *
 * For a standalone workbook it is just the permanent object key. For a ZIP
 * member it is that key plus the entry's identity, and the entry is identified
 * by its ORDINAL and its own content hash — never by its path text. The
 * verbatim `archiveEntryPath` is preserved separately as evidence in
 * `central_needs_import_batch_entries.archive_entry_path`, where it is data
 * rather than an address.
 */
export function entryLocator(permanentKey: string, entryOrdinal: number, entrySha256: string): string {
  if (!Number.isInteger(entryOrdinal) || entryOrdinal < 1) {
    throw new UnsafePathSegmentError('entry_ordinal');
  }
  return `${permanentKey}#entry=${entryOrdinal}&sha256=${assertSha256(entrySha256, 'entry_sha256')}`;
}

/**
 * Reverses `entryLocator`/`permanentSourceKey` for an authorized download.
 * Returns only the object key, and only when the whole locator matches the
 * exact shape this module produces — an arbitrary string is refused rather
 * than passed to Storage.
 */
export function objectKeyFromLocator(locator: string): string | null {
  if (typeof locator !== 'string' || locator === '') return null;
  const key = locator.split('#', 1)[0];
  const parts = key.split('/');
  if (parts.length !== 4) return null;
  const [prefix, organizationId, planRevisionId, sha] = parts;
  if (prefix !== PERMANENT_PREFIX) return null;
  if (!UUID_RE.test(organizationId) || !UUID_RE.test(planRevisionId) || !SHA256_RE.test(sha)) return null;
  return key;
}

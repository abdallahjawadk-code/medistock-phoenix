/**
 * R1 / ST-15 hardening — re-assert the caller's authority during an import.
 *
 * `finalize-import` authorizes the caller once at the start, but the import then
 * runs a sequence of SEPARATE database calls (entry session as the caller, trusted
 * replay, trusted batch registration) and a Storage write. The trusted calls carry
 * no caller identity. Re-asserting the caller's authority immediately before the
 * permanent write and before each trusted step narrows the window in which a
 * revoked, suspended or re-homed caller can still drive trusted writes.
 *
 * THIS IS NOT AN ATOMIC REVOCATION GUARANTEE. Each check is a separate request;
 * authority can still be lost between the check and the step that follows it. Only
 * a single database transaction (a different, separately authorized design) can
 * close that window. The check is fail-closed: any error, absent revision, changed
 * organization or non-draft status denies.
 */
import type { AuthenticatedCaller, ResolvedRevision } from './supabase.ts';

export type AuthorityDecision =
  | { ok: true }
  | { ok: false; status: 403 | 404 | 409; code: string; detail?: string };

export interface AuthorityDeps {
  resolveRevision: (caller: AuthenticatedCaller, planRevisionId: string) => Promise<ResolvedRevision | null>;
  isAuthorized: (caller: AuthenticatedCaller, organizationId: string, permissionKey: string) => Promise<boolean>;
}

export async function reassertImportAuthority(
  caller: AuthenticatedCaller,
  planRevisionId: string,
  expectedOrganizationId: string,
  deps: AuthorityDeps,
): Promise<AuthorityDecision> {
  let revision: ResolvedRevision | null;
  try {
    revision = await deps.resolveRevision(caller, planRevisionId);
  } catch {
    return { ok: false, status: 404, code: 'authority_check_unavailable' };
  }
  // Not visible to the caller any more (RLS) or gone: indistinguishable on purpose.
  if (!revision) return { ok: false, status: 404, code: 'plan_revision_not_found' };

  // The organization is read from the row; it must be the one authorized at the start.
  if (revision.organizationId !== expectedOrganizationId) {
    return { ok: false, status: 409, code: 'import_scope_changed' };
  }

  let authorized = false;
  try {
    authorized = await deps.isAuthorized(caller, revision.organizationId, 'central_needs.import');
  } catch {
    authorized = false;
  }
  if (!authorized) return { ok: false, status: 403, code: 'authority_lost_during_import' };

  if (revision.status !== 'draft') {
    return { ok: false, status: 409, code: 'plan_revision_not_editable', detail: revision.status };
  }
  return { ok: true };
}

/**
 * SCREEN-ACCESS — the five-role visibility model for guarded screens.
 *
 * These are UX GATES only. Every screen's data path is re-checked server-side
 * by RLS + SECURITY DEFINER RPCs, so a hidden button or a forged route can
 * never become an unauthorized read or write. This module keeps the nav,
 * command palette and route guard agreeing on ONE predicate each, instead of
 * scattered role-name checks that drift apart.
 *
 * The five operational roles (migration-066 model):
 *   super_admin               — platform administrator
 *   central_warehouse_manager — pharmacy-department stock control
 *   institution_admin         — one institution
 *   warehouse_officer         — one institution store (depot)
 *   outlet_officer            — one dispensing outlet
 */
import { normalizeRole } from '@/shared/lib/roles';

/** Platform administrator — the ONLY role that manages institutions globally. */
export function isPlatformAdmin(role: string | null | undefined): boolean {
  return normalizeRole(role ?? '') === 'super_admin';
}

/**
 * An institution-level administrator (current or legacy org admin). Gets the
 * "My Organization" settings scope — NOT the global institutions directory.
 */
export function isInstitutionAdmin(role: string | null | undefined): boolean {
  const n = normalizeRole(role ?? '');
  return n === 'institution_admin' || n === 'hospital_admin';
}

/**
 * Who may reach screen 11 at all, and in which mode:
 *   'directory' — the global institutions list/create (platform admin only);
 *   'own'       — "My Organization" for this actor's institution;
 *   false       — no access (route guard renders 403; nav hides the entry).
 */
export function institutionsScreenAccess(role: string | null | undefined): 'directory' | 'own' | false {
  if (isPlatformAdmin(role)) return 'directory';
  if (isInstitutionAdmin(role)) return 'own';
  return false;
}

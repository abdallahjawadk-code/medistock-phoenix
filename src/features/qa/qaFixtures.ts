/**
 * VISUAL-QA-HARNESS-A — deterministic fixtures (DEV/TEST ONLY).
 *
 * Every value here is clearly QA-only and never touches a database. Personas
 * mirror the real role families so permission-gated UI renders realistically;
 * `roleDefaults` is the SAME hardcoded fallback table the app uses when the
 * permission-matrix RPC is briefly unavailable — no invented capabilities.
 */
import type { Lang, Role, Theme } from '@/shared/lib/types';
import type { AppState } from '@/app/AppContext';
import type { Profile } from '@/shared/supabase/services/auth.service';
import { roleDefaults } from '@/shared/lib/permissions';
import {
  createAuthorizationService,
  createRbacObservability,
} from '@/shared/authz/authorization';
import {
  currentScopedRbacDiagnostic,
  currentScopedRbacMode,
} from '@/shared/authz/mode';
import { QA_HARNESS_MARKER } from './qaConfig';
import { ORG_A } from './qaData';
import { createQaRbacTransport, qaLoadScopes } from './qaScopes';

export type QaPersonaId =
  | 'super_admin'
  | 'central_warehouse_manager'
  | 'warehouse_officer'
  | 'warehouse_officer_assigned'
  | 'outlet_officer'
  | 'outlet_officer_assigned';

export interface QaPersona {
  id: QaPersonaId;
  labelAr: string;
  labelEn: string;
  profile: Profile;
}

/**
 * The organization the org-scoped personas belong to. This is ORG_A from the
 * fixture catalog, NOT a synthetic UUID: a persona whose `organization_id`
 * matches no fixture organization can never resolve a warehouse or outlet, so
 * every org-scoped screen would dead-end on an empty catalog.
 */
const QA_ORG = ORG_A;

function qaProfile(
  id: QaPersonaId,
  /**
   * The REAL role this persona carries. Kept separate from the persona id so a
   * scoped and an unassigned persona can share one role and differ only by
   * their migration-062 assignment rows — which is exactly what makes the
   * scoped-permission evidence a scope proof rather than a role proof.
   */
  role: Role,
  fullName: string,
  organizationId: string | null,
): Profile {
  return {
    // Deterministic, obviously-synthetic ids — QA ONLY, never a real user.
    id: `qa-${id}`,
    organization_id: organizationId,
    full_name: `${fullName} · ${QA_HARNESS_MARKER}`,
    role,
    status: 'active',
    username: `qa.${id}`,
    login_mode: 'local',
    contact_email: null,
    must_change_password: false,
    whatsapp_phone: null,
  };
}

export const QA_PERSONAS: QaPersona[] = [
  {
    id: 'super_admin',
    labelAr: 'مسؤول النظام',
    labelEn: 'Super admin',
    profile: qaProfile('super_admin', 'super_admin', 'مسؤول النظام', null),
  },
  {
    id: 'central_warehouse_manager',
    labelAr: 'مدير مخزن مركزي',
    labelEn: 'Central warehouse manager',
    profile: qaProfile('central_warehouse_manager', 'central_warehouse_manager', 'مدير المخزن المركزي', QA_ORG),
  },
  {
    id: 'warehouse_officer',
    labelAr: 'أمين مذخر مؤسسة (بلا تخصيص)',
    labelEn: 'Institution warehouse officer (unassigned)',
    profile: qaProfile('warehouse_officer', 'warehouse_officer', 'أمين مذخر المؤسسة', QA_ORG),
  },
  {
    // Same role as above; differs ONLY by carrying a migration-062 warehouse
    // assignment. Reaches the outlets under `qa-wh-inst-a` and no others.
    id: 'warehouse_officer_assigned',
    labelAr: 'أمين مذخر مؤسسة (مخصَّص)',
    labelEn: 'Institution warehouse officer (assigned)',
    profile: qaProfile('warehouse_officer_assigned', 'warehouse_officer', 'أمين مذخر المؤسسة المخصَّص', QA_ORG),
  },
  {
    id: 'outlet_officer',
    labelAr: 'أمين منفذ (بلا تخصيص)',
    labelEn: 'Outlet officer (unassigned)',
    profile: qaProfile('outlet_officer', 'outlet_officer', 'أمين المنفذ', QA_ORG),
  },
  {
    // Same role as above; differs ONLY by carrying a migration-062
    // distribution-point assignment. Reaches `qa-outlet-1` ALONE.
    id: 'outlet_officer_assigned',
    labelAr: 'أمين منفذ (مخصَّص)',
    labelEn: 'Outlet officer (assigned)',
    profile: qaProfile('outlet_officer_assigned', 'outlet_officer', 'أمين المنفذ المخصَّص', QA_ORG),
  },
];

export function qaPersona(id: QaPersonaId): QaPersona {
  return QA_PERSONAS.find(p => p.id === id) ?? QA_PERSONAS[0];
}

interface BuildArgs {
  persona: QaPersona;
  lang: Lang;
  theme: Theme;
  setLang: (l: Lang) => void;
  setTheme: (t: Theme) => void;
  /**
   * Organization the harness should render as active, overriding the persona's
   * own `organization_id`. A super_admin profile carries `organization_id: null`
   * exactly as in production, so org-scoped screens (Inventory Center) would
   * otherwise dead-end on "no organization scope" — in the real app the operator
   * picks an org with <PhoenixOrgScope />, which the harness cannot drive
   * because its setActiveOrgId is inert. This override is the harness's stand-in
   * for that click. It grants NOTHING: authz context, role and every RPC
   * permission check are unchanged.
   */
  orgId?: string | null;
}

/**
 * Build a full, type-faithful {@link AppState} for the harness. Reuses the real
 * (network-free) authz/telemetry factories in their resolved mode, so nothing
 * about authorization behaviour is faked — the harness simply never signs in.
 * All async mutators are inert no-ops: the harness performs no auth actions.
 */
export function buildQaAppState({ persona, lang, theme, setLang, setTheme, orgId }: BuildArgs): AppState {
  const activeOrgId = orgId !== undefined ? orgId : persona.profile.organization_id;
  const mode = currentScopedRbacMode();
  const observability = createRbacObservability(mode);
  // Inject the migration-062 assignment fixtures through the authorization
  // service's OWN seams. The real scope-resolution logic runs untouched; only
  // the rows it reads are fixture rows, so an unassigned persona is denied by
  // the production code path rather than by anything the harness decides.
  const authz = createAuthorizationService({
    mode,
    reporter: observability.reporter,
    transport: createQaRbacTransport(),
    loadScopes: qaLoadScopes,
  });
  const permissions = new Set(roleDefaults(persona.profile.role));
  authz.setContext({
    authenticated: true,
    profileId: persona.profile.id,
    role: persona.profile.role,
    organizationId: persona.profile.organization_id,
    legacyPermissions: permissions,
  });
  const noop = async () => { /* QA harness performs no auth/session actions */ };
  const noopResult = async () => ({ ok: false, error: QA_HARNESS_MARKER });

  return {
    lang,
    theme,
    setLang,
    setTheme,
    toggleLang: () => setLang(lang === 'ar' ? 'en' : 'ar'),
    toggleTheme: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
    dir: lang === 'ar' ? 'rtl' : 'ltr',

    configured: true,
    authReady: true,
    // QA ONLY: a minimal session shape — enough for UI that reads user.id.
    session: { user: { id: persona.profile.id } } as unknown as AppState['session'],
    profile: persona.profile,
    role: persona.profile.role,
    activeOrgId,
    setActiveOrgId: () => { /* QA: org scope is fixed per persona / ?org= */ },
    signIn: noopResult,
    signOut: noop,
    reloadProfile: noop,

    myPermissions: permissions,
    myPermissionsMigrationMissing: false,
    reloadMyPermissions: noop,

    authz,
    scopedRbacMode: mode,
    rbacTelemetry: observability.store,
    scopedRbacDiagnostic: currentScopedRbacDiagnostic(),

    passwordRecovery: false,
    requestPasswordReset: noopResult,
    updatePassword: noopResult,
    clearRecovery: noop,
  };
}

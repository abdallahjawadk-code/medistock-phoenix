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
  | 'outlet_officer_assigned'
  | 'institution_admin'
  | 'health_center_manager_assigned';

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
  /**
   * IG-2 ROUND 3 — the ORG-WIDE (NULL,NULL) suspension claim's holder, per
   * MaterialDispensingSuspensionPanel.tsx's own doc comment on the
   * institution_admin case. Carries no migration-062 warehouse/outlet
   * assignment at all — an org-wide claim needs none.
   */
  {
    id: 'institution_admin',
    labelAr: 'مسؤول المؤسسة',
    labelEn: 'Institution admin',
    profile: qaProfile('institution_admin', 'institution_admin', 'مسؤول المؤسسة', QA_ORG),
  },
  /**
   * IG-2 ROUND 3 — the "read-only, no admin steps" persona for the Quarantine
   * tour. `health_center_manager`'s read affordance
   * (`useInventoryReadAffordance`, R1.5-E) is a ROLE predicate needing no
   * scoped-permission grant; this persona is ASSIGNED to `qa-wh-inst-a`
   * (reachability only, see qaScopes.ts) and is granted NO
   * `warehouse_transfer.return_request` anywhere.
   */
  {
    id: 'health_center_manager_assigned',
    labelAr: 'مدير مركز صحي (مخصَّص)',
    labelEn: 'Health-centre manager (assigned)',
    profile: qaProfile('health_center_manager_assigned', 'health_center_manager', 'مدير المركز الصحي', QA_ORG),
  },
];

export function qaPersona(id: QaPersonaId): QaPersona {
  return QA_PERSONAS.find(p => p.id === id) ?? QA_PERSONAS[0];
}

/**
 * FEFO-OVERRIDE-DIALOG-CAPTURE — a SMALL, EXPLICIT, harness-only permission
 * overlay on top of `roleDefaults()`, additive per persona.
 *
 * The problem it solves: `InventoryCenterScreen`'s Dispatch tab is gated on
 * `role === 'super_admin' || myPermissions.has('warehouse_dispatch.create')`,
 * and in the harness `myPermissions` is exactly `roleDefaults(role)` (no live
 * permission-matrix fetch) — `warehouse_dispatch.create` (a migration-066 key)
 * is not in ANY non-super_admin fallback list, so without this overlay ONLY
 * `super_admin` can ever reach the dispatch composer in QA mode at all. That
 * makes it impossible to drive FefoOverrideDialog's "denied" branch through
 * real interaction, because `useFefoOverridePermission` special-cases
 * `role === 'super_admin'` to `true` unconditionally (matching the real RPC's
 * super_admin bypass) — a super_admin persona can never exercise "no
 * inventory.fefo_override" at all.
 *
 * This overlay grants `warehouse_officer_assigned` (already carrying a
 * migration-062 warehouse assignment to `qa-wh-inst-a`, see qaScopes.ts) JUST
 * `warehouse_dispatch.create`, so it can open the composer and reach the
 * picker. It does NOT grant `inventory.fefo_override` — that permission is
 * still resolved through `useFefoOverridePermission`'s own scoped RPC
 * preflight (`supabaseRbacTransport.hasScopedPermission`, routed through the
 * SAME installed fixture Supabase client every other QA read uses), and
 * `phoenix_profile_has_scoped_permission` has no registered fixture, so the
 * fixture client's `rpc()` fails closed to `QA_READONLY` exactly like any
 * other unregistered RPC — the hook then returns `false`, denying the
 * override affordance through the REAL denial code path, not a harness
 * shortcut. `warehouse_officer_assigned` is therefore the "no permission"
 * FEFO persona; `super_admin` (its bypass, no RPC involved) is the "with
 * permission" one.
 *
 * Nothing here touches `roleDefaults()`, any RPC, RLS, or migration — this is
 * additive fixture data read only by `buildQaAppState`, itself reachable only
 * behind `visualQaEnabled` (see qaConfig.ts) and tree-shaken from production
 * (tests/qa-harness-production-safety.test.ts).
 */
const QA_EXTRA_PERMISSIONS: Partial<Record<QaPersonaId, readonly string[]>> = {
  warehouse_officer_assigned: ['warehouse_dispatch.create'],
};

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
  const permissions = new Set([
    ...roleDefaults(persona.profile.role),
    ...(QA_EXTRA_PERMISSIONS[persona.id] ?? []),
  ]);
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
    // PHASE-B1-AUTH-RESILIENCE: the harness renders screens for a persona that
    // is, by construction, already signed in with a loaded profile — so it
    // reports the terminal state and never a failure the fixtures cannot
    // produce. Both retries are the same no-op as every other auth action here.
    authStatus: 'authenticated',
    retryAuthBootstrap: noop,
    retryProfileLoad: noop,
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

import { useEffect, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { institutionsScreenAccess, isScreenAuthorized, roleLandingScreen } from '@/shared/authz/screen-access';
import { useApp } from './AppContext';
import { LoginScreen } from '@/features/auth/LoginScreen';
import { PhoenixWelcomeExperience } from '@/features/auth/PhoenixWelcomeExperience';
import { ResetPasswordScreen } from '@/features/auth/ResetPasswordScreen';
import { PhoenixAppShell } from '@/shared/ui/PhoenixAppShell';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { AuthRecoveryState } from '@/shared/ui/AuthRecoveryState';
import { ForbiddenScreen } from '@/shared/ui/ForbiddenScreen';
import { InventoryCenterScreen } from '@/features/inventory/InventoryCenterScreen';
import { RegistryScreen } from '@/features/registry/RegistryScreen';
import { MeshScreen } from '@/features/mesh/MeshScreen';
import { QrScreen } from '@/features/qr/QrScreen';
import { HealthScreen } from '@/features/health/HealthScreen';
import { IntakeFrozenScreen } from '@/features/health/IntakeFrozenScreen';
import { MobileCommandScreen } from '@/features/mesh/MobileCommandScreen';
import { InstitutionScreen } from '@/features/institutions/InstitutionScreen';
import { InterInstitutionAlertsScreen } from '@/features/alerts/InterInstitutionAlertsScreen';
import { UserManagementScreen } from '@/features/users/UserManagementScreen';
import { MyAccountScreen } from '@/features/account/MyAccountScreen';
import { StatusEditorScreen } from '@/features/status/StatusEditorScreen';
import { NetworkManagementScreen } from '@/features/network/NetworkManagementScreen';
import { OutletOperationsScreen } from '@/features/outlet/OutletOperationsScreen';
import { LocalProcurementScreen } from '@/features/procurement/LocalProcurementScreen';
import { DecisionIntelligenceReportsScreen } from '@/features/reports/DecisionIntelligenceReportsScreen';
import { CommandCenterScreen } from '@/features/command-center/CommandCenterScreen';
import { ScreenAuthzGuard } from '@/shared/authz/ScreenAuthzGuard';
import {
  suggestionDocumentScreen,
  type SuggestionDocumentTarget,
} from '@/features/inventory/suggestion-document-navigation';
import {
  clearRememberedScreen,
  isScreenRestorable,
  rememberScreen,
  resolveRestoredScreen,
  screenFromPopState,
} from './screen-continuity';

/**
 * QR-BUNDLE-CODE-SPLIT-A: everything that only an authenticated session
 * needs (login, password reset, the app shell, and every screen) lives here
 * so it code-splits into its own chunk, separate from the anonymous public
 * QR route (App.tsx / PublicQrScreen). Moved verbatim out of App.tsx — no
 * auth/session/business logic changed, only the file it lives in.
 */
/** Authenticated application shell and screen router. */
export function AuthenticatedApp() {
  const {
    authReady, session, profile, signOut, passwordRecovery, role, lang,
    authStatus, retryAuthBootstrap, retryProfileLoad, myPermissions,
  } = useApp();
  // Keep explicit navigation scoped to the profile that created it. A later
  // session on the same workstation must derive its own role-safe landing
  // instead of inheriting the previous user's screen.
  const [navigation, setNavigation] = useState<{
    profileId: string;
    screen: number;
    suggestionDocument?: SuggestionDocumentTarget;
  } | null>(null);
  const [welcomeCompletedFor, setWelcomeCompletedFor] = useState<string | null>(null);

  useEffect(() => {
    if (authStatus !== 'authenticated' || !profile) return;
    const profileId = profile.id;
    const restored = resolveRestoredScreen(profileId, profile.role, myPermissions);
    setNavigation(previous => previous?.profileId === profileId
      ? previous
      : { profileId, screen: restored });
    rememberScreen(profileId, restored, 'replace');

    const onPopState = (event: PopStateEvent) => {
      const next = screenFromPopState(event.state, profileId, profile.role, myPermissions);
      setNavigation({ profileId, screen: next });
      rememberScreen(profileId, next, 'storage-only');
      if (event.state === null || typeof event.state !== 'object') {
        rememberScreen(profileId, next, 'replace');
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [authStatus, profile, myPermissions]);

  // ── Password recovery (from reset email) — takes priority over the app ──
  if (passwordRecovery) {
    return <ResetPasswordScreen />;
  }

  // ── PHASE-B1-AUTH-RESILIENCE ──
  // The session read FAILED: we do not know whether anyone is signed in. This
  // must be said, before the `!session` branch below could otherwise present a
  // login form as if the answer were "nobody" — and before `!authReady`, which
  // would otherwise show the same spinner the failure was meant to end.
  // No sign-out is offered here: there is no established session to end.
  if (authStatus === 'bootstrap_failed') {
    return (
      <AuthRecoveryState
        title={t('auth_boot_failed_title', lang)}
        message={t('auth_boot_failed_msg', lang)}
        onRetry={() => { void retryAuthBootstrap(); }}
      />
    );
  }

  // ── Wait for the session check before deciding login vs app ──
  if (!authReady) {
    return <PhoenixLoadingState fullScreen />;
  }

  if (!session) {
    return <LoginScreen />;
  }

  const welcomeKey = `medistock-phoenix-welcome:${session.user.id}`;
  let welcomeSeen = false;
  try {
    welcomeSeen = window.sessionStorage.getItem(welcomeKey) === 'complete';
  } catch {
    // Privacy-restricted browsers may deny sessionStorage. The in-memory
    // completion state still prevents the sequence from looping.
  }

  // The one sign-out path, shared by the app shell and by the recovery states
  // below — a stranded operator gets exactly the same logout the shell offers,
  // not a weaker copy of it. Moved out of the shell's JSX unchanged.
  const handleLogout = () => {
    try {
      window.sessionStorage.removeItem(welcomeKey);
    } catch {
      // A restricted storage environment needs no cleanup.
    }
    if (profile) clearRememberedScreen(profile.id);
    setWelcomeCompletedFor(null);
    void signOut();
    setNavigation(null);
  };

  // ── PHASE-B1-AUTH-RESILIENCE ──
  // A session exists but its profile is unreadable. This used to fall through
  // to the `!profile` spinner below and stay there forever, with no retry and
  // no way to sign out. It is checked BEFORE the welcome sequence so a stuck
  // operator is not made to sit through an animation first.
  //   • failed  — the read could not complete; retrying is meaningful.
  //   • missing — the read completed and there is no readable profile row;
  //               retry stays available (an administrator may fix it while
  //               this screen is open) but sign-out is the real way out.
  if (authStatus === 'profile_failed' || authStatus === 'profile_missing' || authStatus === 'profile_inactive') {
    const missing = authStatus === 'profile_missing';
    const inactive = authStatus === 'profile_inactive';
    return (
      <AuthRecoveryState
        title={t(inactive ? 'auth_profile_inactive_title' : missing ? 'auth_profile_missing_title' : 'auth_profile_failed_title', lang)}
        message={t(inactive ? 'auth_profile_inactive_msg' : missing ? 'auth_profile_missing_msg' : 'auth_profile_failed_msg', lang)}
        onRetry={() => { void retryProfileLoad(); }}
        onSignOut={handleLogout}
      />
    );
  }

  if (!welcomeSeen && welcomeCompletedFor !== session.user.id) {
    return (
      <PhoenixWelcomeExperience
        onComplete={() => {
          try {
            window.sessionStorage.setItem(welcomeKey, 'complete');
          } catch {
            // See the storage note above; completion remains in memory.
          }
          setWelcomeCompletedFor(session.user.id);
        }}
      />
    );
  }

  // onAuthChange publishes the session before its async profile read finishes.
  // Do not render any role-sensitive screen from AppContext's display fallback:
  // wait for the real profile, then synchronously select the safe landing so
  // outlet_officer never mounts the reports screen, even for one frame.
  //
  // PHASE-B1-AUTH-RESILIENCE-RACE: the shell opens on `authenticated` — which
  // additionally requires the loaded profile to belong to THIS session — and
  // not merely on "a profile object exists". A profile left over from another
  // user is not a licence to render an operational screen.
  if (authStatus !== 'authenticated' || !profile) {
    return <PhoenixLoadingState fullScreen />;
  }

  /**
   * R1.1-U (U-B corrective, C2) — the single screen-authorization choke point.
   *
   * Every way a screen id can arrive converges here: in-session navigation from
   * the Sidebar, Drawer, BottomNav or Command Palette, a restored session, a
   * refresh, the Back button, and any direct screen id. Enforcing the canonical
   * decision at this one place means an unsafe organization-level screen is
   * REFUSED rather than rendered empty, without a per-component gate anywhere.
   *
   * Falling back to the role landing rather than rendering ForbiddenScreen keeps
   * a legitimately-navigating user out of a dead end; the refusal itself is the
   * authorization decision, and it is asserted directly in the tests.
   */
  const requestedScreen = navigation?.profileId === profile.id
    ? navigation.screen
    : resolveRestoredScreen(profile.id, profile.role, myPermissions);
  const screen = isScreenAuthorized(requestedScreen, profile.role, myPermissions)
    ? requestedScreen
    : roleLandingScreen(profile.role);
  const setScreen = (nextScreen: number) => {
    setNavigation({ profileId: profile.id, screen: nextScreen });
    if (isScreenRestorable(nextScreen, profile.role, myPermissions)) {
      rememberScreen(profile.id, nextScreen, 'push');
    }
  };
  const openSuggestionDocument = (target: SuggestionDocumentTarget) => {
    const nextScreen = suggestionDocumentScreen(target);
    setNavigation({
      profileId: profile.id,
      screen: nextScreen,
      suggestionDocument: target,
    });
    if (isScreenRestorable(nextScreen, profile.role, myPermissions)) {
      rememberScreen(profile.id, nextScreen, 'push');
    }
  };

  const screenContent = () => {
    switch (screen) {
      // INVENTORY-CENTER-INTAKE-A: screen 3 was the Availability Editor, which
      // wrote item_availability directly with a hand-picked condition. It is
      // replaced by the Inventory Center, whose only write path is the
      // warehouse ledger (migration 065) — see InventoryCenterScreen.
      case 3:
        return <InventoryCenterScreen
          key={navigation?.suggestionDocument?.documentId ?? 'inventory-center'}
          initialSuggestionDocument={navigation?.suggestionDocument}
        />;
      case 4:  return <RegistryScreen />;
      case 5:  return <MeshScreen onNavigate={setScreen} />;
      case 6:  return <QrScreen />;
      case 7:  return <HealthScreen />;
      case 8:  return <IntakeFrozenScreen onNavigate={setScreen} />;
      // REPORTING-UNIFICATION: screen 9 (Reports) is retired — its Summary
      // tab is a subset of Overview's classification_counts, its
      // Comparison tab is redundant with Institution Status (same RPC), its
      // Global Material Search and Audit tabs both moved into screen 21
      // verbatim. Redirects to Overview, the closest single equivalent.
      case 9:  return <DecisionIntelligenceReportsScreen onNavigate={setScreen} onOpenSuggestionDocument={openSuggestionDocument} initialTab="overview" />;
      case 10: return <MobileCommandScreen onNavigate={setScreen} />;
      // ROLE-REORG-§5: institutions management is platform-admin exclusive; an
      // institution admin gets the same route scoped to "My Organization". Any
      // other role reaching this route directly is refused (403) — the server
      // RLS is the real boundary; this stops a mis-typed URL from rendering.
      case 11:
        return institutionsScreenAccess(role) === false
          ? <ForbiddenScreen />
          : <InstitutionScreen />;
      // REPORTING-UNIFICATION: screen 12 (Status Center) is retired — its
      // entire live-operations view (filters, row actions, quick actions,
      // alerts, activity feed) moved verbatim into screen 21's Materials &
      // Batches tab. Redirects there directly, not to Overview, since that
      // tab is the exact 1:1 continuation of what this screen number used
      // to show.
      case 12: return <DecisionIntelligenceReportsScreen onNavigate={setScreen} onOpenSuggestionDocument={openSuggestionDocument} initialTab="materials" />;
      case 13: return <InterInstitutionAlertsScreen />;
      case 14: return <UserManagementScreen />;
      case 15: return <MyAccountScreen />;
      case 16: return <StatusEditorScreen />;
      case 17:
        return <NetworkManagementScreen
          key={navigation?.suggestionDocument?.documentId ?? 'network-management'}
          initialSuggestionDocument={navigation?.suggestionDocument}
        />;
      // OUTLET-CORRIDOR: the outlet operator's surface — receive, stock, returns,
      // history — scoped to assigned outlets (062), server re-checked per action.
      case 18:
        return <OutletOperationsScreen
          key={navigation?.suggestionDocument?.documentId ?? 'outlet-operations'}
          initialSuggestionDocument={navigation?.suggestionDocument}
          onOpenSuggestionDocument={openSuggestionDocument}
        />;
      // INSTITUTION-LOCAL-PROCUREMENT-087: suppliers, purchase orders,
      // approvals, receiving and supplier returns — scoped to assigned
      // institution warehouses (062), every write a guarded 087 RPC.
      case 19: return <LocalProcurementScreen />;
      // REPORTING-UNIFICATION: screen 20 (Monthly Position) is retired —
      // its full prepare->classify/stocktake->submit->approve+lock->amend
      // workflow moved verbatim into screen 21's Monthly Position tab
      // (every RPC in monthly-status.service.ts, every role gate,
      // unchanged). Redirects there directly, the exact 1:1 continuation.
      case 20: return <DecisionIntelligenceReportsScreen onNavigate={setScreen} onOpenSuggestionDocument={openSuggestionDocument} initialTab="monthly" />;
      // DECISION-INTELLIGENCE-REPORTS-119/REPORTING-UNIFICATION: «مركز
      // التقارير والمواقف» — the single unified reporting/status shell.
      // Executive overview, live institution position, materials &
      // batches (the former Status Center), stock movements, custody
      // chain, differences & corrections, supplementary procurement,
      // monthly position (the former screen 20), audit/sensitive-action
      // log, the official report library, and (super_admin only) global
      // material search — every RPC re-checked server-side, every
      // permission gate unchanged from its original screen.
      case 21: return <DecisionIntelligenceReportsScreen onNavigate={setScreen} onOpenSuggestionDocument={openSuggestionDocument} />;
      // RAC-3: the role-aware Command Center. Reached only by an actor the
      // canonical decision admits (dashboard.view); Migration 199 re-proves
      // that authority server-side on every read, so this route is a UX gate
      // over a boundary the database already enforces.
      case 22: return <CommandCenterScreen onNavigate={setScreen} />;
      // Central dashboard (former screen 2) and any unknown screen number
      // safely redirect to the unified shell — the real-data landing screen.
      default: return <DecisionIntelligenceReportsScreen onNavigate={setScreen} onOpenSuggestionDocument={openSuggestionDocument} />;
    }
  };

  return (
    <PhoenixAppShell
      currentScreen={screen}
      onNavigate={setScreen}
      onLogout={handleLogout}
    >
      {/* PHASE-1-CONTROLLED-RBAC-ACTIVATION-SHADOW-MODE: in 'off'/'shadow' this
          renders screenContent() unchanged and only observes. It gates solely
          under PHOENIX_SCOPED_RBAC_MODE=enforce_super_admin, for super_admin. */}
      <ScreenAuthzGuard screen={screen}>
        {screenContent()}
      </ScreenAuthzGuard>
    </PhoenixAppShell>
  );
}

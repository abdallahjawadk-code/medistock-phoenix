import { useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { institutionsScreenAccess } from '@/shared/authz/screen-access';
import { useApp } from './AppContext';
import { LoginScreen } from '@/features/auth/LoginScreen';
import { PhoenixWelcomeExperience } from '@/features/auth/PhoenixWelcomeExperience';
import { ResetPasswordScreen } from '@/features/auth/ResetPasswordScreen';
import { PhoenixAppShell } from '@/shared/ui/PhoenixAppShell';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { InventoryCenterScreen } from '@/features/inventory/InventoryCenterScreen';
import { RegistryScreen } from '@/features/registry/RegistryScreen';
import { MeshScreen } from '@/features/mesh/MeshScreen';
import { QrScreen } from '@/features/qr/QrScreen';
import { HealthScreen } from '@/features/health/HealthScreen';
import { IntakeFrozenScreen } from '@/features/health/IntakeFrozenScreen';
import { ReportsScreen } from '@/features/reports/ReportsScreen';
import { MobileCommandScreen } from '@/features/mesh/MobileCommandScreen';
import { InstitutionScreen } from '@/features/institutions/InstitutionScreen';
import { StatusCenterScreen } from '@/features/status/StatusCenterScreen';
import { InterInstitutionAlertsScreen } from '@/features/alerts/InterInstitutionAlertsScreen';
import { UserManagementScreen } from '@/features/users/UserManagementScreen';
import { MyAccountScreen } from '@/features/account/MyAccountScreen';
import { StatusEditorScreen } from '@/features/status/StatusEditorScreen';
import { NetworkManagementScreen } from '@/features/network/NetworkManagementScreen';
import { OutletOperationsScreen } from '@/features/outlet/OutletOperationsScreen';
import { LocalProcurementScreen } from '@/features/procurement/LocalProcurementScreen';
import { ScreenAuthzGuard } from '@/shared/authz/ScreenAuthzGuard';

/**
 * QR-BUNDLE-CODE-SPLIT-A: everything that only an authenticated session
 * needs (login, password reset, the app shell, and every screen) lives here
 * so it code-splits into its own chunk, separate from the anonymous public
 * QR route (App.tsx / PublicQrScreen). Moved verbatim out of App.tsx — no
 * auth/session/business logic changed, only the file it lives in.
 */
/** ROLE-REORG-§5: a role-refused screen (e.g. non-admin hitting institutions). */
function ForbiddenScreen() {
  const { lang } = useApp();
  return <PhoenixEmptyState icon="lock" title={t('access_forbidden_title', lang)} description={t('access_forbidden_hint', lang)} />;
}

export function AuthenticatedApp() {
  const { authReady, session, signOut, passwordRecovery, role } = useApp();
  // PRODUCTION-READINESS-CLEANUP-A: the central dashboard (screen 2) was
  // removed from navigation and no longer renders; Status Center (screen 12)
  // is the real-data landing screen.
  const [screen, setScreen] = useState(12);
  const [welcomeCompletedFor, setWelcomeCompletedFor] = useState<string | null>(null);

  // ── Password recovery (from reset email) — takes priority over the app ──
  if (passwordRecovery) {
    return <ResetPasswordScreen />;
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

  const screenContent = () => {
    switch (screen) {
      // INVENTORY-CENTER-INTAKE-A: screen 3 was the Availability Editor, which
      // wrote item_availability directly with a hand-picked condition. It is
      // replaced by the Inventory Center, whose only write path is the
      // warehouse ledger (migration 065) — see InventoryCenterScreen.
      case 3:  return <InventoryCenterScreen />;
      case 4:  return <RegistryScreen />;
      case 5:  return <MeshScreen onNavigate={setScreen} />;
      case 6:  return <QrScreen />;
      case 7:  return <HealthScreen />;
      case 8:  return <IntakeFrozenScreen onNavigate={setScreen} />;
      case 9:  return <ReportsScreen />;
      case 10: return <MobileCommandScreen onNavigate={setScreen} />;
      // ROLE-REORG-§5: institutions management is platform-admin exclusive; an
      // institution admin gets the same route scoped to "My Organization". Any
      // other role reaching this route directly is refused (403) — the server
      // RLS is the real boundary; this stops a mis-typed URL from rendering.
      case 11:
        return institutionsScreenAccess(role) === false
          ? <ForbiddenScreen />
          : <InstitutionScreen />;
      case 12: return <StatusCenterScreen onNavigate={setScreen} />;
      case 13: return <InterInstitutionAlertsScreen />;
      case 14: return <UserManagementScreen />;
      case 15: return <MyAccountScreen />;
      case 16: return <StatusEditorScreen />;
      case 17: return <NetworkManagementScreen />;
      // OUTLET-CORRIDOR: the outlet operator's surface — receive, stock, returns,
      // history — scoped to assigned outlets (062), server re-checked per action.
      case 18: return <OutletOperationsScreen />;
      // INSTITUTION-LOCAL-PROCUREMENT-087: suppliers, purchase orders,
      // approvals, receiving and supplier returns — scoped to assigned
      // institution warehouses (062), every write a guarded 087 RPC.
      case 19: return <LocalProcurementScreen />;
      // Central dashboard (former screen 2) and any unknown screen number
      // safely redirect to Status Center — the real-data landing screen.
      default: return <StatusCenterScreen onNavigate={setScreen} />;
    }
  };

  return (
    <PhoenixAppShell
      currentScreen={screen}
      onNavigate={setScreen}
      onLogout={() => {
        try {
          window.sessionStorage.removeItem(welcomeKey);
        } catch {
          // A restricted storage environment needs no cleanup.
        }
        setWelcomeCompletedFor(null);
        void signOut();
        setScreen(12);
      }}
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

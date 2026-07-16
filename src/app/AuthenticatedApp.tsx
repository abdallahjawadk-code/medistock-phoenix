import { useState } from 'react';
import { useApp } from './AppContext';
import { LoginScreen } from '@/features/auth/LoginScreen';
import { ResetPasswordScreen } from '@/features/auth/ResetPasswordScreen';
import { PhoenixAppShell } from '@/shared/ui/PhoenixAppShell';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { EditorScreen } from '@/features/editor/EditorScreen';
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
import { ScreenAuthzGuard } from '@/shared/authz/ScreenAuthzGuard';

/**
 * QR-BUNDLE-CODE-SPLIT-A: everything that only an authenticated session
 * needs (login, password reset, the app shell, and every screen) lives here
 * so it code-splits into its own chunk, separate from the anonymous public
 * QR route (App.tsx / PublicQrScreen). Moved verbatim out of App.tsx — no
 * auth/session/business logic changed, only the file it lives in.
 */
export function AuthenticatedApp() {
  const { authReady, session, signOut, passwordRecovery } = useApp();
  // PRODUCTION-READINESS-CLEANUP-A: the central dashboard (screen 2) was
  // removed from navigation and no longer renders; Status Center (screen 12)
  // is the real-data landing screen.
  const [screen, setScreen] = useState(12);

  // ── Password recovery (from reset email) — takes priority over the app ──
  if (passwordRecovery) {
    return <ResetPasswordScreen />;
  }

  // ── Wait for the session check before deciding login vs app ──
  if (!authReady) {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <PhoenixLoadingState />
      </div>
    );
  }

  if (!session) {
    return <LoginScreen />;
  }

  const screenContent = () => {
    switch (screen) {
      case 3:  return <EditorScreen />;
      case 4:  return <RegistryScreen />;
      case 5:  return <MeshScreen onNavigate={setScreen} />;
      case 6:  return <QrScreen />;
      case 7:  return <HealthScreen />;
      case 8:  return <IntakeFrozenScreen onNavigate={setScreen} />;
      case 9:  return <ReportsScreen />;
      case 10: return <MobileCommandScreen onNavigate={setScreen} />;
      case 11: return <InstitutionScreen />;
      case 12: return <StatusCenterScreen onNavigate={setScreen} />;
      case 13: return <InterInstitutionAlertsScreen />;
      case 14: return <UserManagementScreen />;
      case 15: return <MyAccountScreen />;
      case 16: return <StatusEditorScreen />;
      // Central dashboard (former screen 2) and any unknown screen number
      // safely redirect to Status Center — the real-data landing screen.
      default: return <StatusCenterScreen onNavigate={setScreen} />;
    }
  };

  return (
    <PhoenixAppShell
      currentScreen={screen}
      onNavigate={setScreen}
      onLogout={() => { void signOut(); setScreen(12); }}
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

import { useState } from 'react';
import { AppProvider, useApp } from './AppContext';
import { LoginScreen } from '@/features/auth/LoginScreen';
import { ResetPasswordScreen } from '@/features/auth/ResetPasswordScreen';
import { PublicQrScreen } from '@/features/qr/PublicQrScreen';
import { PhoenixAppShell } from '@/shared/ui/PhoenixAppShell';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { DashboardScreen } from '@/features/dashboard/DashboardScreen';
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

/** Read a public QR handle from the URL (?qid=… or ?token=…). Anon, no auth. */
function publicQrId(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('qid') ?? params.get('token');
}

function AppInner() {
  const { authReady, session, signOut, passwordRecovery } = useApp();
  const [screen, setScreen] = useState(2);

  // ── Anon public QR scan view — bypasses auth entirely ──
  const qid = publicQrId();
  if (qid) {
    return <PublicQrScreen publicId={qid} />;
  }

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
      case 2:  return <DashboardScreen onNavigate={setScreen} />;
      case 3:  return <EditorScreen />;
      case 4:  return <RegistryScreen />;
      case 5:  return <MeshScreen onNavigate={setScreen} />;
      case 6:  return <QrScreen />;
      case 7:  return <HealthScreen />;
      case 8:  return <IntakeFrozenScreen onNavigate={setScreen} />;
      case 9:  return <ReportsScreen />;
      case 10: return <MobileCommandScreen onNavigate={setScreen} />;
      case 11: return <InstitutionScreen />;
      case 12: return <StatusCenterScreen />;
      case 13: return <InterInstitutionAlertsScreen />;
      default: return <DashboardScreen onNavigate={setScreen} />;
    }
  };

  return (
    <PhoenixAppShell
      currentScreen={screen}
      onNavigate={setScreen}
      onLogout={() => { void signOut(); setScreen(2); }}
    >
      {screenContent()}
    </PhoenixAppShell>
  );
}

export function App() {
  return (
    <AppProvider>
      <AppInner />
    </AppProvider>
  );
}

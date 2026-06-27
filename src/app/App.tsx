import { useState } from 'react';
import { AppProvider } from './AppContext';
import { LoginScreen } from '@/features/auth/LoginScreen';
import { PhoenixAppShell } from '@/shared/ui/PhoenixAppShell';
import { DashboardScreen } from '@/features/dashboard/DashboardScreen';
import { EditorScreen } from '@/features/editor/EditorScreen';
import { RegistryScreen } from '@/features/registry/RegistryScreen';
import { MeshScreen } from '@/features/mesh/MeshScreen';
import { QrScreen } from '@/features/qr/QrScreen';
import { HealthScreen } from '@/features/health/HealthScreen';
import { IntakeFrozenScreen } from '@/features/health/IntakeFrozenScreen';
import { ReportsScreen } from '@/features/reports/ReportsScreen';
import { MobileCommandScreen } from '@/features/mesh/MobileCommandScreen';

function AppInner() {
  const [screen, setScreen] = useState(1);

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
      default: return <DashboardScreen onNavigate={setScreen} />;
    }
  };

  if (screen === 1) {
    return <LoginScreen onLogin={() => setScreen(2)} />;
  }

  return (
    <PhoenixAppShell
      currentScreen={screen}
      onNavigate={setScreen}
      onLogout={() => setScreen(1)}
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

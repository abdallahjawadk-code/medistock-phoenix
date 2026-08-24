import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');

const consumers = [
  'shared/ui/PhoenixAppShell.tsx',
  'features/mesh/MeshScreen.tsx',
  'features/qr/QrScreen.tsx',
  'features/health/HealthScreen.tsx',
  'features/reports/ReportsScreen.tsx',
  'features/dashboard/DashboardScreen.tsx',
  'features/inventory/InventoryIntelligenceSummary.tsx',
  'features/status/StatusCenterScreen.tsx',
  'features/users/UserManagementScreen.tsx',
  'features/reports/GlobalMaterialSearchPanel.tsx',
  'features/institutions/InstitutionScreen.tsx',
  'features/alerts/InterInstitutionAlertsScreen.tsx',
];

describe('mobile viewport convergence', () => {
  it('uses one live responsive hook across the shell and feature screens', () => {
    for (const path of consumers) {
      const src = read(path);
      expect(src, path).toContain('useIsMobileViewport');
      expect(src, path).not.toMatch(/window\.innerWidth\s*<\s*768/);
    }
  });

  it('keeps the JS breakpoint exactly aligned with the CSS 767px mobile boundary', () => {
    const hook = read('shared/ui/useResponsiveViewport.ts');
    expect(hook).toContain('MOBILE_VIEWPORT_MAX_PX = 767');
    expect(hook).toContain('matchMedia');
    expect(hook).toContain("addEventListener('change'");
    expect(hook).toContain("window.addEventListener('resize'");
  });
});

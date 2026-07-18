import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const icon = read('../PhoenixIcon.tsx');
const screenHeader = read('../PhoenixScreenHeader.tsx');
const notice = read('../PhoenixNotice.tsx');
const dialog = read('../PhoenixDialog.tsx');
const css = read('../../lib/phoenix-nexus-w2.css');
const publicQr = read('../../../features/qr/PublicQrScreen.tsx');
const reset = read('../../../features/auth/ResetPasswordScreen.tsx');

const SCREEN_COMPONENTS = [
  '../../../features/editor/EditorScreen.tsx',
  '../../../features/registry/RegistryScreen.tsx',
  '../../../features/mesh/MeshScreen.tsx',
  '../../../features/mesh/MobileCommandScreen.tsx',
  '../../../features/health/HealthScreen.tsx',
  '../../../features/health/IntakeFrozenScreen.tsx',
  '../../../features/reports/ReportsScreen.tsx',
  '../../../features/institutions/InstitutionScreen.tsx',
  '../../../features/alerts/InterInstitutionAlertsScreen.tsx',
  '../../../features/users/UserManagementScreen.tsx',
  '../../../features/account/MyAccountScreen.tsx',
  '../../../features/qr/QrScreen.tsx',
  '../../../features/status/StatusEditorScreen.tsx',
];

const ACTION_SURFACES = [
  '../MobilePrintFallbackModal.tsx',
  '../WhatsAppContactButton.tsx',
  '../../../features/status/MovementHistoryModal.tsx',
  '../../../features/status/MovementReportSection.tsx',
  '../../../features/status/OutletAvailabilityReportModal.tsx',
  '../../../features/status/OutletMaterialGroups.tsx',
  '../../../features/inventory/InventoryIntelligencePanel.tsx',
  '../../../features/reports/GlobalMaterialSearchPanel.tsx',
  '../../../features/institutions/InstitutionScreen.tsx',
  '../../../features/users/UserManagementScreen.tsx',
  '../../../features/qr/QrScreen.tsx',
];

describe('Phoenix Nexus final-cinematic visual contract', () => {
  it('uses one accessible screen identity component across every secondary product surface', () => {
    expect(screenHeader).toContain('<header');
    expect(screenHeader).toContain('premium-page-header');
    expect(screenHeader).toContain('<PhoenixIcon');
    for (const path of SCREEN_COMPONENTS) {
      expect(read(path), path).toContain('<PhoenixScreenHeader');
    }
  });

  it('ships first-party editable source artwork with no remote dependency', () => {
    const svgPath = new URL('../../../../public/phoenix-circuit-field.svg', import.meta.url);
    expect(existsSync(svgPath)).toBe(true);
    const svg = readFileSync(svgPath, 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox="0 0 1600 900"');
    expect(svg).not.toMatch(/(?:href|url\()\s*=?["']?https?:\/\//i);
    expect(css).toContain("url('/phoenix-circuit-field.svg')");
  });

  it('keeps iconography code-native, semantic and accessible', () => {
    for (const name of ['health', 'info', 'location', 'package', 'shield', 'clock', 'download', 'trash', 'eye', 'phone', 'print', 'refresh', 'settings', 'star']) {
      expect(icon).toContain(`case '${name}'`);
    }
    expect(icon).toContain('viewBox="0 0 24 24"');
    expect(icon).toContain('stroke="currentColor"');
    expect(icon).toContain("role={title ? 'img' : undefined}");
    expect(notice).toContain("role={tone === 'danger' ? 'alert' : 'note'}");
  });

  it('uses the source icon set instead of emoji across action-heavy surfaces', () => {
    for (const path of ACTION_SURFACES) {
      expect(read(path), path).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('keeps shared dialogs keyboard-contained and restores focus', () => {
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain('focusableSelector');
    expect(dialog).toContain("e.key !== 'Tab'");
    expect(dialog).toContain('previousFocus?.focus()');
  });

  it('gives anonymous recovery and QR routes the same Phoenix identity without exposing internals', () => {
    expect(reset).toContain('nexus-recovery-shell');
    expect(reset).toContain('<PhoenixMark');
    expect(reset).toContain("name={theme === 'dark' ? 'sun' : 'moon'}");
    expect(publicQr).toContain('nexus-public-qr');
    expect(publicQr).toContain('<PhoenixMark');
    expect(publicQr).toContain("message={t('qr_public_load_error', lang)}");
    expect(publicQr).not.toContain('message={error}');
  });

  it('documents the screen and asset acceptance matrices', () => {
    const screenMatrix = read('../../../../docs/design/phoenix-final-cinematic-screen-matrix.md');
    const assetManifest = read('../../../../docs/design/phoenix-asset-manifest.md');
    expect(screenMatrix).toContain('Screen 12 (Status Center) remains the real landing screen');
    expect(screenMatrix).toContain('WebGL');
    expect(assetManifest).toContain('public/app-icon.svg');
    expect(assetManifest).toContain('PhoenixIcon.tsx');
    expect(assetManifest).toContain('No additional official logo');
  });

  it('keeps the final-cinematic layer presentation-only', () => {
    for (const source of [icon, screenHeader, notice, css]) {
      expect(source).not.toMatch(/service_role|auth\.admin|security definer/i);
      expect(source).not.toMatch(/\.(insert|update|delete|upsert)\s*\(/);
    }
  });
});

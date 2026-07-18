import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const css = read('../../lib/phoenix-nexus-w2.css');
const globalCss = read('../../lib/global.css');
const shell = read('../PhoenixAppShell.tsx');
const statusCenter = read('../../../features/status/StatusCenterScreen.tsx');
const network = read('../../../features/network/NetworkManagementScreen.tsx');
const topology = read('../../../features/network/NetworkTopologyStage.tsx');
const dialog = read('../PhoenixDialog.tsx');
const orgScope = read('../PhoenixOrgScope.tsx');
const toast = read('../PhoenixToast.tsx');

describe('Phoenix Nexus W2 product-wide visual contract', () => {
  it('wraps every authorized screen in one screen-aware workspace without changing routing', () => {
    expect(shell).toContain('className="nexus-workspace"');
    expect(shell).toContain('data-screen={currentScreen}');
    expect(shell).toContain('{children}');
    expect(shell).toContain('href="#phoenix-workspace"');
    expect(shell).toContain('currentScreen={currentScreen}');
    expect(shell).toContain('onNavigate={onNavigate}');
  });

  it('declares a visual accent contract for every live authenticated screen', () => {
    for (let screen = 3; screen <= 17; screen += 1) {
      expect(css).toContain(`.nexus-workspace[data-screen="${screen}"]`);
    }
    expect(globalCss).toContain("@import './phoenix-nexus-w2.css';");
  });

  it('upgrades the real Status Center landing screen without adding another dashboard route', () => {
    expect(statusCenter).toContain('premium-page premium-dashboard nexus-dashboard');
    expect(statusCenter).toContain('nexus-status-matrix');
    expect(statusCenter).toContain('nexus-filter-console');
    expect(statusCenter).toContain('getAvailabilityByOrg');
    expect(statusCenter).toContain('InventoryIntelligencePanel');
    expect(statusCenter).not.toContain('case 2:');
  });

  it('covers shared forms, tables, dialogs, toasts and organization scope', () => {
    expect(css).toContain('.nexus-workspace table');
    expect(css).toContain('.nexus-dialog__backdrop');
    expect(css).toContain('.nexus-toast');
    expect(css).toContain('.nexus-org-scope');
    expect(dialog).toContain('className="nexus-dialog"');
    expect(dialog).toContain('aria-labelledby={titleId}');
    expect(orgScope).toContain('PhoenixIcon name="scope"');
    expect(toast).toContain('PhoenixIcon name="check"');
  });

  it('keeps the network twin on existing RLS-protected reads and adds complete interaction states', () => {
    expect(network).toContain('getAllWarehouses()');
    expect(network).toContain('getSupplyRoutes()');
    expect(network).toContain('getPointsByOrg(orgId)');
    expect(topology).toContain('topology.nodes.map');
    expect(topology).not.toContain('topology.nodes.slice');
    expect(topology).toContain('onPointerEnter={() => setSelectedId(node.id)}');
    expect(topology).toContain('onFocus={() => setSelectedId(node.id)}');
    expect(topology).toContain('aria-pressed={selectedId === node.id}');
    expect(topology).not.toMatch(/\.(insert|update|delete|upsert)\s*\(/);
  });

  it('pauses GPU animation when the document is hidden and retains safe fallbacks', () => {
    expect(topology).toContain('document.hidden');
    expect(topology).toContain("document.addEventListener('visibilitychange'");
    expect(topology).toContain("document.removeEventListener('visibilitychange'");
    expect(topology).toContain("canvas.getContext('webgl'");
    expect(topology).toContain('setWebglReady(false)');
    expect(topology).toContain('Math.min(window.devicePixelRatio || 1, 1.6)');
  });

  it('ships mobile, tablet, dark, reduced-motion, high-contrast and print contracts', () => {
    expect(css).toContain('@container phoenix-workspace (max-width: 1120px)');
    expect(css).toContain('@media (max-width: 767px)');
    expect(css).toContain('@media (max-width: 420px)');
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain('@media print');
  });

  it('keeps the W2 layer presentation-only', () => {
    expect(css).not.toMatch(/supabase|service_role|security definer|\brls\b/i);
    expect(css).not.toMatch(/\.(insert|update|delete|upsert)\s*\(/);
    expect(shell).not.toContain('myPermissions');
  });
});

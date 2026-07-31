import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import pkg from '../../../../package.json';

const SRC = join(__dirname, '../../../');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');

describe('Phase A inventory + network/transfer workspaces (A4) presentation contract', () => {
  const main = read('main.tsx');
  const css = read('shared/lib/phase-a-inventory-transfers.css');
  const inventoryCenter = read('features/inventory/InventoryCenterScreen.tsx');
  const networkManagement = read('features/network/NetworkManagementScreen.tsx');
  const authenticatedApp = read('app/AuthenticatedApp.tsx');

  it('loads the inventory-transfers layer after every prior Phase A layer', () => {
    const foundationIndex = main.indexOf("import '@/shared/lib/phase-a-foundation.css';");
    const authIndex = main.indexOf("import '@/shared/lib/phase-a-auth.css';");
    const ccIndex = main.indexOf("import '@/shared/lib/phase-a-command-center.css';");
    const itIndex = main.indexOf("import '@/shared/lib/phase-a-inventory-transfers.css';");

    expect(foundationIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeGreaterThan(foundationIndex);
    expect(ccIndex).toBeGreaterThan(authIndex);
    expect(itIndex).toBeGreaterThan(ccIndex);
  });

  it('gates every real selector behind the Phase A document marker', () => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const withoutKeyframeSteps = withoutComments.replace(/@keyframes[^{]*\{[\s\S]*?\n\}/g, '');
    const selectorLines = withoutKeyframeSteps
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.endsWith('{') && !l.startsWith('@'));
    expect(selectorLines.length).toBeGreaterThan(0);
    const ungated = selectorLines.filter(sel => !sel.includes("html[data-phoenix-ui-phase='a']"));
    expect(ungated).toEqual([]);
  });

  it('touches only the Inventory Center and Network Management screens via one shared class hook', () => {
    expect(css).toContain('.nexus-inventory-transfers');
    expect(inventoryCenter).toContain('nexus-inventory-transfers nexus-inventory-transfers--center');
    expect(networkManagement).toContain('nexus-inventory-transfers nexus-inventory-transfers--network');
  });

  it('is a pure CSS file: no imports, no Supabase/RPC access, no CDN or external URL', () => {
    expect(css).not.toMatch(/@import/);
    expect(css).not.toContain('supabase');
    expect(css).not.toContain('.rpc(');
    expect(css).not.toMatch(/https?:\/\//);
    expect(css).not.toContain('100vw');
  });

  it('never reaches Supabase directly from the two screen roots it styles (service-layer only)', () => {
    expect(inventoryCenter).not.toContain("from '@/shared/supabase/client'");
    expect(networkManagement).not.toContain("from '@/shared/supabase/client'");
  });

  it('adds no new runtime or dev dependency', () => {
    const deps = Object.keys(pkg.dependencies).sort();
    const devDeps = Object.keys(pkg.devDependencies).sort();
    expect(deps).toEqual([
      '@fontsource-variable/dm-sans', '@fontsource-variable/inter', '@fontsource-variable/noto-sans-arabic',
      '@fontsource/ibm-plex-sans-arabic', '@react-three/fiber', '@supabase/supabase-js', 'exceljs',
      'qrcode', 'react', 'react-dom', 'tesseract.js', 'three',
    ]);
    expect(devDeps).toEqual([
      '@testing-library/jest-dom', '@testing-library/react', '@types/node', '@types/pg', '@types/qrcode',
      '@types/react', '@types/react-dom', '@types/three', '@typescript-eslint/eslint-plugin',
      '@typescript-eslint/parser', '@vitejs/plugin-react', 'eslint', 'jsdom', 'pg', 'playwright-core',
      'sharp', 'typescript', 'vite', 'vitest',
    ]);
  });

  it('uses only logical (RTL-safe) direction properties, never a hardcoded left/right side', () => {
    expect(css).not.toMatch(/[^-](left|right)\s*:/);
    expect(css).toMatch(/inset-inline/);
  });

  it('provides desktop and mobile responsive behavior', () => {
    expect(css).toContain('@media (max-width: 767px)');
  });

  it('removes nonessential motion under reduced-motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{[^}]*\.nexus-inventory-transfers\s*\{[^}]*animation:\s*none/);
  });

  it('never mentions a database migration file', () => {
    expect(css).not.toMatch(/supabase\/migrations/);
    expect(inventoryCenter).not.toMatch(/supabase\/migrations/);
    expect(networkManagement).not.toMatch(/supabase\/migrations/);
  });

  // ── Domain boundary guards specific to A4 (owner instructions: no data/RBAC/
  // routing/business-logic changes) ─────────────────────────────────────────

  it('keeps the Inventory Center on its existing warehouse-ledger write path (065), never a direct availability write', () => {
    expect(inventoryCenter).toContain('getWarehouseStock(');
    expect(inventoryCenter).toContain('receiveWarehouseStock(');
    expect(inventoryCenter).toContain('applyWarehouseStockMovement(');
    expect(inventoryCenter).toContain('requestWarehouseStockCorrection(');
    expect(inventoryCenter).not.toMatch(/\.rpc\(\s*['"]phoenix_upsert_availability/);
  });

  it('keeps Network Management on its existing route-free direct-supply RPCs (077), never a legacy supply-route write', () => {
    expect(networkManagement).toContain('getAllWarehouses(');
    expect(networkManagement).toContain('getSupplyRoutes(');
    expect(networkManagement).toContain('assignProfileScope(');
    expect(networkManagement).toContain('revokeProfileScope(');
  });

  it('keeps every existing permission gate in both screens untouched', () => {
    expect(inventoryCenter).toContain("myPermissions.has('warehouse_transfer.receive')");
    expect(inventoryCenter).toContain("myPermissions.has('warehouse_dispatch.create')");
    expect(networkManagement).toContain("myPermissions.has('users.edit_scope')");
    expect(networkManagement).toContain("myPermissions.has('warehouse_transfer.send')");
  });

  it('leaves screen routing (screen 3 / screen 17) and their component names unchanged', () => {
    expect(authenticatedApp).toContain('case 3:');
    expect(authenticatedApp).toContain('<InventoryCenterScreen');
    expect(authenticatedApp).toContain('case 17:');
    expect(authenticatedApp).toContain('<NetworkManagementScreen');
  });

  it('adds no wrapping element: both screens keep their original dir={dir} root, only className is added', () => {
    expect(inventoryCenter).toMatch(/<div dir=\{dir\} className="nexus-inventory-transfers nexus-inventory-transfers--center">/);
    expect(networkManagement).toMatch(/<div dir=\{dir\} className="nexus-inventory-transfers nexus-inventory-transfers--network">/);
  });
});

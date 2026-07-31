/**
 * SCREEN 18 — Outlet Operations wiring contract.
 *
 * Static scans (no DOM test env) prove the screen is routed, reachable from
 * every navigation surface, gated by scope (never a raw role name), and hosts
 * no free-text / OCR / manual-balance path. Screens 3–17 and existing route
 * contracts are left untouched.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const app = read('src', 'app', 'AuthenticatedApp.tsx');
const sidebar = read('src', 'shared', 'ui', 'PhoenixSidebar.tsx');
const drawer = read('src', 'shared', 'ui', 'PhoenixMobileDrawer.tsx');
const palette = read('src', 'shared', 'ui', 'CommandPalette.tsx');
const screen = read('src', 'features', 'outlet', 'OutletOperationsScreen.tsx');
const strings = read('src', 'shared', 'i18n', 'strings.ts');

describe('the route is wired without disturbing screens 3-17', () => {
  it('case 18 renders OutletOperationsScreen', () => {
    expect(app).toMatch(/case 18:\s*return <OutletOperationsScreen[\s\S]*?initialSuggestionDocument=/);
    expect(app).toContain("import { OutletOperationsScreen } from '@/features/outlet/OutletOperationsScreen'");
  });

  it('leaves the existing screen routes intact', () => {
    for (const c of ['case 3:', 'case 11:', 'case 12:', 'case 17:']) {
      expect(app).toContain(c);
    }
  });

  it('stays inside the ScreenAuthzGuard wrapper', () => {
    expect(app).toContain('<ScreenAuthzGuard screen={screen}>');
  });
});

describe('the screen is reachable from every navigation surface', () => {
  it('appears in the sidebar, the mobile drawer, and the command palette', () => {
    for (const nav of [sidebar, drawer, palette]) {
      expect(nav).toContain('screen: 18');
      expect(nav).toContain("labelKey: 'nav_outlet_ops'");
    }
  });
});

describe('visibility is by scope, never a raw role name', () => {
  it('the nav item carries no role-name gate', () => {
    const item = sidebar.slice(sidebar.indexOf('screen: 18'), sidebar.indexOf('screen: 18') + 120);
    expect(item).not.toMatch(/role ===|point_operator|outlet_officer|super_admin/);
  });

  it('the screen self-gates on the profile 062 outlet assignments', () => {
    const code = stripComments(screen);
    expect(code).toContain('manageableOutlets');
    expect(code).toContain("t('or_no_outlet_scope'");
    expect(code).not.toMatch(/role === 'point_operator'|role === 'outlet/);
  });
});

describe('the four tabs exist and host no unsafe path', () => {
  it('names all four tabs', () => {
    for (const key of ['or_tab_incoming', 'or_tab_stock', 'or_tab_returns', 'or_tab_history']) {
      expect(screen).toContain(`'${key}'`);
    }
  });

  it('mounts the receive and return composers and read-only tabs', () => {
    expect(screen).toContain('<OutletIncomingSupplies');
    expect(screen).toContain('<OutletReturnComposer');
    expect(screen).toContain('getOutletStock(');
    expect(screen).toContain('getOutletStockMovements(');
  });

  it('offers a canonical receipt built ONLY from freshly reloaded server rows', () => {
    const code = stripComments(screen);
    expect(code).toContain('<MovementDocumentActions');
    expect(code).toContain('buildOutletReturnRequestReceipt(');
    // The receipt is keyed to the created request id and reloads server rows —
    // it is never built from the local draft.
    expect(code).toContain('getOutletReturnRequests(');
    expect(code).toContain('getOutletReturnRequestLines(created)');
  });

  it('creates no stock, uses no OCR, and edits no balance directly', () => {
    const code = stripComments(screen);
    for (const forbidden of [
      'receiveWarehouseStock', 'applyWarehouseStockMovement', 'phoenix_receive_warehouse_stock',
      'Ocr', 'OCR', 'set_exact', '.insert(', '.update(', '.upsert(',
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });
});

describe('every new i18n key is bilingual', () => {
  it('defines ar and en for each nav/screen key', () => {
    for (const key of [
      'nav_outlet_ops', 'or_screen_title', 'or_screen_sub', 'or_tab_incoming',
      'or_tab_stock', 'or_tab_returns', 'or_tab_history', 'or_no_outlet_scope',
      'or_select_outlet', 'or_stock_none', 'or_history_none',
    ]) {
      const line = strings.split('\n').find(l => l.trimStart().startsWith(`${key}:`));
      expect(line, key).toBeTruthy();
      expect(line, `${key} ar`).toMatch(/ar:\s*'[^']+'/);
      expect(line, `${key} en`).toMatch(/en:\s*'[^']+'/);
    }
  });
});

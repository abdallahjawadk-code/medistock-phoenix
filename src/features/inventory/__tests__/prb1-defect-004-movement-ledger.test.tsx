/**
 * @vitest-environment jsdom
 *
 * PRB-1 · UAT-DEFECT-004 — THE MOVEMENT LEDGER MUST NEVER SAY "NO MOVEMENTS"
 * ABOUT A READ IT COULD NOT PERFORM.
 *
 * Two independent faults produced one operationally dangerous screen, and this
 * suite pins both of them, because either one alone re-creates the defect.
 *
 *   1. THE READ CONTRACT. getWarehouseStockMovements projected
 *      quantity_before / quantity_delta / quantity_after / notes /
 *      actor_name_snapshot. Migration 060 created none of those: the ledger's
 *      on-hand triple is on_hand_before / on_hand_delta / on_hand_after, the
 *      actor column is actor_name, and there is no notes column. PostgREST
 *      refused the whole read with 42703 — so the read failed for EVERY batch,
 *      populated or not.
 *
 *   2. THE STATE MACHINE. The view rendered
 *      `loading ? spinner : rows.length === 0 ? empty : list`, which has no
 *      branch for a failed read. `movements.data` stays null on error, so
 *      `(data ?? []).length === 0` was true and the operator was told there
 *      had been no stock movement. For a controlled-substance ledger that is
 *      an assertion of fact that was never established.
 *
 * The projection proof reads migration 060's own CREATE TABLE rather than a
 * hardcoded list, so it stays true if the ledger schema legitimately changes —
 * it asserts AGREEMENT between client and schema, not one frozen column set.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WarehouseStockBatch } from '@/features/network/network.service';

const ROOT = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const SERVICE_SRC = read('src/features/inventory/warehouse-intake.service.ts');
const SCREEN_SRC = read('src/features/inventory/InventoryCenterScreen.tsx');
const M060 = read('supabase/migrations/060_phoenix_warehouse_foundation.sql');

// ───────────────────────────────────────────────────────────────────────────
// 1. THE READ CONTRACT: every projected column exists on the real table.
// ───────────────────────────────────────────────────────────────────────────

/** Column names migration 060's CREATE TABLE declares for the ledger. */
function ledgerColumnsFrom060(): Set<string> {
  const start = M060.indexOf('CREATE TABLE IF NOT EXISTS public.warehouse_stock_movements');
  expect(start, 'migration 060 must still create warehouse_stock_movements').toBeGreaterThan(-1);
  const body = M060.slice(start, M060.indexOf('\n);', start));
  const cols = new Set<string>();
  for (const line of body.split('\n').slice(1)) {
    const m = /^\s{2}([a-z][a-z0-9_]*)\s{2,}/.exec(line);
    if (m && !/^(constraint|check|foreign|primary|unique)$/i.test(m[1])) cols.add(m[1]);
  }
  return cols;
}

/** Columns any later migration ADDs to the same table. */
function ledgerColumnsAdded(): Set<string> {
  const added = new Set<string>();
  for (let n = 61; n <= 200; n++) {
    const num = String(n).padStart(3, '0');
    let sql = '';
    try {
      const dir = join(ROOT, 'supabase/migrations');
      const name = readdirSync(dir).find(f => f.startsWith(`${num}_`) && f.endsWith('.sql'));
      if (!name) continue;
      sql = readFileSync(join(dir, name), 'utf8');
    } catch { continue; }
    const re = /ALTER TABLE\s+public\.warehouse_stock_movements([\s\S]*?);/g;
    for (const m of sql.matchAll(re)) {
      for (const a of m[1].matchAll(/ADD COLUMN(?: IF NOT EXISTS)?\s+([a-z][a-z0-9_]*)/g)) added.add(a[1]);
    }
  }
  return added;
}

/** The column list inside getWarehouseStockMovements' own .select(). */
function projectedColumns(): string[] {
  const fn = SERVICE_SRC.slice(SERVICE_SRC.indexOf('export async function getWarehouseStockMovements'));
  const sel = /\.from\('warehouse_stock_movements'\)\s*\.select\(`([\s\S]*?)`\)/.exec(fn);
  expect(sel, 'the ledger read must still be a .select() on warehouse_stock_movements').not.toBeNull();
  return sel![1].split(',').map(s => s.trim()).filter(Boolean);
}

describe('UAT-DEFECT-004 · the ledger read projects only columns the ledger actually has', () => {
  it('every projected column is declared by migration 060 or added by a later migration', () => {
    const declared = new Set([...ledgerColumnsFrom060(), ...ledgerColumnsAdded()]);
    expect(declared.size).toBeGreaterThan(10);
    const unknown = projectedColumns().filter(c => !declared.has(c));
    expect(unknown, `projected columns absent from the schema: ${unknown.join(', ')}`).toEqual([]);
  });

  it('the four columns that produced the 42703 are gone from the projection', () => {
    const projected = projectedColumns();
    for (const dead of ['quantity_before', 'quantity_delta', 'quantity_after', 'notes', 'actor_name_snapshot']) {
      expect(projected, `${dead} does not exist on warehouse_stock_movements`).not.toContain(dead);
    }
  });

  it('the on-hand triple and the actor column are the ones the ledger keeps', () => {
    const projected = projectedColumns();
    for (const live of ['on_hand_before', 'on_hand_delta', 'on_hand_after', 'actor_name']) {
      expect(projected).toContain(live);
    }
  });

  it('a failed read is raised, never flattened into an empty result', () => {
    const fn = SERVICE_SRC.slice(SERVICE_SRC.indexOf('export async function getWarehouseStockMovements'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toContain('if (error) throw error;');
    // The one legitimate [] return is the unconfigured-client guard, which is
    // not a read at all.
    const emptyReturns = [...body.matchAll(/return \[\];/g)].length;
    expect(emptyReturns).toBe(1);
    expect(body.indexOf('return [];')).toBeLessThan(body.indexOf('.from('));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. THE STATE MACHINE: loading / error / empty / populated are four states.
// ───────────────────────────────────────────────────────────────────────────

const movementsMock = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('@/app/AppContext', () => ({
  useApp: () => ({
    lang: 'en' as const, dir: 'ltr' as const, activeOrgId: 'org-1',
    role: 'central_warehouse_manager', myPermissions: new Set<string>(), profile: { id: 'p1', role: 'central_warehouse_manager' },
  }),
  PhoenixOrgScope: () => null,
}));
vi.mock('../warehouse-intake.service', async (orig) => ({
  ...(await orig<typeof import('../warehouse-intake.service')>()),
  getWarehouseStockMovements: (...a: unknown[]) => movementsMock.fn(...a),
}));
vi.mock('@/features/movement/paper-reference.service', () => ({
  getPaperReferencesFor: () => Promise.resolve(new Map()),
  getPaperReference: () => Promise.resolve(null),
  setPaperReference: () => Promise.resolve({ ok: true }),
}));

const BATCH: WarehouseStockBatch = {
  id: 'b1', warehouseId: 'wh-1', scientificName: 'Paracetamol', batchNumber: 'LOT-9',
  expiryDate: '2027-01-01', onHandQuantity: 40, reservedQuantity: 0, availableQuantity: 40,
  nationalCode: null, materialIdentityKey: null, internalBatchReference: null,
  supplyType: 'kimadia', purchaseOrigin: null,
};

const movement = (over: Record<string, unknown> = {}) => ({
  id: 'm1', warehouseStockId: 'b1', movementType: 'add',
  onHandBefore: 10, onHandDelta: 5, onHandAfter: 15,
  reason: null, sourceDocumentNumber: null, actorName: null,
  createdAt: '2026-08-01T10:00:00.000Z', ...over,
});

// The first jsdom mount in this file pulls in InventoryCenterScreen's whole
// module graph. On its own that takes ~2s; inside a full parallel run it can
// exceed vitest's 5s default and time out on the FIRST test only. The
// assertions are unaffected — this is warm-up, not behaviour.
vi.setConfig({ testTimeout: 30000 });

describe('UAT-DEFECT-004 · the ledger view distinguishes error from empty', () => {
  beforeEach(() => { movementsMock.fn.mockReset(); });
  afterEach(() => cleanup());

  it('SOURCE: the render has an explicit error branch, ordered before the empty branch', () => {
    const start = SCREEN_SRC.indexOf('function LedgerList');
    expect(start).toBeGreaterThan(-1);
    const body = SCREEN_SRC.slice(start, SCREEN_SRC.indexOf('\n}\n', start));
    const errorAt = body.indexOf('movements.error');
    const emptyAt = body.indexOf("t('inv_no_movements', lang)");
    expect(errorAt, 'the ledger must test movements.error').toBeGreaterThan(-1);
    expect(emptyAt).toBeGreaterThan(-1);
    // Order matters: an error branch AFTER the empty branch never runs.
    expect(errorAt).toBeLessThan(emptyAt);
    expect(body).toContain('onRetry={movements.reload}');
  });

  it('SOURCE: the empty state is reached only when there is no error', () => {
    const start = SCREEN_SRC.indexOf('function LedgerList');
    const body = SCREEN_SRC.slice(start, SCREEN_SRC.indexOf('\n}\n', start));
    // The ternary chain must be loading -> error -> empty -> list.
    const chain = body.slice(body.indexOf('movements.loading ?'));
    const order = ['movements.loading ?', 'movements.error', 'length === 0', 'map(m =>'];
    let cursor = -1;
    for (const token of order) {
      const at = chain.indexOf(token, cursor + 1);
      expect(at, `expected ${token} after the previous state`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('RUNTIME A1: a successful read of zero rows renders the legitimate empty state', async () => {
    movementsMock.fn.mockResolvedValue([]);
    const { LedgerList } = await import('../InventoryCenterScreen');
    const { container } = render(<LedgerList batches={[BATCH]} lang="en" />);
    const view = within(container);
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'b1' } });
    await waitFor(() => expect(view.getByText('No movements')).toBeInTheDocument());
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('RUNTIME A2/A4/A5: one movement renders its real before/after and actor', async () => {
    movementsMock.fn.mockResolvedValue([movement({ onHandBefore: 40, onHandAfter: 55, actorName: 'Dr Amal' })]);
    const { LedgerList } = await import('../InventoryCenterScreen');
    const { container } = render(<LedgerList batches={[BATCH]} lang="en" />);
    const view = within(container);
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'b1' } });
    await waitFor(() => expect(view.getByText(/40/)).toBeInTheDocument());
    const row = view.getByText(/40/).closest('li')!;
    expect(row.textContent).toContain('40');
    expect(row.textContent).toContain('55');
    expect(row.textContent).toContain('Dr Amal');
    expect(view.queryByText('No movements')).toBeNull();
  });

  it('RUNTIME A3: multiple movements all render, in the order the service returned', async () => {
    movementsMock.fn.mockResolvedValue([
      movement({ id: 'm3', onHandBefore: 20, onHandAfter: 12, createdAt: '2026-08-03T10:00:00.000Z' }),
      movement({ id: 'm2', onHandBefore: 15, onHandAfter: 20, createdAt: '2026-08-02T10:00:00.000Z' }),
      movement({ id: 'm1', onHandBefore: 10, onHandAfter: 15, createdAt: '2026-08-01T10:00:00.000Z' }),
    ]);
    const { LedgerList } = await import('../InventoryCenterScreen');
    const { container } = render(<LedgerList batches={[BATCH]} lang="en" />);
    const view = within(container);
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'b1' } });
    await waitFor(() => expect(container.querySelectorAll('li.nexus-it-ledger-row')).toHaveLength(3));
    const rows = [...container.querySelectorAll('li.nexus-it-ledger-row')].map(n => n.textContent ?? '');
    expect(rows[0]).toContain('20');
    expect(rows[2]).toContain('10');
  });

  it('RUNTIME A6: a failed read renders an ERROR, never "No movements"', async () => {
    movementsMock.fn.mockRejectedValue(
      Object.assign(new Error('column warehouse_stock_movements.quantity_before does not exist'), { code: '42703' }),
    );
    const { LedgerList } = await import('../InventoryCenterScreen');
    const { container } = render(<LedgerList batches={[BATCH]} lang="en" />);
    const view = within(container);
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'b1' } });
    await waitFor(() => expect(view.getByRole('alert')).toBeInTheDocument());
    expect(view.queryByText('No movements'), 'a read error must never read as an empty history').toBeNull();
  });

  it('RUNTIME A7: retry recovers from error to populated without a reload', async () => {
    movementsMock.fn
      .mockRejectedValueOnce(Object.assign(new Error('network down'), { code: 'PGRST000' }))
      .mockResolvedValue([movement({ onHandBefore: 7, onHandAfter: 9 })]);
    const { LedgerList } = await import('../InventoryCenterScreen');
    const { container } = render(<LedgerList batches={[BATCH]} lang="en" />);
    const view = within(container);
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'b1' } });
    await waitFor(() => expect(view.getByRole('alert')).toBeInTheDocument());
    fireEvent.click(view.getByRole('button', { name: /Retry/i }));
    await waitFor(() => expect(view.queryByRole('alert')).toBeNull());
    expect(view.getByText(/7/)).toBeInTheDocument();
    expect(view.queryByText('No movements')).toBeNull();
  });

  it('RUNTIME: a persistent failure stays an error and never decays into empty', async () => {
    movementsMock.fn.mockRejectedValue(new Error('still down'));
    const { LedgerList } = await import('../InventoryCenterScreen');
    const { container } = render(<LedgerList batches={[BATCH]} lang="en" />);
    const view = within(container);
    fireEvent.change(view.getByRole('combobox'), { target: { value: 'b1' } });
    await waitFor(() => expect(view.getByRole('alert')).toBeInTheDocument());
    fireEvent.click(view.getByRole('button', { name: /Retry/i }));
    await waitFor(() => expect(view.getByRole('alert')).toBeInTheDocument());
    expect(view.queryByText('No movements')).toBeNull();
  });
});

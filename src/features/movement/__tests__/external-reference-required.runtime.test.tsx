/**
 * @vitest-environment jsdom
 *
 * GI-OBS-1 — the official-letter number is REQUIRED, in BOTH composers.
 *
 * THE DEFECT. `mv_external_reference` described the field as optional in both
 * languages, and neither composer's confirm gate looked at it: both derive
 * `confirmable` from `draftIsConfirmable(lines, direction)`, which inspects
 * ONLY lines. An operator following the label could therefore reach Confirm
 * with the field empty, and the server refused the call outright —
 * `request_number_required` for the forward path (migration 077) and
 * `return_number_required` for the return path (migration 069) — surfacing a
 * raw lower_snake token as an HTTP 400.
 *
 * OWNER RULING (evidence artifact 299): the number is REQUIRED, the scope is
 * BOTH composers, and no migration is authorised — the client is brought into
 * line with the live server contract, not the reverse.
 *
 * WHY THIS FILE RENDERS INSTEAD OF SCANNING SOURCE. Every pre-existing test for
 * these composers reads them as text. A source scan cannot observe that the
 * confirm button is actually dead, nor that no RPC left the client. These tests
 * therefore mount the real components, drive them the way the operator does,
 * and assert on the mocked service boundary. Each one fails against the
 * pre-ruling components.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const app = vi.hoisted(() => ({ lang: 'ar' as 'ar' | 'en', dir: 'rtl' as 'rtl' | 'ltr' }));
vi.mock('@/app/AppContext', () => ({ useApp: () => ({ lang: app.lang, dir: app.dir }) }));

const svc = vi.hoisted(() => ({
  getWarehouseStock: vi.fn(),
  createDirectTransferRequest: vi.fn(),
  addTransferRequestLine: vi.fn(),
  getTransferRequestLines: vi.fn(),
  getTransfers: vi.fn(),
  getIncomingTransferLines: vi.fn(),
  requestDirectReturn: vi.fn(),
  recallDirectTransfer: vi.fn(),
  addDirectReturnLine: vi.fn(),
  getReturnRequestLines: vi.fn(),
}));
vi.mock('@/features/network/network.service', () => ({
  ...svc,
  RETURN_REASON_CODES: ['near_expiry', 'excess', 'shipment_error', 'expired', 'damaged',
    'recalled', 'quality_issue', 'temperature_excursion', 'other'] as const,
}));

import { DirectSupplyComposer } from '../DirectSupplyComposer';
import { DirectReturnComposer } from '../DirectReturnComposer';
import { T } from '@/shared/i18n/strings';

const SRC_WH = '00000000-0000-0000-0000-0000000000s1';
const DST_ORG = '00000000-0000-0000-0000-0000000000o1';
const DST_WH = '00000000-0000-0000-0000-0000000000d1';
const STOCK_ID = '00000000-0000-0000-0000-0000000000b1';
const CENTRAL_ITEM = '00000000-0000-0000-0000-0000000000c1';
const TRANSFER_ID = '00000000-0000-0000-0000-0000000000t1';
const TRANSFER_LINE = '00000000-0000-0000-0000-0000000000l1';

const batch = {
  id: STOCK_ID, warehouseId: SRC_WH, scientificName: 'Paracetamol',
  batchNumber: 'B-1', expiryDate: '2028-02-29',
  onHandQuantity: 100, reservedQuantity: 0, availableQuantity: 100,
  nationalCode: null, centralItemId: CENTRAL_ITEM, concentration: '500 mg',
  dosageForm: 'tablet', unit: 'box', materialIdentityKey: 'mik-1',
  internalBatchReference: null, supplyType: null, purchaseOrigin: null,
};

/** Click the shell's forward-nav button for a step, by its Product label. */
function advance(stepKey: 'mv_step_materials' | 'mv_step_review') {
  const label = T[stepKey][app.lang];
  const btn = screen.getAllByRole('button').find(b => (b.textContent || '').trim() === label);
  expect(btn, `no advance button for ${stepKey}`).toBeTruthy();
  expect(btn).not.toBeDisabled();
  fireEvent.click(btn!);
}

function setSelectByValue(value: string) {
  const target = (screen.getAllByRole('combobox') as HTMLSelectElement[])
    .find(s => [...s.options].some(o => o.value === value));
  expect(target, `no <select> offering ${value}`).toBeTruthy();
  fireEvent.change(target!, { target: { value } });
}

/** The operator-typed reference input, located by its Product label. */
function referenceInput(): HTMLInputElement {
  const label = T.mv_external_reference[app.lang];
  const found = (screen.getAllByRole('textbox') as HTMLInputElement[]).find(i => {
    const wrap = i.closest('label') ?? i.parentElement;
    return (wrap?.textContent ?? '').includes(label);
  });
  expect(found, 'reference input not found by its Product label').toBeTruthy();
  return found!;
}

afterEach(() => { cleanup(); vi.clearAllMocks(); app.lang = 'ar'; app.dir = 'rtl'; });

beforeEach(() => {
  svc.getWarehouseStock.mockResolvedValue([batch]);
  svc.getTransferRequestLines.mockResolvedValue([]);
  svc.createDirectTransferRequest.mockResolvedValue({ ok: true, data: { id: 'req-1' } });
  svc.addTransferRequestLine.mockResolvedValue({ ok: true, data: { id: 'line-1' } });
  svc.getTransfers.mockResolvedValue([{ id: TRANSFER_ID, transferNumber: 'SHIP-1' }]);
  svc.getIncomingTransferLines.mockResolvedValue([{
    id: TRANSFER_LINE, transferId: TRANSFER_ID, receivedQuantity: 40, returnedQuantity: 0,
    resultingWarehouseStockId: STOCK_ID, scientificName: 'Paracetamol', tradeName: null,
    concentration: '500 mg', dosageForm: 'tablet', unit: 'box', nationalCode: null,
    batchNumber: 'B-1', internalBatchReference: null, expiryDate: '2028-02-29',
    receivedAt: '2026-08-01T00:00:00Z',
  }]);
  svc.requestDirectReturn.mockResolvedValue({ ok: true, data: { id: 'ret-1' } });
  svc.addDirectReturnLine.mockResolvedValue({ ok: true, data: { id: 'retline-1' } });
  svc.getReturnRequestLines.mockResolvedValue([]);
});

/* ── FORWARD ────────────────────────────────────────────────────────────── */

async function mountSupplyAtReview(reference?: string) {
  render(
    <DirectSupplyComposer
      sourceWarehouses={[{ id: SRC_WH, name: 'Central', name_ar: 'المركزي' } as never]}
      destinationWarehouses={[{ id: DST_WH, organizationId: DST_ORG, organizationName: 'Org', warehouseName: 'Depot' } as never]}
      organizations={[{ id: DST_ORG, name: 'Org' }]}
      onCancel={() => {}}
      onCreated={() => {}}
    />,
  );
  setSelectByValue(SRC_WH);
  setSelectByValue(DST_ORG);
  setSelectByValue(DST_WH);
  if (reference !== undefined) fireEvent.change(referenceInput(), { target: { value: reference } });
  advance('mv_step_materials');
  await waitFor(() => expect(svc.getWarehouseStock).toHaveBeenCalled());

  const numeric = await waitFor(() => {
    const el = document.querySelector('input[inputmode="numeric"]') as HTMLInputElement | null;
    expect(el, 'stock picker quantity input never appeared').toBeTruthy();
    return el!;
  });
  fireEvent.change(numeric, { target: { value: '10' } });
  const addLabel = T.mv_add_line[app.lang];
  const add = await waitFor(() => {
    const b = screen.getAllByRole('button')
      .find(x => (x.textContent || '').trim() === addLabel && !(x as HTMLButtonElement).disabled);
    expect(b, 'add-line button not enabled').toBeTruthy();
    return b!;
  });
  fireEvent.click(add);

  advance('mv_step_review');
  return await screen.findByTestId('confirm-create-supply-request');
}

describe('FORWARD composer — the number gates Confirm', () => {
  it('empty number blocks Confirm and calls NO RPC', async () => {
    const confirm = await mountSupplyAtReview();
    expect(confirm).toBeDisabled();
    expect(screen.getByTestId('supply-external-reference-required')).toBeInTheDocument();
    fireEvent.click(confirm);
    await waitFor(() => expect(svc.createDirectTransferRequest).not.toHaveBeenCalled());
    expect(svc.addTransferRequestLine).not.toHaveBeenCalled();
  });

  it('whitespace-only number is invalid and still blocks Confirm', async () => {
    const confirm = await mountSupplyAtReview('   ');
    expect(confirm).toBeDisabled();
    expect(screen.getByTestId('supply-external-reference-required')).toBeInTheDocument();
    fireEvent.click(confirm);
    expect(svc.createDirectTransferRequest).not.toHaveBeenCalled();
  });

  it('a valid number enables Confirm and reaches the RPC exactly as normalized', async () => {
    const confirm = await mountSupplyAtReview('  OPS-77  ');
    await waitFor(() => expect(confirm).not.toBeDisabled());
    expect(screen.queryByTestId('supply-external-reference-required')).not.toBeInTheDocument();
    fireEvent.click(confirm);
    await waitFor(() => expect(svc.createDirectTransferRequest).toHaveBeenCalledTimes(1));
    expect(svc.createDirectTransferRequest.mock.calls[0][0]).toMatchObject({ requestNumber: 'OPS-77' });
  });
});

/* ── RETURN ─────────────────────────────────────────────────────────────── */

async function mountReturnAtReview(reference?: string) {
  render(
    <DirectReturnComposer
      institutionWarehouses={[{ id: SRC_WH, organizationId: DST_ORG, organizationName: 'Org', warehouseName: 'Depot' } as never]}
      organizations={[{ id: DST_ORG, name: 'Org' }]}
      centralWarehouses={[{ id: DST_WH, name: 'Central', name_ar: 'المركزي' } as never]}
      onCancel={() => {}}
      onCreated={() => {}}
      onRecalled={() => {}}
    />,
  );
  setSelectByValue(DST_ORG);
  setSelectByValue(SRC_WH);
  setSelectByValue(DST_WH);
  if (reference !== undefined) fireEvent.change(referenceInput(), { target: { value: reference } });
  advance('mv_step_materials');
  await waitFor(() => expect(svc.getIncomingTransferLines).toHaveBeenCalled());

  const results = await screen.findByTestId('provenance-picker-results');
  const numeric = await waitFor(() => {
    const el = results.querySelector('input[inputmode="numeric"], input[type="number"]') as HTMLInputElement | null;
    expect(el, 'provenance quantity input never appeared').toBeTruthy();
    return el!;
  });
  fireEvent.change(numeric, { target: { value: '5' } });
  const addLabel = T.mv_add_line[app.lang];
  const add = await waitFor(() => {
    const b = within(results).getAllByRole('button')
      .find(x => (x.textContent || '').trim() === addLabel && !(x as HTMLButtonElement).disabled);
    expect(b, 'return add-line button not enabled').toBeTruthy();
    return b!;
  });
  fireEvent.click(add);

  advance('mv_step_review');
  return await screen.findByTestId('confirm-create-return-request');
}

describe('RETURN composer — the number gates Confirm', () => {
  it('empty number blocks Confirm and calls NO RPC', async () => {
    const confirm = await mountReturnAtReview();
    expect(confirm).toBeDisabled();
    expect(screen.getByTestId('return-external-reference-required')).toBeInTheDocument();
    fireEvent.click(confirm);
    await waitFor(() => expect(svc.requestDirectReturn).not.toHaveBeenCalled());
    expect(svc.addDirectReturnLine).not.toHaveBeenCalled();
  });

  it('whitespace-only number is invalid and still blocks Confirm', async () => {
    const confirm = await mountReturnAtReview('  \t ');
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(svc.requestDirectReturn).not.toHaveBeenCalled();
  });

  it('a valid number enables Confirm and reaches the RPC exactly as normalized', async () => {
    const confirm = await mountReturnAtReview('  RET-9  ');
    await waitFor(() => expect(confirm).not.toBeDisabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(svc.requestDirectReturn).toHaveBeenCalledTimes(1));
    expect(svc.requestDirectReturn.mock.calls[0][0]).toMatchObject({ returnNumber: 'RET-9' });
  });
});

/* ── COPY: both languages, both directions ──────────────────────────────── */

describe('the field is presented as REQUIRED, in AR and EN', () => {
  it('neither language still calls it optional', () => {
    expect(T.mv_external_reference.ar).toContain('مطلوب');
    expect(T.mv_external_reference.ar).not.toContain('اختياري');
    expect(T.mv_external_reference.en.toLowerCase()).toContain('required');
    expect(T.mv_external_reference.en.toLowerCase()).not.toContain('optional');
  });

  it('the hint no longer says "if one exists" nor promises an auto order number', () => {
    expect(T.mv_external_reference_hint.ar).not.toContain('إن وجد');
    expect(T.mv_external_reference_hint.en.toLowerCase()).not.toContain('if one exists');
    expect(T.mv_external_reference_hint.ar).not.toContain('رقم الطلب والتتبع');
    expect(T.mv_external_reference_hint.en.toLowerCase()).not.toContain('order and trace numbers');
  });

  it('the refusal message exists in both languages and is actionable', () => {
    expect(T.mv_external_reference_required.ar).toContain('مطلوب');
    expect(T.mv_external_reference_required.en.toLowerCase()).toContain('required');
    expect(T.mv_external_reference_required.ar.length).toBeGreaterThan(20);
    expect(T.mv_external_reference_required.en.length).toBeGreaterThan(20);
  });

  it('renders the required banner in EN/LTR as well as AR/RTL', async () => {
    app.lang = 'en'; app.dir = 'ltr';
    const confirm = await mountSupplyAtReview();
    expect(confirm).toBeDisabled();
    const banner = screen.getByTestId('supply-external-reference-required');
    expect(banner).toHaveTextContent(T.mv_external_reference_required.en);
  });
});

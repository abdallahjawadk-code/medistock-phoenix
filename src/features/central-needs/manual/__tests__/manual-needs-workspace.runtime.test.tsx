/** @vitest-environment jsdom */
/**
 * R1-A4 — the manual workspace against the REAL component with only the service boundary injected.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));
const { ManualNeedsWorkspace } = await import('../ManualNeedsWorkspace');
const { CentralNeedsError } = await import('../../central-needs.service');
import type { ManualNeedEvent, ManualCapabilities } from '../manual-needs.service';

const REV = 'rev-1';
const B = [{ id: 'b1', name: 'Hospital A' }, { id: 'b2', name: 'Hospital B' }];
const I = [{ id: 'i1', name: 'Paracetamol', unit: 'box' }, { id: 'i2', name: 'Amoxicillin', unit: 'vial' }];

const caps = (o: Partial<ManualCapabilities> = {}): ManualCapabilities => ({
  view: true, edit: true, approve: false, manualSet: true, excelImportOpen: true, approveExcludedForRevision: false, ...o,
});
const event = (o: Partial<ManualNeedEvent> & { id: string; eventSeq: number; eventKind: ManualNeedEvent['eventKind'] }): ManualNeedEvent => ({
  planRevisionId: REV, beneficiaryOrganizationId: 'b1', centralItemId: 'i1', targetWarehouseId: null,
  quantityText: '10', approvedUnit: 'box', reason: 'r', reference: null, actorId: 'u', ...o,
});

function makeApi(initial: ManualNeedEvent[] = [], capsValue = caps()) {
  let chain = initial;
  const api = {
    getManualCapabilities: vi.fn(async () => capsValue),
    listManualNeedEvents: vi.fn(async () => chain),
    addManualNeedLine: vi.fn(async () => ({ idempotentReplay: false, eventId: 'new', eventSeq: 1 })),
    correctManualNeedLine: vi.fn(async () => ({ idempotentReplay: false, eventId: 'new', eventSeq: 2 })),
    voidManualNeedLine: vi.fn(async () => ({ idempotentReplay: false, eventId: 'new', eventSeq: 2 })),
    newManualIdempotencyKey: vi.fn(() => `key-${Math.random().toString(36).slice(2)}-xxxxxxxx`),
  };
  return { api, setChain: (c: ManualNeedEvent[]) => { chain = c; } };
}

const mount = (api: ReturnType<typeof makeApi>['api'], o: Partial<React.ComponentProps<typeof ManualNeedsWorkspace>> = {}) =>
  render(<ManualNeedsWorkspace lang="en" organizationId="org" planRevisionId={REV} revisionStatus="draft" sourceMode="manual"
    beneficiaries={B} items={I} api={api} {...o} />);

beforeEach(() => cleanup());
afterEach(() => cleanup());

const fillAdd = (qty: string, reason = 'planned need') => {
  fireEvent.change(screen.getByLabelText('Beneficiary institution'), { target: { value: 'b1' } });
  fireEvent.change(screen.getByLabelText('Item'), { target: { value: 'i1' } });
  fireEvent.change(screen.getByLabelText('Annual quantity'), { target: { value: qty } });
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: reason } });
};

describe('persisted identity in a fresh reviewer session', () => {
  it('loads saved material names and national code even when the picker is empty', async () => {
    const { api }=makeApi([event({id:'persisted',eventSeq:1,eventKind:'add'})]);
    const ready=vi.fn();
    const withLabels={...api,getManualCatalogLabels:vi.fn(async()=>[{id:'i1',name:'Persisted reagent',nameAr:null,unit:'box',nationalCode:'00043-A',concentration:null,dosageForm:null,status:'active'}])};
    mount(withLabels,{items:[],revisionStatus:'approved',onIdentityReady:ready});
    expect(await screen.findByText('Persisted reagent')).toBeInTheDocument();
    expect(screen.getByText(/00043-A/)).toBeInTheDocument();
    expect(screen.queryByText('i1')).toBeNull();expect(ready).toHaveBeenLastCalledWith(true);
  });
  it('reports denied identity loading and keeps decision readiness false', async () => {
    const {api}=makeApi([event({id:'persisted',eventSeq:1,eventKind:'add'})]);const ready=vi.fn();
    const withLabels={...api,getManualCatalogLabels:vi.fn(async()=>{throw new Error('denied');})};
    mount(withLabels,{items:[],revisionStatus:'approved',onIdentityReady:ready});
    await screen.findByText('Some material names could not be loaded. Saved data is unchanged.');
    expect(screen.getByText('Material name unavailable')).toBeInTheDocument();
    expect(ready).not.toHaveBeenCalledWith(true);
  });
});

describe('R1-A4 manual workspace', () => {
  it('without the manual key it explains why and offers no editing control', async () => {
    const { api } = makeApi([event({ id: 'e1', eventSeq: 1, eventKind: 'add' })], caps({ manualSet: false }));
    mount(api);
    expect(await screen.findByText(/not enabled/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add line' })).toBeNull();
    expect(screen.getByText('10')).toBeInTheDocument();
  });

  it('a non-draft or Excel revision is read-only even for a key holder', async () => {
    const { api } = makeApi();
    mount(api, { revisionStatus: 'approved' });
    expect(await screen.findByText(/read-only/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add line' })).toBeNull();
  });

  it('an invalid quantity is explained and sends nothing; Arabic-Indic digits get a display-only proposal', async () => {
    const { api } = makeApi();
    mount(api);
    await screen.findByRole('button', { name: 'Add line' });
    fillAdd('١٢');
    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));
    const err = await screen.findByText(/Did you mean 12/);
    expect(err.textContent).toContain('12');
    expect(api.addManualNeedLine).not.toHaveBeenCalled();
    fillAdd('1.50');
    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));
    await waitFor(() => expect(screen.getByLabelText('Annual quantity')).toHaveAttribute('aria-invalid', 'true'));
    expect(api.addManualNeedLine).not.toHaveBeenCalled();
  });

  it('adds a line with the exact text, then re-reads the server list (no optimistic row)', async () => {
    const { api, setChain } = makeApi();
    mount(api);
    await screen.findByRole('button', { name: 'Add line' });
    fillAdd('12.5');
    setChain([event({ id: 'e1', eventSeq: 1, eventKind: 'add', quantityText: '12.5' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));
    await screen.findByText(/Saved/);
    expect(api.addManualNeedLine).toHaveBeenCalledTimes(1);
    const args = api.addManualNeedLine.mock.calls[0] as unknown[];
    expect(args[1]).toBe('12.5');
    expect(args[4]).toBeNull();                         // no expected event for a brand-new scope
    expect(api.listManualNeedEvents).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('12.5')).toBeInTheDocument();
  });

  it('a stale refusal refreshes the list, keeps the typed input and uses a NEW key on the next attempt', async () => {
    const { api, setChain } = makeApi([event({ id: 'e1', eventSeq: 1, eventKind: 'add' })]);
    api.correctManualNeedLine.mockRejectedValueOnce(new CentralNeedsError('manual_need_line_stale'));
    mount(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Correct' }));
    fireEvent.change(screen.getByLabelText('Annual quantity'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'recount' } });
    setChain([event({ id: 'e1', eventSeq: 1, eventKind: 'add' }), event({ id: 'e2', eventSeq: 2, eventKind: 'correct', quantityText: '11' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/changed on the server/);
    expect(screen.getByLabelText('Annual quantity')).toHaveValue('20');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.correctManualNeedLine).toHaveBeenCalledTimes(2));
    const [first, second] = api.correctManualNeedLine.mock.calls as unknown as unknown[][];
    expect(first[3]).not.toBe(second[3]);                // new intent after a definitive answer
    expect(first[4]).toBe('e1');
    expect(second[4]).toBe('e2');                        // fence advanced to the refreshed last event
  });

  it('a transport failure keeps the SAME idempotency key for the retry', async () => {
    const { api } = makeApi();
    api.addManualNeedLine.mockRejectedValueOnce(new TypeError('network'));
    mount(api);
    await screen.findByRole('button', { name: 'Add line' });
    fillAdd('5');
    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));
    await waitFor(() => expect(api.addManualNeedLine).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add line' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));
    await waitFor(() => expect(api.addManualNeedLine).toHaveBeenCalledTimes(2));
    const calls = api.addManualNeedLine.mock.calls as unknown as unknown[][];
    expect(calls[0][3]).toBe(calls[1][3]);
    expect(api.newManualIdempotencyKey).toHaveBeenCalledTimes(1);
  });

  it('void needs a reason and sends the fence; a voided scope shows as voided', async () => {
    const { api } = makeApi([event({ id: 'e1', eventSeq: 1, eventKind: 'add' })]);
    mount(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Void line' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('A reason is required.')).toBeInTheDocument();
    expect(api.voidManualNeedLine).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'mistake' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.voidManualNeedLine).toHaveBeenCalledTimes(1));
    expect((api.voidManualNeedLine.mock.calls[0] as unknown[])[3]).toBe('e1');
  });

  it('switching organization discards a response still in flight and resets the form', async () => {
    let release!: (v: ManualNeedEvent[]) => void;
    const slow = makeApi();
    slow.api.listManualNeedEvents.mockImplementationOnce(() => new Promise<ManualNeedEvent[]>((r) => { release = r; }));
    const { rerender } = mount(slow.api);
    rerender(<ManualNeedsWorkspace lang="en" organizationId="org-2" planRevisionId="rev-2" revisionStatus="draft" sourceMode="manual"
      beneficiaries={B} items={I} api={slow.api} />);
    release([event({ id: 'stale', eventSeq: 1, eventKind: 'add', quantityText: '999' })]);
    await screen.findByRole('button', { name: 'Add line' });
    expect(screen.queryByText('999')).toBeNull();
  });

  it('Arabic renders RTL with the quantity kept LTR, labelled controls and a polite status region', async () => {
    const { api } = makeApi([event({ id: 'e1', eventSeq: 1, eventKind: 'add' })]);
    mount(api, { lang: 'ar' });
    const region = await screen.findByTestId('manual-needs-workspace');
    expect(region).toHaveAttribute('dir', 'rtl');
    expect(within(region).getByText('10').closest('td')).toHaveAttribute('dir', 'ltr');
    expect(within(region).getByLabelText('الكمية السنوية')).toBeInTheDocument();
    expect(region.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(region.querySelector('table caption')).not.toBeNull();
  });
});

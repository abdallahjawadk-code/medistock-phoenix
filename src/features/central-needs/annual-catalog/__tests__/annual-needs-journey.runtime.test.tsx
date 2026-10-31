/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ManualNeedsJourney } from '../../manual/ManualNeedsJourney';
import type { JourneyApi, YearRevision } from '../../manual/manual-journey.service';
import { CentralNeedsError } from '../../central-needs.service';
import { AnnualCatalogContractError } from '../annual-catalog-server.contract';
import type { AnnualNeedEvent } from '../annual-needs.contract';
import { AnnualNeedsWorkspace } from '../AnnualNeedsWorkspace';
import { annualFixture, annualItem, binding, change, CAPS, ID, SCOPE } from './annual-ui-fixtures';

vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: vi.fn(() => { throw new Error('Unexpected real RPC'); }), from: vi.fn(() => { throw new Error('Unexpected direct query'); }) } }));
vi.mock('../../CentralNeedsRevisionHistory', () => ({ CentralNeedsRevisionHistory: () => <div data-testid="revision-history" /> }));
afterEach(cleanup);

const REV: YearRevision = { id: ID.revision, revisionNumber: 1, status: 'draft', sourceMode: 'manual', createdBy: ID.actor };
const CONTRACT = { version: 1 as const, scope: 'owner_year' as const, quantityBinding: true as const, annualEdits: true as const,
  actorSnapshots: true as const, editPolicy: 'annual_snapshot_with_legal_review' as const };
function fixture() {
  const fixture = annualFixture();
  let key = 0;
  fixture.manualApi.newManualIdempotencyKey.mockImplementation(() => `annual-intent-${++key}-stable`);
  const journeyApi: JourneyApi = {
    annualNeedsContract: vi.fn(async () => CONTRACT),
    features: vi.fn(async () => ({ nationalCode: true, sameActorManual: true, dossiers: false, workbookIntake: false })),
    listYearRevisions: vi.fn(async () => [REV]),
    listBeneficiaries: vi.fn(async () => [{ id: ID.beneficiary, name: 'Hospital A', nameAr: 'مستشفى أ' }, { id: ID.otherBeneficiary, name: 'Hospital B', nameAr: 'مستشفى ب' }]),
    searchCatalog: vi.fn(async () => [{ id: ID.canonical, name: 'Amoxicillin', nameAr: 'أموكسيسيلين', unit: 'box', concentration: '500 mg', dosageForm: 'Capsules', nationalCode: '00012-A' }]),
    resolveForIdentity: vi.fn(async () => []), getCaps: vi.fn(async () => CAPS),
    openPlan: vi.fn(async () => ({ planRevisionId: ID.revision })), openCorrection: vi.fn(async () => ({ planRevisionId: ID.revision })),
    readiness: vi.fn(async () => ({ planRevisionId: ID.revision, status: 'draft' as const, ready: true, blockers: [] })),
    submit: vi.fn(async () => undefined), approve: vi.fn(async () => undefined), reject: vi.fn(async () => undefined),
  };
  return { ...fixture, journeyApi };
}
const journey = (f: ReturnType<typeof fixture>, actorId: string = ID.actor) => <ManualNeedsJourney lang="en" organizationId={ID.owner} actorId={actorId}
  initialYear={2026} api={f.journeyApi} workspaceApi={f.manualApi} annualApi={f.api} preview={{ state: { phase: 'idle' } as never, parse: vi.fn(), reset: vi.fn() }} />;
const mount = (f: ReturnType<typeof fixture>) => render(journey(f));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function openYear() { fireEvent.click(screen.getByRole('button', { name: 'Open year' })); await screen.findByText('Revision 1 — draft'); }
async function chooseBeneficiary(id = ID.beneficiary) {
  const select = await screen.findByLabelText('Beneficiary institution');
  await waitFor(() => expect(select).toBeEnabled());
  fireEvent.change(select, { target: { value: id } });
  await waitFor(() => expect(screen.getByLabelText('Beneficiary institution')).toHaveValue(id));
}
async function selectAnnualMaterial() {
  await chooseBeneficiary();
  fireEvent.click(screen.getByRole('button', { name: 'Search this year' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Select material' }));
  await screen.findByRole('button', { name: 'Remove selection Amoxicillin' });
  fireEvent.change(screen.getByLabelText('Item'), { target: { value: ID.canonical } });
}
function historicalEvent(unbound = false): AnnualNeedEvent {
  return { id: ID.event, planRevisionId: ID.revision, beneficiaryOrganizationId: ID.beneficiary, centralItemId: ID.canonical,
    targetWarehouseId: null, eventSeq: 1, eventKind: 'add', quantityText: '23', approvedUnit: 'box', reason: 'Original need', reference: null,
    actorId: ID.actor, actorName: unbound ? null : 'Original employee', fromTrustedProfile: !unbound,
    createdAt: '2026-01-02T09:00:00Z', annualBinding: unbound ? null : binding() };
}
async function openEditor() {
  fireEvent.click(screen.getByRole('button', { name: 'Search this year' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Material details and history' }));
  await screen.findByRole('form', { name: 'Edit this year’s material information' });
}
function fillEdit() {
  fireEvent.change(screen.getByLabelText('Arabic display name'), { target: { value: 'اسم مصحح' } });
  fireEvent.change(screen.getByLabelText('Reason for changing material information'), { target: { value: 'Correct the annual label' } });
}

describe('annual capability and complete employee journey', () => {
  it('retains the institution read when the employee opens a year before that read finishes', async () => {
    const f = fixture(); const institutions = deferred<Awaited<ReturnType<JourneyApi['listBeneficiaries']>>>();
    vi.mocked(f.journeyApi.listBeneficiaries).mockReturnValue(institutions.promise);
    mount(f); await openYear();
    expect(screen.queryByRole('option', { name: 'Hospital A' })).toBeNull();
    await act(async () => institutions.resolve([{ id: ID.beneficiary, name: 'Hospital A', nameAr: 'مستشفى أ' }]));
    await chooseBeneficiary();
    expect(screen.getByRole('option', { name: 'Hospital A' })).toBeInTheDocument();
    expect(f.journeyApi.listBeneficiaries).toHaveBeenCalledTimes(1);
  });

  it('discards a prior account’s late journey capabilities and reloads the same year for the new account', async () => {
    const f = fixture(); const priorCaps = deferred<typeof CAPS>(); const viewer = { ...CAPS, edit: false, manualSet: false };
    vi.mocked(f.journeyApi.getCaps).mockReturnValueOnce(priorCaps.promise).mockResolvedValue(viewer);
    f.manualApi.getManualCapabilities.mockResolvedValue(viewer);
    const view = mount(f); fireEvent.click(screen.getByRole('button', { name: 'Open year' }));
    await waitFor(() => expect(f.journeyApi.getCaps).toHaveBeenCalledTimes(1));
    view.rerender(journey(f, '70000000-0000-4000-8000-000000000002'));
    await openYear();
    expect(f.journeyApi.listBeneficiaries).toHaveBeenCalledTimes(2);
    await act(async () => priorCaps.resolve(CAPS));
    expect(f.journeyApi.getCaps).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Add a material to this year’s catalog' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add line' })).toBeNull();
  });

  it('discards both late event and capability reads in the quantity child after an account change', async () => {
    const f = fixture(); const priorEvents = deferred<AnnualNeedEvent[]>(); const priorCaps = deferred<typeof CAPS>();
    const viewer = { ...CAPS, edit: false, manualSet: false };
    vi.mocked(f.api.listAnnualNeedEvents).mockReturnValueOnce(priorEvents.promise).mockResolvedValue([{ ...historicalEvent(), actorName: 'New account event' }]);
    f.manualApi.getManualCapabilities.mockReturnValueOnce(priorCaps.promise).mockResolvedValue(viewer);
    const workspace = (actorId: string) => <AnnualNeedsWorkspace lang="en" scope={SCOPE} actorId={actorId} revision={REV}
      capabilities={viewer} beneficiaries={[]} searchRegisteredMaterials={f.journeyApi.searchCatalog} api={f.api} manualApi={f.manualApi} />;
    const view = render(workspace(ID.actor));
    await waitFor(() => expect(f.api.listAnnualNeedEvents).toHaveBeenCalledTimes(1));
    view.rerender(workspace('70000000-0000-4000-8000-000000000002'));
    await screen.findByText('New account event');
    await act(async () => { priorEvents.resolve([historicalEvent()]); priorCaps.resolve(CAPS); });
    expect(f.api.listAnnualNeedEvents).toHaveBeenCalledTimes(2);
    expect(f.manualApi.getManualCapabilities).toHaveBeenCalledTimes(2);
    expect(screen.getByText('New account event')).toBeInTheDocument();
    expect(screen.queryByText('Original employee')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add line' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Correct' })).toBeNull();
  });

  it('keeps the legacy journey when the new capability is explicitly absent', async () => {
    const f = fixture(); vi.mocked(f.journeyApi.annualNeedsContract!).mockResolvedValue(null);
    f.manualApi.listManualNeedEvents.mockResolvedValue([] as never);
    mount(f); await openYear();
    expect(await screen.findByRole('button', { name: 'Search' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Search this year' })).toBeNull();
    expect(f.api.listAnnualCatalogYears).not.toHaveBeenCalled();
  });

  it('shows a failed capability check without falling back to global search or the legacy writer', async () => {
    const f = fixture(); vi.mocked(f.journeyApi.annualNeedsContract!).mockRejectedValue(new Error('transport'));
    mount(f); fireEvent.click(screen.getByRole('button', { name: 'Open year' }));
    expect(await screen.findByText(/annual workflow capability could not be verified/i)).toBeInTheDocument();
    expect(screen.queryByTestId('manual-needs-workspace')).toBeNull();
    expect(f.journeyApi.searchCatalog).not.toHaveBeenCalled(); expect(f.manualApi.addManualNeedLine).not.toHaveBeenCalled();
    expect(f.journeyApi.listYearRevisions).not.toHaveBeenCalled();
  });

  it('selects from the year, leaves the quantity blank, and writes exact annual references through the connected journey', async () => {
    const f = fixture(); mount(f); await openYear(); await selectAnnualMaterial();
    expect(screen.getByLabelText('Annual quantity')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Annual quantity'), { target: { value: '12.5' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Planned annual use' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add line' }));
    await screen.findByText('Saved; the list was refreshed from the server.');
    expect(f.api.addAnnualNeedLine).toHaveBeenCalledWith(expect.objectContaining({ scope: SCOPE,
      manualScope: { planRevisionId: ID.revision, beneficiaryOrganizationId: ID.beneficiary, centralItemId: ID.canonical, targetWarehouseId: null },
      annualItemId: ID.annual, fieldVersionId: ID.version, quantityText: '12.5', expectedLastEventId: null }));
    const table = screen.getByRole('table', { name: 'Recorded need lines' });
    expect(within(table).getAllByText('Amoxicillin').length).toBeGreaterThan(0);
    expect(within(table).getByText('Employee recorded by server')).toBeInTheDocument();
    expect(f.journeyApi.searchCatalog).not.toHaveBeenCalled(); expect(f.manualApi.addManualNeedLine).not.toHaveBeenCalled();
  });

  it('clears selections and unsaved quantity when the beneficiary changes while retaining the owner/year catalog', async () => {
    const f = fixture(); mount(f); await openYear(); await selectAnnualMaterial();
    fireEvent.change(screen.getByLabelText('Annual quantity'), { target: { value: '70' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'For A only' } });
    await chooseBeneficiary(ID.otherBeneficiary);
    expect(await screen.findByLabelText('Annual quantity')).toHaveValue('');
    expect(screen.getByLabelText('Item')).toHaveValue(''); expect(screen.queryByRole('button', { name: 'Remove selection Amoxicillin' })).toBeNull();
    expect(f.api.addAnnualNeedLine).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Search this year' }));
    await screen.findByRole('button', { name: 'Select material' });
    expect(f.api.searchAnnualCatalogForNeeds).toHaveBeenLastCalledWith(SCOPE, '', 25, null);
  });

  it('records a material edit with a reason and server attribution without changing saved event snapshots', async () => {
    const f = fixture(); f.state.events = [historicalEvent()]; mount(f); await openYear(); await openEditor();
    fillEdit(); fireEvent.click(screen.getByRole('button', { name: 'Save the new field version' }));
    await screen.findByText(/operation was saved and the material was read again/i);
    expect(f.api.editAnnualCatalogItem).toHaveBeenCalledWith(expect.objectContaining({ scope: SCOPE, annualItemId: ID.annual,
      expectedFieldVersionId: ID.version, expectedCanonicalFingerprint: 'a'.repeat(64), reason: 'Correct the annual label', fields: expect.objectContaining({ nameAr: 'اسم مصحح' }) }));
    expect(Object.keys(vi.mocked(f.api.editAnnualCatalogItem).mock.calls[0][0])).not.toContain('actorName');
    expect(await screen.findByText('Employee recorded by server')).toBeInTheDocument();
    expect(f.state.events[0].annualBinding?.fieldVersionId).toBe(ID.version);
    expect(f.state.events[0].annualBinding?.fields.nameAr).toEqual(annualItem().fieldVersion.fields.nameAr);
    expect(f.api.addAnnualNeedLine).not.toHaveBeenCalled();
  });

  it('keeps an unresolved edit immutable and reconciles the same intent before fresh eligibility is shown', async () => {
    const f = fixture(); const edit = vi.mocked(f.api.editAnnualCatalogItem).getMockImplementation()!;
    vi.mocked(f.api.editAnnualCatalogItem).mockImplementationOnce(async (input) => {
      await edit(input); throw new CentralNeedsError('central_needs_request_failed');
    }).mockImplementationOnce(async () => ({ ...f.state.item, selectable: false, selectionBlockers: ['receipt_replay_requires_refresh'],
      idempotentReplay: true, change: f.state.changes[0] }));
    mount(f); await openYear(); await openEditor(); fillEdit();
    fireEvent.click(screen.getByRole('button', { name: 'Save the new field version' }));
    const retry = await screen.findByRole('button', { name: 'Reconcile the same pending request' });
    expect(screen.getByLabelText('Arabic display name')).toBeDisabled(); expect(screen.getByLabelText('Beneficiary institution')).toBeDisabled();
    fireEvent.click(retry);
    await screen.findByText(/operation was saved and the material was read again/i);
    const calls = vi.mocked(f.api.editAnnualCatalogItem).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[1][0]).toEqual(calls[0][0]);
    expect(f.api.getAnnualCatalogItemForNeeds).toHaveBeenCalledTimes(2);
  });

  it('separates confirmed save from failed refresh and retries only the read', async () => {
    const f = fixture(); vi.mocked(f.api.getAnnualCatalogItemForNeeds).mockImplementationOnce(async () => f.state.item)
      .mockRejectedValueOnce(new Error('refresh failed')).mockImplementation(async () => f.state.item);
    mount(f); await openYear(); await openEditor(); fillEdit();
    fireEvent.click(screen.getByRole('button', { name: 'Save the new field version' }));
    expect(await screen.findByText(/operation was confirmed saved, but the current state could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save the new field version' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Read the current state after saving' }));
    await screen.findByText(/operation was saved and the material was read again/i);
    expect(f.api.editAnnualCatalogItem).toHaveBeenCalledTimes(1);
    expect(f.api.getAnnualCatalogItemForNeeds).toHaveBeenCalledTimes(3);
  });

  it('keeps historical lines readable for a view-only user even when this year has no catalog', async () => {
    const f = fixture(); f.state.yearExists = false; f.state.events = [historicalEvent(true)];
    const viewer = { ...CAPS, edit: false, manualSet: false };
    vi.mocked(f.journeyApi.getCaps).mockResolvedValue(viewer); f.manualApi.getManualCapabilities.mockResolvedValue(viewer);
    mount(f); await openYear();
    expect(await screen.findByRole('table', { name: 'Recorded need lines' })).toHaveTextContent('23');
    expect(screen.getAllByText(/Historical line without a saved annual version/).length).toBeGreaterThan(0);
    expect(screen.getByText('The employee name was not recorded for this historical event')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create this year’s catalog' })).toBeNull();
    expect(f.api.openAnnualCatalogYear).not.toHaveBeenCalled(); expect(f.api.getAnnualCatalogItemForNeeds).not.toHaveBeenCalled();
  });

  it('allows the existing reviewer decision for an unbound submitted line after a same-ID current label is read', async () => {
    const f = fixture(); f.state.events = [historicalEvent(true)]; f.state.yearExists = false;
    const reviewer = { ...CAPS, edit: false, manualSet: false, approve: true };
    vi.mocked(f.journeyApi.getCaps).mockResolvedValue(reviewer); f.manualApi.getManualCapabilities.mockResolvedValue(reviewer);
    vi.mocked(f.journeyApi.listYearRevisions).mockResolvedValue([{ ...REV, status: 'submitted' }]);
    mount(f); fireEvent.click(screen.getByRole('button', { name: 'Open year' }));
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(approve).toBeEnabled();
    expect(screen.getByRole('table', { name: 'Recorded need lines' })).toHaveTextContent('Current registered label, not a saved historical snapshot');
    expect(f.manualApi.getManualCatalogLabels).toHaveBeenCalledWith([ID.canonical]);
    fireEvent.change(screen.getByLabelText('Reason for rejection'), { target: { value: 'Reviewed reason' } });
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
    fireEvent.click(approve); await waitFor(() => expect(f.journeyApi.approve).toHaveBeenCalledWith(ID.revision));
    expect(f.state.events[0].annualBinding).toBeNull(); expect(f.state.events[0].actorName).toBeNull();
    expect(f.api.getAnnualCatalogItemForNeeds).not.toHaveBeenCalled(); expect(f.api.openAnnualCatalogYear).not.toHaveBeenCalled();
  });

  it('does not authorize review from a current label returned for a different canonical item', async () => {
    const f = fixture(); f.state.events = [historicalEvent(true)];
    const reviewer = { ...CAPS, edit: false, manualSet: false, approve: true };
    vi.mocked(f.journeyApi.getCaps).mockResolvedValue(reviewer); f.manualApi.getManualCapabilities.mockResolvedValue(reviewer);
    vi.mocked(f.journeyApi.listYearRevisions).mockResolvedValue([{ ...REV, status: 'submitted' }]);
    f.manualApi.getManualCatalogLabels.mockResolvedValue([{ id: '30000000-0000-4000-8000-000000000002', name: 'Unrelated material', nameAr: 'مادة أخرى',
      unit: 'box', nationalCode: 'X', dosageForm: 'Capsules', concentration: '500 mg', status: 'active' }]);
    mount(f); fireEvent.click(screen.getByRole('button', { name: 'Open year' }));
    await screen.findByRole('table', { name: 'Recorded need lines' });
    await waitFor(() => expect(f.manualApi.getManualCatalogLabels).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByText('Unrelated material')).toBeNull();
    expect(screen.getByText('Wait for material names before making a decision.')).toBeInTheDocument();
  });

  it('explains a stale edit and reloads the server version without silently erasing the employee’s proposal', async () => {
    const f = fixture(); vi.mocked(f.api.editAnnualCatalogItem).mockRejectedValueOnce(new CentralNeedsError('annual_catalog_version_stale'));
    mount(f); await openYear(); await openEditor(); fillEdit();
    fireEvent.click(screen.getByRole('button', { name: 'Save the new field version' }));
    await screen.findByText(/newer material version was saved/i);
    f.state.item = { ...f.state.item, membership: { ...f.state.item.membership, currentFieldVersionId: ID.nextVersion },
      fieldVersion: { ...f.state.item.fieldVersion, fieldVersionId: ID.nextVersion, versionNumber: 2 } };
    fireEvent.click(screen.getByRole('button', { name: 'Load the server version and keep my input' }));
    await screen.findByText(/server version was read/i);
    expect(screen.getByLabelText('Arabic display name')).toHaveValue('اسم مصحح');
    expect(screen.getByLabelText('Reason for changing material information')).toHaveValue('Correct the annual label');
    expect(screen.getByRole('button', { name: 'Save the new field version' })).toBeDisabled();
    expect(f.api.editAnnualCatalogItem).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('annual_catalog_version_stale')).toBeNull();
  });

  it('keeps the server’s change-history order across pages without sorting rounded timestamps or IDs', async () => {
    const f = fixture(); const one = { ...change(), changeId: 'b0000000-0000-4000-8000-000000000001', actorName: 'Server first', createdAt: '2026-10-31T09:00:00.000002Z' };
    const two = { ...change(), changeId: 'a0000000-0000-4000-8000-000000000001', actorName: 'Server second', createdAt: '2026-10-31T09:00:00.000001Z' };
    const three = { ...change(), changeId: 'c0000000-0000-4000-8000-000000000001', actorName: 'Server third', createdAt: '2026-10-31T08:59:59Z' };
    vi.mocked(f.api.listAnnualCatalogChanges).mockResolvedValueOnce({ scope: SCOPE, annualItemId: ID.annual, changes: [one, two], nextAfterChangeId: two.changeId })
      .mockResolvedValueOnce({ scope: SCOPE, annualItemId: ID.annual, changes: [three], nextAfterChangeId: null });
    mount(f); await openYear(); await openEditor();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more changes' }));
    await screen.findByText('Server third');
    const history = screen.getByRole('region', { name: 'Material information change history' });
    const entries = within(history).getAllByRole('listitem');
    expect(entries.map((entry) => entry.querySelector('summary bdi')?.textContent)).toEqual(['Server first', 'Server second', 'Server third']);
    expect(f.api.listAnnualCatalogChanges).toHaveBeenLastCalledWith(SCOPE, ID.annual, 25, two.changeId);
  });

  it('locks year, beneficiary and other operations while annual registration is unresolved, but leaves its exact retry usable', async () => {
    const f = fixture(); f.registrationApi.createMaterialRequestDraft.mockRejectedValueOnce(new CentralNeedsError('central_needs_request_failed'));
    mount(f); await openYear();
    fireEvent.click(await screen.findByRole('button', { name: 'Add a material to this year’s catalog' }));
    fireEvent.click(screen.getByRole('button', { name: 'Request registration of a missing material' }));
    fireEvent.change(await screen.findByLabelText('Scientific name'), { target: { value: 'Missing annual material' } });
    fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'box' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save request as draft' }));
    const retry = await screen.findByRole('button', { name: 'Reconcile the same operation' });
    expect(retry).toBeEnabled(); expect(screen.getByRole('button', { name: 'Open year' })).toBeDisabled();
    expect(screen.getByLabelText('Beneficiary institution')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Search this year' })).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open year' })).toBeEnabled());
    expect(screen.getByLabelText('Beneficiary institution')).toBeEnabled();
    const calls = f.registrationApi.createMaterialRequestDraft.mock.calls;
    expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
    expect(f.registrationApi.newMaterialIdempotencyKey).toHaveBeenCalledTimes(1);
  });

  it('keeps the event history readable when the catalog-year read fails and disables new quantity entry', async () => {
    const f = fixture(); f.state.events = [historicalEvent()]; vi.mocked(f.api.listAnnualCatalogYears).mockRejectedValue(new Error('denied'));
    mount(f); await openYear();
    expect(await screen.findByText(/annual catalog could not be verified/i)).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Recorded need lines' })).toHaveTextContent('Original employee');
    expect(screen.queryByRole('button', { name: 'Add line' })).toBeNull();
    expect(f.api.searchAnnualCatalogForNeeds).not.toHaveBeenCalled(); expect(f.journeyApi.searchCatalog).not.toHaveBeenCalled();
  });

  it('voids only an explicitly unbound historical event through its original writer without fabricating annual references', async () => {
    const f = fixture(); f.state.yearExists = false; const old = historicalEvent(true); f.state.events = [old];
    f.manualApi.voidManualNeedLine.mockImplementation(async () => {
      f.state.events = [old, { ...old, id: '80000000-0000-4000-8000-000000000002', eventSeq: 2, eventKind: 'void', quantityText: null }];
      return { idempotentReplay: false, eventId: '80000000-0000-4000-8000-000000000002', eventSeq: 2 } as never;
    });
    mount(f); await openYear();
    await chooseBeneficiary();
    fireEvent.click(await screen.findByRole('button', { name: 'Void line' }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Withdraw historical line' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved; the list was refreshed from the server.');
    expect(f.manualApi.voidManualNeedLine).toHaveBeenCalledWith({ planRevisionId: ID.revision, beneficiaryOrganizationId: ID.beneficiary,
      centralItemId: ID.canonical, targetWarehouseId: null }, 'Withdraw historical line', expect.any(String), ID.event, null);
    expect(f.api.voidAnnualNeedLine).not.toHaveBeenCalled(); expect(f.api.addAnnualCatalogItemForNeeds).not.toHaveBeenCalled();
  });

  it('requires an explicit current selection after a stale correction rather than silently replacing its saved version', async () => {
    const f = fixture(); f.state.events = [historicalEvent()];
    f.state.item = { ...f.state.item, membership: { ...f.state.item.membership, currentFieldVersionId: ID.nextVersion },
      fieldVersion: { ...f.state.item.fieldVersion, fieldVersionId: ID.nextVersion, versionNumber: 2 } };
    vi.mocked(f.api.correctAnnualNeedLine).mockRejectedValueOnce(new AnnualCatalogContractError('input', 'annualNeeds.oldVersion'));
    mount(f); await openYear();
    await chooseBeneficiary();
    fireEvent.click(await screen.findByRole('button', { name: 'Correct' }));
    fireEvent.change(screen.getByLabelText('Annual quantity'), { target: { value: '24' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Revised demand' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/material version could not be bound/i);
    expect(vi.mocked(f.api.correctAnnualNeedLine).mock.calls[0][0].fieldVersionId).toBe(ID.version);
    fireEvent.click(screen.getByRole('button', { name: 'Search this year' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Select material' }));
    await screen.findByRole('button', { name: 'Remove selection Amoxicillin' });
    expect(screen.getByLabelText('Annual quantity')).toHaveValue('24');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved; the list was refreshed from the server.');
    expect(vi.mocked(f.api.correctAnnualNeedLine).mock.calls[1][0].fieldVersionId).toBe(ID.nextVersion);
  });

  it('uses the historical binding when voiding a bound line even after the current catalog version changes', async () => {
    const f = fixture(); f.state.events = [historicalEvent()];
    f.state.item = { ...f.state.item, fieldVersion: { ...f.state.item.fieldVersion, fieldVersionId: ID.nextVersion, versionNumber: 2 } };
    mount(f); await openYear();
    await chooseBeneficiary();
    fireEvent.click(await screen.findByRole('button', { name: 'Void line' }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'No longer required' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved; the list was refreshed from the server.');
    expect(f.api.voidAnnualNeedLine).toHaveBeenCalledWith(expect.objectContaining({ annualItemId: ID.annual, fieldVersionId: ID.version, expectedLastEventId: ID.event }));
    expect(f.manualApi.voidManualNeedLine).not.toHaveBeenCalled();
  });

  it('completes a resolved annual registration explicitly instead of using the legacy draft link', async () => {
    const f = fixture(); f.state.requests = [{ id: ID.request, organizationId: ID.owner, requesterId: ID.actor, status: 'approved_new', version: 4,
      scientificName: 'Amoxicillin', nameAr: 'أموكسيسيلين', tradeName: null, strength: '500 mg', dosageForm: 'Capsules', unit: 'box', barcode: '1234',
      nationalCode: '00012-A', note: null, provenanceKind: 'manual_typed', reviewerId: ID.actor, resolvedItemId: ID.canonical, decisionReason: 'Approved', createdAt: '2026-10-31T09:00:00Z' }];
    mount(f); await openYear();
    fireEvent.click(await screen.findByRole('button', { name: 'Add a material to this year’s catalog' }));
    fireEvent.click(screen.getByRole('button', { name: 'Request registration of a missing material' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review the resolved material for this year' }));
    fireEvent.change(await screen.findByLabelText('Reason for adding the material to the annual catalog'), { target: { value: 'Complete the year catalog' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm adding the material to this year' }));
    await screen.findByText(/operation was saved and the material was read again/i);
    expect(f.api.completeAnnualMaterialRequestForNeeds).toHaveBeenCalledWith(expect.objectContaining({ scope: SCOPE, requestId: ID.request, expectedRequestVersion: 4,
      expectedCanonicalFingerprint: 'a'.repeat(64), reason: 'Complete the year catalog' }));
    expect(f.api.addAnnualNeedLine).not.toHaveBeenCalled(); expect(f.api.createAnnualRegistrationApi).toHaveBeenCalledWith(SCOPE);
  });

  it('creates an empty year catalog independently of opening a need revision or entering a zero quantity', async () => {
    const f = fixture(); f.state.yearExists = false; vi.mocked(f.journeyApi.listYearRevisions).mockResolvedValue([]);
    mount(f); fireEvent.click(screen.getByRole('button', { name: 'Open year' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create this year’s catalog' }));
    expect(await screen.findByRole('button', { name: 'Search this year' })).toBeInTheDocument();
    expect(f.api.openAnnualCatalogYear).toHaveBeenCalledWith(SCOPE, expect.any(String));
    expect(f.journeyApi.openPlan).not.toHaveBeenCalled(); expect(f.api.addAnnualNeedLine).not.toHaveBeenCalled();
    expect(f.api.listAnnualNeedEvents).not.toHaveBeenCalled();
  });
});

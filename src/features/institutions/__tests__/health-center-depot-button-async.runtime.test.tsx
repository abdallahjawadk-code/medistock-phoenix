/**
 * @vitest-environment jsdom
 *
 * R1.1 HOTFIX — the health-centre depot create button must survive facilities
 * arriving ASYNCHRONOUSLY.
 *
 * THE PRODUCTION DEFECT. `WarehouseFacilityAssignmentPanel` seeded its selected
 * facility once, with `useState(availableFacilities[0]?.id ?? '')`. Facilities
 * are fetched after mount, so the first render saw an empty list and captured
 * ''. When the centres arrived the native <select> displayed its first
 * <option> — so the screen LOOKED correct — but the controlled value stayed ''
 * and `disabled={!facilityId || ...}` kept the create button dead no matter
 * what the operator typed.
 *
 * The existing r1-1-health-sector-topology-ui.test.ts reads the source and
 * proves only static wiring, so it cannot see this: the wiring was never wrong,
 * the STATE was. These tests therefore render the real component and drive it
 * the way the operator did, and every one of them fails against the pre-hotfix
 * component.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WarehouseFacilityAssignmentPanel } from '../WarehouseFacilityAssignmentPanel';
import type { OrganizationFacility } from '../facilities.service';
import type { Warehouse } from '@/shared/supabase/services/warehouses.service';

const svc = vi.hoisted(() => ({ createHealthCenterWarehouse: vi.fn() }));

vi.mock('@/features/network/network.service', () => ({
  createHealthCenterWarehouse: svc.createHealthCenterWarehouse,
}));

const ORG = '00000000-0000-0000-0000-0000000000aa';
const CENTER_A = '00000000-0000-0000-0000-00000000fa01';
const CENTER_B = '00000000-0000-0000-0000-00000000fa02';

const facility = (id: string, name: string, nameAr: string): OrganizationFacility => ({
  id,
  organizationId: ORG,
  facilityClass: 'primary_health_center',
  name,
  nameAr,
  code: null,
  status: 'active',
  createdAt: '2026-08-13T00:00:00Z',
});

/** Renders the panel with the given props and returns a typed rerender helper. */
function renderPanel(facilities: OrganizationFacility[], warehouses: Warehouse[] = []) {
  const view = render(
    <WarehouseFacilityAssignmentPanel
      warehouses={warehouses}
      facilities={facilities}
      lang="en"
      canManage
      onAssigned={() => {}}
    />,
  );
  const rerenderWith = (next: OrganizationFacility[], nextWarehouses: Warehouse[] = []) =>
    view.rerender(
      <WarehouseFacilityAssignmentPanel
        warehouses={nextWarehouses}
        facilities={next}
        lang="en"
        canManage
        onAssigned={() => {}}
      />,
    );
  return { ...view, rerenderWith };
}

/** The exact rendered labels (en): see strings.ts fac_section / net_wh_*. */
const LABEL_CENTER = 'Subordinate Health Centers';
const LABEL_NAME_EN = 'Name (English)';
const LABEL_NAME_AR = 'Name (Arabic)';

const createButton = () => screen.getByRole('button', { name: 'Create Health Center Depot' });
const centerSelect = () => screen.getByLabelText(LABEL_CENTER);
const typeNames = (en = 'Center A Depot', ar = 'مذخر مركز أ') => {
  fireEvent.change(screen.getByLabelText(LABEL_NAME_EN), { target: { value: en } });
  fireEvent.change(screen.getByLabelText(LABEL_NAME_AR), { target: { value: ar } });
};

describe('R1.1 hotfix · depot create survives asynchronous facility loading', () => {
  beforeEach(() => {
    svc.createHealthCenterWarehouse.mockReset().mockResolvedValue({ ok: true, data: {} });
  });
  afterEach(cleanup);

  it('THE DEFECT: a facility arriving AFTER mount enables create, and is the id submitted', async () => {
    // 1. The real first render: the fetch has not resolved, so there is nothing
    //    to select. The panel hides itself, exactly as it does in Production.
    const { rerenderWith, container } = renderPanel([]);
    expect(container).toBeEmptyDOMElement();

    // 2. The centres arrive.
    rerenderWith([facility(CENTER_A, 'Center A', 'مركز أ')]);

    // 3. The operator types both names and NEVER touches the centre select —
    //    which is precisely how the Production report was produced.
    typeNames();

    // 4. Pre-hotfix this stayed disabled forever.
    expect(createButton()).toBeEnabled();

    fireEvent.click(createButton());

    await waitFor(() => expect(svc.createHealthCenterWarehouse).toHaveBeenCalledTimes(1));
    expect(svc.createHealthCenterWarehouse).toHaveBeenCalledWith({
      organizationId: ORG,
      facilityId: CENTER_A,       // the ASYNC id, not '' and not undefined
      name: 'Center A Depot',
      nameAr: 'مذخر مركز أ',
      code: null,                 // blank optional code submits as null
    });
  });

  it('the select shows the effective centre, so control and display agree', () => {
    const { rerenderWith } = renderPanel([]);
    rerenderWith([facility(CENTER_A, 'Center A', 'مركز أ')]);
    // The bug was that the <select> displayed Center A while the value was ''.
    expect(centerSelect()).toHaveValue(CENTER_A);
  });

  it('an explicit choice of a second centre is preserved and submitted', async () => {
    const { rerenderWith } = renderPanel([]);
    rerenderWith([
      facility(CENTER_A, 'Center A', 'مركز أ'),
      facility(CENTER_B, 'Center B', 'مركز ب'),
    ]);

    const select = centerSelect();
    fireEvent.change(select, { target: { value: CENTER_B } });
    expect(select).toHaveValue(CENTER_B);

    typeNames('Center B Depot', 'مذخر مركز ب');
    fireEvent.click(createButton());

    await waitFor(() => expect(svc.createHealthCenterWarehouse).toHaveBeenCalledTimes(1));
    expect(svc.createHealthCenterWarehouse.mock.calls[0][0].facilityId).toBe(CENTER_B);
  });

  it('a chosen centre that later becomes unavailable falls back to the next one', async () => {
    const { rerenderWith } = renderPanel([]);
    rerenderWith([
      facility(CENTER_A, 'Center A', 'مركز أ'),
      facility(CENTER_B, 'Center B', 'مركز ب'),
    ]);

    const select = centerSelect();
    fireEvent.change(select, { target: { value: CENTER_B } });
    expect(select).toHaveValue(CENTER_B);

    // Centre B is deactivated underneath the operator (or another depot claimed
    // it). The panel must not keep submitting a centre that is gone.
    rerenderWith([facility(CENTER_A, 'Center A', 'مركز أ')]);
    expect(centerSelect()).toHaveValue(CENTER_A);

    typeNames();
    fireEvent.click(createButton());
    await waitFor(() => expect(svc.createHealthCenterWarehouse).toHaveBeenCalledTimes(1));
    expect(svc.createHealthCenterWarehouse.mock.calls[0][0].facilityId).toBe(CENTER_A);
  });

  it('a centre already owning an ACTIVE depot is not offered, and the next one is used', async () => {
    const claimed = [{
      id: 'w-1', organizationId: ORG, name: 'Depot A', nameAr: 'أ',
      warehouseKind: 'institution', facilityId: CENTER_A, isMain: false,
      status: 'active', code: null,
    } as unknown as Warehouse];

    const { rerenderWith } = renderPanel([]);
    rerenderWith(
      [facility(CENTER_A, 'Center A', 'مركز أ'), facility(CENTER_B, 'Center B', 'مركز ب')],
      claimed,
    );

    expect(centerSelect()).toHaveValue(CENTER_B);
    typeNames('Center B Depot', 'مذخر مركز ب');
    fireEvent.click(createButton());
    await waitFor(() => expect(svc.createHealthCenterWarehouse).toHaveBeenCalledTimes(1));
    expect(svc.createHealthCenterWarehouse.mock.calls[0][0].facilityId).toBe(CENTER_B);
  });

  it('both names remain required, and neither alone enables create', () => {
    const { rerenderWith } = renderPanel([]);
    rerenderWith([facility(CENTER_A, 'Center A', 'مركز أ')]);

    expect(createButton()).toBeDisabled();

    // English only.
    fireEvent.change(screen.getByLabelText(LABEL_NAME_EN), { target: { value: 'Depot' } });
    expect(createButton()).toBeDisabled();

    // Arabic only.
    fireEvent.change(screen.getByLabelText(LABEL_NAME_EN), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(LABEL_NAME_AR), { target: { value: 'مذخر' } });
    expect(createButton()).toBeDisabled();

    // Whitespace is not a name.
    fireEvent.change(screen.getByLabelText(LABEL_NAME_EN), { target: { value: '   ' } });
    expect(createButton()).toBeDisabled();

    // Both, properly.
    fireEvent.change(screen.getByLabelText(LABEL_NAME_EN), { target: { value: 'Depot' } });
    expect(createButton()).toBeEnabled();
  });

  it('an in-flight submission disables the button and cannot double-fire', async () => {
    let release!: (v: unknown) => void;
    svc.createHealthCenterWarehouse.mockReturnValue(new Promise(res => { release = res; }));

    const { rerenderWith } = renderPanel([]);
    rerenderWith([facility(CENTER_A, 'Center A', 'مركز أ')]);
    typeNames();

    // Held by reference: while loading, PhoenixButton replaces the label with an
    // aria-hidden spinner, so the button has no accessible name to query by.
    const btn = createButton();
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
    expect(btn).toHaveAttribute('aria-busy', 'true');

    // A second click while busy must not produce a second RPC.
    fireEvent.click(btn);
    expect(svc.createHealthCenterWarehouse).toHaveBeenCalledTimes(1);

    release({ ok: true, data: {} });
    await waitFor(() => expect(btn).toBeEnabled());
  });

  it('with no available centre the panel stays hidden, as before', () => {
    const { container, rerenderWith } = renderPanel([]);
    expect(container).toBeEmptyDOMElement();
    // An INACTIVE centre is not an available centre.
    rerenderWith([{ ...facility(CENTER_A, 'Center A', 'مركز أ'), status: 'inactive' }]);
    expect(container).toBeEmptyDOMElement();
  });
});

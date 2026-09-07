/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * INTERACTIVE-GUIDE-IG3 — the eight lifecycle tours, over the REAL
 * InventoryCenterScreen and its real child panels.
 *
 * Same division of labour as `guide-ig2-panels.runtime.test.tsx`:
 * `guide-ig3-tours.test.ts` proves the registry's own filtering logic against
 * constructed audiences (cheap, no rendering); this file proves the ACTUAL
 * screen renders the anchors/presence the registry expects, that walking every
 * tour performs zero writes and adds no unnecessary reads, and that the guide
 * never disturbs an operator's own in-progress form.
 *
 * Only the Supabase client and the RBAC transport are replaced, at their own
 * seams — every panel is the real component, reading real (fixture) rows.
 */

type Row = Record<string, unknown>;
let fixtures: Record<string, Row[]> = {};
const rpcCalls: string[] = [];
const readTables: string[] = [];

/** Every write RPC any of the eight tabs' real components can call. */
const WRITE_RPCS = [
  'phoenix_receive_warehouse_stock_guarded',
  'phoenix_apply_warehouse_stock_movement_guarded',
  'phoenix_request_warehouse_stock_correction',
  'phoenix_approve_warehouse_stock_correction',
  'phoenix_reject_warehouse_stock_correction',
  'phoenix_receive_warehouse_transfer_line',
  'phoenix_create_warehouse_dispatch',
  'phoenix_add_dispatch_line_fefo_guarded',
  'phoenix_send_warehouse_dispatch',
  'phoenix_cancel_warehouse_dispatch',
  'phoenix_receive_outlet_return_shipment_line',
  'phoenix_resolve_outlet_return_exception',
  'phoenix_request_outlet_stock_correction',
  'phoenix_approve_outlet_stock_correction',
  'phoenix_reject_outlet_stock_correction',
  'phoenix_set_paper_reference',
];

const rpc = vi.fn((name: string, _params?: unknown) => {
  rpcCalls.push(name);
  if (name === 'phoenix_query_organization_scope_topology') {
    return Promise.resolve({ data: fixtures.__topology ?? [], error: null });
  }
  // phoenix_status_center_authorized (correction-approval-authorization.service.ts)
  // RETURNS boolean — PostgREST hands back a bare JSON bool, not an object;
  // `isCorrectionApprovalAuthorized` checks `data === true` literally.
  if (name === 'phoenix_status_center_authorized') {
    return Promise.resolve({ data: true, error: null });
  }
  return Promise.resolve({ data: { ok: true, allowed: true }, error: null });
});

class Builder implements PromiseLike<{ data: unknown; error: null }> {
  private rows: Row[];
  constructor(rows: Row[]) { this.rows = [...rows]; }
  select(): this { return this; }
  eq(column: string, value: unknown): this {
    this.rows = this.rows.filter(r => r[column] === value);
    return this;
  }
  is(column: string, value: unknown): this {
    this.rows = this.rows.filter(r => (r[column] ?? null) === value);
    return this;
  }
  in(column: string, values: unknown[]): this {
    this.rows = this.rows.filter(r => values.includes(r[column]));
    return this;
  }
  order(): this { return this; }
  limit(): this { return this; }
  then<A, B = never>(
    onfulfilled?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve({ data: this.rows as unknown, error: null }).then(onfulfilled, onrejected);
  }
  maybeSingle(): PromiseLike<{ data: unknown; error: null }> {
    return Promise.resolve({ data: (this.rows[0] as unknown) ?? null, error: null });
  }
}

const from = vi.fn((table: string) => {
  readTables.push(table);
  if (fixtures[table] === undefined) throw new Error(`test fixture missing for table ${table}`);
  return new Builder(fixtures[table]);
});

vi.mock('@/shared/supabase/client', () => ({
  supabase: { rpc: (n: string, p: unknown) => rpc(n, p), from: (t: string) => from(t) },
  supabaseConfigured: true,
  __installQaSupabaseClient: () => undefined,
}));

vi.mock('@/shared/authz/rbac.service', () => ({
  supabaseRbacTransport: {
    hasScopedPermission: () => Promise.resolve({ ok: true, allowed: true }),
    hasWarehouseAssignment: () => Promise.resolve({ ok: true, allowed: true }),
    hasPointAssignment: () => Promise.resolve({ ok: true, allowed: true }),
  },
}));

let appState = {
  lang: 'ar' as 'ar' | 'en',
  dir: 'rtl' as 'rtl' | 'ltr',
  theme: 'light' as const,
  role: 'central_warehouse_manager',
  activeOrgId: 'org-1' as string | null,
  myPermissions: new Set<string>(['warehouse_transfer.receive', 'warehouse_dispatch.create']),
  profile: { id: 'p1', full_name: 'T', role: 'central_warehouse_manager', organization_id: 'org-1' },
  session: { user: { id: 'u1' } } as { user: { id: string } } | null,
  authStatus: 'authenticated',
  toggleLang: () => undefined,
  toggleTheme: () => undefined,
};
vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
vi.mock('@/shared/ui/PhoenixIcon', () => ({
  PhoenixIcon: ({ name }: { name: string }) => <span aria-hidden="true" data-icon={name} />,
}));

import { GuideSurfaceProvider } from '../guide.surface';
import { GuideEngine } from '../GuideEngine';
import { InventoryCenterScreen } from '@/features/inventory/InventoryCenterScreen';

const INERT_DRAWER = { isAvailable: false, isOpen: false, open: () => undefined, close: () => undefined };

const WH_A = 'wh-A';

const topologyRow = (over: Row = {}): Row => ({
  node_kind: 'warehouse', organization_id: 'org-1', warehouse_id: WH_A,
  warehouse_name: 'Depot A', warehouse_name_ar: 'مستودع أ', warehouse_kind: 'central',
  warehouse_status: 'active', warehouse_is_main: false, structural_role: 'central_depot',
  facility_id: null, distribution_point_id: null, in_effective_scope: true, ...over,
});

function Harness() {
  return (
    <GuideSurfaceProvider>
      <InventoryCenterScreen />
      <GuideEngine currentScreen={3} onNavigate={() => undefined} drawer={INERT_DRAWER} onClose={() => undefined} />
    </GuideSurfaceProvider>
  );
}

const originalRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  appState = {
    ...appState, lang: 'ar', dir: 'rtl',
    myPermissions: new Set(['warehouse_transfer.receive', 'warehouse_dispatch.create']),
  };
  window.localStorage.clear();
  rpcCalls.length = 0;
  readTables.length = 0;
  rpc.mockClear();
  from.mockClear();
  fixtures = {
    __topology: [topologyRow()],
    organizations: [{ id: 'org-1', name: 'Babil Health', name_ar: 'دائرة صحة بابل' }],
    warehouse_stock: [{
      id: 'ws-1', warehouse_id: WH_A, scientific_name: 'Paracetamol', batch_number: 'B1',
      national_code: '123', expiry_date: '2027-01-01', on_hand_quantity: 40, reserved_quantity: 0,
      available_quantity: 40, movement_seq: 1, concentration: '500 mg', dosage_form: 'Tablet', unit: 'tablet',
      central_item_id: null, internal_batch_reference: null, supply_type: null, purchase_origin: null,
      material_identity_key: 'mik/paracetamol',
    }],
    warehouse_stock_movements: [],
    warehouse_transfers: [{ id: 'tr-1', destination_warehouse_id: WH_A, route_id: null, transfer_number: 'TR-1' }],
    warehouse_transfer_lines: [{
      id: 'tl-1', transfer_id: 'tr-1', scientific_name: 'Amoxicillin', trade_name: null, concentration: '500 mg',
      dosage_form: 'Capsule', unit: 'capsule', national_code: '999', batch_number: 'B9', internal_batch_reference: null,
      expiry_date: '2027-06-01', sent_quantity: 10, received_quantity: null, status: 'in_transit',
      difference_reason: null, supply_type_text: null,
    }],
    warehouse_dispatches: [{
      id: 'wd-1', warehouse_id: WH_A, destination_distribution_point_id: 'out-1',
      dispatch_number: 'WD-1', status: 'draft', sent_at: null,
    }],
    warehouse_dispatch_lines: [],
    phoenix_paper_references: [],
    outlet_return_shipments: [{ id: 'sh-1', destination_warehouse_id: WH_A, status: 'in_transit', shipment_number: 'SH-1' }],
    outlet_return_shipment_lines: [{
      id: 'sl-1', shipment_id: 'sh-1', return_request_line_id: null, original_dispatch_line_id: 'dl-1',
      scientific_name: 'Omeprazole', batch_number: 'B7', expiry_date: '2027-03-01', sent_quantity: 20,
      received_quantity: null, status: 'sent', difference_reason: null, disposition: null, custody_state: 'in_transit',
    }],
    phoenix_outlet_return_exception_resolutions: [],
    phoenix_stock_correction_requests: [],
    phoenix_warehouse_correction_requests: [],
    profiles: [{ id: 'p1', full_name: 'T' }],
  };
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({
      matches: false, media: q, onchange: null,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
    }),
  });
  Element.prototype.getBoundingClientRect = function fake(this: Element) {
    const guided = this.hasAttribute?.('data-guide-id');
    const box = guided ? { top: 90, left: 60, width: 140, height: 40 } : { top: 0, left: 0, width: 320, height: 200 };
    return { ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => box } as DOMRect;
  };
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = originalRect;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

/* ── helpers ────────────────────────────────────────────────────────────────
 * PLAIN DOM QUERIES ONLY for anything inside InventoryCenterScreen.
 *
 * This harness mounts `<GuideEngine>` unconditionally (there is no
 * `useGuideHost` shell here to own an open/closed boolean), so its Help
 * Center is open from the very first render — which means
 * `useGuideBackgroundInert` marks the ENTIRE InventoryCenterScreen tree
 * `inert`/`aria-hidden` immediately, for the harness's whole lifetime.
 * `screen.getByRole`/`getByLabelText` respect that (by design — they compute
 * the ACCESSIBLE tree), so they can never see anything under it. Only the
 * guide's own portal content (never inert) is fair game for role queries;
 * everything else goes through `document.querySelector`, exactly like
 * `guide-ig2-panels.runtime.test.tsx` already does for the same reason.
 * ────────────────────────────────────────────────────────────────────────── */

function fieldByLabel(text: string): HTMLInputElement | HTMLSelectElement {
  const label = Array.from(document.querySelectorAll('label')).find(l => l.textContent?.trim() === text);
  if (!label) throw new Error(`no <label> reads "${text}"`);
  const forId = label.getAttribute('for');
  const el = forId ? document.getElementById(forId) : null;
  if (!el) throw new Error(`label "${text}" names no element`);
  return el as HTMLInputElement | HTMLSelectElement;
}

async function selectWarehouse() {
  await waitFor(() => expect(fieldByLabel('المخزن').querySelector('option[value="wh-A"]')).not.toBeNull());
  const select = fieldByLabel('المخزن') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: WH_A } });
  await waitFor(() => expect(select.value).toBe(WH_A));
}

function clickTab(labelAr: string) {
  const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(n => n.textContent === labelAr) as HTMLElement | undefined;
  if (!tab) {
    const seen = Array.from(document.querySelectorAll('[role="tab"]')).map(n => n.textContent).join(', ');
    throw new Error(`tab "${labelAr}" not found; tabs: ${seen}`);
  }
  fireEvent.click(tab);
}

async function openGuideCenter() {
  // Open from the harness's first render (see the block comment above) — this
  // just waits for the engine's own chunk/state to have settled.
  await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
}

function tourTitles(): string[] {
  return Array.from(document.querySelectorAll('.guide-tour-card__title')).map(n => n.textContent?.trim() ?? '');
}

async function startTour(title: string) {
  const card = Array.from(document.querySelectorAll('.guide-tour-card'))
    .find(n => n.querySelector('.guide-tour-card__title')?.textContent?.includes(title));
  if (!card) throw new Error(`tour "${title}" is not offered; offered: ${tourTitles().join(' | ')}`);
  const buttons = Array.from(card.querySelectorAll('.guide-tour-card__actions button')) as HTMLElement[];
  fireEvent.click(buttons[buttons.length - 1]);
  await waitFor(() => expect(document.querySelector('[data-guide-tour]')).not.toBeNull());
}

async function currentStepId(): Promise<string | undefined> {
  return document.querySelector('[data-guide-tour]')?.getAttribute('data-guide-step') ?? undefined;
}

async function advance() {
  const before = await currentStepId();
  const btn = document.querySelector('.guide-card .guide-btn--primary') as HTMLElement;
  fireEvent.click(btn);
  await waitFor(() => expect(currentStepId()).resolves.not.toBe(before));
}

async function walkToClosing(maxSteps = 15) {
  for (let i = 0; i < maxSteps; i += 1) {
    const id = await currentStepId();
    if (id === 'closing' || id?.endsWith('.closing')) return;
    await advance();
  }
  throw new Error('tour did not reach a closing step within the guard');
}

const TAB_LABEL: Record<string, string> = {
  intake: 'إدخال مواد', stock: 'رصيد المخزن', ledger: 'سجل الحركات',
  incoming: 'واردات تجهيز الدائرة', dispatch: 'تجهيز المنافذ',
  returns: 'استلام مرتجعات المنافذ', return_exceptions: 'استثناءات مرتجعات المنافذ',
  corrections: 'تصحيحات بانتظار الاعتماد',
};

const TOUR_TITLE_AR: Record<string, string> = {
  intake: 'إدخال مواد', stock: 'رصيد المخزن', ledger: 'سجل الحركات',
  incoming: 'واردات تجهيز الدائرة', dispatch: 'تجهيز المنافذ',
  returns: 'استلام مرتجعات المنافذ', return_exceptions: 'استثناءات مرتجعات المنافذ',
  corrections: 'تصحيحات بانتظار الاعتماد',
};

describe('IG-3 — each tab surface offers exactly its own tour, over the real screen', () => {
  for (const tab of Object.keys(TAB_LABEL)) {
    it(`offers "${TOUR_TITLE_AR[tab]}" while the ${tab} tab is open, real tab click and all`, async () => {
      render(<Harness />);
      await selectWarehouse();
      clickTab(TAB_LABEL[tab]);
      await openGuideCenter();
      expect(tourTitles()).toContain(TOUR_TITLE_AR[tab]);
    });
  }
});

describe('IG-3 — mutation freedom: walking every tour performs zero writes', () => {
  for (const tab of Object.keys(TAB_LABEL)) {
    it(`"${TOUR_TITLE_AR[tab]}" calls no write RPC across its whole walk`, async () => {
      render(<Harness />);
      await selectWarehouse();
      clickTab(TAB_LABEL[tab]);
      await openGuideCenter();
      await startTour(TOUR_TITLE_AR[tab]);
      await walkToClosing();
      const writesSeen = rpcCalls.filter(name => WRITE_RPCS.includes(name));
      expect(writesSeen, `write RPC(s) fired by the guide: ${writesSeen.join(', ')}`).toEqual([]);
    });
  }
});

describe('IG-3 — intake: the guide shows the region that actually rendered', () => {
  it('shows the blocked step, not the form step, for an institution warehouse', async () => {
    fixtures.__topology = [topologyRow({ warehouse_kind: 'institution' })];
    render(<Harness />);
    await selectWarehouse();
    clickTab(TAB_LABEL.intake);
    await waitFor(() => expect(document.body.textContent).toContain('الإدخال اليدوي وOCR غير متاحين لمخازن المؤسسات'));
    await openGuideCenter();
    await startTour(TOUR_TITLE_AR.intake);
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const id = await currentStepId();
      if (id) ids.push(id);
      if (id === 'intake.closing') break;
      await advance();
    }
    expect(ids).toContain('intake.blocked');
    expect(ids).not.toContain('intake.form');
    expect(ids).not.toContain('intake.submit');
  });

  it('preserves a half-typed intake form across starting, advancing and exiting the guide', async () => {
    render(<Harness />);
    await selectWarehouse();
    clickTab(TAB_LABEL.intake);
    await waitFor(() => expect(() => fieldByLabel('الاسم العلمي')).not.toThrow());
    const nameInput = fieldByLabel('الاسم العلمي') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Ibuprofen' } });
    expect(nameInput.value).toBe('Ibuprofen');

    await openGuideCenter();
    await startTour(TOUR_TITLE_AR.intake);
    await advance();
    await advance();
    // The overlay's own focus trap wires Escape to "exit tour" — see
    // GuideTourOverlay / useGuideFocusTrap. No visible close button is part
    // of the tour card itself (only Back/Next/Finish and "Skip tour").
    fireEvent.keyDown(document.querySelector('[data-guide-tour]')!, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('[data-guide-tour]')).toBeNull());

    expect((fieldByLabel('الاسم العلمي') as HTMLInputElement).value).toBe('Ibuprofen');
  });
});

describe('IG-3 — the guide adds no read beyond what each panel already makes', () => {
  it('opening and walking the incoming tour adds no table/RPC read the panel had not already made on its own', async () => {
    render(<Harness />);
    await selectWarehouse();
    clickTab(TAB_LABEL.incoming);
    // Wait for the panel's OWN load to actually settle (it reads both tables
    // itself, unprompted) before taking the "before" snapshot below.
    await waitFor(() => expect(readTables).toEqual(expect.arrayContaining(['warehouse_transfers', 'warehouse_transfer_lines'])));
    const readsBeforeGuide = new Set(readTables);
    const rpcsBeforeGuide = new Set(rpcCalls);

    await openGuideCenter();
    await startTour(TOUR_TITLE_AR.incoming);
    await walkToClosing();

    const newReads = readTables.filter(t => !readsBeforeGuide.has(t));
    const newRpcs = rpcCalls.filter(n => !rpcsBeforeGuide.has(n));
    expect(newReads, `new table reads: ${newReads.join(', ')}`).toEqual([]);
    expect(newRpcs, `new RPC calls: ${newRpcs.join(', ')}`).toEqual([]);
  });
});

describe('IG-3 — the guide never switches tabs on its own', () => {
  it('walking the stock tour end to end leaves the operator on the stock tab throughout', async () => {
    render(<Harness />);
    await selectWarehouse();
    clickTab(TAB_LABEL.stock);
    await openGuideCenter();
    await startTour(TOUR_TITLE_AR.stock);
    await walkToClosing();
    const stockTab = Array.from(document.querySelectorAll('[role="tab"]')).find(n => n.textContent === TAB_LABEL.stock);
    expect(stockTab).toHaveAttribute('aria-selected', 'true');
  });
});

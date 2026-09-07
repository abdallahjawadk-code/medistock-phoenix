/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

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

/**
 * IG-3-CORRECTION §6 — REQUEST LOGS, not sets.
 *
 * `rpcCalls`/`readTables` are plain arrays, pushed to on every call and never
 * deduplicated at the source — so multiplicity was always preserved HERE.
 * The defect the independent review found was one level up: the "no
 * additional read" test (below) used to snapshot these into a `Set` before
 * comparing, and `Set.has(name)` is blind to a SECOND call to a table/RPC
 * that had already been seen once before the snapshot — exactly the case
 * that matters (a duplicate read of an already-open table). The fix is a
 * length-slice diff (`array.slice(lengthAtSnapshotTime)`), not a rewrite of
 * these arrays — see the dedicated proof test further down, which runs both
 * techniques on the same log and shows the difference directly.
 *
 * `rpcParams`/`readFilters` are parallel, same-index logs of the arguments
 * each call carried, so a failure message can name not just "which table"
 * but "with which filter" — the "relevant arguments" half of §6.
 */
const rpcCalls: string[] = [];
const rpcParams: unknown[] = [];
const readTables: string[] = [];
const readFilters: Array<Array<{ op: string; column: string; value: unknown }>> = [];

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

const rpc = vi.fn((name: string, params?: unknown) => {
  rpcCalls.push(name);
  rpcParams.push(params);
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
  constructor(rows: Row[], private filterLog: Array<{ op: string; column: string; value: unknown }>) {
    this.rows = [...rows];
  }
  select(): this { return this; }
  eq(column: string, value: unknown): this {
    this.filterLog.push({ op: 'eq', column, value });
    this.rows = this.rows.filter(r => r[column] === value);
    return this;
  }
  is(column: string, value: unknown): this {
    this.filterLog.push({ op: 'is', column, value });
    this.rows = this.rows.filter(r => (r[column] ?? null) === value);
    return this;
  }
  in(column: string, values: unknown[]): this {
    this.filterLog.push({ op: 'in', column, value: values });
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
  const filterLog: Array<{ op: string; column: string; value: unknown }> = [];
  readFilters.push(filterLog);
  if (fixtures[table] === undefined) throw new Error(`test fixture missing for table ${table}`);
  return new Builder(fixtures[table], filterLog);
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

import { PhoenixAppShell } from '@/shared/ui/PhoenixAppShell';
import { InventoryCenterScreen } from '@/features/inventory/InventoryCenterScreen';

const WH_A = 'wh-A';

const topologyRow = (over: Row = {}): Row => ({
  node_kind: 'warehouse', organization_id: 'org-1', warehouse_id: WH_A,
  warehouse_name: 'Depot A', warehouse_name_ar: 'مستودع أ', warehouse_kind: 'central',
  warehouse_status: 'active', warehouse_is_main: false, structural_role: 'central_depot',
  facility_id: null, distribution_point_id: null, in_effective_scope: true, ...over,
});

/**
 * IG-3-CORRECTION §2 — a REAL open/close lifecycle, not an always-mounted
 * engine. `PhoenixAppShell` is the same shell component the real app (and
 * the QA harness) wraps every authenticated screen in: it owns `useGuideHost`
 * internally and renders the actual "Guide & Help" topbar entry, so opening
 * the guide here means a real click on the real control that ships to
 * production — not a harness shortcut that skips `useGuideHost` entirely.
 * The guide is CLOSED (nothing of it mounted) until that entry is clicked,
 * and clicking the Help Center's own close control genuinely unmounts it —
 * see `openGuideCenter`/`closeGuideCenter` below.
 */
function Harness() {
  return (
    <PhoenixAppShell currentScreen={3} onNavigate={() => undefined} onLogout={() => undefined}>
      <InventoryCenterScreen />
    </PhoenixAppShell>
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
  rpcParams.length = 0;
  readTables.length = 0;
  readFilters.length = 0;
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
    /**
     * IG-3-CORRECTION §5 — `sl-1` is the RETURNS tab's populated row
     * (`status: 'sent'`, still in `IN_TRANSIT_STATUSES` — see
     * receive-model.ts — so `assessReceive(...).individuallyReceivable` is
     * true). `sl-2` is a SEPARATE, genuinely `custody_state:
     * 'exception_pending'` line with no matching row in
     * `phoenix_outlet_return_exception_resolutions` below — this is what
     * `getExceptionPendingLines` (outlet-return.service.ts) actually filters
     * on (`.eq('custody_state', 'exception_pending')`), which `sl-1`'s
     * `'in_transit'` custody state never satisfied. The reviewed head's
     * fixture had only `sl-1`, so the return-exceptions tab's "populated
     * row" claim was never actually exercised — it always rendered its
     * empty state.
     */
    outlet_return_shipment_lines: [
      {
        id: 'sl-1', shipment_id: 'sh-1', return_request_line_id: null, original_dispatch_line_id: 'dl-1',
        scientific_name: 'Omeprazole', batch_number: 'B7', expiry_date: '2027-03-01', sent_quantity: 20,
        received_quantity: null, status: 'sent', difference_reason: null, disposition: null, custody_state: 'in_transit',
      },
      {
        id: 'sl-2', shipment_id: 'sh-1', return_request_line_id: null, original_dispatch_line_id: 'dl-2',
        scientific_name: 'Metronidazole', batch_number: 'B3', expiry_date: '2027-04-01', sent_quantity: 15,
        received_quantity: 0, status: 'received_with_difference', difference_reason: 'zero receipt on arrival',
        disposition: null, custody_state: 'exception_pending',
      },
    ],
    phoenix_outlet_return_exception_resolutions: [],
    /**
     * IG-3-CORRECTION §5 — one PENDING row per scope, with DIFFERENT
     * `proposed_by` identities: the outlet row was proposed by `p2` (a
     * different actor than the signed-in `p1`, so decide controls should
     * render for it), the warehouse row was proposed by `p1` (the signed-in
     * actor's OWN request, so the panel's own `isOwnRequest` branch must
     * hide decide controls and show `cor_own_request_notice` instead — the
     * real second-person rule, not the guide). The reviewed head's fixture
     * had both tables empty, so the corrections tab's "populated row" claim
     * was never actually exercised either.
     */
    outlet_stock: [{
      id: 'os-1', scientific_name: 'Ciprofloxacin', batch_number: 'B9', expiry_date: '2027-06-01',
      distribution_point_id: 'out-1', on_hand_quantity: 12, movement_seq: 3,
    }],
    phoenix_stock_correction_requests: [{
      id: 'occ-1', outlet_stock_id: 'os-1', on_hand_before: 12, counted_quantity: 9, variance: -3,
      reason: 'inventory count mismatch', notes: null, proposed_by: 'p2', proposed_at: '2026-01-05T09:00:00Z',
      status: 'pending',
    }],
    phoenix_warehouse_correction_requests: [{
      id: 'wcc-1', warehouse_stock_id: 'ws-1', on_hand_before: 40, new_quantity: 35, variance: -5,
      reason: 'physical count', source_document_number: null, notes: null, proposed_by: 'p1',
      proposed_at: '2026-01-04T09:00:00Z', status: 'pending',
    }],
    profiles: [{ id: 'p1', full_name: 'T' }, { id: 'p2', full_name: 'Reviewer Two' }],
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
 * The guide is CLOSED until `openGuideCenter()` performs a real click on the
 * real topbar entry (see the Harness doc comment above) — `useGuideBackground
 * Inert` therefore marks the InventoryCenterScreen tree inert/aria-hidden
 * only while the guide is genuinely open, exactly as in production.
 * `screen.getByRole`/`getByLabelText` respect that (by design — they compute
 * the ACCESSIBLE tree), so they can never see anything under it while open.
 * Only the guide's own portal content (never inert) is fair game for role
 * queries while open; everything else goes through `document.querySelector`,
 * exactly like `guide-ig2-panels.runtime.test.tsx` already does.
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

/**
 * IG-3-CORRECTION §2 — the REAL entry action: a click on the topbar's own
 * "Guide & Help" control (`GuideHost`'s `controller.open`, wired by
 * `PhoenixAppShell`), not a harness shortcut. Nothing of the guide is
 * mounted before this click — `React.lazy` means the engine's chunk resolves
 * asynchronously even in this same-process test, hence the `waitFor`.
 */
async function openGuideCenter() {
  const openButton = document.querySelector('[data-guide-id="guide.shell.topbar.help"]') as HTMLElement | null;
  if (!openButton) throw new Error('the real "Guide & Help" topbar entry was not found — is the viewport desktop-width?');
  fireEvent.click(openButton);
  await waitFor(() => expect(document.querySelector('[aria-labelledby="guide-center-title"]')).not.toBeNull());
}

/**
 * IG-3-CORRECTION §2 — the REAL exit action: a click on the Help Center's own
 * close control (`aria-label={t('guide_close', lang)}`, selected here by its
 * stable class rather than the translated string so this helper works in
 * either language). This calls the SAME `onClose` `GuideHost` handed the
 * engine, which flips `useGuideHost`'s `open` state to `false` and genuinely
 * UNMOUNTS `GuideEngine` — reaching a tour's closing card, or even clicking
 * Finish, does neither: both just return to the still-open catalog.
 */
async function closeGuideCenter() {
  // `.guide-center__head` also carries the language-switch button, which
  // shares the same `.guide-btn--quiet` class — excluded by its own
  // `data-guide-language-control` marker so this always finds the actual X.
  const headButtons = Array.from(document.querySelectorAll('.guide-center__head button')) as HTMLElement[];
  const closeButton = headButtons.find(b => !b.hasAttribute('data-guide-language-control')) ?? null;
  if (!closeButton) throw new Error('the Help Center close control was not found — is a tour still active?');
  fireEvent.click(closeButton);
  await waitFor(() => {
    expect(document.querySelector('.guide-layer')).toBeNull();
    expect(document.querySelector('[data-guide-tour]')).toBeNull();
    expect(document.querySelector('[aria-labelledby="guide-center-title"]')).toBeNull();
  });
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

/**
 * IG-3-CORRECTION §2 — actually presses Finish (the same `.guide-btn--primary`
 * button, on the tour's last step, calls `onFinish` instead of advancing —
 * see GuideTourOverlay.tsx). Reaching the closing CARD via `walkToClosing`
 * is not the same as completing the tour: this click is what the real
 * "Finish" action does, returning to the still-open Help Center catalog.
 */
async function finishTour() {
  const btn = document.querySelector('.guide-card .guide-btn--primary') as HTMLElement;
  if (!btn) throw new Error('no primary button found on the closing card — did walkToClosing run first?');
  fireEvent.click(btn);
  await waitFor(() => {
    expect(document.querySelector('[data-guide-tour]')).toBeNull();
    expect(document.querySelector('[aria-labelledby="guide-center-title"]')).not.toBeNull();
  });
}

/** `return_exceptions` stays here — the TAB itself is still real and
 *  reachable (unaffected by this correction); only its GUIDE tour is held. */
const TAB_LABEL: Record<string, string> = {
  intake: 'إدخال مواد', stock: 'رصيد المخزن', ledger: 'سجل الحركات',
  incoming: 'واردات تجهيز الدائرة', dispatch: 'تجهيز المنافذ',
  returns: 'استلام مرتجعات المنافذ', return_exceptions: 'استثناءات مرتجعات المنافذ',
  corrections: 'تصحيحات بانتظار الاعتماد',
};

/**
 * IG-3-CORRECTION — `return_exceptions` is deliberately ABSENT: a second
 * independent review found the entire `guide.tour.return-exceptions` tour
 * has no independent authorization basis (unlike `returns`), so it was
 * removed from the registry outright — see guide.registry.ts's module doc
 * comment above the former tour's definition. There is no tour to look for
 * by title for this tab; see the dedicated "held tour" describe blocks below
 * for its own regression coverage.
 */
const TOUR_TITLE_AR: Record<string, string> = {
  intake: 'إدخال مواد', stock: 'رصيد المخزن', ledger: 'سجل الحركات',
  incoming: 'واردات تجهيز الدائرة', dispatch: 'تجهيز المنافذ',
  returns: 'استلام مرتجعات المنافذ',
  corrections: 'تصحيحات بانتظار الاعتماد',
};

/** The seven tabs that still offer a real IG-3 tour. */
const AVAILABLE_TABS = Object.keys(TOUR_TITLE_AR);

describe('IG-3 — each tab surface offers exactly its own tour, over the real screen', () => {
  for (const tab of AVAILABLE_TABS) {
    it(`offers "${TOUR_TITLE_AR[tab]}" while the ${tab} tab is open, real tab click and all`, async () => {
      render(<Harness />);
      await selectWarehouse();
      clickTab(TAB_LABEL[tab]);
      await openGuideCenter();
      expect(tourTitles()).toContain(TOUR_TITLE_AR[tab]);
    });
  }

  it('offers NO tour at all while the return_exceptions tab is open — the entire tour is held, not merely hidden', async () => {
    render(<Harness />);
    await selectWarehouse();
    clickTab(TAB_LABEL.return_exceptions);
    await openGuideCenter();
    expect(tourTitles()).not.toContain('استثناءات مرتجعات المنافذ');
  });
});

describe('IG-3 — mutation freedom: walking every tour performs zero writes', () => {
  for (const tab of AVAILABLE_TABS) {
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

/**
 * Per-tab "the panel's own initial load has settled" signal — the table(s)
 * that tab's real child component reads, unprompted, on its own mount. Tabs
 * with no per-tab-mounted async child of their own (intake/stock/ledger read
 * from `warehouse_stock`, already fetched before any tab was ever clicked)
 * fall through to the generic aria-selected wait.
 */
async function settleForTab(tab: string): Promise<void> {
  const signalTables: Record<string, string[]> = {
    incoming: ['warehouse_transfers', 'warehouse_transfer_lines'],
    dispatch: ['warehouse_dispatches'],
    returns: ['outlet_return_shipments', 'outlet_return_shipment_lines'],
    return_exceptions: ['outlet_return_shipments', 'outlet_return_shipment_lines', 'phoenix_outlet_return_exception_resolutions'],
    corrections: ['phoenix_stock_correction_requests', 'phoenix_warehouse_correction_requests'],
  };
  const signal = signalTables[tab];
  if (signal) {
    await waitFor(() => expect(readTables).toEqual(expect.arrayContaining(signal)));
    return;
  }
  await waitFor(() => expect(
    Array.from(document.querySelectorAll('[role="tab"]')).find(n => n.getAttribute('aria-selected') === 'true'),
  ).not.toBeUndefined());
}

describe('IG-3-CORRECTION §2 — the COMPLETE guide lifecycle (real open → tour → real Finish → real close) adds no read, RPC, or write', () => {
  /**
   * IG-3-CORRECTION §2 — this replaces a version that opened the guide via an
   * always-mounted `<GuideEngine>` and stopped measuring at "reached the
   * closing card". Neither was the real lifecycle: production mounts nothing
   * of the guide until `useGuideHost`'s real `open()` fires (see the Harness
   * doc comment above), and reaching a closing CARD is not the same as
   * pressing Finish, which is not the same as closing the Help Center itself
   * — `onFinish`/`onExitTour` both return to the still-mounted, still-open
   * catalog (GuideEngine.tsx), and only the Help Center's own close control
   * calls the `onClose` that actually unmounts the engine. This test walks
   * the REAL sequence end to end — closed → real open click → start → advance
   * → real Finish click → real close click → confirmed unmount — and proves
   * NOTHING beyond the panel's own settled initial load was read, called, or
   * written anywhere across the whole thing.
   *
   * §6's count-preserving technique is unchanged here: a length-slice on the
   * append-only `readTables`/`rpcCalls` logs catches every read/call after
   * the snapshot, including a repeat of one already seen — see the dedicated
   * proof test below for a direct demonstration against the rejected
   * `Set`-based alternative.
   */
  for (const tab of AVAILABLE_TABS) {
    it(`"${TOUR_TITLE_AR[tab]}": the complete open→start→advance→Finish→close lifecycle adds nothing beyond the panel's own settled initial load`, async () => {
      render(<Harness />);
      await selectWarehouse();
      clickTab(TAB_LABEL[tab]);
      await settleForTab(tab);

      // The guide is genuinely CLOSED at this point — nothing of it mounted.
      expect(document.querySelector('.guide-layer')).toBeNull();
      expect(document.querySelector('[data-guide-tour]')).toBeNull();

      const readsBeforeLen = readTables.length;
      const rpcsBeforeLen = rpcCalls.length;

      await openGuideCenter();
      await startTour(TOUR_TITLE_AR[tab]);
      await walkToClosing();
      await finishTour();
      await closeGuideCenter();

      const newReads = readTables.slice(readsBeforeLen);
      const newRpcs = rpcCalls.slice(rpcsBeforeLen);
      const writesSeen = newRpcs.filter(name => WRITE_RPCS.includes(name));
      expect(newReads, `new/duplicate table read(s) across the complete lifecycle: ${newReads.join(', ')} (filters: ${JSON.stringify(readFilters.slice(readsBeforeLen))})`).toEqual([]);
      expect(newRpcs, `new/duplicate RPC call(s) across the complete lifecycle: ${newRpcs.join(', ')} (params: ${JSON.stringify(rpcParams.slice(rpcsBeforeLen))})`).toEqual([]);
      expect(writesSeen, `write RPC(s) fired across the complete lifecycle: ${writesSeen.join(', ')}`).toEqual([]);
    });
  }

  /**
   * The held tab: no tour to start, but the FULL open→close lifecycle (real
   * clicks both ways) must still add nothing. Verifies absence rather than
   * fabricating eligibility — see the dedicated "held tour" describes above
   * and in guide-ig3-tours.test.ts for the registry-level proof.
   */
  it('the held return_exceptions tab: opening and closing the Help Center (no tour to start) adds nothing beyond the panel\'s own settled initial load', async () => {
    render(<Harness />);
    await selectWarehouse();
    clickTab(TAB_LABEL.return_exceptions);
    await settleForTab('return_exceptions');
    expect(document.querySelector('.guide-layer')).toBeNull();

    const readsBeforeLen = readTables.length;
    const rpcsBeforeLen = rpcCalls.length;

    await openGuideCenter();
    expect(tourTitles()).not.toContain('استثناءات مرتجعات المنافذ');
    await closeGuideCenter();

    const newReads = readTables.slice(readsBeforeLen);
    const newRpcs = rpcCalls.slice(rpcsBeforeLen);
    expect(newReads, `new/duplicate table read(s): ${newReads.join(', ')}`).toEqual([]);
    expect(newRpcs, `new/duplicate RPC call(s): ${newRpcs.join(', ')}`).toEqual([]);
  });
});

describe('IG-3-CORRECTION §6 — the measurement itself is proven to catch a duplicate request a Set-based diff would miss', () => {
  it('a length-slice diff catches a second call to an already-seen table; the old Set-based diff it replaces does not', () => {
    // "Before" state: the panel's own initial load has already read this
    // table once — exactly the steady state every real per-tab test above
    // snapshots from.
    from('warehouse_stock');
    const readsBeforeLen = readTables.length;
    const readsBeforeSet = new Set(readTables); // the OLD, rejected technique

    // Controlled perturbation: something (hypothetically the guide) reads
    // the SAME already-seen table a second time. This is the exact shape of
    // bug this correction exists to catch.
    from('warehouse_stock');

    const caughtByLengthSlice = readTables.slice(readsBeforeLen);
    const caughtByOldSetDiff = readTables.filter(t => !readsBeforeSet.has(t));

    expect(caughtByLengthSlice, 'the corrected measurement must catch the duplicate').toEqual(['warehouse_stock']);
    expect(caughtByOldSetDiff, 'the old Set-based measurement this replaces was blind to it — that is precisely the defect').toEqual([]);
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

/** Walk up to `maxLevels` ancestors looking for `text` in combined descendant content. */
function ancestorContains(el: Element, text: string, maxLevels = 6): boolean {
  let node: Element | null = el;
  for (let i = 0; i < maxLevels && node; i += 1) {
    if (node.textContent?.includes(text)) return true;
    node = node.parentElement;
  }
  return false;
}

async function stepIdsUntil(closingId: string, maxSteps = 12): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < maxSteps; i += 1) {
    const id = await currentStepId();
    if (id) ids.push(id);
    if (id === closingId) return ids;
    await advance();
  }
  throw new Error(`did not reach "${closingId}" within the guard; saw: ${ids.join(', ')}`);
}

/**
 * ── IG-3-CORRECTION §5 ───────────────────────────────────────────────────
 *
 * incoming/dispatch are the only two of the eight tours that still carry a
 * real per-row action anchor (they are gated on the global, synchronous
 * `myPermissions` set, structurally immune to the A→B→A staleness class —
 * see the module doc comments in guide.registry.ts) — so they are the right
 * place to prove a per-row anchor is unique and belongs to the actual
 * fixture row it claims to describe, over REAL rendered rows.
 */
describe('IG-3-CORRECTION §5 — incoming/dispatch: the surviving per-row action anchor is unique and belongs to the real fixture row', () => {
  it('incoming.receive anchors exactly one element, inside the real Amoxicillin transfer-line row', async () => {
    render(<Harness />);
    await selectWarehouse();
    clickTab(TAB_LABEL.incoming);
    await waitFor(() => expect(document.body.textContent).toContain('Amoxicillin'));
    await openGuideCenter();
    await startTour(TOUR_TITLE_AR.incoming);
    const ids = await stepIdsUntil('incoming.closing');
    expect(ids).toContain('incoming.receive');

    const anchored = document.querySelectorAll('[data-guide-id="guide.incoming.row.receive-action"]');
    expect(anchored.length).toBe(1);
    expect(ancestorContains(anchored[0], 'Amoxicillin')).toBe(true);
  });

  it('dispatch.send anchors exactly one element, inside the real WD-1 draft dispatch row', async () => {
    render(<Harness />);
    await selectWarehouse();
    clickTab(TAB_LABEL.dispatch);
    await waitFor(() => expect(document.body.textContent).toContain('WD-1'));
    await openGuideCenter();
    await startTour(TOUR_TITLE_AR.dispatch);
    const ids = await stepIdsUntil('dispatch.closing');
    expect(ids).toContain('dispatch.send');

    const anchored = document.querySelectorAll('[data-guide-id="guide.dispatch.row.actions"]');
    expect(anchored.length).toBe(1);
    expect(ancestorContains(anchored[0], 'WD-1')).toBe(true);
  });
});

/**
 * IG-3-CORRECTION — a second independent review found that the ENTIRE
 * `guide.tour.return-exceptions` tour (not merely its former `.resolve`
 * step) has no independent authorization basis, so it was removed from the
 * registry outright — see guide.registry.ts's module doc comment above the
 * former tour's definition. `sl-2` (custody_state 'exception_pending', no
 * matching row in `phoenix_outlet_return_exception_resolutions`) is kept as
 * a fixture specifically so the FIRST test below can show the hold is a
 * deliberate authorization decision against a panel that genuinely renders
 * a populated row — not an accident of a panel that never renders anything.
 */
describe('IG-3-CORRECTION — return-exceptions: the held tour stays absent whether the queue is populated or empty', () => {
  it('renders the real populated Metronidazole row (operational, unrelated to the guide) yet still offers no tour and no anchor', async () => {
    render(<Harness />);
    await selectWarehouse();
    clickTab(TAB_LABEL.return_exceptions);
    await waitFor(() => expect(document.body.textContent).toContain('Metronidazole'));
    // The RETURNS-tab line (custody_state 'in_transit') must not leak into
    // this queue — it belongs to a different tab/context.
    expect(document.body.textContent).not.toContain('Omeprazole');

    await openGuideCenter();
    expect(tourTitles()).not.toContain('استثناءات مرتجعات المنافذ');
    expect(document.querySelectorAll('[data-guide-id="guide.return-exceptions.list.region"]').length).toBe(0);
  });

  it('stays absent when the queue is genuinely empty too', async () => {
    fixtures.outlet_return_shipment_lines = fixtures.outlet_return_shipment_lines.filter(
      l => l.custody_state !== 'exception_pending',
    );
    render(<Harness />);
    await selectWarehouse();
    clickTab(TAB_LABEL.return_exceptions);
    await waitFor(() => expect(document.body.textContent).not.toContain('Metronidazole'));

    await openGuideCenter();
    expect(tourTitles()).not.toContain('استثناءات مرتجعات المنافذ');
  });
});

/**
 * The reviewed head's fixture left BOTH `phoenix_stock_correction_requests`
 * and `phoenix_warehouse_correction_requests` empty, so the corrections
 * tab's "populated row" claim was likewise never exercised. The fixture now
 * carries one PENDING row per scope with different `proposed_by` identities
 * — proving the real, pre-existing (non-guide) second-person rule renders
 * correctly is part of establishing that the frozen example row the guide
 * points at is a genuine, correctly-scoped row, not an artifact.
 */
describe('IG-3-CORRECTION §5 — corrections: reaches genuinely populated pending requests across both scopes, with real proposer/reviewer identity', () => {
  it('renders both scope rows, hides decide controls on the signed-in actor\'s own request, and offers corrections.list anchored uniquely', async () => {
    render(<Harness />);
    await selectWarehouse();
    clickTab(TAB_LABEL.corrections);
    await waitFor(() => expect(document.body.textContent).toContain('Ciprofloxacin'));
    expect(document.body.textContent).toContain('Paracetamol');
    // Real operational (non-guide) behavior: p1 is signed in and proposed
    // the WAREHOUSE-scope row — the panel's own isOwnRequest branch must
    // hide decide controls for it and show the own-request notice instead.
    expect(document.body.textContent).toContain('هذا طلبك — لا يمكنك اعتماده بنفسك');
    // The OUTLET-scope row was proposed by a different actor (p2) — decide
    // controls must render for it.
    expect(document.body.textContent).toContain('اعتماد');

    await openGuideCenter();
    await startTour(TOUR_TITLE_AR.corrections);
    const ids = await stepIdsUntil('corrections.closing');
    expect(ids).toContain('corrections.list');
    expect(ids).not.toContain('corrections.decide');

    const anchored = document.querySelectorAll('[data-guide-id="guide.corrections.list.region"]');
    expect(anchored.length).toBe(1);
    expect(anchored[0].textContent).toContain('Ciprofloxacin');
    expect(anchored[0].textContent).toContain('Paracetamol');
  });
});

describe('IG-3-CORRECTION §5 — corrections: an empty queue is handled honestly, never fabricated', () => {
  it('drops corrections.list when both scopes are empty, keeps tab/closing, and never resurrects the held decide step', async () => {
    fixtures.phoenix_stock_correction_requests = [];
    fixtures.phoenix_warehouse_correction_requests = [];
    render(<Harness />);
    await selectWarehouse();
    clickTab(TAB_LABEL.corrections);
    await waitFor(() => expect(document.body.textContent).not.toContain('Ciprofloxacin'));

    await openGuideCenter();
    await startTour(TOUR_TITLE_AR.corrections);
    const ids = await stepIdsUntil('corrections.closing');
    expect(ids).toContain('corrections.tab');
    expect(ids).not.toContain('corrections.list');
    expect(ids).not.toContain('corrections.decide');
    expect(ids).toContain('corrections.closing');
  });
});

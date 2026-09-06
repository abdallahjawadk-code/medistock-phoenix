/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useMemo, useState } from 'react';

/**
 * INTERACTIVE-GUIDE-IG2 — THE TOURS, OVER THE REAL PANELS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS SEPARATELY
 *
 * `guide-ig2-tours.runtime.test.tsx` drives the ENGINE against a stand-in
 * surface, which is the right instrument for eligibility and invalidation
 * because every state can be commanded. It cannot say anything about the
 * panels: a stand-in always renders every anchor, so it can never show what
 * happens when a list is empty, when the operator has a form open, when the
 * example row is disposed of, or when a reload reorders the list.
 *
 * Everything below renders the ACTUAL QuarantinePanel and
 * MaterialDispensingSuspensionPanel — their real states, their real anchors,
 * their real forms — and walks each tour over them, end to end, one tour at a
 * time. Only the Supabase client and the RBAC transport are replaced, at their
 * own seams, so the panels' own reads resolve from fixtures.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/* ── the data the real panels read ──────────────────────────────────────── */

type Row = Record<string, unknown>;
let fixtures: Record<string, Row[]> = {};
const rpcCalls: string[] = [];
const readTables: string[] = [];

/**
 * Every RPC the panels' own code path makes, recorded by name.
 *
 * NOT every RPC is a write. `phoenix_query_organization_scope_topology` is a
 * SECURITY INVOKER read the suspension panel legitimately performs on mount to
 * resolve its outlet catalog, and counting it as a mutation would make the
 * "nothing operational happened" assertion meaningless in both directions. So
 * the suites below assert two separate things: that no name from the write
 * vocabulary is ever called, and that the guide adds no call of ANY kind to
 * what the panel had already made before the tour started.
 */
const WRITE_RPCS = [
  'phoenix_release_quarantine_stock',
  'phoenix_destroy_quarantine_stock',
  'phoenix_suspend_material_dispensing',
  'phoenix_lift_material_dispensing_suspension',
];

const rpc = vi.fn((name: string) => {
  rpcCalls.push(name);
  return Promise.resolve({ data: [], error: null });
});

class Builder implements PromiseLike<{ data: unknown; error: null }> {
  private rows: Row[];
  constructor(rows: Row[]) { this.rows = [...rows]; }
  select(): this { return this; }
  eq(column: string, value: unknown): this {
    this.rows = this.rows.filter(r => r[column] === value);
    return this;
  }
  gt(column: string, value: number): this {
    this.rows = this.rows.filter(r => Number(r[column]) > value);
    return this;
  }
  order(): this { return this; }
  in(): this { return this; }
  limit(): this { return this; }
  then<A, B = never>(
    onfulfilled?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve({ data: this.rows as unknown, error: null }).then(onfulfilled, onrejected);
  }
}

const from = vi.fn((table: string) => {
  readTables.push(table);
  if (fixtures[table] === undefined) throw new Error(`test fixture missing for table ${table}`);
  return new Builder(fixtures[table]);
});

vi.mock('@/shared/supabase/client', () => ({
  supabase: { rpc: (n: string) => rpc(n), from: (t: string) => from(t) },
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
  myPermissions: new Set<string>(),
  profile: { id: 'p1', full_name: 'T', role: 'central_warehouse_manager', organization_id: 'org-1' },
  session: { user: { id: 'u1' } } as { user: { id: string } } | null,
  authStatus: 'authenticated',
  toggleLang: () => undefined,
  toggleTheme: () => undefined,
};
let notify: (() => void) | null = null;
vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
vi.mock('@/shared/ui/PhoenixIcon', () => ({
  PhoenixIcon: ({ name }: { name: string }) => <span aria-hidden="true" data-icon={name} />,
}));
// The material resolver is a search surface over the catalog; the create form's
// own fields are what the tour describes, and the resolver's network shape is
// not this suite's subject.
vi.mock('@/shared/materials/PhoenixMaterialResolver', () => ({
  PhoenixMaterialResolver: ({ label }: { label: string }) => <div>{label}</div>,
}));

import { GUIDE_ANCHORS, guideAnchorSelector } from '../guide.anchors';
import { GUIDE_CAPABILITIES, GUIDE_REGISTRY } from '../guide.registry';
import { GuideEngine } from '../GuideEngine';
import {
  GuideSurfaceProvider,
  useGuideCapabilities,
  useGuideSurface,
} from '../guide.surface';
import { QuarantinePanel } from '@/features/inventory/QuarantinePanel';
import { MaterialDispensingSuspensionPanel } from '@/features/inventory/MaterialDispensingSuspensionPanel';

const INERT_DRAWER = { isAvailable: false, isOpen: false, open: () => undefined, close: () => undefined };

const MIK_PARA = 'mik/paracetamol';
const MIK_OMEP = 'mik/omeprazole';

const quarantineRow = (over: Row = {}): Row => ({
  id: 'q1', warehouse_id: 'wh-A', scientific_name: 'Paracetamol',
  batch_number: null, national_code: null, expiry_date: '2026-09-30',
  quarantine_reason: 'short_receipt', quantity: 2,
  material_identity_key: MIK_PARA, internal_batch_reference: null,
  supply_type: null, purchase_origin: null, ...over,
});

const stockRow = (over: Row = {}): Row => ({
  id: 's1', warehouse_id: 'wh-A', scientific_name: 'Paracetamol',
  batch_number: null, expiry_date: '2026-09-30', on_hand_quantity: 42,
  reserved_quantity: 0, available_quantity: 42, national_code: null,
  central_item_id: 'ci-para', concentration: '500 mg', dosage_form: 'Tablet',
  unit: 'tablet', material_identity_key: MIK_PARA, internal_batch_reference: null,
  supply_type: null, purchase_origin: null, ...over,
});

const suspensionRow = (over: Row = {}): Row => ({
  id: 'm1', central_item_id: 'ci-amox', organization_id: 'org-1',
  distribution_point_id: null, reason_code: 'regulatory_hold',
  reason_detail: null, reference_document: null,
  effective_start: '2026-08-20T07:00:00Z', effective_end: null,
  created_by: 'p1', created_at: '2026-08-20T07:00:00Z',
  lifted_by: null, lifted_at: null, lift_reason: null,
  central_items: { name: 'Amoxicillin', name_ar: 'أموكسيسيلين' }, ...over,
});

/* ── the harness: the real panels under the real engine ─────────────────── */

const ALL_CAPS: Record<string, boolean> = {
  [GUIDE_CAPABILITIES.quarantineView]: true,
  [GUIDE_CAPABILITIES.quarantineDispose]: true,
  [GUIDE_CAPABILITIES.suspensionView]: true,
  [GUIDE_CAPABILITIES.suspensionCreate]: true,
  [GUIDE_CAPABILITIES.suspensionLift]: true,
};

/**
 * Stands in for InventoryCenterScreen's SURFACE and CAPABILITY publishing
 * only — the part proven separately, against the real async hook, in
 * guide-ig2-scope-attribution.runtime.test.tsx. The panels below it are the
 * real ones, and everything this file asserts is about them.
 */
function Publisher({ tab, caps }: { tab: string; caps: Record<string, boolean> }) {
  useGuideSurface(3, tab);
  useGuideCapabilities('screen', caps, 'ready', 'wh:A');
  // The two tab buttons are the Inventory Center's own anchors, not the
  // panels'. They are rendered here for the same reason the surface is
  // published here: this stands in for the screen, and the panels below are
  // the real thing.
  return (
    <div role="tablist">
      <button type="button" data-guide-id={GUIDE_ANCHORS.inventoryTabQuarantine}>q</button>
      <button type="button" data-guide-id={GUIDE_ANCHORS.inventoryTabSuspensions}>s</button>
    </div>
  );
}

function Harness({
  tab = 'quarantine',
  caps = ALL_CAPS,
  canDispose = true,
}: { tab?: string; caps?: Record<string, boolean>; canDispose?: boolean }) {
  const [, force] = useState(0);
  notify = () => force(n => n + 1);
  const drawer = useMemo(() => INERT_DRAWER, []);
  return (
    <GuideSurfaceProvider>
      <Publisher tab={tab} caps={caps} />
      {tab === 'quarantine' && <QuarantinePanel warehouseId="wh-A" canDispose={canDispose} />}
      {tab === 'suspensions' && <MaterialDispensingSuspensionPanel organizationId="org-1" />}
      <GuideEngine currentScreen={3} onNavigate={() => undefined} drawer={drawer} onClose={() => undefined} />
    </GuideSurfaceProvider>
  );
}

const originalRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  appState = { ...appState, lang: 'ar', dir: 'rtl' };
  window.localStorage.clear();
  rpcCalls.length = 0;
  readTables.length = 0;
  rpc.mockClear();
  from.mockClear();
  fixtures = {
    warehouse_quarantine_stock: [quarantineRow()],
    warehouse_stock: [stockRow()],
    material_dispensing_suspensions: [suspensionRow()],
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
  // Every guide-anchored element gets a usable box; everything else is the
  // page. Enough for resolveTarget's "present AND usable" rule, which is the
  // only geometry this suite depends on.
  Element.prototype.getBoundingClientRect = function fake(this: Element) {
    const guided = this.hasAttribute?.('data-guide-id');
    const box = guided ? { top: 90, left: 60, width: 140, height: 40 } : { top: 0, left: 0, width: 320, height: 200 };
    return { ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top, toJSON: () => box } as DOMRect;
  };
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  cleanup();
  notify = null;
  Element.prototype.getBoundingClientRect = originalRect;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

/* ── helpers ────────────────────────────────────────────────────────────── */

const anchorsInDocument = () =>
  Array.from(document.querySelectorAll('[data-guide-id]'))
    .map(n => n.getAttribute('data-guide-id') as string);

const countAnchor = (id: string) => document.querySelectorAll(guideAnchorSelector(id)).length;

async function openCenter() {
  const name = appState.lang === 'ar' ? 'الدليل والمساعدة' : 'Guide & Help';
  await waitFor(() => expect(screen.getByRole('dialog', { name })).toBeInTheDocument());
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

const layer = (): HTMLElement => {
  const n = document.querySelector('[data-guide-tour]');
  if (!n) throw new Error('no tour overlay');
  return n as HTMLElement;
};

const nextLabel = () => (appState.lang === 'ar' ? 'التالي' : 'Next');
const skipLabel = () => (appState.lang === 'ar' ? 'تخطّي الجولة' : 'Skip tour');

/**
 * Make the real panel re-read its list, the way it does after a disposition.
 *
 * `reload` is keyed on the warehouse and the language, so flipping the language
 * back and forth runs the panel's OWN loader against whatever the fixtures now
 * hold — no test-only reload hook, and no reaching inside the component.
 */
async function reloadPanel() {
  const before = readTables.length;
  act(() => {
    appState = appState.lang === 'ar'
      ? { ...appState, lang: 'en', dir: 'ltr' }
      : { ...appState, lang: 'ar', dir: 'rtl' };
    notify?.();
  });
  await waitFor(() => expect(readTables.length).toBeGreaterThan(before));
}

/** Walk one tour to its end, recording (step id, resolved anchor) per step. */
async function walk(): Promise<Array<{ step: string; anchor: string }>> {
  const seen: Array<{ step: string; anchor: string }> = [];
  for (let i = 0; i < 25; i += 1) {
    await waitFor(() => expect(layer().dataset.guideAnchor).toBeDefined());
    seen.push({
      step: layer().dataset.guideStep as string,
      anchor: layer().dataset.guideAnchor as string,
    });
    const next = screen.queryByRole('button', { name: nextLabel() });
    if (!next) break;
    fireEvent.click(next);
    await waitFor(() => expect(layer().dataset.guideStep).not.toBe(seen[seen.length - 1].step));
  }
  return seen;
}

/* ════════════════════════════════════════════════════════════════════════ */

describe('IG-2 · quarantine — the panel’s real states decide which steps exist', () => {
  it('walks the whole tour over the real panel, every step on a real anchor', async () => {
    render(<Harness tab="quarantine" />);
    await openCenter();
    await startTour('الحجر الصحي');
    const seen = await walk();

    expect(seen.map(s => s.step)).toEqual([
      'quarantine.tab', 'quarantine.list', 'quarantine.identity',
      'quarantine.quantity', 'quarantine.release', 'quarantine.destroy',
      'quarantine.closing',
    ]);
    // Every step that declares an anchor found one in the real DOM; only the
    // deliberately anchorless closing card is centred.
    for (const { step, anchor } of seen) {
      if (step === 'quarantine.closing') expect(anchor).toBe('none');
      else expect(anchor, `${step} fell back to a centred card`).not.toBe('none');
    }
    expect(seen.find(s => s.step === 'quarantine.identity')?.anchor)
      .toBe(GUIDE_ANCHORS.quarantineRowIdentity);
    expect(seen.find(s => s.step === 'quarantine.release')?.anchor)
      .toBe(GUIDE_ANCHORS.quarantineReleaseAction);
  });

  it('an EMPTY list keeps the region step and drops the row steps', async () => {
    fixtures.warehouse_quarantine_stock = [];
    render(<Harness tab="quarantine" />);
    await openCenter();
    await startTour('الحجر الصحي');
    const seen = await walk();

    // The empty state IS the region, and carries its anchor.
    expect(anchorsInDocument()).toContain(GUIDE_ANCHORS.quarantineList);
    expect(seen.map(s => s.step)).toEqual(['quarantine.tab', 'quarantine.list', 'quarantine.closing']);
    expect(seen.find(s => s.step === 'quarantine.list')?.anchor).toBe(GUIDE_ANCHORS.quarantineList);
    // Absent, not centred: there is no row to describe.
    expect(seen.map(s => s.step)).not.toContain('quarantine.identity');
    expect(seen.map(s => s.step)).not.toContain('quarantine.release');
  });

  it('a FAILED read offers no step about a list that is not there', async () => {
    from.mockImplementationOnce(() => { throw new Error('read failed'); });
    render(<Harness tab="quarantine" />);
    await waitFor(() => expect(document.querySelector('.nexus-error-state, [role="alert"]')).not.toBeNull());
    await openCenter();
    await startTour('الحجر الصحي');
    const seen = await walk();
    expect(seen.map(s => s.step)).toEqual(['quarantine.tab', 'quarantine.closing']);
  });

  it('a view-only operator gets the reading steps and no disposition steps', async () => {
    const viewOnly = { [GUIDE_CAPABILITIES.quarantineView]: true };
    render(<Harness tab="quarantine" caps={viewOnly} canDispose={false} />);
    await openCenter();
    await startTour('الحجر الصحي');
    const seen = await walk();
    expect(seen.map(s => s.step)).toEqual([
      'quarantine.tab', 'quarantine.list', 'quarantine.identity',
      'quarantine.quantity', 'quarantine.closing',
    ]);
    // ...and the panel rendered no disposition area at all for them.
    expect(countAnchor(GUIDE_ANCHORS.quarantineRowActions)).toBe(0);
  });
});

describe('IG-2 · quarantine — a form the OPERATOR opened is not a broken step', () => {
  async function openReleaseForm() {
    render(<Harness tab="quarantine" />);
    await waitFor(() => expect(screen.getByText('إفراج')).toBeInTheDocument());
    fireEvent.click(screen.getByText('إفراج'));
    await waitFor(() => expect(screen.getByLabelText('سبب القرار')).toBeInTheDocument());
  }

  it('keeps the release step on the row’s disposition region while the form is open', async () => {
    await openReleaseForm();
    // The precise button wrapper is genuinely gone — the form replaced it.
    expect(countAnchor(GUIDE_ANCHORS.quarantineReleaseAction)).toBe(0);
    expect(countAnchor(GUIDE_ANCHORS.quarantineRowActions)).toBe(1);

    await openCenter();
    await startTour('الحجر الصحي');
    const seen = await walk();
    const release = seen.find(s => s.step === 'quarantine.release');
    expect(release, 'the release step must still exist').toBeDefined();
    // Not a centred fallback: the declared region anchor took over.
    expect(release?.anchor).toBe(GUIDE_ANCHORS.quarantineRowActions);
  });

  it('preserves what the operator typed across starting, exiting and switching language', async () => {
    await openReleaseForm();
    fireEvent.change(screen.getByLabelText('الكمية'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('سبب القرار'), { target: { value: 'فحص مخبري' } });

    await openCenter();
    await startTour('الحجر الصحي');
    await walk();

    act(() => { appState = { ...appState, lang: 'en', dir: 'ltr' }; notify?.(); });
    await waitFor(() => expect(screen.getByLabelText('Decision reason')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(document.querySelector('[data-guide-tour]')).toBeNull());

    expect((screen.getByLabelText('Quantity') as HTMLInputElement).value).toBe('1');
    expect((screen.getByLabelText('Decision reason') as HTMLInputElement).value).toBe('فحص مخبري');
  });

  it('opens no form of its own — the release form’s fields never appear', async () => {
    render(<Harness tab="quarantine" />);
    await openCenter();
    await startTour('الحجر الصحي');
    await walk();
    // The release form auto-selects a destination lot the instant it opens.
    // If the guide had opened it, this field would exist.
    expect(screen.queryByLabelText('سبب القرار')).toBeNull();
    expect(screen.queryByLabelText('الدفعة المستقبلة')).toBeNull();
  });
});

describe('IG-2 · quarantine — one declared example row, and it does not drift', () => {
  const threeRows = () => ([
    quarantineRow({ id: 'q1', scientific_name: 'Paracetamol' }),
    quarantineRow({ id: 'q2', scientific_name: 'Omeprazole', material_identity_key: MIK_OMEP, batch_number: 'OMP1' }),
    quarantineRow({ id: 'q3', scientific_name: 'Amoxicillin', material_identity_key: 'mik/amox', batch_number: 'AMX1' }),
  ]);

  it('anchors exactly ONE row however many there are', async () => {
    fixtures.warehouse_quarantine_stock = threeRows();
    render(<Harness tab="quarantine" />);
    await waitFor(() => expect(screen.getByText('Amoxicillin')).toBeInTheDocument());

    for (const anchor of [
      GUIDE_ANCHORS.quarantineRowIdentity, GUIDE_ANCHORS.quarantineRowQuantity,
      GUIDE_ANCHORS.quarantineRowActions, GUIDE_ANCHORS.quarantineReleaseAction,
      GUIDE_ANCHORS.quarantineDestroyAction,
    ]) {
      expect(countAnchor(anchor), `${anchor} must be unique`).toBe(1);
    }
    const identity = document.querySelector(guideAnchorSelector(GUIDE_ANCHORS.quarantineRowIdentity));
    expect(identity?.textContent).toContain('Paracetamol');
  });

  it('keeps the SAME record when a reload reorders the list', async () => {
    fixtures.warehouse_quarantine_stock = threeRows();
    render(<Harness tab="quarantine" />);
    await waitFor(() => expect(screen.getByText('Amoxicillin')).toBeInTheDocument());
    expect(
      document.querySelector(guideAnchorSelector(GUIDE_ANCHORS.quarantineRowIdentity))?.textContent,
    ).toContain('Paracetamol');

    // A reload puts a different lot first — an ordinary consequence of an
    // expiry-ordered list being refetched after a disposition.
    const reordered = threeRows();
    fixtures.warehouse_quarantine_stock = [reordered[1], reordered[2], reordered[0]];
    await reloadPanel();

    // The example is still the record it was, even though it is no longer
    // first. Nothing silently moved to another lot.
    expect(
      document.querySelector(guideAnchorSelector(GUIDE_ANCHORS.quarantineRowIdentity))?.textContent,
    ).toContain('Paracetamol');
    expect(countAnchor(GUIDE_ANCHORS.quarantineRowIdentity)).toBe(1);
  });

  it('releases the example — rather than moving it — when the record leaves MID-TOUR', async () => {
    fixtures.warehouse_quarantine_stock = threeRows();
    render(<Harness tab="quarantine" />);
    await waitFor(() => expect(screen.getByText('Amoxicillin')).toBeInTheDocument());

    await openCenter();
    await startTour('الحجر الصحي');
    // Stand on the step that is describing the example row.
    fireEvent.click(screen.getByRole('button', { name: nextLabel() }));
    fireEvent.click(screen.getByRole('button', { name: nextLabel() }));
    await waitFor(() => expect(layer().dataset.guideStep).toBe('quarantine.identity'));
    expect(layer().dataset.guideAnchor).toBe(GUIDE_ANCHORS.quarantineRowIdentity);

    // The lot is disposed of by someone, and the list reloads without it.
    fixtures.warehouse_quarantine_stock = threeRows().slice(1);
    await reloadPanel();
    await waitFor(() => expect(screen.queryByText('Paracetamol')).toBeNull());

    // No row anchors at all — NOT the same anchors re-pointed at Omeprazole
    // while the card still says "this lot".
    expect(countAnchor(GUIDE_ANCHORS.quarantineRowIdentity)).toBe(0);
    expect(countAnchor(GUIDE_ANCHORS.quarantineRowActions)).toBe(0);
    // The region survives, so the reading step still has its target.
    expect(countAnchor(GUIDE_ANCHORS.quarantineList)).toBe(1);
    // ...and the tour continues over the steps that still have a subject.
    await waitFor(() => expect(layer().dataset.guideStep).toBe('quarantine.closing'));
  });

  it('is free to exemplify the list again once the explanation is over', async () => {
    fixtures.warehouse_quarantine_stock = threeRows();
    render(<Harness tab="quarantine" />);
    await waitFor(() => expect(screen.getByText('Amoxicillin')).toBeInTheDocument());

    await openCenter();
    await startTour('الحجر الصحي');
    fixtures.warehouse_quarantine_stock = threeRows().slice(1);
    await reloadPanel();
    await waitFor(() => expect(countAnchor(GUIDE_ANCHORS.quarantineRowIdentity)).toBe(0));

    fireEvent.click(screen.getByRole('button', { name: skipLabel() }));
    await waitFor(() => expect(document.querySelector('[data-guide-tour]')).toBeNull());

    // A new explanation gets a new example; the panel is not left degraded.
    await waitFor(() => expect(countAnchor(GUIDE_ANCHORS.quarantineRowIdentity)).toBe(1));
    expect(
      document.querySelector(guideAnchorSelector(GUIDE_ANCHORS.quarantineRowIdentity))?.textContent,
    ).toContain('Omeprazole');
  });
});

describe('IG-2 · suspension — the panel’s real states decide which steps exist', () => {
  it('walks the whole tour over the real panel, every step on a real anchor', async () => {
    fixtures.material_dispensing_suspensions = [
      suspensionRow({ id: 'm1' }),
      suspensionRow({
        id: 'm2', distribution_point_id: 'outlet-1', reason_code: 'other',
        lifted_by: 'p1', lifted_at: '2026-07-29T11:00:00Z', lift_reason: 'done',
        central_items: { name: 'Omeprazole', name_ar: 'أوميبرازول' },
      }),
    ];
    render(<Harness tab="suspensions" />);
    await openCenter();
    await startTour('موقوفة الصرف');
    const seen = await walk();

    expect(seen.map(s => s.step)).toEqual([
      'suspension.tab', 'suspension.active', 'suspension.scope',
      'suspension.badge', 'suspension.create', 'suspension.lift', 'suspension.history',
    ]);
    for (const { step, anchor } of seen) {
      expect(anchor, `${step} fell back to a centred card`).not.toBe('none');
    }
  });

  it('drops the history step when nothing has ever been lifted', async () => {
    fixtures.material_dispensing_suspensions = [suspensionRow()];
    render(<Harness tab="suspensions" />);
    await openCenter();
    await startTour('موقوفة الصرف');
    const seen = await walk();
    expect(seen.map(s => s.step)).not.toContain('suspension.history');
    expect(countAnchor(GUIDE_ANCHORS.suspensionHistory)).toBe(0);
  });

  it('drops the row steps when every suspension has been LIFTED', async () => {
    fixtures.material_dispensing_suspensions = [
      suspensionRow({ lifted_by: 'p1', lifted_at: '2026-07-29T11:00:00Z', lift_reason: 'done' }),
    ];
    render(<Harness tab="suspensions" />);
    await openCenter();
    await startTour('موقوفة الصرف');
    const seen = await walk();

    // There IS a region and a history; there is NO active row.
    expect(seen.map(s => s.step)).toContain('suspension.active');
    expect(seen.map(s => s.step)).toContain('suspension.history');
    expect(seen.map(s => s.step)).not.toContain('suspension.scope');
    expect(seen.map(s => s.step)).not.toContain('suspension.badge');
    expect(seen.map(s => s.step)).not.toContain('suspension.lift');
  });

  it('keeps the region step on an entirely empty panel', async () => {
    fixtures.material_dispensing_suspensions = [];
    render(<Harness tab="suspensions" />);
    await openCenter();
    await startTour('موقوفة الصرف');
    const seen = await walk();
    expect(anchorsInDocument()).toContain(GUIDE_ANCHORS.suspensionList);
    expect(seen.find(s => s.step === 'suspension.active')?.anchor).toBe(GUIDE_ANCHORS.suspensionList);
    expect(seen.map(s => s.step)).not.toContain('suspension.scope');
  });

  it('keeps the create step on the create region while the composer is open', async () => {
    render(<Harness tab="suspensions" />);
    await waitFor(() => expect(screen.getAllByText('إيقاف عن الصرف')[0]).toBeInTheDocument());
    fireEvent.click(screen.getAllByText('إيقاف عن الصرف')[0]);
    await waitFor(() => expect(screen.getByLabelText('سبب الإيقاف')).toBeInTheDocument());

    expect(countAnchor(GUIDE_ANCHORS.suspensionSuspendAction)).toBe(0);
    expect(countAnchor(GUIDE_ANCHORS.suspensionCreateArea)).toBe(1);

    await openCenter();
    await startTour('موقوفة الصرف');
    const seen = await walk();
    expect(seen.find(s => s.step === 'suspension.create')?.anchor)
      .toBe(GUIDE_ANCHORS.suspensionCreateArea);
  });

  it('keeps the lift step on the row’s action region while the lift form is open', async () => {
    render(<Harness tab="suspensions" />);
    await waitFor(() => expect(screen.getByText('رفع إيقاف الصرف')).toBeInTheDocument());
    fireEvent.click(screen.getByText('رفع إيقاف الصرف'));
    await waitFor(() => expect(screen.getByLabelText('سبب رفع الإيقاف')).toBeInTheDocument());

    expect(countAnchor(GUIDE_ANCHORS.suspensionLiftAction)).toBe(0);
    expect(countAnchor(GUIDE_ANCHORS.suspensionRowActions)).toBe(1);

    await openCenter();
    await startTour('موقوفة الصرف');
    const seen = await walk();
    expect(seen.find(s => s.step === 'suspension.lift')?.anchor)
      .toBe(GUIDE_ANCHORS.suspensionRowActions);
  });

  it('separates “the create entry is reachable” from “allowed on this outlet”', async () => {
    // Reachability alone is published as `create`; the org-wide claim is a
    // DIFFERENT key, and a candidate outlet can never set it.
    const reachableOnly = {
      [GUIDE_CAPABILITIES.suspensionView]: true,
      [GUIDE_CAPABILITIES.suspensionCreate]: true,
    };
    render(<Harness tab="suspensions" caps={reachableOnly} />);
    await openCenter();
    await startTour('موقوفة الصرف');
    const seen = await walk();
    expect(seen.map(s => s.step)).toContain('suspension.create');
    // ...and it is anchored on the create surface, which is all reachability
    // buys. The copy is what has to carry the rest, and it says so.
    expect(seen.find(s => s.step === 'suspension.create')?.anchor)
      .toBe(GUIDE_ANCHORS.suspensionSuspendAction);
    const createStep = GUIDE_REGISTRY.tours
      .find(t => t.id === 'guide.tour.dispensing-suspension')?.steps
      .find(x => x.id === 'suspension.create');
    expect(createStep?.body.ar).toMatch(/فتح النموذج ليس قبولًا/);
    expect(createStep?.body.en.toLowerCase()).toMatch(/opening the form is not acceptance/);
    // The proven org-wide grant is a DIFFERENT key, and reachability never
    // implies it.
    expect(GUIDE_CAPABILITIES.suspensionCreateOrgWide)
      .not.toBe(GUIDE_CAPABILITIES.suspensionCreate);
  });
});

describe('IG-2 · both tours — nothing operational is touched', () => {
  it('the quarantine walk fires no RPC at all, and reads only what the panel already read', async () => {
    render(<Harness tab="quarantine" />);
    await waitFor(() => expect(screen.getByText('Paracetamol')).toBeInTheDocument());
    const readsBefore = [...readTables];
    const rpcBefore = [...rpcCalls];

    await openCenter();
    await startTour('الحجر الصحي');
    await walk();
    fireEvent.click(screen.getByRole('button', { name: 'إنهاء' }));
    await waitFor(() => expect(document.querySelector('[data-guide-tour]')).toBeNull());

    // Two separate claims. No mutation was ever attempted...
    expect(rpcCalls.filter(n => WRITE_RPCS.includes(n))).toEqual([]);
    // ...and the guide added no call of any kind on top of the reads the panel
    // had already made for itself.
    expect(rpcCalls).toEqual(rpcBefore);
    expect(readTables).toEqual(readsBefore);
  });

  it('the suspension walk fires no RPC at all, and adds no read', async () => {
    render(<Harness tab="suspensions" />);
    await waitFor(() => expect(screen.getByText('أموكسيسيلين')).toBeInTheDocument());
    const readsBefore = [...readTables];
    const rpcBefore = [...rpcCalls];

    await openCenter();
    await startTour('موقوفة الصرف');
    await walk();
    fireEvent.click(screen.getByRole('button', { name: 'إنهاء' }));
    await waitFor(() => expect(document.querySelector('[data-guide-tour]')).toBeNull());

    expect(rpcCalls.filter(n => WRITE_RPCS.includes(n))).toEqual([]);
    expect(rpcCalls).toEqual(rpcBefore);
    expect(readTables).toEqual(readsBefore);
  });

  it('never switches the tab or the scope from under the operator', async () => {
    render(<Harness tab="quarantine" />);
    await openCenter();
    await startTour('الحجر الصحي');
    await walk();
    // The suspensions panel was never mounted, so its table was never read.
    expect(readTables).not.toContain('material_dispensing_suspensions');
  });

  it('anchors on wrappers, never on the operational controls themselves', async () => {
    render(<Harness tab="quarantine" />);
    await waitFor(() => expect(screen.getByText('إفراج')).toBeInTheDocument());
    for (const anchor of [
      GUIDE_ANCHORS.quarantineReleaseAction, GUIDE_ANCHORS.quarantineDestroyAction,
      GUIDE_ANCHORS.quarantineRowActions,
    ]) {
      const el = document.querySelector(guideAnchorSelector(anchor)) as HTMLElement;
      expect(el).not.toBeNull();
      expect(el.tagName).not.toBe('BUTTON');
      expect(el.querySelector('button, [role="button"]')?.tagName ?? 'BUTTON').toBe('BUTTON');
    }
  });

  it('makes the panel inert while a step describes it, and restores it after', async () => {
    /**
     * Wrapping a button in an anchored container proves nothing about whether
     * the button can be pressed. What does is the modal treatment: the blocker
     * covers the viewport including the highlighted element, and everything
     * behind the overlay is marked `inert` and `aria-hidden`, so neither
     * pointer, keyboard nor assistive technology reaches it.
     *
     * jsdom does not implement `inert` behaviour, so what is asserted here is
     * the marking and its restoration; that the browser then actually refuses
     * the interaction is asserted in tests/interactive-guide.chromium.test.ts.
     */
    const { container, unmount } = render(<Harness tab="quarantine" />);
    await waitFor(() => expect(screen.getByText('إفراج')).toBeInTheDocument());
    // The overlay is portalled to <body>, so the whole application subtree is
    // its sibling and is what the inert treatment covers.
    const panelHost = container;

    await openCenter();
    await startTour('الحجر الصحي');
    await waitFor(() => expect(document.querySelector('[data-guide-tour]')).not.toBeNull());

    await waitFor(() => expect(panelHost.hasAttribute('inert')).toBe(true));
    expect(panelHost.getAttribute('aria-hidden')).toBe('true');
    // Focus opened on the guide's own primary action, not on the panel.
    expect(layer().contains(document.activeElement)).toBe(true);
    expect(document.querySelector('.guide-blocker')).not.toBeNull();
    // The release button is behind the inert subtree, so it is unreachable by
    // pointer, by Tab, and by assistive technology alike.
    expect(panelHost.contains(screen.getByText('إفراج'))).toBe(true);

    // Leaving the tour returns to the Help Center, which is itself modal — so
    // the marking is correctly still in place — and closing the guide entirely
    // puts every attribute back exactly as it was.
    fireEvent.click(screen.getByRole('button', { name: skipLabel() }));
    await waitFor(() => expect(document.querySelector('[data-guide-tour]')).toBeNull());
    expect(panelHost.hasAttribute('inert')).toBe(true);

    unmount();
    expect(panelHost.hasAttribute('inert')).toBe(false);
    expect(panelHost.hasAttribute('aria-hidden')).toBe(false);
  });
});

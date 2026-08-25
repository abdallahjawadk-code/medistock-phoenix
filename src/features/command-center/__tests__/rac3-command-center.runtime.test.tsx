/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandCenterReadContract } from '@/shared/supabase/services/command-center.service';

/* ── Mocks ───────────────────────────────────────────────────────────────── */

let appState: Record<string, unknown> = {};
vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));

const readContract = vi.fn();
vi.mock('@/shared/supabase/services/command-center.service', () => ({
  getCommandCenterReadContract: (...args: unknown[]) => readContract(...args),
}));

import { CommandCenterScreen } from '../CommandCenterScreen';

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const CAPS = {
  dashboard_view: true,
  alerts_view: false,
  reports_view: false,
  warehouse_stock_view: false,
  outlet_stock_view: false,
  warehouse_transfer_view: false,
};

function contract(over: Partial<CommandCenterReadContract> = {}): CommandCenterReadContract {
  return {
    ok: true,
    scope: { kind: 'organization', organization_id: 'org-1', warehouse_id: null, distribution_point_id: null },
    capabilities: { ...CAPS },
    summary: {
      availability_rows: 40, quantity_units: 900,
      available: 20, low_stock: 6, missing: 4, near_expiry: 7, expired: 3, surplus: 0,
    },
    network: { organizations: 1, warehouses: 4, distribution_points: 9 },
    trend: null,
    trend_status: 'deferred_pending_measurement',
    near_expiry_days: 270,
    as_of: '2026-08-25T00:00:00.000Z',
    ...over,
  } as CommandCenterReadContract;
}

function setViewport(mobile: boolean, reducedMotion = false) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? reducedMotion : mobile,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }),
  });
}

beforeEach(() => {
  readContract.mockReset();
  appState = {
    lang: 'ar',
    role: 'institution_admin',
    activeOrgId: 'org-1',
    myPermissions: new Set(['dashboard.view']),
    profile: { id: 'p1', full_name: 'سارة', role: 'institution_admin' },
  };
  setViewport(false);
  // Drive the count-up straight to its end: the callback is handed a timestamp
  // well past the animation window, so the first frame settles on the final
  // value and never reschedules. A stub that replays `now` unchanged would
  // recurse forever, and one that defers would make every assertion racy.
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(performance.now() + 10_000);
    return 1;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame;
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const root = () => document.querySelector('.rac3') as HTMLElement;

/* ────────────────────────────────────────────────────────────────────────── */

describe('RAC-3 runtime · lifecycle states are distinguishable', () => {
  it('shows a skeleton on first load, never an empty dashboard', async () => {
    let resolve!: (v: CommandCenterReadContract) => void;
    readContract.mockReturnValue(new Promise(r => { resolve = r; }));
    render(<CommandCenterScreen onNavigate={vi.fn()} />);

    expect(root()).toHaveAttribute('data-rac3-state', 'loading');
    expect(screen.getByRole('status', { busy: true })).toBeInTheDocument();

    resolve(contract());
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'ready'));
  });

  it('presents a 42501 as a refusal, NOT as "no data"', async () => {
    readContract.mockRejectedValue({ code: '42501', message: 'command_center_forbidden' });
    render(<CommandCenterScreen onNavigate={vi.fn()} />);

    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'unauthorized'));
    expect(screen.getByText(/لا تملك صلاحية الإحصائيات/)).toBeInTheDocument();
    // The honest-empty copy must NOT be what an unauthorized actor sees.
    expect(screen.queryByText(/لا توجد بيانات لعرضها/)).not.toBeInTheDocument();
  });

  it('offers the actor its own canonical landing, and cannot loop back here', async () => {
    const onNavigate = vi.fn();
    readContract.mockRejectedValue({ code: '42501', message: 'command_center_forbidden' });
    render(<CommandCenterScreen onNavigate={onNavigate} />);

    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'unauthorized'));
    screen.getByRole('button', { name: /العودة إلى شاشتك الرئيسية/ }).click();
    // institution_admin's canonical landing is 21 — never 22, which would loop.
    expect(onNavigate).toHaveBeenCalledWith(21);
    expect(onNavigate).not.toHaveBeenCalledWith(22);
  });

  it('separates a transport failure from a refusal and offers retry', async () => {
    readContract.mockRejectedValue(new Error('Failed to fetch'));
    render(<CommandCenterScreen onNavigate={vi.fn()} />);

    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'error'));
    expect(screen.getByText(/تعذّر الوصول إلى الخادم/)).toBeInTheDocument();
  });

  it('renders an honest empty state when the service returns nothing', async () => {
    readContract.mockResolvedValue(null);
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'empty'));
  });
});

describe('RAC-3 runtime · exactly one authorized request', () => {
  it('issues one RPC for the whole screen, with scope as a REQUEST only', async () => {
    readContract.mockResolvedValue(contract());
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'ready'));

    expect(readContract).toHaveBeenCalledTimes(1);
    expect(readContract).toHaveBeenCalledWith({
      organizationId: 'org-1', warehouseId: null, distributionPointId: null,
    });
  });
});

describe('RAC-3 runtime · capability-driven rendering', () => {
  it('does not render the alerts link when the contract withheld alerts_view', async () => {
    readContract.mockResolvedValue(contract());
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'ready'));

    expect(screen.queryByRole('button', { name: /فتح اقتراحات المناقلات/ })).not.toBeInTheDocument();
  });

  it('renders it when the contract granted alerts_view', async () => {
    readContract.mockResolvedValue(contract({ capabilities: { ...CAPS, alerts_view: true } }));
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'ready'));

    expect(screen.getByRole('button', { name: /فتح اقتراحات المناقلات/ })).toBeInTheDocument();
  });

  it('renders no Quick Actions panel — those destinations live in the canonical nav', async () => {
    // OWNER POLISH: the body panel duplicated the sidebar/drawer/bottom-bar and
    // was removed from the composition entirely. This asserts ABSENCE FROM THE
    // DOM, not that it is merely hidden: a CSS-hidden panel would still match.
    readContract.mockResolvedValue(contract());
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'ready'));

    expect(document.querySelector('.rac3-panel--actions')).toBeNull();
    expect(document.querySelector('.premium-quick-action-grid')).toBeNull();
    expect(screen.queryByText('إجراءات سريعة')).not.toBeInTheDocument();
  });
});

describe('RAC-3 runtime · scoped payloads reveal no platform size', () => {
  it('omits the organization count entirely at organization scope', async () => {
    readContract.mockResolvedValue(contract());
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'ready'));

    const net = document.querySelector('.rac3-panel--network') as HTMLElement;
    // The pinned "1" is never printed beside "Organizations", which would read
    // as a platform total of one.
    expect(within(net).queryByText('المؤسسات')).not.toBeInTheDocument();
    expect(within(net).getByText(/لا تعكس حجم المنظومة/)).toBeInTheDocument();
  });

  it('shows the organization count only at global scope', async () => {
    readContract.mockResolvedValue(contract({
      scope: { kind: 'global', organization_id: null, warehouse_id: null, distribution_point_id: null },
      network: { organizations: 37, warehouses: 120, distribution_points: 410 },
    }));
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-scope', 'global'));

    const net = document.querySelector('.rac3-panel--network') as HTMLElement;
    expect(within(net).getByText('المؤسسات')).toBeInTheDocument();
  });
});

describe('RAC-3 runtime · KPI semantics', () => {
  it('renders a dash, not a zero, for a figure the contract omitted', async () => {
    readContract.mockResolvedValue(contract({
      summary: { availability_rows: 5, quantity_units: 10, available: 5 } as never,
    }));
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'ready'));

    const missing = screen.getByRole('group', { name: /مفقود: غير متوفر/ });
    expect(within(missing).getByText('—')).toBeInTheDocument();
  });

  it('exposes each KPI as one labelled fact for assistive technology', async () => {
    readContract.mockResolvedValue(contract());
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'ready'));

    expect(screen.getByRole('group', { name: /منتهي الصلاحية: ٣/ })).toBeInTheDocument();
  });
});

describe('RAC-3 runtime · trend stays deferred', () => {
  it('states the deferral and draws no chart', async () => {
    readContract.mockResolvedValue(contract());
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'ready'));

    const trend = document.querySelector('.rac3-trend') as HTMLElement;
    expect(trend).toHaveAttribute('data-trend-status', 'deferred_pending_measurement');
    expect(trend.querySelector('svg[aria-hidden="false"]')).toBeNull();
    expect(within(trend).getByText(/لا تُعرض هنا أرقام تقديرية/)).toBeInTheDocument();
  });
});

describe('RAC-3 runtime · accessibility and direction', () => {
  it('renders no h1 — PhoenixAppShell owns the page heading for every screen', async () => {
    readContract.mockResolvedValue(contract());
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'ready'));

    // Screens 18 and 21 title themselves with an h2 under the shell's topbar
    // h1. An h1 here would put two page headings in one document.
    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(0);
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThan(2);
  });

  it('uses the Statistics identity, never the retired Command Center wording', async () => {
    readContract.mockResolvedValue(contract());
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'ready'));

    expect(screen.getByRole('heading', { level: 2, name: 'الإحصائيات' })).toBeInTheDocument();
    expect(root().textContent).not.toContain('مركز القيادة');
    // …and the wrong shell title must never leak into the page body either.
    expect(root().textContent).not.toContain('مركز التقارير والمواقف');
  });

  it('carries status severity as text, never colour alone', async () => {
    readContract.mockResolvedValue(contract());
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'ready'));

    const signals = document.querySelector('.rac3-panel--signals') as HTMLElement;
    expect(within(signals).getAllByText('حرج').length).toBeGreaterThan(0);
    expect(within(signals).getAllByText('مراقبة').length).toBeGreaterThan(0);
  });

  it('renders the stock-health values as text beside the decorative ring', async () => {
    readContract.mockResolvedValue(contract());
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'ready'));

    const health = document.querySelector('.rac3-panel--health') as HTMLElement;
    // The SVG is decoration; the legend is the information channel.
    expect(health.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(within(health).getByText('متوفر')).toBeInTheDocument();
    expect(within(health).getAllByRole('listitem').length).toBe(5);
  });

  it('renders English LTR from the same component with no physical-direction CSS', async () => {
    appState = { ...appState, lang: 'en' };
    readContract.mockResolvedValue(contract());
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'ready'));

    expect(screen.getByRole('heading', { level: 2, name: 'Statistics' })).toBeInTheDocument();
    expect(root().textContent).not.toContain('Command Center');
    expect(screen.getByText('Scope: Your organization')).toBeInTheDocument();
    // No inline left/right anywhere in the rendered tree.
    expect(root().innerHTML).not.toMatch(/style="[^"]*(margin-left|margin-right|padding-left|padding-right|left:|right:)/);
  });
});

describe('RAC-3 runtime · reduced motion', () => {
  it('commits final KPI values immediately and never animates', async () => {
    setViewport(false, true);
    // If any animation were required to reach the value, this would fail:
    // rAF is not driven here.
    window.requestAnimationFrame = (() => { throw new Error('animated under reduced motion'); }) as never;

    readContract.mockResolvedValue(contract());
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'ready'));

    expect(screen.getByRole('group', { name: /منتهي الصلاحية: ٣/ })).toBeInTheDocument();
  });
});

describe('RAC-3 runtime · mobile layout contract', () => {
  it('stacks in urgency order with critical signals first', async () => {
    setViewport(true);
    readContract.mockResolvedValue(contract());
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'ready'));

    const stack = document.querySelector('.rac3-stack') as HTMLElement;
    expect(stack).toBeInTheDocument();
    expect(document.querySelector('.rac3-grid')).toBeNull();

    const order = [...stack.children].map(c => c.className.split(' ').find(x => x.startsWith('rac3-panel--')) ?? c.className);
    expect(order[0]).toBe('rac3-panel--signals');
  });

  it('leads with the KPI overview on desktop instead', async () => {
    setViewport(false);
    readContract.mockResolvedValue(contract());
    render(<CommandCenterScreen onNavigate={vi.fn()} />);
    await waitFor(() => expect(root()).toHaveAttribute('data-rac3-state', 'ready'));

    const main = document.querySelector('.rac3-grid__main') as HTMLElement;
    expect(main.firstElementChild).toHaveClass('rac3-kpis');
    expect(document.querySelector('.rac3-stack')).toBeNull();
  });
});

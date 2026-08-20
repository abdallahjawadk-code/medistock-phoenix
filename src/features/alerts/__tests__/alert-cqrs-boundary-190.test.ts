/**
 * ALERT-CQRS-BOUNDARY-190 (G4.1) — frontend contract.
 *
 * Migration 190 draws a command/query boundary in the database. This suite
 * states, in ONE place, what the frontend half of that boundary must be, so a
 * future edit that quietly reintroduces "reading writes" fails here rather than
 * in production.
 *
 * The named invariant this file exists to hold:
 *
 *     DASHBOARD_ALERT_READ_CAUSES_WRITE = FALSE
 *
 * Source-level assertions, in the established style of this repo's UI suites:
 * the behavioural half (that the RPCs really are pure) is proved by
 * supabase/migrations/__tests__/190-inter-org-alert-cqrs-boundary.dynamic.test.ts
 * against a real database. Neither half is sufficient alone — a pure RPC called
 * from nowhere, or a pure call site pointing at a hybrid RPC, would both leave
 * the defect in place.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const service   = read('features/alerts/inter-org-alert-lifecycle.service.ts');
const alerts    = read('features/alerts/InterInstitutionAlertsScreen.tsx');
const dashboard = read('features/dashboard/DashboardScreen.tsx');

/** The two RPCs that upsert lifecycle state as a side effect of being read. */
const HYBRID_READ_RPCS = [
  'phoenix_get_live_inter_institution_alerts_with_state',
  'phoenix_get_live_inter_institution_alerts_with_state_page',
] as const;

/** Their retired client wrappers. */
const HYBRID_WRAPPERS = [
  'getLiveInterInstitutionAlertsWithState',
  'getLiveInterInstitutionAlertsPage',
] as const;

// ============================================================================
// §9 — ZERO first-party consumers of the hybrid read RPCs.
// ============================================================================
describe('G4.1 · the write-capable read RPCs have no frontend consumer left', () => {
  it.each(HYBRID_READ_RPCS)('%s is called from nowhere in the alert surface', (rpc) => {
    for (const [name, src] of [['service', service], ['alerts screen', alerts], ['dashboard', dashboard]] as const) {
      expect(src, `${rpc} in ${name}`).not.toContain(`supabase.rpc('${rpc}'`);
    }
  });

  it.each(HYBRID_WRAPPERS)('the retired client wrapper %s no longer exists', (fn) => {
    expect(service).not.toContain(`export async function ${fn}(`);
    expect(alerts).not.toContain(fn);
    expect(dashboard).not.toContain(fn);
  });

  it('the assertion above is non-vacuous — the service really does call RPCs', () => {
    expect(service.match(/supabase\.rpc\('/g)?.length).toBeGreaterThanOrEqual(6);
  });
});

// ============================================================================
// The command / query split in the service.
// ============================================================================
describe('G4.1 · the service is split along the command/query boundary', () => {
  it('exposes exactly one lifecycle-refresh COMMAND, pointed at 190\'s RPC', () => {
    expect(service).toContain('export async function refreshInterOrgAlertLifecycle(');
    expect(service).toContain("supabase.rpc('phoenix_refresh_inter_org_alert_lifecycle'");
  });

  it('exposes the two PURE queries, pointed at 190\'s query RPCs', () => {
    expect(service).toContain('export async function queryLiveInterOrgAlertsPage(');
    expect(service).toContain("supabase.rpc('phoenix_query_live_inter_org_alerts_with_state_page'");
    expect(service).toContain('export async function queryLiveInterOrgAlertSummary(');
    expect(service).toContain("supabase.rpc('phoenix_query_live_inter_org_alert_summary'");
  });

  it('leaves the existing lifecycle commands and the event-history query alone', () => {
    expect(service).toContain('export async function updateInterOrgAlertState(');
    expect(service).toContain("supabase.rpc('phoenix_update_inter_org_alert_state'");
    expect(service).toContain('export async function reopenInterOrgAlert(');
    expect(service).toContain("supabase.rpc('phoenix_reopen_inter_org_alert'");
    expect(service).toContain('export async function getInterOrgAlertEvents(');
    expect(service).toContain("supabase.rpc('phoenix_get_inter_org_alert_events'");
  });

  it('the refresh COMMAND returns no alert rows — callers cannot read through it', () => {
    const at = service.indexOf('export async function refreshInterOrgAlertLifecycle(');
    expect(at).toBeGreaterThan(-1);
    // Slice to the function's own closing brace, not to the next export: the
    // next declaration is an interface, and swallowing it would make this
    // assertion read a doc comment instead of the command body.
    const body = service.slice(at, service.indexOf('\n}\n', at) + 3);
    expect(body).toContain('refreshedCount');
    expect(body).not.toContain('mapRow');
    expect(body).not.toContain('alerts');
  });

  it('reads still go through supabase.rpc only — no direct table access appeared', () => {
    for (const table of ['inter_org_alert_states', 'inter_org_alert_events', 'item_availability']) {
      expect(service, table).not.toContain(`from('${table}')`);
    }
  });
});

// ============================================================================
// §7 — the alert screen: COMMAND once, then QUERY; paging is query-only.
// ============================================================================
describe('G4.1 · the alert screen loads COMMAND-then-QUERY', () => {
  it('issues the refresh COMMAND before the first query', () => {
    const commandAt = alerts.indexOf('await refreshInterOrgAlertLifecycle()');
    const queryAt = alerts.indexOf('return queryLiveInterOrgAlertsPage(');
    expect(commandAt).toBeGreaterThan(-1);
    expect(queryAt).toBeGreaterThan(commandAt);
  });

  it('guards the COMMAND behind a ref so a page change cannot re-issue it', () => {
    expect(alerts).toContain('const lifecycleRefreshed = useRef(false);');
    expect(alerts).toContain('if (!lifecycleRefreshed.current) {');
    expect(alerts).toContain('lifecycleRefreshed.current = true;');
  });

  it('the ref is set only AFTER the command succeeds, so a failed refresh is retried', () => {
    const at = alerts.indexOf('if (!lifecycleRefreshed.current) {');
    const block = alerts.slice(at, alerts.indexOf('return queryLiveInterOrgAlertsPage(', at));
    const failAt = block.indexOf('if (!command.ok)');
    const setAt = block.indexOf('lifecycleRefreshed.current = true;');
    expect(failAt).toBeGreaterThan(-1);
    expect(setAt).toBeGreaterThan(failAt);
  });

  it('the loader is keyed on the page alone — the command is not a page dependency', () => {
    expect(alerts).toMatch(/return queryLiveInterOrgAlertsPage\(PAGE_SIZE, page \* PAGE_SIZE\);\s*\n\s*\}, \[page\]\);/);
  });

  it('pagination controls change only the page — they issue no command', () => {
    expect(alerts).toContain('setPage(p => Math.max(0, p - 1))');
    expect(alerts).toContain('setPage(p => Math.min(pageCount - 1, p + 1))');
    for (const control of ['lia_page_prev', 'lia_page_next']) {
      const at = alerts.indexOf(control);
      const around = alerts.slice(Math.max(0, at - 300), at);
      expect(around, control).not.toContain('refreshInterOrgAlertLifecycle');
    }
  });

  it('lifecycle transitions and event history are untouched by the split', () => {
    for (const marker of [
      "onAction('acknowledged')", "onAction('in_progress')", "onAction('resolved')",
      "onAction('dismissed')", "onAction('open')",
    ]) {
      expect(alerts).toContain(marker);
    }
    expect(alerts).toContain('getInterOrgAlertEvents');
    expect(alerts).toContain('updateInterOrgAlertState');
    expect(alerts).toContain('reopenInterOrgAlert');
  });

  it('filtering, grouping and sorting remain presentation-only over the fetched page', () => {
    // Each is a pure transform of `allAlerts`/`filtered` — none re-fetches.
    for (const marker of ['const filtered = useMemo', 'sortAlerts(filtered, sortMode)', 'const criticalAlerts = useMemo']) {
      expect(alerts).toContain(marker);
    }
    expect(alerts).not.toMatch(/set(Severity|Type|Inst)Filter[\s\S]{0,200}queryLiveInterOrgAlertsPage/);
  });
});

// ============================================================================
// §8 — the hard invariant.
// ============================================================================
describe('G4.1 · DASHBOARD_ALERT_READ_CAUSES_WRITE = FALSE', () => {
  it('the Dashboard reads the PURE summary query and nothing else', () => {
    expect(dashboard).toContain("from '@/features/alerts/inter-org-alert-lifecycle.service'");
    expect(dashboard).toMatch(/useAsync\(\(\) => queryLiveInterOrgAlertSummary\(200\), \[\]\)/);
  });

  it('the Dashboard never issues the refresh COMMAND', () => {
    // Refreshing lifecycle state is the Internal Alerts screen's job alone.
    // A Dashboard that refreshed would put the writes straight back.
    expect(dashboard).not.toContain('refreshInterOrgAlertLifecycle');
    expect(dashboard).not.toContain('phoenix_refresh_inter_org_alert_lifecycle');
  });

  it('the Dashboard imports NO write-capable alert call of any kind', () => {
    for (const forbidden of [
      ...HYBRID_READ_RPCS, ...HYBRID_WRAPPERS,
      'updateInterOrgAlertState', 'reopenInterOrgAlert',
    ]) {
      expect(dashboard, forbidden).not.toContain(forbidden);
    }
  });

  it('the Dashboard no longer ships 200 alert objects to reduce in the browser', () => {
    expect(dashboard).not.toContain('lifecycleStatus');
    expect(dashboard).not.toMatch(/liveResult\?\.alerts/);
    expect(dashboard).not.toContain('liveList');
  });

  it('the four rendered counters come straight off the server payload', () => {
    for (const field of ['total', 'high', 'surplusToShortage', 'nearExpiryToShortage']) {
      expect(dashboard, field).toContain(`liveResult?.${field}`);
    }
    // Same widget, same labels — the numbers changed origin, not meaning.
    for (const label of ['lia_summary_total', 'lia_summary_high', 'lia_summary_surplus', 'lia_summary_near_expiry']) {
      expect(dashboard, label).toContain(label);
    }
  });

  it('the widget keeps its FORBIDDEN / loading / error handling', () => {
    expect(dashboard).toContain("const liveForbidden = liveRpcError === 'FORBIDDEN'");
    expect(dashboard).toContain('liveAlerts.loading');
    expect(dashboard).toContain('liveAlerts.error');
    expect(dashboard).toContain('onRetry={liveAlerts.reload}');
  });
});

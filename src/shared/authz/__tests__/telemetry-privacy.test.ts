/**
 * RBAC-PHASE-2 — Phase D: telemetry privacy, bounding, dedup and lifetime.
 *
 * This store holds authorization decisions from a health system. The tests
 * below are the reason it is safe to look at: they pin that it cannot carry an
 * identity, cannot grow without bound, cannot outlive its subject, and cannot
 * report a network failure as an RBAC finding.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  createRbacTelemetryStore, telemetryEnabled, telemetryReporter,
  type RbacTelemetryEvent,
} from '../telemetry';
import { createAuthorizationService, type AuthzContext } from '../authorization';
import { createFakeDb, createFakeTransport } from './fake-062-database';
import type { ShadowMismatchRecord } from '../diagnostics';

const ORG = '11111111-1111-1111-1111-111111111111';
const WH  = 'aaaaaaaa-0000-0000-0000-000000000001';

const record = (over: Partial<ShadowMismatchRecord> = {}): Omit<ShadowMismatchRecord, 'suppressedCount'> => ({
  outcome: 'disagreement',
  profileRef: 'abcd1234',
  role: 'warehouse_officer',
  permissionKey: 'warehouse_stock.view',
  organizationId: ORG,
  warehouseId: WH,
  distributionPointId: null,
  legacyDecision: true,
  scopedDecision: false,
  reasonCode: 'ASSIGNMENT_MISSING',
  mode: 'shadow',
  ...over,
});

const store = (over: Partial<Parameters<typeof createRbacTelemetryStore>[0]> = {}) =>
  createRbacTelemetryStore({ mode: 'shadow', dev: true, now: () => 1_000_000, ...over });

describe('D1. enablement', () => {
  it('collects wherever the engine runs', () => {
    expect(telemetryEnabled('shadow', false)).toBe(true);
    expect(telemetryEnabled('enforce_super_admin', false)).toBe(true);
    expect(telemetryEnabled('off', true)).toBe(true); // dev always observes
  });

  it('is disabled in production when mode=off', () => {
    expect(telemetryEnabled('off', false)).toBe(false);

    const s = store({ mode: 'off', dev: false });
    expect(s.enabled).toBe(false);
    s.record(record());
    expect(s.events()).toEqual([]);
  });

  it('a disabled store says so rather than looking empty', () => {
    const s = store({ mode: 'off', dev: false });
    const parsed = JSON.parse(s.exportJson());
    // "No events" and "not collecting" must not read identically to a reviewer.
    expect(parsed.error).toBe('TELEMETRY_DISABLED');
    expect(parsed.events).toBeUndefined();
  });
});

describe('D2. privacy', () => {
  it('carries no identity, token, URL or clinical field', () => {
    const s = store();
    s.record(record());
    const [e] = s.events();

    const forbidden = [
      'email', 'name', 'fullName', 'username', 'phone', 'token', 'accessToken',
      'password', 'session', 'url', 'endpoint', 'profileId', 'userId',
      'batch', 'material', 'quantity', 'patient', 'document',
    ];
    for (const f of forbidden) {
      expect(`${f}: ${f in (e as unknown as Record<string, unknown>)}`).toBe(`${f}: false`);
    }
  });

  it('holds exactly the agreed field set — nothing can be added by accident', () => {
    const s = store();
    s.record(record());
    expect(Object.keys(s.events()[0]).sort()).toEqual([
      'count', 'firstSeen', 'lastSeen', 'legacyDecision', 'mode',
      'organizationRef', 'outcome', 'permissionKey', 'profileRef',
      'reasonCode', 'resourceRef', 'role', 'scopeType', 'scopedDecision',
    ]);
  });

  it('stores only a truncated profile reference', () => {
    const s = store();
    const fullId = '9f8e7d6c-1111-2222-3333-444444444444';
    s.record(record({ profileRef: fullId.slice(0, 8) }));

    const json = s.exportJson();
    expect(json).not.toContain(fullId);
    expect(s.events()[0].profileRef).toBe('9f8e7d6c');
    expect(s.events()[0].profileRef.length).toBe(8);
  });

  it('the exported JSON contains no full profile identifier anywhere', () => {
    const s = store();
    s.record(record({ profileRef: 'abcd1234' }));
    // A UUID-shaped string in the export may only ever be an org/resource ref.
    const uuids = [...s.exportJson().matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)]
      .map(m => m[0]);
    expect(new Set(uuids)).toEqual(new Set([ORG, WH]));
  });

  it('the module introduces no network transport or third-party vendor', () => {
    const src = readFileSync(join(__dirname, '../telemetry.ts'), 'utf8');
    for (const banned of ['fetch(', 'XMLHttpRequest', 'navigator.sendBeacon', 'WebSocket', 'axios', 'import(']) {
      expect(`${banned}: ${src.includes(banned)}`).toBe(`${banned}: false`);
    }
    // Session-scoped only: nothing survives the tab.
    expect(src).not.toContain('localStorage');
    expect(src).not.toContain('sessionStorage');
    expect(src).not.toContain('SERVICE_ROLE');
  });
});

describe('D3. deduplication and rate limiting', () => {
  it('collapses identical events and counts occurrences', () => {
    let t = 0;
    const s = store({ now: () => t, minIntervalMs: 1000 });

    s.record(record());
    // 50 re-renders spanning 500ms — inside the 1000ms window throughout.
    for (let i = 0; i < 50; i++) { t += 10; s.record(record()); }

    const events = s.events();
    expect(events).toHaveLength(1);
    // A list re-rendering on every keystroke is one reachable mismatch, not 50
    // occurrences: `count` must measure reach, not render churn.
    expect(events[0].count).toBe(1);
  });

  it('counts a genuinely repeated occurrence once the interval passes', () => {
    let t = 0;
    const s = store({ now: () => t, minIntervalMs: 1000 });

    s.record(record());
    t = 1500; s.record(record());
    t = 3000; s.record(record());

    const [e] = s.events();
    expect(e.count).toBe(3);
    expect(e.firstSeen).toBe(new Date(0).toISOString());
    expect(e.lastSeen).toBe(new Date(3000).toISOString());
  });

  it('does not collapse different resources, roles or keys', () => {
    const s = store();
    s.record(record({ warehouseId: WH }));
    s.record(record({ warehouseId: 'aaaaaaaa-0000-0000-0000-000000000002' }));
    s.record(record({ role: 'viewer' }));
    s.record(record({ permissionKey: 'audit.view' }));
    expect(s.events()).toHaveLength(4);
  });

  it('never collapses an unknown into a disagreement', () => {
    const s = store();
    s.record(record({ outcome: 'disagreement' }));
    s.record(record({ outcome: 'unknown', scopedDecision: null, reasonCode: 'TEMPORARY_FAILURE' }));
    expect(s.events()).toHaveLength(2);
  });

  it('orders by frequency — the biggest divergence reads first', () => {
    let t = 0;
    const s = store({ now: () => t, minIntervalMs: 0 });
    s.record(record({ permissionKey: 'audit.view' }));
    for (let i = 0; i < 5; i++) { t += 10; s.record(record({ permissionKey: 'reports.view' })); }
    expect(s.events()[0].permissionKey).toBe('reports.view');
  });
});

describe('D4. bounded storage', () => {
  it('refuses new distinct events past the cap and reports the drop', () => {
    const s = store({ maxEvents: 5 });
    for (let i = 0; i < 20; i++) s.record(record({ permissionKey: `key.${i}` }));

    const snap = s.snapshot();
    expect(snap.eventCount).toBe(5);
    expect(snap.droppedEventCount).toBe(15);
    // Refusing rather than evicting keeps the session's FIRST mismatch, which
    // is usually the most informative one.
    expect(s.events().map(e => e.permissionKey)).toContain('key.0');
  });

  it('an unbounded occurrence count cannot grow memory', () => {
    let t = 0;
    const s = store({ now: () => t, minIntervalMs: 0, maxEvents: 5 });
    for (let i = 0; i < 10_000; i++) { t += 1; s.record(record()); }
    expect(s.events()).toHaveLength(1);
    expect(s.events()[0].count).toBe(10_000);
  });
});

describe('D5. session lifetime', () => {
  it('clear() empties the store and its counters', () => {
    const s = store({ maxEvents: 1 });
    s.record(record());
    s.record(record({ permissionKey: 'audit.view' })); // dropped
    expect(s.snapshot().droppedEventCount).toBe(1);

    s.clear();
    const snap = s.snapshot();
    expect(snap.eventCount).toBe(0);
    expect(snap.occurrenceCount).toBe(0);
    expect(snap.droppedEventCount).toBe(0);
  });

  it('is cleared on logout and profile switch by AppContext', () => {
    const ctx = readFileSync(join(__dirname, '../../../app/AppContext.tsx'), 'utf8');
    expect(ctx).toContain('rbacTelemetry.clear();');
    expect(ctx).toMatch(/\}, \[rbacTelemetry, profile\?\.id\]\);/);
  });

  it('the reporter adapter does not clear on invalidate()', () => {
    // invalidate() also fires on a permission refresh and on the pilot's Retry
    // button. Wiping the session's evidence on Retry would look exactly like
    // "no mismatches found".
    const s = store();
    const reporter = telemetryReporter(s);
    reporter.report(record());
    reporter.reset();
    expect(s.events()).toHaveLength(1);
  });
});

describe('D6. unknown is never an authorization disagreement', () => {
  it('an RPC failure is recorded as unknown, not as a mismatch', async () => {
    const fake = createFakeDb({
      profiles: [{ id: 'p1', role: 'warehouse_officer', status: 'active', organization_id: ORG }],
      warehouses: [{ id: WH, organization_id: ORG, status: 'active' }],
      roleDefaults: { warehouse_officer: { 'warehouse_stock.view': true } },
    });
    const s = store();
    const ctx: AuthzContext = {
      authenticated: true, profileId: 'p1', role: 'warehouse_officer',
      organizationId: ORG, legacyPermissions: new Set(['warehouse_stock.view']),
    };
    const svc = createAuthorizationService({
      mode: 'shadow',
      transport: createFakeTransport(fake, { failWith: 'NETWORK_ERROR' }),
      reporter: telemetryReporter(s),
    });
    svc.setContext(ctx);

    const d = await svc.canForWarehouse('warehouse_stock.view', ORG, WH);
    expect(d.mismatch).toBe(false);

    const snap = s.snapshot();
    expect(snap.disagreementCount).toBe(0);
    expect(snap.unknownCount).toBe(1);
    expect(snap.events[0].outcome).toBe('unknown');
    expect(snap.events[0].scopedDecision).toBeNull();
    expect(snap.events[0].reasonCode).toBe('TEMPORARY_FAILURE');
  });

  it('a real scoped denial IS recorded as a disagreement', async () => {
    const fake = createFakeDb({
      profiles: [{ id: 'p1', role: 'warehouse_officer', status: 'active', organization_id: ORG }],
      warehouses: [{ id: WH, organization_id: ORG, status: 'active' }],
      assignments: [],
      roleDefaults: { warehouse_officer: { 'warehouse_stock.view': true } },
    });
    const s = store();
    const svc = createAuthorizationService({
      mode: 'shadow', transport: createFakeTransport(fake), reporter: telemetryReporter(s),
    });
    svc.setContext({
      authenticated: true, profileId: 'p1', role: 'warehouse_officer',
      organizationId: ORG, legacyPermissions: new Set(['warehouse_stock.view']),
    });

    await svc.canForWarehouse('warehouse_stock.view', ORG, WH);

    const snap = s.snapshot();
    expect(snap.disagreementCount).toBe(1);
    expect(snap.unknownCount).toBe(0);
    expect(snap.events[0]).toMatchObject({
      outcome: 'disagreement', legacyDecision: true, scopedDecision: false,
      scopeType: 'warehouse', organizationRef: ORG, resourceRef: WH,
    });
  });

  it('an anonymous context produces no telemetry at all', async () => {
    const fake = createFakeDb({ roleDefaults: {} });
    const s = store();
    const svc = createAuthorizationService({
      mode: 'shadow', transport: createFakeTransport(fake), reporter: telemetryReporter(s),
    });
    svc.setContext({
      authenticated: false, profileId: null, role: null,
      organizationId: null, legacyPermissions: new Set(),
    });

    await svc.canForOrganization('reports.view', ORG);
    // Unknowns from a missing session say nothing about migration 062.
    expect(s.events()).toEqual([]);
  });
});

describe('D7. scope typing', () => {
  it('classifies the three scope types from the record', () => {
    const s = store();
    s.record(record({ warehouseId: null, distributionPointId: null }));
    s.record(record({ warehouseId: WH }));
    s.record(record({ warehouseId: null, distributionPointId: 'cccccccc-0000-0000-0000-000000000001' }));

    const byType = Object.fromEntries(s.events().map((e: RbacTelemetryEvent) => [e.scopeType, e.resourceRef]));
    expect(byType.organization).toBeNull();
    expect(byType.warehouse).toBe(WH);
    expect(byType.distribution_point).toBe('cccccccc-0000-0000-0000-000000000001');
  });
});

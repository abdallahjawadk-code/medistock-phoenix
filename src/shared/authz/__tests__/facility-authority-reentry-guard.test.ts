/**
 * FACILITY-AUTHORITY-REENTRY-GUARD — H Unit 3 (TEST-ONLY).
 *
 * `r1-3-supply-reachability.test.ts` pins WHICH screens a facility-scoped (L2)
 * role may open. This suite pins WHAT those screens can reach. Both are needed:
 * an authority call added inside a screen that is already on the allow-list —
 * directly, via a new nested helper, via a hook, or by moving an existing
 * writer into a reachable module — passes every other test in this repository.
 *
 * The baseline below is an EXACT set of reachability tuples, each keyed by
 *   screen + entry component + callsite file + callsite symbol + sink
 * and never by RPC name alone. A writer that moves file, is reached through a
 * new symbol, or becomes reachable from an additional safe screen produces a
 * different key and must be re-reviewed — in either direction, so the baseline
 * cannot drift silently.
 *
 * This suite changes no runtime behaviour and no security semantics. It reads
 * committed source with the TypeScript compiler API; the negative controls run
 * entirely against in-memory overlays and never touch disk.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeFacilityAuthorityReach, tupleKey, renderTuple, repoRel, REPO_ROOT,
  PRESENTATION_ONLY_RPCS, DIRECT_WRITE_OPS,
  type AuthorityTuple,
} from './facility-authority-reentry-guard.helper';

vi.setConfig({ testTimeout: 300000, hookTimeout: 300000 });

const ENTRY = {
  3: 'src/features/inventory/InventoryCenterScreen.tsx::InventoryCenterScreen',
  6: 'src/features/qr/QrScreen.tsx::QrScreen',
  15: 'src/features/account/MyAccountScreen.tsx::MyAccountScreen',
  18: 'src/features/outlet/OutletOperationsScreen.tsx::OutletOperationsScreen',
} as const;

interface ReviewedTuple extends AuthorityTuple { rationale: string }
const t = (
  screen: keyof typeof ENTRY, callsiteFile: string, callsiteSymbol: string,
  sink: string, rationale: string,
): ReviewedTuple => ({
  screen, entryComponent: ENTRY[screen], callsiteFile, callsiteSymbol,
  sinkType: 'rpc', sink, rationale,
});

const SVC = 'src/shared/supabase/services';
const OUTLET = 'src/features/outlet';
const MOVEMENT = 'src/features/movement';
const INV = 'src/features/inventory';

/**
 * THE REVIEWED AUTHORITY BASELINE.
 *
 * Every reachable `.rpc()` is authority-shaped BY DEFAULT — there is no naming
 * heuristic anywhere in this guard. Several entries below are read models; they
 * stay in this list rather than in PRESENTATION_ONLY_RPCS because moving an RPC
 * to the presentation catalogue is an explicit review decision, not something a
 * regex should infer.
 */
const REVIEWED: readonly ReviewedTuple[] = [
  // ── screen 3 · Inventory Center ────────────────────────────────────────────
  t(3, `${INV}/SourceBalancesPanel.tsx`, 'readSourceBalances', 'phoenix_warehouse_source_balances',
    'Read model (088, RETURNS TABLE) — source balances for display.'),
  t(3, `${MOVEMENT}/paper-reference.service.ts`, 'setPaperReference', 'phoenix_set_paper_reference',
    'Legitimate L2 operational action: records the paper reference for a document the operator already owns; 110 gates it server-side.'),
  t(3, `${OUTLET}/outlet-stock.service.ts`, 'approveOutletStockCorrection', 'phoenix_approve_outlet_stock_correction',
    'Legitimate L2 operational action. Separation of duties is enforced SERVER-SIDE: 098 refuses approval when v_req.proposed_by = v_actor, so holding both request and approve paths is not a SoD hole.'),
  t(3, `${OUTLET}/outlet-stock.service.ts`, 'rejectOutletStockCorrection', 'phoenix_reject_outlet_stock_correction',
    'Legitimate L2 operational action; same 098 second-person contract as approve.'),
  t(3, `${SVC}/delegated-access.service.ts`, 'getMyOperationalResourceCatalog', 'phoenix_my_operational_resource_catalog',
    'Read model of the caller’s OWN operational resources. Note this is the read symbol imported from a module that also exports delegated-scope writers — those writers are NOT reachable, which is the mixed-module control below.'),
  t(3, `${SVC}/scope-topology.service.ts`, 'getOrganizationScopeTopology', 'phoenix_query_organization_scope_topology',
    'Read model (191 canonical scope topology read contract).'),

  // ── screen 6 · QR ──────────────────────────────────────────────────────────
  t(6, `${SVC}/delegated-access.service.ts`, 'getMyOperationalResourceCatalog', 'phoenix_my_operational_resource_catalog',
    'Same own-resource read model, reached from the QR screen.'),
  t(6, `${SVC}/qr.service.ts`, 'disableQrToken', 'disable_qr_token',
    'Legitimate L2 operational action: revokes a QR token for a target the operator owns; server re-checks ownership.'),

  // ── screen 15 · My Account ─────────────────────────────────────────────────
  t(15, `${SVC}/auth.service.ts`, 'markPasswordChanged', 'phoenix_mark_password_changed',
    'Self-scoped: marks the caller’s own password-changed flag.'),
  t(15, `${SVC}/auth.service.ts`, 'setMyOrgWhatsappContact', 'phoenix_set_my_org_whatsapp_contact',
    'ORG-scoped writer that is statically reachable from a facility-safe screen but SERVER-SIDE DENIED to health_center_manager: migration 046 admits only institution_admin / hospital_admin / monthly_status_officer. Retained as a reviewed tuple precisely so that any change to its reachability is re-examined.'),
  t(15, `${SVC}/auth.service.ts`, 'updateMyWhatsappPhone', 'phoenix_update_my_whatsapp_phone',
    'Self-scoped: updates the caller’s own WhatsApp number (045).'),

  // ── screen 18 · Outlet Operations ──────────────────────────────────────────
  t(18, `${INV}/inventory-intelligence.service.ts`, 'createTransferDraftFromSuggestion', 'phoenix_create_transfer_draft_from_suggestion',
    'Legitimate L2 operational action: drafts a transfer from a suggestion; 148 gates the corridor server-side.'),
  t(18, `${INV}/inventory-intelligence.service.ts`, 'getInventoryTransferSuggestions', 'phoenix_get_inventory_suggestion_actions',
    'Read model (152 suggestion action read model).'),
  t(18, `${MOVEMENT}/movement-search.service.ts`, 'searchMovementDocuments', 'phoenix_search_paper_reference',
    'Read model (110/182, RETURNS TABLE) — paper-reference lookup.'),
  t(18, `${MOVEMENT}/paper-reference.service.ts`, 'setPaperReference', 'phoenix_set_paper_reference',
    'Same paper-reference writer, reached from the outlet surface.'),
  t(18, `${OUTLET}/dispense-context.service.ts`, 'dispenseWithContext', 'phoenix_dispense_outlet_stock_with_context',
    'Legitimate L2 operational action: the outlet dispensing corridor (136), scoped to assigned outlets by 062.'),
  t(18, `${OUTLET}/dispense-context.service.ts`, 'getDispenseContext', 'phoenix_get_movement_dispense_context',
    'Read model (134, RETURNS jsonb) — masked dispense context.'),
  t(18, `${OUTLET}/dispense-context.service.ts`, 'recordDispenseContext', 'phoenix_record_movement_dispense_context',
    'Legitimate L2 operational action: records dispense context for a movement the operator performed (134).'),
  t(18, `${OUTLET}/outlet-stock.service.ts`, 'correctOutletStock', 'phoenix_request_outlet_stock_correction',
    'Legitimate L2 operational action: REQUESTS a correction. Approval is a separate 098-gated second person.'),
  t(18, `${SVC}/delegated-access.service.ts`, 'getMyOperationalResourceCatalog', 'phoenix_my_operational_resource_catalog',
    'Same own-resource read model, reached from the outlet surface.'),
  t(18, `${SVC}/scope-topology.service.ts`, 'getOrganizationScopeTopology', 'phoenix_query_organization_scope_topology',
    'Same canonical topology read model, reached from the outlet surface.'),
];

const REVIEWED_KEYS = new Set(REVIEWED.map(tupleKey));
const base = analyzeFacilityAuthorityReach();

describe('U3 · entrypoints are derived, never hard-coded', () => {
  it('derives the safe screens from the canonical FACILITY_SAFE_SCREENS declaration', () => {
    expect(base.screens).toEqual([3, 6, 15, 18]);
  });

  it('resolves every safe screen to exactly one production entry component', () => {
    for (const s of base.screens) {
      expect(base.entrypoints.get(s), `screen ${s}`).toBe(ENTRY[s as keyof typeof ENTRY]);
    }
    expect(base.entrypoints.size).toBe(base.screens.length);
  });

  it('fails closed when a safe screen has no resolvable entry component', () => {
    // Adding an id to FACILITY_SAFE_SCREENS must widen this guard's roots, not
    // silently escape it.
    const src = readFileSync(join(REPO_ROOT, 'src/shared/authz/screen-access.ts'), 'utf8');
    const widened = src.replace(
      /FACILITY_SAFE_SCREENS: readonly number\[\] = \[3, 6, 15, 18\]/,
      'FACILITY_SAFE_SCREENS: readonly number[] = [3, 6, 15, 18, 999]',
    );
    expect(widened).not.toBe(src);
    expect(() => analyzeFacilityAuthorityReach({
      overlay: { 'src/shared/authz/screen-access.ts': widened },
    })).toThrow(/screen 999 has no resolvable production entry component/);
  });

  it('traverses production source only', () => {
    for (const f of base.reachableFiles) {
      expect(f.startsWith('src/'), f).toBe(true);
      expect(f.includes('__tests__'), f).toBe(false);
      expect(/\.(test|spec)\.tsx?$/.test(f), f).toBe(false);
    }
  });
});

describe('U3 · exact authority baseline', () => {
  it('no UNREVIEWED authority is reachable from a facility-safe screen', () => {
    const extra = base.authority.filter((x) => !REVIEWED_KEYS.has(tupleKey(x)));
    if (extra.length) {
      throw new Error(
        `UNREVIEWED_AUTHORITY_REENTRY — ${extra.length} tuple(s) reachable from a facility-safe screen ` +
        `are not in the reviewed baseline:\n\n` +
        extra.map((x) => renderTuple(x, 'UNREVIEWED_AUTHORITY_REENTRY')).join('\n\n'),
      );
    }
    expect(extra).toEqual([]);
  });

  it('every reviewed authority tuple is still reachable — no silent baseline drift', () => {
    const found = new Set(base.authority.map(tupleKey));
    const missing = REVIEWED.filter((x) => !found.has(tupleKey(x)));
    if (missing.length) {
      throw new Error(
        `EXPECTED_AUTHORITY_TUPLE_MISSING — ${missing.length} reviewed tuple(s) no longer reachable. ` +
        `If a path was legitimately removed, delete it from the baseline in the same change:\n\n` +
        missing.map((x) => renderTuple(x, 'EXPECTED_AUTHORITY_TUPLE_MISSING')).join('\n\n'),
      );
    }
    expect(missing).toEqual([]);
  });

  it('the baseline is exactly the measured set, and is non-empty', () => {
    expect(base.authority.length).toBe(REVIEWED.length);
    expect(REVIEWED.length).toBeGreaterThan(0);
    expect(new Set(REVIEWED.map(tupleKey)).size).toBe(REVIEWED.length); // no duplicates
  });

  it('every reviewed tuple carries a rationale', () => {
    for (const r of REVIEWED) expect(r.rationale.length, tupleKey(r)).toBeGreaterThan(30);
  });

  it('NO direct PostgREST relation write is reachable from any facility-safe screen', () => {
    const writes = base.authority.filter((x) => x.sinkType === 'table-write');
    if (writes.length) {
      throw new Error('UNREVIEWED_AUTHORITY_REENTRY (direct relation write):\n\n' +
        writes.map((x) => renderTuple(x, 'UNREVIEWED_AUTHORITY_REENTRY')).join('\n\n'));
    }
    expect(writes).toEqual([]);
  });
});

describe('U3 · presentation-only exceptions are exact, never heuristic', () => {
  it('exposes exactly the three reviewed read-only RPCs', () => {
    expect([...PRESENTATION_ONLY_RPCS.keys()].sort()).toEqual([
      'phoenix_inventory_fefo_batches',
      'phoenix_movement_timeline',
      'phoenix_outlet_replenishment_reversible_batches',
    ]);
    for (const [, why] of PRESENTATION_ONLY_RPCS) expect(why.length).toBeGreaterThan(30);
  });

  it('every classified presentation hit is one of those exact names', () => {
    for (const p of base.presentation) expect(PRESENTATION_ONLY_RPCS.has(p.sink), p.sink).toBe(true);
    expect(base.presentation.length).toBeGreaterThan(0);
  });

  it('the helper contains no name-shaped read-only heuristic', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/shared/authz/__tests__/facility-authority-reentry-guard.helper.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(src).not.toMatch(/\^\(\?:\)?\s*get\|/);
    expect(src).not.toMatch(/READ_HINT|readHint/);
    expect(src).not.toMatch(/startsWith\(\s*['"`](get|list|read|search)/);
  });
});

// ===========================================================================
// NEGATIVE CONTROLS — each must make the guard FAIL, for the intended reason.
// All run against in-memory overlays; nothing is written to disk.
// ===========================================================================
const SCREEN3 = 'src/features/inventory/InventoryCenterScreen.tsx';

/** A synthetic screen-3 entry component wired to `chain`, replacing the real
 *  one in memory. Other screens keep their real source, so any new tuple is
 *  unambiguously attributable to the synthetic path. */
const syntheticScreen3 = (importLine: string, callExpr: string): string => `
${importLine}
export function InventoryCenterScreen(): unknown {
  return ${callExpr};
}
`;

const runOverlay = (overlay: Record<string, string>) => {
  const r = analyzeFacilityAuthorityReach({ overlay });
  return { ...r, extras: r.authority.filter((x) => !REVIEWED_KEYS.has(tupleKey(x))) };
};
const extrasOf = (overlay: Record<string, string>): AuthorityTuple[] => runOverlay(overlay).extras;

/**
 * Assert a pass-control is NOT vacuous.
 *
 * Before the compiler host learned to answer `directoryExists`/`realpath` for
 * overlay folders, every synthetic file was unresolvable — so each pass control
 * "passed" simply because nothing was ever visited, and each negative control
 * silently failed to detect. A pass control is only meaningful if the traversal
 * actually reached the synthetic file and still found no authority.
 */
const expectReached = (reachableFiles: readonly string[], file: string): void => {
  expect(reachableFiles, `pass control would be vacuous: ${file} was never traversed`).toContain(file);
};

describe('U3 · negative controls — future re-entry must FAIL', () => {
  it('CONTROL 1 · a new NESTED helper reachable from safe screen 3 that calls an authority service', () => {
    const extras = extrasOf({
      'src/features/inventory/__u3_synth__/nested/reentry.ts': `
        import { supabase } from '@/shared/supabase/client';
        export async function nestedReentry() {
          return supabase.rpc('assign_profile_role', { p_profile_id: null, p_role: 'x' });
        }`,
      [SCREEN3]: syntheticScreen3(
        `import { nestedReentry } from './__u3_synth__/nested/reentry';`, 'nestedReentry()'),
    });
    expect(extras.map((x) => x.sink)).toContain('assign_profile_role');
    expect(extras.some((x) => x.callsiteFile.includes('__u3_synth__/nested/reentry'))).toBe(true);
  });

  it('CONTROL 2 · the SAME rpc sink reached from a different callsite symbol', () => {
    // Proves the tuple key is not the RPC name: this sink is already reviewed
    // for screen 3, but only via outlet-stock.service::approveOutletStockCorrection.
    const extras = extrasOf({
      'src/features/inventory/__u3_synth__/moved.ts': `
        import { supabase } from '@/shared/supabase/client';
        export async function movedApprovalWriter() {
          return supabase.rpc('phoenix_approve_outlet_stock_correction', {});
        }`,
      [SCREEN3]: syntheticScreen3(
        `import { movedApprovalWriter } from './__u3_synth__/moved';`, 'movedApprovalWriter()'),
    });
    const hit = extras.find((x) => x.sink === 'phoenix_approve_outlet_stock_correction');
    expect(hit, 'a relocated writer with an already-reviewed sink must still be unreviewed').toBeTruthy();
    expect(hit!.callsiteSymbol).toBe('movedApprovalWriter');
  });

  it('CONTROL 3 · screen → component → hook → service → rpc writer', () => {
    const extras = extrasOf({
      'src/features/inventory/__u3_synth__/chain.service.ts': `
        import { supabase } from '@/shared/supabase/client';
        export async function chainWriter() { return supabase.rpc('phoenix_admin_grant_delegated_scope', {}); }`,
      'src/features/inventory/__u3_synth__/useChain.ts': `
        import { chainWriter } from './chain.service';
        export function useChain() { return { run: () => chainWriter() }; }`,
      'src/features/inventory/__u3_synth__/ChainPanel.tsx': `
        import { useChain } from './useChain';
        export function ChainPanel() { const c = useChain(); return c.run(); }`,
      [SCREEN3]: syntheticScreen3(
        `import { ChainPanel } from './__u3_synth__/ChainPanel';`, 'ChainPanel()'),
    });
    expect(extras.map((x) => x.sink)).toContain('phoenix_admin_grant_delegated_scope');
  });

  it('CONTROL 4 · a direct PostgREST relation write behind a safe screen', () => {
    const extras = extrasOf({
      'src/features/inventory/__u3_synth__/writer.ts': `
        import { supabase } from '@/shared/supabase/client';
        export async function directWriter() {
          return supabase.from('profiles').update({ full_name: 'x' }).eq('id', '1');
        }`,
      [SCREEN3]: syntheticScreen3(
        `import { directWriter } from './__u3_synth__/writer';`, 'directWriter()'),
    });
    const w = extras.find((x) => x.sinkType === 'table-write');
    expect(w, 'a reachable relation write must be reported').toBeTruthy();
    expect(w!.sink).toBe('profiles.update');
  });

  it('CONTROL 5 · a NEW, entirely unknown rpc name fails by default', () => {
    // The old guard could not see this: the RPC is in no catalogue at all.
    const extras = extrasOf({
      'src/features/inventory/__u3_synth__/future.ts': `
        import { supabase } from '@/shared/supabase/client';
        export async function futureWriter() {
          return supabase.rpc('phoenix_some_rpc_invented_next_quarter', {});
        }`,
      [SCREEN3]: syntheticScreen3(
        `import { futureWriter } from './__u3_synth__/future';`, 'futureWriter()'),
    });
    expect(extras.map((x) => x.sink)).toContain('phoenix_some_rpc_invented_next_quarter');
  });
});

// ===========================================================================
// PASS CONTROLS — legitimate read-only UI must NOT be flagged.
// Each asserts "introduces no UNREVIEWED authority", which is the property the
// guard must have; reviewed screen-3 tuples are naturally absent because the
// synthetic component replaces that screen.
// ===========================================================================
describe('U3 · pass controls — read-only surfaces stay clean', () => {
  it('CONTROL 6 · an RLS-filtered read/search path introduces no authority', () => {
    const r = runOverlay({
      'src/features/inventory/__u3_synth__/search.ts': `
        import { supabase } from '@/shared/supabase/client';
        export async function searchThings(term: string) {
          return supabase.from('central_items').select('id,name').ilike('name', term);
        }`,
      [SCREEN3]: syntheticScreen3(
        `import { searchThings } from './__u3_synth__/search';`, `searchThings('x')`),
    });
    expectReached(r.reachableFiles, 'src/features/inventory/__u3_synth__/search.ts');
    expect(r.extras).toEqual([]);
  });

  it('CONTROL 7 · importing ONE read symbol from a mixed module does not reach its admin writers', () => {
    // The proven module-granularity false positive: organizations.service.ts
    // exports getOrganizations AND assignProfileRole.
    const r = runOverlay({
      [SCREEN3]: syntheticScreen3(
        `import { getOrganizations } from '@/shared/supabase/services/organizations.service';`,
        'getOrganizations()'),
    });
    expectReached(r.reachableFiles, 'src/shared/supabase/services/organizations.service.ts');
    expect(r.extras).toEqual([]);

    // …and the module IS genuinely traversed in the real baseline, so this is
    // not passing merely because the file was never visited.
    expect(base.reachableFiles).toContain('src/shared/supabase/services/organizations.service.ts');
    for (const forbidden of [
      'assign_profile_role', 'assign_profile_permissions', 'reset_profile_permissions',
      'phoenix_admin_grant_delegated_scope', 'phoenix_admin_revoke_delegated_scope',
      'phoenix_admin_grant_delegated_network_snapshot',
    ]) {
      expect(base.authority.map((x) => x.sink), forbidden).not.toContain(forbidden);
    }
  });

  it('CONTROL 8 · a pure reporting/export path introduces no authority', () => {
    const r = runOverlay({
      'src/features/inventory/__u3_synth__/report.ts': `
        export function buildReport(rows: readonly { n: number }[]) {
          return rows.map(r => r.n).reduce((a, b) => a + b, 0);
        }`,
      [SCREEN3]: syntheticScreen3(
        `import { buildReport } from './__u3_synth__/report';`, 'buildReport([])'),
    });
    expectReached(r.reachableFiles, 'src/features/inventory/__u3_synth__/report.ts');
    expect(r.extras).toEqual([]);
  });

  it('CONTROL 9 · the three reviewed read-only RPCs are not treated as authority', () => {
    for (const rpc of PRESENTATION_ONLY_RPCS.keys()) {
      const r = runOverlay({
        'src/features/inventory/__u3_synth__/readonly.ts': `
          import { supabase } from '@/shared/supabase/client';
          export async function readOnlyCall() { return supabase.rpc('${rpc}', {}); }`,
        [SCREEN3]: syntheticScreen3(
          `import { readOnlyCall } from './__u3_synth__/readonly';`, 'readOnlyCall()'),
      });
      expectReached(r.reachableFiles, 'src/features/inventory/__u3_synth__/readonly.ts');
      // …and it WAS seen, as a presentation hit rather than authority.
      expect(r.presentation.some((x) => x.sink === rpc && x.screen === 3), rpc).toBe(true);
      expect(r.extras, rpc).toEqual([]);
    }
  });
});

describe('U3 · guard wiring and non-vacuity', () => {
  it('the direct-write primitive set is explicit', () => {
    expect([...DIRECT_WRITE_OPS].sort()).toEqual(['delete', 'insert', 'update', 'upsert']);
  });

  it('the analysis actually traversed a substantial graph', () => {
    expect(base.reachableFiles.length).toBeGreaterThan(50);
    expect(base.visitedSymbols).toBeGreaterThan(1000);
  });

  it('BOTH new U3 files are registered in the A7.2.4 exact-path approved-diff registry', () => {
    // The Unit-2 lesson: src/shared/authz is a WATCHED prefix, and an untracked
    // new file is invisible to that guard until it is committed — at which
    // point CI fails. Register by EXACT path, never by directory or wildcard.
    const guard = readFileSync(
      join(REPO_ROOT, 'src/shared/ui/__tests__/phase-a724-pharmacy-emblem-rollout.test.ts'), 'utf8');
    for (const p of [
      'src/shared/authz/__tests__/facility-authority-reentry-guard.helper.ts',
      'src/shared/authz/__tests__/facility-authority-reentry-guard.test.ts',
    ]) {
      expect(guard, `${p} must be registered by exact path`).toContain(`'${p}'`);
    }
    expect(guard).not.toContain("'src/shared/authz/__tests__/*'");
    expect(guard).not.toContain("'src/shared/authz/'");
  });

  it('this unit changed no runtime authorization source', () => {
    const untouched = readFileSync(join(REPO_ROOT, 'src/shared/authz/screen-access.ts'), 'utf8');
    expect(untouched).toMatch(/FACILITY_SAFE_SCREENS: readonly number\[\] = \[3, 6, 15, 18\]/);
    expect(repoRel(join(REPO_ROOT, 'src'))).toBe('src');
  });
});

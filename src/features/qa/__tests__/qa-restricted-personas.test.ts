import { describe, it, expect } from 'vitest';
import { createQaFixtureClient, QA_RPC_CALLS, clearQaRpcCalls } from '../qaFixtureClient';
import { qaAnswerExtraScopedPermission, qaScopeTopologyRows } from '../qaScopes';
import { ORG_A, ORG_B } from '../qaData';
import { QA_PERSONAS } from '../qaFixtures';

/**
 * IG-2 ROUND 3 — the QA-only simulation of `warehouse_transfer.return_request`
 * and `material_dispensing_suspension.view/create/lift`.
 *
 * WHY THIS EXISTS. `useQuarantinePermission` /
 * `useMaterialDispensingSuspensionPermission` ask
 * `supabaseRbacTransport.hasScopedPermission`, which sends the key straight to
 * `phoenix_profile_has_scoped_permission` with NO client-side allowlist — so
 * these two keys' absence from `scoped-permissions.ts`'s
 * `SCOPED_PERMISSION_KEY_SET` (migration 062 section B's ten keys) was never
 * evidence the PRODUCT needed a key added there; nothing reads that catalog to
 * decide them. What was actually missing was the harness's OWN fixture answer
 * for this RPC, which is what `qaAnswerExtraScopedPermission` supplies.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. This is the FIXTURE LOGIC in
 * isolation — exact-match scope comparison, per-key independence, real
 * assignment-driven reachability via `qaScopeTopologyRows`. It does not
 * restate migrations 099/105/203's real default role-to-key matrix (this
 * repository's tests have no visibility into that SQL); each persona below
 * demonstrates ONE property the review asked to see proven, using the same
 * assignment-gated mechanism the original ten keys already use.
 *
 * The end-to-end proof — that the REAL screen and REAL panels render
 * correctly from these answers — is
 * `tests/interactive-guide-ig2.chromium.test.ts`'s "restricted personas"
 * describe block, which drives an actual browser against this exact data.
 */

const client = createQaFixtureClient();

async function askQuarantine(profileId: string, warehouseId: string | null) {
  clearQaRpcCalls();
  const { data, error } = await client.rpc('phoenix_profile_has_scoped_permission', {
    p_profile_id: profileId,
    p_permission_key: 'warehouse_transfer.return_request',
    p_organization_id: ORG_A,
    p_warehouse_id: warehouseId,
    p_distribution_point_id: null,
  });
  return { data, error };
}

async function askSuspension(profileId: string, key: string, distributionPointId: string | null) {
  clearQaRpcCalls();
  const { data, error } = await client.rpc('phoenix_profile_has_scoped_permission', {
    p_profile_id: profileId,
    p_permission_key: key,
    p_organization_id: ORG_A,
    p_warehouse_id: null,
    p_distribution_point_id: distributionPointId,
  });
  return { data, error };
}

describe('IG-2 · QA simulation — warehouse_transfer.return_request (quarantine)', () => {
  it('grants the assigned warehouse and refuses every other one, for the same profile', async () => {
    const granted = await askQuarantine('qa-warehouse_officer_assigned', 'qa-wh-inst-a');
    expect(granted).toEqual({ data: true, error: null });

    // A DIFFERENT warehouse this SAME profile is separately ASSIGNED to
    // (migration 062, for the picker) but never scoped-permission-granted at.
    const differentWarehouse = await askQuarantine('qa-warehouse_officer_assigned', 'qa-wh-inst-a-empty');
    expect(differentWarehouse).toEqual({ data: false, error: null });
  });

  it('refuses an unassigned profile at the identical warehouse a granted profile is allowed at', async () => {
    const unassigned = await askQuarantine('qa-warehouse_officer', 'qa-wh-inst-a');
    expect(unassigned).toEqual({ data: false, error: null });
  });

  it('never lets an organization-only ask (rule-8 shape) leak a warehouse grant', async () => {
    const result = await askQuarantine('qa-warehouse_officer_assigned', null);
    // quarantine's key targets 'warehouse' only (see QA_EXTRA_SCOPED_PERMISSION_KEYS);
    // asking with no warehouse can never match an exact-warehouse grant.
    expect(result).toEqual({ data: false, error: null });
  });

  it('records the RPC call exactly as sent, for the capture/verification tooling', async () => {
    await askQuarantine('qa-warehouse_officer_assigned', 'qa-wh-inst-a');
    expect(QA_RPC_CALLS).toHaveLength(1);
    expect(QA_RPC_CALLS[0]).toEqual({
      name: 'phoenix_profile_has_scoped_permission',
      args: {
        p_profile_id: 'qa-warehouse_officer_assigned',
        p_permission_key: 'warehouse_transfer.return_request',
        p_organization_id: ORG_A,
        p_warehouse_id: 'qa-wh-inst-a',
        p_distribution_point_id: null,
      },
    });
  });
});

describe('IG-2 · QA simulation — material_dispensing_suspension.{view,create,lift}', () => {
  it('answers the three keys INDEPENDENTLY for the outlet-reachable, no-org-wide-claim persona', async () => {
    const view = await askSuspension('qa-outlet_officer_assigned', 'material_dispensing_suspension.view', null);
    const create = await askSuspension('qa-outlet_officer_assigned', 'material_dispensing_suspension.create', null);
    const lift = await askSuspension('qa-outlet_officer_assigned', 'material_dispensing_suspension.lift', null);
    expect(view.data).toBe(true);
    expect(create.data).toBe(false);
    expect(lift.data).toBe(true);
  });

  it('answers the three keys independently for the org-wide claim persona, the OPPOSITE combination', async () => {
    const view = await askSuspension('qa-institution_admin', 'material_dispensing_suspension.view', null);
    const create = await askSuspension('qa-institution_admin', 'material_dispensing_suspension.create', null);
    const lift = await askSuspension('qa-institution_admin', 'material_dispensing_suspension.lift', null);
    expect(view.data).toBe(true);
    expect(create.data).toBe(true);
    expect(lift.data).toBe(false);
  });

  it('separates REACHABILITY (an outlet assignment) from an exact-scope CREATE grant', async () => {
    // No org-wide claim...
    const orgWide = await askSuspension('qa-central_warehouse_manager', 'material_dispensing_suspension.create', null);
    expect(orgWide.data).toBe(false);
    // ...but a genuine grant at the EXACT outlet this profile is assigned to.
    const exactOutlet = await askSuspension('qa-central_warehouse_manager', 'material_dispensing_suspension.create', 'qa-outlet-2');
    expect(exactOutlet.data).toBe(true);
    // A DIFFERENT outlet — never assigned, never granted — stays refused.
    const otherOutlet = await askSuspension('qa-central_warehouse_manager', 'material_dispensing_suspension.create', 'qa-outlet-1');
    expect(otherOutlet.data).toBe(false);
  });

  it('never lets a grant at one outlet answer for a different outlet, for the SAME persona', async () => {
    // qa-institution_admin's claim is (org, null, null) — an outlet-targeted
    // ask must never match it; the exact-match rule has no organization-only
    // fallback the way migration-062's rule 8 does for the original ten keys.
    const atAnOutlet = await askSuspension('qa-institution_admin', 'material_dispensing_suspension.create', 'qa-outlet-1');
    expect(atAnOutlet.data).toBe(false);
  });

  it('refuses an unassigned, ungranted profile every one of the three keys', async () => {
    for (const key of ['view', 'create', 'lift']) {
      const result = await askSuspension('qa-outlet_officer', `material_dispensing_suspension.${key}`, null);
      expect(result.data, key).toBe(false);
    }
  });
});

describe('IG-2 · QA simulation — the read-only persona grants nothing extra', () => {
  it('holds no warehouse_transfer.return_request grant at any warehouse', async () => {
    for (const warehouseId of ['qa-wh-inst-a', 'qa-wh-inst-a-empty', 'qa-wh-inst-b']) {
      const result = await askQuarantine('qa-health_center_manager_assigned', warehouseId);
      expect(result.data, warehouseId).toBe(false);
    }
  });
});

describe('IG-2 · QA simulation — an unrecognised key falls through unchanged', () => {
  it('leaves the ordinary QA_READONLY failure in place for a key this round never touched', async () => {
    const { data, error } = await client.rpc('phoenix_profile_has_scoped_permission', {
      p_profile_id: 'qa-warehouse_officer_assigned',
      p_permission_key: 'warehouse_stock.adjust', // one of the ORIGINAL ten keys
      p_organization_id: ORG_A,
      p_warehouse_id: 'qa-wh-inst-a',
      p_distribution_point_id: null,
    });
    expect(data).toBeNull();
    expect(error?.code).toBe('QA_READONLY');
  });
});

describe('IG-2 · QA simulation — qaAnswerExtraScopedPermission as a pure function', () => {
  it('returns null (not one of ours) for a key outside this catalog, never false', () => {
    // null and false are different answers: null defers to whatever else the
    // transport does with the key; false would assert an actual refusal.
    expect(qaAnswerExtraScopedPermission({
      profileId: 'qa-super_admin', permissionKey: 'users.edit_scope',
      organizationId: null, warehouseId: null, distributionPointId: null,
    })).toBeNull();
  });

  it('requires an EXACT match on every field — organization included', () => {
    const grantedForOrgA = qaAnswerExtraScopedPermission({
      profileId: 'qa-warehouse_officer_assigned',
      permissionKey: 'warehouse_transfer.return_request',
      organizationId: ORG_A, warehouseId: 'qa-wh-inst-a', distributionPointId: null,
    });
    const askedForOrgB = qaAnswerExtraScopedPermission({
      profileId: 'qa-warehouse_officer_assigned',
      permissionKey: 'warehouse_transfer.return_request',
      organizationId: ORG_B, warehouseId: 'qa-wh-inst-a', distributionPointId: null,
    });
    expect(grantedForOrgA).toBe(true);
    expect(askedForOrgB).toBe(false);
  });
});

describe('IG-2 · QA simulation — reachability plumbing is consistent with the grants above', () => {
  it('qa-warehouse_officer_assigned is topology-assigned to BOTH warehouses it can select', () => {
    const rows = qaScopeTopologyRows('qa-warehouse_officer_assigned', ORG_A);
    const warehouses = rows.filter(r => r.node_kind === 'warehouse' && r.in_effective_scope);
    expect(warehouses.map(w => w.warehouse_id).sort()).toEqual(['qa-wh-inst-a', 'qa-wh-inst-a-empty']);
  });

  it('qa-central_warehouse_manager reaches qa-outlet-2 through its own point assignment', () => {
    const rows = qaScopeTopologyRows('qa-central_warehouse_manager', ORG_A);
    const outlet = rows.find(r => r.distribution_point_id === 'qa-outlet-2');
    expect(outlet?.in_effective_scope).toBe(true);
  });

  it('every new persona id used above is a real, registered QA persona', () => {
    const ids = QA_PERSONAS.map(p => p.id);
    for (const id of [
      'warehouse_officer_assigned', 'warehouse_officer', 'outlet_officer_assigned',
      'outlet_officer', 'institution_admin', 'central_warehouse_manager',
      'health_center_manager_assigned',
    ]) {
      expect(ids, id).toContain(id);
    }
  });
});

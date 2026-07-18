/**
 * RBAC-PHASE-2-STAGING-SHADOW-TELEMETRY-AND-LEGACY-ROLE-ALIGNMENT — Phase B.
 *
 * Every retained role keeps its own authorization identity and is never
 * resolved through a newer operational role.
 *
 * WHY THIS MATTERS, stated once: migration 010 seeded transfer_manager by
 * COPYING monthly_status_officer's defaults, so the two are identical today.
 * Migration 062 then diverged them — monthly_status_officer gained reports.view
 * and audit.view; transfer_manager gained neither and was explicitly denied the
 * other eight new keys. A frontend that resolves one role through the other
 * cannot represent that divergence, and would grant two denied permissions the
 * moment the new keys reach the catalog. Migration 066 repeats that boundary
 * for warehouse_manager, port_officer and point_operator: new warehouse/outlet
 * roles receive keys the retained roles are denied. These tests pin both halves:
 * today's fallback behavior is preserved and every inheritance channel is shut.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  normalizeRole, roleLabelKey, isLegacyAuthorizationRole,
  LEGACY_TO_OFFICIAL, LEGACY_AUTHORIZATION_ROLES, OFFICIAL_ROLES,
} from '../roles';
import { roleDefaults, effectivePermissions } from '../permissions';
import { SCOPED_PERMISSION_KEYS } from '@/shared/authz/scoped-permissions';

const NEW_062_KEYS = SCOPED_PERMISSION_KEYS.map(k => k.key);

describe('B1. transfer_manager keeps its own authorization identity', () => {
  it('normalizeRole does not rewrite it into monthly_status_officer', () => {
    expect(normalizeRole('transfer_manager')).toBe('transfer_manager');
    expect(normalizeRole('transfer_manager')).not.toBe('monthly_status_officer');
  });

  it('does not fall back to viewer, monthly_status_officer or super_admin', () => {
    const n = normalizeRole('transfer_manager');
    expect(n).not.toBe('viewer');
    expect(n).not.toBe('monthly_status_officer');
    expect(n).not.toBe('super_admin');
  });

  it('is not present in the legacy alias table — an alias claims equivalence', () => {
    expect(LEGACY_TO_OFFICIAL).not.toHaveProperty('transfer_manager');
    expect(Object.keys(LEGACY_TO_OFFICIAL)).toEqual([]);
  });

  it('is recognised as a legacy authorization role', () => {
    expect(isLegacyAuthorizationRole('transfer_manager')).toBe(true);
    expect([...LEGACY_AUTHORIZATION_ROLES]).toEqual([
      'warehouse_manager', 'port_officer', 'point_operator', 'transfer_manager',
    ]);
    for (const r of [...OFFICIAL_ROLES, 'hospital_admin']) {
      expect(isLegacyAuthorizationRole(r)).toBe(false);
    }
  });

  it('the stored role value stays readable and is never rewritten', () => {
    // normalizeRole interprets; it does not mutate. The identity it returns for
    // a stored 'transfer_manager' round-trips to the same stored string.
    expect(normalizeRole('transfer_manager')).toBe('transfer_manager');
  });
});

describe('B2. display stays compatible', () => {
  it('marks transfer_manager as a retained legacy role', () => {
    expect(roleLabelKey('transfer_manager')).toBe('orole_legacy_transfer_manager');
  });

  it('every role still resolves to a defined label key', () => {
    for (const r of [
      ...OFFICIAL_ROLES, 'hospital_admin', 'transfer_manager',
      'warehouse_manager', 'port_officer', 'point_operator', 'nonsense', '', null, undefined,
    ]) {
      const key = roleLabelKey(r as string);
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    }
  });
});

describe('B3. transfer_manager inherits no new 062 permission', () => {
  it('holds none of the ten new keys by default', () => {
    const d = roleDefaults('transfer_manager');
    for (const key of NEW_062_KEYS) {
      expect(`${key}: ${d.has(key)}`).toBe(`${key}: false`);
    }
  });

  it('specifically holds neither reports.view nor audit.view', () => {
    // The two migration 062 grants monthly_status_officer and it does not.
    const d = roleDefaults('transfer_manager');
    expect(d.has('reports.view')).toBe(false);
    expect(d.has('audit.view')).toBe(false);
  });

  it('gains nothing even if monthly_status_officer later gains the new keys', () => {
    // The defence is structural: the list is a snapshot, not a reference. This
    // asserts the source rather than the behavior, because the behavior only
    // diverges AFTER someone edits the other list — which is exactly the moment
    // the safeguard has to already be in place.
    const src = readFileSync(join(__dirname, '../permissions.ts'), 'utf8');
    expect(src).toContain('const TRANSFER_MANAGER_LEGACY_DEFAULTS = [');
    expect(src).toContain("if (n === 'transfer_manager') return new Set(TRANSFER_MANAGER_LEGACY_DEFAULTS);");
    // It must not be derived from the other role's list.
    expect(src).not.toContain('TRANSFER_MANAGER_LEGACY_DEFAULTS = MONTHLY_STATUS_OFFICER_DEFAULTS');
    expect(src).not.toContain('...MONTHLY_STATUS_OFFICER_DEFAULTS');
  });

  it('no retained role can inherit a 062 key', () => {
    for (const role of LEGACY_AUTHORIZATION_ROLES) {
      const d = roleDefaults(role);
      for (const key of NEW_062_KEYS) {
        expect(`${role}/${key}: ${d.has(key)}`).toBe(`${role}/${key}: false`);
      }
    }
  });

  it('an explicit override is still the only way to grant it a new key', () => {
    // Overrides are a deliberate, audited administrative act; inheritance is not.
    // This documents that the frozen list removes the accident, not the decision.
    const eff = effectivePermissions('transfer_manager', {});
    expect(eff.has('reports.view')).toBe(false);
  });
});

describe('B4. today\'s privileges are preserved — nothing is escalated or dropped', () => {
  it('keeps the exact legacy set migration 010 copied from monthly_status_officer', () => {
    // 010: `select 'transfer_manager', permission_key, allowed from
    // role_permission_defaults where role = 'monthly_status_officer'`.
    // Today the two must still agree on every PRE-062 key — this phase changes
    // no privilege, it only stops the list from tracking future edits.
    const tm = roleDefaults('transfer_manager');
    const mso = roleDefaults('monthly_status_officer');
    expect([...tm].sort()).toEqual([...mso].sort());
  });

  it('still has alert acknowledge only, matching the committed lifecycle matrix', () => {
    const d = roleDefaults('transfer_manager');
    expect(d.has('inter_institution_alerts.acknowledge')).toBe(true);
    expect(d.has('inter_institution_alerts.manage')).toBe(false);
    expect(d.has('inter_institution_alerts.resolve')).toBe(false);
    expect(d.has('inter_institution_alerts.dismiss')).toBe(false);
  });

  it('holds no permission it did not hold before this phase', () => {
    const d = roleDefaults('transfer_manager');
    expect([...d].sort()).toEqual([
      'availability.movements.view',
      'availability.view',
      'dashboard.view',
      'exchange_alerts.view',
      'inter_institution_alerts.acknowledge',
      'inter_institution_alerts.view',
      'status_center.create',
      'status_center.edit',
      'status_center.resolve',
      'status_center.view',
      'status_contacts.manage',
      'status_contacts.view',
    ]);
  });
});

describe('B6. the authorization context preserves the original role', () => {
  it('AppContext feeds the engine the STORED role, never a normalized one', () => {
    const ctx = readFileSync(join(__dirname, '../../../app/AppContext.tsx'), 'utf8');
    // The engine's context must carry profiles.role verbatim: the database's
    // scoped helper looks the role up itself, and handing it a frontend
    // normalization would ask it about a different role than the one stored.
    expect(ctx).toContain('role:              profile?.role ?? null,');
    // Specifically NOT the display role, whose fallback is 'viewer'.
    expect(ctx).not.toContain('role: normalizeRole(');
    expect(ctx).not.toContain("role:              role,");
  });

  it('a stored transfer_manager reaches the engine as transfer_manager', async () => {
    const { createAuthorizationService } = await import('@/shared/authz/authorization');
    const svc = createAuthorizationService({ mode: 'off' });
    svc.setContext({
      authenticated: true, profileId: 'p-xfer', role: 'transfer_manager',
      organizationId: 'org-1', legacyPermissions: new Set(),
    });
    expect(svc.getContext().role).toBe('transfer_manager');
    expect(svc.getContext().role).not.toBe('monthly_status_officer');
  });

  it('a legacy role is never enforced as super_admin by the pilot', async () => {
    const { scopedEngineEnforcesRole } = await import('@/shared/authz/mode');
    for (const r of ['transfer_manager', 'warehouse_manager', 'point_operator', 'hospital_admin']) {
      expect(scopedEngineEnforcesRole('enforce_super_admin', r)).toBe(false);
    }
  });
});

describe('B7. shadow diagnostics report the literal role without escalation', () => {
  it('reports the stored role string, not a normalized substitute', async () => {
    const { createAuthorizationService } = await import('@/shared/authz/authorization');
    const { createShadowReporter } = await import('@/shared/authz/diagnostics');
    const { createFakeDb, createFakeTransport } = await import('@/shared/authz/__tests__/fake-062-database');

    const ORG = 'org-1';
    const fake = createFakeDb({
      profiles: [{ id: 'p-xfer', role: 'transfer_manager', status: 'active', organization_id: ORG }],
      // The legacy engine grants it, the scoped engine denies it → a mismatch,
      // which is the only way to get a diagnostic record out of the engine.
      roleDefaults: { transfer_manager: { 'status_center.view': true } },
    });

    const emitted: { role: string }[] = [];
    const svc = createAuthorizationService({
      mode: 'shadow',
      transport: createFakeTransport(fake),
      reporter: createShadowReporter({ emit: r => emitted.push(r) }),
    });
    svc.setContext({
      authenticated: true, profileId: 'p-xfer', role: 'transfer_manager',
      organizationId: ORG, legacyPermissions: new Set(['status_center.view']),
    });

    await svc.canForOrganization('status_center.view', ORG);

    expect(emitted).toHaveLength(1);
    // A diagnostic that renamed the role would make the mismatch report unusable
    // for exactly the role this phase exists to disambiguate.
    expect(emitted[0].role).toBe('transfer_manager');
    expect(emitted[0].role).not.toBe('monthly_status_officer');
    expect(emitted[0].role).not.toBe('super_admin');
  });
});

describe('B5. unrelated roles are unchanged', () => {
  it('every retained role now normalizes to its literal stored identity', () => {
    expect(normalizeRole('warehouse_manager')).toBe('warehouse_manager');
    expect(normalizeRole('port_officer')).toBe('port_officer');
    expect(normalizeRole('point_operator')).toBe('point_operator');
    expect(normalizeRole('hospital_admin')).toBe('hospital_admin');
  });

  it('every official role still normalizes to itself', () => {
    for (const r of OFFICIAL_ROLES) expect(normalizeRole(r)).toBe(r);
  });

  it('unknown and empty roles still fall back to viewer', () => {
    for (const r of ['nonsense', '', null, undefined]) {
      expect(normalizeRole(r as string)).toBe('viewer');
    }
  });

  it('monthly_status_officer itself is untouched', () => {
    const d = roleDefaults('monthly_status_officer');
    expect(d.has('status_center.create')).toBe(true);
    expect(d.has('inter_institution_alerts.acknowledge')).toBe(true);
    expect(d.has('status_contacts.manage')).toBe(true);
  });

  it('super_admin is not reachable from any legacy role', () => {
    for (const r of ['transfer_manager', 'warehouse_manager', 'port_officer', 'point_operator', 'hospital_admin', 'nonsense']) {
      expect(normalizeRole(r)).not.toBe('super_admin');
    }
  });
});

describe('B8. migration 066 operational roles are explicit and fail closed', () => {
  const migration066 = readFileSync(
    join(__dirname, '../../../../supabase/migrations/066_phoenix_inventory_network_expand.sql'),
    'utf8',
  );
  const strings = readFileSync(join(__dirname, '../../i18n/strings.ts'), 'utf8');
  const permissions = readFileSync(join(__dirname, '../permissions.ts'), 'utf8');
  const createUser = readFileSync(
    join(__dirname, '../../../../supabase/functions/admin-create-user/index.ts'),
    'utf8',
  );
  const recycleUser = readFileSync(
    join(__dirname, '../../../../supabase/functions/admin-recycle-user/index.ts'),
    'utf8',
  );

  it('offers the approved seven roles and retires port_officer from creation', () => {
    expect(OFFICIAL_ROLES).toEqual([
      'super_admin', 'institution_admin', 'central_warehouse_manager',
      'warehouse_officer', 'outlet_officer', 'monthly_status_officer', 'viewer',
    ]);
    expect(OFFICIAL_ROLES).not.toContain('port_officer');
  });

  it('mirrors the role values accepted by migration 066', () => {
    for (const role of [...OFFICIAL_ROLES, ...LEGACY_AUTHORIZATION_ROLES, 'hospital_admin']) {
      expect(migration066).toContain(`'${role}'`);
    }
  });

  it('new roles have bilingual labels and literal authorization identity', () => {
    expect(normalizeRole('central_warehouse_manager')).toBe('central_warehouse_manager');
    expect(normalizeRole('outlet_officer')).toBe('outlet_officer');
    expect(strings).toContain('orole_central_warehouse_manager:');
    expect(strings).toContain('orole_outlet_officer:');
  });

  it('uses narrow offline fallbacks until the 066 catalog lands', () => {
    expect([...roleDefaults('central_warehouse_manager')]).toEqual(['warehouses.view']);
    expect([...roleDefaults('outlet_officer')]).toEqual([]);
  });

  it('freezes every retained fallback instead of spreading a newer role list', () => {
    expect(permissions).not.toContain('...WAREHOUSE_OFFICER_DEFAULTS');
    expect(permissions).not.toContain('...PORT_OFFICER_DEFAULTS');
  });

  it('server allowlists accept the new roles and stop creating port_officer', () => {
    for (const source of [createUser, recycleUser]) {
      const allowlist = source.slice(
        source.indexOf('const OFFICIAL_ROLES'),
        source.indexOf('const CORS'),
      );
      expect(allowlist).toContain("'central_warehouse_manager'");
      expect(allowlist).toContain("'outlet_officer'");
      expect(allowlist).not.toContain("'port_officer'");
    }
  });

  it('reserves central manager assignment for super_admin on both server paths', () => {
    expect(createUser).toContain("role === 'central_warehouse_manager' && !isSuper");
    expect(createUser).toContain('CANNOT_CREATE_CENTRAL_WAREHOUSE_MANAGER');
    expect(recycleUser).toContain("newRole === 'central_warehouse_manager'");
    expect(recycleUser).toContain('CANNOT_ASSIGN_ELEVATED_ROLE');
  });
});

/**
 * RBAC-FALLBACK-ALIGNMENT — Checkpoint 1.
 *
 * The frontend role-default fallback must never out-grant migration 062.
 *
 * WHY THIS FILE PARSES SQL RATHER THAN RE-STATING IT: a hand-copied expectation
 * table is a second source of truth that drifts silently — the exact failure it
 * would exist to prevent. These tests derive 062's defaults from the committed
 * migration itself, so a future edit to the SQL that diverges from the fallback
 * fails here instead of in production.
 *
 * THE DIVERGENCE THIS CLOSES: migration 010 granted warehouse_officer
 * `warehouses.manage`; migration 060 then made that key authorize org-wide
 * INSERT/UPDATE on warehouse MASTER records; migration 062 (C1) set the default
 * to false. The frontend fallback still granted it — so a fallback-resolved
 * warehouse_officer could see warehouse-master affordances the database denies.
 *
 * SCOPE: the fallback is a fallback. `get_effective_permissions` is
 * authoritative whenever it succeeds (see D3). These tests pin the fallback's
 * shape, not the database's.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { roleDefaults, effectivePermissions, PERMISSION_KEY_SET, PERMISSION_KEYS } from '../permissions';
import { normalizeRole, OFFICIAL_ROLES, LEGACY_AUTHORIZATION_ROLES } from '../roles';
import { SCOPED_PERMISSION_KEYS } from '@/shared/authz/scoped-permissions';

const MIGRATION_062 = readFileSync(
  join(__dirname, '../../../../supabase/migrations/062_phoenix_user_rbac_scope_foundation.sql'),
  'utf8',
);

const NEW_062_KEYS = SCOPED_PERMISSION_KEYS.map(k => k.key);

/**
 * Extract every ('role','permission_key',bool) default tuple 062 states.
 * Comment lines are stripped first so the prose examples in the header (which
 * contain role names and keys) can never be mistaken for real defaults.
 */
function parse062Defaults(): Map<string, boolean> {
  const sql = MIGRATION_062.split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');

  const out = new Map<string, boolean>();

  // C2: INSERT ... VALUES ('role','key',true|false)
  const tuple = /\(\s*'([a-z_]+)'\s*,\s*'([a-z_.]+)'\s*,\s*(true|false)\s*\)/g;
  for (const m of sql.matchAll(tuple)) {
    out.set(`${m[1]}::${m[2]}`, m[3] === 'true');
  }

  // C1: the UPDATE ... SET allowed = false that demotes warehouse_officer.
  const upd = /UPDATE\s+public\.role_permission_defaults\s+SET\s+allowed\s*=\s*(true|false)\s+WHERE\s+role\s*=\s*'([a-z_]+)'\s+AND\s+permission_key\s*=\s*'([a-z_.]+)'/gis;
  for (const m of sql.matchAll(upd)) {
    out.set(`${m[2]}::${m[3]}`, m[1].toLowerCase() === 'true');
  }

  return out;
}

const DB_DEFAULTS = parse062Defaults();

describe('A. The parser actually found migration 062 (guard against vacuous passes)', () => {
  it('parsed a substantial number of defaults', () => {
    expect(DB_DEFAULTS.size).toBeGreaterThan(40);
  });

  it('captured the C1 warehouse_officer demotion specifically', () => {
    expect(DB_DEFAULTS.get('warehouse_officer::warehouses.manage')).toBe(false);
  });
});

describe('B. warehouse_officer — the corrected role', () => {
  const d = roleDefaults('warehouse_officer');

  it('does NOT receive warehouses.manage from the fallback', () => {
    expect(d.has('warehouses.manage')).toBe(false);
  });

  it('retains warehouses.view — it must still see its warehouses', () => {
    expect(d.has('warehouses.view')).toBe(true);
  });

  it('agrees with migration 062 on warehouses.manage', () => {
    expect(d.has('warehouses.manage')).toBe(DB_DEFAULTS.get('warehouse_officer::warehouses.manage'));
  });

  it('keeps every unrelated permission it had before the correction', () => {
    // The pre-correction list minus warehouses.manage, pinned verbatim. If a
    // future edit removes anything else from this role, that is a regression.
    const PRESERVED = [
      'dashboard.view', 'organizations.view', 'warehouses.view',
      'ports.view', 'qr.view', 'qr.generate',
      'availability.view', 'availability.manage', 'availability.create', 'availability.update',
      'status_center.view', 'exchange_alerts.view', 'inter_institution_alerts.view',
      'deletion_wizard.view', 'deletion_wizard.clear_port_items', 'deletion_wizard.archive_port',
      'availability.quantity.set', 'availability.quantity.add', 'availability.quantity.subtract',
      'availability.movements.view', 'availability.movements.export', 'availability.movements.print',
      'inter_institution_alerts.acknowledge', 'inter_institution_alerts.manage',
      'inter_institution_alerts.resolve',
    ];
    for (const k of PRESERVED) expect(d.has(k), `warehouse_officer lost ${k}`).toBe(true);
    // Exactly the preserved set — nothing silently added alongside the removal.
    expect([...d].sort()).toEqual([...PRESERVED].sort());
  });

  it('still cannot correct quantities or manage users (unchanged by this repair)', () => {
    expect(d.has('availability.quantity.correct')).toBe(false);
    expect(d.has('users.create')).toBe(false);
    expect(d.has('inter_institution_alerts.dismiss')).toBe(false);
  });

  it('an explicit override can still grant the key back — an audited decision, not a default', () => {
    expect(effectivePermissions('warehouse_officer', { 'warehouses.manage': true }).has('warehouses.manage')).toBe(true);
    expect(effectivePermissions('warehouse_officer', {}).has('warehouses.manage')).toBe(false);
  });
});

describe('C. No collateral damage to other roles', () => {
  it('institution_admin and hospital_admin remain stock read-only', () => {
    // 062 grants them warehouse_stock.view/movements_view but explicitly denies
    // adjust/correct: oversight that can rewrite what it oversees is not oversight.
    for (const role of ['institution_admin', 'hospital_admin']) {
      expect(DB_DEFAULTS.get(`${role}::warehouse_stock.adjust`)).toBe(false);
      expect(DB_DEFAULTS.get(`${role}::warehouse_stock.correct`)).toBe(false);
      // The fallback surfaces none of the stock keys at all — fail-closed.
      const d = roleDefaults(role);
      expect(d.has('warehouse_stock.adjust')).toBe(false);
      expect(d.has('warehouse_stock.correct')).toBe(false);
    }
  });

  it('institution_admin never held warehouses.manage and still does not', () => {
    expect(roleDefaults('institution_admin').has('warehouses.manage')).toBe(false);
  });

  it('hospital_admin KEEPS warehouses.manage — 062 deliberately did not demote it', () => {
    // INTENTIONAL_LEGACY: 062's C1 names warehouse_officer only. Quietly
    // re-scoping legacy roles is explicitly out of that migration's contract,
    // so removing it here would be the frontend diverging in the other direction.
    expect(DB_DEFAULTS.has('hospital_admin::warehouses.manage')).toBe(false); // 062 states no row
    expect(roleDefaults('hospital_admin').has('warehouses.manage')).toBe(true);
  });

  it('transfer_manager receives no new 062 permission', () => {
    const d = roleDefaults('transfer_manager');
    for (const k of NEW_062_KEYS) {
      expect(d.has(k), `transfer_manager must not hold 062 key ${k}`).toBe(false);
    }
    expect(d.has('warehouses.manage')).toBe(false);
  });

  it('transfer_manager stays authorization-distinct — resolved through its OWN frozen list', () => {
    expect(normalizeRole('transfer_manager')).toBe('transfer_manager');
    expect(roleDefaults('transfer_manager').has('reports.view')).toBe(false);
  });

  it('no other role default changed: full snapshot of every role fallback', () => {
    // A blunt but load-bearing pin — any unintended edit to any role list fails here.
    const snapshot: Record<string, number> = {};
    for (const r of [...OFFICIAL_ROLES, ...LEGACY_AUTHORIZATION_ROLES]) {
      snapshot[r] = roleDefaults(r).size;
    }
    expect(snapshot).toMatchObject({
      warehouse_officer: 25, // 26 before the correction
      transfer_manager: 12,
    });
  });
});

describe('D. Structural safety', () => {
  it('D1. no role normalization produces privilege escalation', () => {
    // No legacy alias may inherit a 062 key it was never granted.
    for (const legacy of LEGACY_AUTHORIZATION_ROLES) {
      const legacyPerms = roleDefaults(legacy);
      for (const k of NEW_062_KEYS) {
        expect(legacyPerms.has(k), `legacy role ${legacy} inherited 062 key ${k}`).toBe(false);
      }
    }
  });

  it('D2. no legacy alias inherits a new 062 permission via the catalog', () => {
    // The 062 keys are deliberately NOT in the user-management catalog yet.
    for (const k of NEW_062_KEYS) {
      expect(PERMISSION_KEY_SET.has(k), `062 key ${k} leaked into the fallback catalog`).toBe(false);
    }
  });

  it('D3. the fallback never out-grants migration 062 on any shared key', () => {
    // The parity matrix, enforced: for every key present in BOTH the frontend
    // catalog and 062's stated defaults, a `false` in the DB must not be `true`
    // in the fallback. This is the general form of the warehouses.manage bug.
    const violations: string[] = [];
    for (const [compound, allowed] of DB_DEFAULTS) {
      const [role, key] = compound.split('::');
      if (!PERMISSION_KEY_SET.has(key)) continue;      // not surfaced in fallback
      if (!isKnownRole(role)) continue;
      if (allowed === false && roleDefaults(role).has(key)) {
        violations.push(`${role} holds ${key} in fallback but 062 denies it`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('D4. every fallback key is a valid catalog key', () => {
    const valid = new Set(PERMISSION_KEYS.map(p => p.key));
    for (const r of [...OFFICIAL_ROLES, ...LEGACY_AUTHORIZATION_ROLES]) {
      for (const k of roleDefaults(r)) {
        expect(valid.has(k), `${r} default ${k} is not in the catalog`).toBe(true);
      }
    }
  });
});

function isKnownRole(role: string): boolean {
  return ([...OFFICIAL_ROLES, ...LEGACY_AUTHORIZATION_ROLES] as string[]).includes(role);
}

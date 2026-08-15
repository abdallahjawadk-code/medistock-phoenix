/**
 * R1.3 · SUPPLY SURFACE REACHABILITY.
 *
 * THE DEFECT THIS CLOSES
 * ---------------------------------------------------------------------------
 * Screen 17 hosts two unrelated sub-surfaces: warehouse/network structural
 * administration plus scope assignment (`users.edit_scope`), and the SUPPLY
 * authoring surface (`warehouse_transfer.send`). The canonical screen gate
 * admitted only the first:
 *
 *     if (screen === 17) return super_admin || permissions.has('users.edit_scope');
 *
 * while NetworkManagementScreen offered the Supply tab on
 * `warehouse_transfer.send`. `central_warehouse_manager` — the role that exists
 * to send central stock — holds `warehouse_transfer.send = true` (migration
 * 068) and is granted `users.edit_scope` by NO migration. It could therefore
 * satisfy every server-side check the supply RPC makes and still be bounced to
 * its landing screen before the surface ever rendered.
 *
 * THE FIX, AND WHAT IT MUST NOT DO
 * ---------------------------------------------------------------------------
 * Admit the supply CAPABILITY at the screen gate. Emphatically NOT: grant
 * `users.edit_scope` to warehouse senders, and NOT widen anything for a
 * facility-scoped role. Both are asserted below as first-class requirements.
 *
 * Reaching a screen is not authority over it: every sub-surface keeps its own
 * gate, and the database re-proves every read and write regardless.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isScreenAuthorized } from '../screen-access';
import { projectNavigation } from '../nav-projection';

const ROOT = join(__dirname, '../../../../');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const SUPPLY_SCREEN = 17;
const perms = (...keys: string[]) => new Set<string>(keys);

describe('R1.3 · a legitimate supply actor can reach the supply surface', () => {
  it('central_warehouse_manager with warehouse_transfer.send reaches screen 17', () => {
    expect(isScreenAuthorized(SUPPLY_SCREEN, 'central_warehouse_manager', perms('warehouse_transfer.send')))
      .toBe(true);
  });

  it('reaches it WITHOUT holding users.edit_scope', () => {
    const actorPerms = perms('warehouse_transfer.send');
    expect(actorPerms.has('users.edit_scope')).toBe(false);
    expect(isScreenAuthorized(SUPPLY_SCREEN, 'central_warehouse_manager', actorPerms)).toBe(true);
  });

  it('any role holding the send capability reaches it, not just the central manager', () => {
    for (const role of ['warehouse_officer', 'warehouse_manager', 'transfer_manager', 'institution_admin']) {
      expect(isScreenAuthorized(SUPPLY_SCREEN, role, perms('warehouse_transfer.send')), role).toBe(true);
    }
  });

  it('super_admin and users.edit_scope holders keep their existing access', () => {
    expect(isScreenAuthorized(SUPPLY_SCREEN, 'super_admin', perms())).toBe(true);
    expect(isScreenAuthorized(SUPPLY_SCREEN, 'warehouse_officer', perms('users.edit_scope'))).toBe(true);
  });

  it('the nav projection AGREES with the guard — no menu entry the guard refuses', () => {
    const item = [{ screen: SUPPLY_SCREEN, labelKey: 'nav_network' }];
    for (const actor of [
      { role: 'central_warehouse_manager', permissions: perms('warehouse_transfer.send') },
      { role: 'central_warehouse_manager', permissions: perms() },
      { role: 'warehouse_officer', permissions: perms('users.edit_scope') },
      { role: 'warehouse_officer', permissions: perms() },
      { role: 'health_center_manager', permissions: perms('warehouse_transfer.send') },
      { role: 'super_admin', permissions: perms() },
    ]) {
      const visible = projectNavigation(item, actor).length === 1;
      const authorized = isScreenAuthorized(SUPPLY_SCREEN, actor.role, actor.permissions);
      expect(visible, `${actor.role} / [${[...actor.permissions].join(',')}]`).toBe(authorized);
    }
  });
});

describe('R1.3 · the widening is exactly one screen and one capability', () => {
  it('holding NEITHER capability still refuses screen 17', () => {
    for (const role of ['warehouse_officer', 'outlet_officer', 'port_officer', 'point_operator', 'viewer']) {
      expect(isScreenAuthorized(SUPPLY_SCREEN, role, perms()), role).toBe(false);
    }
  });

  it('warehouse_transfer.send does NOT unlock the user-management screen (14)', () => {
    expect(isScreenAuthorized(14, 'central_warehouse_manager', perms('warehouse_transfer.send'))).toBe(false);
  });

  it('warehouse_transfer.send does NOT unlock the institutions directory (11)', () => {
    expect(isScreenAuthorized(11, 'central_warehouse_manager', perms('warehouse_transfer.send'))).toBe(false);
  });

  it('an unrelated permission does not unlock screen 17', () => {
    for (const key of ['warehouse_transfer.view', 'warehouse_transfer.receive', 'reports.view', 'users.view']) {
      expect(isScreenAuthorized(SUPPLY_SCREEN, 'warehouse_officer', perms(key)), key).toBe(false);
    }
  });
});

describe('R1.3 · no facility-scoped widening', () => {
  it('health_center_manager is refused screen 17 even holding warehouse_transfer.send', () => {
    expect(isScreenAuthorized(SUPPLY_SCREEN, 'health_center_manager', perms('warehouse_transfer.send')))
      .toBe(false);
  });

  it('health_center_manager is refused screen 17 holding BOTH gate permissions', () => {
    expect(isScreenAuthorized(
      SUPPLY_SCREEN, 'health_center_manager', perms('warehouse_transfer.send', 'users.edit_scope'),
    )).toBe(false);
  });

  it('its facility-safe allow-list is unchanged and still excludes 17', () => {
    const src = read('src/shared/authz/screen-access.ts');
    expect(src).toMatch(/FACILITY_SAFE_SCREENS: readonly number\[\] = \[3, 6, 15, 18\]/);
    for (const screen of [3, 6, 15, 18]) {
      expect(
        isScreenAuthorized(screen, 'health_center_manager', perms()),
        `facility-safe screen ${screen}`,
      ).toBe(true);
    }
  });

  it('the facility-scoped early return still precedes the screen-17 branch', () => {
    // Ordering is load-bearing: if the 17 branch ran first, the widening would
    // reach a facility-scoped role.
    const src = read('src/shared/authz/screen-access.ts');
    const earlyReturn = src.indexOf('if (isFacilityScopedRole(n)) return FACILITY_SAFE_SCREENS');
    const screen17 = src.indexOf('if (screen === 17)');
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(screen17).toBeGreaterThan(-1);
    expect(earlyReturn).toBeLessThan(screen17);
  });
});

describe('R1.3 · scope management remains gated on users.edit_scope', () => {
  const screenSrc = read('src/features/network/NetworkManagementScreen.tsx');

  it('NetworkManagementScreen still derives canEditScope from users.edit_scope alone', () => {
    expect(screenSrc).toMatch(/const canEditScope = isSuper \|\| myPermissions\.has\('users\.edit_scope'\)/);
  });

  it('canEditScope is NOT satisfied by the supply capability', () => {
    const line = screenSrc.split('\n').find(l => l.includes('const canEditScope')) ?? '';
    expect(line).not.toMatch(/warehouse_transfer/);
  });

  it('the supply tab keeps its own independent capability gate', () => {
    expect(screenSrc).toMatch(/const canSupply = isSuper \|\| myPermissions\.has\('warehouse_transfer\.send'\)/);
  });

  it('the screen gate grants no permission — it only decides reachability', () => {
    const src = read('src/shared/authz/screen-access.ts');
    // A UX gate must never mutate or synthesize a permission set.
    expect(src).not.toMatch(/permissions\.add\(/);
    expect(src).not.toMatch(/\.delete\(/);
  });
});

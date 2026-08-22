/**
 * PG-RIG PRODUCTION AUTHORIZATION BASELINE — the durable H-05 contract.
 *
 * Builds a CLEAN disposable rig through migration 194 and requires its
 * normalized authorization surface to equal the versioned contract fixture
 * `tools/pg-rig/production-authorization-baseline-v194.json` EXACTLY, in BOTH
 * directions. On failure it prints the actual object/signature/privilege
 * tuples — EXTRA_IN_RIG and MISSING_FROM_RIG — never just a count or a hash.
 *
 * WHY THIS EXISTS (H-04/H-05): before Unit 2 the repository could not
 * reproduce Production's authorization posture from a fresh platform baseline.
 * A clean replay came out MORE permissive than Production — 186 tuples more,
 * including writes on the RBAC tables. That is a disaster-recovery defect: any
 * rebuilt environment would have come up over-granted. This test is the
 * standing guard that the gap stays closed.
 *
 * A hash of the contract is checked too, but only as a secondary signal. Exact
 * set equality is the acceptance condition; a hash alone cannot tell an
 * operator WHICH privilege moved.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import {
  readAuthorizationSurface, setDifference, tuplesOfKind, objectsOf,
  authenticatedWrites, renderDiff, CONTRACT_WRITE_RELATIONS, MANUAL_AVAILABILITY_WRITERS,
  type AuthorizationSurface,
} from './helpers/authorization-surface';

vi.setConfig({ testTimeout: 300000, hookTimeout: 300000 });

const ROOT = join(__dirname, '../../../');
const CONTRACT = JSON.parse(
  readFileSync(join(ROOT, 'tools/pg-rig/production-authorization-baseline-v194.json'), 'utf8'),
) as {
  baseline_contract_version: number;
  source_production_ceiling: number;
  source_production_migration_version: string;
  source_master_sha: string;
  contract_semantics: string;
  normalization: { relation_privileges: string[]; [k: string]: unknown };
  anchors: Record<string, number>;
  migration_085_status: {
    source_header: string;
    production_history: string;
    production_count: number;
    m194_writer_revokes: string;
  };
  sets: {
    schema: string[]; relation: string[]; sequence: string[]; function: string[];
    default_acl: string[]; role_attributes: string[];
  };
  sets_sha256: string;
};

const CONTRACT_TUPLES = [
  ...CONTRACT.sets.schema, ...CONTRACT.sets.relation,
  ...CONTRACT.sets.sequence, ...CONTRACT.sets.function,
].sort();

describe('production authorization baseline · contract fixture integrity', () => {
  it('is the v194 contract, pinned to the reviewed source state', () => {
    expect(CONTRACT.baseline_contract_version).toBe(194);
    expect(CONTRACT.source_production_ceiling).toBe(193);
    expect(CONTRACT.source_production_migration_version).toBe('20260821211809');
    expect(CONTRACT.source_master_sha).toBe('f8deaf6a3533837e2beb12fc447a4adb3d189aed');
    expect(CONTRACT.contract_semantics).toBe('post_M194_canonical_authorization_surface');
  });

  it('records the CORRECTED migration 085 status contract', () => {
    // Live Production verification: 085 WAS applied (count 1). The fixture must
    // record that, and must not carry the retracted "prepared only" claim.
    expect(CONTRACT.migration_085_status.source_header).toBe('PREPARED_CUTOVER');
    expect(CONTRACT.migration_085_status.production_history).toBe('APPLIED');
    expect(CONTRACT.migration_085_status.production_count).toBe(1);
    expect(CONTRACT.migration_085_status.m194_writer_revokes)
      .toBe('IDEMPOTENT_REASSERTION_OF_EXISTING_085_SECURITY_BOUNDARY');
    // The retracted token must not survive as a STATUS VALUE. It may still
    // appear inside `note`, which is the record of the correction itself —
    // that history is deliberately kept, not scrubbed.
    const { note: _note, ...statusFields } = CONTRACT.migration_085_status as Record<string, unknown>;
    expect(JSON.stringify(statusFields)).not.toContain('PREPARED_ONLY_NOT_PRODUCTION_APPLIED');
    expect(JSON.stringify(statusFields)).not.toContain('SUPERSEDED_BY_M194');
    expect(String(_note)).toContain('PREPARED_ONLY_NOT_PRODUCTION_APPLIED');
  });

  it('carries authorization METADATA only — no secret-shaped material', () => {
    const raw = readFileSync(join(ROOT, 'tools/pg-rig/production-authorization-baseline-v194.json'), 'utf8');
    expect(raw).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);      // JWT
    expect(raw).not.toMatch(/sbp_[a-f0-9]{40,}/i);                             // supabase token
    expect(raw).not.toMatch(/postgres(ql)?:\/\/[^@\s"]*:[^@\s"]+@/i);          // credentialed URL
    expect(raw).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/); // email address
    expect(raw).not.toMatch(/service_role_key|anon_key/i);

    // Credential-shaped ASSIGNMENTS, not bare words: the contract legitimately
    // contains first-party function names such as
    // `phoenix_mark_password_changed()`, which are identifiers, not secrets.
    expect(raw).not.toMatch(/"(?:[a-z_]*(?:password|secret|token|api_?key|credential)[a-z_]*)"\s*:\s*"[^"]{8,}"/i);
    expect(raw).not.toMatch(/(?:password|secret|token|apikey|api_key)\s*=\s*\S{8,}/i);

    // And no row data: the contract stores object identities and privilege
    // names only, so every tuple must match the declared tuple grammar.
    for (const t of [...CONTRACT.sets.schema, ...CONTRACT.sets.relation,
                     ...CONTRACT.sets.sequence, ...CONTRACT.sets.function]) {
      expect(t, `malformed contract tuple: ${t}`).toMatch(
        /^(SCHEMA|RELATION|SEQUENCE|FUNCTION)\|(anon|authenticated|service_role)\|.+\|[A-Z]+$/,
      );
    }
  });

  it('its sets are deterministic, sorted, de-duplicated and non-empty', () => {
    for (const [name, set] of Object.entries(CONTRACT.sets)) {
      expect(set.length, `${name} must not be empty`).toBeGreaterThan(0);
      expect([...set], `${name} must be sorted`).toEqual([...set].sort());
      expect(new Set(set).size, `${name} must be de-duplicated`).toBe(set.length);
    }
  });

  it('its secondary hash matches its own sets', () => {
    const h = createHash('sha256').update(JSON.stringify(CONTRACT.sets)).digest('hex');
    expect(h).toBe(CONTRACT.sets_sha256);
  });
});

const run = rigAvailable() ? describe : describe.skip;

run('production authorization baseline · clean rig through 194', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let surface: AuthorizationSurface;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 194 });
    surface = await rig.asAdmin((c: any) =>
      readAuthorizationSurface((sql, params) => c.query(sql, params)));
  }, 300000);

  afterAll(async () => { await rig?.end(); });

  it('EXACT SET EQUALITY with the versioned Production authorization contract', () => {
    const extraInRig = setDifference(surface.tuples, CONTRACT_TUPLES);
    const missingFromRig = setDifference(CONTRACT_TUPLES, surface.tuples);

    if (extraInRig.length > 0 || missingFromRig.length > 0) {
      throw new Error(
        'pg-rig authorization surface does not match the Production baseline contract.\n' +
        'A clean rebuild from this repository must reproduce Production EXACTLY.\n\n' +
        renderDiff('EXTRA_IN_RIG', extraInRig) + '\n\n' +
        renderDiff('MISSING_FROM_RIG', missingFromRig) + '\n',
      );
    }
    expect(extraInRig).toEqual([]);
    expect(missingFromRig).toEqual([]);
  });

  it('default-ACL tuples match the contract exactly', () => {
    expect(setDifference(surface.default_acl, CONTRACT.sets.default_acl)).toEqual([]);
    expect(setDifference(CONTRACT.sets.default_acl, surface.default_acl)).toEqual([]);
  });

  it('role security properties match the contract exactly', () => {
    expect(setDifference(surface.role_attributes, CONTRACT.sets.role_attributes)).toEqual([]);
    expect(setDifference(CONTRACT.sets.role_attributes, surface.role_attributes)).toEqual([]);
    // service_role bypasses RLS by design; the two client principals must not.
    expect(surface.role_attributes.find((r) => r.startsWith('ROLE|service_role|'))).toContain('bypassrls=true');
    expect(surface.role_attributes.find((r) => r.startsWith('ROLE|authenticated|'))).toContain('bypassrls=false');
    expect(surface.role_attributes.find((r) => r.startsWith('ROLE|anon|'))).toContain('bypassrls=false');
  });

  it('secondary: the surface hash equals the contract hash', () => {
    const sets = {
      schema: tuplesOfKind(surface.tuples, 'SCHEMA', 'anon')
        .concat(tuplesOfKind(surface.tuples, 'SCHEMA', 'authenticated'))
        .concat(tuplesOfKind(surface.tuples, 'SCHEMA', 'service_role')).sort(),
      relation: surface.tuples.filter((t) => t.startsWith('RELATION|')).sort(),
      sequence: surface.tuples.filter((t) => t.startsWith('SEQUENCE|')).sort(),
      function: surface.tuples.filter((t) => t.startsWith('FUNCTION|')).sort(),
      default_acl: surface.default_acl,
      role_attributes: surface.role_attributes,
    };
    expect(createHash('sha256').update(JSON.stringify(sets)).digest('hex')).toBe(CONTRACT.sets_sha256);
  });

  // ==========================================================================
  // §27 NAMED ASSERTIONS — each pinned to the verified Production anchor.
  // ==========================================================================
  describe('named authorization anchors', () => {
    it('FIRST_PARTY_FUNCTION_COUNT = 349', () => {
      expect(surface.inventory.functions).toHaveLength(349);
      expect(CONTRACT.anchors.first_party_function_count).toBe(349);
    });

    it('SERVICE_ROLE_FUNCTION_EXECUTE = 315', () => {
      expect(tuplesOfKind(surface.tuples, 'FUNCTION', 'service_role')).toHaveLength(315);
    });

    it('ANON_FUNCTION_EXECUTE = 7', () => {
      expect(tuplesOfKind(surface.tuples, 'FUNCTION', 'anon')).toHaveLength(7);
    });

    it('AUTHENTICATED_FUNCTION_EXECUTE = 219', () => {
      // Production measured 219 at ceiling 193. That 219 ALREADY EXCLUDES the
      // two manual availability writers — Production has them revoked. A clean
      // replay of 001->193 reaches 221 (219 + those two), and M194 brings it
      // back to 219. So the count does NOT change in Production; it changes in
      // the rig, which is exactly the reproducibility defect M194 closes.
      expect(tuplesOfKind(surface.tuples, 'FUNCTION', 'authenticated')).toHaveLength(219);
    });

    it('AUTHENTICATED_WRITE_RELATIONS = 2 and AUTHENTICATED_WRITE_TUPLES = 4', () => {
      const writes = authenticatedWrites(surface.tuples);
      expect(writes).toEqual([
        'distribution_points|INSERT',
        'distribution_points|UPDATE',
        'organizations|INSERT',
        'organizations|UPDATE',
      ]);
      expect(new Set(writes.map((w) => w.split('|')[0])).size).toBe(2);
      expect(writes).toHaveLength(4);
      expect([...CONTRACT_WRITE_RELATIONS].sort())
        .toEqual([...new Set(writes.map((w) => w.split('|')[0]))].sort());
    });

    it('authenticated relation surface = 75 relations / 79 tuples', () => {
      const rel = tuplesOfKind(surface.tuples, 'RELATION', 'authenticated');
      expect(rel).toHaveLength(79);
      expect(objectsOf(rel)).toHaveLength(75);
    });

    it('PRODUCTION_AUTHENTICATED_MAINTAIN_RELATIONS = 0', () => {
      // Live-verified against Production at ceiling 193. MAINTAIN is a real
      // PostgreSQL 17 table privilege conferred by GRANT ALL ON TABLES; a
      // clean replay carried 68 of these before M194. It is part of the
      // contract, never an ignored privilege.
      const maintain = (role: string) =>
        surface.tuples.filter((t) => t.startsWith(`RELATION|${role}|`) && t.endsWith('|MAINTAIN'));
      expect(maintain('authenticated')).toEqual([]);
      expect(maintain('anon')).toEqual([]);
      expect(CONTRACT.anchors.authenticated_maintain_relations).toBe(0);
      expect(CONTRACT.anchors.anon_maintain_relations).toBe(0);
      // service_role legitimately keeps it — trusted server identity.
      expect(maintain('service_role')).toHaveLength(82);
      expect(CONTRACT.anchors.service_role_maintain_relations).toBe(82);
    });

    it('the contract actually CONTAINS MAINTAIN tuples — it is not silently absent', () => {
      // Guards against the exact defect this contract version corrects: a
      // normalization that simply never queries MAINTAIN would also produce
      // "authenticated MAINTAIN = 0" and look identical to a real convergence.
      expect(CONTRACT.normalization.relation_privileges).toContain('MAINTAIN');
      expect(CONTRACT.sets.relation.filter((t: string) => t.endsWith('|MAINTAIN')).length)
        .toBeGreaterThan(0);
      expect(CONTRACT.normalization).not.toHaveProperty('excluded_from_contract');
    });

    it('AUTHENTICATED_PUBLIC_SEQUENCE_PRIVILEGES = {}', () => {
      expect(tuplesOfKind(surface.tuples, 'SEQUENCE', 'authenticated')).toEqual([]);
    });

    it('ANON_PUBLIC_RELATION_PRIVILEGES = {} and ANON_PUBLIC_SEQUENCE_PRIVILEGES = {}', () => {
      expect(tuplesOfKind(surface.tuples, 'RELATION', 'anon')).toEqual([]);
      expect(tuplesOfKind(surface.tuples, 'SEQUENCE', 'anon')).toEqual([]);
    });

    it('AUTHENTICATED_STOCK_DIRECT_WRITES = {}', () => {
      const stock = [
        'item_availability', 'item_availability_movements', 'warehouse_stock',
        'warehouse_stock_movements', 'outlet_stock', 'outlet_stock_movements',
        'warehouse_quarantine_stock', 'warehouse_quarantine_stock_movements',
        'warehouse_stock_in_transit',
      ];
      expect(authenticatedWrites(surface.tuples).filter((w) => stock.includes(w.split('|')[0]))).toEqual([]);
    });

    it('AUTHENTICATED_INTER_ORG_LIFECYCLE_DIRECT_WRITES = {}', () => {
      const lifecycle = [
        'inter_org_alert_events', 'inter_org_alert_states',
        'inter_org_exchange_events', 'inter_org_exchange_requests',
      ];
      expect(authenticatedWrites(surface.tuples).filter((w) => lifecycle.includes(w.split('|')[0]))).toEqual([]);
    });

    it('AUTHENTICATED_RBAC_DIRECT_WRITES = {}', () => {
      const rbac = [
        'profiles', 'permission_keys', 'role_permission_defaults',
        'profile_permission_overrides', 'profile_scope_assignments',
        'user_identity_history', 'audit_logs',
      ];
      expect(authenticatedWrites(surface.tuples).filter((w) => rbac.includes(w.split('|')[0]))).toEqual([]);
    });

    it('the manual availability writers are closed to authenticated and open to service_role', () => {
      for (const w of MANUAL_AVAILABILITY_WRITERS) {
        const name = w.slice(0, w.indexOf('('));
        const authTuples = tuplesOfKind(surface.tuples, 'FUNCTION', 'authenticated')
          .filter((t) => t.split('|')[2].startsWith(name + '('));
        expect(authTuples, `${name} must not be executable by authenticated`).toEqual([]);
        const svcTuples = tuplesOfKind(surface.tuples, 'FUNCTION', 'service_role')
          .filter((t) => t.split('|')[2].startsWith(name + '('));
        expect(svcTuples, `${name} must remain executable by service_role`).toHaveLength(1);
      }
    });
  });
});

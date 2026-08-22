/**
 * 194 · AUTHORIZATION SURFACE REPRODUCIBILITY CONVERGENCE — real disposable rig.
 *
 * Proves, against a live PostgreSQL replay of the canonical chain:
 *
 *   §24  CLEAN REPLAY — 001→193 carries exactly the 186-tuple H-24/H-25
 *        residual; M194 removes exactly those 186 and nothing else, landing on
 *        the Production authorization contract with EXACT set equality.
 *   §23  PRODUCTION-SHAPED NO-OP — in an environment shaped like current
 *        Production (already hardened), M194 produces an EMPTY effective
 *        authorization delta. It neither revokes anything Production has nor
 *        grants anything Production lacks.
 *   §30  NEGATIVE CONTROLS — the baseline contract is non-vacuous: it fails,
 *        with the offending tuples named, when a forbidden write is restored
 *        (A), when a manual writer is reopened (B), and when the platform
 *        baseline is deficient (C); and passes only on the correct build (D).
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRig, rigAvailable, bootstrapSource, MIGRATIONS_DIR } from '../../../tools/pg-rig/rig.mjs';
import {
  readAuthorizationSurface, setDifference, tuplesOfKind, objectsOf,
  authenticatedWrites, MANUAL_AVAILABILITY_WRITERS, type AuthorizationSurface,
} from './helpers/authorization-surface';

vi.setConfig({ testTimeout: 300000, hookTimeout: 300000 });

const ROOT = join(__dirname, '../../../');
const M194_SQL = readFileSync(
  join(MIGRATIONS_DIR, '194_phoenix_authorization_surface_reproducibility_convergence.sql'), 'utf8');
const CONTRACT = JSON.parse(
  readFileSync(join(ROOT, 'tools/pg-rig/production-authorization-baseline-v194.json'), 'utf8'));
const CONTRACT_TUPLES: string[] = [
  ...CONTRACT.sets.schema, ...CONTRACT.sets.relation,
  ...CONTRACT.sets.sequence, ...CONTRACT.sets.function,
].sort();

const WRITE_PRIVS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
const run = rigAvailable() ? describe : describe.skip;

const maintainRelations = (s: AuthorizationSurface, role: string): string[] =>
  s.tuples.filter((t) => t.startsWith(`RELATION|${role}|`) && t.endsWith('|MAINTAIN'));

const surfaceOf = (rig: any): Promise<AuthorizationSurface> =>
  rig.asAdmin((c: any) => readAuthorizationSurface((sql, params) => c.query(sql, params)));

/**
 * Run ONE statement as a genuine `authenticated` session and require Postgres
 * to refuse it. Each statement gets its OWN transaction: a failed statement
 * aborts the surrounding transaction, so batching them would make every
 * statement after the first report "current transaction is aborted" instead of
 * the permission error under test. The ROLLBACK is in a `finally` so the
 * pooled connection is never handed back mid-abort.
 */
const expectDeniedAsAuthenticated = async (rig: any, sql: string): Promise<void> => {
  await rig.asAdmin(async (c: any) => {
    await c.query('BEGIN');
    try {
      await c.query('SET LOCAL ROLE authenticated');
      await expect(c.query(sql), sql).rejects.toThrow(/permission denied/i);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
    }
  });
};

// ===========================================================================
// §24 — CLEAN REPLAY
// ===========================================================================
run('194 · dynamic · clean replay 001→193 then M194', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let before: AuthorizationSurface;
  let after: AuthorizationSurface;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 193 });
    before = await surfaceOf(rig);
    await rig.asAdmin((c: any) => c.query(M194_SQL));
    after = await surfaceOf(rig);
  }, 300000);

  afterAll(async () => { await rig?.end(); });

  it('the pre-M194 replay is MORE permissive than Production by exactly 252 relation tuples', () => {
    const extra = setDifference(before.tuples, CONTRACT_TUPLES);
    const missing = setDifference(CONTRACT_TUPLES, before.tuples);
    expect(missing, 'the H-23 bootstrap correction must already close every under-grant').toEqual([]);

    // 184 data-write tuples over 46 relations plus 68 MAINTAIN tuples — the
    // whole H-25 legacy excess and nothing else. Decomposed per privilege so a
    // change in ANY component is named rather than hidden behind a total.
    const relExtra = extra.filter((t) => t.startsWith('RELATION|authenticated|'));
    const byPriv: Record<string, number> = {};
    for (const t of relExtra) { const p = t.split('|')[3]; byPriv[p] = (byPriv[p] ?? 0) + 1; }

    expect(byPriv).toEqual({
      INSERT: 15, UPDATE: 15, DELETE: 16,
      TRUNCATE: 46, REFERENCES: 46, TRIGGER: 46,
      MAINTAIN: 68,
    });
    expect(relExtra).toHaveLength(252);
    expect(extra).toHaveLength(252);
    expect(relExtra.every((t) => WRITE_PRIVS.includes(t.split('|')[3]))).toBe(true);
    expect(relExtra.some((t) => t.endsWith('|SELECT')), 'SELECT is never excess').toBe(false);
  });

  it('H24_FUNCTION_EXECUTE_RESIDUAL_PRE_M194 = {} — migration 085 already closed it', () => {
    // H-24 was a rig REPLAY-POLICY fidelity defect: Production applied 085,
    // the rig skipped it. With the skip retired the two writer grants are gone
    // BEFORE 194 runs, so 194's own REVOKEs are an idempotent reassertion.
    const fnExtra = setDifference(before.tuples, CONTRACT_TUPLES)
      .filter((t) => t.startsWith('FUNCTION|'));
    expect(fnExtra).toEqual([]);

    for (const w of MANUAL_AVAILABILITY_WRITERS) {
      const name = w.slice(0, w.indexOf('('));
      const authExec = tuplesOfKind(before.tuples, 'FUNCTION', 'authenticated')
        .filter((t) => t.split('|')[2].startsWith(name + '('));
      expect(authExec, `${name} must already be closed at ceiling 193`).toEqual([]);
    }
    // …and the count already matches Production before 194.
    expect(tuplesOfKind(before.tuples, 'FUNCTION', 'authenticated')).toHaveLength(219);
  });

  it('the pre-M194 replay carries 68 authenticated MAINTAIN relations; Production has 0', () => {
    // The correction that made this contract version necessary. MAINTAIN is
    // conferred by GRANT ALL ON TABLES, so the platform provisioning default
    // handed it to `authenticated` on every pre-109 table, and no historical
    // REVOKE list ever named it.
    expect(maintainRelations(before, 'authenticated')).toHaveLength(68);
    expect(maintainRelations(before, 'anon')).toHaveLength(0);
    expect(maintainRelations(before, 'service_role')).toHaveLength(82);
  });

  it('the pre-M194 excess includes the RBAC and audit tables — the reason this matters', () => {
    const extraWrites = setDifference(before.tuples, CONTRACT_TUPLES)
      .filter((t) => t.startsWith('RELATION|authenticated|'))
      .map((t) => t.split('|')[2]);
    for (const rbac of ['profiles', 'permission_keys', 'role_permission_defaults',
                        'profile_permission_overrides', 'audit_logs']) {
      expect(extraWrites, `${rbac} must be among the pre-M194 over-grants`).toContain(rbac);
    }
  });

  it('M194 achieves EXACT SET EQUALITY with the Production contract, both directions', () => {
    expect(setDifference(after.tuples, CONTRACT_TUPLES)).toEqual([]); // RIG_MINUS_PRODUCTION
    expect(setDifference(CONTRACT_TUPLES, after.tuples)).toEqual([]); // PRODUCTION_MINUS_RIG
  });

  it('M194 removed exactly the 252 residual tuples and added nothing', () => {
    const removed = setDifference(before.tuples, after.tuples);
    const added = setDifference(after.tuples, before.tuples);
    expect(removed).toHaveLength(252);
    expect(added).toEqual([]);
    expect(removed.sort()).toEqual(setDifference(before.tuples, CONTRACT_TUPLES).sort());
    // Every removal is a relation privilege: the writer REVOKEs are no-ops
    // here because 085 already performed them.
    expect(removed.every((t) => t.startsWith('RELATION|authenticated|'))).toBe(true);
  });

  it('M194 drives authenticated MAINTAIN to zero and leaves the other roles alone', () => {
    expect(maintainRelations(after, 'authenticated')).toEqual([]);
    expect(maintainRelations(after, 'anon')).toEqual([]);
    // service_role is the trusted server identity; Production grants it and
    // M194 must not touch it.
    expect(maintainRelations(after, 'service_role')).toHaveLength(82);
    expect(maintainRelations(after, 'service_role')).toEqual(maintainRelations(before, 'service_role'));
  });

  it('the authenticated SELECT surface is untouched', () => {
    const sel = (s: AuthorizationSurface) =>
      tuplesOfKind(s.tuples, 'RELATION', 'authenticated').filter((t) => t.endsWith('|SELECT')).sort();
    expect(sel(after)).toEqual(sel(before));
    expect(sel(after)).toHaveLength(75);
  });

  it('anon and service_role surfaces are untouched', () => {
    for (const role of ['anon', 'service_role']) {
      const of = (s: AuthorizationSurface) => s.tuples.filter((t) => t.split('|')[1] === role).sort();
      expect(of(after), `${role} must be unchanged`).toEqual(of(before));
    }
    expect(tuplesOfKind(after.tuples, 'FUNCTION', 'service_role')).toHaveLength(315);
    expect(tuplesOfKind(after.tuples, 'FUNCTION', 'anon')).toHaveLength(7);
  });

  it('authenticated function EXECUTE is already 219 before 194 and stays 219 after', () => {
    // It used to read 221 → 219 here, because the rig skipped migration 085.
    // With 085 replayed as Production actually applied it, the rig matches
    // Production's 219 at ceiling 193 and 194 changes no function privilege.
    expect(tuplesOfKind(before.tuples, 'FUNCTION', 'authenticated')).toHaveLength(219);
    expect(tuplesOfKind(after.tuples, 'FUNCTION', 'authenticated')).toHaveLength(219);
  });

  it('the authenticated direct-write surface is exactly the contracted four tuples', () => {
    expect(authenticatedWrites(after.tuples)).toEqual([
      'distribution_points|INSERT', 'distribution_points|UPDATE',
      'organizations|INSERT', 'organizations|UPDATE',
    ]);
  });

  it('default privileges and role attributes are untouched — 109 still owns them', () => {
    expect(after.default_acl).toEqual(before.default_acl);
    expect(after.role_attributes).toEqual(before.role_attributes);
  });

  it('M193 function bodies, security and search_path are untouched', async () => {
    const r = await rig.asAdmin((c: any) => c.query(`
      SELECT p.proname, md5(p.prosrc) AS body_md5, p.prosecdef,
             COALESCE(array_to_string(p.proconfig, ','), '') AS cfg
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN (
         'phoenix_refresh_inter_org_alert_lifecycle',
         'phoenix_get_live_inter_institution_alerts_with_state',
         'phoenix_get_live_inter_institution_alerts_with_state_page')
       ORDER BY 1`));
    expect(r.rows.map((x: any) => [x.proname, x.body_md5, x.prosecdef, x.cfg])).toEqual([
      ['phoenix_get_live_inter_institution_alerts_with_state', '69104e1646a2e0203de6e2789ba54c7e', true, 'search_path=public, pg_temp'],
      ['phoenix_get_live_inter_institution_alerts_with_state_page', 'bf2b2295c55b4bc0a5dae074353250a3', true, 'search_path=public, pg_temp'],
      ['phoenix_refresh_inter_org_alert_lifecycle', 'a203286cb5c0075a4942b1307207076b', true, 'search_path=public, pg_temp'],
    ]);
  });

  it('the manual availability writers keep their bodies, owner, search_path and secdef', async () => {
    const r = await rig.asAdmin((c: any) => c.query(`
      SELECT p.proname, md5(p.prosrc) AS body_md5, p.prosecdef,
             pg_get_userbyid(p.proowner) AS owner,
             COALESCE(array_to_string(p.proconfig, ','), '') AS cfg
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('phoenix_upsert_availability','phoenix_apply_availability_movement')
       ORDER BY 1`));
    expect(r.rows).toEqual([
      { proname: 'phoenix_apply_availability_movement', body_md5: '1229dfd36bebaac947f65c1852a9912d',
        prosecdef: true, owner: 'postgres', cfg: 'search_path=public, pg_temp' },
      { proname: 'phoenix_upsert_availability', body_md5: 'cf66c61734c5d1ecc2f54822efbb56ed',
        prosecdef: true, owner: 'postgres', cfg: 'search_path=public' },
    ]);
  });

  it('behavioural proof: a real authenticated session cannot reach a forbidden write', async () => {
    for (const stmt of [
      'TRUNCATE TABLE public.permission_keys CASCADE',
      'DELETE FROM public.role_permission_defaults',
      "INSERT INTO public.audit_logs (actor_role, action, entity_type) VALUES ('x','y','z')",
      'UPDATE public.profiles SET full_name = full_name',
      'TRUNCATE TABLE public.item_availability CASCADE',
    ]) {
      await expectDeniedAsAuthenticated(rig, stmt);
    }
  });

  it('behavioural proof: an authenticated session cannot call either manual writer', async () => {
    await expectDeniedAsAuthenticated(rig,
      `SELECT public.phoenix_apply_availability_movement(
         '00000000-0000-0000-0000-000000000001'::uuid, 'set', 1, 'r', 'n')`);
    await expectDeniedAsAuthenticated(rig,
      `SELECT public.phoenix_upsert_availability(
         '00000000-0000-0000-0000-000000000001'::uuid, 's', 't', 'd', 'c', 1, 'good',
         NULL::date, 'b', 'n', 'sup', 1.0, 'nc')`);
  });

  it('behavioural proof: the authenticated READ surface still works', async () => {
    await rig.asAdmin(async (c: any) => {
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL ROLE authenticated');
        // SELECT must be unaffected by M194 — this is the surface it preserves.
        await expect(c.query('SELECT count(*) FROM public.organizations')).resolves.toBeTruthy();
        await expect(c.query('SELECT count(*) FROM public.distribution_points')).resolves.toBeTruthy();
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
      }
    });
  });

  it('M194 is idempotent — applying it again changes nothing', async () => {
    await rig.asAdmin((c: any) => c.query(M194_SQL));
    const twice = await surfaceOf(rig);
    expect(setDifference(twice.tuples, after.tuples)).toEqual([]);
    expect(setDifference(after.tuples, twice.tuples)).toEqual([]);
  });
});

// ===========================================================================
// §23 — PRODUCTION-SHAPED NO-OP
// ===========================================================================
run('194 · dynamic · Production-shaped environment accepts M194 as a no-op', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let shaped: AuthorizationSurface;
  let afterM194: AuthorizationSurface;

  beforeAll(async () => {
    rig = await buildRig({ upTo: 193 });

    // Shape the environment to current Production using statements derived
    // from the CONTRACT, never from M194's own text — otherwise M194 would be
    // checking itself. Anything the contract does not grant `authenticated`
    // gets revoked here, exactly as Production's manual hardening did.
    await rig.asAdmin(async (c: any) => {
      const pre = await readAuthorizationSurface((sql, p) => c.query(sql, p));
      for (const t of setDifference(pre.tuples, CONTRACT_TUPLES)) {
        const [kind, role, object, priv] = t.split('|');
        if (kind === 'RELATION') {
          await c.query(`REVOKE ${priv} ON TABLE public."${object}" FROM ${role}`);
        } else if (kind === 'FUNCTION') {
          await c.query(`REVOKE EXECUTE ON FUNCTION public."${object.slice(0, object.indexOf('('))}"(${
            object.slice(object.indexOf('(') + 1, -1)}) FROM ${role}`);
        }
      }
    });

    shaped = await surfaceOf(rig);
    await rig.asAdmin((c: any) => c.query(M194_SQL));
    afterM194 = await surfaceOf(rig);
  }, 300000);

  afterAll(async () => { await rig?.end(); });

  it('the shaped environment really is the Production authorization shape', () => {
    expect(setDifference(shaped.tuples, CONTRACT_TUPLES)).toEqual([]);
    expect(setDifference(CONTRACT_TUPLES, shaped.tuples)).toEqual([]);
  });

  it('M194 applies successfully — its preconditions do NOT require the excess to exist', () => {
    expect(afterM194.tuples.length).toBe(shaped.tuples.length);
  });

  it('M194_EFFECT_ON_CURRENT_PRODUCTION = NO_EFFECTIVE_AUTHORIZATION_DELTA', () => {
    const revoked = setDifference(shaped.tuples, afterM194.tuples);
    const granted = setDifference(afterM194.tuples, shaped.tuples);
    expect(revoked, 'M194 must not revoke anything Production currently has').toEqual([]);
    expect(granted, 'M194 must not grant anything Production currently lacks').toEqual([]);
  });

  it('default privileges and role attributes are equally unaffected', () => {
    expect(afterM194.default_acl).toEqual(shaped.default_acl);
    expect(afterM194.role_attributes).toEqual(shaped.role_attributes);
  });
});

// ===========================================================================
// §30 — NEGATIVE CONTROLS
// ===========================================================================
run('194 · dynamic · negative controls prove the baseline contract is non-vacuous', () => {
  /** The contract comparison, exactly as the durable baseline test performs it. */
  const compare = (s: AuthorizationSurface) => ({
    EXTRA_IN_RIG: setDifference(s.tuples, CONTRACT_TUPLES),
    MISSING_FROM_RIG: setDifference(CONTRACT_TUPLES, s.tuples),
  });
  const passes = (s: AuthorizationSurface) => {
    const { EXTRA_IN_RIG, MISSING_FROM_RIG } = compare(s);
    return EXTRA_IN_RIG.length === 0 && MISSING_FROM_RIG.length === 0;
  };

  it('CONTROL D · correct bootstrap + 001→194 PASSES exact equality', async () => {
    const rig = await buildRig({ upTo: 194 });
    try {
      const s = await surfaceOf(rig);
      expect(compare(s).EXTRA_IN_RIG).toEqual([]);
      expect(compare(s).MISSING_FROM_RIG).toEqual([]);
      expect(passes(s)).toBe(true);
    } finally { await rig.end(); }
  }, 300000);

  it('CONTROL A · restoring one forbidden authenticated table write FAILS, and names it', async () => {
    const rig = await buildRig({ upTo: 194 });
    try {
      expect(passes(await surfaceOf(rig))).toBe(true);
      // The control mutation lives ONLY here, in a disposable database.
      await rig.asAdmin((c: any) =>
        c.query('GRANT INSERT ON TABLE public.role_permission_defaults TO authenticated'));

      const s = await surfaceOf(rig);
      const { EXTRA_IN_RIG, MISSING_FROM_RIG } = compare(s);
      expect(passes(s), 'the contract must FAIL on an over-grant').toBe(false);
      expect(EXTRA_IN_RIG).toEqual(['RELATION|authenticated|role_permission_defaults|INSERT']);
      expect(MISSING_FROM_RIG).toEqual([]);
    } finally { await rig.end(); }
  }, 300000);

  it('CONTROL A-MAINTAIN · restoring one authenticated MAINTAIN FAILS, and names it', async () => {
    // The contract must be non-vacuous for MAINTAIN specifically — this is the
    // privilege the first draft of this contract omitted entirely, so a control
    // that only covered the six data-write privileges would have passed while
    // the gap was open.
    const rig = await buildRig({ upTo: 194 });
    try {
      expect(passes(await surfaceOf(rig))).toBe(true);
      // Control mutation, disposable database only.
      await rig.asAdmin((c: any) =>
        c.query('GRANT MAINTAIN ON TABLE public.permission_keys TO authenticated'));

      const s = await surfaceOf(rig);
      const { EXTRA_IN_RIG, MISSING_FROM_RIG } = compare(s);
      expect(passes(s), 'the contract must FAIL on a restored MAINTAIN').toBe(false);
      expect(EXTRA_IN_RIG).toEqual(['RELATION|authenticated|permission_keys|MAINTAIN']);
      expect(MISSING_FROM_RIG).toEqual([]);

      // Remove the synthetic mutation and confirm the contract passes again —
      // proving the failure was caused by the control and nothing else.
      await rig.asAdmin((c: any) =>
        c.query('REVOKE MAINTAIN ON TABLE public.permission_keys FROM authenticated'));
      expect(passes(await surfaceOf(rig))).toBe(true);
    } finally { await rig.end(); }
  }, 300000);

  it('CONTROL B · reopening a manual availability writer FAILS, and names it', async () => {
    const rig = await buildRig({ upTo: 194 });
    try {
      expect(passes(await surfaceOf(rig))).toBe(true);
      await rig.asAdmin((c: any) => c.query(`
        GRANT EXECUTE ON FUNCTION public.phoenix_upsert_availability(
          uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text
        ) TO authenticated`));

      const s = await surfaceOf(rig);
      const { EXTRA_IN_RIG, MISSING_FROM_RIG } = compare(s);
      expect(passes(s), 'the contract must FAIL when a manual writer is reopened').toBe(false);
      expect(EXTRA_IN_RIG).toHaveLength(1);
      expect(EXTRA_IN_RIG[0]).toMatch(/^FUNCTION\|authenticated\|phoenix_upsert_availability\(/);
      expect(MISSING_FROM_RIG).toEqual([]);
    } finally { await rig.end(); }
  }, 300000);

  /**
   * Exactly the H-23 deficiency, reconstructed: strip the platform-initial
   * service_role FUNCTION default from the bootstrap. Because default ACLs are
   * not retroactive, every function created before migration 109 then loses
   * service_role EXECUTE.
   */
  const deficientBootstrap = (): string => {
    const deficient = bootstrapSource().replace(
      /^ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;$/m,
      '-- (negative control C: platform service_role FUNCTION default removed)',
    );
    expect(deficient, 'the control must actually change the bootstrap').not.toBe(bootstrapSource());
    return deficient;
  };

  it('CONTROL C · a deficient platform baseline FAILS the contract, with service_role signatures in MISSING_FROM_RIG', async () => {
    // Measured at ceiling 193 — i.e. the state the contract inherits — because
    // M194 itself refuses to run on this platform at all (asserted next).
    const rig = await buildRig({ upTo: 193, bootstrapSql: deficientBootstrap() });
    try {
      const s = await surfaceOf(rig);
      const { MISSING_FROM_RIG } = compare(s);
      expect(passes(s), 'the contract must FAIL on a deficient platform baseline').toBe(false);

      expect(MISSING_FROM_RIG.length).toBeGreaterThan(100);
      expect(
        MISSING_FROM_RIG.every((t) => t.startsWith('FUNCTION|service_role|')),
        'every under-grant must be a service_role function EXECUTE',
      ).toBe(true);
      // Reported as real signatures, not as a count.
      for (const t of MISSING_FROM_RIG.slice(0, 5)) {
        expect(t).toMatch(/^FUNCTION\|service_role\|\w+\(.*\)\|EXECUTE$/);
      }
      expect(tuplesOfKind(s.tuples, 'FUNCTION', 'service_role').length).toBeLessThan(315);
    } finally { await rig.end(); }
  }, 300000);

  it('CONTROL C · M194 additionally FAILS CLOSED rather than converging a deficient platform', async () => {
    // A migration that silently "succeeded" here would hide the platform
    // defect. M194's precondition catches it: service_role must still hold
    // EXECUTE on both manual writers before `authenticated` is revoked from
    // them, otherwise the revoke would orphan the function entirely.
    await expect(buildRig({ upTo: 194, bootstrapSql: deficientBootstrap() }))
      .rejects.toThrow(/M194 precondition failed: service_role must retain EXECUTE/);
  }, 300000);
});

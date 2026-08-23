/**
 * M198 — SECURITY DEFINER search_path CONVERGENCE — dynamic proof.
 *
 * Replays 001→197 onto a disposable database, measures the real catalog,
 * applies M198, and measures again. The migration's own VERIFY already proves
 * the convergence; what this suite adds is the measurement M198 cannot make
 * about itself — that the candidate population really is thirty on a faithful
 * replay of the canonical chain, that the identities are exactly the reviewed
 * ones, and that nothing else in the database moved.
 *
 * It also proves the two things a green migration could otherwise hide: that
 * re-running M198 REFUSES rather than silently no-opping, and that M197's
 * PUBLIC EXECUTE convergence survives untouched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

vi.setConfig({ testTimeout: 900_000, hookTimeout: 900_000 });
const run = rigAvailable() ? describe : describe.skip;

const SQL_198 = readFileSync(join(__dirname, '..', '198_phoenix_secdef_search_path_convergence.sql'), 'utf8');

const BEFORE_CFG = 'search_path=public';
const AFTER_CFG = 'search_path=public, pg_temp';

/** The exact thirty, as reviewed. Hard-coded so the suite cannot agree with
 *  whatever the database happens to contain. */
const THIRTY = [
  'public.archive_entity(text,uuid,text)',
  'public.create_qr_for_target(text,uuid,text)',
  'public.disable_qr_token(uuid,text)',
  'public.get_entity_purge_impact(text,uuid)',
  'public.get_public_qr_payload(text)',
  'public.phoenix_ack_platform_broadcast(uuid)',
  'public.phoenix_apply_manual_availability_movement_internal(uuid,text,integer,text,text)',
  'public.phoenix_clean_availability_data(boolean,text)',
  'public.phoenix_create_inter_org_exchange_request(text,uuid,uuid,uuid,integer,text,text)',
  'public.phoenix_create_platform_broadcast(text,text,text,text,uuid[],timestamp with time zone,timestamp with time zone)',
  'public.phoenix_deactivate_platform_broadcast(uuid)',
  'public.phoenix_delete_platform_broadcast(uuid,text)',
  'public.phoenix_get_dashboard_condition_counts(uuid)',
  'public.phoenix_get_institution_condition_counts()',
  'public.phoenix_get_inter_org_alert_events(text)',
  'public.phoenix_get_inter_org_exchange_events(uuid)',
  'public.phoenix_get_inter_org_exchange_requests(text,integer,integer)',
  'public.phoenix_get_pending_platform_broadcasts()',
  'public.phoenix_get_platform_broadcast_ack_status(uuid)',
  'public.phoenix_handle_new_user()',
  'public.phoenix_list_platform_broadcasts_admin()',
  'public.phoenix_my_org()',
  'public.phoenix_my_role()',
  'public.phoenix_reopen_inter_org_alert(text,text,text)',
  'public.phoenix_set_my_org_whatsapp_contact(boolean)',
  'public.phoenix_update_inter_org_alert_state(text,text,text,text)',
  'public.phoenix_update_inter_org_exchange_status(uuid,text,integer,integer,text,text)',
  'public.phoenix_update_my_whatsapp_phone(text)',
  'public.phoenix_upsert_availability(uuid,text,text,text,text,integer,text,date,text,text,text,numeric,text)',
  'public.purge_entity_with_all_data(text,uuid,text)',
].sort();

/** First-party = not extension-owned, exactly as migrations 194/197 scope it. */
const FIRST_PARTY = `
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.prosecdef
   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`;

const CENSUS_SQL = `
  SELECT p.oid::regprocedure::text AS sig,
         coalesce(array_to_string(p.proconfig, '; '), '') AS cfg,
         p.oid::text AS fn_oid,
         md5(p.prosrc) AS body_md5,
         pg_get_userbyid(p.proowner) AS owner,
         pg_get_function_result(p.oid) AS result_type,
         (SELECT coalesce(string_agg(coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC')||'='||a.privilege_type,
                                     ',' ORDER BY (coalesce(nullif(a.grantee::regrole::text,'-'),'PUBLIC')||'='||a.privilege_type) COLLATE "C"), '')
            FROM aclexplode(p.proacl) a) AS acl
  ${FIRST_PARTY}
  ORDER BY 1`;

const PUBLIC_EXECUTE_SQL = `
  SELECT count(*)::int AS n ${FIRST_PARTY}
     AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
                  WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')`;

type Row = { sig: string; cfg: string; fn_oid: string; body_md5: string; owner: string; result_type: string; acl: string };

/** `public.` is implicit in regprocedure output when public is on search_path. */
const qualify = (s: string) => (s.startsWith('public.') ? s : `public.${s}`);

run('M198 dynamic — search_path convergence over a real 001→197 replay', () => {
  let rig: any;
  let before: Row[];
  let after: Row[];

  beforeAll(async () => {
    rig = await buildRig({ upTo: 197 });
    before = (await rig.asAdmin((c: any) => c.query(CENSUS_SQL))).rows;
  });

  afterAll(async () => { if (rig) await rig.end(); });

  it('the replay reproduces the reviewed candidate set EXACTLY, in both directions', () => {
    const candidates = before.filter((r) => r.cfg === BEFORE_CFG).map((r) => qualify(r.sig)).sort();
    // Not count equality alone: the identities are compared as sets.
    expect(candidates.filter((s) => !THIRTY.includes(s))).toEqual([]); // replay minus reviewed
    expect(THIRTY.filter((s) => !candidates.includes(s))).toEqual([]); // reviewed minus replay
    expect(candidates).toEqual(THIRTY);
    expect(candidates).toHaveLength(30);
  });

  it('every other first-party SECURITY DEFINER routine is ALREADY on public, pg_temp', () => {
    // If some third search_path form existed, "converge onto public, pg_temp"
    // would be a claim about a state nobody had measured.
    const others = before.filter((r) => r.cfg !== BEFORE_CFG);
    expect(others.length).toBeGreaterThan(0);
    expect([...new Set(others.map((r) => r.cfg))]).toEqual([AFTER_CFG]);
  });

  it('none of the thirty resolves a temporary object, so reordering pg_temp is inert', async () => {
    const { rows } = await rig.asAdmin((c: any) => c.query(`
      SELECT p.oid::regprocedure::text AS sig ${FIRST_PARTY}
         AND p.proconfig = ARRAY['${BEFORE_CFG}']
         AND (p.prosrc ~* '\\mtemp(orary)?\\M' OR p.prosrc ~* '\\mpg_temp\\M')`));
    expect(rows).toEqual([]);
  });

  it('applies M198 and converges all thirty, leaving none on bare public', async () => {
    await rig.asAdmin((c: any) => c.query(SQL_198));
    after = (await rig.asAdmin((c: any) => c.query(CENSUS_SQL))).rows;

    expect(after.filter((r) => r.cfg === BEFORE_CFG)).toEqual([]);
    const converged = after.filter((r) => THIRTY.includes(qualify(r.sig)));
    expect(converged).toHaveLength(30);
    for (const r of converged) expect(r.cfg).toBe(AFTER_CFG);
  });

  it('leaves EVERY first-party SECURITY DEFINER routine on the same setting', () => {
    expect([...new Set(after.map((r) => r.cfg))]).toEqual([AFTER_CFG]);
    expect(after).toHaveLength(before.length);
  });

  it('moved nothing but search_path — OID, body, owner, result and ACL all hold', () => {
    const b = new Map(before.map((r) => [r.sig, r]));
    for (const a of after) {
      const prev = b.get(a.sig);
      expect(prev, `${a.sig} appeared from nowhere`).toBeDefined();
      expect(a.fn_oid).toBe(prev!.fn_oid);
      expect(a.body_md5).toBe(prev!.body_md5);
      expect(a.owner).toBe(prev!.owner);
      expect(a.result_type).toBe(prev!.result_type);
      expect(a.acl).toBe(prev!.acl);
    }
  });

  it('leaves M197 intact — no first-party SECURITY DEFINER routine regains PUBLIC EXECUTE', async () => {
    const { rows } = await rig.asAdmin((c: any) => c.query(PUBLIC_EXECUTE_SQL));
    expect(rows[0].n).toBe(0);
  });

  it('still answers real calls after the change', async () => {
    // A catalog assertion cannot show the routines still run. These are the
    // two helpers 127 RLS policies depend on, plus the anonymous QR entry point.
    const { rows } = await rig.asAdmin((c: any) => c.query(`
      SELECT public.phoenix_my_org() AS org,
             public.phoenix_my_role() AS role,
             public.get_public_qr_payload('M198NOSUCHTOKEN') AS qr`));
    // No authenticated JWT in this session, so the helpers return NULL and the
    // unknown token yields no payload — the point is that all three EXECUTE.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveProperty('org');
    expect(rows[0]).toHaveProperty('role');
    expect(rows[0]).toHaveProperty('qr');
  });

  it('REFUSES a second application rather than silently doing nothing', async () => {
    // A migration that quietly no-ops on re-run cannot distinguish "already
    // converged" from "converged something else"; M198 must fail closed.
    await expect(rig.asAdmin((c: any) => c.query(SQL_198)))
      .rejects.toThrow(/M198 PRECONDITION: search_path is not/);
  });
});

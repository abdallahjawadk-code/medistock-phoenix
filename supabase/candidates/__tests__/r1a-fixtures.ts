/**
 * Shared fixtures for the R1-a candidate dynamic suites (03 and later).
 * Real disposable PostgreSQL only (PHOENIX_RIG_PG); nothing here touches any shared database.
 * Chain: canonical 001..220 -> candidates in order -> synthetic seed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildRig } from '../../../tools/pg-rig/rig.mjs';

export const read = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

export const ORG = '00000000-0000-0000-0000-0000000c3001';        // owner PDA
export const ORG_OTHER = '00000000-0000-0000-0000-0000000c3002';  // another PDA
export const ORG_CARE = '00000000-0000-0000-0000-0000000c3003';   // care institution used as home (not a PDA)
export const ORG_BENE = '00000000-0000-0000-0000-0000000c3004';   // beneficiary hospital A
export const ORG_BENE_B = '00000000-0000-0000-0000-0000000c3005'; // beneficiary hospital B

export const U = {
  maker: '00000000-0000-0000-0000-0000000c3401',     // cwm, ORG: view, edit, manual_need.set
  maker2: '00000000-0000-0000-0000-0000000c3402',    // cwm, ORG: view, edit, manual_need.set (a second entrant)
  checker: '00000000-0000-0000-0000-0000000c3403',   // cwm, ORG: view, approve
  checker2: '00000000-0000-0000-0000-0000000c3404',  // cwm, ORG: view, approve
  viewer: '00000000-0000-0000-0000-0000000c3405',    // cwm, ORG: view
  saKeys: '00000000-0000-0000-0000-0000000c3406',    // super_admin, ORG: view, import, edit, approve, manual_need.set
  saOther: '00000000-0000-0000-0000-0000000c3407',   // super_admin, ORG_OTHER: all keys
  saNull: '00000000-0000-0000-0000-0000000c3408',    // super_admin, no home: all keys
  other: '00000000-0000-0000-0000-0000000c3409',     // cwm, ORG_OTHER: all keys
  susp: '00000000-0000-0000-0000-0000000c340a',      // cwm, ORG, suspended: all keys
  inst: '00000000-0000-0000-0000-0000000c340b',      // institution_admin, ORG: all keys
  setterNoView: '00000000-0000-0000-0000-0000000c340c', // cwm, ORG: manual_need.set only
} as const;

export interface Refusal { code: string; message: string; detail?: string }
export async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try { await p; } catch (e) {
    const err = e as { code?: string; message?: string; detail?: string };
    return { code: String(err.code), message: String(err.message), detail: err.detail };
  }
  throw new Error('expected the database to refuse this call, but it succeeded');
}

export type Rig = Awaited<ReturnType<typeof buildRig>>;

export function helpers(getRig: () => Rig) {
  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    getRig().asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));
  const as = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    getRig().asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows), { role, commit: true });
  /** Superuser transaction that impersonates a JWT subject; `replica` skips triggers (fixtures only). */
  const txAs = async (sub: string | null, fn: (q: (sql: string, p?: unknown[]) => Promise<any[]>) => Promise<void>, o: { replica?: boolean; commit?: boolean } = {}) => {
    await getRig().asAdmin(async (c: any) => {
      await c.query('BEGIN');
      try {
        if (o.replica) await c.query(`SET LOCAL session_replication_role = replica`);
        await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [sub ?? '']);
        await fn((sql, p = []) => c.query(sql, p).then((r: any) => r.rows));
        await c.query(o.commit === false ? 'ROLLBACK' : 'COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    });
  };
  const applyRefused = async (sql: string) => {
    try { await getRig().asAdmin((c: any) => c.query(sql)); } catch (e) {
      await getRig().asAdmin((c: any) => c.query('ROLLBACK')).catch(() => undefined);
      const err = e as { code?: string; message?: string };
      return { code: String(err.code), message: String(err.message) } as Refusal;
    }
    throw new Error('expected the candidate to be refused, but it applied');
  };
  return { admin, as, txAs, applyRefused };
}

/** Build the chain, apply the given candidate files in order (seeding between 01 and 02), seed orgs/users/keys. */
export async function buildWithCandidates(files: string[], seedAfter = 1): Promise<Rig> {
  const rig = await buildRig({ upTo: 220 });
  const seed = async () => {
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES
        ($1,'R1c Pharmacy Dept','دائرة','r1c-owner','pharmacy_department_authority',NULL),
        ($2,'R1c Other PDA','دائرة أخرى','r1c-other','pharmacy_department_authority',NULL),
        ($3,'R1c Care Home','مؤسسة','r1c-care','care_institution','hospital'),
        ($4,'R1c Hospital A','مستشفى أ','r1c-bene-a','care_institution','hospital'),
        ($5,'R1c Hospital B','مستشفى ب','r1c-bene-b','care_institution','hospital')`, [ORG, ORG_OTHER, ORG_CARE, ORG_BENE, ORG_BENE_B]);
      const ids = Object.values(U);
      await c.query(`INSERT INTO auth.users (id, email) SELECT x, 'r1c-'||substr(x::text,35)||'@rig' FROM unnest($1::uuid[]) x`, [ids]);
      const set = (u: string, role: string, org: string | null, status = 'active') =>
        c.query(`UPDATE profiles SET role=$2, status=$3, organization_id=$4 WHERE id=$1`, [u, role, status, org]);
      for (const u of [U.maker, U.maker2, U.checker, U.checker2, U.viewer, U.setterNoView]) await set(u, 'central_warehouse_manager', ORG);
      await set(U.saKeys, 'super_admin', ORG); await set(U.saOther, 'super_admin', ORG_OTHER); await set(U.saNull, 'super_admin', null);
      await set(U.other, 'central_warehouse_manager', ORG_OTHER); await set(U.susp, 'central_warehouse_manager', ORG, 'suspended');
      await set(U.inst, 'institution_admin', ORG);
      const grants: Array<[string, string[]]> = [
        [U.maker, ['view', 'edit']], [U.maker2, ['view', 'edit']], [U.checker, ['view', 'approve']], [U.checker2, ['view', 'approve']],
        [U.viewer, ['view']], [U.saKeys, ['view', 'import', 'edit', 'approve']], [U.saOther, ['view', 'import', 'edit', 'approve']],
        [U.saNull, ['view', 'import', 'edit', 'approve']], [U.other, ['view', 'import', 'edit', 'approve']],
        [U.susp, ['view', 'import', 'edit', 'approve']], [U.inst, ['view', 'import', 'edit', 'approve']],
      ];
      for (const [u, keys] of grants) for (const k of keys) {
        await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true)
          ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [u, `central_needs.${k}`]);
      }
    });
  };
  for (let i = 0; i < files.length; i += 1) {
    await rig.asAdmin((c: any) => c.query(read(files[i])));
    if (i + 1 === seedAfter) await seed();
  }
  if (seedAfter === 0) await seed();
  return rig;
}

/** After candidate 02 is applied, the manual key may be granted (registered, no defaults). */
export async function grantManualKey(rig: Rig, users: string[]) {
  await rig.asAdmin(async (c: any) => {
    for (const u of users) {
      await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,'central_needs.manual_need.set',true)
        ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [u]);
    }
  });
}

export const newItem = async (admin: ReturnType<typeof helpers>['admin'], unit = 'box', status = 'active') => {
  const id = randomUUID();
  await admin(`INSERT INTO central_items (id, name, name_ar, unit, status) VALUES ($1,$2,$2,$3,$4)`, [id, `R1c item ${id.slice(0, 8)}`, unit, status]);
  return id;
};

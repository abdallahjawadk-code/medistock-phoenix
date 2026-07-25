/**
 * MOVEMENT-WRITER-COMPLETENESS — DYNAMIC twin, against a real disposable
 * Postgres with 001->latest applied in order.
 *
 * The static guard parses files; this one asks the database what it actually
 * ended up with. Both must agree, and the runtime facts the static scan
 * cannot see (ACLs, search_path settings, prosecdef, the reason_code CHECK,
 * the event-capture triggers, and the "dead ledger" claim) are proven here.
 *
 * Gated on PHOENIX_RIG_PG; skipped in CI (no database).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import {
  REVIEWED_MOVEMENT_WRITERS,
  EXCLUDED_WRITERS,
  CONTRACT_LEDGERS,
  NON_CONTRACT_LEDGERS,
  isReviewedWriter,
  isExcludedWriter,
  reviewedWriter,
} from './helpers/reviewed-movement-writers';

const run = rigAvailable() ? describe : describe.skip;

interface PgWriter {
  proname: string;
  args: string;
  prosecdef: boolean;
  ledgers: string | null;
  config: string[] | null;
  acl: string | null;
}

run('movement-writer completeness — dynamic (pg_proc is the source of truth)', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let writers: PgWriter[] = [];
  const byName = new Map<string, PgWriter>();

  beforeAll(async () => {
    rig = await buildRig({});
    await rig.asAdmin(async (c: any) => {
      const all = [...CONTRACT_LEDGERS, ...NON_CONTRACT_LEDGERS];
      const res = await c.query(
        `SELECT p.proname,
                pg_get_function_identity_arguments(p.oid) AS args,
                p.prosecdef,
                (SELECT string_agg(l, ',' ORDER BY l) FROM unnest($1::text[]) l
                   WHERE p.prosrc ~* ('INSERT\\s+INTO\\s+(public\\.)?' || l || '\\M')) AS ledgers,
                p.proconfig AS config,
                array_to_string(p.proacl, ' ') AS acl
           FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace
            AND p.prokind = 'f'
            AND EXISTS (SELECT 1 FROM unnest($1::text[]) l
                         WHERE p.prosrc ~* ('INSERT\\s+INTO\\s+(public\\.)?' || l || '\\M'))
          ORDER BY p.proname`,
        [all],
      );
      writers = res.rows;
      for (const w of writers) byName.set(w.proname, w);
    });
  }, 120000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ── 1. The live set matches the registry, both directions ────────────────

  it('discovers writers at all (the query is not silently empty)', () => {
    expect(writers.length).toBeGreaterThanOrEqual(20);
  });

  it('every live ledger writer is either reviewed or explicitly excluded', () => {
    const unknown = writers
      .map(w => w.proname)
      .filter(n => !isReviewedWriter(n) && !isExcludedWriter(n))
      .sort();
    expect(unknown).toEqual([]);
  });

  it('every reviewed writer actually exists in the database', () => {
    const missing = REVIEWED_MOVEMENT_WRITERS.map(w => w.fn).filter(n => !byName.has(n)).sort();
    expect(missing).toEqual([]);
  });

  it('every excluded writer actually exists in the database', () => {
    const missing = EXCLUDED_WRITERS.map(w => w.fn).filter(n => !byName.has(n)).sort();
    expect(missing).toEqual([]);
  });

  it('the live contract-writer count equals the registry count', () => {
    const liveContract = writers.filter(w =>
      (w.ledgers ?? '').split(',').some(l => (CONTRACT_LEDGERS as string[]).includes(l)),
    );
    expect(liveContract.length).toBe(REVIEWED_MOVEMENT_WRITERS.length);
  });

  // ── 2. Runtime hardening the static scan cannot see ──────────────────────

  it('every reviewed writer is SECURITY DEFINER with search_path pinned to public,pg_temp', () => {
    for (const w of REVIEWED_MOVEMENT_WRITERS) {
      const live = byName.get(w.fn)!;
      expect(live.prosecdef, `${w.fn} prosecdef`).toBe(true);
      const cfg = (live.config ?? []).join(';');
      expect(cfg, `${w.fn} proconfig`).toMatch(/search_path=(")?public(")?,\s*(")?pg_temp(")?/);
    }
  });

  it('no reviewed writer is executable by PUBLIC or anon', () => {
    for (const w of REVIEWED_MOVEMENT_WRITERS) {
      const acl = byName.get(w.fn)!.acl ?? '';
      // A NULL/empty acl means owner-only default — also fine.
      expect(acl, `${w.fn} acl`).not.toMatch(/(^|\s)=X/);   // "=X/..." is the PUBLIC grant form
      expect(acl, `${w.fn} acl`).not.toMatch(/\banon=/);
    }
  });

  it('client-callable claims match the real ACL', () => {
    for (const w of REVIEWED_MOVEMENT_WRITERS) {
      const acl = byName.get(w.fn)!.acl ?? '';
      const granted = /\bauthenticated=/.test(acl);
      expect(granted, `${w.fn} clientCallable`).toBe(w.clientCallable);
    }
  });

  it('excluded writers are never granted to authenticated on a NON-contract ledger without review', () => {
    for (const w of EXCLUDED_WRITERS) {
      const live = byName.get(w.fn)!;
      const ledgers = (live.ledgers ?? '').split(',').filter(Boolean);
      // The exclusion is only valid while the function stays off contract ledgers.
      expect(ledgers.every(l => (NON_CONTRACT_LEDGERS as string[]).includes(l)), w.fn).toBe(true);
    }
  });

  // ── 3. The "dead ledger" exclusion is proven, not asserted ───────────────

  it('item_availability_movements has NONE of the contract columns', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='item_availability_movements'
            AND column_name IN ('reason_code','correlation_id','causation_id','occurred_at')`,
      );
      expect(r.rows.map((x: any) => x.column_name)).toEqual([]);
    });
  });

  it('item_availability_movements carries NO canonical event-capture trigger', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT t.tgname FROM pg_trigger t JOIN pg_class c2 ON c2.oid=t.tgrelid
          WHERE NOT t.tgisinternal AND c2.relname='item_availability_movements'
            AND t.tgname LIKE '%capture_movement%'`,
      );
      expect(r.rows).toEqual([]);
    });
  });

  it('each CONTRACT ledger DOES carry the contract columns and the event-capture trigger', async () => {
    await rig.asAdmin(async (c: any) => {
      for (const ledger of CONTRACT_LEDGERS) {
        const cols = await c.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema='public' AND table_name=$1
              AND column_name IN ('reason_code','correlation_id','causation_id','occurred_at')
            ORDER BY column_name`,
          [ledger],
        );
        expect(cols.rows.map((x: any) => x.column_name), ledger)
          .toEqual(['causation_id', 'correlation_id', 'occurred_at', 'reason_code']);

        const trg = await c.query(
          `SELECT t.tgname FROM pg_trigger t JOIN pg_class c2 ON c2.oid=t.tgrelid
            WHERE NOT t.tgisinternal AND c2.relname=$1 AND t.tgname LIKE '%capture_movement_posted%'`,
          [ledger],
        );
        expect(trg.rows.length, `${ledger} event-capture trigger`).toBe(1);
      }
    });
  });

  it('every contract ledger constrains reason_code to the closed vocabulary', async () => {
    await rig.asAdmin(async (c: any) => {
      for (const ledger of CONTRACT_LEDGERS) {
        const r = await c.query(
          `SELECT pg_get_constraintdef(con.oid) AS def
             FROM pg_constraint con JOIN pg_class c2 ON c2.oid=con.conrelid
            WHERE c2.relname=$1 AND con.contype='c'
              AND pg_get_constraintdef(con.oid) ILIKE '%reason_code%'`,
          [ledger],
        );
        expect(r.rows.length, `${ledger} reason_code CHECK`).toBeGreaterThanOrEqual(1);
        expect(r.rows[0].def).toContain("'dispensed'");
        expect(r.rows[0].def).toContain("'corrected'");
      }
    });
  });

  // ── 4. Registry metadata matches the live body ───────────────────────────

  it('every reviewed writer references reason_code and correlation_id in its live body', async () => {
    await rig.asAdmin(async (c: any) => {
      for (const w of REVIEWED_MOVEMENT_WRITERS) {
        const r = await c.query(
          `SELECT p.prosrc ~* 'reason_code' AS rc,
                  p.prosrc ~* 'correlation_id' AS corr,
                  p.prosrc ~* 'causation_id' AS caus
             FROM pg_proc p
            WHERE p.proname=$1 AND p.pronamespace='public'::regnamespace`,
          [w.fn],
        );
        expect(r.rows[0].rc, `${w.fn} reason_code`).toBe(true);
        expect(r.rows[0].corr, `${w.fn} correlation_id`).toBe(true);
        if (w.causation !== null) {
          expect(r.rows[0].caus, `${w.fn} causation_id`).toBe(true);
        }
      }
    });
  });

  it('the Group I writer found by this guard is genuinely fixed in the live database', async () => {
    await rig.asAdmin(async (c: any) => {
      const r = await c.query(
        `SELECT p.prosrc ~* 'reason_code' AS rc,
                p.prosrc ~* 'correlation_id' AS corr,
                p.prosrc ~* 'causation_id' AS caus
           FROM pg_proc p
          WHERE p.proname='phoenix_receive_outlet_return_shipment_line'
            AND p.pronamespace='public'::regnamespace`,
      );
      expect(r.rows[0]).toEqual({ rc: true, corr: true, caus: true });
      expect(reviewedWriter('phoenix_receive_outlet_return_shipment_line')!.group).toBe('I');

      const col = await c.query(
        `SELECT count(*)::int AS n FROM information_schema.columns
          WHERE table_schema='public' AND table_name='outlet_return_shipment_lines'
            AND column_name='source_movement_id'`,
      );
      expect(col.rows[0].n).toBe(1);
    });
  });

  // ── 5. Append-only audit history on every contract ledger ────────────────

  it('no contract ledger grants UPDATE or DELETE to authenticated (append-only)', async () => {
    await rig.asAdmin(async (c: any) => {
      for (const ledger of CONTRACT_LEDGERS) {
        const r = await c.query(
          `SELECT privilege_type FROM information_schema.role_table_grants
            WHERE table_schema='public' AND table_name=$1 AND grantee='authenticated'
              AND privilege_type IN ('UPDATE','DELETE')`,
          [ledger],
        );
        expect(r.rows.map((x: any) => x.privilege_type), ledger).toEqual([]);
      }
    });
  });

  it('no contract ledger grants anything to anon or PUBLIC', async () => {
    await rig.asAdmin(async (c: any) => {
      for (const ledger of CONTRACT_LEDGERS) {
        const r = await c.query(
          `SELECT grantee, privilege_type FROM information_schema.role_table_grants
            WHERE table_schema='public' AND table_name=$1 AND grantee IN ('anon','PUBLIC')`,
          [ledger],
        );
        expect(r.rows, ledger).toEqual([]);
      }
    });
  });
});

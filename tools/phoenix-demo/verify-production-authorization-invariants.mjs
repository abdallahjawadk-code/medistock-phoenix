#!/usr/bin/env node
// ===========================================================================
// PINNED PRODUCTION MIGRATION EXECUTOR — post-apply contract verification
// (READ-ONLY).
//
// Re-measures the authorization invariants Major H closed, on a FRESH
// connection after a Stage-I migration has been applied. These five facts are
// the security floor the whole platform stands on; no Stage-I migration is
// permitted to move any of them, so re-proving them after every apply turns a
// silent authorization regression into a failed workflow.
//
// The invariants (measured from Production, never assumed):
//   1. authenticated has NO EXECUTE on the write-capable hybrid alert RPC   (H-01)
//   2. authenticated has NO EXECUTE on the legacy alert paging wrapper      (H-02)
//   3. the inter-org alert refresh command is still SECURITY DEFINER        (H-07)
//   4. authenticated's direct relation-write surface is EXACTLY four tuples (M194)
//   5. anon holds NO privilege on any first-party public relation           (M192)
//
// This is a FIXED contract, not an operator-supplied one: the executor accepts
// no script path, no SQL, and no assertion text as input, so a dispatch cannot
// choose a weaker post-apply check than this one.
//
// Usage:
//   PHOENIX_PRODUCTION_DATABASE_URL=... \
//     node tools/phoenix-demo/verify-production-authorization-invariants.mjs
// ===========================================================================
import { buildRemoteIo } from '../pg-rig/remote-io.mjs';
import { PINNED_PROJECT_REF, assertProjectRefPinned } from './production-migration-contract.mjs';

const HYBRID_ALERT_RPC = 'public.phoenix_get_live_inter_institution_alerts_with_state(integer)';
const LEGACY_PAGE_WRAPPER = 'public.phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer)';
const REFRESH_COMMAND = 'public.phoenix_refresh_inter_org_alert_lifecycle(integer)';

const EXPECTED_AUTHENTICATED_WRITES = [
  'distribution_points INSERT',
  'distribution_points UPDATE',
  'organizations INSERT',
  'organizations UPDATE',
];

// Extension-owned relations are excluded exactly the way migration 194's own
// proof excludes them, so pgcrypto/pg_trgm can never widen or narrow a
// first-party measurement. $1 is the privilege-name array.
const RELATION_PRIVILEGE_SQL = `
  SELECT c.relname || ' ' || pr.p AS tuple
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (SELECT unnest($2::text[]) AS p) pr
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r','v','m','p','f')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
     AND has_table_privilege($1, c.oid, pr.p)
   ORDER BY 1`;

const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
const ALL_PRIVILEGES = ['SELECT', ...WRITE_PRIVILEGES];

async function main() {
  const connectionString = process.env.PHOENIX_PRODUCTION_DATABASE_URL;
  assertProjectRefPinned(connectionString, PINNED_PROJECT_REF);

  const failures = [];
  const fail = (m) => failures.push(m);

  const io = await buildRemoteIo({ connectionString });
  try {
    await io.asAdmin(async (c) => {
      // --- 1 & 2: the two revoked alert entry points -----------------------
      for (const [label, sig] of [
        ['hybrid alert RPC', HYBRID_ALERT_RPC],
        ['legacy alert paging wrapper', LEGACY_PAGE_WRAPPER],
      ]) {
        const r = await c.query(
          `SELECT has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') AS auth_exec`, [sig]);
        if (r.rows[0].auth_exec !== false) {
          fail(`H-01/H-02 REGRESSION: authenticated can EXECUTE the ${label} (${sig}).`);
        } else {
          console.log(`authenticated EXECUTE on ${label}: NO`);
        }
      }

      // --- 3: the refresh command must stay SECURITY DEFINER ---------------
      const sd = await c.query(`SELECT prosecdef FROM pg_proc WHERE oid = $1::regprocedure`, [REFRESH_COMMAND]);
      if (sd.rows.length !== 1) {
        fail(`H-07 REGRESSION: ${REFRESH_COMMAND} does not resolve to exactly one function.`);
      } else if (sd.rows[0].prosecdef !== true) {
        fail(`H-07 REGRESSION: ${REFRESH_COMMAND} is no longer SECURITY DEFINER.`);
      } else {
        console.log(`${REFRESH_COMMAND}: SECURITY DEFINER`);
      }

      // --- 4: authenticated's direct relation-write surface -----------------
      const writes = await c.query(RELATION_PRIVILEGE_SQL, ['authenticated', WRITE_PRIVILEGES]);
      const actualWrites = writes.rows.map((r) => r.tuple);
      if (JSON.stringify(actualWrites) !== JSON.stringify(EXPECTED_AUTHENTICATED_WRITES)) {
        fail(
          `M194 REGRESSION: authenticated direct-write surface is ${JSON.stringify(actualWrites)}, ` +
            `expected ${JSON.stringify(EXPECTED_AUTHENTICATED_WRITES)}.`,
        );
      } else {
        console.log('authenticated direct relation-write surface: exactly the contracted 4 tuples');
      }

      // --- 5: anon holds nothing on any first-party public relation ---------
      const anon = await c.query(RELATION_PRIVILEGE_SQL, ['anon', ALL_PRIVILEGES]);
      if (anon.rows.length !== 0) {
        fail(
          `M192 REGRESSION: anon holds ${anon.rows.length} first-party public relation privilege(s), expected none: ` +
            JSON.stringify(anon.rows.slice(0, 12).map((r) => r.tuple)),
        );
      } else {
        console.log('anon first-party public relation privileges: {}');
      }
    });
  } finally {
    await io.end();
  }

  if (failures.length > 0) {
    throw new Error(`Post-apply authorization contract FAILED:\n  - ${failures.join('\n  - ')}`);
  }
  console.log('Post-apply authorization contract PASS: all five Major-H invariants hold.');
}

main().catch((e) => {
  console.error(`::error::${e?.message ?? e}`);
  process.exitCode = 1;
});

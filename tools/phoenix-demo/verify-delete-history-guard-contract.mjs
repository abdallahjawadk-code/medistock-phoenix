#!/usr/bin/env node
// ===========================================================================
// READ-ONLY post-migration security verification for migration 147
// (SECURE-USER-DELETE-HISTORY-GUARD-147), run by deploy-admin-user-lifecycle
// AFTER migration 147 is confirmed applied (whether by this run or a prior
// one) and BEFORE either Edge Function is deployed.
//
// Independently re-asserts, from OUTSIDE the migration, exactly what
// 147_phoenix_secure_user_delete_history_guard.sql already asserts on apply:
//   - phoenix_profile_operational_blockers: SECURITY DEFINER, pinned
//     search_path, EXECUTE revoked from public/anon/authenticated (internal
//     helper only).
//   - phoenix_lifecycle_reserve: SECURITY DEFINER, pinned search_path,
//     EXECUTE granted to authenticated, NOT anon, NOT PUBLIC.
//   - phoenix_lifecycle_reserve's body actually contains the
//     USER_HAS_OPERATIONAL_HISTORY gate (proves the CREATE OR REPLACE from
//     147 is the one live in Production, not a stale pre-147 definition).
//   - Production's migration history highest version is exactly 147.
//
// Every assertion failure aborts the workflow before any Edge Function
// deploy step runs. No mutation of any kind.
//
// Usage:
//   PHOENIX_PRODUCTION_DATABASE_URL=... node tools/phoenix-demo/verify-delete-history-guard-contract.mjs
// ===========================================================================
import { buildRemoteIo } from '../pg-rig/remote-io.mjs';

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { reconcileMigrationHistory } from './production-migration-history.mjs';

// Production's history is NOT this repository's canonical numbering: it holds
// three-digit versions followed by 14-digit Supabase CLI timestamps. Casting
// `version::int` fails outright on a timestamp, so versions are read as TEXT
// and the canonical ceiling is RECONCILED. See production-migration-history.mjs.
function localManifest() {
  return readdirSync(join(process.cwd(), 'supabase', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((filename) => {
      const m = /^(\d{3})_/.exec(filename);
      return m ? { version: parseInt(m[1], 10), filename } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.version - b.version);
}

async function readCanonicalHistory(io) {
  let rows;
  await io.asAdmin(async (c) => {
    const r = await c.query(
      `SELECT version::text AS version, name::text AS name
         FROM supabase_migrations.schema_migrations
        ORDER BY version::text`);
    rows = r.rows;
  });
  return reconcileMigrationHistory(rows, localManifest());
}


async function main() {
  const io = await buildRemoteIo({ connectionString: process.env.PHOENIX_PRODUCTION_DATABASE_URL });
  try {
    await io.asAdmin(async (c) => {
      // Canonical ceiling, reconciled from Production's mixed version
      // namespaces — never `version::int`, which overflows on a timestamp.
      const reconciled = await readCanonicalHistory({ asAdmin: async (fn) => fn(c) });
      const highest = reconciled.canonicalCeiling;
      if (highest !== 147) {
        throw new Error(`Production canonical migration ceiling is ${highest}, expected exactly 147.`);
      }

      await c.query(`
        do $$
        declare
          v_blockers_oid regprocedure := 'public.phoenix_profile_operational_blockers(uuid)'::regprocedure;
          v_reserve_oid  regprocedure := 'public.phoenix_lifecycle_reserve(uuid,text,uuid)'::regprocedure;
          v_is_definer   boolean;
          v_config       text[];
          v_reserve_src  text;
        begin
          select p.prosecdef, p.proconfig into v_is_definer, v_config
          from pg_proc p where p.oid = v_blockers_oid;
          assert v_is_definer,
            'POST-DEPLOY VERIFY FAILED: phoenix_profile_operational_blockers must be SECURITY DEFINER';
          assert 'search_path=public, pg_temp' = any(v_config),
            'POST-DEPLOY VERIFY FAILED: phoenix_profile_operational_blockers search_path is not pinned';
          assert not has_function_privilege('authenticated', v_blockers_oid, 'EXECUTE'),
            'POST-DEPLOY VERIFY FAILED: authenticated can directly execute phoenix_profile_operational_blockers';
          assert not has_function_privilege('anon', v_blockers_oid, 'EXECUTE'),
            'POST-DEPLOY VERIFY FAILED: anon can execute phoenix_profile_operational_blockers';
          assert not exists (
            select 1 from pg_proc p
            cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where p.oid = v_blockers_oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'
          ), 'POST-DEPLOY VERIFY FAILED: PUBLIC can execute phoenix_profile_operational_blockers';

          select p.prosecdef, p.proconfig, pg_get_functiondef(p.oid)
            into v_is_definer, v_config, v_reserve_src
          from pg_proc p where p.oid = v_reserve_oid;
          assert v_is_definer,
            'POST-DEPLOY VERIFY FAILED: phoenix_lifecycle_reserve must be SECURITY DEFINER';
          assert 'search_path=public, pg_temp' = any(v_config),
            'POST-DEPLOY VERIFY FAILED: phoenix_lifecycle_reserve search_path is not pinned';
          assert has_function_privilege('authenticated', v_reserve_oid, 'EXECUTE'),
            'POST-DEPLOY VERIFY FAILED: authenticated must be able to execute phoenix_lifecycle_reserve';
          assert not has_function_privilege('anon', v_reserve_oid, 'EXECUTE'),
            'POST-DEPLOY VERIFY FAILED: anon must not execute phoenix_lifecycle_reserve';
          assert not exists (
            select 1 from pg_proc p
            cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
            where p.oid = v_reserve_oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'
          ), 'POST-DEPLOY VERIFY FAILED: PUBLIC can execute phoenix_lifecycle_reserve';
          assert v_reserve_src like '%USER_HAS_OPERATIONAL_HISTORY%',
            'POST-DEPLOY VERIFY FAILED: live phoenix_lifecycle_reserve body does not contain the USER_HAS_OPERATIONAL_HISTORY gate — migration 147 is not the version actually installed';

          raise notice 'SECURE-USER-DELETE-HISTORY-GUARD-147 post-deploy contract verified in Production.';
        end;
        $$;
      `);
    });
  } finally {
    await io.end();
  }
  console.log('Delete-history guard contract verified: safe to deploy admin-user-lifecycle and admin-recycle-user.');
}

main().catch((e) => {
  console.error(`::error::${e?.message ?? e}`);
  process.exitCode = 1;
});

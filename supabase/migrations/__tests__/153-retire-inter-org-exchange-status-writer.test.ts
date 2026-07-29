/**
 * RETIRE-INTER-ORG-EXCHANGE-STATUS-WRITER-153 — static contract.
 *
 * Migration 153 is a privilege-only retirement. It must fail closed on schema
 * or lifecycle drift, preserve the reviewed function byte-for-byte, and avoid
 * absorbing the separate repository-wide ACL reconciliation.
 */
import { describe, expect, it } from 'vitest';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';
import { excludedWriter } from './helpers/reviewed-movement-writers';
import { executableSql, stripSqlComments } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS = join(ROOT, 'supabase/migrations');
const NAME = '153_phoenix_retire_inter_org_exchange_status_writer.sql';
const TARGET = 'phoenix_update_inter_org_exchange_status';
const sql = readFileSync(join(MIGRATIONS, NAME), 'utf8').replace(/\r\n?/g, '\n');
const active = stripSqlComments(sql);
const executable = executableSql(sql);

function productionFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '__tests__' || entry.name === 'node_modules') return [];
    const path = join(root, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    return /\.(?:ts|tsx|js|jsx|mjs|cjs|sql)$/.test(entry.name) ? [path] : [];
  });
}

function containsProductionCall(source: string): boolean {
  return (
    /\brpc\s*\(\s*['"`]phoenix_update_inter_org_exchange_status['"`]/i.test(source)
    || /\b(?:select|perform|call)\s+(?:public\.)?phoenix_update_inter_org_exchange_status\s*\(/i.test(source)
    || /\b(?:from|join)\s+(?:public\.)?phoenix_update_inter_org_exchange_status\s*\(/i.test(source)
  );
}

describe('153 registration and exact scope', () => {
  it('is the one reviewed migration 153', () => {
    expect(REVIEWED_MIGRATION_FILES.filter(f => f.startsWith('153_'))).toEqual([NAME]);
  });

  it('is one explicit transaction and uses no ASSERT', () => {
    expect(active.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(active.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(executable).not.toMatch(/\bASSERT\b/i);
  });

  it('does not drop, wrap, replace, alter, or comment the legacy function', () => {
    expect(executable).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    expect(executable).not.toMatch(/\bCREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\b/i);
    expect(executable).not.toMatch(/\bALTER\s+FUNCTION\b/i);
    expect(executable).not.toMatch(/\bCOMMENT\s+ON\s+FUNCTION\b/i);
    expect(executable).not.toMatch(/\bGRANT\b/i);
  });

  it('contains no application DDL or DML', () => {
    expect(executable).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|POLICY|ROLE)\b/i);
    expect(executable).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(executable).not.toMatch(/\bUPDATE\s+public\./i);
    expect(executable).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(executable).not.toMatch(/\bTRUNCATE\b/i);
  });
});

describe('153 fail-closed lifecycle preflight', () => {
  it('requires one exact reviewed overload', () => {
    expect(active).toContain("p.proname = 'phoenix_update_inter_org_exchange_status'");
    expect(active).toContain('v_fn_count <> 1');
    expect(active).toContain(
      'public.phoenix_update_inter_org_exchange_status(uuid,text,integer,integer,text,text)',
    );
    expect(active).toContain('to_regprocedure(v_signature)');
  });

  it('derives all allowed statuses from the status-only CHECK', () => {
    expect(active).toContain("t.relname = 'inter_org_exchange_requests'");
    expect(active).toContain("a.attname = 'status'");
    expect(active).toContain("c.contype = 'c'");
    expect(active).toContain('c.conkey = ARRAY[a.attnum]::smallint[]');
    for (const status of [
      'requested',
      'source_approved',
      'source_rejected',
      'dispatched',
      'received',
      'completed',
      'cancelled',
    ]) {
      expect(active).toContain(`'${status}'`);
    }
  });

  it('derives terminal states from the active-request partial index', () => {
    expect(active).toContain(
      "i.relname = 'inter_org_exchange_requests_active_alert_key_uq'",
    );
    expect(active).toContain('pg_get_expr(x.indpred, x.indrelid, true)');
    expect(active).toContain('v_terminal_statuses IS DISTINCT FROM');
    expect(active).toContain('v_non_terminal_statuses IS DISTINCT FROM');
  });

  it('locks out a lifecycle race and refuses every derived non-terminal request', () => {
    expect(active).toContain(
      'LOCK TABLE public.inter_org_exchange_requests IN SHARE MODE',
    );
    expect(active).toContain('WHERE status = ANY(v_non_terminal_statuses)');
    expect(active).toContain('live legacy exchange request(s) remain');
  });
});

describe('153 owner-only ACL and preservation proof', () => {
  it('revokes all privileges from PUBLIC, anon, authenticated, and service_role', () => {
    expect(active).toMatch(
      /REVOKE ALL PRIVILEGES ON FUNCTION[\s\S]*?phoenix_update_inter_org_exchange_status[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/,
    );
  });

  it('rejects any remaining non-owner ACL and any inherited external execution', () => {
    expect(active).toContain("acl.privilege_type = 'EXECUTE'");
    expect(active).toContain('acl.grantee <> v_fn_owner');
    expect(active).toContain(
      "has_function_privilege(r.oid, v_fn_oid, 'EXECUTE')",
    );
    expect(active).toContain(
      "has_function_privilege(v_fn_owner, v_fn_oid, 'EXECUTE')",
    );
  });

  it('preserves body, full definition, SECURITY DEFINER, and search_path', () => {
    expect(active).toContain('md5(p.prosrc)');
    expect(active).toContain('md5(pg_get_functiondef(p.oid))');
    expect(active).toContain('v_body_hash_after IS DISTINCT FROM v_body_hash_before');
    expect(active).toContain(
      'v_definition_hash_after IS DISTINCT FROM v_definition_hash_before',
    );
    expect(active).toContain('NOT v_security_definer_before');
    expect(active).toContain("ARRAY['search_path=public']::text[]");
  });

  it('fingerprints tables, policies, permission data, role defaults, and transaction DML', () => {
    expect(active).toContain('v_table_schema_hash_after IS DISTINCT FROM');
    expect(active).toContain('v_policy_hash_after IS DISTINCT FROM');
    expect(active).toContain('v_permission_key_hash_after IS DISTINCT FROM');
    expect(active).toContain('v_role_default_hash_after IS DISTINCT FROM');
    expect(active).toContain('FROM pg_stat_xact_user_tables');
    expect(active).toContain('v_xact_dml_after IS DISTINCT FROM v_xact_dml_before');
  });

  it('updates only the existing excluded-writer rationale', () => {
    const reviewed = excludedWriter(TARGET);
    expect(reviewed?.ledger).toBe('item_availability_movements');
    expect(reviewed?.reason).toContain('Migration 153');
    expect(reviewed?.reason).toContain('owner-only');
  });
});

describe('153 has zero production caller', () => {
  it('has no React or Edge Function caller', () => {
    const files = [
      ...productionFiles(join(ROOT, 'src')),
      ...productionFiles(join(ROOT, 'supabase/functions')),
    ];
    const callers = files.filter(file =>
      containsProductionCall(readFileSync(file, 'utf8')),
    );
    expect(callers).toEqual([]);
  });

  it('has no later SQL caller before retirement', () => {
    const callers = readdirSync(MIGRATIONS)
      .filter(file => /^\d{3}_.*\.sql$/.test(file))
      .filter(file => {
        const number = Number(file.slice(0, 3));
        return number > 41 && number < 153;
      })
      .filter(file =>
        containsProductionCall(
          stripSqlComments(readFileSync(join(MIGRATIONS, file), 'utf8')),
        ),
      );
    expect(callers).toEqual([]);
  });
});

/**
 * REVOKE-MANUAL-AVAILABILITY-WRITERS-085 — static SQL contract tests.
 *
 * This migration is PREPARED, not applied (the disposable rig deliberately stops
 * at 084; 085 is proven to ABORT when applied without attestation). So there is
 * no dynamic proof file — these static assertions ARE the guard: it is
 * fail-closed, it revokes exactly the two manual quantity writers, it drops
 * nothing, and it requires the derived read (083) + visibility setter (084) to
 * be present.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';
import { stripSqlComments, executableSql } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const NAME = '085_phoenix_revoke_manual_availability_writers.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const active = stripSqlComments(sql);
const exec = executableSql(sql);

describe('registration and apply discipline', () => {
  it('is registered', () => expect(REVIEWED_MIGRATION_FILES).toContain(NAME));
  it('is manual-apply only', () => {
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
  });
  it('declares itself PREPARED / do-not-apply', () => {
    expect(sql).toMatch(/PREPARED[\s\S]*DO NOT APPLY|DO NOT APPLY|PREPARED only/);
  });
  it('is a single transaction', () => {
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });
});

describe('it is fail-closed on an explicit parity attestation', () => {
  it('aborts unless phoenix.availability_cutover_attested is true', () => {
    expect(active).toMatch(/current_setting\('phoenix\.availability_cutover_attested', true\)/);
    expect(active).toMatch(/RAISE EXCEPTION 'REFUSING TO APPLY 085/);
  });
  it('requires the 083 read projection and the 084 visibility setter to exist', () => {
    expect(active).toMatch(/phoenix_available_stock\(uuid\)'\) IS NULL/);
    expect(active).toMatch(/phoenix_set_availability_visibility\(uuid, boolean, text\)'\) IS NULL/);
  });
});

describe('it revokes exactly the two manual quantity writers, and only their client EXECUTE', () => {
  it('revokes EXECUTE from authenticated on phoenix_upsert_availability', () => {
    expect(active).toMatch(/REVOKE EXECUTE ON FUNCTION public\.phoenix_upsert_availability\([\s\S]*?\) FROM authenticated/);
  });
  it('revokes EXECUTE from authenticated on phoenix_apply_availability_movement', () => {
    expect(active).toMatch(/REVOKE EXECUTE ON FUNCTION public\.phoenix_apply_availability_movement\([\s\S]*?\) FROM authenticated/);
  });
  it('drops nothing (revoke, not drop — the guarded/internal bodies survive)', () => {
    expect(exec).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    expect(exec).not.toMatch(/\bDROP\s+TABLE\b/i);
  });
  it('does not touch the derived read or the visibility setter grants', () => {
    expect(exec).not.toMatch(/REVOKE[\s\S]*phoenix_available_stock/i);
    expect(exec).not.toMatch(/REVOKE[\s\S]*phoenix_set_availability_visibility/i);
  });
});

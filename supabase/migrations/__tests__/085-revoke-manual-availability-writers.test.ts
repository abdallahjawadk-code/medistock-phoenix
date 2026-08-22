/**
 * REVOKE-MANUAL-AVAILABILITY-WRITERS-085 — static SQL contract tests.
 *
 * These assertions pin the SOURCE: it is fail-closed behind an explicit
 * availability-cutover attestation, it revokes exactly the two manual quantity
 * writers, it drops nothing, and it requires the derived read (083) + the
 * visibility setter (084) to be present.
 *
 * NOTE ON APPLY STATUS — corrected by live Production verification. This file
 * previously said 085 was "PREPARED, not applied". That was WRONG.
 * Production's `supabase_migrations.schema_migrations` records version 085,
 * count 1, and the live functions carry 085's comments with `authenticated`
 * EXECUTE revoked. The three facts that actually hold are:
 *
 *   085_SOURCE_HEADER              = PREPARED_CUTOVER   (this file's text)
 *   085_PRODUCTION_HISTORY         = APPLIED_ONCE
 *   085_PRODUCTION_SECURITY_EFFECT = LIVE
 *
 * The canonical disposable rig therefore APPLIES 085, supplying the historical
 * attestation for that one apply — see
 * `085-canonical-replay-attested.dynamic.test.ts` for the behavioural proof
 * and for the fail-closed proof that the raw file still aborts without it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';
import { execFileSync } from 'child_process';
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


/**
 * H UNIT 2A — THE 085 STATUS CONTRACT (corrected by live Production evidence).
 *
 *   085_SOURCE_HEADER              = PREPARED_CUTOVER
 *   085_PRODUCTION_HISTORY         = APPLIED_ONCE
 *   085_PRODUCTION_SECURITY_EFFECT = LIVE
 *   M194_WRITER_REVOKES            = IDEMPOTENT_REASSERTION_OF_EXISTING_085_SECURITY_BOUNDARY
 *
 * An earlier revision of this suite asserted
 * `085_STATUS = PREPARED_ONLY_NOT_PRODUCTION_APPLIED`. A live read-only
 * inspection of Production disproved it: version 085 is recorded once, its
 * stored payload carries both writer REVOKEs, and the live functions show
 * `authenticated` EXECUTE = NO with `service_role` EXECUTE = YES.
 *
 * These assertions now guard against the OPPOSITE regression — that someone
 * reintroduces the false "never applied" claim, or re-adds a rig skip that
 * would make a clean replay diverge from Production's real migration history.
 */
describe('085 status contract — PREPARED source header, APPLIED in Production', () => {
  const M194_NAME = '194_phoenix_authorization_surface_reproducibility_convergence.sql';
  const m194 = readFileSync(join(ROOT, 'supabase/migrations', M194_NAME), 'utf8').replace(/\r\n?/g, '\n');
  const rig = readFileSync(join(ROOT, 'tools/pg-rig/rig.mjs'), 'utf8');
  const unwrap = (s: string): string => s.replace(/^\s*--\s?/gm, ' ').replace(/\s+/g, ' ');

  it('085 keeps its PREPARED cutover source header — history is not rewritten', () => {
    expect(sql).toMatch(/\*\*\*CUTOVER — PREPARED, DO NOT APPLY\*\*\*/);
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(active).toMatch(/RAISE EXCEPTION 'REFUSING TO APPLY 085/);
  });

  it('the canonical rig APPLIES 085 — it is no longer skipped', () => {
    expect(rig).not.toMatch(/PREPARED_ONLY_SKIP/);
    expect(rig).toMatch(/ATTESTED_CUTOVER_MIGRATIONS/);
    expect(rig).toContain(`['${NAME}', 'phoenix.availability_cutover_attested']`);
  });

  it('the rig supplies the attestation only around that apply, and resets it', () => {
    expect(rig).toMatch(/SET \$\{guc\} = 'true'/);
    expect(rig).toMatch(/RESET \$\{guc\}/);
    // The reset must be in a finally, so a failed apply cannot leave it live.
    expect(rig).toMatch(/finally\s*\{[\s\S]{0,220}RESET \$\{guc\}/);
  });

  it('194 records the corrected status contract and does NOT claim 085 was unapplied', () => {
    expect(m194).toContain('085_SOURCE_HEADER');
    expect(m194).toContain('PREPARED_CUTOVER');
    expect(m194).toContain('085_PRODUCTION_HISTORY');
    expect(m194).toContain('APPLIED_ONCE');
    expect(m194).toContain('085_PRODUCTION_SECURITY_EFFECT');
    expect(m194).toContain('M194_WRITER_REVOKES');
    expect(m194).toContain('IDEMPOTENT_REASSERTION_OF_EXISTING_085_SECURITY_BOUNDARY');

    // The retracted status tokens must not reappear.
    expect(m194).not.toContain('PREPARED_ONLY_NOT_PRODUCTION_APPLIED');
    expect(m194).not.toContain('SUPERSEDED_BY_M194');
    // …and the retraction itself is recorded, so the correction cannot be
    // quietly undone by someone who only reads this migration.
    expect(unwrap(m194)).toMatch(
      /earlier claim that 085 was .{0,40}never applied.{0,20} was FALSE and must not be reintroduced/i,
    );
  });

  it('194 still forbids re-applying 085 by hand', () => {
    expect(unwrap(m194)).toMatch(/MUST NOT READ THIS MIGRATION AS PERMISSION TO APPLY 085/i);
  });

  it('194 reasserts the same two writer revokes 085 established', () => {
    for (const fn of ['phoenix_upsert_availability', 'phoenix_apply_availability_movement']) {
      const revoke = new RegExp(String.raw`REVOKE EXECUTE ON FUNCTION public\.${fn}\(`);
      expect(active, `085 must still name ${fn}`).toMatch(revoke);
      expect(executableSql(m194), `194 must carry the ${fn} revoke`).toMatch(revoke);
    }
  });

  it('194 does NOT apply, invoke, or attest 085 itself', () => {
    expect(executableSql(m194)).not.toMatch(/availability_cutover_attested/);
    expect(executableSql(m194)).not.toMatch(/\\i\s|\bINCLUDE\b/i);
    expect(executableSql(m194)).not.toContain(NAME);
  });

  it('085 bytes are unchanged against the base commit', () => {
    const dirty = execFileSync(
      'git', ['-C', ROOT, 'status', '--porcelain=v1', '--', `supabase/migrations/${NAME}`],
      { encoding: 'utf8' },
    ).trim();
    expect(dirty, '085 is IMMUTABLE').toBe('');
  });
});

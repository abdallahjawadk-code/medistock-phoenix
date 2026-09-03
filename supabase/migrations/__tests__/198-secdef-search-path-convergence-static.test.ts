/**
 * M198 — SECURITY DEFINER search_path CONVERGENCE — static contract.
 *
 * Reads the migration as TEXT. The behavioural proof (real replay, real catalog
 * measurement, real calls) lives in the .dynamic suite; this file guards the
 * properties no runtime assertion can recover once the file is edited: that
 * M198 is search_path-only, that it touches exactly the reviewed thirty, and
 * that its own preconditions still refuse a database in any other state.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..');
const FILENAME = '198_phoenix_secdef_search_path_convergence.sql';
const SQL = readFileSync(join(MIGRATIONS, FILENAME), 'utf8');

/** Statement text with comments stripped, so prose can never satisfy a check. */
const CODE = SQL.replace(/--[^\n]*/g, ' ');

/**
 * The exact thirty, measured from a disposable replay of 001->197 and confirmed
 * by bidirectional set comparison against a live read-only Production
 * enumeration (replay-minus-production and production-minus-replay both empty).
 */
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
];

describe('M198 static — identity and placement', () => {
  it('is registered at 198, below the 202 ceiling, with no 203+ present', () => {
    // RAC-2 landed 199 (Command Center read contract) directly after this
    // migration, so 198 is no longer the newest file. It must still exist
    // exactly once, still sit at index 197, and 199 must be the ONLY thing
    // above it — a second unreviewed migration still fails this closed.
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    expect(files).toContain(FILENAME);
    expect(files.indexOf(FILENAME)).toBe(197);
    expect(files.slice(198)).toEqual([
      '199_phoenix_command_center_read_contract.sql',
      '200_phoenix_demo_purge_auth_boundary_correction.sql',
      '201_phoenix_organization_archive_dependency_guard.sql',
      '202_phoenix_organization_archive_reciprocal_guard.sql',
      '203_phoenix_material_dispensing_suspension.sql',
      '204_phoenix_dispensing_suspension_enforcement_dispense.sql',
      '205_phoenix_dispensing_suspension_enforcement_fefo.sql',
      '206_phoenix_dispensing_suspension_enforcement_suggestions.sql',
      '207_phoenix_dispensing_suspension_enforcement_warehouse_send.sql',
      '208_phoenix_dispensing_suspension_enforcement_replenishment_and_drafts.sql',
    ]);
    expect(files.filter((f) => Number(f.slice(0, 3)) > 208)).toEqual([]);
    expect(files).toHaveLength(208);
  });

  it('carries no MANUAL APPLY ONLY banner, so the pinned executor will accept it', () => {
    // The I-2 executor refuses any migration whose own header forbids
    // `supabase db push`. M198 is applied by that executor, so it must not.
    expect(SQL).not.toMatch(/MANUAL APPLY ONLY/i);
  });

  it('is LF-only — the repository stores no CR bytes', () => {
    expect(SQL.includes('\r')).toBe(false);
  });

  it('is one transaction: a single BEGIN and a single COMMIT, no ROLLBACK', () => {
    expect(CODE.match(/\bBEGIN\s*;/g) ?? []).toHaveLength(1);
    expect(CODE.match(/\bCOMMIT\s*;/g) ?? []).toHaveLength(1);
    expect(CODE).not.toMatch(/\bROLLBACK\b/i);
  });
});

describe('M198 static — search_path ONLY', () => {
  it('issues exactly thirty ALTER FUNCTION statements, one per target', () => {
    const alters = SQL.split('\n').filter((l) => l.startsWith('ALTER FUNCTION'));
    expect(alters).toHaveLength(30);
  });

  it('every ALTER sets exactly `search_path = public, pg_temp` and nothing else', () => {
    const alters = SQL.split('\n').filter((l) => l.startsWith('ALTER FUNCTION'));
    for (const line of alters) {
      expect(line).toMatch(/^ALTER FUNCTION public\..+ SET search_path = public, pg_temp;$/);
    }
  });

  it('the ALTERed set is EXACTLY the reviewed thirty — no additions, no omissions', () => {
    const altered = SQL.split('\n')
      .filter((l) => l.startsWith('ALTER FUNCTION'))
      .map((l) => l.replace(/^ALTER FUNCTION /, '').replace(/ SET search_path = public, pg_temp;$/, ''))
      .sort();
    expect(altered).toEqual([...THIRTY].sort());
  });

  it('declares the same thirty as its target table', () => {
    for (const sig of THIRTY) {
      expect(CODE).toContain(`('${sig}')`);
    }
  });

  it('never redefines a routine — no CREATE OR REPLACE, no DROP', () => {
    // A CREATE OR REPLACE would reparse the body and could silently change it;
    // the whole point of M198 is that only proconfig moves.
    expect(CODE).not.toMatch(/CREATE\s+OR\s+REPLACE/i);
    expect(CODE).not.toMatch(/\bDROP\s+(FUNCTION|TABLE|POLICY|TRIGGER|VIEW|SCHEMA)\b/i);
  });

  it('changes no privilege: no GRANT, no REVOKE, no ownership change', () => {
    expect(CODE).not.toMatch(/\bGRANT\b/i);
    expect(CODE).not.toMatch(/\bREVOKE\b/i);
    expect(CODE).not.toMatch(/OWNER\s+TO/i);
  });

  it('changes no RLS, policy, trigger or table structure', () => {
    expect(CODE).not.toMatch(/\bCREATE\s+POLICY\b/i);
    expect(CODE).not.toMatch(/\bALTER\s+POLICY\b/i);
    expect(CODE).not.toMatch(/\bCREATE\s+TRIGGER\b/i);
    expect(CODE).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(CODE).not.toMatch(/ROW\s+LEVEL\s+SECURITY/i);
  });

  it('mutates no business data — the only writes are to its own TEMP tables', () => {
    // INSERT is permitted only into _m198_targets; UPDATE/DELETE/TRUNCATE never.
    const inserts = [...CODE.matchAll(/\bINSERT\s+INTO\s+([A-Za-z_][\w.]*)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(['_m198_targets']);
    expect(CODE).not.toMatch(/\bUPDATE\s+[A-Za-z_]/i);
    expect(CODE).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(CODE).not.toMatch(/\bTRUNCATE\b/i);
    // Every CREATE TABLE is a TEMP table dropped at COMMIT.
    const creates = [...CODE.matchAll(/\bCREATE\s+(\w+\s+)?TABLE\b/gi)].map((m) => (m[1] ?? '').trim());
    expect(creates.length).toBeGreaterThan(0);
    for (const kind of creates) expect(kind.toUpperCase()).toBe('TEMP');
    expect(CODE.match(/ON COMMIT DROP/g) ?? []).toHaveLength(creates.length);
  });
});

describe('M198 static — it refuses anything but the reviewed state', () => {
  it('has both a PRECONDITION and a VERIFY block', () => {
    expect(CODE).toContain('$m198_pre$');
    expect(CODE).toContain('$m198_post$');
  });

  it('PRECONDITION pins the population at exactly thirty, not merely the targets', () => {
    // Without a population check a routine added since the measurement could be
    // left behind on bare `public` while the migration reported success.
    expect(SQL).toMatch(/carry search_path=public, expected exactly 30/);
    expect(SQL).toMatch(/outside the reviewed thirty/);
  });

  it('PRECONDITION refuses to run unless M197 is still intact', () => {
    expect(SQL).toMatch(/PUBLIC EXECUTE; M197 is not intact/);
  });

  it('VERIFY proves zero routines are left on bare `public`', () => {
    expect(SQL).toMatch(/still carry search_path=public, expected 0/);
  });

  it('VERIFY proves no non-search_path attribute moved, including body and ACL', () => {
    for (const attr of ['fn_oid', 'owner', 'ident_args', 'result_type', 'prosecdef',
      'prokind', 'language', 'provolatile', 'proisstrict', 'proparallel',
      'proleakproof', 'pronargs', 'body_md5', 'acl']) {
      expect(CODE).toContain(`b.${attr} IS DISTINCT FROM a.${attr}`);
    }
  });

  it('VERIFY proves the world OUTSIDE the thirty is byte-identical', () => {
    expect(CODE).toContain('_m198_env_before');
    expect(CODE).toContain('_m198_env_after');
    expect(SQL).toMatch(/state outside the thirty targets changed/);
    // …and the environment snapshot must cover privileges, RLS, policies and
    // triggers, not just functions.
    for (const kind of ["'fn'", "'rel_acl'", "'rls'", "'schema_acl'", "'default_acl'", "'policy'", "'trigger'", "'role_attr'"]) {
      expect(CODE).toContain(kind);
    }
  });
});

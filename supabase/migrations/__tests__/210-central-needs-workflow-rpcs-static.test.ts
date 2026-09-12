/**
 * CN-1B / M210 — CENTRAL NEEDS WORKFLOW RPCs — static contract.
 *
 * Reads the migration as TEXT. Behavioural proof (real replay, real
 * authorization, real state machine, real audit atomicity) lives in the
 * .dynamic suite; this file guards the properties no runtime assertion can
 * recover once the file is edited:
 *
 *   - that CN-1B stayed inside its scope (no stock, no movement, no transfer,
 *     no second authorization system, no trigger-based audit framework),
 *   - that the permission surface did not grow (no fifth key, and above all
 *     no central_needs.send),
 *   - that every client-facing RPC is SECURITY DEFINER with a pinned
 *     search_path and an exact EXECUTE surface,
 *   - and that 210 is registered correctly in every migration-governance
 *     guard.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  REVIEWED_MIGRATION_FILES, getMaximumReviewedMigrationNumber, getNextUnreviewedMigrationNumber,
  isReviewedMigrationFile,
} from './helpers/reviewed-migrations';

const MIGRATIONS = join(__dirname, '..');
const FILENAME = '210_phoenix_central_needs_workflow_rpcs.sql';
const SQL = readFileSync(join(MIGRATIONS, FILENAME), 'utf8');

/** Statement text with comments stripped, so prose can never satisfy a check. */
const CODE = SQL.replace(/--[^\n]*/g, ' ');
const BODY = CODE.slice(CODE.indexOf('BEGIN;'), CODE.indexOf('\nCOMMIT;'));

/**
 * The implementation half (DDL + function bodies) and the VERIFY half are
 * checked separately: VERIFY legitimately READS governance tables and names
 * the forbidden send key inside a negative assertion, so a blunt whole-body
 * scan would flag its safety checks as if they were the thing they forbid.
 */
const VERIFY_AT = BODY.indexOf('DO $verify$');
const IMPL = BODY.slice(0, VERIFY_AT);
const VERIFY = BODY.slice(VERIFY_AT);

/** The seven CLIENT-facing RPCs and their exact argument signatures. */
const RPCS: ReadonlyArray<readonly [string, string]> = [
  ['phoenix_central_needs_open_plan_revision', 'uuid, integer, boolean'],
  ['phoenix_central_needs_start_import_session', 'uuid, text, text, text, jsonb, bigint, text'],
  ['phoenix_central_needs_set_record_mapping', 'uuid, text, uuid'],
  ['phoenix_central_needs_record_field_override', 'uuid, jsonb, text, text, text'],
  ['phoenix_central_needs_submit_revision', 'uuid'],
  ['phoenix_central_needs_approve_revision', 'uuid'],
  ['phoenix_central_needs_reject_revision', 'uuid, text'],
];

/** The single TRUSTED-backend RPC — service_role only, never client-reachable. */
const TRUSTED_RPC = 'phoenix_central_needs_apply_authoritative_replay';
const TRUSTED_RPC_ARGS = 'uuid, text, jsonb, jsonb';

const INTERNAL_HELPERS = [
  '_phoenix_central_needs_assert_org_live_v1',
  '_phoenix_central_needs_guard_v1',
  '_phoenix_central_needs_load_revision_v1',
  '_phoenix_central_needs_assert_draft_v1',
  '_phoenix_central_needs_semantic_digest_v1',
  '_phoenix_central_needs_payload_digest_v1',
  '_phoenix_central_needs_assert_payload_v1',
];

describe('CN-1B/210 static — registration and file hygiene', () => {
  it('is registered at 210, immediately below CN-2B/211 which is now the ceiling', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    expect(files).toContain(FILENAME);
    expect(files.indexOf(FILENAME)).toBe(209);
    expect(files.filter((f) => Number(f.slice(0, 3)) > 212)).toEqual([]);
    expect(files).toHaveLength(212);
    expect(isReviewedMigrationFile(FILENAME)).toBe(true);
    // 210 is no longer last: CN-2B/211 sits directly after it, and 211's own
    // static suite owns the ceiling assertions from here on.
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.indexOf(FILENAME) + 1])
      .toBe('211_phoenix_central_needs_batch_and_disposition.sql');
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.length - 1])
      .toBe('212_phoenix_central_needs_need_lines.sql');
    expect(getMaximumReviewedMigrationNumber()).toBe(212);
    expect(getNextUnreviewedMigrationNumber()).toBe(213);
  });

  it('carries no CR bytes — LF only', () => {
    expect(SQL.includes('\r')).toBe(false);
  });

  it('is a single transaction, never rolls itself back, no MANUAL APPLY ONLY banner', () => {
    expect(SQL).toContain('BEGIN;');
    expect((SQL.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((SQL.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    expect(BODY).not.toMatch(/\bROLLBACK\b/);
    expect(SQL).not.toMatch(/MANUAL APPLY ONLY/i);
  });

  it('fails closed on its own preconditions before changing anything', () => {
    expect(BODY).toMatch(/210_precondition_failed/);
    // M209's tables, the canonical auth helper, central_items, audit_logs and
    // M202's archived_at marker are all asserted present up front.
    expect(BODY).toMatch(/phoenix_status_center_authorized\(uuid, text\)/);
    expect(BODY).toMatch(/organizations\.archived_at \(M202\) is absent/);
  });
});

describe('CN-1B/210 static — authorization model', () => {
  it('composes the canonical helper and never reimplements authorization', () => {
    expect(IMPL).toMatch(/public\.phoenix_status_center_authorized\(p_organization_id, p_permission_key\)/);
    // No parallel permission resolution: CN-1B must not read the permission
    // tables directly to decide access.
    expect(IMPL).not.toMatch(/FROM\s+public\.profile_permission_overrides/i);
    expect(IMPL).not.toMatch(/FROM\s+public\.role_permission_defaults/i);
    expect(IMPL).not.toMatch(/FROM\s+public\.permission_keys/i);
  });

  it('uses exactly the four M209 permission keys and adds none', () => {
    const keys = [...IMPL.matchAll(/'(central_needs\.[a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(keys)).toEqual(new Set([
      'central_needs.view', 'central_needs.import', 'central_needs.edit', 'central_needs.approve',
    ]));
  });

  it('never creates a permission key or a default role grant', () => {
    expect(BODY).not.toMatch(/INSERT\s+INTO\s+public\.permission_keys/i);
    expect(BODY).not.toMatch(/INSERT\s+INTO\s+public\.role_permission_defaults/i);
  });

  it('never introduces a Central Needs send permission', () => {
    // The implementation must not mention the key at all...
    expect(IMPL).not.toMatch(/central_needs\.send/i);
    // ...and VERIFY must actively assert it can never come to exist.
    expect(VERIFY).toMatch(/central_needs\.send/);
    expect(VERIFY).toMatch(/must never exist/);
  });

  it('approval and rejection require central_needs.approve, not merely edit', () => {
    for (const fn of ['phoenix_central_needs_approve_revision', 'phoenix_central_needs_reject_revision']) {
      const start = BODY.indexOf(`FUNCTION public.${fn}(`);
      expect(start, fn).toBeGreaterThan(-1);
      const segment = BODY.slice(start, BODY.indexOf('$$;', start));
      expect(segment, fn).toMatch(/_phoenix_central_needs_guard_v1\([^)]*'central_needs\.approve'\)/);
      expect(segment, fn).not.toMatch(/'central_needs\.edit'/);
    }
  });
});

describe('CN-1B/210 static — SECURITY DEFINER discipline', () => {
  it('declares every client RPC SECURITY DEFINER with a pinned search_path', () => {
    for (const [name, args] of RPCS) {
      const start = BODY.indexOf(`FUNCTION public.${name}(`);
      expect(start, name).toBeGreaterThan(-1);
      const segment = BODY.slice(start, BODY.indexOf('$$;', start));
      expect(segment, name).toMatch(/SECURITY DEFINER/);
      expect(segment, name).toMatch(/SET search_path = public, pg_temp/);
      // Exact EXECUTE surface: revoked from PUBLIC and anon, granted only to
      // authenticated.
      expect(BODY, name).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\(\\s*${args.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\) FROM PUBLIC, anon`),
      );
      expect(BODY, name).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(\\s*${args.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\) TO authenticated`),
      );
    }
  });

  it('keeps the trusted replay RPC off every client role', () => {
    // The security boundary of the whole import path: it must be revoked from
    // PUBLIC, anon AND authenticated, and must never be granted to
    // authenticated. service_role reaches it via M109's default privilege.
    expect(IMPL).toMatch(
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${TRUSTED_RPC}\\(${TRUSTED_RPC_ARGS}\\)\\s*\\n?\\s*FROM PUBLIC, anon, authenticated`),
    );
    expect(IMPL).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${TRUSTED_RPC}`));
    expect(IMPL).not.toMatch(new RegExp(`GRANT[^;]*${TRUSTED_RPC}[^;]*authenticated`));
    // VERIFY asserts the ACL positively and negatively at apply time.
    expect(VERIFY).toMatch(/service_role cannot EXECUTE the trusted replay RPC/);
    expect(VERIFY).toMatch(/can EXECUTE the trusted replay RPC/);
  });

  it('exposes no client-facing path that writes authoritative evidence', () => {
    // The two forgeable RPCs of the earlier design must be gone entirely.
    expect(BODY).not.toMatch(/phoenix_central_needs_record_source_values/);
    expect(BODY).not.toMatch(/phoenix_central_needs_finalize_import_session/);
    // Only the trusted RPC may insert source records or complete a session.
    const inserts = [...IMPL.matchAll(/INSERT INTO public\.central_needs_source_records/g)];
    expect(inserts).toHaveLength(1);
    const trustedAt = IMPL.indexOf(`FUNCTION public.${TRUSTED_RPC}(`);
    expect(IMPL.indexOf('INSERT INTO public.central_needs_source_records')).toBeGreaterThan(trustedAt);
    const completes = [...IMPL.matchAll(/SET status = 'completed'/g)];
    expect(completes).toHaveLength(1);
    expect(IMPL.indexOf("SET status = 'completed'")).toBeGreaterThan(trustedAt);
  });

  it('never accepts an authoritative digest from any caller', () => {
    // No parameter anywhere may carry an authoritative digest, and the value
    // written must come from the database's own recomputation.
    expect(IMPL).not.toMatch(/p_authoritative_digest/);
    expect(IMPL).toMatch(/v_digest\s*:=\s*public\._phoenix_central_needs_semantic_digest_v1\(/);
    expect(IMPL).toMatch(/authoritative_digest = v_digest/);
  });

  it('recomputes the digest over persisted rows, not over caller input', () => {
    const start = IMPL.indexOf('FUNCTION public._phoenix_central_needs_semantic_digest_v1(');
    const seg = IMPL.slice(start, IMPL.indexOf('$$;', start));
    expect(seg).toMatch(/FROM public\.central_needs_source_records/);
    expect(seg).toMatch(/sha256\(/);
    expect(seg).toMatch(/ORDER BY r\.record_ordinal/);
  });

  it('binds the replay to the exact source file of the session', () => {
    expect(IMPL).toMatch(/authoritative_replay_source_file_mismatch/);
    expect(IMPL).toMatch(/v_file_hash IS DISTINCT FROM p_source_file_sha256/);
  });

  it('keeps the internal helpers entirely off the client surface', () => {
    for (const name of INTERNAL_HELPERS) {
      expect(BODY, name).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\)\\s*FROM PUBLIC, anon, authenticated`),
      );
      expect(BODY, name).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(`));
    }
  });

  it('uses no dynamic SQL and no eval-like construct', () => {
    // format() is used only to build human-readable DETAIL/HINT strings; it is
    // never fed to EXECUTE. Prove no EXECUTE-of-a-string exists at all.
    expect(BODY).not.toMatch(/\bEXECUTE\s+(format|'|"|v_|p_)/i);
    expect(BODY).not.toMatch(/\bEXECUTE\s+IMMEDIATE\b/i);
    // EXECUTE FUNCTION (trigger attachment) and EXECUTE ON FUNCTION (grants)
    // are different constructs and are permitted; assert the only occurrences
    // in the IMPLEMENTATION are exactly those. VERIFY is excluded: its error
    // strings legitimately contain the English word "EXECUTE".
    for (const m of IMPL.matchAll(/\bEXECUTE\b\s+(\w+)/gi)) {
      expect(['FUNCTION', 'ON'], m[0]).toContain(m[1].toUpperCase());
    }
  });

  it('never grants a client any direct write on a Central Needs table', () => {
    expect(BODY).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)[\s\S]{0,80}central_needs/i);
    expect(BODY).toMatch(/REVOKE INSERT, UPDATE, DELETE ON TABLE public\.central_needs_record_mappings FROM authenticated/);
    expect(BODY).toMatch(/GRANT SELECT ON TABLE public\.central_needs_record_mappings TO authenticated/);
  });
});

describe('CN-1B/210 static — the CN-2A trust boundary', () => {
  it('carries a declarative finalization gate, not merely RPC logic', () => {
    expect(BODY).toMatch(/central_needs_import_sessions_authoritative_finalization_chk/);
    const chk = BODY.slice(
      BODY.indexOf('central_needs_import_sessions_authoritative_finalization_chk'),
      BODY.indexOf('COMMENT ON COLUMN'),
    );
    expect(chk).toMatch(/status <> 'completed'/);
    expect(chk).toMatch(/preview_digest IS NOT NULL/);
    expect(chk).toMatch(/authoritative_digest IS NOT NULL/);
    expect(chk).toMatch(/preview_digest = authoritative_digest/);
  });

  it('constrains both digests to lowercase SHA-256 hex', () => {
    expect(BODY).toMatch(/preview_digest ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(BODY).toMatch(/authoritative_digest ~ '\^\[0-9a-f\]\{64\}\$'/);
  });

  it('requires the authoritative pass to be the Node runtime', () => {
    expect(BODY).toMatch(/authoritative_pass_must_be_node_runtime/);
    expect(BODY).toMatch(/p_parser_identity->>'runtime', ''\) <> 'node'/);
  });

  it('stays parser-neutral — no sheet/row/column/workbook-family assumption', () => {
    for (const forbidden of [/\bsheet_?name\b/i, /\bsheet_?index\b/i, /\bcell\b/i, /\brow_?index\b/i,
      /\bcolumn_?index\b/i, /\bworkbook_?family\b/i, /\bxlsx?\b/i, /\bsheetjs\b/i]) {
      expect(BODY, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('derives import identity from the frozen contract, not a client-invented key', () => {
    expect(BODY).toMatch(/file_hash_must_be_lowercase_sha256_hex/);
    expect(BODY).toMatch(/plan_revision_id = p_plan_revision_id AND file_hash = p_file_hash/);
  });
});

describe('CN-1B/210 static — source immutability is preserved', () => {
  it('never updates or deletes source evidence', () => {
    expect(BODY).not.toMatch(/UPDATE\s+public\.central_needs_source_records/i);
    expect(BODY).not.toMatch(/UPDATE\s+public\.central_needs_source_files/i);
    expect(BODY).not.toMatch(/DELETE\s+FROM\s+public\.central_needs_source_records/i);
    expect(BODY).not.toMatch(/DELETE\s+FROM\s+public\.central_needs_source_files/i);
  });

  it('never silently discards an emitted source record', () => {
    // The old (session, entity, field) ON CONFLICT DO NOTHING would drop a
    // second same-header cell in one row — losing immutable evidence while
    // reporting success. Ordinal identity replaced it, so the insert carries
    // no conflict clause at all and a genuine collision would raise.
    expect(IMPL).not.toMatch(/ON CONFLICT[\s\S]{0,120}central_needs_source_records/);
    const start = IMPL.indexOf('INSERT INTO public.central_needs_source_records');
    const seg = IMPL.slice(start, start + 700);
    expect(seg).not.toMatch(/ON CONFLICT/);
    expect(seg).toMatch(/WITH ORDINALITY/);
  });

  it('drops neither M209 immutability trigger', () => {
    expect(BODY).not.toMatch(/DROP TRIGGER[\s\S]{0,80}immutable/i);
    expect(BODY).not.toMatch(/DROP FUNCTION[\s\S]{0,80}_phoenix_central_needs_source_immutability_v1/i);
  });

  it('makes an override reason mandatory', () => {
    expect(BODY).toMatch(/override_reason_required/);
  });
});

describe('CN-1B/210 static — archived-organization contract', () => {
  it('refuses mutation under an archived organization, server-side', () => {
    expect(BODY).toMatch(/central_needs_write_blocked_by_archived_organization/);
    expect(BODY).toMatch(/SELECT archived_at INTO v_archived_at/);
    expect(BODY).toMatch(/FOR KEY SHARE/);
  });

  it('does not widen M201/M202 archive semantics', () => {
    // CN-1B must not attach Central Needs tables to the reciprocal guard, nor
    // add itself to the archive dependency count.
    expect(BODY).not.toMatch(/_phoenix_assert_parent_not_archived_v1/);
    expect(BODY).not.toMatch(/_phoenix_organization_archive_dependency_guard_v1/);
    expect(BODY).not.toMatch(/CREATE TRIGGER[\s\S]{0,120}not_archived/i);
  });
});

describe('CN-1B/210 static — audit contract', () => {
  it('writes audit rows as explicit inline INSERTs, never via a trigger framework', () => {
    const inserts = [...BODY.matchAll(/INSERT INTO public\.audit_logs/g)];
    // Exactly one per mutating workflow event that can actually commit: open,
    // import start, trusted authoritative replay, mapping, override, submit,
    // approve, reject. A failed replay writes none — it raises, so anything
    // written there would roll back with the caller's transaction.
    expect(inserts.length).toBe(8);
    expect(BODY).not.toMatch(/CREATE TRIGGER[\s\S]{0,160}audit/i);
    expect(BODY).not.toMatch(/FUNCTION[\s\S]{0,60}audit[\s\S]{0,60}RETURNS trigger/i);
  });

  it('uses the canonical audit column set', () => {
    expect(BODY).toMatch(
      /organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload/,
    );
  });

  it('namespaces every audit action under central_needs', () => {
    const actions = [...BODY.matchAll(/'(central_needs\.[a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]);
    expect(actions.length).toBe(8);
    expect(new Set(actions).size).toBe(8);
    for (const a of actions) expect(a.startsWith('central_needs.')).toBe(true);
  });

  it('does not copy imported business values into the audit payload', () => {
    // Source values are already persisted as evidence; duplicating workbook
    // contents into audit_logs would leak restricted data into a broader read
    // surface. Counts and identifiers only.
    expect(BODY).toMatch(/'records_supplied', v_supplied/);
    expect(BODY).not.toMatch(/'source_values',\s*r->/);
  });
});

describe('CN-1B/210 static — forbidden invariants', () => {
  it('touches no stock, movement, transfer or suggestion surface', () => {
    for (const forbidden of [
      /warehouse_stock/i, /stock_movements/i, /inventory_transfer_suggestions/i,
      /warehouse_transfer_request/i, /warehouse_transfer_line/i, /transfer_request_line/i,
      /item_availability/i, /dispense/i, /warehouse_transfer\.send/i,
    ]) {
      expect(BODY, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('creates no table outside the Central Needs namespace', () => {
    const created = [...BODY.matchAll(/CREATE TABLE public\.(\w+)/g)].map((m) => m[1]);
    expect(created).toEqual(['central_needs_record_mappings']);
  });

  it('alters only Central Needs tables', () => {
    const altered = new Set([...BODY.matchAll(/ALTER TABLE public\.(\w+)/g)].map((m) => m[1]));
    // import_sessions (trust evidence), source_records (ordinal identity),
    // field_overrides (lineage) and the new mappings table (RLS).
    expect([...altered].sort()).toEqual([
      'central_needs_field_overrides',
      'central_needs_import_sessions',
      'central_needs_record_mappings',
      'central_needs_source_records',
    ]);
    for (const t of altered) expect(t.startsWith('central_needs_')).toBe(true);
  });

  it('creates no function outside the Central Needs namespace', () => {
    const fns = [...BODY.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((m) => m[1]);
    for (const f of fns) expect(f, f).toMatch(/central_needs/);
    // 7 client RPCs + 1 trusted backend RPC + 4 internal helpers.
    expect(fns).toHaveLength(RPCS.length + 1 + INTERNAL_HELPERS.length);
  });

  it('declares no test bypass anywhere', () => {
    expect(SQL).not.toMatch(/\.(skip|only|todo)\(/);
  });
});

describe('CN-1B/210 static — state machine uses only M209 labels', () => {
  it('invents no revision status', () => {
    const statuses = new Set(
      [...BODY.matchAll(/status\s*(?:=|<>)\s*'([a-z_]+)'/g)].map((m) => m[1]),
    );
    const allowed = new Set([
      // central_needs_plan_revisions
      'draft', 'submitted', 'approved', 'superseded', 'rejected',
      // central_needs_import_sessions
      'pending', 'processing', 'completed', 'failed',
    ]);
    for (const s of statuses) expect(allowed.has(s), `unexpected status '${s}'`).toBe(true);
  });

  it('only ever supersedes an approved revision, preserving its approval record', () => {
    // A revision still under review cannot be closed out from under the reviewer.
    expect(IMPL).toMatch(/plan_revision_still_in_review/);
    expect(IMPL).toMatch(/SET status = 'superseded'/);
    // Exactly one supersede site, and it is guarded on 'approved'.
    expect([...IMPL.matchAll(/SET status = 'superseded'/g)]).toHaveLength(1);
    // The supersede UPDATE must not clear the approval pair.
    expect(IMPL).not.toMatch(/SET status = 'superseded'[\s\S]{0,120}approved_by\s*=\s*NULL/);
  });

  it('restricts content mutation to a draft revision', () => {
    expect(BODY).toMatch(/plan_revision_not_editable/);
    expect(BODY).toMatch(/p_status <> 'draft'/);
  });

  it('authorizes before disclosing revision state on every content RPC', () => {
    // load -> guard -> assert_draft. An unauthorized caller must be refused on
    // authorization grounds before the workflow state of a revision they may
    // not see is disclosed to them.
    for (const [name] of RPCS) {
      const start = IMPL.indexOf(`FUNCTION public.${name}(`);
      const segment = IMPL.slice(start, IMPL.indexOf('$$;', start));
      const guardAt = segment.indexOf('_phoenix_central_needs_guard_v1');
      const draftAt = segment.indexOf('_phoenix_central_needs_assert_draft_v1');
      if (draftAt === -1) continue; // RPC has no draft requirement
      expect(guardAt, `${name}: guard must run before the draft assertion`).toBeGreaterThan(-1);
      expect(guardAt, `${name}: guard must run before the draft assertion`).toBeLessThan(draftAt);
    }
  });

  it('refuses to submit a revision with no authoritatively finalized import', () => {
    expect(BODY).toMatch(/plan_revision_has_no_finalized_import/);
  });
});

describe('CN-1B/210 static — review-round repairs', () => {
  it('B1: the trusted replay is subject to the archived-organization rule', () => {
    // service_role bypasses RLS but is NOT exempt from the archive contract.
    const start = IMPL.indexOf(`FUNCTION public.${TRUSTED_RPC}(`);
    const seg = IMPL.slice(start, IMPL.indexOf('$$;', start));
    expect(seg).toMatch(/_phoenix_central_needs_assert_org_live_v1\(v_session\.organization_id\)/);
    // ...and the check runs BEFORE any source record is written.
    expect(seg.indexOf('_phoenix_central_needs_assert_org_live_v1'))
      .toBeLessThan(seg.indexOf('INSERT INTO public.central_needs_source_records'));
    // The archive rule lives in one shared helper used by the client guard too.
    expect(IMPL).toMatch(/central_needs_write_blocked_by_archived_organization/);
    const guard = IMPL.slice(IMPL.indexOf('FUNCTION public._phoenix_central_needs_guard_v1('));
    expect(guard.slice(0, guard.indexOf('$$;'))).toMatch(/_phoenix_central_needs_assert_org_live_v1/);
  });

  it('B2: source identity is a deterministic ordinal, not (entity, field)', () => {
    expect(IMPL).toMatch(/ADD COLUMN record_ordinal integer NOT NULL/);
    expect(IMPL).toMatch(/DROP CONSTRAINT central_needs_source_records_import_session_id_target_entit_key/);
    expect(IMPL).toMatch(/central_needs_source_records_session_ordinal_key[\s\S]{0,40}UNIQUE \(import_session_id, record_ordinal\)/);
    // Order comes from CN-2A's frozen array, captured relationally.
    expect(IMPL).toMatch(/WITH ORDINALITY AS e\(r, ord\)/);
    // Nothing may silently discard an emitted record any more.
    expect(IMPL).not.toMatch(/ON CONFLICT[\s\S]{0,80}central_needs_source_records/);
    expect(IMPL).not.toMatch(/ON CONFLICT \(import_session_id, target_entity, field_name\)/);
    // Still parser-neutral: no sheet/row/column relational column appears.
    expect(IMPL).not.toMatch(/ADD COLUMN\s+(sheet|row|column|cell)_/i);
  });

  it('B2: mappings are scoped to an import session, not merely a revision', () => {
    expect(IMPL).toMatch(/CREATE TABLE public\.central_needs_record_mappings[\s\S]*?UNIQUE \(import_session_id, target_entity\)/);
    expect(IMPL).toMatch(/central_needs_record_mappings_session_org_fk/);
  });

  it('B3: mapping and override are bound to real evidence', () => {
    expect(IMPL).toMatch(/target_entity_not_in_import_session/);
    expect(IMPL).toMatch(/source_record_not_found/);
    expect(IMPL).toMatch(/ADD COLUMN source_record_id uuid NOT NULL/);
    expect(IMPL).toMatch(/central_needs_field_overrides_source_record_org_fk/);
    // previous_value is derived from lineage, never taken from the caller.
    const start = IMPL.indexOf('FUNCTION public.phoenix_central_needs_record_field_override(');
    const seg = IMPL.slice(start, IMPL.indexOf('$$;', start));
    expect(seg).not.toMatch(/p_previous_value/);
    expect(seg).toMatch(/v_previous := v_record\.source_values/);
    expect(seg).toMatch(/'source_record_id', p_source_record_id/);
  });

  it('B4: the digest binds provenance, normalizing only extractedAt', () => {
    const start = IMPL.indexOf('FUNCTION public._phoenix_central_needs_semantic_digest_v1(');
    const seg = IMPL.slice(start, IMPL.indexOf('$$;', start));
    expect(seg).toMatch(/r\.record_ordinal/);
    expect(seg).toMatch(/r\.source_values/);
    expect(seg).toMatch(/source_provenance - 'extractedAt'/);
    expect(seg).toMatch(/ORDER BY r\.record_ordinal/);
    // Provenance is mandatory and must fingerprint this session's file.
    expect(IMPL).toMatch(/record_requires_source_provenance_object/);
    expect(IMPL).toMatch(/record_provenance_file_fingerprint_mismatch/);
  });

  it('B5: the trusted replay is idempotent on exact retry and fails closed otherwise', () => {
    expect(IMPL).toMatch(/import_session_already_finalized_with_different_evidence/);
    const start = IMPL.indexOf(`FUNCTION public.${TRUSTED_RPC}(`);
    const seg = IMPL.slice(start, IMPL.indexOf('$$;', start));
    expect(seg).toMatch(/v_session\.status = 'completed'/);
    expect(seg).toMatch(/'idempotent_replay', true/);
    expect(seg).toMatch(/'records_inserted', 0/);
  });

  it('B6: a rejected revision does not dead-end the plan year', () => {
    const start = IMPL.indexOf('FUNCTION public.phoenix_central_needs_open_plan_revision(');
    const seg = IMPL.slice(start, IMPL.indexOf('$$;', start));
    expect(seg).toMatch(/status NOT IN \('approved', 'rejected'\)/);
    // Only an approved revision is superseded; a rejected one stays rejected.
    expect(seg).toMatch(/IF v_current\.status = 'approved' THEN[\s\S]{0,160}SET status = 'superseded'/);
    expect(seg).not.toMatch(/rejected'[\s\S]{0,80}SET status = 'superseded'/);
    // The parameter name states what it does.
    expect(IMPL).toMatch(/p_open_next_revision\s+boolean DEFAULT false/);
    expect(IMPL).not.toMatch(/p_supersede/);
  });
});

describe('CN-1B/210 static — payload validation precedes digesting', () => {
  const trustedBody = () => {
    const start = IMPL.indexOf(`FUNCTION public.${TRUSTED_RPC}(`);
    return IMPL.slice(start, IMPL.indexOf('$$;', start));
  };

  it('validates the payload BEFORE the completed-session branch', () => {
    const seg = trustedBody();
    const validateAt = seg.indexOf('_phoenix_central_needs_assert_payload_v1(p_records, p_source_file_sha256)');
    const completedAt = seg.indexOf("v_session.status = 'completed'");
    const digestAt = seg.indexOf('_phoenix_central_needs_payload_digest_v1(p_records)');
    expect(validateAt, 'the shared validator must be invoked').toBeGreaterThan(-1);
    expect(completedAt, 'the completed branch must exist').toBeGreaterThan(-1);
    expect(digestAt, 'the payload digest must be used for the retry comparison').toBeGreaterThan(-1);
    // Digesting an unvalidated payload is exactly how a malformed appended
    // element could hash as an identical retry.
    expect(validateAt, 'validation must precede the completed branch').toBeLessThan(completedAt);
    expect(validateAt, 'validation must precede payload digesting').toBeLessThan(digestAt);
  });

  it('uses ONE shared validator, not two drifting copies', () => {
    // Exactly one call site, and the per-record rules live only in the helper.
    expect([...trustedBody().matchAll(/_phoenix_central_needs_assert_payload_v1\(/g)]).toHaveLength(1);
    const helperStart = IMPL.indexOf('FUNCTION public._phoenix_central_needs_assert_payload_v1(');
    const helper = IMPL.slice(helperStart, IMPL.indexOf('$$;', helperStart));
    for (const rule of [
      /record_requires_target_entity_field_name_and_source_values/,
      /record_requires_source_provenance_object/,
      /record_provenance_file_fingerprint_mismatch/,
      /authoritative_replay_produced_no_records/,
    ]) {
      expect(helper, String(rule)).toMatch(rule);
      // ...and NOT re-implemented inline in the RPC body.
      expect(trustedBody(), `${rule} must not be duplicated inline`).not.toMatch(rule);
    }
  });

  it('the payload digest cannot silently drop a malformed member', () => {
    const start = IMPL.indexOf('FUNCTION public._phoenix_central_needs_payload_digest_v1(');
    const seg = IMPL.slice(start, IMPL.indexOf('$$;', start));
    // Every concatenated member is COALESCE'd, so a NULL can never vanish
    // inside string_agg and make two different payloads hash alike.
    expect(seg).toMatch(/COALESCE\(btrim\(e\.r->>'targetEntity'\), ''\)/);
    expect(seg).toMatch(/COALESCE\(btrim\(e\.r->>'fieldName'\), ''\)/);
    expect(seg).toMatch(/COALESCE\(\(e\.r->'sourceValues'\)::text, ''\)/);
    expect(seg).toMatch(/COALESCE\(\(\(e\.r->'sourceProvenance'\) - 'extractedAt'\)::text, ''\)/);
  });
});

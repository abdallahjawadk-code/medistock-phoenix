import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REVIEWED_MIGRATION_FILES, findUnreviewedMigrationFiles } from './helpers/reviewed-migrations';

const MIGRATIONS_DIR = join(__dirname, '..');
const NAME = '190_phoenix_inter_org_alert_cqrs_boundary.sql';
const sql = readFileSync(join(MIGRATIONS_DIR, NAME), 'utf8');

/**
 * ALERT-CQRS-BOUNDARY-190 — STATIC proof.
 *
 * The whole point of this migration is a boundary: two RPCs that may never
 * write, one RPC whose job IS to write, and one internal projection both
 * queries share. A whole-file `not.toContain('INSERT')` would be meaningless
 * here — the migration's own header and VERIFY block legitimately name every
 * forbidden expression, as documentation and as a rejection pattern. Each
 * executable body is therefore isolated by its own dollar-quote tag, exactly as
 * the 189/188/177 static suites do, and the purity assertions run over the
 * ISOLATED bodies only.
 */
const between = (openTag: string, closeTag: string): string => {
  const open = sql.indexOf(openTag);
  const close = sql.indexOf(closeTag, open + openTag.length);
  if (open === -1 || close === -1) throw new Error(`190: could not isolate ${openTag}`);
  return sql.slice(open + openTag.length, close);
};

const projectionBody = between('AS $projection$', '$projection$;');
const refreshBody    = between('AS $refresh$', '$refresh$;');
const pageBody       = between('AS $page$', '$page$;');
const summaryBody    = between('AS $summary$', '$summary$;');
const preflightBlock = sql.slice(sql.indexOf('DO $preflight$'), sql.indexOf('$preflight$;'));
const verifyBlock    = sql.slice(sql.indexOf('DO $verify$'), sql.indexOf('$verify$;'));

/** Everything except the four executable bodies — headers, preflight, verify. */
const scaffolding = sql
  .replace(projectionBody, '')
  .replace(refreshBody, '')
  .replace(pageBody, '')
  .replace(summaryBody, '');

/**
 * A body with its `--` line comments removed. Every purity assertion runs over
 * this, never the raw body: the bodies deliberately EXPLAIN in prose why they
 * do not upsert, and matching that prose would be matching the documentation
 * rather than the code.
 */
const code = (body: string): string => body.replace(/--[^\n]*/g, ' ');

/**
 * The body's LAST `RETURN jsonb_build_object(...)` — its success envelope.
 * Asserted separately from the whole body because the verbatim-refusal path
 * (`RETURN v_full;`) and a `v_full->'alerts'` read both legitimately mention
 * keys the success envelope itself must NOT carry.
 */
const successEnvelope = (body: string): string => {
  const at = body.lastIndexOf('RETURN jsonb_build_object(');
  if (at === -1) throw new Error('190: no success envelope found');
  return body.slice(at);
};

/**
 * The TOP-LEVEL key names of a success envelope, read off the key positions
 * only. `jsonb_array_length(COALESCE(v_full->'alerts', ...))` legitimately
 * mentions 'alerts' as a VALUE expression; only a key position counts.
 */
const envelopeKeys = (envelope: string): string[] =>
  [...envelope.matchAll(/^\s*'(\w+)',/gm)].map(m => m[1]);

/** Statement lines only — never header prose, which discusses every keyword. */
const statementLines = (text: string): string[] =>
  text.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('--'));

/** The three surfaces that must be pure. The refresh COMMAND is not among them. */
const PURE_BODIES: readonly (readonly [string, string])[] = [
  ['projection', code(projectionBody)],
  ['page query', code(pageBody)],
  ['summary query', code(summaryBody)],
];

// ============================================================================
// Registration and file hygiene
// ============================================================================
describe('190 · registration and file hygiene', () => {
  it('exists exactly once, is registered, and is manual-apply-only', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('190_'))).toEqual([NAME]);
    expect(REVIEWED_MIGRATION_FILES).toContain(NAME);
    expect(findUnreviewedMigrationFiles(readdirSync(MIGRATIONS_DIR))).toEqual([]);
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('supabase db push');
  });

  it('is LF-only (162 portability contract)', () => {
    expect(sql.includes('\r')).toBe(false);
  });

  it('is exactly one transaction with no rollback path', () => {
    expect(sql).toContain('\nBEGIN;');
    expect(sql).toContain('\nCOMMIT;');
    expect(sql.match(/\nBEGIN;/g)).toHaveLength(1);
    expect(sql.match(/\nCOMMIT;/g)).toHaveLength(1);
    for (const [name, body] of PURE_BODIES) {
      expect(body, name).not.toMatch(/\bROLLBACK\b/);
    }
    expect(code(refreshBody)).not.toMatch(/\bROLLBACK\b/);
  });

  it('is followed by 191 through 196, the new ceiling, and 197 stays absent', () => {
    const numbers = REVIEWED_MIGRATION_FILES.map(f => Number(f.slice(0, 3))).filter(Number.isFinite);
    const NEXT = '191_phoenix_canonical_scope_topology_read_contract.sql';
    const NEXT_2 = '192_phoenix_anonymous_read_surface_convergence.sql';
    const NEXT_3 = '193_phoenix_inter_org_alert_command_surface_hardening.sql';
    const NEXT_4 = '194_phoenix_authorization_surface_reproducibility_convergence.sql';
    const NEXT_5 = '195_phoenix_auth_helper_profile_schema_qualification.sql';
    const NEXT_6 = '196_phoenix_secdef_relation_schema_qualification.sql';
    expect(Math.max(...numbers)).toBe(196);
    const i = REVIEWED_MIGRATION_FILES.indexOf(NAME);
    expect(REVIEWED_MIGRATION_FILES.slice(i + 1)).toEqual([NEXT, NEXT_2, NEXT_3, NEXT_4, NEXT_5, NEXT_6]);
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.length - 1]).toBe(NEXT_6);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^191_/.test(f))).toEqual([NEXT]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^192_/.test(f))).toEqual([NEXT_2]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^193_/.test(f))).toEqual([NEXT_3]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^194_/.test(f))).toEqual([NEXT_4]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^195_/.test(f))).toEqual([NEXT_5]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^196_/.test(f))).toEqual([NEXT_6]);
    expect(REVIEWED_MIGRATION_FILES.filter(f => /^197_/.test(f))).toHaveLength(0);
  });
});

// ============================================================================
// PURE-QUERY GUARDS — the requirement this migration exists to satisfy.
// ============================================================================
describe('190 · the query side writes nothing', () => {
  it.each(PURE_BODIES.map(([name]) => name))('%s contains no INSERT', (name) => {
    const body = PURE_BODIES.find(([n]) => n === name)![1];
    expect(body).not.toMatch(/\bINSERT\b/i);
  });

  it.each(PURE_BODIES.map(([name]) => name))('%s contains no UPDATE statement', (name) => {
    const body = PURE_BODIES.find(([n]) => n === name)![1];
    // \b…\b so `updated_at` (a column the 047 contact ordering legitimately
    // reads) is not mistaken for an UPDATE statement.
    expect(body).not.toMatch(/\bUPDATE\b/i);
  });

  it.each(PURE_BODIES.map(([name]) => name))('%s contains no DELETE', (name) => {
    const body = PURE_BODIES.find(([n]) => n === name)![1];
    expect(body).not.toMatch(/\bDELETE\b/i);
  });

  it.each(PURE_BODIES.map(([name]) => name))('%s contains no upsert (ON CONFLICT)', (name) => {
    const body = PURE_BODIES.find(([n]) => n === name)![1];
    expect(body).not.toMatch(/ON\s+CONFLICT/i);
  });

  it.each(PURE_BODIES.map(([name]) => name))('%s contains no TRUNCATE or MERGE', (name) => {
    const body = PURE_BODIES.find(([n]) => n === name)![1];
    expect(body).not.toMatch(/\bTRUNCATE\b/i);
    expect(body).not.toMatch(/\bMERGE\b/i);
  });

  it.each(PURE_BODIES.map(([name]) => name))('%s never writes the lifecycle event log', (name) => {
    const body = PURE_BODIES.find(([n]) => n === name)![1];
    // inter_org_alert_events has exactly one writer (039's hybrid) and the read
    // side must not touch it at all — not even to read it.
    expect(body).not.toMatch(/inter_org_alert_events/i);
  });

  it.each(PURE_BODIES.map(([name]) => name))('%s never delegates to the with_state hybrid or its paged wrapper', (name) => {
    const body = PURE_BODIES.find(([n]) => n === name)![1];
    // One pattern covers both: the paged wrapper's name is the hybrid's name
    // plus `_page`, so forbidding the hybrid's name forbids the wrapper too.
    expect(body).not.toMatch(/phoenix_get_live_inter_institution_alerts_with_state/i);
  });

  it.each(PURE_BODIES.map(([name]) => name))('%s never calls the refresh COMMAND', (name) => {
    const body = PURE_BODIES.find(([n]) => n === name)![1];
    expect(body).not.toMatch(/phoenix_refresh_inter_org_alert_lifecycle/i);
  });

  it('the guards above are non-vacuous — the isolated bodies are real code', () => {
    for (const [name, body] of PURE_BODIES) {
      expect(body.length, name).toBeGreaterThan(200);
      expect(body, name).toContain('BEGIN');
      expect(body, name).toContain('RETURN');
    }
  });

  it('…and the same patterns DO fire on the hybrid this migration is replacing', () => {
    // Counter-proof: if the matchers above could not see a real upsert, every
    // assertion in this describe block would be passing for the wrong reason.
    const hybrid = readFileSync(
      join(MIGRATIONS_DIR, '189_phoenix_inter_org_alert_canonical_identity.sql'), 'utf8');
    const stateBody = hybrid.slice(
      hybrid.indexOf('AS $fn_state$'), hybrid.indexOf('$fn_state$;'));
    const hybridCode = code(stateBody);
    expect(hybridCode).toMatch(/\bINSERT\b/i);
    expect(hybridCode).toMatch(/ON\s+CONFLICT/i);
    expect(hybridCode).toMatch(/inter_org_alert_events/i);
  });
});

// ============================================================================
// NO THIRD MATCHER — canonical identity stays owned by 189/150.
// ============================================================================
describe('190 · reuses the canonical computation instead of restating it', () => {
  it('the projection gets its alert set from 189\'s PURE base RPC', () => {
    expect(code(projectionBody)).toContain('public.phoenix_get_live_inter_institution_alerts(p_limit)');
  });

  it('both queries read through the ONE shared projection, not two copies', () => {
    expect(code(pageBody)).toContain('public._phoenix_live_inter_org_alert_read_projection_v1(500)');
    expect(code(summaryBody)).toContain('public._phoenix_live_inter_org_alert_read_projection_v1(v_limit)');
  });

  it('the projection implements no material matching of its own', () => {
    const body = code(projectionBody);
    // Neither 150's canonical key nor 189's bridge is recomputed here: the
    // match already happened inside the base RPC.
    expect(body).not.toMatch(/material_identity_key/i);
    expect(body).not.toMatch(/_phoenix_material_identity_v1/i);
    expect(body).not.toMatch(/_phoenix_availability_material_identity_v1/i);
  });

  it('the projection never re-reads item_availability to decide eligibility', () => {
    // Anchored on FROM/JOIN: the projection legitimately CARRIES the base RPC's
    // source_item_availability_id / target_item_availability_id fields through,
    // so a bare substring test would fail on its own payload.
    expect(code(projectionBody)).not.toMatch(/(FROM|JOIN)\s+(public\.)?item_availability\b/i);
  });

  it('no display label is ever used as a matching key', () => {
    const body = code(projectionBody);
    // scientific_name/trade_name/concentration/dosage_form must not appear in
    // any join or equality — the projection does not even reference them.
    expect(body).not.toMatch(/scientific_name/i);
    expect(body).not.toMatch(/trade_name/i);
    for (const forbidden of ['ON s.', 'GROUP BY', 'DISTINCT ON']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('the only tables the projection reads are the lifecycle state and the contact book', () => {
    const reads = [...code(projectionBody).matchAll(/(?:FROM|JOIN)\s+public\.(\w+)/gi)]
      .map(m => m[1]).sort();
    expect([...new Set(reads)]).toEqual(['inter_org_alert_states', 'organization_status_contacts']);
  });

  it('the lifecycle join is LEFT, so a never-persisted alert is still returned', () => {
    expect(code(projectionBody)).toMatch(/LEFT JOIN\s+public\.inter_org_alert_states/i);
    // …and never the INNER form, which would silently drop live alerts.
    const inner = code(projectionBody).split('JOIN public.inter_org_alert_states').length - 1;
    const left = code(projectionBody).split('LEFT JOIN public.inter_org_alert_states').length - 1;
    expect(inner).toBe(left);
  });

  it('an unpersisted alert reads exactly as the hybrid would have written it', () => {
    const body = code(projectionBody);
    expect(body).toContain("COALESCE(st.status, 'open')");
    expect(body).toContain('COALESCE(st.first_seen_at, v_computed_at)');
    expect(body).toContain('COALESCE(st.last_seen_at,  v_computed_at)');
  });

  it('alert_key keeps 039\'s exact shape so historical rows still match', () => {
    const body = code(projectionBody);
    expect(body).toContain("(t.elem->>'source_item_availability_id') || ':' ||");
    expect(body).toContain("(t.elem->>'target_item_availability_id') || ':' ||");
    expect(body).toContain("(t.elem->>'alert_type')");
  });
});

// ============================================================================
// THE COMMAND — one writer, reached explicitly.
// ============================================================================
describe('190 · the refresh COMMAND delegates rather than duplicates', () => {
  it('calls the canonical hybrid', () => {
    expect(code(refreshBody)).toContain('public.phoenix_get_live_inter_institution_alerts_with_state(p_limit)');
  });

  it('holds no copy of the lifecycle upsert or the opened event', () => {
    const body = code(refreshBody);
    expect(body).not.toMatch(/\bINSERT\b/i);
    expect(body).not.toMatch(/ON\s+CONFLICT/i);
    expect(body).not.toMatch(/inter_org_alert_states/i);
    expect(body).not.toMatch(/inter_org_alert_events/i);
  });

  it('returns command metadata only — never the alert rows', () => {
    // Exact key set, not a subset: a command that also answered the read would
    // keep inviting callers to read through the writer. It COUNTS the array it
    // was handed (a value expression); it never publishes it as a key.
    expect(envelopeKeys(successEnvelope(code(refreshBody))))
      .toEqual(['ok', 'refreshed_count', 'computed_at']);
  });

  it('returns the hybrid\'s refusal verbatim rather than inventing one', () => {
    expect(code(refreshBody)).toContain('RETURN v_full;');
  });
});

// ============================================================================
// PAYLOAD COMPATIBILITY with the 148 wrapper the page query replaces.
// ============================================================================
describe('190 · paged query is contract-compatible with the wrapper it replaces', () => {
  it('keeps 148\'s limit/offset sanitisation exactly', () => {
    const body = code(pageBody);
    expect(body).toContain('LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)');
    expect(body).toContain('GREATEST(COALESCE(p_offset, 0), 0)');
  });

  it('keeps 148\'s permanently-non-executable stamp', () => {
    expect(code(pageBody)).toContain("jsonb_build_object('executable', false)");
  });

  it('returns the same envelope keys, in the same order', () => {
    expect(envelopeKeys(successEnvelope(code(pageBody)))).toEqual([
      'ok', 'alerts', 'total_count', 'limit', 'offset', 'computed_at',
    ]);
  });

  it('reads the same 500-row universe the wrapper always used', () => {
    expect(code(pageBody)).toContain('_phoenix_live_inter_org_alert_read_projection_v1(500)');
  });
});

// ============================================================================
// SUMMARY SEMANTICS — parity with the client-side derivation it replaces.
// ============================================================================
describe('190 · summary query preserves the Dashboard\'s exact counting rule', () => {
  it('counts only ACTIVE lifecycle states', () => {
    expect(code(summaryBody)).toContain("IN ('open', 'acknowledged', 'in_progress')");
  });

  it('does not count resolved or dismissed alerts', () => {
    const body = code(summaryBody);
    expect(body).not.toMatch(/'resolved'\s*,/);
    expect(body).not.toMatch(/'dismissed'\s*,/);
  });

  it('keeps the pre-existing 200-row window', () => {
    expect(code(summaryBody)).toContain('LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500)');
    expect(sql).toContain('p_limit integer DEFAULT 200');
  });

  it('returns exactly the four counters the widget renders, server-computed', () => {
    // Exact key set: it must NOT ship the alert rows — shipping 200 objects for
    // the browser to reduce is precisely what the Dashboard is being moved off.
    expect(envelopeKeys(successEnvelope(code(summaryBody)))).toEqual([
      'ok', 'total', 'high', 'surplus_to_shortage', 'near_expiry_to_shortage', 'computed_at',
    ]);
  });
});

// ============================================================================
// SECURITY POSTURE
// ============================================================================
describe('190 · security posture', () => {
  it('every new function pins its search_path', () => {
    expect(sql.match(/SET search_path = public, pg_temp/g)?.length).toBe(4);
  });

  it('the internal projection is revoked from every client role', () => {
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public._phoenix_live_inter_org_alert_read_projection_v1(integer)\n  FROM PUBLIC, anon, authenticated;');
  });

  it('every public RPC revokes PUBLIC and anon before granting authenticated', () => {
    for (const fn of [
      'public.phoenix_refresh_inter_org_alert_lifecycle(integer)',
      'public.phoenix_query_live_inter_org_alerts_with_state_page(integer,integer)',
      'public.phoenix_query_live_inter_org_alert_summary(integer)',
    ]) {
      const revokeAt = sql.indexOf(`REVOKE ALL ON FUNCTION ${fn}`);
      const grantAt = sql.indexOf(`GRANT EXECUTE ON FUNCTION ${fn}`);
      expect(revokeAt, fn).toBeGreaterThan(-1);
      expect(grantAt, fn).toBeGreaterThan(-1);
      expect(revokeAt, fn).toBeLessThan(grantAt);
    }
    expect(sql.match(/GRANT EXECUTE ON FUNCTION[^;]*TO authenticated;/g)?.length).toBe(3);
  });

  it('grants nothing to anon anywhere', () => {
    // Statement lines only: the header prose necessarily discusses anon and
    // grants, and matching that would be reading the documentation.
    const grants = statementLines(sql).filter(l => l.startsWith('GRANT'));
    expect(grants.length).toBeGreaterThan(0);          // non-vacuous
    for (const g of grants) expect(g, g).not.toMatch(/\banon\b|\bPUBLIC\b/);
  });

  it('opens no lifecycle table to any client role', () => {
    // §14: the query problem must NOT be solved with a table grant.
    expect(sql).not.toMatch(/GRANT[^;]*ON\s+TABLE/i);
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
    expect(sql).not.toMatch(/ALTER\s+TABLE/i);
  });

  it('the projection and the two queries are SECURITY DEFINER; the COMMAND is not', () => {
    // Function-attribute lines only — `SECURITY DEFINER` also appears many
    // times in the header, explaining exactly why each choice was made.
    expect(statementLines(sql).filter(l => l === 'SECURITY DEFINER')).toHaveLength(3);
    expect(statementLines(sql).filter(l => l === 'SECURITY INVOKER')).toHaveLength(1);
    // The COMMAND's dollar-quote tag follows its own SECURITY INVOKER line.
    const invokerAt = sql.indexOf('SECURITY INVOKER');
    const refreshTagAt = sql.indexOf('AS $refresh$');
    expect(invokerAt).toBeLessThan(refreshTagAt);
  });

  it('touches no DDL — no table, column, index, trigger or type is created', () => {
    for (const forbidden of [
      'CREATE TABLE', 'DROP TABLE', 'ADD COLUMN', 'DROP COLUMN',
      'CREATE INDEX', 'CREATE TRIGGER', 'CREATE TYPE', 'CREATE VIEW',
      'CREATE MATERIALIZED VIEW',
    ]) {
      expect(sql, forbidden).not.toContain(forbidden);
    }
  });
});

// ============================================================================
// ADDITIVE ONLY — nothing that existed before 190 is changed by 190.
// ============================================================================
describe('190 · is additive and breaks no existing contract', () => {
  it('drops and revokes nothing that pre-existed it', () => {
    // The only REVOKEs are the three "revoke then grant" pairs on its OWN new
    // functions plus the internal projection's lockdown — never on a legacy one.
    expect(sql).not.toMatch(/DROP FUNCTION/i);
    expect(sql).not.toMatch(/ALTER FUNCTION/i);
    const revoked = [...sql.matchAll(/REVOKE ALL ON FUNCTION\s+(public\.[\w]+)/g)].map(m => m[1]).sort();
    expect([...new Set(revoked)]).toEqual([
      'public._phoenix_live_inter_org_alert_read_projection_v1',
      'public.phoenix_query_live_inter_org_alert_summary',
      'public.phoenix_query_live_inter_org_alerts_with_state_page',
      'public.phoenix_refresh_inter_org_alert_lifecycle',
    ]);
  });

  it('only ever CREATE OR REPLACEs its own four new functions', () => {
    const created = [...sql.matchAll(/CREATE OR REPLACE FUNCTION\s+(public\.[\w]+)/g)].map(m => m[1]).sort();
    expect(created).toEqual([
      'public._phoenix_live_inter_org_alert_read_projection_v1',
      'public.phoenix_query_live_inter_org_alert_summary',
      'public.phoenix_query_live_inter_org_alerts_with_state_page',
      'public.phoenix_refresh_inter_org_alert_lifecycle',
    ]);
  });

  it('re-asserts every legacy RPC as still present, still granted, still anon-denied', () => {
    for (const legacy of [
      'public.phoenix_get_live_inter_institution_alerts(integer)',
      'public.phoenix_get_live_inter_institution_alerts_with_state(integer)',
      'public.phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer)',
      'public.phoenix_update_inter_org_alert_state(text,text,text,text)',
      'public.phoenix_reopen_inter_org_alert(text,text,text)',
      'public.phoenix_get_inter_org_alert_events(text)',
    ]) {
      expect(verifyBlock, legacy).toContain(`'${legacy}'`);
    }
    expect(verifyBlock).toContain('190 must be additive');
    expect(verifyBlock).toContain('lost authenticated EXECUTE');
    expect(verifyBlock).toContain('became anon-reachable');
  });

  it('asserts the hybrid is still the hybrid — 190 does not neuter the old writer', () => {
    expect(verifyBlock).toContain("NOT LIKE '%INSERT INTO public.inter_org_alert_states%'");
    expect(verifyBlock).toContain('190 must leave it exactly as 189 left it');
  });
});

// ============================================================================
// PREFLIGHT tells the truth about what it depends on.
// ============================================================================
describe('190 · preflight', () => {
  it('requires 189 to have been applied, not merely the base RPC to exist', () => {
    expect(preflightBlock).toContain('_phoenix_availability_material_identity_v1(uuid,text,text,text,text)');
    expect(preflightBlock).toContain('may still be label-matching');
  });

  it('requires every object the new functions touch', () => {
    for (const dep of [
      'public.phoenix_get_live_inter_institution_alerts(integer)',
      'public.phoenix_get_live_inter_institution_alerts_with_state(integer)',
      'public.phoenix_get_live_inter_institution_alerts_with_state_page(integer,integer)',
      'public.inter_org_alert_states',
      'public.inter_org_alert_events',
      'public.organization_status_contacts',
    ]) {
      expect(preflightBlock, dep).toContain(dep);
    }
  });

  it('proves alert_key is uniquely constrained before LEFT JOINing on it', () => {
    // Without this, a duplicated key would multiply rows and silently inflate
    // total_count and every dashboard counter.
    expect(preflightBlock).toContain("contype IN ('p','u')");
    expect(preflightBlock).toContain('could multiply rows');
  });

  it('names every lifecycle and contact column it publishes', () => {
    for (const col of [
      'acknowledged_at', 'in_progress_by', 'dismissed_by', 'first_seen_at',
      'is_primary', 'is_active',
    ]) {
      expect(preflightBlock, col).toContain(col);
    }
  });

  it('every failure raises a labelled 190 precondition error', () => {
    const raises = preflightBlock.match(/RAISE EXCEPTION '([^']+)/g) ?? [];
    expect(raises.length).toBeGreaterThan(8);
    for (const r of raises) expect(r).toContain('190_precondition_failed');
  });
});

// ============================================================================
// VERIFY proves behaviour, not only text.
// ============================================================================
describe('190 · verify', () => {
  it('strips comments before matching, so prose cannot hide DML or fake a failure', () => {
    expect(verifyBlock).toContain("regexp_replace(v_src, E'--[^\\n]*', ' ', 'g')");
  });

  it('asserts purity with word boundaries, over the catalog definition', () => {
    expect(verifyBlock).toContain('pg_get_functiondef');
    for (const pattern of ["'\\\\mINSERT\\\\M'", "'\\\\mUPDATE\\\\M'", "'\\\\mDELETE\\\\M'"]) {
      expect(verifyBlock, pattern).toContain(pattern.replace(/\\\\/g, '\\'));
    }
    expect(verifyBlock).toContain("'ON\\s+CONFLICT'");
  });

  it('makes a data-independent behavioural assertion, armed even on an empty database', () => {
    // auth.uid() is NULL during a migration, so all three surfaces must refuse.
    expect(verifyBlock).toContain("IS DISTINCT FROM 'NOT_AUTHENTICATED'");
    expect(verifyBlock).toContain('phoenix_query_live_inter_org_alerts_with_state_page(10, 0)');
    expect(verifyBlock).toContain('phoenix_query_live_inter_org_alert_summary(10)');
    expect(verifyBlock).toContain('phoenix_refresh_inter_org_alert_lifecycle(10)');
    // …and a refusal must be a refusal, not an ok:true carrying zero rows.
    expect(verifyBlock).toContain('an unauthenticated summary call reported ok');
  });

  it('asserts the ACL contract it claims in its header', () => {
    expect(verifyBlock).toContain("has_function_privilege('anon'");
    expect(verifyBlock).toContain("has_function_privilege('authenticated', 'public._phoenix_live_inter_org_alert_read_projection_v1(integer)', 'EXECUTE')");
    expect(verifyBlock).toContain('the internal projection is directly callable by a client role');
  });

  it('asserts no table-grant widening was used to solve the read', () => {
    expect(verifyBlock).toContain("has_table_privilege('authenticated', 'public.inter_org_alert_events', 'SELECT')");
    expect(verifyBlock).toContain("has_table_privilege('authenticated', 'public.inter_org_alert_states', 'INSERT')");
    expect(verifyBlock).toContain('inter_org_alert_states_select_perm');
  });

  it('asserts the definer/invoker split it documents', () => {
    expect(verifyBlock).toContain('the refresh COMMAND took SECURITY DEFINER it does not need');
    expect(verifyBlock).toContain('must be SECURITY DEFINER to match the hybrid');
  });

  it('every failure raises a labelled 190 verify error', () => {
    const raises = verifyBlock.match(/RAISE EXCEPTION '([^']+)/g) ?? [];
    expect(raises.length).toBeGreaterThan(15);
    for (const r of raises) expect(r).toContain('190 verify failed');
  });

  it('the migration edits no historical file — all scaffolding is 190-labelled', () => {
    expect(scaffolding).toContain('190_precondition_failed');
    expect(scaffolding).toContain('190 verify failed');
    expect(scaffolding).toContain('ALERT-CQRS-BOUNDARY-190');
  });
});

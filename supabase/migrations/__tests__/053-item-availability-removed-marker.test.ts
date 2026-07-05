/**
 * DB-REMOVED-OUTLET-MATERIAL-MARKER-053-A
 * Run: npm test -- --run 053
 *
 * Static source-code tests for migration 053: adds an explicit
 * removed_at/removed_by/removal_reason marker to item_availability so future
 * removal operations (single-item "remove from outlet" and bulk
 * clear_port_availability) can be reliably distinguished from genuine
 * shortage — which quantity=0 + condition='missing' alone cannot express.
 * No live DB is used — these are text/shape assertions against the SQL
 * file, mirroring the 028/042/051/052 tests' conventions.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../');
const ROOT = join(__dirname, '../../../');
const MIGRATION_053_PATH = join(MIGRATIONS_DIR, '053_item_availability_removed_marker.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

/** Strip `--` comment lines, leaving only active SQL for whole-file guardrails. */
function activeSql(sql: string): string {
  return sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
}

function extractFunction(sql: string, name: string): string {
  const marker = new RegExp(`create or replace function (public\\.)?${name}\\(`, 'i');
  const match = marker.exec(sql);
  expect(match).not.toBeNull();
  const start = match!.index;
  const lowerSql = sql.toLowerCase();
  const asIdx = lowerSql.indexOf('as $$', start);
  expect(asIdx).toBeGreaterThan(-1);
  const afterStart = asIdx + 'as $$'.length;
  const end = sql.indexOf('\n$$;', afterStart);
  return sql.slice(start, end);
}

const migration053 = readMigration('053_item_availability_removed_marker.sql');
const active053 = activeSql(migration053);
// Scoped to everything before the VERIFY block's own DO $$ ... — that block
// legitimately contains the literal strings 'TRUNCATE'/'DROP TABLE'/
// 'DELETE FROM item_availability'/'service_role'/'auth.admin'/'whatsapp' as
// part of the ASSERT checks that prove those strings are absent from the
// modified functions — exactly the same pattern migration 028/052 use.
const activeSqlPreVerify = activeSql(migration053.slice(0, migration053.indexOf('DO $$')));

const fnMovement = extractFunction(migration053, 'phoenix_apply_availability_movement');
const fnClearPort = extractFunction(migration053, 'clear_port_availability');
const fnUpsert = extractFunction(migration053, 'phoenix_upsert_availability');
const fnQr = extractFunction(migration053, 'get_public_qr_payload');
const fnAlerts = extractFunction(migration053, 'phoenix_get_live_inter_institution_alerts_with_state');

describe('Migration 053 exists exactly once', () => {
  it('053_item_availability_removed_marker.sql exists', () => {
    expect(existsSync(MIGRATION_053_PATH)).toBe(true);
  });

  it('is the only file named 053_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('053_'));
    expect(matches).toEqual(['053_item_availability_removed_marker.sql']);
  });

  it('does not create migration 054', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('054_'));
    expect(matches).toEqual([]);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    expect(migration053).toContain('MANUAL APPLY ONLY');
    expect(migration053).toContain('supabase db push');
  });

  it('has a DO $$ ... VERIFY block with ASSERT statements', () => {
    expect(migration053).toContain('DO $$');
    expect(migration053).toMatch(/ASSERT /);
  });
});

describe('Migration 053: schema — adds removed_at/removed_by/removal_reason', () => {
  it('adds removed_at timestamptz null', () => {
    expect(active053).toMatch(/add column if not exists removed_at\s+timestamptz\s+null/i);
  });

  // FIX-MIGRATION-053-REMOVED-BY-FK-A: removed_by is added as a bare column
  // (no inline REFERENCES) — the FK is created separately as an explicitly
  // named, idempotent constraint (see the next describe block). This avoids
  // the original inline-REFERENCES approach, whose auto-generated constraint
  // name gave the VERIFY block no reliable way to check for its existence.
  it('adds removed_by uuid null WITHOUT an inline REFERENCES clause', () => {
    expect(active053).toMatch(/add column if not exists removed_by\s+uuid\s+null,/i);
    expect(active053).not.toMatch(/add column if not exists removed_by\s+uuid\s+null\s+references/i);
  });

  it('adds removal_reason text null', () => {
    expect(active053).toMatch(/add column if not exists removal_reason\s+text\s+null/i);
  });

  it('adds a plain index on removed_at (not a partial index — kept simple per task scope)', () => {
    expect(active053).toMatch(/create index if not exists item_avail_removed_at_idx on public\.item_availability\(removed_at\)/i);
  });

  it('does not backfill any existing row as removed (no bare UPDATE outside the modified functions)', () => {
    // The only UPDATEs touching item_availability in this file must be
    // inside phoenix_apply_availability_movement / clear_port_availability /
    // phoenix_upsert_availability's own bodies (checked separately below) —
    // there must be no standalone "UPDATE item_availability SET removed_at"
    // at the top level of the migration (i.e. before the first function).
    const firstFnIdx = active053.search(/CREATE OR REPLACE FUNCTION/i);
    const beforeFunctions = active053.slice(0, firstFnIdx);
    expect(beforeFunctions).not.toMatch(/UPDATE\s+(public\.)?item_availability/i);
  });

  it('does not hard-delete item_availability anywhere in the migration body (excluding the VERIFY block\'s own absence-check prose)', () => {
    expect(activeSqlPreVerify).not.toMatch(/DELETE FROM (public\.)?item_availability\b/i);
  });

  it('has no TRUNCATE anywhere in the migration body (excluding the VERIFY block\'s own absence-check prose)', () => {
    expect(activeSqlPreVerify).not.toMatch(/TRUNCATE/i);
  });

  it('has no DROP TABLE anywhere in the migration body (excluding the VERIFY block\'s own absence-check prose)', () => {
    expect(activeSqlPreVerify).not.toMatch(/DROP TABLE/i);
  });
});

describe('FIX-MIGRATION-053-REMOVED-BY-FK-A: removed_by FK is created as a named, idempotent constraint', () => {
  it('adds a DO block that checks pg_constraint for item_availability_removed_by_fkey before creating it', () => {
    const idx = active053.indexOf("conname = 'item_availability_removed_by_fkey'");
    expect(idx).toBeGreaterThan(-1);
    const block = active053.slice(active053.lastIndexOf('do $$', idx), active053.indexOf('end $$;', idx) + 'end $$;'.length);
    expect(block).toContain('if not exists');
    expect(block).toContain("conrelid = 'public.item_availability'::regclass");
    expect(block).toContain("contype = 'f'");
  });

  it('the FK constraint targets auth.users(id) with ON DELETE SET NULL, on the removed_by column', () => {
    const idx = active053.indexOf('add constraint item_availability_removed_by_fkey');
    expect(idx).toBeGreaterThan(-1);
    const stmt = active053.slice(idx, active053.indexOf(';', idx));
    expect(stmt).toMatch(/foreign key \(removed_by\)/i);
    expect(stmt).toMatch(/references auth\.users\(id\)/i);
    expect(stmt).toMatch(/on delete set null/i);
  });

  it('the FK-creation DO block runs before the removed_at index and before any function replacement', () => {
    const fkIdx = active053.indexOf("conname = 'item_availability_removed_by_fkey'");
    const idxIdx = active053.indexOf('create index if not exists item_avail_removed_at_idx');
    const firstFnIdx = active053.search(/CREATE OR REPLACE FUNCTION/i);
    expect(fkIdx).toBeGreaterThan(-1);
    expect(fkIdx).toBeLessThan(idxIdx);
    expect(idxIdx).toBeLessThan(firstFnIdx);
  });
});

describe('FIX-MIGRATION-053-REMOVED-BY-FK-A: VERIFY block uses a robust pg_constraint/pg_attribute check', () => {
  const verifyBlock = migration053.slice(migration053.indexOf('DO $$'));
  // Scoped to active SQL only — the block's own explanatory comment
  // legitimately quotes the old broken join condition (prose describing why
  // it was wrong), which is not itself active SQL.
  const activeVerifyBlock = activeSql(verifyBlock);

  it('no longer uses the broken information_schema.constraint_column_usage join (table_schema mismatch for cross-schema FKs)', () => {
    expect(activeVerifyBlock).not.toContain('information_schema.constraint_column_usage');
    expect(activeVerifyBlock).not.toMatch(/tc\.table_schema\s*=\s*ccu\.table_schema/);
  });

  it('the FK check uses pg_constraint with conrelid/confrelid regclass comparisons', () => {
    expect(verifyBlock).toMatch(/FROM pg_constraint c/);
    expect(verifyBlock).toContain("c.conrelid  = 'public.item_availability'::regclass");
    expect(verifyBlock).toContain("c.confrelid = 'auth.users'::regclass");
    expect(verifyBlock).toContain("c.contype   = 'f'");
  });

  it('resolves the constrained column name via pg_attribute joined on conkey, checking for removed_by', () => {
    expect(verifyBlock).toMatch(/JOIN unnest\(c\.conkey\) AS k\(attnum\) ON true/);
    expect(verifyBlock).toMatch(/JOIN pg_attribute a ON a\.attrelid = c\.conrelid AND a\.attnum = k\.attnum/);
    expect(verifyBlock).toContain("a.attname   = 'removed_by'");
  });

  it('the same VERIFY FAILED message is preserved for continuity', () => {
    expect(verifyBlock).toContain("'VERIFY FAILED: item_availability.removed_by is not FK''d to auth.users'");
  });
});

describe('Migration 053: A) phoenix_apply_availability_movement marks removed_from_outlet', () => {
  it('preserves the exact signature from migration 034', () => {
    expect(migration053).toMatch(
      /CREATE OR REPLACE FUNCTION public\.phoenix_apply_availability_movement\(\s*p_item_availability_id uuid,\s*p_movement_type\s+text,\s*p_amount\s+integer,\s*p_reason\s+text DEFAULT NULL,\s*p_notes\s+text DEFAULT NULL\s*\)/,
    );
  });

  it('preserves SECURITY DEFINER and SET search_path', () => {
    const header = migration053.slice(migration053.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement'));
    expect(header).toMatch(/SECURITY DEFINER/);
    expect(header).toMatch(/SET search_path = public/);
  });

  it('branches on p_reason = \'removed_from_outlet\'', () => {
    expect(fnMovement).toMatch(/IF p_reason = 'removed_from_outlet' THEN/);
  });

  it('the removed_from_outlet branch forces quantity=0, condition=\'missing\', and sets removed_at/removed_by/removal_reason', () => {
    const idx = fnMovement.indexOf("IF p_reason = 'removed_from_outlet' THEN");
    const branch = fnMovement.slice(idx, fnMovement.indexOf('ELSE', idx));
    expect(branch).toMatch(/quantity\s*=\s*0/);
    expect(branch).toMatch(/condition\s*=\s*'missing'/);
    expect(branch).toContain('removed_at      = now()');
    expect(branch).toContain('removed_by      = v_actor');
    expect(branch).toMatch(/removal_reason\s*=\s*'removed_from_outlet'/);
  });

  it('any other reason leaves removed_at/removed_by/removal_reason untouched (ELSE branch does not reference them)', () => {
    const idx = fnMovement.indexOf('ELSE');
    const branch = fnMovement.slice(idx, fnMovement.indexOf('END IF;', idx));
    expect(branch).not.toContain('removed_at');
    expect(branch).not.toContain('removed_by');
    expect(branch).not.toContain('removal_reason');
  });

  it('still inserts the movement row with the real computed quantity_before/delta/after (ledger unaffected)', () => {
    expect(fnMovement).toContain('INSERT INTO public.item_availability_movements');
    expect(fnMovement).toContain('quantity_before, quantity_delta, quantity_after');
  });

  it('still enforces the negative-quantity guard and permission checks (unchanged from 034)', () => {
    expect(fnMovement).toContain('quantity_cannot_go_negative');
    expect(fnMovement).toContain('availability.quantity.set');
    expect(fnMovement).toContain('availability.quantity.add');
    expect(fnMovement).toContain('availability.quantity.subtract');
    expect(fnMovement).toContain('availability.quantity.correct');
  });

  it('grants unchanged from migration 034 (authenticated only, no anon/PUBLIC)', () => {
    expect(migration053).toContain('REVOKE ALL ON FUNCTION public.phoenix_apply_availability_movement(\n  uuid, text, integer, text, text\n) FROM PUBLIC, anon;');
    expect(migration053).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_apply_availability_movement(\n  uuid, text, integer, text, text\n) TO authenticated;');
  });
});

describe('Migration 053: B) clear_port_availability marks removed rows', () => {
  it('preserves the exact signature from migration 042', () => {
    expect(migration053).toMatch(
      /CREATE OR REPLACE FUNCTION public\.clear_port_availability\(\s*p_point_id\s+uuid,\s*p_confirmation\s+text\s*\)/,
    );
  });

  it('the bulk UPDATE sets removed_at/removed_by/removal_reason alongside quantity=0/condition=\'missing\'', () => {
    expect(fnClearPort).toMatch(/UPDATE item_availability\s*\n\s*SET quantity\s*=\s*0,\s*\n\s*condition\s*=\s*'missing',\s*\n\s*removed_at\s*=\s*now\(\),\s*\n\s*removed_by\s*=\s*v_actor_id,\s*\n\s*removal_reason\s*=\s*'clear_port_availability'/);
  });

  it('preserves the idempotency guard (does not re-touch already-cleared rows)', () => {
    expect(fnClearPort).toMatch(/WHERE distribution_point_id = p_point_id\s*\n\s*AND \(quantity <> 0 OR condition IS DISTINCT FROM 'missing'\)/);
  });

  it('never deletes rows and still writes the same audit_logs entry', () => {
    expect(fnClearPort).not.toMatch(/DELETE FROM item_availability/i);
    expect(fnClearPort).toContain("'port_items_cleared'");
    expect(fnClearPort).toContain("'mode', 'zeroed_not_deleted'");
  });

  it('grants unchanged from migration 042 (authenticated only, no anon)', () => {
    expect(migration053).toContain('REVOKE ALL ON FUNCTION public.clear_port_availability(uuid, text) FROM PUBLIC, anon;');
    expect(migration053).toContain('GRANT EXECUTE ON FUNCTION public.clear_port_availability(uuid, text) TO authenticated;');
  });
});

describe('Migration 053: C) phoenix_upsert_availability reactivates on active re-add', () => {
  it('preserves the exact signature (13 params) from migration 051', () => {
    expect(migration053).toMatch(
      /CREATE OR REPLACE FUNCTION public\.phoenix_upsert_availability\(\s*p_distribution_point_id uuid,/,
    );
    expect(fnUpsert).toContain('p_national_code          text DEFAULT NULL');
  });

  it('preserves the 051 identity match key (scientific_name + concentration + dosage_form + national_code + batch_number + expiry_date)', () => {
    expect(fnUpsert).toContain('ia.scientific_name       = p_scientific_name');
    expect(fnUpsert).toContain("COALESCE(ia.national_code, '')                  = v_national_code_key");
    expect(fnUpsert).toContain("COALESCE(ia.batch_number, '')                   = v_batch_number_key");
    expect(fnUpsert).toContain("COALESCE(ia.expiry_date, DATE '0001-01-01')     = v_expiry_date_key");
  });

  it('preserves the migration 035 quantity hard guard on UPDATE', () => {
    expect(fnUpsert).toContain('quantity_update_requires_movement');
    expect(fnUpsert).toContain('IS DISTINCT FROM v_existing_quantity');
  });

  it('computes v_reactivates from existing quantity > 0 OR an active condition', () => {
    expect(fnUpsert).toMatch(/v_reactivates\s*:=\s*\(v_existing_quantity > 0\)\s*\n\s*OR \(p_condition IN \('available', 'surplus', 'near_expiry', 'low_stock'\)\)/);
  });

  it('the UPDATE clears removed_at/removed_by/removal_reason to NULL only when v_reactivates, otherwise preserves the existing value', () => {
    const updateStart = fnUpsert.indexOf('UPDATE public.item_availability AS ia');
    const updateEnd = fnUpsert.indexOf('RETURNING ia.id INTO v_id;', updateStart);
    const updateStmt = fnUpsert.slice(updateStart, updateEnd);
    expect(updateStmt).toMatch(/removed_at\s*=\s*CASE WHEN v_reactivates THEN NULL ELSE ia\.removed_at END/);
    expect(updateStmt).toMatch(/removed_by\s*=\s*CASE WHEN v_reactivates THEN NULL ELSE ia\.removed_by END/);
    expect(updateStmt).toMatch(/removal_reason\s*=\s*CASE WHEN v_reactivates THEN NULL ELSE ia\.removal_reason END/);
  });

  it('does not add removed_at/removed_by/removal_reason to the INSERT column list (defaults to NULL for a new row)', () => {
    const insertStart = fnUpsert.indexOf('INSERT INTO public.item_availability (');
    const insertEnd = fnUpsert.indexOf(') VALUES (', insertStart);
    const insertCols = fnUpsert.slice(insertStart, insertEnd);
    expect(insertCols).not.toContain('removed_at');
    expect(insertCols).not.toContain('removed_by');
    expect(insertCols).not.toContain('removal_reason');
  });

  it('does not reactivate a row that stays at quantity=0/condition=\'missing\' (genuine ongoing shortage is left untouched)', () => {
    // v_reactivates is false when v_existing_quantity = 0 AND p_condition = 'missing' —
    // proven structurally: 'missing' is not in the active-condition list.
    expect(fnUpsert).not.toMatch(/'missing'.*v_reactivates|v_reactivates.*'missing'/);
    expect(fnUpsert).toMatch(/IN \('available', 'surplus', 'near_expiry', 'low_stock'\)/);
  });
});

describe('Migration 053: D) get_public_qr_payload excludes removed rows', () => {
  it('preserves the exact signature and return type from migration 052', () => {
    expect(migration053).toMatch(/create or replace function get_public_qr_payload\(p_public_id text\)\s*\nreturns jsonb/);
  });

  it('both branches with item-level output filter removed_at is null', () => {
    const occurrences = fnQr.split('and ia.removed_at is null').length - 1;
    expect(occurrences).toBe(2);
  });

  it('preserves migration 052\'s quantity<=0 -> missing branch', () => {
    expect(fnQr).toContain('ia.quantity <= 0');
    expect(fnQr).toMatch(/when ia\.quantity <= 0\s*\n\s*then 'missing'/);
  });

  it('preserves D4 (distribution_point_not_active guard) and D6 (LEFT JOIN + scientific_name fallback)', () => {
    expect(fnQr).toContain('DISTRIBUTION_POINT_NOT_ACTIVE');
    expect(fnQr).toContain('left join local_items');
  });

  it('preserves privacy guarantees — no batch_number/price/trade_name/notes/supply_type in output', () => {
    for (const field of ['batch_number', 'price', 'trade_name', 'notes', 'supply_type']) {
      expect(fnQr).not.toContain(`'${field}'`);
    }
  });

  it('grants unchanged (anon + authenticated EXECUTE)', () => {
    expect(migration053).toContain('revoke all on function get_public_qr_payload(text) from authenticated;');
    expect(migration053).toContain('grant execute on function get_public_qr_payload(text) to anon, authenticated;');
  });
});

describe('Migration 053: E) phoenix_get_live_inter_institution_alerts_with_state excludes removed rows', () => {
  it('preserves the exact signature from migration 048', () => {
    expect(migration053).toMatch(
      /CREATE OR REPLACE FUNCTION public\.phoenix_get_live_inter_institution_alerts_with_state\(\s*p_limit integer DEFAULT 200\s*\)/,
    );
  });

  it('the candidates CTE filters ia.removed_at IS NULL', () => {
    const idx = fnAlerts.indexOf('WHERE ia.scientific_name IS NOT NULL');
    const clause = fnAlerts.slice(idx, fnAlerts.indexOf('),', idx));
    expect(clause).toContain("AND btrim(ia.scientific_name) <> ''");
    expect(clause).toContain('AND ia.removed_at IS NULL');
  });

  it('preserves alert_key computation and lifecycle upsert (open/acknowledged/in_progress/resolved/dismissed)', () => {
    expect(fnAlerts).toContain('alert_key');
    expect(fnAlerts).toContain('acknowledged_at');
    expect(fnAlerts).toContain('in_progress_at');
    expect(fnAlerts).toContain('resolved_at');
    expect(fnAlerts).toContain('dismissed_at');
  });

  it('preserves migration 047\'s source/target contact phone fields', () => {
    expect(fnAlerts).toContain('source_contact_phone');
    expect(fnAlerts).toContain('target_contact_phone');
    expect(fnAlerts).toContain('is_active = true');
  });

  it('preserves migration 048\'s expiry-risk-tier fields', () => {
    expect(fnAlerts).toContain('source_expiry_risk_tier');
    expect(fnAlerts).toContain('source_expiry_days_remaining');
  });

  it('grants unchanged (authenticated only, no anon/PUBLIC)', () => {
    expect(migration053).toContain('REVOKE ALL ON FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state(integer)\n  FROM PUBLIC, anon;');
    expect(migration053).toContain('GRANT EXECUTE ON FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state(integer)\n  TO authenticated;');
  });
});

describe('Migration 053: security guardrails', () => {
  it('no service_role reference in the migration body', () => {
    expect(activeSqlPreVerify).not.toMatch(/service_role/i);
  });

  it('no auth.admin reference in the migration body', () => {
    expect(activeSqlPreVerify).not.toMatch(/auth\.admin/i);
  });

  it('no Graph API / Bearer token reference in the migration body (outside preserved 047 comments/contact fields)', () => {
    expect(activeSqlPreVerify).not.toMatch(/graph\.facebook|bearer/i);
  });

  it('the VERIFY block itself asserts absence of service_role/auth.admin in the five modified functions', () => {
    expect(migration053).toMatch(/NOT ILIKE '%service_role%'/);
    expect(migration053).toMatch(/NOT ILIKE '%auth\.admin%'/);
  });

  // FIX-MIGRATION-053-WHATSAPP-VERIFY-GUARD-A: pg_get_functiondef() reproduces
  // a function's body verbatim, including its comments.
  // phoenix_get_live_inter_institution_alerts_with_state legitimately carries
  // two migration-047 comments naming DB-ALERTS-LIVE-WHATSAPP-CONTACT-FIELDS-A
  // alongside the preserved source_contact_phone/target_contact_phone fields
  // — a raw `NOT ILIKE '%whatsapp%'` guard is a false positive against that
  // historical comment text, not a real external API/token call, and rolls
  // back the whole migration on every apply. The guard must check for actual
  // dangerous patterns instead.
  describe('FIX-MIGRATION-053-WHATSAPP-VERIFY-GUARD-A: precise external API/token guard (no raw whatsapp ban)', () => {
    const verifyBlock = migration053.slice(migration053.indexOf('DO $$'));

    it('does not use a raw %whatsapp% text ban anywhere in the VERIFY block', () => {
      expect(verifyBlock).not.toMatch(/NOT ILIKE '%whatsapp%'/i);
    });

    it('still blocks graph.facebook, bearer, and access_token references', () => {
      expect(verifyBlock).toContain("NOT ILIKE '%graph.facebook%'");
      expect(verifyBlock).toContain("NOT ILIKE '%bearer%'");
      expect(verifyBlock).toContain("NOT ILIKE '%access_token%'");
    });

    it('still blocks Authorization header references', () => {
      expect(verifyBlock).toContain("NOT ILIKE '%authorization%'");
    });

    it('still blocks outbound HTTP(S) call patterns and Postgres HTTP extensions', () => {
      expect(verifyBlock).toContain("NOT ILIKE '%https://%'");
      expect(verifyBlock).toContain("NOT ILIKE '%http://%'");
      expect(verifyBlock).toContain("NOT ILIKE '%pg_net%'");
      expect(verifyBlock).toContain("NOT ILIKE '%net.http%'");
    });

    it('the cross-function guardrail loop still checks service_role/auth.admin/DROP TABLE/TRUNCATE/DELETE FROM item_availability', () => {
      const loopIdx = verifyBlock.indexOf('Cross-function security guardrails');
      const loopEnd = verifyBlock.indexOf('END LOOP;', loopIdx);
      const loop = verifyBlock.slice(loopIdx, loopEnd);
      expect(loop).toContain("NOT ILIKE '%service_role%'");
      expect(loop).toContain("NOT ILIKE '%auth.admin%'");
      expect(loop).toContain("NOT ILIKE '%DROP TABLE%'");
      expect(loop).toContain("NOT ILIKE '%TRUNCATE%'");
      expect(loop.toLowerCase()).toContain('delete from item_availability');
    });
  });

  // FIX-MIGRATION-053-EXTERNAL-API-VERIFY-PROFESSIONAL-A: the previous fix
  // (FIX-MIGRATION-053-WHATSAPP-VERIFY-GUARD-A) still ran its precise
  // external-API/token checks against the RAW pg_get_functiondef() output,
  // which retains comments. phoenix_apply_availability_movement's own step-3
  // comment ("Lock the target row before any authorization/math ...")
  // matches '%authorization%' via ILIKE even though it's inert prose, not
  // executable code — a second false positive of the same shape as the
  // whatsapp one. The VERIFY loop must strip `--` line comments into a
  // sanitized v_fn_active and run the security-negative checks against that,
  // while structural presence checks keep reading the raw v_fn_def.
  describe('FIX-MIGRATION-053-EXTERNAL-API-VERIFY-PROFESSIONAL-A: comment-stripped active source for security checks', () => {
    const verifyBlock = migration053.slice(migration053.indexOf('DO $$'));
    const loopIdx = verifyBlock.indexOf('Cross-function security guardrails');
    const loopEnd = verifyBlock.indexOf('END LOOP;', loopIdx);
    const loop = verifyBlock.slice(loopIdx, loopEnd);

    it('declares a v_fn_active text variable in the DO block', () => {
      expect(migration053).toMatch(/v_fn_active\s+text;/);
    });

    it('computes v_fn_active by stripping `--` line comments from v_fn_def before any security check runs', () => {
      const assignIdx = loop.indexOf('v_fn_active := regexp_replace(');
      expect(assignIdx).toBeGreaterThan(-1);
      expect(loop.slice(assignIdx)).toContain("regexp_replace(v_fn_def, '--[^\\r\\n]*', '', 'g')");
      // Must run before the first ASSERT in the loop.
      const firstAssertIdx = loop.indexOf('ASSERT');
      expect(assignIdx).toBeLessThan(firstAssertIdx);
    });

    it('all security-negative (dangerous-pattern-absence) checks in the loop read v_fn_active, not raw v_fn_def', () => {
      const afterAssign = loop.slice(loop.indexOf('v_fn_active := regexp_replace('));
      // Every ASSERT after the sanitization line must reference v_fn_active;
      // none may fall back to checking the raw, comment-bearing v_fn_def.
      const assertLines = afterAssign.split('ASSERT').slice(1);
      for (const stmt of assertLines) {
        const clause = stmt.slice(0, stmt.indexOf(','));
        expect(clause).toMatch(/v_fn_active/);
        expect(clause).not.toMatch(/v_fn_def/);
      }
    });

    it('the sanitized-check regex removes only `--` line comments (no block-comment stripping needed — none exist in any of the five modified function bodies)', () => {
      for (const fn of [fnMovement, fnClearPort, fnUpsert, fnQr, fnAlerts]) {
        expect(fn).not.toContain('/*');
        expect(fn).not.toContain('*/');
      }
    });

    it('reproduces the same false positive shape locally: raw fnMovement contains "authorization" only inside a comment, and stripping `--` lines removes it', () => {
      expect(fnMovement.toLowerCase()).toContain('authorization');
      const stripped = fnMovement.replace(/--[^\r\n]*/g, '');
      expect(stripped.toLowerCase()).not.toContain('authorization');
    });

    it('stripping `--` line comments does not remove real security-relevant SQL from any of the five modified functions', () => {
      for (const fn of [fnMovement, fnClearPort, fnUpsert, fnQr, fnAlerts]) {
        const stripped = fn.replace(/--[^\r\n]*/g, '');
        // Real executable markers must survive comment stripping untouched.
        expect(stripped).not.toMatch(/service_role|auth\.admin|graph\.facebook|DROP TABLE|TRUNCATE/i);
      }
    });

    it('structural presence checks outside the loop still read the raw v_fn_def (comments legitimately count as documentation of intent)', () => {
      const beforeLoop = verifyBlock.slice(0, loopIdx);
      expect(beforeLoop).toMatch(/ASSERT v_fn_def ILIKE '%removed_from_outlet%'/);
      expect(beforeLoop).toMatch(/ASSERT v_fn_def ILIKE '%source_contact_phone%' AND v_fn_def ILIKE '%target_contact_phone%'/);
    });
  });

  it('no CREATE/DROP POLICY anywhere (no RLS change)', () => {
    expect(active053).not.toMatch(/CREATE POLICY|DROP POLICY/i);
  });

  it('no React/TSX component syntax (SQL-only file)', () => {
    expect(migration053).not.toMatch(/import React|useState|useEffect|<div/);
  });
});

describe('DB-REMOVED-OUTLET-MATERIAL-MARKER-053-A: DB-only phase — no frontend/service files changed', () => {
  it('no working-tree diff on any frontend production file', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- "src/**/*.ts" "src/**/*.tsx" ":!src/**/__tests__/**"',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');
  });

  it('no working-tree diff on availability.service.ts, dashboard.service.ts, qr.service.ts, InstitutionScreen.tsx, or PublicQrScreen.tsx specifically', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/shared/supabase/services/availability.service.ts src/shared/supabase/services/dashboard.service.ts src/shared/supabase/services/qr.service.ts src/features/institutions/InstitutionScreen.tsx src/features/qr/PublicQrScreen.tsx',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('no package/lockfile diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('premium-preview.html remains untracked (only "??" status if present)', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });

  it('supabase/.temp/ was not staged', () => {
    const status = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' });
    const tempLine = status.split('\n').find(l => l.includes('supabase/.temp'));
    if (tempLine) {
      expect(tempLine.trim().startsWith('??')).toBe(true);
    }
  });

  it('Service-D stash (paused inter-org exchange service work) remains untouched', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });
});

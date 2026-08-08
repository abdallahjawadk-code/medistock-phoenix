/**
 * 167 · DISPATCH-LINE FULL-REJECTION RECONCILIATION — static proof.
 *
 * Source-level guards that need no database. Two jobs here:
 *
 *   1. Prove the replacement constraint is 061's text with EXACTLY ONE clause
 *      changed. That is asserted structurally — every other branch is compared
 *      character-for-character against the real 061 file — rather than by
 *      eyeballing a diff. A migration that silently relaxed 'accepted' while
 *      claiming to fix 'rejected' would fail here.
 *
 *   2. Prove the NON-GOALS. 167 replaces no function, creates no object, grants
 *      nothing, and edits no earlier migration. The assertions are deliberately
 *      weighted toward what is ABSENT.
 *
 * Behavioural proof — that a full rejection now completes through the real RPC
 * and that the header recomputes to 'rejected' — lives in the sibling
 * *.dynamic.test.ts, which drives a real 001->167 rig.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';
import { activeSql, executableSql, normalizeSql } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const NAME = '167_phoenix_dispatch_line_full_rejection_reconciliation.sql';
const read = (f: string) =>
  readFileSync(join(ROOT, 'supabase/migrations', f), 'utf8').replace(/\r\n?/g, '\n');

const sql = read(NAME);
const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'));
/** Comments stripped — prose must never satisfy an assertion. */
const active = activeSql(code);
/** Comments stripped AND string literals blanked — for negative assertions. */
const exec = executableSql(code);

// The immutable predecessors this migration reconciles.
const sql061 = read('061_phoenix_warehouse_dispatch_schema.sql');
const sql069 = read('069_phoenix_institution_to_central_return.sql');
const sql071 = read('071_phoenix_outlet_to_institution_return.sql');

/**
 * The body of a `CASE status ... END` decision CHECK, split into its per-status
 * branches. Comments are stripped first so the explanatory prose that surrounds
 * 061's constraint cannot leak into a branch and make a comparison pass.
 */
function decisionBranches(source: string, constraintName: string): Map<string, string> {
  const stripped = activeSql(source);
  const at = stripped.indexOf(`CONSTRAINT ${constraintName}`);
  expect(at, `${constraintName} must be present`).toBeGreaterThan(-1);

  // Bounded by the CASE's own END, not by "the next constraint": the last
  // constraint in a table has no next one.
  const caseStart = stripped.indexOf('CASE status', at);
  expect(caseStart).toBeGreaterThan(-1);
  const caseEnd = stripped.indexOf('ELSE false', caseStart);
  expect(caseEnd).toBeGreaterThan(caseStart);
  const body = stripped.slice(caseStart, caseEnd);

  const branches = new Map<string, string>();
  const re = /WHEN '([a-z_]+)' THEN([\s\S]*?)(?=WHEN '|$)/g;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    branches.set(m[1], normalizeSql(m[2]));
  }
  return branches;
}

const ours = decisionBranches(code, 'warehouse_dispatch_lines_decision_chk');
const theirs = decisionBranches(sql061, 'warehouse_dispatch_lines_decision_chk');

// ============================================================================
// 1. Registration and shape
// ============================================================================

describe('1. 167 registration and shape', () => {
  it('is registered exactly once, immediately after 166', () => {
    // Position relative to its predecessor, not "is last": asserting last would
    // force the next migration to edit this file. 167 was authored on its own
    // branch concurrently with Stage E's 166 (a separate, independent
    // migration authored on its own branch) and did not wait for it; now that
    // both are merged and registered in their real numeric order, 167's
    // predecessor in the registry is 166.
    expect(REVIEWED_MIGRATION_FILES.filter(f => f === NAME)).toEqual([NAME]);
    const i = REVIEWED_MIGRATION_FILES.indexOf(NAME);
    expect(i).toBeGreaterThan(0);
    expect(REVIEWED_MIGRATION_FILES[i - 1])
      .toBe('166_phoenix_initial_provisioning_invariant.sql');
  });

  it('is a single transaction, manual-apply only', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('\nCOMMIT;');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
  });

  it('fails closed on preconditions and verifies in-transaction', () => {
    expect(active).toContain('PREFLIGHT FAILED (167)');
    expect(active).toContain('VERIFY FAILED (167)');
  });

  it('documents a manual rollback', () => {
    expect(sql).toMatch(/ROLLBACK \(manual\)/);
  });

  it('records WHY the constraint, not the writer, was moved', () => {
    // The decision is the substance of this migration; it must be written down
    // where the next reader of the constraint will find it.
    expect(sql).toMatch(/069/);
    expect(sql).toMatch(/071/);
    expect(sql).toMatch(/COALESCE\(received_quantity, 0\)/);
  });
});

// ============================================================================
// 2. The replacement constraint: ONE clause changed, everything else identical
// ============================================================================

describe('2. the replacement is 061 with exactly one clause changed', () => {
  it('replaces the constraint by name, dropping then re-adding it', () => {
    expect(active).toMatch(
      /ALTER TABLE public\.warehouse_dispatch_lines\s+DROP CONSTRAINT warehouse_dispatch_lines_decision_chk;/,
    );
    expect(active).toMatch(
      /ALTER TABLE public\.warehouse_dispatch_lines\s+ADD CONSTRAINT warehouse_dispatch_lines_decision_chk/,
    );
  });

  it('covers every status 061 covered, and no new one', () => {
    expect([...ours.keys()].sort()).toEqual(
      ['accepted', 'accepted_with_difference', 'cancelled', 'pending', 'rejected'].sort(),
    );
    expect([...ours.keys()].sort()).toEqual([...theirs.keys()].sort());
  });

  it('still refuses an unknown status', () => {
    expect(active).toContain('ELSE false');
  });

  // ── The four untouched branches, character for character ─────────────────
  for (const status of ['pending', 'accepted', 'accepted_with_difference', 'cancelled']) {
    it(`the '${status}' branch is identical to 061's`, () => {
      expect(ours.get(status)).toBe(theirs.get(status));
    });
  }

  // ── The one changed branch ───────────────────────────────────────────────
  it("the 'rejected' branch is the ONLY one that differs from 061", () => {
    expect(ours.get('rejected')).not.toBe(theirs.get('rejected'));
    const changed = [...ours.keys()].filter(s => ours.get(s) !== theirs.get(s));
    expect(changed).toEqual(['rejected']);
  });

  it("the 'rejected' branch requires received_quantity = 0, guarded against NULL", () => {
    const r = ours.get('rejected')!;
    expect(r).toContain('received_quantity IS NOT NULL');
    expect(r).toContain('received_quantity = 0');
    // The guard must come BEFORE the comparison, so a NULL short-circuits the
    // AND-chain to FALSE instead of leaving the whole predicate NULL.
    expect(r.indexOf('received_quantity IS NOT NULL')).toBeLessThan(r.indexOf('received_quantity = 0'));
  });

  it("the 'rejected' branch no longer requires received_quantity IS NULL", () => {
    expect(ours.get('rejected')).not.toMatch(/received_quantity IS NULL/);
    // 061's did — this is what makes the assertion above a real change.
    expect(theirs.get('rejected')).toMatch(/received_quantity IS NULL/);
  });

  it("the 'rejected' branch keeps EVERY other requirement it had", () => {
    const r = ours.get('rejected')!;
    expect(r).toContain("rejection_reason IS NOT NULL AND btrim(rejection_reason) <> ''");
    expect(r).toContain('rejected_at IS NOT NULL');
    expect(r).toContain('accepted_by IS NULL');
    expect(r).toContain('accepted_at IS NULL');
    expect(r).toContain('difference_reason IS NULL');
    expect(r).toContain('resulting_item_availability_id IS NULL');
    expect(r).toContain('resulting_movement_id IS NULL');
  });

  it('the change is a MOVE, not a widening: NULL and 0 are never both legal', () => {
    // A rejected line has exactly one legal received_quantity, before and after.
    // The IS NOT NULL guard is what makes that true under three-valued logic.
    const r = ours.get('rejected')!;
    expect(r).not.toMatch(/received_quantity IS NULL OR/);
    expect(r).not.toMatch(/OR received_quantity IS NULL/);
    expect(r).not.toMatch(/received_quantity IS NULL/);
  });
});

// ============================================================================
// 3. 061's retention contract survives (the reason 061 removed four clauses)
// ============================================================================

describe("3. 061's retention contract is preserved", () => {
  // Every one of these columns is ON DELETE SET NULL by design. Requiring any
  // of them non-null would make a deciding user undeletable and would abort
  // migration 055's Deep Clean. 061:1218-1233 removed them; 062:1535-1547
  // re-asserts their absence; 167 must not reintroduce them.
  for (const clause of [
    'accepted_by IS NOT NULL',
    'rejected_by IS NOT NULL',
    'resulting_item_availability_id IS NOT NULL',
    'resulting_movement_id IS NOT NULL',
  ]) {
    it(`the new constraint never requires ${clause}`, () => {
      const whole = [...ours.values()].join(' | ');
      expect(whole).not.toContain(clause);
    });
  }

  it('re-asserts all four on the LIVE definition at apply time', () => {
    // Not merely absent from this file's text — checked against
    // pg_get_constraintdef inside the migration's own VERIFY block.
    expect(active).toContain('pg_get_constraintdef');
    expect(active).toContain('retention contract broken');
    for (const clause of [
      'accepted_by IS NOT NULL',
      'rejected_by IS NOT NULL',
      'resulting_item_availability_id IS NOT NULL',
      'resulting_movement_id IS NOT NULL',
    ]) {
      expect(active).toContain(clause);
    }
  });

  it('the newly required column is not an FK, so nothing can null it', () => {
    // received_quantity is declared as a plain integer in 061 — no REFERENCES.
    expect(sql061).toMatch(/received_quantity\s+integer/);
    expect(sql061).not.toMatch(/received_quantity\s+integer[^,\n]*REFERENCES/);
  });
});

// ============================================================================
// 4. Data safety: backfill BEFORE tighten, and only the one column
// ============================================================================

describe('4. the backfill is ordered, narrow and self-checked', () => {
  /**
   * DROP -> BACKFILL -> ADD, in that order, and the order is the whole point.
   *
   * "Backfill first, then tighten" is the instinctive sequence and it is WRONG
   * here: the old rule requires `received_quantity IS NULL` for a rejected line,
   * so writing 0 while it is still installed violates it and the migration
   * aborts. The failure is invisible on a database with no rejected rows (the
   * UPDATE matches nothing), so only a test that plants a legacy row catches it —
   * see 167-dispatch-line-full-rejection-backfill.dynamic.test.ts, which is what
   * caught it. This assertion locks the corrected order in place.
   */
  it('drops the old constraint, THEN backfills, THEN adds the new one', () => {
    const dropAt = active.indexOf('DROP CONSTRAINT warehouse_dispatch_lines_decision_chk');
    const backfillAt = active.indexOf('SET received_quantity = 0');
    const addAt = active.indexOf('ADD CONSTRAINT warehouse_dispatch_lines_decision_chk');

    expect(dropAt).toBeGreaterThan(-1);
    expect(backfillAt).toBeGreaterThan(-1);
    expect(addAt).toBeGreaterThan(-1);

    expect(dropAt).toBeLessThan(backfillAt);
    expect(backfillAt).toBeLessThan(addAt);
  });

  it('does the whole sequence in ONE transaction', () => {
    // The table is briefly without a decision rule between the drop and the add.
    // That is only safe because it is transactional: DROP/ADD CONSTRAINT hold
    // ACCESS EXCLUSIVE, so no other session observes the gap, and an abort
    // restores the old constraint by rollback.
    const begins = (sql.match(/^BEGIN;$/gm) ?? []).length;
    const commits = (sql.match(/^COMMIT;$/gm) ?? []).length;
    expect(begins).toBe(1);
    expect(commits).toBe(1);
    expect(sql.indexOf('BEGIN;')).toBeLessThan(
      sql.indexOf('DROP CONSTRAINT warehouse_dispatch_lines_decision_chk'),
    );
    expect(sql.indexOf('ADD CONSTRAINT warehouse_dispatch_lines_decision_chk')).toBeLessThan(
      sql.indexOf('\nCOMMIT;'),
    );
    // No intermediate commit could expose the unconstrained window.
    const between = sql.slice(
      sql.indexOf('DROP CONSTRAINT warehouse_dispatch_lines_decision_chk'),
      sql.indexOf('ADD CONSTRAINT warehouse_dispatch_lines_decision_chk'),
    );
    expect(between).not.toMatch(/^COMMIT;$/m);
  });

  it('touches only rejected rows whose quantity is NULL', () => {
    expect(normalizeSql(active)).toMatch(
      /UPDATE public\.warehouse_dispatch_lines SET received_quantity = 0 WHERE status = 'rejected' AND received_quantity IS NULL;/,
    );
  });

  it('writes received_quantity ONLY — never status, so no trigger fires', () => {
    // 070:1253's header-sync trigger is AFTER UPDATE **OF status**. A backfill
    // that also wrote status would recompute headers as a side effect.
    //
    // Scoped to the SET clause specifically: the WHERE clause legitimately
    // mentions `status = 'rejected'` to select the rows, and a pattern spanning
    // the whole statement would match that and fail for the wrong reason.
    const setClause = normalizeSql(active).match(
      /UPDATE public\.warehouse_dispatch_lines SET (.*?) WHERE /,
    )?.[1];
    expect(setClause).toBeTruthy();
    expect(setClause).toBe('received_quantity = 0');
    expect(setClause).not.toMatch(/\bstatus\b/);
  });

  it('proves nothing non-conforming survives the backfill', () => {
    expect(active).toContain('BACKFILL FAILED (167)');
    expect(active).toMatch(/status = 'rejected' AND received_quantity IS DISTINCT FROM 0/);
  });

  it('is the only DML in the migration', () => {
    // One UPDATE, and no INSERT/DELETE/TRUNCATE anywhere.
    const updates = exec.match(/\bUPDATE\s+public\./g) ?? [];
    expect(updates).toHaveLength(1);
    expect(exec).not.toMatch(/\bINSERT\s+INTO\b/);
    expect(exec).not.toMatch(/\bDELETE\s+FROM\b/);
    expect(exec).not.toMatch(/\bTRUNCATE\b/);
  });
});

// ============================================================================
// 5. VERIFY proves semantics, not just text
// ============================================================================

describe('5. VERIFY evaluates the installed predicate', () => {
  it('renders and executes the live constraint rather than re-reading its text', () => {
    expect(active).toContain('pg_get_expr(conbin, conrelid)');
    expect(active).toMatch(/EXECUTE format\(/);
  });

  it('asserts refusal as FALSE, not merely "not true"', () => {
    // A CHECK passes on NULL. `IS DISTINCT FROM false` is what catches the
    // three-valued-logic hole a bare `received_quantity = 0` would leave.
    expect(active).toContain('IS DISTINCT FROM false');
    expect(active).toContain('IS DISTINCT FROM true');
  });

  it('probes all three shapes: writer row, legacy NULL row, blank-reason row', () => {
    expect(active).toMatch(/v_writer_row/);
    expect(active).toMatch(/v_legacy_row/);
    expect(active).toMatch(/v_blank_row/);
  });

  it('never mutates a real row to test itself', () => {
    // The probe is an expression evaluation over a VALUES list. There must be no
    // second UPDATE (the backfill in section 4 is the only one).
    expect((exec.match(/\bUPDATE\s+public\./g) ?? [])).toHaveLength(1);
    expect(exec).not.toMatch(/ROLLBACK TO SAVEPOINT/i);
  });

  it('asserts the live data conforms and the sibling parity still holds', () => {
    expect(active).toContain('wrsl_decision_chk');
    expect(active).toContain('orsl_decision_chk');
  });
});

// ============================================================================
// 6. NON-GOALS — what 167 must not do
// ============================================================================

describe('6. 167 changes nothing else', () => {
  it('replaces, creates or drops NO function', () => {
    expect(exec).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/);
    expect(exec).not.toMatch(/\bDROP\s+FUNCTION\b/);
    expect(exec).not.toMatch(/\bALTER\s+FUNCTION\b/);
  });

  it('creates no table, column, index, view, type, trigger or policy', () => {
    expect(exec).not.toMatch(/\bCREATE\s+TABLE\b/);
    expect(exec).not.toMatch(/\bADD\s+COLUMN\b/);
    expect(exec).not.toMatch(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/);
    expect(exec).not.toMatch(/\bCREATE\s+(OR\s+REPLACE\s+)?VIEW\b/);
    expect(exec).not.toMatch(/\bCREATE\s+TYPE\b/);
    expect(exec).not.toMatch(/\bCREATE\s+TRIGGER\b/);
    expect(exec).not.toMatch(/\bCREATE\s+POLICY\b/);
  });

  it('grants and revokes nothing', () => {
    expect(exec).not.toMatch(/\bGRANT\b/);
    expect(exec).not.toMatch(/\bREVOKE\b/);
  });

  it('touches exactly one table, and it is warehouse_dispatch_lines', () => {
    const altered = [...exec.matchAll(/ALTER TABLE (?:public\.)?(\w+)/g)].map(m => m[1]);
    expect([...new Set(altered)]).toEqual(['warehouse_dispatch_lines']);
  });

  it('touches neither sibling corridor constraint', () => {
    // 069 and 071 are already correct. 167 reads them in VERIFY (a bare name in
    // a SELECT) but must never ALTER either table.
    expect(exec).not.toMatch(/ALTER TABLE (?:public\.)?warehouse_return_shipment_lines/);
    expect(exec).not.toMatch(/ALTER TABLE (?:public\.)?outlet_return_shipment_lines/);
    expect(exec).not.toMatch(/DROP CONSTRAINT wrsl_decision_chk/);
    expect(exec).not.toMatch(/DROP CONSTRAINT orsl_decision_chk/);
  });

  it('leaves the column-level received_quantity rule from 061 alone', () => {
    expect(exec).not.toMatch(/DROP CONSTRAINT warehouse_dispatch_lines_received_qty_chk/);
    expect(sql061).toMatch(/CHECK \(received_quantity IS NULL OR received_quantity >= 0\)/);
  });
});

// ============================================================================
// 7. The premise: the writer says 0, and the siblings agree
// ============================================================================

describe('7. the premise this migration rests on is real', () => {
  it('the 131 delegate body stores received_quantity = 0 on rejection', () => {
    const sql131 = read('131_phoenix_movement_reason_code_group_f_outlet.sql');
    expect(activeSql(sql131)).toMatch(
      /SET status = 'rejected', received_quantity = 0,/,
    );
  });

  it('the writer has stored 0 since 070, so this was never a regression', () => {
    const sql070 = read('070_phoenix_institution_warehouse_outlet_dispatch.sql');
    expect(activeSql(sql070)).toMatch(
      /SET status = 'rejected', received_quantity = 0,/,
    );
  });

  it('149 renamed that body to the delegate 167 preflights for', () => {
    const sql149 = read('149_phoenix_inventory_suggestion_lineage_commitments.sql');
    expect(activeSql(sql149)).toContain(
      '_phoenix_149_delegate_receive_outlet_dispatch_line',
    );
    expect(active).toContain('_phoenix_149_delegate_receive_outlet_dispatch_line');
  });

  it('069 and 071 both require received_quantity = 0 on rejection', () => {
    expect(decisionBranches(sql069, 'wrsl_decision_chk').get('rejected'))
      .toContain('received_quantity = 0');
    expect(decisionBranches(sql071, 'orsl_decision_chk').get('rejected'))
      .toContain('received_quantity = 0');
  });

  it('and both leave the NULL hole 167 declines to copy', () => {
    // Bare `= 0` with no IS NOT NULL guard: a NULL quantity makes the predicate
    // NULL, which a CHECK accepts. Documented in 167's header as the reason it
    // is one notch stricter than the text it is reconciling with. If a future
    // migration guards them too, this expectation is the one to update.
    for (const [source, name] of [[sql069, 'wrsl_decision_chk'], [sql071, 'orsl_decision_chk']] as const) {
      expect(decisionBranches(source, name).get('rejected'))
        .not.toContain('received_quantity IS NOT NULL');
    }
  });

  it('the header recompute counts statuses and never reads received_quantity', () => {
    // This is why an all-rejected dispatch recomputes to 'rejected' with no
    // change to 070 — asserted dynamically too.
    const sql070 = read('070_phoenix_institution_warehouse_outlet_dispatch.sql');
    const fn = activeSql(sql070).slice(
      activeSql(sql070).indexOf('FUNCTION public.phoenix_recompute_warehouse_dispatch_header_status'),
    );
    const body = fn.slice(0, fn.indexOf('$$;'));
    expect(body).toContain("count(*) FILTER (WHERE status = 'rejected')");
    expect(body).not.toContain('received_quantity');
  });
});

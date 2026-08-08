-- ============================================================================
-- DISPATCH-LINE-FULL-REJECTION-RECONCILIATION-167
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 166. Number 166 is occupied by Stage E's INITIAL-PROVISIONING-
-- INVARIANT migration; 167 is next regardless of when 166 lands, because this
-- migration is completely independent of it — it neither reads nor writes
-- warehouse_dispatches.is_initial_provisioning /
-- initial_provisioning_consumed_at, and touches no object 166 creates. If 166
-- has not been applied in a given environment, 167 still applies cleanly.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- FULL REJECTION OF A WAREHOUSE DISPATCH LINE HAS NEVER WORKED. Every
-- zero-quantity receipt aborts with:
--
--   new row for relation "warehouse_dispatch_lines"
--   violates check constraint "warehouse_dispatch_lines_decision_chk"
--
-- Two halves of the same corridor disagree about how a rejected line records
-- the quantity that arrived, and they have disagreed since the day the corridor
-- was written:
--
--   THE WRITER (says 0). The rejection branch of the receive RPC sets
--     received_quantity = 0:
--       UPDATE public.warehouse_dispatch_lines
--          SET status = 'rejected', received_quantity = 0,
--              rejection_reason = ..., rejected_by = ..., rejected_at = now()
--     This is NOT a recent regression. It is the ORIGINAL text of
--     phoenix_receive_outlet_dispatch_line as first written at
--     070:443-447, carried forward verbatim into 131:257-261 (the
--     movement-reason-code rebuild) and renamed — body unchanged — to
--     _phoenix_149_delegate_receive_outlet_dispatch_line at 149:1763. Every
--     generation of this writer has set 0.
--
--   THE CONSTRAINT (says NULL). warehouse_dispatch_lines_decision_chk, defined
--     once at 061:746 and NEVER redefined since, requires for status
--     'rejected':
--       received_quantity IS NULL
--       AND rejection_reason IS NOT NULL AND btrim(rejection_reason) <> ''
--       AND rejected_at IS NOT NULL
--       AND accepted_by IS NULL AND accepted_at IS NULL
--       AND difference_reason IS NULL
--       AND resulting_item_availability_id IS NULL
--       AND resulting_movement_id IS NULL
--
-- `received_quantity = 0` fails `received_quantity IS NULL`, so the UPDATE
-- always raises, the transaction always rolls back, and the line is left
-- 'pending' with the header still 'sent'. There is no workaround at the API
-- level: the RPC derives 'rejected' from p_received_quantity = 0 itself
-- (131:253-257), so a caller cannot reach the terminal state by any other
-- argument.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHICH SIDE IS CORRECT: THE WRITER. THE CONSTRAINT IS THE OUTLIER.
-- ─────────────────────────────────────────────────────────────────────────────
-- This migration moves the CONSTRAINT to the writer, not the writer to the
-- constraint. Five independent reasons, in descending weight:
--
--   1. THE SIBLING CORRIDORS ALREADY REQUIRE 0, and they are the only other
--      implementations of "a received line was fully refused" in this schema:
--        069:802-805  wrsl_decision_chk  WHEN 'rejected' THEN
--                       received_quantity = 0 AND received_at IS NOT NULL ...
--        071:731-734  orsl_decision_chk  WHEN 'rejected' THEN
--                       received_quantity = 0 AND received_at IS NOT NULL ...
--      Their writers store 0 and their constraints permit exactly 0. Changing
--      the dispatch WRITER to NULL would make this corridor the odd one out of
--      three; changing the CONSTRAINT makes all three agree.
--
--   2. 0 IS THE HONEST BUSINESS RECORD, AND NULL IS ALREADY TAKEN. Within this
--      very constraint, `received_quantity IS NULL` is what 'pending' (061:750)
--      and 'cancelled' (061:778) mean by it: NO DECISION WAS EVER MADE. A
--      rejection is the opposite — a decision was made, a human recorded a
--      mandatory reason, and the counted quantity was zero. Storing NULL there
--      overloads "never decided" onto "decided, and the answer was none", and
--      loses the distinction permanently.
--
--   3. NO READER CAN TELL THE DIFFERENCE, so this cannot change downstream
--      behaviour. Every consumer of a dispatch line's received_quantity already
--      normalises NULL to 0 before using it:
--        071:212   wdl_returned_qty_chk
--                    CHECK (returned_quantity >= 0
--                           AND returned_quantity <= COALESCE(received_quantity, 0))
--        071:1137  v_cap := COALESCE(v_dispatch.received_quantity, 0) - returned_quantity
--        072:693, 072:711, 072:1478, 072:1694
--                  COALESCE(wdl.received_quantity, 0) - wdl.returned_quantity
--      A rejected line's return cap is 0 - 0 = 0 either way: nothing can be
--      returned from a consignment that was refused. The frontend
--      (OutletDispatchOperations.tsx:212) renders received_quantity only when
--      non-null, so the sole visible effect is that a rejected line now
--      displays an explicit "received 0" instead of omitting the figure —
--      which is the correct thing to show a user reading a refusal.
--
--   4. CHANGING THE WRITER WOULD COST MORE AND PROVE LESS. The writer is a
--      149-era private delegate reached through a public wrapper whose
--      signature, ACL, search_path and return contract are themselves asserted
--      by 149's own guards. Rewriting that body to store NULL would mean
--      replacing a function to preserve a constraint clause that no reader
--      depends on (point 3) and that both siblings contradict (point 1).
--
--   5. THE COLUMN ITSELF HAS ALWAYS ALLOWED 0. 061:530 declares
--      CHECK (received_quantity IS NULL OR received_quantity >= 0) — zero is a
--      legitimate value for this column by original design, and 061's own
--      static guards never asserted the NULL requirement for the 'rejected'
--      branch. The `IS NULL` clause reads as a copy of the adjacent
--      pending/cancelled branches rather than a deliberate rule.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS **NOT** WEAKENED
-- ─────────────────────────────────────────────────────────────────────────────
-- The replacement constraint below is the 061 text with ONE clause changed —
-- `received_quantity IS NULL` becomes
-- `received_quantity IS NOT NULL AND received_quantity = 0`, inside the
-- 'rejected' branch only. Everything else is reproduced BYTE-FOR-BYTE:
--
--   • 'pending', 'accepted', 'accepted_with_difference' and 'cancelled' are
--     character-identical to 061:749-780, including `ELSE false`.
--   • The 'rejected' branch keeps every other requirement it had: a non-blank
--     rejection_reason, a rejected_at, no accepted_by/accepted_at, no
--     difference_reason, and NO result links.
--   • 061's RETENTION CONTRACT is preserved exactly. The new definition
--     contains none of `accepted_by IS NOT NULL`, `rejected_by IS NOT NULL`,
--     `resulting_item_availability_id IS NOT NULL`,
--     `resulting_movement_id IS NOT NULL`. Those four were deliberately removed
--     by 061's own RETENTION-FIX (061:1218-1233) because every one of those
--     columns is ON DELETE SET NULL BY DESIGN: requiring them non-null would
--     make any user who ever decided a line undeletable, and would abort
--     migration 055's Deep Clean. 062:1535-1547 re-asserts the same four. This
--     migration's VERIFY block asserts all four AGAIN on the live definition,
--     so the reconciliation cannot silently reintroduce either contradiction.
--   • The new clause is itself SET NULL-safe: received_quantity is a plain
--     integer column with no FK, so nothing can ever null it from underneath
--     the CHECK.
--
-- Note the direction of the change on the 'rejected' branch: it is NOT a
-- widening. Exactly one received_quantity value remains legal for a rejected
-- line; this migration changes WHICH one, from the value the writer never
-- produces to the value it always produces.
--
-- WHY THE EXPLICIT `IS NOT NULL` GUARD, when `= 0` looks sufficient. A CHECK
-- constraint rejects a row only when its predicate evaluates to FALSE — a NULL
-- result PASSES. Written as bare `received_quantity = 0`, a NULL quantity makes
-- that comparison NULL, the whole AND-chain NULL, the CASE NULL, and the row
-- would be ACCEPTED. The branch would then admit BOTH 0 and NULL, i.e. it
-- really would be a silent widening, and the "exactly one legal value" claim
-- above would be false.
--
-- This is a live hole in the sibling constraints: 069:803 and 071:732 both say
-- bare `received_quantity = 0`, so both currently admit a NULL-quantity
-- rejected row by exactly this route. 167 therefore matches the siblings'
-- INTENT (a rejected line records the zero it counted) while being one notch
-- stricter than their TEXT, rather than copying a defect across for the sake of
-- a byte-identical diff.
--
-- The `IS NOT NULL AND ...` shape is not novel here either — it is 061's own
-- idiom, used a few lines up in the SAME constraint for exactly this reason:
--   061:766-768  WHEN 'accepted_with_difference' THEN
--                  received_quantity IS NOT NULL
--                  AND received_quantity > 0
--                  AND received_quantity <> sent_quantity
-- 167's rejected branch is written in that established local style.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DATA SAFETY
-- ─────────────────────────────────────────────────────────────────────────────
-- The legacy rows are normalised BETWEEN the drop and the add (sections 1-3), so
-- the ALTER cannot fail on live data. That ordering is deliberate and NOT the
-- obvious one — see the long note on section 1 for why "backfill first, then
-- tighten" cannot work when the old and new rules are disjoint.
--
-- The set it touches is provably tiny and provably safe:
--   • The OLD constraint required `received_quantity IS NULL` for every
--     'rejected' row, so NULL is the ONLY value any pre-existing rejected line
--     can hold. There is no third case to consider, and no row can be lost or
--     rewritten to a different number.
--   • In practice the set is EMPTY in any environment whose rejected lines only
--     ever came through the RPC, because that path has always aborted. The
--     backfill exists for completeness — an environment seeded by other means,
--     or one where a rejected row was created before 108's direct-write
--     lockdown — not because a known population exists.
--   • NULL -> 0 is lossless for every reader, by point 3 above: all of them
--     already COALESCE to 0.
--
-- The backfill writes received_quantity ONLY. It does not touch status, so
-- 070:1253's `AFTER UPDATE OF status ... WHEN (NEW.status IS DISTINCT FROM
-- OLD.status)` header-sync trigger does not fire and no header status is
-- recomputed. No outbox producer is attached to warehouse_dispatch_lines
-- (the table carries exactly two triggers: 061:804 set_updated_at and
-- 070:1253 trg_sync_warehouse_dispatch_header_status), so the backfill emits
-- no events. 061:804's set_updated_at will bump updated_at on any row it does
-- touch, which is the correct record of the normalisation.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
--   • It does not replace, rename or re-grant ANY function. The writer is
--     already correct; the receive RPC, its 149 wrapper and its delegate are
--     untouched.
--   • It does not change the header recompute. 070:194-207 counts lines by
--     STATUS and never reads received_quantity, so a dispatch whose every line
--     is rejected already recomputes to 'rejected' (070:205) the moment the
--     line UPDATE is allowed to commit. That is asserted end to end by this
--     migration's dynamic test, not assumed.
--   • It does not touch 069's or 071's constraints — they are already right.
--   • It does not edit any migration 001-166. Those remain immutable.
--   • It does not widen the bulk path. 096's
--     phoenix_receive_all_matching_dispatch_lines only accepts lines whose
--     counted quantity EXACTLY matches sent_quantity (096:154) and skips the
--     rest, so it never drives a rejection and is unaffected either way.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. PRE-FLIGHT — the objects this migration reconciles must both be present
--    and must still be in the state described in the header. Fail closed
--    rather than silently reconcile something else.
-- ============================================================================
DO $preflight$
DECLARE
  v_txt text;
BEGIN
  IF to_regclass('public.warehouse_dispatch_lines') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (167): public.warehouse_dispatch_lines is missing — '
      'migration 061 must be applied before 167';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_txt
  FROM pg_constraint WHERE conname = 'warehouse_dispatch_lines_decision_chk';

  IF v_txt IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (167): warehouse_dispatch_lines_decision_chk is missing — '
      '167 reconciles that constraint and must not invent it';
  END IF;

  -- The writer must still be the one described in the header, i.e. the 149
  -- delegate that stores 0. If some environment already changed the writer to
  -- store NULL, reconciling the constraint to `= 0` would break it — stop and
  -- let a human decide instead.
  IF to_regprocedure(
       'public._phoenix_149_delegate_receive_outlet_dispatch_line(uuid, uuid, integer, text, text, text)'
     ) IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (167): the 149 receive delegate is missing — '
      '167 assumes the 070/131/149 writer chain and must not run against a different one';
  END IF;

  IF pg_get_functiondef(to_regprocedure(
       'public._phoenix_149_delegate_receive_outlet_dispatch_line(uuid, uuid, integer, text, text, text)'
     )) NOT LIKE '%received_quantity = 0%' THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (167): the receive delegate no longer stores '
      'received_quantity = 0 on rejection — the premise of this reconciliation is gone';
  END IF;
END;
$preflight$;

-- ============================================================================
-- 1. DROP the old constraint FIRST.
--
-- THE ORDER OF SECTIONS 1-3 IS LOAD-BEARING, and not the obvious one.
--
-- The instinct is "normalise the data, then tighten the rule". That does not
-- work here, because the two rules are DISJOINT: the OLD constraint requires
-- `received_quantity IS NULL` for a rejected line, so an UPDATE writing 0 to a
-- legacy rejected row VIOLATES THE OLD CONSTRAINT and the migration aborts with
-- the very error it exists to eliminate:
--   new row for relation "warehouse_dispatch_lines"
--   violates check constraint "warehouse_dispatch_lines_decision_chk"
--
-- That failure is invisible on a database with no rejected rows — the UPDATE
-- matches nothing, so nothing is checked — which is precisely the case on a
-- fresh rig. It only bites on the real databases the backfill exists for. The
-- backfill therefore runs BETWEEN the drop and the add:
--
--   1. DROP the old constraint      (this section)
--   2. UPDATE the legacy rows       (section 2, now unconstrained)
--   3. ADD the new constraint       (section 3, validates every existing row)
--
-- All three are in ONE transaction, and DROP/ADD CONSTRAINT take ACCESS
-- EXCLUSIVE on the table, so no other session ever observes the table without a
-- decision rule: concurrent writers block until COMMIT, and on abort the old
-- constraint is restored by the rollback. The window is transactional, not real.
--
-- Step 3 is also what makes step 2 self-checking: ADD CONSTRAINT validates the
-- whole table, so if the backfill missed a row the ALTER fails and the entire
-- migration rolls back. Section 2 asserts the same thing explicitly for a
-- clearer error message, but the ALTER is the structural guarantee.
-- ============================================================================
ALTER TABLE public.warehouse_dispatch_lines
  DROP CONSTRAINT warehouse_dispatch_lines_decision_chk;

-- ============================================================================
-- 2. BACKFILL — normalise legacy rejected rows to the value the writer stores.
--    See DATA SAFETY in the header: under the old constraint NULL is the only
--    value a rejected row can hold, and every reader already COALESCEs it to 0,
--    so this is lossless.
-- ============================================================================
DO $backfill$
DECLARE
  v_rows bigint;
BEGIN
  UPDATE public.warehouse_dispatch_lines
     SET received_quantity = 0
   WHERE status = 'rejected'
     AND received_quantity IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows > 0 THEN
    RAISE NOTICE '167: normalised % legacy rejected dispatch line(s) from received_quantity '
      'NULL to 0.', v_rows;
  ELSE
    RAISE NOTICE '167: no legacy rejected dispatch lines needed normalising (expected — the '
      'rejection path has never been able to commit).';
  END IF;

  -- Nothing may remain that the tightened rule would reject. The ADD CONSTRAINT
  -- in section 3 would catch this anyway by validating the whole table; this
  -- says so with a clearer message, and covers the case of a row written by a
  -- concurrent transaction that committed between this migration's snapshot and
  -- the ALTER.
  IF EXISTS (
    SELECT 1 FROM public.warehouse_dispatch_lines
    WHERE status = 'rejected' AND received_quantity IS DISTINCT FROM 0
  ) THEN
    RAISE EXCEPTION 'BACKFILL FAILED (167): a rejected dispatch line still has '
      'received_quantity <> 0 after normalisation';
  END IF;
END;
$backfill$;

-- ============================================================================
-- 3. ADD the reconciled decision CHECK.
--
-- The 061:746-785 definition, reproduced verbatim except for the single
-- 'rejected' branch clause `received_quantity IS NULL` ->
-- `received_quantity IS NOT NULL AND received_quantity = 0`. Diffing this block
-- against 061:746-785 should show exactly that one change.
--
-- This ALTER validates every existing row, so it is also the structural proof
-- that section 2 left no non-conforming rejected line behind.
-- ============================================================================
ALTER TABLE public.warehouse_dispatch_lines
  ADD CONSTRAINT warehouse_dispatch_lines_decision_chk
    CHECK (
      CASE status
        WHEN 'pending' THEN
          received_quantity IS NULL
          AND accepted_by IS NULL AND accepted_at IS NULL
          AND rejected_by IS NULL AND rejected_at IS NULL
          AND difference_reason IS NULL AND rejection_reason IS NULL
          AND resulting_item_availability_id IS NULL
          AND resulting_movement_id IS NULL
        WHEN 'accepted' THEN
          received_quantity = sent_quantity
          AND accepted_at IS NOT NULL
          AND difference_reason IS NULL
          AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL
        WHEN 'accepted_with_difference' THEN
          received_quantity IS NOT NULL
          AND received_quantity > 0
          AND received_quantity <> sent_quantity
          AND difference_reason IS NOT NULL AND btrim(difference_reason) <> ''
          AND accepted_at IS NOT NULL
          AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL
        WHEN 'rejected' THEN
          received_quantity IS NOT NULL
          AND received_quantity = 0
          AND rejection_reason IS NOT NULL AND btrim(rejection_reason) <> ''
          AND rejected_at IS NOT NULL
          AND accepted_by IS NULL AND accepted_at IS NULL AND difference_reason IS NULL
          AND resulting_item_availability_id IS NULL
          AND resulting_movement_id IS NULL
        WHEN 'cancelled' THEN
          received_quantity IS NULL
          AND accepted_by IS NULL AND accepted_at IS NULL
          AND rejected_by IS NULL AND rejected_at IS NULL
          AND resulting_item_availability_id IS NULL
          AND resulting_movement_id IS NULL
        ELSE false
      END
    );

-- ============================================================================
-- 4. VERIFY — fail closed inside the same transaction
-- ============================================================================
DO $verify$
DECLARE
  v_txt  text;
  v_item text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_txt
  FROM pg_constraint WHERE conname = 'warehouse_dispatch_lines_decision_chk';

  IF v_txt IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): decision CHECK missing after replacement';
  END IF;

  -- ── The change actually landed, including its NULL guard ────────────────
  IF v_txt NOT LIKE '%received_quantity = 0%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): the rejected branch does not accept received_quantity = 0';
  END IF;
  IF v_txt NOT LIKE '%received_quantity IS NOT NULL%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): the rejected branch lost its received_quantity IS NOT NULL '
      'guard — without it a NULL quantity makes the predicate NULL, which a CHECK accepts';
  END IF;
  -- `received_quantity IS NULL` must now appear EXACTLY TWICE — 'pending' and
  -- 'cancelled'. Before 167 it appeared three times; the third was 'rejected'.
  -- Counted rather than pattern-matched because pg_get_constraintdef()
  -- parenthesises every clause (`(received_quantity IS NULL) AND (...)`), so a
  -- LIKE spanning two clauses would silently never match and prove nothing.
  -- Note `received_quantity IS NOT NULL` does not contain this substring, so the
  -- new guard is not double-counted here.
  IF (length(v_txt) - length(replace(v_txt, 'received_quantity IS NULL', ''))) /
     length('received_quantity IS NULL') <> 2 THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): received_quantity IS NULL must be required by exactly '
      'the pending and cancelled branches (found % occurrence(s)) — the rejected branch must no '
      'longer require it',
      (length(v_txt) - length(replace(v_txt, 'received_quantity IS NULL', ''))) /
      length('received_quantity IS NULL');
  END IF;

  -- ── 061's RETENTION CONTRACT, re-asserted on the LIVE definition ────────
  -- No nullable FK column may be required non-null: every one of these is
  -- ON DELETE SET NULL by design (061:1218-1233, re-asserted at 062:1535-1547).
  -- Requiring any of them would make a deciding user undeletable and would
  -- abort migration 055's Deep Clean.
  FOREACH v_item IN ARRAY ARRAY[
    'accepted_by IS NOT NULL', 'rejected_by IS NOT NULL',
    'resulting_item_availability_id IS NOT NULL', 'resulting_movement_id IS NOT NULL'
  ] LOOP
    IF v_txt LIKE '%' || v_item || '%' THEN
      RAISE EXCEPTION 'VERIFY FAILED (167): 061 retention contract broken — decision CHECK '
        'now requires %', v_item;
    END IF;
  END LOOP;

  -- ── Every OTHER branch still carries its full rule ──────────────────────
  IF v_txt NOT LIKE '%received_quantity = sent_quantity%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): accepted no longer requires received_quantity = sent_quantity';
  END IF;
  IF v_txt NOT LIKE '%received_quantity <> sent_quantity%'
     OR v_txt NOT LIKE '%received_quantity > 0%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): accepted_with_difference lost its quantity rules';
  END IF;
  IF v_txt NOT LIKE '%difference_reason IS NOT NULL%'
     OR v_txt NOT LIKE '%rejection_reason IS NOT NULL%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): a mandatory reason requirement was dropped';
  END IF;
  IF v_txt NOT LIKE '%rejected_at IS NOT NULL%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): rejected no longer requires rejected_at';
  END IF;
  IF v_txt NOT LIKE '%accepted_at IS NOT NULL%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): an acceptance timestamp requirement was dropped';
  END IF;
  IF v_txt NOT LIKE '%ELSE false%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): the CHECK no longer refuses unknown statuses';
  END IF;

  -- The 'rejected' branch must NOT have become a hole: a rejected line still
  -- carries no result links and no acceptance fields. `v_txt` is the whole
  -- constraint, so count occurrences to prove the pending/rejected/cancelled
  -- branches all still assert the result links are NULL (3 branches x 2 links).
  IF (length(v_txt) - length(replace(v_txt, 'resulting_movement_id IS NULL', ''))) /
     length('resulting_movement_id IS NULL') <> 3 THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): resulting_movement_id IS NULL is no longer asserted by '
      'all three of pending/rejected/cancelled';
  END IF;
  IF (length(v_txt) - length(replace(v_txt, 'resulting_item_availability_id IS NULL', ''))) /
     length('resulting_item_availability_id IS NULL') <> 3 THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): resulting_item_availability_id IS NULL is no longer '
      'asserted by all three of pending/rejected/cancelled';
  END IF;

  -- ── The column-level rule from 061:530 is untouched ─────────────────────
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conname = 'warehouse_dispatch_lines_received_qty_chk') IS NOT NULL
     AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint
          WHERE conname = 'warehouse_dispatch_lines_received_qty_chk')
         NOT LIKE '%received_quantity >= 0%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): the column-level received_quantity rule changed';
  END IF;

  -- ── No live row violates the new rule ───────────────────────────────────
  IF EXISTS (
    SELECT 1 FROM public.warehouse_dispatch_lines
    WHERE status = 'rejected' AND received_quantity IS DISTINCT FROM 0
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): a rejected dispatch line violates the new rule';
  END IF;

  -- ── PARITY WITH THE SIBLING CORRIDORS — the whole point of the change ───
  -- 069 and 071 must still require exactly `received_quantity = 0` on their own
  -- rejection branches. If a future migration ever moves them, this assertion
  -- makes 167 the place that notices the three corridors have diverged again.
  SELECT pg_get_constraintdef(oid) INTO v_txt
  FROM pg_constraint WHERE conname = 'wrsl_decision_chk';
  IF v_txt IS NOT NULL AND v_txt NOT LIKE '%received_quantity = 0%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): 069 wrsl_decision_chk no longer requires '
      'received_quantity = 0 on rejection — the parity 167 relies on is gone';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_txt
  FROM pg_constraint WHERE conname = 'orsl_decision_chk';
  IF v_txt IS NOT NULL AND v_txt NOT LIKE '%received_quantity = 0%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): 071 orsl_decision_chk no longer requires '
      'received_quantity = 0 on rejection — the parity 167 relies on is gone';
  END IF;

  -- ── THE WRITER IS UNTOUCHED ─────────────────────────────────────────────
  -- 167 changes no function. The receive wrapper and its 149 delegate must
  -- both still exist with their original signatures.
  IF to_regprocedure(
       'public.phoenix_receive_outlet_dispatch_line(uuid, uuid, integer, text, text, text)'
     ) IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): the public receive wrapper disappeared';
  END IF;
  IF to_regprocedure(
       'public._phoenix_149_delegate_receive_outlet_dispatch_line(uuid, uuid, integer, text, text, text)'
     ) IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (167): the 149 receive delegate disappeared';
  END IF;

  -- ── THE 'rejected' BRANCH ADMITS 0 AND GENUINELY REFUSES NULL ───────────
  -- Asserted by EVALUATING THE INSTALLED PREDICATE, not by re-reading its text
  -- and not by mutating a real row. pg_get_expr() renders the live constraint;
  -- running it against a one-row VALUES list named after the same columns proves
  -- the SEMANTICS of the object actually attached to the table.
  --
  -- Deliberately NOT done by UPDATE-ing a sampled production line inside a
  -- rolled-back subtransaction: that would fire 070:1253's header-sync trigger
  -- and bump updated_at on a row this migration has no business touching, to
  -- learn something this evaluation establishes with no side effect at all.
  --
  -- THE THREE-VALUED-LOGIC TRAP IS THE POINT OF CASES (b) AND (c). A CHECK
  -- rejects a row only on FALSE; NULL passes. So "refused" is asserted as
  -- `IS DISTINCT FROM false` failing — which catches a NULL result too, not
  -- just an outright true. A bare `received_quantity = 0` clause would return
  -- NULL for case (b) and sail straight through; these assertions are what
  -- make the `IS NOT NULL` guard in the branch above load-bearing rather than
  -- decorative.
  DECLARE
    v_pred text;
    v_ok   boolean;
    -- Column list naming the probe row, in the order the rows below supply.
    v_cols text := 'status, sent_quantity, received_quantity, accepted_by, accepted_at, '
                || 'rejected_by, rejected_at, difference_reason, rejection_reason, '
                || 'resulting_item_availability_id, resulting_movement_id';
    -- A rejected line exactly as the 070/131/149 writer leaves it.
    v_writer_row text := $r$'rejected'::text, 6::integer, 0::integer, NULL::uuid, NULL::timestamptz,
                             NULL::uuid, now(), NULL::text, '167 verify probe'::text,
                             NULL::uuid, NULL::uuid$r$;
    -- The same line with the pre-167 NULL quantity.
    v_legacy_row text := $r$'rejected'::text, 6::integer, NULL::integer, NULL::uuid, NULL::timestamptz,
                             NULL::uuid, now(), NULL::text, '167 verify probe'::text,
                             NULL::uuid, NULL::uuid$r$;
    -- The same line with a blank reason, which must stay illegal.
    v_blank_row text := $r$'rejected'::text, 6::integer, 0::integer, NULL::uuid, NULL::timestamptz,
                            NULL::uuid, now(), NULL::text, '   '::text,
                            NULL::uuid, NULL::uuid$r$;
  BEGIN
    SELECT pg_get_expr(conbin, conrelid) INTO v_pred
    FROM pg_constraint WHERE conname = 'warehouse_dispatch_lines_decision_chk';

    IF v_pred IS NULL THEN
      RAISE EXCEPTION 'VERIFY FAILED (167): could not render the decision CHECK predicate';
    END IF;

    -- (a) the shape the writer produces must now SATISFY the constraint.
    EXECUTE format('SELECT (%s) FROM (VALUES (%s)) AS t(%s)', v_pred, v_writer_row, v_cols)
      INTO v_ok;
    IF v_ok IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'VERIFY FAILED (167): the installed CHECK does not admit a rejected line '
        'with received_quantity = 0 — exactly the row the writer produces (got %)',
        coalesce(v_ok::text, 'NULL');
    END IF;

    -- (b) the pre-167 shape must be REFUSED OUTRIGHT (false, not NULL). This is
    -- what makes the change a MOVE rather than a widening.
    EXECUTE format('SELECT (%s) FROM (VALUES (%s)) AS t(%s)', v_pred, v_legacy_row, v_cols)
      INTO v_ok;
    IF v_ok IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'VERIFY FAILED (167): a rejected line with a NULL received_quantity is not '
        'refused (predicate returned %) — a NULL result PASSES a CHECK, so the rejected branch '
        'was widened to admit both NULL and 0 instead of moved to 0',
        coalesce(v_ok::text, 'NULL');
    END IF;

    -- (c) the mandatory non-blank reason must STILL be enforced outright.
    EXECUTE format('SELECT (%s) FROM (VALUES (%s)) AS t(%s)', v_pred, v_blank_row, v_cols)
      INTO v_ok;
    IF v_ok IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'VERIFY FAILED (167): a rejected line with a blank rejection_reason is not '
        'refused (predicate returned %)', coalesce(v_ok::text, 'NULL');
    END IF;
  END;

  RAISE NOTICE '167 VERIFY OK.';
END;
$verify$;

COMMIT;

-- ============================================================================
-- ROLLBACK (manual): restore 061's original clause. READ BOTH WARNINGS FIRST.
--
--   WARNING 1 — this RE-BREAKS full rejection. Every zero-quantity receipt will
--   abort again, because the writer will still store 0 (167 does not touch it).
--   Rolling back does not return the corridor to a working state; it returns it
--   to the broken state 167 exists to fix.
--
--   WARNING 2 — it DESTROYS recorded history. Any line rejected since 167 was
--   applied holds received_quantity = 0 as a real business record. The restored
--   rule requires NULL there, so those rows must be rewritten to NULL for the
--   ALTER to succeed — erasing the fact that a human counted zero. Decide what
--   to do with them deliberately; do not blanket-null them without a reason.
--
-- The sequence mirrors this migration's own, and for the same reason: the two
-- rules are disjoint, so the data cannot be rewritten while either rule is
-- installed. Drop first, then rewrite, then add.
--
--   BEGIN;
--   ALTER TABLE public.warehouse_dispatch_lines
--     DROP CONSTRAINT warehouse_dispatch_lines_decision_chk;
--
--   -- Only after deciding this is acceptable (WARNING 2):
--   UPDATE public.warehouse_dispatch_lines
--      SET received_quantity = NULL
--    WHERE status = 'rejected' AND received_quantity = 0;
--
--   -- then re-add 061:746-785 verbatim, with
--   --   WHEN 'rejected' THEN received_quantity IS NULL ...
--   COMMIT;
--
-- 167 creates no schema object and replaces no function, so there is nothing
-- else to undo.
-- ============================================================================
-- END OF MIGRATION 167
-- ============================================================================

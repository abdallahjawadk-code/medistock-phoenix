-- ============================================================================
-- WAREHOUSE-RECEIPT-EXPECTED-GENERATION-078-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard -> SQL Editor after reading this file in full,
-- and ONLY after migrations 001-077 are confirmed applied and healthy.
--
-- VERIFICATION STATUS: pre-merge validation did NOT include execution against a
-- disposable PostgreSQL database. Validation is static analysis + CI + the
-- frontend contract tests in this PR. POST-CONDITIONS below is analysis, not a
-- proven runtime guarantee. Apply to a staging/preview database, run the
-- post-conditions, and confirm every one passes BEFORE production.
--
-- STRATEGY: EXPAND, additive, backward-compatible by construction.
--   * Modifies NONE of 001-077. No function is dropped, no grant is removed.
--   * Adds one column, one trigger, and TWO NEW distinctly-named RPCs.
--   * The legacy RPCs stay callable and unchanged. Revoking them is a LATER
--     CONTRACT migration, only after frontend parity is proven in production.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DEFECT THIS CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- `phoenix_receive_warehouse_stock` (065) posts an ADDITIVE receipt guarded only
-- by p_request_id + request_fingerprint. That makes ONE client's own retry safe,
-- and does nothing about two INDEPENDENT submissions of the same physical
-- receipt, because each mints its own request id:
--
--   step  device A        device B        ledger on-hand
--   read  batch = 0       batch = 0       0
--   post  +30 (req R_A)                   30
--   post                  +30 (req R_B)   60      <-- silent, no error
--
-- Sixty units recorded for a thirty-unit delivery. A silent wrong balance in a
-- pharmaceutical ledger is worse than a visible rejection. Unlike the 070/071
-- line receives, whose target line carries a pending->decided status the RPC
-- enforces, the accumulating receipt has NO per-target precondition, so the
-- double post is invisible. The additive modes of
-- `phoenix_apply_warehouse_stock_movement` share the identical gap.
--
-- This CANNOT be closed on the client: two devices that never see each other
-- cannot coordinate a token. The server must adjudicate.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A TRIGGER ADVANCES THE GENERATION, NOT EACH RPC BODY
-- ─────────────────────────────────────────────────────────────────────────────
-- The generation must advance for EVERY posted movement, including ones posted
-- through the legacy RPCs that remain callable during the parity window. Doing
-- that inside each function body would mean copying two large function bodies
-- (11190 and 7224 characters live) to change one line each — the highest-risk,
-- lowest-value edit available. A BEFORE UPDATE trigger advances it in the SAME
-- statement as the quantity change, for every writer, present and future, and
-- cannot be forgotten by a later RPC author.
--
-- The trigger also makes movement_seq SERVER-OWNED: any client-supplied value is
-- overwritten, so the generation can never be spoofed.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY NEW FUNCTION NAMES INSTEAD OF A NEW PARAMETER
-- ─────────────────────────────────────────────────────────────────────────────
-- PostgreSQL identifies a function by (name, argument types). CREATE OR REPLACE
-- with an ADDED parameter does not replace — it creates a SECOND, overloaded
-- function. Both would then be callable, PostgREST would have to disambiguate
-- from the posted JSON keys, and the unsafe legacy body would remain reachable
-- under the same name. Live catalog confirms exactly one overload of each today,
-- and that property is worth keeping.
--
-- Dropping and recreating with the extra parameter is the other option. It keeps
-- one name but is a BREAKING change for any client mid-deploy, and it discards
-- and re-grants privileges. Rejected: this migration must be safe to apply while
-- the current frontend is live.
--
-- So the guarded contract gets its own names. No overload is created, nothing
-- existing changes behaviour, and the legacy callable is retired separately once
-- parity is proven.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE GUARDED RPCs DELEGATE
-- ─────────────────────────────────────────────────────────────────────────────
-- Each guarded RPC enforces the precondition and then calls the legacy RPC to do
-- the work. It does NOT reimplement it. Copying the bodies would fork the
-- identity resolution, the fingerprint construction, the central-item conflict
-- rule, the audit payload and the RBAC check into a second place that must be
-- kept in sync forever. Delegation keeps exactly one implementation of the
-- write, so the scoped RBAC/RLS checks, the fingerprint idempotency and the
-- audit trail are inherited unchanged and CANNOT drift.
--
-- Ordering inside the guarded function matters and is deliberate:
--   1. take the SAME advisory lock the legacy RPC uses, keyed on the request id;
--   2. check for an existing movement for this request id — a REPLAY;
--   3. if replaying, delegate immediately and SKIP the generation check;
--   4. otherwise resolve + lock the canonical target row FOR UPDATE;
--   5. compare its server-owned movement_seq to p_expected_generation;
--   6. on mismatch RAISE, on match delegate.
--
-- Step 3 is what keeps a lost-response retry idempotent: the retry carries the
-- generation the caller read BEFORE its first attempt, which its own committed
-- post has since advanced. Checking the generation on a replay would turn every
-- successful-but-unacknowledged post into a permanent false conflict.
--
-- The advisory lock is taken before any row lock, matching the 065 lock order,
-- so no lock-order inversion is introduced. pg_advisory_xact_lock is re-entrant
-- within a transaction, so the legacy RPC re-taking it is a no-op, and the row
-- this function locks is already held by the same transaction when the legacy
-- RPC re-resolves it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SEMANTICS
-- ─────────────────────────────────────────────────────────────────────────────
--   * A brand-new lot has generation 0. Two concurrent "new lot" posts both read
--     0; the advisory lock serializes them; the first commits and advances to 1;
--     the second, still carrying expected 0, sees 1 under the lock -> CONFLICT,
--     not a second post.
--   * A genuine retry replays the same request id and short-circuits at step 3.
--   * A genuine LATER receipt into the same lot is a new submission that reads
--     the current generation first, so it is accepted and advances again.
--   * p_expected_generation NULL means "unguarded", preserving the legacy
--     contract for callers that have not been migrated. The frontend always
--     sends it; the production gate stays fail-closed until that is proven.
--
-- CONFLICT CODE: SQLSTATE 40001 (serialization_failure) with message
-- 'warehouse_receipt_generation_conflict'. 40001 is the standard "retry the
-- whole business operation" class, and is deliberately NOT 23505, which the
-- client already maps to the different meaning "same request id, different
-- arguments".
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PRECONDITIONS (this transaction ABORTS if any fails)
-- ─────────────────────────────────────────────────────────────────────────────
-- Verified read-only against the live database before authoring:
--   * migrations 001-077 applied (supabase_migrations.schema_migrations = 77)
--   * warehouse_stock has NO movement_seq column
--   * exactly ONE overload each of the two legacy RPCs
--   * warehouse_stock row count 0, duplicate identity groups 0
-- The row count is NOT asserted below: rows may legitimately appear between
-- authoring and apply. The DEFAULT 0 backfill is correct for any row count, and
-- the trigger takes over from the first update onward.
-- ============================================================================

BEGIN;

-- ── PRECONDITIONS ───────────────────────────────────────────────────────────

DO $precond$
BEGIN
  IF to_regclass('public.warehouse_stock') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: public.warehouse_stock is missing (apply 060-065 first)';
  END IF;
  IF to_regclass('public.warehouse_stock_movements') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: public.warehouse_stock_movements is missing';
  END IF;

  -- The legacy RPCs must exist, and must each still be a SINGLE overload.
  -- If a second overload already exists, resolution is ambiguous and this
  -- migration must not add a third callable shape on top of it.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'phoenix_receive_warehouse_stock') <> 1 THEN
    RAISE EXCEPTION 'precondition failed: expected exactly 1 phoenix_receive_warehouse_stock overload';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'phoenix_apply_warehouse_stock_movement') <> 1 THEN
    RAISE EXCEPTION 'precondition failed: expected exactly 1 phoenix_apply_warehouse_stock_movement overload';
  END IF;

  -- Never silently re-run the mutation half of this migration.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'warehouse_stock'
                AND column_name = 'movement_seq') THEN
    RAISE EXCEPTION 'precondition failed: warehouse_stock.movement_seq already exists (078 already applied?)';
  END IF;
END;
$precond$;

-- ── A. Server-owned generation ──────────────────────────────────────────────

ALTER TABLE public.warehouse_stock
  ADD COLUMN movement_seq bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.warehouse_stock.movement_seq IS
  'Server-owned optimistic-concurrency generation. Advanced by '
  'phoenix_warehouse_stock_bump_movement_seq on every quantity change, in the '
  'same statement. Clients may READ it and pass it as p_expected_generation; '
  'any client-supplied value is overwritten by the trigger.';

-- The generation must never be settable by a writer, and must advance for every
-- quantity change regardless of which RPC posted it.
CREATE OR REPLACE FUNCTION public.phoenix_warehouse_stock_bump_movement_seq()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $bump$
BEGIN
  IF NEW.on_hand_quantity   IS DISTINCT FROM OLD.on_hand_quantity
  OR NEW.reserved_quantity  IS DISTINCT FROM OLD.reserved_quantity THEN
    NEW.movement_seq := OLD.movement_seq + 1;
  ELSE
    -- A metadata-only update must not advance the generation, or every unrelated
    -- edit would invalidate a receipt the operator is in the middle of posting.
    NEW.movement_seq := OLD.movement_seq;
  END IF;
  RETURN NEW;
END;
$bump$;

REVOKE ALL ON FUNCTION public.phoenix_warehouse_stock_bump_movement_seq() FROM PUBLIC;

DROP TRIGGER IF EXISTS warehouse_stock_bump_movement_seq ON public.warehouse_stock;
CREATE TRIGGER warehouse_stock_bump_movement_seq
  BEFORE UPDATE ON public.warehouse_stock
  FOR EACH ROW
  EXECUTE FUNCTION public.phoenix_warehouse_stock_bump_movement_seq();

-- ── B. Guarded accumulating receipt ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.phoenix_receive_warehouse_stock_guarded(
  p_request_id             uuid,
  p_warehouse_id           uuid,
  p_scientific_name        text,
  p_quantity               integer,
  p_has_no_national_code   boolean,
  p_has_no_batch_number    boolean,
  p_expected_generation    bigint  DEFAULT NULL,
  p_central_item_id        uuid    DEFAULT NULL,
  p_trade_name             text    DEFAULT NULL,
  p_concentration          text    DEFAULT NULL,
  p_dosage_form            text    DEFAULT NULL,
  p_unit                   text    DEFAULT NULL,
  p_national_code          text    DEFAULT NULL,
  p_batch_number           text    DEFAULT NULL,
  p_expiry_date            date    DEFAULT NULL,
  p_unit_price             numeric DEFAULT NULL,
  p_price_basis            text    DEFAULT NULL,
  p_currency               text    DEFAULT NULL,
  p_supply_type_text       text    DEFAULT NULL,
  p_source_document_number text    DEFAULT NULL,
  p_notes                  text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $guarded_receive$
DECLARE
  v_scientific    text := NULLIF(btrim(p_scientific_name), '');
  v_concentration text := NULLIF(btrim(p_concentration), '');
  v_dosage        text := NULLIF(btrim(p_dosage_form), '');
  v_national      text := NULLIF(btrim(p_national_code), '');
  v_batch         text := NULLIF(btrim(p_batch_number), '');
  v_internal_ref  text;
  v_seq           bigint;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;

  -- Same advisory lock, same key, taken BEFORE any row lock — identical order to
  -- the legacy RPC, so delegating cannot invert lock order.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 65065));

  -- REPLAY FIRST. A retry of an already-committed post must stay idempotent, so
  -- it must never reach the generation check: its expected generation is
  -- necessarily stale by exactly its own successful post.
  IF EXISTS (
    SELECT 1 FROM public.warehouse_stock_movements m
     WHERE m.reference_type = 'warehouse_request'
       AND m.reference_id   = p_request_id
  ) THEN
    RETURN public.phoenix_receive_warehouse_stock(
      p_request_id, p_warehouse_id, p_scientific_name, p_quantity,
      p_has_no_national_code, p_has_no_batch_number, p_central_item_id,
      p_trade_name, p_concentration, p_dosage_form, p_unit, p_national_code,
      p_batch_number, p_expiry_date, p_unit_price, p_price_basis, p_currency,
      p_supply_type_text, p_source_document_number, p_notes
    );
  END IF;

  IF p_expected_generation IS NOT NULL THEN
    -- Resolve the canonical target on the SAME identity the legacy RPC uses, so
    -- the row guarded here is exactly the row it will write.
    v_internal_ref := CASE
      WHEN p_has_no_batch_number THEN 'WSNB-' || replace(p_request_id::text, '-', '')
      ELSE NULL
    END;

    SELECT s.movement_seq
      INTO v_seq
      FROM public.warehouse_stock s
     WHERE s.warehouse_id = p_warehouse_id
       AND s.scientific_name = v_scientific
       AND COALESCE(s.concentration, '') = COALESCE(v_concentration, '')
       AND COALESCE(s.dosage_form, '')   = COALESCE(v_dosage, '')
       AND COALESCE(s.national_code, '') = COALESCE(v_national, '')
       AND COALESCE(s.batch_number, '')  = COALESCE(v_batch, '')
       AND COALESCE(s.expiry_date, DATE '0001-01-01')
           = COALESCE(p_expiry_date, DATE '0001-01-01')
       AND COALESCE(s.internal_batch_reference, '') = COALESCE(v_internal_ref, '')
       FOR UPDATE;

    -- An absent lot IS generation 0: that is what a first receipt legitimately
    -- expects, and it is also what the loser of a two-device race no longer
    -- sees, because the winner's INSERT has since made the row exist at 1.
    v_seq := COALESCE(v_seq, 0);

    IF v_seq IS DISTINCT FROM p_expected_generation THEN
      RAISE EXCEPTION 'warehouse_receipt_generation_conflict'
        USING ERRCODE = '40001',
              DETAIL  = format('expected generation %s, canonical generation %s',
                               p_expected_generation, v_seq);
    END IF;
  END IF;

  RETURN public.phoenix_receive_warehouse_stock(
    p_request_id, p_warehouse_id, p_scientific_name, p_quantity,
    p_has_no_national_code, p_has_no_batch_number, p_central_item_id,
    p_trade_name, p_concentration, p_dosage_form, p_unit, p_national_code,
    p_batch_number, p_expiry_date, p_unit_price, p_price_basis, p_currency,
    p_supply_type_text, p_source_document_number, p_notes
  );
END;
$guarded_receive$;

REVOKE ALL ON FUNCTION public.phoenix_receive_warehouse_stock_guarded(
  uuid, uuid, text, integer, boolean, boolean, bigint, uuid, text, text, text,
  text, text, text, date, numeric, text, text, text, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.phoenix_receive_warehouse_stock_guarded(
  uuid, uuid, text, integer, boolean, boolean, bigint, uuid, text, text, text,
  text, text, text, date, numeric, text, text, text, text, text
) TO authenticated;

COMMENT ON FUNCTION public.phoenix_receive_warehouse_stock_guarded(
  uuid, uuid, text, integer, boolean, boolean, bigint, uuid, text, text, text,
  text, text, text, date, numeric, text, text, text, text, text
) IS
  'Accumulating warehouse receipt with a server-authoritative expected-generation '
  'precondition. Delegates the write to phoenix_receive_warehouse_stock so RBAC, '
  'fingerprint idempotency and audit remain single-sourced. Raises 40001 '
  'warehouse_receipt_generation_conflict when the canonical generation moved. '
  'A request-id replay short-circuits BEFORE the check and stays idempotent.';

-- ── C. Guarded adjustment ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.phoenix_apply_warehouse_stock_movement_guarded(
  p_request_id             uuid,
  p_warehouse_stock_id     uuid,
  p_movement_type          text,
  p_amount                 integer,
  p_reason                 text,
  p_expected_generation    bigint DEFAULT NULL,
  p_source_document_number text   DEFAULT NULL,
  p_notes                  text   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $guarded_movement$
DECLARE
  v_seq   bigint;
  v_found boolean;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 65065));

  IF EXISTS (
    SELECT 1 FROM public.warehouse_stock_movements m
     WHERE m.reference_type = 'warehouse_request'
       AND m.reference_id   = p_request_id
  ) THEN
    RETURN public.phoenix_apply_warehouse_stock_movement(
      p_request_id, p_warehouse_stock_id, p_movement_type, p_amount,
      p_reason, p_source_document_number, p_notes
    );
  END IF;

  IF p_expected_generation IS NOT NULL THEN
    -- The target is addressed by id here, so no identity reconstruction is
    -- needed. A missing row is left to the legacy RPC to report, so this
    -- function cannot become an existence oracle for an unauthorized id.
    SELECT s.movement_seq, true
      INTO v_seq, v_found
      FROM public.warehouse_stock s
     WHERE s.id = p_warehouse_stock_id
       FOR UPDATE;

    IF COALESCE(v_found, false) AND v_seq IS DISTINCT FROM p_expected_generation THEN
      RAISE EXCEPTION 'warehouse_receipt_generation_conflict'
        USING ERRCODE = '40001',
              DETAIL  = format('expected generation %s, canonical generation %s',
                               p_expected_generation, v_seq);
    END IF;
  END IF;

  RETURN public.phoenix_apply_warehouse_stock_movement(
    p_request_id, p_warehouse_stock_id, p_movement_type, p_amount,
    p_reason, p_source_document_number, p_notes
  );
END;
$guarded_movement$;

REVOKE ALL ON FUNCTION public.phoenix_apply_warehouse_stock_movement_guarded(
  uuid, uuid, text, integer, text, bigint, text, text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.phoenix_apply_warehouse_stock_movement_guarded(
  uuid, uuid, text, integer, text, bigint, text, text
) TO authenticated;

COMMENT ON FUNCTION public.phoenix_apply_warehouse_stock_movement_guarded(
  uuid, uuid, text, integer, text, bigint, text, text
) IS
  'Existing-lot warehouse adjustment with a server-authoritative '
  'expected-generation precondition. Delegates the write to '
  'phoenix_apply_warehouse_stock_movement. Raises 40001 '
  'warehouse_receipt_generation_conflict when the canonical generation moved.';

COMMIT;

-- ============================================================================
-- POST-CONDITIONS — run AFTER apply. Every one must hold. Read-only.
-- ============================================================================
--
-- 1. The column exists, is NOT NULL, defaults to 0, and no row is null:
--
--    SELECT column_name, is_nullable, column_default
--      FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='warehouse_stock'
--       AND column_name='movement_seq';
--    -- expect: movement_seq | NO | 0
--
--    SELECT count(*) AS must_be_zero
--      FROM public.warehouse_stock WHERE movement_seq IS NULL;
--
-- 2. The trigger is attached and enabled:
--
--    SELECT tgname, tgenabled FROM pg_trigger
--     WHERE tgrelid='public.warehouse_stock'::regclass
--       AND NOT tgisinternal;
--    -- expect a row: warehouse_stock_bump_movement_seq | O
--
-- 3. No overload was created — each name still resolves to ONE function, and the
--    two guarded functions exist exactly once each:
--
--    SELECT p.proname, count(*) AS overloads
--      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--     WHERE n.nspname='public' AND p.proname LIKE 'phoenix_%warehouse_stock%'
--     GROUP BY p.proname ORDER BY p.proname;
--    -- expect every count = 1
--
-- 4. Grants are least-privilege — authenticated only, PUBLIC absent:
--
--    SELECT p.proname, g.grantee, g.privilege_type
--      FROM pg_proc p
--      JOIN pg_namespace n ON n.oid=p.pronamespace
--      CROSS JOIN LATERAL aclexplode(p.proacl) a
--      JOIN LATERAL (SELECT pg_get_userbyid(a.grantee) AS grantee,
--                           a.privilege_type) g ON true
--     WHERE n.nspname='public' AND p.proname LIKE '%_guarded'
--     ORDER BY 1,2;
--
-- 5. search_path is pinned on both new RPCs and the trigger function:
--
--    SELECT proname, proconfig FROM pg_proc p
--      JOIN pg_namespace n ON n.oid=p.pronamespace
--     WHERE n.nspname='public'
--       AND proname IN ('phoenix_receive_warehouse_stock_guarded',
--                       'phoenix_apply_warehouse_stock_movement_guarded',
--                       'phoenix_warehouse_stock_bump_movement_seq');
--    -- expect {search_path=public, pg_temp} on each
--
-- 6. RECONCILIATION — the ledger is unchanged by this migration. Run BEFORE and
--    AFTER; both must return identical rows:
--
--    SELECT count(*) AS lots, coalesce(sum(on_hand_quantity),0) AS on_hand,
--           coalesce(sum(reserved_quantity),0) AS reserved
--      FROM public.warehouse_stock;
--    SELECT count(*) AS movements FROM public.warehouse_stock_movements;
--
-- 7. TRIGGER BEHAVIOUR (staging only — this WRITES; do not run in production):
--
--    BEGIN;
--      SELECT id, movement_seq FROM public.warehouse_stock LIMIT 1;  -- note both
--      UPDATE public.warehouse_stock SET notes = notes WHERE id = '<id>';
--      -- metadata-only: movement_seq must be UNCHANGED
--      UPDATE public.warehouse_stock
--         SET on_hand_quantity = on_hand_quantity + 1 WHERE id = '<id>';
--      -- quantity change: movement_seq must be +1
--      UPDATE public.warehouse_stock SET movement_seq = 999 WHERE id = '<id>';
--      -- client-supplied value must be OVERWRITTEN, not accepted
--      SELECT movement_seq FROM public.warehouse_stock WHERE id = '<id>';
--    ROLLBACK;
--
-- ============================================================================
-- ROLLBACK / CONTAINMENT
-- ============================================================================
--
-- This migration is additive and reversible. Nothing existing was altered, so
-- rolling back cannot lose data.
--
-- CONTAINMENT (preferred, no schema change): stop sending p_expected_generation,
-- or point the client back at the legacy RPC names. The guarded functions become
-- inert; the legacy path behaves exactly as it does today.
--
-- FULL ROLLBACK:
--
--    BEGIN;
--      DROP FUNCTION IF EXISTS public.phoenix_receive_warehouse_stock_guarded(
--        uuid, uuid, text, integer, boolean, boolean, bigint, uuid, text, text,
--        text, text, text, text, date, numeric, text, text, text, text, text);
--      DROP FUNCTION IF EXISTS public.phoenix_apply_warehouse_stock_movement_guarded(
--        uuid, uuid, text, integer, text, bigint, text, text);
--      DROP TRIGGER IF EXISTS warehouse_stock_bump_movement_seq
--        ON public.warehouse_stock;
--      DROP FUNCTION IF EXISTS public.phoenix_warehouse_stock_bump_movement_seq();
--      ALTER TABLE public.warehouse_stock DROP COLUMN IF EXISTS movement_seq;
--    COMMIT;
--
-- Dropping movement_seq discards only the generation counter. No quantity, no
-- movement and no audit row depends on it.
--
-- ============================================================================
-- FOLLOW-UP (NOT part of this migration)
-- ============================================================================
-- Once the frontend sends p_expected_generation on every accumulating receipt in
-- production, and parity is observed, a LATER contract migration should
-- REVOKE EXECUTE on the two legacy RPCs from `authenticated` so the unguarded
-- accumulating path is no longer reachable. Do NOT do that here: this file must
-- be safe to apply while the current frontend is still live.
-- ============================================================================

-- ============================================================================
-- INITIAL-PROVISIONING-INVARIANT-166  (Stage E · subphase E-4)
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 165, via the Supabase SQL Editor, after reading this file in full.
--
-- NOT APPLIED BY THIS PR. Authored and replayed on a disposable PostgreSQL rig
-- only. Migrations 001-165 are immutable and are NOT edited here.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SCOPE — E-4 ONLY  (STAGE-E-FINAL-PLAN-v4 §12, §18, §20)
-- ─────────────────────────────────────────────────────────────────────────────
--   1. warehouse_dispatches.is_initial_provisioning          (new column)
--   2. warehouse_dispatches.initial_provisioning_consumed_at (new column)
--   3. wd_initial_provisioning_consumed_chk                  (new CHECK)
--   4. warehouse_dispatches_initial_provisioning_once_uniq   (partial unique index)
--   5. phoenix_create_initial_provisioning_dispatch(...)      (new RPC)
--   6. CREATE OR REPLACE of phoenix_receive_outlet_dispatch_line(...) — the 149
--      wrapper ONLY.
--
-- No new permission key. No new movement type. No new corridor. No new table.
-- No RLS or grant change on any existing object. Nothing in E-5 or later.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE INVARIANT
-- ─────────────────────────────────────────────────────────────────────────────
-- An emergency outlet (crash cabinet / rescue cart / pharmacy) may be INITIALLY
-- PROVISIONED at most once. "Initial provisioning" is a one-shot lifecycle, not
-- a quantity: once any stock has actually ARRIVED under that lifecycle, the
-- outlet can never be initially provisioned again — no matter what happens to
-- the header afterwards, and no matter how the balance moves afterwards.
--
-- A lifecycle that delivered NOTHING (fully rejected, or cancelled while still
-- a draft) is not a consumption and must leave the outlet re-provisionable.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A SEPARATE consumed_at COLUMN — THE HEADER IS AMBIGUOUS
-- ─────────────────────────────────────────────────────────────────────────────
-- phoenix_recompute_warehouse_dispatch_header_status (070:202-207) sets:
--
--     WHEN v_pending > 0        THEN 'partially_accepted'   -- still open  (070:203)
--     WHEN v_accepted = v_total THEN 'accepted'
--     WHEN v_rejected = v_total THEN 'rejected'
--     ELSE                           'partially_accepted'   -- all decided, mixed (070:206)
--
-- so 'partially_accepted' means EITHER "still open" OR "finished with a mix".
-- Deriving consumption from the header would therefore be wrong in both
-- directions:
--   * 'accepted' is terminal and would fall OUT of any status-only predicate,
--     re-opening a fully consumed outlet;
--   * 'partially_accepted' cannot distinguish rule B from rule F.
-- Consumption is consequently RECORDED, not inferred, in its own column.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- RULES A-G AND THE MECHANISM THAT SATISFIES EACH
-- ─────────────────────────────────────────────────────────────────────────────
-- A. RESERVED        an open lifecycle (draft/sent/partially_accepted) holds the
--                    outlet; a second one raises 23505.
-- B. PARTIAL RECEIPT  receipt logic is untouched; the row stays in the index.
-- C. CONSUMED        consumed_at IS NOT NULL keeps the row in the index FOREVER,
--                    independently of the header — this is the clause that
--                    survives the terminal 'accepted' status.
-- D. FULLY REJECTED  header 'rejected', consumed_at NULL => leaves the index.
--                    A rejection is p_received_quantity = 0, which the delegate
--                    routes to its 'rejected' branch returning quantity_delta 0
--                    (131:251-255, 131:282-286), so it never stamps.
-- E. DRAFT CANCELLED header 'cancelled', consumed_at NULL => leaves the index.
--                    070's cancel path refuses any status other than 'draft'
--                    (070:970-972), so a cancelled lifecycle delivered nothing.
-- F. MIXED OUTCOME   the stamp is driven by the delegate's own reported
--                    quantity_delta > 0, never by the ambiguous header.
-- G. LATER STOCK ZERO no balance column appears anywhere in the predicate, so
--                    depletion cannot reopen the lifecycle.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE 149 WRAPPER, AND WHY THAT IS SUFFICIENT
-- ─────────────────────────────────────────────────────────────────────────────
-- The public entry point phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,
-- text,text,text) is a 6-line wrapper (149:1996-2014) over
-- _phoenix_149_delegate_receive_outlet_dispatch_line — the migration-131 body
-- renamed in place at 149:1763-1764. The delegate is NOT touched.
--
-- This was verified rather than assumed: the BULK receive path
-- (_phoenix_149_delegate_receive_all_matching_dispatch_lines, the 096 body
-- renamed at 149:1779-1780) calls the PUBLIC WRAPPER by name at 096:168-170,
-- passing five positional arguments and letting p_reason_code default. There is
-- no third path. Replacing the wrapper alone therefore covers single-line AND
-- bulk receipt; had the bulk delegate bypassed the wrapper, this design would
-- have left a hole in rule C. That assumption is enforced as a precondition
-- below, so a future migration cannot silently re-point it.
--
-- The stamp runs AFTER the delegate returns and is therefore still inside the
-- delegate's `SELECT ... FROM warehouse_dispatches ... FOR UPDATE` header lock,
-- which is held to end of transaction.
--
-- For every ordinary (non-provisioning) dispatch the added statement matches no
-- row: no lock is taken and nothing is written.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A SEPARATE CREATE RPC
-- ─────────────────────────────────────────────────────────────────────────────
-- phoenix_create_warehouse_dispatch(uuid,uuid,text,text,text,text) (070:617)
-- cannot set the flag, and migration 106:24-33 documents why adding a trailing
-- DEFAULT parameter to it would create an ambiguous overload. The new RPC
-- therefore DELEGATES to it — inheriting authentication, the outlet/warehouse
-- pairing rule (070:674-676), the organization match (070:677-679), the
-- warehouse_dispatch.create permission check (070:681-685) and the creation
-- audit (070:701-707) verbatim — and then flags the row it created. No
-- validation is duplicated and no new permission key is introduced.
--
-- Delegating FIRST is deliberate: an unauthorised caller is rejected by the
-- existing permission gate and never learns whether a lifecycle already exists.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY NEITHER WRITE EMITS A SPURIOUS LIFECYCLE OR OUTBOX EVENT
-- ─────────────────────────────────────────────────────────────────────────────
-- warehouse_dispatches carries the AFTER INSERT OR UPDATE trigger
-- `phoenix_capture_lifecycle` (attached at 082:206-208; its function
-- phoenix_capture_lifecycle_event was last replaced by 159:154, which also
-- became the lifecycle OUTBOX producer). That function returns early unless the
-- status column actually changed (159:182-184, the 082:130-132 guard carried
-- forward). Both writes below set flag columns ONLY and never touch status, so
-- neither emits a movement event or an outbox row.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. PRECONDITIONS — fail closed
-- ============================================================================
DO $preflight$
BEGIN
  IF to_regclass('public.warehouse_dispatches') IS NULL THEN
    RAISE EXCEPTION '166_precondition_failed: warehouse_dispatches (061) is absent';
  END IF;
  IF to_regclass('public.warehouse_dispatch_lines') IS NULL THEN
    RAISE EXCEPTION '166_precondition_failed: warehouse_dispatch_lines (061) is absent';
  END IF;

  -- The creator we delegate to, and the wrapper/delegate pair we extend, must
  -- exist with the EXACT signatures assumed below.
  IF to_regprocedure('public.phoenix_create_warehouse_dispatch(uuid,uuid,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION '166_precondition_failed: phoenix_create_warehouse_dispatch (070) is absent';
  END IF;
  IF to_regprocedure('public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text,text)') IS NULL THEN
    RAISE EXCEPTION '166_precondition_failed: phoenix_receive_outlet_dispatch_line (149) is absent';
  END IF;
  IF to_regprocedure('public._phoenix_149_delegate_receive_outlet_dispatch_line(uuid,uuid,integer,text,text,text)') IS NULL THEN
    RAISE EXCEPTION '166_precondition_failed: the 149 receive delegate is absent';
  END IF;
  IF to_regprocedure('public._phoenix_lock_linked_suggestions(text,uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION '166_precondition_failed: _phoenix_lock_linked_suggestions (149) is absent';
  END IF;

  -- The bulk path must still reach the wrapper. If a future migration ever
  -- re-points it at the inner delegate, wrapper-only stamping would silently
  -- stop covering bulk receipt — so that assumption is enforced here.
  IF to_regprocedure('public._phoenix_149_delegate_receive_all_matching_dispatch_lines(uuid,uuid,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION '166_precondition_failed: the 149 bulk receive delegate is absent';
  END IF;
  IF pg_get_functiondef('public._phoenix_149_delegate_receive_all_matching_dispatch_lines(uuid,uuid,jsonb,text)'::regprocedure)
     NOT LIKE '%public.phoenix_receive_outlet_dispatch_line(%' THEN
    RAISE EXCEPTION '166_precondition_failed: the bulk receive path no longer calls the public wrapper';
  END IF;

  -- The delegate must still REPORT the received quantity: the stamp below is
  -- driven by that key and by nothing else.
  IF pg_get_functiondef('public._phoenix_149_delegate_receive_outlet_dispatch_line(uuid,uuid,integer,text,text,text)'::regprocedure)
     NOT LIKE '%quantity_delta%' THEN
    RAISE EXCEPTION '166_precondition_failed: the receive delegate no longer reports quantity_delta';
  END IF;

  -- Flag-only writes must stay event-silent: the lifecycle/outbox capture
  -- function must still return early when status did not change.
  IF pg_get_functiondef('public.phoenix_capture_lifecycle_event()'::regprocedure)
     NOT LIKE '%IS NOT DISTINCT FROM v_old_status%' THEN
    RAISE EXCEPTION '166_precondition_failed: the lifecycle capture no longer ignores same-status updates';
  END IF;

  -- The dispatch status vocabulary the invariant reads must be the 061 one.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conname = 'warehouse_dispatches_status_chk') IS NULL THEN
    RAISE EXCEPTION '166_precondition_failed: warehouse_dispatches_status_chk (061) is absent';
  END IF;

  -- The E-2/E-3 foundation must be in place: 166 is the fourth Stage-E step.
  IF to_regclass('public.organization_facilities') IS NULL THEN
    RAISE EXCEPTION '166_precondition_failed: organization_facilities (164) is absent';
  END IF;
  IF pg_get_functiondef('public.phoenix_assert_direct_supply_endpoints(uuid,uuid,uuid)'::regprocedure)
     NOT LIKE '%facility_id%' THEN
    RAISE EXCEPTION '166_precondition_failed: migration 165 has not been applied';
  END IF;

  -- Idempotency guard: this migration is not re-runnable.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouse_dispatches'
      AND column_name IN ('is_initial_provisioning', 'initial_provisioning_consumed_at')
  ) THEN
    RAISE EXCEPTION '166_precondition_failed: an initial-provisioning column already exists';
  END IF;
END;
$preflight$;

-- ============================================================================
-- 1. COLUMNS
-- ============================================================================
-- is_initial_provisioning         — the lifecycle marker, set once at creation
--                                   by the dedicated RPC and never cleared.
-- initial_provisioning_consumed_at — the moment stock first actually ARRIVED
--                                   under that lifecycle. NULL means "nothing
--                                   has been received yet".
ALTER TABLE public.warehouse_dispatches
  ADD COLUMN is_initial_provisioning boolean NOT NULL DEFAULT false,
  ADD COLUMN initial_provisioning_consumed_at timestamptz;

-- ============================================================================
-- 2. CHECK — consumption is meaningless without the lifecycle
-- ============================================================================
ALTER TABLE public.warehouse_dispatches
  ADD CONSTRAINT wd_initial_provisioning_consumed_chk
  CHECK (initial_provisioning_consumed_at IS NULL OR is_initial_provisioning);

-- ============================================================================
-- 3. THE INVARIANT ITSELF — one partial unique index, no new table
-- ============================================================================
-- Uniqueness is per DESTINATION OUTLET. A row occupies the index while the
-- lifecycle is either OPEN (draft/sent/partially_accepted) or CONSUMED
-- (consumed_at IS NOT NULL). It leaves the index only when the lifecycle ended
-- without delivering anything — 'rejected' or 'cancelled' with consumed_at
-- still NULL — which is exactly rules D and E.
--
-- No balance column appears here: rule G holds by construction.
CREATE UNIQUE INDEX warehouse_dispatches_initial_provisioning_once_uniq
  ON public.warehouse_dispatches (destination_distribution_point_id)
  WHERE is_initial_provisioning
    AND (initial_provisioning_consumed_at IS NOT NULL
         OR status IN ('draft', 'sent', 'partially_accepted'));

-- ============================================================================
-- 4. CREATE RPC — flag the one-time lifecycle
-- ============================================================================
CREATE FUNCTION public.phoenix_create_initial_provisioning_dispatch(
  p_warehouse_id uuid,
  p_destination_distribution_point_id uuid,
  p_dispatch_number text,
  p_document_number text DEFAULT NULL,
  p_default_currency text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_created     jsonb;
  v_dispatch    public.warehouse_dispatches%ROWTYPE;
BEGIN
  -- Every authentication, pairing, organization and permission rule is the
  -- creator's, unchanged. It raises not_authenticated / dispatch_number_required
  -- / warehouse_not_found_or_inactive / destination_outlet_not_found_or_inactive
  -- / outlet_type_not_approved_for_stock / destination_outlet_not_paired_with_
  -- this_warehouse / warehouse_and_destination_organization_mismatch /
  -- forbidden_warehouse_dispatch_create / active_profile_required for us, and
  -- takes pg_advisory_xact_lock(hashtextextended(p_warehouse_id::text, 70169)).
  v_created := public.phoenix_create_warehouse_dispatch(
    p_warehouse_id,
    p_destination_distribution_point_id,
    p_dispatch_number,
    p_document_number,
    p_default_currency,
    p_notes
  );

  SELECT * INTO v_dispatch
  FROM public.warehouse_dispatches
  WHERE id = (v_created ->> 'dispatch_id')::uuid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'initial_provisioning_dispatch_not_created' USING ERRCODE = 'P0002';
  END IF;

  -- Named error instead of a raw constraint violation — the same courtesy 070
  -- extends for the outlet/warehouse pairing. This check is DETERMINISTIC, not
  -- racy: the creator above already holds the per-warehouse advisory lock, and
  -- the destination outlet is required to be paired with that same warehouse
  -- (070:674-676), so every competing creation for one outlet serialises on one
  -- lock. The partial unique index remains the structural backstop regardless.
  IF EXISTS (
    SELECT 1
    FROM public.warehouse_dispatches d
    WHERE d.destination_distribution_point_id = p_destination_distribution_point_id
      AND d.id <> v_dispatch.id
      AND d.is_initial_provisioning
      AND (d.initial_provisioning_consumed_at IS NOT NULL
           OR d.status IN ('draft', 'sent', 'partially_accepted'))
  ) THEN
    RAISE EXCEPTION 'initial_provisioning_already_exists_for_outlet'
      USING ERRCODE = '23505';
  END IF;

  -- Flags only. Status is untouched, so phoenix_capture_lifecycle_event —
  -- which returns early unless status actually changed (159:182-184) — emits
  -- neither a movement event nor an outbox row.
  UPDATE public.warehouse_dispatches
     SET is_initial_provisioning = true
   WHERE id = v_dispatch.id;

  SELECT p.role INTO v_actor_role
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_dispatch.organization_id, v_actor, v_actor_role,
    'warehouse_dispatch.initial_provisioning_created', 'warehouse_dispatches',
    v_dispatch.id, v_dispatch.dispatch_number,
    jsonb_build_object(
      'warehouse_id', p_warehouse_id,
      'distribution_point_id', p_destination_distribution_point_id,
      'is_initial_provisioning', true
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'dispatch_id', v_dispatch.id,
    'status', v_dispatch.status,
    'is_initial_provisioning', true
  );
END;
$$;

-- ============================================================================
-- 5. CREATE OR REPLACE — the 149 wrapper, and ONLY the wrapper
-- ============================================================================
-- The first two statements are migration 149's body, unchanged. The delegate
-- (_phoenix_149_delegate_receive_outlet_dispatch_line) is NOT redefined here.
--
-- Parameter names and the signature are preserved exactly: CREATE OR REPLACE
-- cannot rename parameters, and the bulk delegate calls this wrapper by
-- position (096:168-170).
CREATE OR REPLACE FUNCTION public.phoenix_receive_outlet_dispatch_line(
  p_request_id uuid,
  p_dispatch_line_id uuid,
  p_received_quantity integer,
  p_difference_reason text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_reason_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_result      jsonb;
  v_dispatch_id uuid;
BEGIN
  -- 149, verbatim.
  PERFORM public._phoenix_lock_linked_suggestions(
    'dispatch_line', p_dispatch_line_id, false);

  v_result := public._phoenix_149_delegate_receive_outlet_dispatch_line(
    p_request_id, p_dispatch_line_id, p_received_quantity,
    p_difference_reason, p_notes, p_reason_code);

  -- 166: record consumption on the FIRST receipt that actually delivered stock.
  --
  -- quantity_delta is present on all three of the delegate's return paths:
  --   * idempotent replay  -> the original movement's on_hand_delta (131:179)
  --   * rejected (qty = 0) -> 0                                     (131:285)
  --   * accepted / accepted_with_difference -> the received quantity (131:417)
  -- so a rejection never consumes the lifecycle (rule D), and a replay is a
  -- no-op because consumed_at is already set (the IS NULL guard).
  --
  -- This runs after the delegate returned, i.e. still under the header's
  -- FOR UPDATE lock, which the delegate holds to end of transaction.
  --
  -- The predicate is deliberately blind to dispatch status: rule C must survive
  -- the terminal 'accepted' header, and rule F must not consult the ambiguous
  -- 'partially_accepted' one.
  IF COALESCE((v_result ->> 'quantity_delta')::integer, 0) > 0 THEN
    SELECT l.dispatch_id INTO v_dispatch_id
    FROM public.warehouse_dispatch_lines l
    WHERE l.id = p_dispatch_line_id;

    UPDATE public.warehouse_dispatches
       SET initial_provisioning_consumed_at = now()
     WHERE id = v_dispatch_id
       AND is_initial_provisioning
       AND initial_provisioning_consumed_at IS NULL;
  END IF;

  RETURN v_result;
END;
$$;

-- ============================================================================
-- 6. GRANTS — the 070/149 idiom, unchanged for the replaced wrapper
-- ============================================================================
REVOKE ALL ON FUNCTION public.phoenix_create_initial_provisioning_dispatch(uuid, uuid, text, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_create_initial_provisioning_dispatch(uuid, uuid, text, text, text, text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_receive_outlet_dispatch_line(uuid, uuid, integer, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_outlet_dispatch_line(uuid, uuid, integer, text, text, text)
  TO authenticated;

-- ============================================================================
-- 7. COMMENTS
-- ============================================================================
COMMENT ON COLUMN public.warehouse_dispatches.is_initial_provisioning IS
  'E-4: marks this dispatch as the one-time initial provisioning of its destination outlet. Set only by phoenix_create_initial_provisioning_dispatch; never cleared.';

COMMENT ON COLUMN public.warehouse_dispatches.initial_provisioning_consumed_at IS
  'E-4: when stock first actually arrived under this initial-provisioning lifecycle. NULL means nothing has been received yet, so the outlet remains re-provisionable. Stamped by phoenix_receive_outlet_dispatch_line on the first receipt with a positive quantity.';

COMMENT ON INDEX public.warehouse_dispatches_initial_provisioning_once_uniq IS
  'E-4 invariant: at most one initial-provisioning lifecycle per destination outlet may be OPEN (draft/sent/partially_accepted) or CONSUMED (consumed_at IS NOT NULL). A lifecycle that delivered nothing (rejected or cancelled, consumed_at NULL) leaves the index and frees the outlet. No balance column participates, so depletion can never reopen it.';

COMMENT ON CONSTRAINT wd_initial_provisioning_consumed_chk ON public.warehouse_dispatches IS
  'E-4: a consumption timestamp is meaningless on a dispatch that is not an initial provisioning.';

COMMENT ON FUNCTION public.phoenix_create_initial_provisioning_dispatch(uuid, uuid, text, text, text, text) IS
  'E-4: creates a warehouse dispatch flagged as the destination outlet''s one-time initial provisioning. Delegates every validation, permission check and audit to phoenix_create_warehouse_dispatch (070), then sets the flag. Raises initial_provisioning_already_exists_for_outlet (23505) when the outlet already has an open or consumed lifecycle.';

-- ============================================================================
-- 8. VERIFY — in-transaction, fails the whole migration
-- ============================================================================
DO $verify$
DECLARE
  v_wrapper      text;
  v_wrapper_code text;
  v_delegate     text;
  v_create_code  text;
  v_idx          text;
  v_chk          text;
  -- Assertions about what a function body does — especially ABSENCE claims —
  -- must read CODE, not comments. The bodies below deliberately NAME the things
  -- they rule out, so a raw text search would test the documentation instead of
  -- the implementation. `n` makes `.` stop at a line break.
  c_strip CONSTANT text := '--.*$';
BEGIN
  -- 8a. The two columns, with the exact declared shape.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouse_dispatches'
      AND column_name='is_initial_provisioning'
      AND data_type='boolean' AND is_nullable='NO' AND column_default='false'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): is_initial_provisioning is missing or mis-declared';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouse_dispatches'
      AND column_name='initial_provisioning_consumed_at'
      AND data_type='timestamp with time zone' AND is_nullable='YES'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): initial_provisioning_consumed_at is missing or mis-declared';
  END IF;

  -- 8b. The CHECK.
  SELECT pg_get_constraintdef(oid) INTO v_chk
  FROM pg_constraint WHERE conname='wd_initial_provisioning_consumed_chk';
  IF v_chk IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): wd_initial_provisioning_consumed_chk is absent';
  END IF;
  IF v_chk NOT LIKE '%initial_provisioning_consumed_at IS NULL%'
     OR v_chk NOT LIKE '%is_initial_provisioning%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): wd_initial_provisioning_consumed_chk has the wrong shape';
  END IF;

  -- 8c. The index — every clause of the invariant, and nothing balance-related.
  SELECT indexdef INTO v_idx
  FROM pg_indexes
  WHERE schemaname='public' AND indexname='warehouse_dispatches_initial_provisioning_once_uniq';
  IF v_idx IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): the invariant index is absent';
  END IF;
  IF v_idx NOT LIKE 'CREATE UNIQUE INDEX%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): the invariant index is not UNIQUE';
  END IF;
  IF v_idx NOT LIKE '%(destination_distribution_point_id)%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): the invariant is not keyed on the destination outlet';
  END IF;
  IF v_idx NOT LIKE '%is_initial_provisioning%'
     OR v_idx NOT LIKE '%initial_provisioning_consumed_at IS NOT NULL%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): rule C (consumed blocks forever) is not encoded';
  END IF;
  IF v_idx NOT LIKE '%draft%' OR v_idx NOT LIKE '%sent%' OR v_idx NOT LIKE '%partially_accepted%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): rule A (open lifecycle reserves) is not encoded';
  END IF;
  -- Rules D/E: no terminal-empty status may keep a row in the index. Checked on
  -- the WHERE clause only — 'partially_accepted' legitimately contains neither
  -- token, but a bare 'rejected'/'cancelled' would break both rules.
  IF split_part(v_idx, 'WHERE', 2) ~ '''(rejected|cancelled)''' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): rules D/E broken — a terminal-empty status is in the predicate';
  END IF;
  -- Rule G, structurally: no balance may participate.
  IF v_idx LIKE '%quantity%' OR v_idx LIKE '%on_hand%' OR v_idx LIKE '%stock%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): rule G broken — a balance appears in the invariant predicate';
  END IF;

  -- 8d. The new RPC.
  IF to_regprocedure('public.phoenix_create_initial_provisioning_dispatch(uuid,uuid,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): phoenix_create_initial_provisioning_dispatch has the wrong signature';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc
          WHERE oid='public.phoenix_create_initial_provisioning_dispatch(uuid,uuid,text,text,text,text)'::regprocedure) THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): the new RPC is not SECURITY DEFINER';
  END IF;
  v_create_code := regexp_replace(
    pg_get_functiondef('public.phoenix_create_initial_provisioning_dispatch(uuid,uuid,text,text,text,text)'::regprocedure),
    c_strip, '', 'gn');
  IF v_create_code NOT LIKE '%public.phoenix_create_warehouse_dispatch(%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): the new RPC no longer reuses the 070 creator';
  END IF;
  IF v_create_code NOT LIKE '%initial_provisioning_already_exists_for_outlet%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): the new RPC lost its named duplicate-lifecycle error';
  END IF;

  -- 8e. The wrapper: signature, security, the preserved 149 body, the stamp.
  v_wrapper := pg_get_functiondef(
    'public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text,text)'::regprocedure);
  IF pg_get_function_arguments(
       'public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text,text)'::regprocedure)
     <> 'p_request_id uuid, p_dispatch_line_id uuid, p_received_quantity integer, '
        || 'p_difference_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, '
        || 'p_reason_code text DEFAULT NULL::text' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): receive wrapper signature changed';
  END IF;
  IF v_wrapper NOT LIKE '%SECURITY DEFINER%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): receive wrapper is no longer SECURITY DEFINER';
  END IF;

  v_wrapper_code := regexp_replace(v_wrapper, c_strip, '', 'gn');

  IF v_wrapper_code NOT LIKE '%_phoenix_lock_linked_suggestions%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): the 149 suggestion lock was dropped from the wrapper';
  END IF;
  IF v_wrapper_code NOT LIKE '%_phoenix_149_delegate_receive_outlet_dispatch_line%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): the wrapper no longer delegates';
  END IF;
  IF v_wrapper_code NOT LIKE '%initial_provisioning_consumed_at = now()%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): the wrapper does not stamp consumption';
  END IF;
  IF v_wrapper_code NOT LIKE '%initial_provisioning_consumed_at IS NULL%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): the stamp is not once-only';
  END IF;
  -- Rules C and F, structurally: the stamp must not consult the dispatch header
  -- status at all — not the terminal 'accepted' one, not the ambiguous
  -- 'partially_accepted' one. Asserting that the CODE never mentions status is
  -- stronger than naming the individual values.
  IF v_wrapper_code LIKE '%status%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): rules C/F broken — the stamp consults the header status';
  END IF;
  -- The stamp must be driven by the delegate's reported delta.
  IF v_wrapper_code NOT LIKE '%quantity_delta%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): the stamp is not driven by the received quantity';
  END IF;

  -- 8f. The delegate must be untouched: it still contains the real
  -- implementation and must NOT have acquired a stamp of its own.
  v_delegate := regexp_replace(pg_get_functiondef(
    'public._phoenix_149_delegate_receive_outlet_dispatch_line(uuid,uuid,integer,text,text,text)'::regprocedure),
    c_strip, '', 'gn');
  IF v_delegate LIKE '%initial_provisioning%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): the receive delegate was modified';
  END IF;
  IF v_delegate NOT LIKE '%FOR UPDATE%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): the receive delegate no longer locks the header';
  END IF;

  -- 8g. The bulk path still reaches the replaced wrapper.
  IF pg_get_functiondef('public._phoenix_149_delegate_receive_all_matching_dispatch_lines(uuid,uuid,jsonb,text)'::regprocedure)
     NOT LIKE '%public.phoenix_receive_outlet_dispatch_line(%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): bulk receipt no longer routes through the wrapper';
  END IF;

  -- 8h. NON-REGRESSION — E-4 changes nothing outside its own scope.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='outlet_stock_movements_type_chk')
     LIKE '%replenish%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): outlet movement vocabulary changed in E-4';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='warehouses_warehouse_kind_chk')
     LIKE '%health_center%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): warehouse_kind was widened';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.item_availability'::regclass
      AND pg_get_constraintdef(oid) LIKE '%near_stockout%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): Availability vocabulary changed';
  END IF;
  IF (SELECT count(*) FROM pg_class
      WHERE relname IN ('pharmacy_stock','rescue_cart_stock','crash_cabinet_stock','facility_stock')) <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): a second balance ledger exists';
  END IF;
  IF to_regprocedure('public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): E-5 work leaked into E-4';
  END IF;
  -- NOTE ON DATA: no row-state assertion appears here, deliberately, for the
  -- reason 165 records — a separately-gated rollout may legitimately have
  -- created facilities, routes or dispatches before 166 is applied, and a
  -- global data assertion would then block a migration that changes no data.
  -- That 166 itself writes no business data is asserted STATICALLY against this
  -- file's text by the sibling static test.
  --
  -- The dispatch status vocabulary the invariant reads must be unchanged.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='warehouse_dispatches_status_chk')
     <> $chk$CHECK ((status = ANY (ARRAY['draft'::text, 'sent'::text, 'partially_accepted'::text, 'accepted'::text, 'rejected'::text, 'cancelled'::text])))$chk$ THEN
    RAISE EXCEPTION 'VERIFY FAILED (166): the dispatch status vocabulary changed';
  END IF;

  RAISE NOTICE '166 VERIFY OK.';
END;
$verify$;

COMMIT;

-- ============================================================================
-- ROLLBACK (manual):
--   DROP FUNCTION public.phoenix_create_initial_provisioning_dispatch(uuid, uuid, text, text, text, text);
--   DROP INDEX public.warehouse_dispatches_initial_provisioning_once_uniq;
--   ALTER TABLE public.warehouse_dispatches
--     DROP CONSTRAINT wd_initial_provisioning_consumed_chk,
--     DROP COLUMN initial_provisioning_consumed_at,
--     DROP COLUMN is_initial_provisioning;
--   then re-apply migration 149's phoenix_receive_outlet_dispatch_line body
--   verbatim (149:1996-2014) to restore the pre-166 wrapper.
-- ============================================================================
-- END OF MIGRATION 166
-- ============================================================================

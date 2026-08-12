-- ============================================================================
-- R1.2 — EMERGENCY-OUTLET INITIAL-PROVISIONING AUTHORITY BOUNDARY (180)
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
--
-- Production DDL is applied ONCE, after 179, by the authorized operator through
-- `Supabase.apply_migration`, following an exact-ceiling preflight and
-- independent approval. The Supabase SQL Editor is no longer the apply path for
-- this project; `supabase db push` remains forbidden outright. (Historical
-- migrations carry the older instruction in their own headers and are NOT
-- edited to match — they are immutable.)
--
-- NOT APPLIED BY THIS PR. Authored and replayed on a disposable PostgreSQL rig
-- only. Migrations 001-179 are immutable and are NOT edited here.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DEFECT (reproduced on a disposable 001->179 rig, current master)
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 166 made initial provisioning a ONE-SHOT lifecycle per destination
-- outlet, enforced by a partial unique index and a dedicated RPC. That RPC is
-- the only writer that can set `is_initial_provisioning`.
--
-- It is NOT the only writer that can move warehouse stock into an emergency
-- outlet. The generic ordinary creator
-- phoenix_create_warehouse_dispatch(uuid,uuid,text,text,text,text) (070:617)
-- accepts ANY destination whose point_type is in the 066/067 approved set:
--
--     IF v_point.point_type NOT IN ('pharmacy','crash_cabinet','rescue_cart')
--     THEN RAISE 'outlet_type_not_approved_for_stock' …            (070:667-670)
--
-- so crash_cabinet and rescue_cart pass. Observed sequence on the rig:
--
--     1. crash cabinet receives a valid Initial Provisioning   -> on_hand = 10
--     2. a SECOND Initial Provisioning is correctly refused     (23505)
--     3. an ORDINARY warehouse dispatch to the same cabinet is
--        nevertheless ACCEPTED                                  -> 10 -> 17
--     4. a repeated ORDINARY warehouse dispatch is ALSO accepted -> 17 -> 20
--
-- The one-shot invariant is therefore bypassable through the generic writer.
-- 166 is not wrong; it is incomplete — it closed one door in a room with three.
--
-- Independent closure review of the first cut of this migration found the other
-- two, and both are corrected here.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DEFECT 2 — INITIAL AUTHORITY ACCEPTED A PHARMACY
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 166 inherited 070's whole approved-type set, so
-- phoenix_create_initial_provisioning_dispatch would happily commission a
-- PHARMACY and burn its one-shot slot. That is no longer the authoritative
-- contract. Initial provisioning is the commissioning of an EMERGENCY outlet; a
-- pharmacy is supplied by ordinary warehouse dispatch as often as needed and has
-- no commissioning lifecycle at all. The two authorities must partition the
-- destination vocabulary, not overlap on it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DEFECT 3 — ROUTINE REPLENISHMENT DID NOT REQUIRE INITIAL PROVISIONING
-- ─────────────────────────────────────────────────────────────────────────────
-- Closing the warehouse door is not enough while the pharmacy door is open.
-- Migration 168's phoenix_replenish_emergency_outlet validates route,
-- authorization, endpoint types, organization, facility, Shape H/I topology,
-- FEFO, stock, quantity and idempotency — but never consults
-- is_initial_provisioning or initial_provisioning_consumed_at. A brand-new crash
-- cabinet or rescue cart with a legal active route can therefore be stocked by
-- routine replenishment having never been commissioned: the SAME lifecycle
-- invariant, bypassed through the other door. Section 4 closes it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A "CONSUMED-ONLY" GUARD IS NOT THE FIX
-- ─────────────────────────────────────────────────────────────────────────────
-- The obvious-looking rule
--
--     reject ordinary emergency dispatch only IF the initial-provisioning
--     lifecycle has already been consumed
--
-- is strictly weaker than the invariant and leaves the hole open at BOTH ends:
--
--   * BEFORE:  a brand-new crash cabinet or rescue cart with no
--              initial-provisioning row at all would accept an ordinary
--              warehouse dispatch, skipping the lifecycle from the beginning.
--              The outlet is then stocked with never a single row carrying
--              is_initial_provisioning — the invariant was never entered, so
--              it can never be violated, and never enforced.
--   * AFTER:   a lifecycle that ended without delivering anything (rejected, or
--              cancelled while still a draft — 166 rules D and E) leaves the
--              partial unique index and is legitimately re-provisionable. A
--              consumed-only guard would read "not consumed" and admit an
--              ordinary dispatch during exactly that window.
--
-- It also re-derives authority from ROW STATE, which is the same mistake 166
-- refused to make when it recorded consumption instead of inferring it.
--
-- THE INVARIANT THIS MIGRATION ENCODES INSTEAD:
--
--     WAREHOUSE / DEPOT DIRECT SUPPLY TO AN EMERGENCY OUTLET IS LEGAL ONLY
--     THROUGH THE DEDICATED INITIAL-PROVISIONING AUTHORITY.
--
-- Ordinary warehouse dispatch to crash_cabinet or rescue_cart is ALWAYS
-- forbidden: before initial provisioning, while it is open, after it is
-- consumed, after the balance returns to zero, after later returns —
-- permanently. Eligibility is historical lifecycle state and is NEVER inferred
-- from a current balance. No balance column appears anywhere below.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE FINAL AUTHORITY MATRIX (disjoint) AND THE INITIAL-FIRST ORDER
-- ─────────────────────────────────────────────────────────────────────────────
--                       pharmacy    crash_cabinet    rescue_cart
--   ORDINARY dispatch    LEGAL        FORBIDDEN       FORBIDDEN
--   INITIAL provisioning FORBIDDEN    LEGAL           LEGAL
--
-- and, for every crash_cabinet / rescue_cart, supply is ORDERED:
--
--     Warehouse/Depot
--         -> INITIAL PROVISIONING
--         -> actual POSITIVE receipt
--         -> initial_provisioning_consumed_at IS NOT NULL
--         -> routine pharmacy replenishment (168) becomes legal
--
-- Routine replenishment before that milestone is forbidden. The milestone is
-- the durable 166 marker, never a balance: a lifecycle that delivered nothing
-- does not open the corridor, and a later fall to zero does not close it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE NAIVE FIX IS UNSAFE, AND WHAT IS DONE INSTEAD
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 166's RPC does not re-implement dispatch creation: it DELEGATES to
-- the ordinary creator (166:270-277) and then flags the row. So dropping
--
--     IF v_point.point_type IN ('crash_cabinet','rescue_cart') THEN RAISE …
--
-- into the ordinary creator's body would break legitimate Initial Provisioning
-- too — the one corridor that must keep working. The two authorities have to
-- stop sharing one entry point before either can be constrained.
--
-- ARCHITECTURE (the narrowest separation that achieves this):
--
--     phoenix_create_warehouse_dispatch(...)              [public, authenticated]
--            │  authority := 'ordinary'  (hard-coded in the wrapper)
--            ▼
--     _phoenix_180_delegate_create_warehouse_dispatch(..., p_authority)
--            ▲                                        [internal, NO grantee]
--            │  authority := 'initial'   (hard-coded in the wrapper)
--     phoenix_create_initial_provisioning_dispatch(...)   [public, authenticated]
--
-- ONE trusted internal core owns every shared mechanic, so the two corridors
-- cannot drift apart: actor authentication, active-profile resolution,
-- warehouse validation, the per-warehouse advisory lock, the destination row
-- lock, the warehouse/destination organization match, the destination/warehouse
-- pairing, the scoped permission check, dispatch-number validation, the INSERT
-- into warehouse_dispatches, the creation audit, deterministic lock ordering,
-- and the existing references/document/currency/notes behaviour. Its body is
-- migration 070's body, moved — not rewritten — plus the authority gate.
--
-- Both public signatures are UNCHANGED, so no frontend, service, test or SQL
-- caller has to be re-pointed.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- AUTHORITY IS NOT A CLIENT-SUPPLIED PARAMETER
-- ─────────────────────────────────────────────────────────────────────────────
-- p_authority exists ONLY on the internal core, which has EXECUTE revoked from
-- PUBLIC, anon AND authenticated. An authenticated client cannot reach it: the
-- only paths in are the two SECURITY DEFINER wrappers, each of which passes a
-- LITERAL token it chooses itself. There is deliberately no
-- `phoenix_create_warehouse_dispatch(..., p_is_initial boolean)` and no
-- `p_mode text` on any client-reachable RPC — a caller must never be able to
-- self-declare ordinary/initial/emergency/special authority. Authority is
-- determined solely by WHICH trusted public RPC was invoked. The verify block
-- asserts this structurally, over the whole public schema, not just for the
-- three functions this file touches.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHERE THE GATE SITS IN THE SEQUENCE, AND WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- The refusal is raised AFTER the scoped permission check and the active-
-- profile resolution, and BEFORE the INSERT — never after a row exists. That
-- ordering is deliberate and follows the precedent 166 set at 166:111-112: an
-- unauthorised caller is stopped by the existing permission gate and never
-- learns anything about the destination's corridor eligibility. An authorised
-- caller, who may already read that outlet, gets the precise domain error.
--
-- The error is `emergency_outlet_requires_initial_provisioning`, NOT 070's
-- `outlet_type_not_approved_for_stock`. The distinction is the point: a crash
-- cabinet IS an outlet type approved to hold stock (066/067), and IS a legal
-- destination for warehouse supply — through the initial-provisioning corridor,
-- and afterwards through 168's routine pharmacy->emergency replenishment. What
-- is wrong is the SUPPLY AUTHORITY used, not the outlet.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
-- No table, column, constraint, index, RLS policy, trigger, view, permission
-- key, movement type or business data is created, altered or deleted. No
-- replenishment routing semantics change (168/169 are untouched). Migration 166
-- is NOT rewritten — its columns, CHECK, partial unique index and consumption
-- stamp are left exactly as it created them, and the verify block re-asserts
-- them. Migration 179 is untouched. No new stock ledger: warehouse_stock and
-- outlet_stock remain the only two balance truths. No FEFO, batch, expiry,
-- provenance, reservation or allocation behaviour is touched — this file
-- contains no allocation algorithm at all, because dispatch LINES (and
-- therefore materials) are added by 070/097/102/106/107, not here.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PRODUCTION PRE-APPLY GATE (NETWORK-WIDE — READ BEFORE APPLYING)
-- ─────────────────────────────────────────────────────────────────────────────
-- This change is network-wide, and it CLOSES two corridors that live data may
-- be using. Before applying to Production the authorised operator must run the
-- inventory query recorded in this PR's description over ALL organizations and
-- confirm every ACTIVE crash_cabinet / rescue_cart passes BOTH conditions:
--
--   1. it has a LEGAL ACTIVE 168 replenishment route from a legal pharmacy —
--      because after this migration that is its only ongoing inbound corridor;
--      AND
--   2. its initial-provisioning lifecycle is either still available/open, or
--      already CONSUMED.
--
-- An active route ALONE is not permission to replenish: after section 4, a
-- route to an outlet that never consumed a lifecycle refuses. And a consumed
-- outlet with no active route has no ongoing corridor at all. Both are
-- reported as stranded and must be resolved BEFORE apply.
--
-- This migration deliberately repairs neither: it cannot invent a route, it
-- must not fabricate a commissioning event, and silently leaving either bypass
-- open is the defect being fixed.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 0. PRECONDITIONS — fail closed
-- ============================================================================
-- Every dependency this migration RELIES ON is asserted semantically: object
-- existence, exact signatures, security posture, the named errors and lock
-- constants whose behaviour is being relocated, and the 166 objects whose
-- semantics must survive. Nothing here hashes a function body or matches
-- whitespace — a reformat must not fail the migration, but a behavioural drift
-- in anything 180 depends on must.
DO $preflight$
DECLARE
  v_ordinary   CONSTANT text := 'public.phoenix_create_warehouse_dispatch(uuid,uuid,text,text,text,text)';
  v_initial    CONSTANT text := 'public.phoenix_create_initial_provisioning_dispatch(uuid,uuid,text,text,text,text)';
  v_core       CONSTANT text := 'public._phoenix_180_delegate_create_warehouse_dispatch(uuid,uuid,text,text,text,text,text)';
  v_repl       CONSTANT text := 'public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)';
  v_ord_def    text;
  v_ini_def    text;
  v_repl_def   text;
  v_idx        text;
BEGIN
  -- ── Tables the core reads and writes.
  IF to_regclass('public.warehouse_dispatches') IS NULL THEN
    RAISE EXCEPTION '180_precondition_failed: warehouse_dispatches (061) is absent';
  END IF;
  IF to_regclass('public.warehouses') IS NULL THEN
    RAISE EXCEPTION '180_precondition_failed: warehouses (060) is absent';
  END IF;
  IF to_regclass('public.distribution_points') IS NULL THEN
    RAISE EXCEPTION '180_precondition_failed: distribution_points (001/024) is absent';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION '180_precondition_failed: profiles is absent';
  END IF;
  IF to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION '180_precondition_failed: audit_logs is absent';
  END IF;

  -- ── The permission helper the core must keep calling.
  IF to_regprocedure('public.phoenix_profile_has_scoped_permission(uuid,text,uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '180_precondition_failed: phoenix_profile_has_scoped_permission (062) is absent';
  END IF;

  -- ── The two public writers, at the EXACT signatures 180 preserves.
  IF to_regprocedure(v_ordinary) IS NULL THEN
    RAISE EXCEPTION '180_precondition_failed: phoenix_create_warehouse_dispatch (070) is absent';
  END IF;
  IF to_regprocedure(v_initial) IS NULL THEN
    RAISE EXCEPTION '180_precondition_failed: phoenix_create_initial_provisioning_dispatch (166) is absent';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_ordinary::regprocedure) THEN
    RAISE EXCEPTION '180_precondition_failed: the ordinary creator is not SECURITY DEFINER';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_initial::regprocedure) THEN
    RAISE EXCEPTION '180_precondition_failed: the initial creator is not SECURITY DEFINER';
  END IF;

  -- Both wrappers keep running as the same owner as the core they will call,
  -- which is what makes a fully-revoked internal function reachable from them
  -- and from nowhere else.
  IF (SELECT proowner FROM pg_proc WHERE oid = v_ordinary::regprocedure)
     <> (SELECT proowner FROM pg_proc WHERE oid = v_initial::regprocedure) THEN
    RAISE EXCEPTION '180_precondition_failed: the two dispatch writers have different owners';
  END IF;

  -- The parameter lists must be exactly what 180 re-declares: CREATE OR REPLACE
  -- cannot rename a parameter, so a drift here would abort mid-migration.
  IF pg_get_function_arguments(v_ordinary::regprocedure)
     <> 'p_warehouse_id uuid, p_destination_distribution_point_id uuid, '
        || 'p_dispatch_number text, p_document_number text DEFAULT NULL::text, '
        || 'p_default_currency text DEFAULT NULL::text, p_notes text DEFAULT NULL::text' THEN
    RAISE EXCEPTION '180_precondition_failed: the ordinary creator parameter list changed';
  END IF;
  IF pg_get_function_arguments(v_initial::regprocedure)
     <> 'p_warehouse_id uuid, p_destination_distribution_point_id uuid, '
        || 'p_dispatch_number text, p_document_number text DEFAULT NULL::text, '
        || 'p_default_currency text DEFAULT NULL::text, p_notes text DEFAULT NULL::text' THEN
    RAISE EXCEPTION '180_precondition_failed: the initial creator parameter list changed';
  END IF;

  -- ── The pre-180 coupling this migration exists to unwind. If the initial
  -- creator no longer delegates to the ordinary one, the shape 180 was authored
  -- against is gone and the relocation below would be reasoning about a
  -- function that no longer exists in that form.
  v_ini_def := pg_get_functiondef(v_initial::regprocedure);
  IF v_ini_def NOT LIKE '%public.phoenix_create_warehouse_dispatch(%' THEN
    RAISE EXCEPTION '180_precondition_failed: the initial creator no longer delegates to the ordinary creator';
  END IF;
  IF v_ini_def NOT LIKE '%initial_provisioning_already_exists_for_outlet%' THEN
    RAISE EXCEPTION '180_precondition_failed: the initial creator lost its named duplicate-lifecycle error';
  END IF;
  IF v_ini_def NOT LIKE '%is_initial_provisioning = true%' THEN
    RAISE EXCEPTION '180_precondition_failed: the initial creator no longer flags the lifecycle';
  END IF;

  -- ── Every mechanic the core takes over must currently live in the ordinary
  -- creator. These are the named errors, the lock constant and the audit action
  -- that define its behaviour; the moved body must reproduce all of them.
  v_ord_def := pg_get_functiondef(v_ordinary::regprocedure);
  IF v_ord_def NOT LIKE '%hashtextextended(p_warehouse_id::text, 70169)%' THEN
    RAISE EXCEPTION '180_precondition_failed: the ordinary creator no longer takes the 70169 per-warehouse advisory lock';
  END IF;
  IF v_ord_def NOT LIKE '%outlet_type_not_approved_for_stock%'
     OR v_ord_def NOT LIKE '%destination_outlet_not_paired_with_this_warehouse%'
     OR v_ord_def NOT LIKE '%warehouse_and_destination_organization_mismatch%'
     OR v_ord_def NOT LIKE '%forbidden_warehouse_dispatch_create%'
     OR v_ord_def NOT LIKE '%active_profile_required%'
     OR v_ord_def NOT LIKE '%warehouse_not_found_or_inactive%'
     OR v_ord_def NOT LIKE '%destination_outlet_not_found_or_inactive%'
     OR v_ord_def NOT LIKE '%dispatch_number_required%'
     OR v_ord_def NOT LIKE '%not_authenticated%' THEN
    RAISE EXCEPTION '180_precondition_failed: the ordinary creator no longer raises its expected named errors';
  END IF;
  IF v_ord_def NOT LIKE '%warehouse_dispatch.created%' THEN
    RAISE EXCEPTION '180_precondition_failed: the ordinary creator no longer writes its creation audit';
  END IF;
  IF v_ord_def NOT LIKE '%warehouse_dispatch.create%' THEN
    RAISE EXCEPTION '180_precondition_failed: the ordinary creator no longer checks the warehouse_dispatch.create permission';
  END IF;
  -- The gate 180 adds must NOT already be present: this migration is not
  -- re-runnable and must not silently no-op over a different implementation.
  IF v_ord_def LIKE '%emergency_outlet_requires_initial_provisioning%' THEN
    RAISE EXCEPTION '180_precondition_failed: the ordinary creator already carries an emergency-corridor gate';
  END IF;

  -- ── The 166 contract this migration must preserve, asserted before and after.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouse_dispatches'
      AND column_name='is_initial_provisioning'
  ) THEN
    RAISE EXCEPTION '180_precondition_failed: warehouse_dispatches.is_initial_provisioning (166) is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouse_dispatches'
      AND column_name='initial_provisioning_consumed_at'
  ) THEN
    RAISE EXCEPTION '180_precondition_failed: warehouse_dispatches.initial_provisioning_consumed_at (166) is absent';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conname='wd_initial_provisioning_consumed_chk') IS NULL THEN
    RAISE EXCEPTION '180_precondition_failed: wd_initial_provisioning_consumed_chk (166) is absent';
  END IF;
  SELECT indexdef INTO v_idx FROM pg_indexes
  WHERE schemaname='public' AND indexname='warehouse_dispatches_initial_provisioning_once_uniq';
  IF v_idx IS NULL THEN
    RAISE EXCEPTION '180_precondition_failed: the 166 one-shot invariant index is absent';
  END IF;
  IF v_idx NOT LIKE 'CREATE UNIQUE INDEX%'
     OR v_idx NOT LIKE '%(destination_distribution_point_id)%'
     OR v_idx NOT LIKE '%initial_provisioning_consumed_at IS NOT NULL%' THEN
    RAISE EXCEPTION '180_precondition_failed: the 166 one-shot invariant index changed shape';
  END IF;

  -- ── The outlet-type vocabulary the gate keys on must still exist. The gate is
  -- keyed on point_type and NOT on clinical_location_kind: an ER PHARMACY is
  -- clinical_location_kind='emergency' yet remains a fully legal ordinary
  -- dispatch destination (it is the SOURCE of 168 rescue-cart replenishment),
  -- so keying on the clinical flag would close a corridor that must stay open.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.distribution_points'::regclass
      AND pg_get_constraintdef(oid) LIKE '%crash_cabinet%'
      AND pg_get_constraintdef(oid) LIKE '%rescue_cart%'
      AND pg_get_constraintdef(oid) LIKE '%pharmacy%'
  ) THEN
    RAISE EXCEPTION '180_precondition_failed: the distribution_points point_type vocabulary changed';
  END IF;

  -- ── The Migration 168 replenishment RPC whose body this migration relocates
  -- forward. 168 itself is NOT edited; its effective body is reproduced with a
  -- single added gate, so every mechanic named below must currently be present
  -- and must survive into the replacement.
  IF to_regprocedure(v_repl) IS NULL THEN
    RAISE EXCEPTION '180_precondition_failed: phoenix_replenish_emergency_outlet (168) is absent';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_repl::regprocedure) THEN
    RAISE EXCEPTION '180_precondition_failed: the replenishment RPC is not SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = v_repl::regprocedure AND proconfig @> ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION '180_precondition_failed: the replenishment RPC does not pin search_path';
  END IF;
  IF (SELECT proowner FROM pg_proc WHERE oid = v_repl::regprocedure)
     <> (SELECT proowner FROM pg_proc WHERE oid = v_ordinary::regprocedure) THEN
    RAISE EXCEPTION '180_precondition_failed: the replenishment RPC has an unexpected owner';
  END IF;
  IF pg_get_function_arguments(v_repl::regprocedure)
     <> 'p_request_id uuid, p_route_id uuid, p_source_outlet_stock_id uuid, '
        || 'p_quantity integer, p_fefo_override_reason text DEFAULT NULL::text, '
        || 'p_notes text DEFAULT NULL::text' THEN
    RAISE EXCEPTION '180_precondition_failed: the replenishment RPC parameter list changed';
  END IF;

  -- Helpers the reproduced body calls. A missing one would only surface at
  -- call time, long after this migration committed.
  IF to_regprocedure('public._phoenix_replenishment_fingerprint_v1(uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION '180_precondition_failed: the 168 replenishment fingerprint helper is absent';
  END IF;
  IF to_regprocedure('public._phoenix_outlet_facility_context_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION '180_precondition_failed: the 164 outlet facility context helper is absent';
  END IF;
  IF to_regprocedure('public.phoenix_inventory_fefo_batches(uuid,text,uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION '180_precondition_failed: the 150 FEFO helper is absent';
  END IF;
  IF to_regprocedure('public.phoenix_project_outlet_availability(uuid)') IS NULL THEN
    RAISE EXCEPTION '180_precondition_failed: the outlet availability projector is absent';
  END IF;
  IF to_regclass('public.outlet_replenishment_routes') IS NULL
     OR to_regclass('public.outlet_stock') IS NULL
     OR to_regclass('public.outlet_stock_movements') IS NULL THEN
    RAISE EXCEPTION '180_precondition_failed: an E-5 replenishment table is absent';
  END IF;

  -- Every mechanic the reproduced body must carry forward, asserted on the
  -- CURRENT definition so a drift in 168 aborts before anything is replaced.
  v_repl_def := pg_get_functiondef(v_repl::regprocedure);
  IF v_repl_def NOT LIKE '%hashtextextended(p_request_id::text, 168168)%' THEN
    RAISE EXCEPTION '180_precondition_failed: the replenishment RPC lost its 168168 advisory lock';
  END IF;
  IF v_repl_def NOT LIKE '%_phoenix_replenishment_fingerprint_v1(%'
     OR v_repl_def NOT LIKE '%request_id_conflict%'
     OR v_repl_def NOT LIKE '%''idempotent_replay'', true%' THEN
    RAISE EXCEPTION '180_precondition_failed: the replenishment RPC lost its fingerprint idempotency';
  END IF;
  IF v_repl_def NOT LIKE '%forbidden_outlet_stock_replenish%'
     OR v_repl_def NOT LIKE '%outlet_stock.replenish%'
     OR v_repl_def NOT LIKE '%route_not_active%'
     OR v_repl_def NOT LIKE '%source_must_be_pharmacy%'
     OR v_repl_def NOT LIKE '%destination_must_be_emergency_outlet%'
     OR v_repl_def NOT LIKE '%health_center_rescue_cart_forbidden%'
     OR v_repl_def NOT LIKE '%rescue_cart_requires_hospital%'
     OR v_repl_def NOT LIKE '%crash_cabinet_requires_non_emergency_context%'
     OR v_repl_def NOT LIKE '%cross_facility_route_forbidden%'
     OR v_repl_def NOT LIKE '%fefo_override_required%'
     OR v_repl_def NOT LIKE '%insufficient_source_stock%'
     OR v_repl_def NOT LIKE '%outlet_quantity_cannot_go_negative%'
     OR v_repl_def NOT LIKE '%stock_lock_identity_mismatch%' THEN
    RAISE EXCEPTION '180_precondition_failed: the replenishment RPC lost one of its named refusals';
  END IF;
  IF v_repl_def NOT LIKE '%''replenish_send''%'
     OR v_repl_def NOT LIKE '%''replenish_receive''%'
     OR v_repl_def NOT LIKE '%outlet_stock.replenish''%' THEN
    RAISE EXCEPTION '180_precondition_failed: the replenishment RPC lost its movement pair or audit';
  END IF;
  -- The gate 180 adds must NOT already be present.
  IF v_repl_def LIKE '%initial_provisioning_required_before_replenishment%' THEN
    RAISE EXCEPTION '180_precondition_failed: the replenishment RPC already carries an initial-first gate';
  END IF;
  IF v_repl_def LIKE '%initial_provisioning_consumed_at%' THEN
    RAISE EXCEPTION '180_precondition_failed: the replenishment RPC already reads the lifecycle marker';
  END IF;

  -- 169's reversal must exist and must stay untouched by this migration.
  IF to_regprocedure('public.phoenix_reverse_outlet_replenishment(uuid,uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION '180_precondition_failed: the 169 reversal corridor is absent';
  END IF;

  -- ── Idempotency guard: this migration is not re-runnable.
  IF to_regprocedure(v_core) IS NOT NULL THEN
    RAISE EXCEPTION '180_precondition_failed: the 180 internal core already exists';
  END IF;
  IF v_ord_def LIKE '%initial_provisioning_requires_emergency_outlet%' THEN
    RAISE EXCEPTION '180_precondition_failed: the ordinary creator already carries the initial-authority gate';
  END IF;
END;
$preflight$;

-- ============================================================================
-- 1. THE TRUSTED INTERNAL CORE
-- ============================================================================
-- Migration 070's creator body (070:630-710), MOVED here unchanged, with one
-- addition: the authority gate. Every validation, lock, permission check, INSERT
-- and audit below is 070's, in 070's order, so the two corridors above it can
-- never drift apart or grow a second implementation of dispatch creation.
--
-- p_authority is NOT a client input. See section 3's ACL: PUBLIC, anon and
-- authenticated all have EXECUTE revoked, so the only callers are the two
-- SECURITY DEFINER wrappers, each passing a literal it chooses itself.
--
-- SECURITY DEFINER with search_path pinned to `public, pg_temp`, matching the
-- 149 internal-delegate idiom and the 070 body it inherits. It is defined
-- BEFORE the wrappers that call it, so the whole file applies in one pass.
CREATE FUNCTION public._phoenix_180_delegate_create_warehouse_dispatch(
  p_warehouse_id                      uuid,
  p_destination_distribution_point_id uuid,
  p_dispatch_number                   text,
  p_document_number                   text,
  p_default_currency                  text,
  p_notes                             text,
  p_authority                         text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_warehouse   public.warehouses%ROWTYPE;
  v_point       public.distribution_points%ROWTYPE;
  v_number      text := NULLIF(btrim(p_dispatch_number), '');
  v_document    text := NULLIF(btrim(p_document_number), '');
  v_currency    text := NULLIF(btrim(p_default_currency), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_dispatch    public.warehouse_dispatches%ROWTYPE;
BEGIN
  -- Authority is validated FIRST and fails closed. An unrecognised token is a
  -- programming error in a wrapper, never a client condition, so it is refused
  -- before anything is read or locked. There is no default: a caller that does
  -- not name an authority does not get one.
  IF p_authority IS NULL OR p_authority NOT IN ('ordinary', 'initial') THEN
    RAISE EXCEPTION 'dispatch_authority_unrecognised: %', COALESCE(p_authority, '<null>')
      USING ERRCODE = '23514';
  END IF;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_warehouse_id IS NULL OR p_destination_distribution_point_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_and_destination_required' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'dispatch_number_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_warehouse_id::text, 70169));

  SELECT * INTO v_warehouse
  FROM public.warehouses WHERE id = p_warehouse_id FOR SHARE;
  IF NOT FOUND OR v_warehouse.status <> 'active' THEN
    RAISE EXCEPTION 'warehouse_not_found_or_inactive' USING ERRCODE = 'P0002';
  END IF;

  -- Lock the destination point row so its warehouse_id/status/point_type
  -- cannot flip mid-transaction — the same lock discipline every route/pairing
  -- check in this domain uses. The authority gate below reads point_type from
  -- THIS locked row, so a concurrent point_type change cannot slip an emergency
  -- outlet past it.
  SELECT * INTO v_point
  FROM public.distribution_points WHERE id = p_destination_distribution_point_id FOR SHARE;
  IF NOT FOUND OR v_point.status <> 'active' THEN
    RAISE EXCEPTION 'destination_outlet_not_found_or_inactive' USING ERRCODE = 'P0002';
  END IF;
  IF v_point.point_type NOT IN ('pharmacy', 'crash_cabinet', 'rescue_cart') THEN
    RAISE EXCEPTION 'outlet_type_not_approved_for_stock: %', v_point.point_type
      USING ERRCODE = '23514';
  END IF;
  -- THE structural pairing, checked here with a named error — the composite
  -- FK on warehouse_dispatches would refuse this anyway, but a friendly error
  -- beats a raw constraint-violation message.
  IF v_point.warehouse_id IS DISTINCT FROM p_warehouse_id THEN
    RAISE EXCEPTION 'destination_outlet_not_paired_with_this_warehouse' USING ERRCODE = '23514';
  END IF;
  IF v_warehouse.organization_id <> v_point.organization_id THEN
    RAISE EXCEPTION 'warehouse_and_destination_organization_mismatch' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_dispatch.create', v_warehouse.organization_id, p_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_dispatch_create' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- ══════════════════════════════════════════════════════════════════════════
  -- 180 — THE AUTHORITY BOUNDARY (DISJOINT MATRIX)
  -- ══════════════════════════════════════════════════════════════════════════
  -- The two authorities partition the stock-holding destination vocabulary;
  -- neither may reach the other's outlets:
  --
  --     ORDINARY : pharmacy LEGAL · crash_cabinet FORBIDDEN · rescue_cart FORBIDDEN
  --     INITIAL  : pharmacy FORBIDDEN · crash_cabinet LEGAL  · rescue_cart LEGAL
  --
  -- Both refusals are unconditional: they consult no lifecycle row, no
  -- consumed_at stamp, no dispatch history and no balance, so they hold
  -- identically before, during and after the one-shot lifecycle, and after any
  -- later depletion or return.
  --
  -- Placed after the permission gate and before the INSERT: an unauthorised
  -- caller is already gone (and learns nothing about this outlet's corridor),
  -- and no dispatch row — and therefore no audit row — can exist by the time
  -- either branch raises.
  --
  -- The ORDINARY branch keys on point_type, never on clinical_location_kind: an
  -- ER pharmacy carries clinical_location_kind='emergency' yet is the SOURCE of
  -- 168 rescue-cart replenishment and must keep its own warehouse supply.
  --
  -- The INITIAL branch is the correction independent closure review required.
  -- Migration 166 accepted a pharmacy destination because it inherited 070's
  -- whole approved-type set; that is no longer the authoritative contract.
  -- Initial provisioning is the one-time commissioning of an EMERGENCY outlet.
  -- A pharmacy is supplied by ordinary warehouse dispatch, as often as needed,
  -- and has no commissioning lifecycle — so offering it one was an authority
  -- overlap, not a feature. The error names that precisely instead of reusing
  -- 070's generic outlet_type_not_approved_for_stock, which would wrongly claim
  -- the outlet cannot hold stock at all.
  IF p_authority = 'ordinary' THEN
    IF v_point.point_type IN ('crash_cabinet', 'rescue_cart') THEN
      RAISE EXCEPTION 'emergency_outlet_requires_initial_provisioning: %', v_point.point_type
        USING ERRCODE = '23514';
    END IF;
  ELSIF p_authority = 'initial' THEN
    IF v_point.point_type NOT IN ('crash_cabinet', 'rescue_cart') THEN
      RAISE EXCEPTION 'initial_provisioning_requires_emergency_outlet: %', v_point.point_type
        USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO public.warehouse_dispatches (
    organization_id, warehouse_id, destination_distribution_point_id,
    dispatch_number, status, document_number, default_currency, notes, created_by
  ) VALUES (
    v_warehouse.organization_id, p_warehouse_id, p_destination_distribution_point_id,
    v_number, 'draft', v_document, v_currency, v_notes, v_actor
  )
  RETURNING * INTO v_dispatch;

  -- 070's creation audit, unchanged, plus one ADDITIVE key: which authority
  -- created the row. Existing consumers read warehouse_id /
  -- distribution_point_id and are unaffected; the added key makes the corridor
  -- actually used visible in the audit trail rather than inferable only from
  -- the presence of a second, later audit row.
  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_warehouse.organization_id, v_actor, v_actor_role,
    'warehouse_dispatch.created', 'warehouse_dispatches', v_dispatch.id, v_number,
    jsonb_build_object(
      'warehouse_id', p_warehouse_id,
      'distribution_point_id', p_destination_distribution_point_id,
      'authority', p_authority
    )
  );

  RETURN jsonb_build_object('ok', true, 'dispatch_id', v_dispatch.id, 'status', v_dispatch.status);
END;
$$;

-- ============================================================================
-- 2. ORDINARY PUBLIC WRITER — unchanged signature, ORDINARY authority
-- ============================================================================
-- CREATE OR REPLACE keeps the OID, the ACL and every existing caller working:
-- 148/149/151's suggestion-accept bridge, the frontend dispatch service, the
-- E2E and demo fixtures and every historical test call the same function with
-- the same six arguments and get the same jsonb back.
--
-- The wrapper chooses 'ordinary' itself. Nothing about the call can influence
-- that choice.
--
-- CONSEQUENCE, stated plainly: any caller that reaches this function with an
-- emergency destination now fails closed. That includes the suggestion-accept
-- bridge (149:1503 / 151:441) when a `warehouse_to_outlet` suggestion targets a
-- crash cabinet or rescue cart. That path is the same bypass as any other — the
-- legal corridors for an emergency outlet are initial provisioning first, then
-- 168's routine pharmacy->emergency replenishment — so it is refused here
-- rather than special-cased. The suggestion row itself is untouched.
CREATE OR REPLACE FUNCTION public.phoenix_create_warehouse_dispatch(
  p_warehouse_id                      uuid,
  p_destination_distribution_point_id uuid,
  p_dispatch_number                   text,
  p_document_number                   text DEFAULT NULL,
  p_default_currency                  text DEFAULT NULL,
  p_notes                             text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN public._phoenix_180_delegate_create_warehouse_dispatch(
    p_warehouse_id,
    p_destination_distribution_point_id,
    p_dispatch_number,
    p_document_number,
    p_default_currency,
    p_notes,
    'ordinary'
  );
END;
$$;

-- ============================================================================
-- 3. INITIAL-PROVISIONING PUBLIC WRITER — unchanged signature, INITIAL authority
-- ============================================================================
-- Migration 166's body, unchanged except for its FIRST statement: it now calls
-- the trusted core with 'initial' instead of calling the ordinary public writer.
-- It therefore inherits exactly the same authentication, warehouse validation,
-- advisory lock, destination lock, pairing rule, organization match, permission
-- check, dispatch-number validation, INSERT and creation audit as before —
-- because that is the same code, in the same order, now living one level down.
--
-- Everything 166 owns is preserved verbatim below: the deterministic
-- duplicate-lifecycle check under the per-warehouse advisory lock, the named
-- initial_provisioning_already_exists_for_outlet error, the flag-only UPDATE
-- that keeps the write event-silent, the active-profile requirement, the
-- dedicated audit row and the return shape. The partial unique index remains
-- the structural backstop. 166 itself is NOT edited.
CREATE OR REPLACE FUNCTION public.phoenix_create_initial_provisioning_dispatch(
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
  -- core's, unchanged. It raises not_authenticated / dispatch_number_required
  -- / warehouse_not_found_or_inactive / destination_outlet_not_found_or_inactive
  -- / outlet_type_not_approved_for_stock / destination_outlet_not_paired_with_
  -- this_warehouse / warehouse_and_destination_organization_mismatch /
  -- forbidden_warehouse_dispatch_create / active_profile_required for us, and
  -- takes pg_advisory_xact_lock(hashtextextended(p_warehouse_id::text, 70169)).
  --
  -- 'initial' is a literal chosen HERE. It is not derived from any argument, so
  -- no caller of this RPC can ask for a different authority, and no caller of
  -- the ordinary RPC can ask for this one.
  v_created := public._phoenix_180_delegate_create_warehouse_dispatch(
    p_warehouse_id,
    p_destination_distribution_point_id,
    p_dispatch_number,
    p_document_number,
    p_default_currency,
    p_notes,
    'initial'
  );

  SELECT * INTO v_dispatch
  FROM public.warehouse_dispatches
  WHERE id = (v_created ->> 'dispatch_id')::uuid;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'initial_provisioning_dispatch_not_created' USING ERRCODE = 'P0002';
  END IF;

  -- Named error instead of a raw constraint violation — the same courtesy 070
  -- extends for the outlet/warehouse pairing. This check is DETERMINISTIC, not
  -- racy: the core above already holds the per-warehouse advisory lock, and
  -- the destination outlet is required to be paired with that same warehouse,
  -- so every competing creation for one outlet serialises on one lock. The
  -- partial unique index remains the structural backstop regardless.
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
-- 4. THE SECOND BYPASS — ROUTINE REPLENISHMENT BEFORE INITIAL PROVISIONING
-- ============================================================================
-- Closing the warehouse corridor is not sufficient on its own. Migration 168's
-- routine pharmacy->emergency replenishment validates route, authorization,
-- endpoint types, organization, facility, Shape H/I topology, FEFO, stock,
-- quantity and idempotency — but it never consults
-- warehouse_dispatches.is_initial_provisioning or
-- initial_provisioning_consumed_at. A brand-new crash cabinet or rescue cart
-- with a legal active route can therefore be stocked by routine replenishment
-- having never been initially provisioned: the SAME lifecycle invariant,
-- bypassed through the other door.
--
-- THE AUTHORITATIVE INITIAL-FIRST RULE
--
--     Warehouse/Depot
--         -> INITIAL PROVISIONING
--         -> actual POSITIVE receipt
--         -> initial_provisioning_consumed_at IS NOT NULL
--         -> routine pharmacy replenishment becomes legal
--
-- Routine replenishment before that milestone is forbidden.
--
-- The milestone is the durable Migration-166 marker, never a balance. A
-- lifecycle that was created but delivered NOTHING (fully rejected, or
-- cancelled while still a draft — 166 rules D and E) leaves consumed_at NULL
-- and does NOT open replenishment; and once the milestone is reached, a later
-- fall to zero on_hand does NOT close it again. Neither outlet_stock,
-- on_hand_quantity nor available_quantity appears in the predicate.
--
-- Header status is deliberately NOT the signal: Migration 166 created
-- consumed_at precisely because
-- phoenix_recompute_warehouse_dispatch_header_status emits 'partially_accepted'
-- for two different situations and 'accepted' as a terminal state (166:37-52).
--
-- HISTORICAL MIGRATION 168 IS NOT EDITED. Its body is reproduced here verbatim
-- — every validation, lock, revalidation, FEFO call, movement pair, audit
-- payload and return shape — with exactly ONE statement added. The signature,
-- owner, SECURITY DEFINER, search_path and ACL are unchanged, so 169's reversal
-- corridor and every existing caller keep working untouched.
--
-- WHERE THE GATE SITS, AND WHY THAT EXACT POINT
--
-- AFTER:  authentication · active profile · scoped outlet_stock.replenish
--         permission · the idempotent replay probe AND its successful return ·
--         route_not_active · endpoint row locks · canonical source/destination
--         context · endpoint type validation · organization / facility /
--         Shape H/I topology validation.
-- BEFORE: destination stock resolution or creation · either outlet_stock
--         FOR UPDATE · the source debit · the destination credit · both
--         movement rows · the audit row.
--
-- Placing it AFTER the replay return is required, not incidental: a request
-- that already completed successfully must keep its authorized idempotent
-- replay semantics forever. The gate governs FRESH stock movement only and
-- never retroactively invalidates a historical successful movement — including
-- movements made before this migration existed.
--
-- CONCURRENCY. consumed_at is monotonic: once stamped it is never cleared, so
-- the predicate can only ever transition NULL -> NOT NULL. The gate takes no
-- lock and introduces no new lock ordering, so it cannot invert 168's binding
-- order (advisory request lock -> route -> points ascending -> stocks
-- ascending). A replenishment racing an initial-provisioning receipt that has
-- not yet committed cannot see the stamp under READ COMMITTED and is refused;
-- once that receipt commits, the next fresh replenishment sees it and proceeds.
-- There is no window in which a balance-based shortcut could admit one early.
CREATE OR REPLACE FUNCTION public.phoenix_replenish_emergency_outlet(
  p_request_id               uuid,
  p_route_id                 uuid,
  p_source_outlet_stock_id   uuid,
  p_quantity                 integer,
  p_fefo_override_reason     text DEFAULT NULL,
  p_notes                    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor          uuid := auth.uid();
  v_actor_role     text;
  v_actor_name     text;
  v_override       text := NULLIF(btrim(p_fefo_override_reason), '');
  v_notes          text := NULLIF(btrim(p_notes), '');
  v_fingerprint    text;
  v_route          public.outlet_replenishment_routes%ROWTYPE;
  v_src_ctx        record;
  v_dst_ctx        record;
  v_src_stock      public.outlet_stock%ROWTYPE;
  v_dst_stock      public.outlet_stock%ROWTYPE;
  v_point_a        uuid;
  v_point_b        uuid;
  v_stock_first    uuid;
  v_stock_second   uuid;
  v_send_existing  public.outlet_stock_movements%ROWTYPE;
  v_recv_existing  public.outlet_stock_movements%ROWTYPE;
  v_fefo_first     uuid;
  v_src_before     integer;
  v_src_after      integer;
  v_dst_before     integer;
  v_dst_after      integer;
  v_send_id        uuid;
  v_recv_id        uuid;
  v_correlation_id uuid := gen_random_uuid();
  v_avail_src      uuid;
  v_avail_dst      uuid;
  v_tmp_stock      public.outlet_stock%ROWTYPE;
  v_dst_stock_id   uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_route_id IS NULL THEN
    RAISE EXCEPTION 'route_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_source_outlet_stock_id IS NULL THEN
    RAISE EXCEPTION 'source_outlet_stock_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := public._phoenix_replenishment_fingerprint_v1(
    p_route_id, p_source_outlet_stock_id, p_quantity, v_override, v_notes
  );

  -- 1. Advisory lock FIRST (salt 168168 — distinct from 067/106/156).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 168168));

  -- 2. Route row share-lock BEFORE the replay probe. Authorization scope
  --    derives from the route row, and EVERY successful return from this
  --    SECURITY DEFINER function — including idempotent_replay = true —
  --    must first prove an active profile holding outlet_stock.replenish
  --    for the source pharmacy scope. Lock order stays advisory → route →
  --    points → stocks (V4 §14 / §19.2); moving the route acquisition ahead
  --    of the replay probe does not invert any pair in that order.
  SELECT * INTO v_route
  FROM public.outlet_replenishment_routes
  WHERE id = p_route_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'route_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Authorization — existing key only; scoped to the route's source pharmacy.
  -- Enforced BEFORE any replay return so an unauthorized caller can never
  -- obtain successful replay semantics or operation details for an existing
  -- request_id. The fresh path later re-proves that the route's organization
  -- still equals the CURRENT canonical organization of both endpoints, so
  -- this route-scoped check is equivalent for every executable request.
  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.replenish', v_route.organization_id,
    NULL, v_route.source_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_stock_replenish' USING ERRCODE = '42501';
  END IF;

  -- Idempotent replay probe — no dedup table (V4 §14 / 070:342 idiom).
  -- Reached only by an authorized, active caller (above).
  SELECT * INTO v_send_existing
  FROM public.outlet_stock_movements m
  WHERE m.reference_type = 'outlet_replenishment'
    AND m.reference_id = p_request_id
    AND m.movement_type = 'replenish_send';

  SELECT * INTO v_recv_existing
  FROM public.outlet_stock_movements m
  WHERE m.reference_type = 'outlet_replenishment'
    AND m.reference_id = p_request_id
    AND m.movement_type = 'replenish_receive';

  IF FOUND OR v_send_existing.id IS NOT NULL THEN
    IF v_send_existing.id IS NULL OR v_recv_existing.id IS NULL THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505',
        DETAIL = 'partial replenishment legs for this request_id — refresh and resubmit';
    END IF;
    IF v_send_existing.request_fingerprint IS DISTINCT FROM v_fingerprint
       OR v_recv_existing.request_fingerprint IS DISTINCT FROM v_fingerprint
       OR v_send_existing.outlet_stock_id IS DISTINCT FROM p_source_outlet_stock_id THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505',
        DETAIL = 'same request_id previously submitted with a different payload';
    END IF;
    -- 180: this return is deliberately UPSTREAM of the initial-first gate
    -- below. A request that already completed successfully keeps its
    -- authorized replay semantics permanently, including one completed before
    -- this migration was applied. The gate governs fresh movement only.
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent_replay', true,
      'request_id', p_request_id,
      'route_id', p_route_id,
      'source_outlet_stock_id', v_send_existing.outlet_stock_id,
      'destination_outlet_stock_id', v_recv_existing.outlet_stock_id,
      'send_movement_id', v_send_existing.id,
      'receive_movement_id', v_recv_existing.id,
      'quantity', abs(v_send_existing.on_hand_delta),
      'source_quantity_before', v_send_existing.on_hand_before,
      'source_quantity_after', v_send_existing.on_hand_after,
      'destination_quantity_before', v_recv_existing.on_hand_before,
      'destination_quantity_after', v_recv_existing.on_hand_after,
      'request_fingerprint', v_fingerprint
    );
  END IF;

  -- Fresh execution from here on (route already share-locked above). A route
  -- deactivated AFTER a request completed must not break the authorized
  -- replay of that completed request, so is_active gates only fresh work.
  IF NOT v_route.is_active THEN
    RAISE EXCEPTION 'route_not_active' USING ERRCODE = '23514';
  END IF;

  -- 3. Distribution-point / facility context share-lock, ascending id.
  IF v_route.source_point_id < v_route.destination_point_id THEN
    v_point_a := v_route.source_point_id;
    v_point_b := v_route.destination_point_id;
  ELSE
    v_point_a := v_route.destination_point_id;
    v_point_b := v_route.source_point_id;
  END IF;

  PERFORM 1 FROM public.distribution_points WHERE id = v_point_a FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'distribution_point_not_found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.distribution_points WHERE id = v_point_b FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'distribution_point_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Resolve CURRENT canonical context (Addendum §F movement-time revalidation).
  SELECT * INTO v_src_ctx
  FROM public._phoenix_outlet_facility_context_v1(v_route.source_point_id);
  IF v_src_ctx.o_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'source_outlet_not_found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_dst_ctx
  FROM public._phoenix_outlet_facility_context_v1(v_route.destination_point_id);
  IF v_dst_ctx.o_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'destination_outlet_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Active endpoints.
  IF v_src_ctx.o_point_status <> 'active' THEN
    RAISE EXCEPTION 'source_outlet_inactive' USING ERRCODE = '23514';
  END IF;
  IF v_dst_ctx.o_point_status <> 'active' THEN
    RAISE EXCEPTION 'destination_outlet_inactive' USING ERRCODE = '23514';
  END IF;

  -- Typed endpoints must still match the route AND the Shape matrix.
  IF v_src_ctx.o_point_type <> 'pharmacy'
     OR v_src_ctx.o_point_type IS DISTINCT FROM v_route.source_point_type THEN
    RAISE EXCEPTION 'source_must_be_pharmacy' USING ERRCODE = '23514';
  END IF;
  IF v_dst_ctx.o_point_type NOT IN ('rescue_cart', 'crash_cabinet')
     OR v_dst_ctx.o_point_type IS DISTINCT FROM v_route.destination_point_type THEN
    RAISE EXCEPTION 'destination_must_be_emergency_outlet' USING ERRCODE = '23514';
  END IF;

  -- Organization relationship still matches the approved route.
  IF v_src_ctx.o_organization_id IS DISTINCT FROM v_dst_ctx.o_organization_id
     OR v_src_ctx.o_organization_id IS DISTINCT FROM v_route.organization_id THEN
    RAISE EXCEPTION 'cross_organization_route_forbidden' USING ERRCODE = '42501';
  END IF;

  IF v_src_ctx.o_institution_class IS NULL THEN
    RAISE EXCEPTION 'organization_institution_class_required' USING ERRCODE = '23514';
  END IF;
  IF v_dst_ctx.o_clinical_location_kind IS NULL THEN
    RAISE EXCEPTION 'destination_clinical_location_kind_required' USING ERRCODE = '23514';
  END IF;

  -- ── Addendum §F Shape H / Shape I (facility-based; NOT warehouse equality) ─
  IF v_src_ctx.o_institution_class = 'health_sector' THEN
    IF v_src_ctx.o_facility_id IS NULL OR v_dst_ctx.o_facility_id IS NULL THEN
      RAISE EXCEPTION 'health_center_route_requires_facility' USING ERRCODE = '23514';
    END IF;
    IF v_src_ctx.o_facility_id IS DISTINCT FROM v_dst_ctx.o_facility_id THEN
      RAISE EXCEPTION 'cross_facility_route_forbidden' USING ERRCODE = '42501';
    END IF;
    IF v_dst_ctx.o_facility_class NOT IN ('primary_health_center', 'subordinate_health_center') THEN
      RAISE EXCEPTION 'invalid_facility_class_for_route' USING ERRCODE = '23514';
    END IF;
    IF v_dst_ctx.o_facility_status <> 'active' THEN
      RAISE EXCEPTION 'facility_not_active' USING ERRCODE = '23514';
    END IF;
    IF v_dst_ctx.o_point_type <> 'crash_cabinet' THEN
      RAISE EXCEPTION 'health_center_rescue_cart_forbidden' USING ERRCODE = '23514';
    END IF;
    IF v_dst_ctx.o_clinical_location_kind <> 'emergency' THEN
      RAISE EXCEPTION 'health_center_crash_cabinet_requires_emergency' USING ERRCODE = '23514';
    END IF;

  ELSIF v_src_ctx.o_institution_class IN ('hospital', 'specialized_center') THEN
    IF v_src_ctx.o_facility_id IS NOT NULL OR v_dst_ctx.o_facility_id IS NOT NULL THEN
      RAISE EXCEPTION 'facility_not_permitted_for_this_institution_class' USING ERRCODE = '23514';
    END IF;

    IF v_dst_ctx.o_point_type = 'rescue_cart' THEN
      IF v_src_ctx.o_institution_class <> 'hospital' THEN
        RAISE EXCEPTION 'rescue_cart_requires_hospital' USING ERRCODE = '23514';
      END IF;
      IF v_dst_ctx.o_clinical_location_kind <> 'emergency' THEN
        RAISE EXCEPTION 'rescue_cart_requires_emergency_context' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF v_dst_ctx.o_clinical_location_kind <> 'non_emergency' THEN
        RAISE EXCEPTION 'crash_cabinet_requires_non_emergency_context' USING ERRCODE = '23514';
      END IF;
    END IF;

  ELSE
    RAISE EXCEPTION 'unsupported_institution_class_for_route' USING ERRCODE = '23514';
  END IF;

  -- ══════════════════════════════════════════════════════════════════════════
  -- 180 — INITIAL-FIRST GATE (the ONLY statement added to 168's body)
  -- ══════════════════════════════════════════════════════════════════════════
  -- Routine replenishment tops an emergency outlet UP; it does not commission
  -- one. Commissioning is initial provisioning, and it must have actually
  -- DELIVERED — a lifecycle that exists but delivered nothing leaves
  -- consumed_at NULL and does not open this corridor.
  --
  -- Reached only on the fresh path: authorization, the replay probe and its
  -- successful return, route activity and the whole Shape H/I topology are all
  -- already behind us, and nothing has been resolved, locked, debited,
  -- credited or written yet.
  --
  -- The predicate names only the durable 166 marker. No status, no
  -- outlet_stock, no on_hand_quantity, no available_quantity: a later fall to
  -- zero must not close a corridor that a consumed lifecycle opened, and a
  -- nonzero balance must never open one that no lifecycle did.
  IF NOT EXISTS (
    SELECT 1
    FROM public.warehouse_dispatches d
    WHERE d.destination_distribution_point_id = v_route.destination_point_id
      AND d.is_initial_provisioning
      AND d.initial_provisioning_consumed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'initial_provisioning_required_before_replenishment'
      USING ERRCODE = '23514';
  END IF;

  -- Authorization already enforced above (before the replay probe) against
  -- the route's organization/source point; the cross-organization check just
  -- above proves that scope equals the CURRENT canonical organization.

  -- Resolve source stock WITHOUT locking yet (lock order requires both stock
  -- rows FOR UPDATE ascending id after destination identity is known).
  SELECT * INTO v_src_stock
  FROM public.outlet_stock
  WHERE id = p_source_outlet_stock_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_outlet_stock_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_src_stock.distribution_point_id IS DISTINCT FROM v_route.source_point_id THEN
    RAISE EXCEPTION 'source_stock_not_on_route_pharmacy' USING ERRCODE = '23514';
  END IF;
  IF v_src_stock.organization_id IS DISTINCT FROM v_route.organization_id THEN
    RAISE EXCEPTION 'source_stock_organization_mismatch' USING ERRCODE = '42501';
  END IF;
  IF v_src_stock.expiry_date IS NOT NULL AND v_src_stock.expiry_date < current_date THEN
    RAISE EXCEPTION 'expired_batch_cannot_be_replenished' USING ERRCODE = '23514';
  END IF;

  -- FEFO revalidation via phoenix_inventory_fefo_batches (150:1597 / V4 §14).
  -- No second FEFO implementation.
  SELECT b.stock_id INTO v_fefo_first
  FROM public.phoenix_inventory_fefo_batches(
    v_src_stock.organization_id,
    'outlet',
    v_src_stock.distribution_point_id,
    v_src_stock.scientific_name,
    v_src_stock.national_code
  ) b
  LIMIT 1;

  IF v_fefo_first IS NULL THEN
    RAISE EXCEPTION 'no_fefo_candidate_for_material' USING ERRCODE = 'P0002';
  END IF;

  IF v_fefo_first IS DISTINCT FROM p_source_outlet_stock_id THEN
    IF v_override IS NULL THEN
      RAISE EXCEPTION 'fefo_override_required' USING ERRCODE = '23514';
    END IF;
    IF NOT public.phoenix_profile_has_scoped_permission(
      v_actor, 'inventory.fefo_override', v_src_stock.organization_id,
      NULL, v_src_stock.distribution_point_id
    ) THEN
      RAISE EXCEPTION 'forbidden_fefo_override' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Resolve (or create) destination outlet_stock with exact material identity
  -- including supply_type / purchase_origin (V4 §14 / §19.2 provenance).
  --
  -- CORRECTION (independent review, PR #109): Migration 150 makes
  -- material_identity_key (central_item_id, scientific_name, national_code,
  -- concentration, dosage_form, unit) the canonical material boundary, and
  -- outlet_stock_identity_v150_uniq allows two destination rows to coexist
  -- for the SAME distribution_point_id + lot/provenance tuple when their
  -- material_identity_key differs (e.g. unit='box' vs unit='strip', or a
  -- different central_item_id). The resolution below MUST therefore key off
  -- the generated material_identity_key — never rebuild identity from a
  -- partial field list — combined with the exact lot/provenance tuple the
  -- unique index enforces, so it can never match a different canonical
  -- material that merely shares scientific_name/national_code/concentration/
  -- dosage_form/batch/expiry/provenance.
  INSERT INTO public.outlet_stock (
    organization_id, distribution_point_id, point_type, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code,
    batch_number, has_no_batch_number, internal_batch_reference,
    expiry_date, on_hand_quantity, reserved_quantity,
    unit_price, price_basis, currency, supply_type_text,
    supply_type, purchase_origin,
    source_document_number, notes, created_by, updated_by
  ) VALUES (
    v_src_stock.organization_id, v_route.destination_point_id,
    v_dst_ctx.o_point_type, v_src_stock.central_item_id,
    v_src_stock.scientific_name, v_src_stock.trade_name,
    v_src_stock.concentration, v_src_stock.dosage_form, v_src_stock.unit,
    v_src_stock.national_code, v_src_stock.has_no_national_code,
    v_src_stock.batch_number, v_src_stock.has_no_batch_number,
    v_src_stock.internal_batch_reference,
    v_src_stock.expiry_date, 0, 0,
    v_src_stock.unit_price, v_src_stock.price_basis, v_src_stock.currency,
    v_src_stock.supply_type_text,
    v_src_stock.supply_type, v_src_stock.purchase_origin,
    v_src_stock.source_document_number, v_notes, v_actor, v_actor
  )
  ON CONFLICT DO NOTHING;

  SELECT s.id INTO v_dst_stock_id
  FROM public.outlet_stock s
  WHERE s.distribution_point_id = v_route.destination_point_id
    AND s.organization_id = v_src_stock.organization_id
    AND s.material_identity_key = v_src_stock.material_identity_key
    AND COALESCE(s.batch_number, '')  = COALESCE(v_src_stock.batch_number, '')
    AND COALESCE(s.expiry_date, DATE '0001-01-01')
        = COALESCE(v_src_stock.expiry_date, DATE '0001-01-01')
    AND COALESCE(s.internal_batch_reference, '')
        = COALESCE(v_src_stock.internal_batch_reference, '')
    AND COALESCE(s.supply_type, '') = COALESCE(v_src_stock.supply_type, '')
    AND COALESCE(s.purchase_origin, '') = COALESCE(v_src_stock.purchase_origin, '');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'destination_outlet_stock_identity_resolution_failed' USING ERRCODE = 'P0002';
  END IF;

  -- 4. Both outlet_stock rows FOR UPDATE in ascending id order (070:1121-1124).
  IF p_source_outlet_stock_id < v_dst_stock_id THEN
    v_stock_first := p_source_outlet_stock_id;
    v_stock_second := v_dst_stock_id;
  ELSE
    v_stock_first := v_dst_stock_id;
    v_stock_second := p_source_outlet_stock_id;
  END IF;

  SELECT * INTO v_tmp_stock FROM public.outlet_stock WHERE id = v_stock_first FOR UPDATE;
  SELECT * INTO v_dst_stock FROM public.outlet_stock WHERE id = v_stock_second FOR UPDATE;

  IF v_tmp_stock.id = p_source_outlet_stock_id THEN
    v_src_stock := v_tmp_stock;
  ELSE
    v_src_stock := v_dst_stock;
    v_dst_stock := v_tmp_stock;
  END IF;

  IF v_src_stock.id IS DISTINCT FROM p_source_outlet_stock_id
     OR v_dst_stock.id IS DISTINCT FROM v_dst_stock_id THEN
    RAISE EXCEPTION 'stock_lock_identity_mismatch' USING ERRCODE = 'P0002';
  END IF;

  -- Quantity checks after final locks.
  IF v_src_stock.available_quantity < p_quantity THEN
    RAISE EXCEPTION 'insufficient_source_stock' USING ERRCODE = '23514';
  END IF;

  v_src_before := v_src_stock.on_hand_quantity;
  v_src_after  := v_src_before - p_quantity;
  IF v_src_after < 0 THEN
    RAISE EXCEPTION 'outlet_quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;
  IF v_src_after < v_src_stock.reserved_quantity THEN
    RAISE EXCEPTION 'outlet_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  v_dst_before := v_dst_stock.on_hand_quantity;
  v_dst_after  := v_dst_before + p_quantity;

  UPDATE public.outlet_stock
     SET on_hand_quantity = v_src_after,
         notes            = COALESCE(v_notes, notes),
         updated_by       = v_actor
   WHERE id = v_src_stock.id;

  UPDATE public.outlet_stock
     SET on_hand_quantity = v_dst_after,
         unit_price       = COALESCE(v_src_stock.unit_price, unit_price),
         notes            = COALESCE(v_notes, notes),
         updated_by       = v_actor
   WHERE id = v_dst_stock.id;

  INSERT INTO public.outlet_stock_movements (
    outlet_stock_id, organization_id, distribution_point_id,
    movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reason_code, reference_type, reference_id, request_fingerprint,
    actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot, dosage_form_snapshot,
    batch_number_snapshot, internal_batch_reference_snapshot, expiry_date_snapshot,
    correlation_id
  ) VALUES (
    v_src_stock.id, v_src_stock.organization_id, v_src_stock.distribution_point_id,
    'replenish_send',
    v_src_before, -p_quantity, v_src_after,
    v_src_stock.reserved_quantity, 0, v_src_stock.reserved_quantity,
    v_notes, 'transferred', 'outlet_replenishment', p_request_id, v_fingerprint,
    v_actor, v_actor_role, v_actor_name,
    v_src_stock.scientific_name, v_src_stock.concentration, v_src_stock.dosage_form,
    v_src_stock.batch_number, v_src_stock.internal_batch_reference, v_src_stock.expiry_date,
    v_correlation_id
  )
  RETURNING id INTO v_send_id;

  INSERT INTO public.outlet_stock_movements (
    outlet_stock_id, organization_id, distribution_point_id,
    movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reason_code, reference_type, reference_id, request_fingerprint,
    actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot, dosage_form_snapshot,
    batch_number_snapshot, internal_batch_reference_snapshot, expiry_date_snapshot,
    correlation_id
  ) VALUES (
    v_dst_stock.id, v_dst_stock.organization_id, v_dst_stock.distribution_point_id,
    'replenish_receive',
    v_dst_before, p_quantity, v_dst_after,
    v_dst_stock.reserved_quantity, 0, v_dst_stock.reserved_quantity,
    v_notes, 'transferred', 'outlet_replenishment', p_request_id, v_fingerprint,
    v_actor, v_actor_role, v_actor_name,
    v_dst_stock.scientific_name, v_dst_stock.concentration, v_dst_stock.dosage_form,
    v_dst_stock.batch_number, v_dst_stock.internal_batch_reference, v_dst_stock.expiry_date,
    v_correlation_id
  )
  RETURNING id INTO v_recv_id;

  v_avail_src := public.phoenix_project_outlet_availability(v_src_stock.id);
  v_avail_dst := public.phoenix_project_outlet_availability(v_dst_stock.id);

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_src_stock.organization_id, v_actor, v_actor_role,
    'outlet_stock.replenish', 'outlet_replenishment_routes', p_route_id,
    v_src_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'route_id', p_route_id,
      'source_outlet_stock_id', v_src_stock.id,
      'destination_outlet_stock_id', v_dst_stock.id,
      'source_distribution_point_id', v_route.source_point_id,
      'destination_distribution_point_id', v_route.destination_point_id,
      'send_movement_id', v_send_id,
      'receive_movement_id', v_recv_id,
      'quantity', p_quantity,
      'source_quantity_before', v_src_before,
      'source_quantity_after', v_src_after,
      'destination_quantity_before', v_dst_before,
      'destination_quantity_after', v_dst_after,
      'fefo_override_applied', (v_override IS NOT NULL AND v_fefo_first IS DISTINCT FROM p_source_outlet_stock_id),
      'request_fingerprint', v_fingerprint,
      'correlation_id', v_correlation_id,
      'source_availability_id', v_avail_src,
      'destination_availability_id', v_avail_dst
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent_replay', false,
    'request_id', p_request_id,
    'route_id', p_route_id,
    'source_outlet_stock_id', v_src_stock.id,
    'destination_outlet_stock_id', v_dst_stock.id,
    'send_movement_id', v_send_id,
    'receive_movement_id', v_recv_id,
    'quantity', p_quantity,
    'source_quantity_before', v_src_before,
    'source_quantity_after', v_src_after,
    'destination_quantity_before', v_dst_before,
    'destination_quantity_after', v_dst_after,
    'request_fingerprint', v_fingerprint,
    'fefo_override_applied', (v_override IS NOT NULL AND v_fefo_first IS DISTINCT FROM p_source_outlet_stock_id)
  );
END;
$$;

-- ============================================================================
-- 5. GRANTS — the internal core is reachable from NOWHERE but the two wrappers
-- ============================================================================
-- The 149 internal-delegate idiom (149:2201-2239): PUBLIC, anon AND
-- authenticated all lose EXECUTE.
--
-- service_role is revoked TOO, which goes one step beyond that idiom and is
-- deliberate. Migration 109 installed a GLOBAL default privilege granting
-- service_role EXECUTE on every function `postgres` subsequently creates, so a
-- new function is service_role-executable unless this line says otherwise. That
-- default is right for ordinary RPCs; it is wrong for the one function in the
-- schema that takes an authority argument. Nothing needs the grant: both
-- wrappers are SECURITY DEFINER owned by the same role as the core, so they
-- reach it as the OWNER regardless of who called them. Revoking here makes the
-- reachable-caller set exactly {the two public wrappers} rather than {the two
-- public wrappers, plus anything holding the service key}.
--
-- This is what makes the boundary real rather than cosmetic: the core is the
-- only function in the schema that accepts an authority argument, and no role a
-- caller can present is able to invoke it.
REVOKE ALL ON FUNCTION public._phoenix_180_delegate_create_warehouse_dispatch(uuid, uuid, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- The two public writers keep the ACL they already had. CREATE OR REPLACE does
-- not alter existing grants, so these are restatements — harmless, and they
-- keep this file self-contained (the same reasoning 070:605-608 records).
REVOKE ALL ON FUNCTION public.phoenix_create_warehouse_dispatch(uuid, uuid, text, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_create_warehouse_dispatch(uuid, uuid, text, text, text, text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_create_initial_provisioning_dispatch(uuid, uuid, text, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_create_initial_provisioning_dispatch(uuid, uuid, text, text, text, text)
  TO authenticated;

-- Migration 168's own ACL idiom for the replenishment RPC, restated verbatim
-- so the replaced body keeps exactly the grants it already had.
REVOKE ALL ON FUNCTION public.phoenix_replenish_emergency_outlet(uuid, uuid, uuid, integer, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_replenish_emergency_outlet(uuid, uuid, uuid, integer, text, text)
  TO authenticated;

-- ============================================================================
-- 6. COMMENTS
-- ============================================================================
COMMENT ON FUNCTION public._phoenix_180_delegate_create_warehouse_dispatch(uuid, uuid, text, text, text, text, text) IS
  'R1.2 INTERNAL — the single trusted dispatch-creation core. Owns migration 070''s authentication, warehouse validation, per-warehouse advisory lock, destination row lock, pairing, organization match, scoped permission check, INSERT and creation audit, plus the emergency-outlet authority gate. p_authority is ''ordinary'' or ''initial'' and is supplied ONLY by the two SECURITY DEFINER public wrappers, never by a client: EXECUTE is revoked from PUBLIC, anon, authenticated and service_role, so the owner — and therefore only those two wrappers — can invoke it. Under ''ordinary'' authority a crash_cabinet or rescue_cart destination raises emergency_outlet_requires_initial_provisioning (23514) before any row is created — unconditionally, consulting no lifecycle state and no balance.';

COMMENT ON FUNCTION public.phoenix_create_warehouse_dispatch(uuid, uuid, text, text, text, text) IS
  'R1.2: creates a DRAFT ordinary warehouse dispatch. Signature and return shape unchanged since 070; the body now delegates to _phoenix_180_delegate_create_warehouse_dispatch with ORDINARY authority, hard-coded here. Warehouse/depot -> pharmacy remains legal. Warehouse/depot -> crash_cabinet or rescue_cart is ALWAYS refused with emergency_outlet_requires_initial_provisioning: those outlets are supplied from a warehouse only through phoenix_create_initial_provisioning_dispatch (166), and thereafter through the routine pharmacy->emergency replenishment corridor (168).';

COMMENT ON FUNCTION public.phoenix_create_initial_provisioning_dispatch(uuid, uuid, text, text, text, text) IS
  'E-4 / R1.2: creates a warehouse dispatch flagged as the destination outlet''s one-time initial provisioning. Signature, semantics, one-shot invariant, named errors and audit are migration 166''s, unchanged; it now delegates to _phoenix_180_delegate_create_warehouse_dispatch with INITIAL authority instead of to the ordinary public creator, so the emergency corridor can be closed to ordinary dispatch without closing it to this one. Destinations are crash_cabinet and rescue_cart ONLY — a pharmacy raises initial_provisioning_requires_emergency_outlet (23514), because a pharmacy has no commissioning lifecycle and is supplied by ordinary warehouse dispatch. Raises initial_provisioning_already_exists_for_outlet (23505) when the outlet already has an open or consumed lifecycle.';

COMMENT ON FUNCTION public.phoenix_replenish_emergency_outlet(uuid, uuid, uuid, integer, text, text) IS
  'E-5 / R1.2 atomic pharmacy->emergency-outlet replenishment. Debits the source pharmacy outlet_stock and credits the destination rescue_cart/crash_cabinet outlet_stock in one transaction under the Addendum-F Shape H/I matrix, with movement-time revalidation, FEFO via 150, and fingerprint idempotency. Permission: outlet_stock.replenish. No warehouse movement. Migration 168''s body is unchanged apart from ONE added gate: a FRESH execution requires the destination outlet to have CONSUMED an initial-provisioning lifecycle (warehouse_dispatches.is_initial_provisioning AND initial_provisioning_consumed_at IS NOT NULL), otherwise initial_provisioning_required_before_replenishment (23514). The gate reads no balance, and sits after the authorized idempotent replay return so a completed request keeps its replay semantics permanently.';

-- ============================================================================
-- 7. VERIFY — in-transaction, fails the whole migration
-- ============================================================================
DO $verify$
DECLARE
  v_ordinary   CONSTANT text := 'public.phoenix_create_warehouse_dispatch(uuid,uuid,text,text,text,text)';
  v_initial    CONSTANT text := 'public.phoenix_create_initial_provisioning_dispatch(uuid,uuid,text,text,text,text)';
  v_core       CONSTANT text := 'public._phoenix_180_delegate_create_warehouse_dispatch(uuid,uuid,text,text,text,text,text)';
  -- Assertions about what a body does — especially ABSENCE claims — must read
  -- CODE, not comments. The bodies above deliberately NAME the things they rule
  -- out, so a raw text search would test the documentation instead of the
  -- implementation. `n` makes `.` stop at a line break (the 166:452 idiom).
  c_strip CONSTANT text := '--.*$';
  v_repl       CONSTANT text := 'public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)';
  v_core_code  text;
  v_ord_code   text;
  v_ini_code   text;
  v_repl_code  text;
  v_gate       text;
  v_idx        text;
  v_leak       text;
BEGIN
  -- ── 6a. The internal core exists at the exact signature, with the expected
  -- security posture.
  IF to_regprocedure(v_core) IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the internal core has the wrong signature';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_core::regprocedure) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the internal core is not SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = v_core::regprocedure
      AND proconfig @> ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the internal core does not pin search_path to public, pg_temp';
  END IF;
  -- Owner parity is what lets the fully-revoked core stay reachable from the
  -- wrappers and nowhere else.
  IF (SELECT proowner FROM pg_proc WHERE oid = v_core::regprocedure)
     <> (SELECT proowner FROM pg_proc WHERE oid = v_ordinary::regprocedure) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the internal core has a different owner than the ordinary writer';
  END IF;

  -- ── 6b. INTERNAL-HELPER SECURITY — the negative proof, asserted in the
  -- migration itself and not only in a test file.
  IF has_function_privilege('authenticated', v_core::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): authenticated can execute the internal core';
  END IF;
  IF has_function_privilege('anon', v_core::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): anon can execute the internal core';
  END IF;
  -- Not part of §11's minimum, but see section 4: migration 109's global
  -- default privilege would otherwise hand service_role EXECUTE on the one
  -- authority-selecting function in the schema.
  IF has_function_privilege('service_role', v_core::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): service_role can execute the internal core';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p,
         LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = v_core::regprocedure
      AND a.grantee = 0                       -- 0 = PUBLIC
      AND a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): PUBLIC can execute the internal core';
  END IF;

  -- ── 6c. AUTHORITY CONFUSION — structural, over the WHOLE public schema.
  -- No function any client-facing role can execute may take an authority/mode
  -- parameter. This is the property that makes the boundary un-bypassable, so
  -- it is asserted globally rather than for the three functions edited here.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_leak
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND pg_get_function_arguments(p.oid)
        ~* '(p_authority|p_is_initial|p_initial_provisioning|p_mode|p_dispatch_mode)'
    AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
         OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_leak IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): a client-reachable RPC lets the caller select an authority: %', v_leak;
  END IF;

  -- ── 6d. The core really owns the relocated mechanics. If any of these were
  -- lost in the move, the two corridors would silently differ from 070.
  v_core_code := regexp_replace(pg_get_functiondef(v_core::regprocedure), c_strip, '', 'gn');
  IF v_core_code NOT LIKE '%hashtextextended(p_warehouse_id::text, 70169)%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the core lost the 70169 per-warehouse advisory lock';
  END IF;
  IF v_core_code NOT LIKE '%FROM public.warehouses WHERE id = p_warehouse_id FOR SHARE%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the core lost the warehouse row lock';
  END IF;
  IF v_core_code NOT LIKE '%FROM public.distribution_points WHERE id = p_destination_distribution_point_id FOR SHARE%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the core lost the destination row lock';
  END IF;
  IF v_core_code NOT LIKE '%phoenix_profile_has_scoped_permission%'
     OR v_core_code NOT LIKE '%warehouse_dispatch.create%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the core lost the scoped permission check';
  END IF;
  IF v_core_code NOT LIKE '%outlet_type_not_approved_for_stock%'
     OR v_core_code NOT LIKE '%destination_outlet_not_paired_with_this_warehouse%'
     OR v_core_code NOT LIKE '%warehouse_and_destination_organization_mismatch%'
     OR v_core_code NOT LIKE '%warehouse_not_found_or_inactive%'
     OR v_core_code NOT LIKE '%destination_outlet_not_found_or_inactive%'
     OR v_core_code NOT LIKE '%dispatch_number_required%'
     OR v_core_code NOT LIKE '%active_profile_required%'
     OR v_core_code NOT LIKE '%not_authenticated%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the core lost one of 070''s named errors';
  END IF;
  IF v_core_code NOT LIKE '%INSERT INTO public.warehouse_dispatches%'
     OR v_core_code NOT LIKE '%warehouse_dispatch.created%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the core lost the INSERT or the creation audit';
  END IF;

  -- ── 6e. The DISJOINT authority matrix: both branches present, each keyed on
  -- its own authority, and both blind to lifecycle state and balance.
  --
  --     ORDINARY : pharmacy LEGAL · crash_cabinet/rescue_cart FORBIDDEN
  --     INITIAL  : crash_cabinet/rescue_cart LEGAL · pharmacy FORBIDDEN
  IF v_core_code NOT LIKE '%emergency_outlet_requires_initial_provisioning%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the core does not raise the emergency-corridor error';
  END IF;
  IF v_core_code NOT LIKE '%initial_provisioning_requires_emergency_outlet%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): INITIAL authority still accepts a pharmacy destination';
  END IF;
  IF v_core_code NOT LIKE '%crash_cabinet%' OR v_core_code NOT LIKE '%rescue_cart%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the gate does not name both emergency outlet types';
  END IF;
  IF v_core_code NOT LIKE '%p_authority = ''ordinary''%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the ordinary branch is not conditioned on ORDINARY authority';
  END IF;
  IF v_core_code NOT LIKE '%p_authority = ''initial''%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the initial branch is not conditioned on INITIAL authority';
  END IF;
  -- The two branches must be complementary, not two copies of the same test:
  -- ordinary excludes the emergency pair, initial requires it.
  IF v_core_code NOT LIKE '%point_type IN (''crash_cabinet'', ''rescue_cart'')%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the ordinary branch does not exclude the emergency pair';
  END IF;
  IF v_core_code NOT LIKE '%point_type NOT IN (''crash_cabinet'', ''rescue_cart'')%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the initial branch does not require an emergency outlet';
  END IF;
  -- Both refusals must precede the INSERT, so neither can leave a dispatch row
  -- or an audit row behind.
  IF position('initial_provisioning_requires_emergency_outlet' in v_core_code)
     > position('INSERT INTO public.warehouse_dispatches' in v_core_code) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the initial-authority refusal can leave a dispatch row';
  END IF;
  IF position('emergency_outlet_requires_initial_provisioning' in v_core_code)
     > position('INSERT INTO public.warehouse_dispatches' in v_core_code) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the ordinary-authority refusal can leave a dispatch row';
  END IF;
  -- …and both must follow the permission gate, so an unauthorised caller
  -- cannot use either error to probe outlet types.
  IF position('forbidden_warehouse_dispatch_create' in v_core_code)
     > position('emergency_outlet_requires_initial_provisioning' in v_core_code) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the corridor refusal precedes the permission gate';
  END IF;
  -- The invariant must be historical, never balance-derived: no lifecycle
  -- column and no balance column may appear anywhere in the core. This is the
  -- structural refusal of the weaker "consumed-only" guard, and the same shape
  -- of assertion 166 used for its own rule G.
  IF v_core_code LIKE '%initial_provisioning_consumed_at%'
     OR v_core_code LIKE '%is_initial_provisioning%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the gate consults initial-provisioning lifecycle state';
  END IF;
  IF v_core_code LIKE '%on_hand%' OR v_core_code LIKE '%outlet_stock%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the gate consults a balance';
  END IF;
  -- Fail-closed authority validation.
  IF v_core_code NOT LIKE '%dispatch_authority_unrecognised%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the core does not reject an unrecognised authority';
  END IF;

  -- ── 6f. The ordinary writer: signature preserved, ORDINARY authority
  -- hard-coded, no way for an argument to influence it.
  IF pg_get_function_arguments(v_ordinary::regprocedure)
     <> 'p_warehouse_id uuid, p_destination_distribution_point_id uuid, '
        || 'p_dispatch_number text, p_document_number text DEFAULT NULL::text, '
        || 'p_default_currency text DEFAULT NULL::text, p_notes text DEFAULT NULL::text' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the ordinary writer signature changed';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_ordinary::regprocedure) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the ordinary writer is no longer SECURITY DEFINER';
  END IF;
  v_ord_code := regexp_replace(pg_get_functiondef(v_ordinary::regprocedure), c_strip, '', 'gn');
  IF v_ord_code NOT LIKE '%_phoenix_180_delegate_create_warehouse_dispatch(%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the ordinary writer does not delegate to the core';
  END IF;
  IF v_ord_code NOT LIKE '%''ordinary''%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the ordinary writer does not pass ORDINARY authority';
  END IF;
  IF v_ord_code LIKE '%''initial''%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the ordinary writer can reach INITIAL authority';
  END IF;

  -- ── 6g. The initial writer: signature preserved, INITIAL authority, and it
  -- no longer routes through the ordinary PUBLIC writer (which is exactly what
  -- would re-open the bypass, because that writer now refuses this corridor).
  IF pg_get_function_arguments(v_initial::regprocedure)
     <> 'p_warehouse_id uuid, p_destination_distribution_point_id uuid, '
        || 'p_dispatch_number text, p_document_number text DEFAULT NULL::text, '
        || 'p_default_currency text DEFAULT NULL::text, p_notes text DEFAULT NULL::text' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the initial writer signature changed';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_initial::regprocedure) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the initial writer is no longer SECURITY DEFINER';
  END IF;
  v_ini_code := regexp_replace(pg_get_functiondef(v_initial::regprocedure), c_strip, '', 'gn');
  IF v_ini_code NOT LIKE '%_phoenix_180_delegate_create_warehouse_dispatch(%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the initial writer does not delegate to the core';
  END IF;
  IF v_ini_code NOT LIKE '%''initial''%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the initial writer does not pass INITIAL authority';
  END IF;
  IF v_ini_code LIKE '%public.phoenix_create_warehouse_dispatch(%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the initial writer still routes through the ordinary public writer';
  END IF;
  -- 166's own semantics, preserved in the replaced body.
  IF v_ini_code NOT LIKE '%initial_provisioning_already_exists_for_outlet%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the initial writer lost its named duplicate-lifecycle error';
  END IF;
  IF v_ini_code NOT LIKE '%is_initial_provisioning = true%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the initial writer no longer flags the lifecycle';
  END IF;
  IF v_ini_code NOT LIKE '%warehouse_dispatch.initial_provisioning_created%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the initial writer lost its dedicated audit row';
  END IF;

  -- ── 6h. Both public writers keep their historical ACL: authenticated yes,
  -- anon no, PUBLIC no. 180 expands no surface.
  IF NOT has_function_privilege('authenticated', v_ordinary::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): authenticated lost the ordinary writer';
  END IF;
  IF NOT has_function_privilege('authenticated', v_initial::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): authenticated lost the initial writer';
  END IF;
  IF has_function_privilege('anon', v_ordinary::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', v_initial::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): anon can execute a dispatch writer';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p,
         LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid IN (v_ordinary::regprocedure, v_initial::regprocedure)
      AND a.grantee = 0
      AND a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): PUBLIC can execute a dispatch writer';
  END IF;

  -- ── 6i. THE REPLENISHMENT INITIAL-FIRST GATE, and 168 preserved around it.
  v_repl_code := regexp_replace(pg_get_functiondef(v_repl::regprocedure), c_strip, '', 'gn');

  IF v_repl_code NOT LIKE '%initial_provisioning_required_before_replenishment%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): routine replenishment does not require initial provisioning';
  END IF;
  IF v_repl_code NOT LIKE '%initial_provisioning_consumed_at IS NOT NULL%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the replenishment gate does not read the consumed marker';
  END IF;
  IF v_repl_code NOT LIKE '%d.is_initial_provisioning%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the replenishment gate does not read the lifecycle flag';
  END IF;

  -- The gate's PREDICATE — not the whole body, which legitimately moves stock —
  -- must be blind to balance and to the ambiguous header status. Extracted
  -- exactly: from the dispatch table reference to the refusal it guards.
  v_gate := substr(
    v_repl_code,
    position('FROM public.warehouse_dispatches d' in v_repl_code),
    position('initial_provisioning_required_before_replenishment' in v_repl_code)
      - position('FROM public.warehouse_dispatches d' in v_repl_code));
  IF v_gate = '' OR v_gate IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the replenishment gate predicate could not be located';
  END IF;
  IF v_gate LIKE '%on_hand%' OR v_gate LIKE '%available_quantity%'
     OR v_gate LIKE '%outlet_stock%' OR v_gate LIKE '%quantity%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the replenishment gate derives eligibility from a balance';
  END IF;
  IF v_gate LIKE '%status%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the replenishment gate uses the ambiguous header status';
  END IF;

  -- ORDERING. The authorized idempotent replay must return BEFORE the gate, so
  -- a request that already completed keeps its replay semantics permanently;
  -- and the gate must precede every write, so a refusal moves nothing.
  IF position('''idempotent_replay'', true' in v_repl_code)
     > position('initial_provisioning_required_before_replenishment' in v_repl_code) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the gate precedes the authorized idempotent replay return';
  END IF;
  IF position('initial_provisioning_required_before_replenishment' in v_repl_code)
     > position('INSERT INTO public.outlet_stock ' in v_repl_code) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the gate runs after destination stock resolution';
  END IF;
  IF position('initial_provisioning_required_before_replenishment' in v_repl_code)
     > position('FOR UPDATE' in v_repl_code) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the gate runs after a stock row is locked';
  END IF;
  IF position('initial_provisioning_required_before_replenishment' in v_repl_code)
     > position('INSERT INTO public.outlet_stock_movements' in v_repl_code) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the gate runs after a movement is written';
  END IF;
  -- …and AFTER the topology matrix, so a structurally illegal route still gets
  -- its own accurate diagnosis rather than a lifecycle error.
  IF position('unsupported_institution_class_for_route' in v_repl_code)
     > position('initial_provisioning_required_before_replenishment' in v_repl_code) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the gate precedes the Shape H/I topology matrix';
  END IF;

  -- 168 PRESERVED. Signature, security posture, owner and ACL unchanged, and
  -- every named mechanic still present in the replaced body.
  IF pg_get_function_arguments(v_repl::regprocedure)
     <> 'p_request_id uuid, p_route_id uuid, p_source_outlet_stock_id uuid, '
        || 'p_quantity integer, p_fefo_override_reason text DEFAULT NULL::text, '
        || 'p_notes text DEFAULT NULL::text' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the replenishment signature changed';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_repl::regprocedure) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the replenishment RPC is no longer SECURITY DEFINER';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = v_repl::regprocedure AND proconfig @> ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the replenishment RPC lost its pinned search_path';
  END IF;
  IF (SELECT proowner FROM pg_proc WHERE oid = v_repl::regprocedure)
     <> (SELECT proowner FROM pg_proc WHERE oid = v_ordinary::regprocedure) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the replenishment RPC changed owner';
  END IF;
  IF NOT has_function_privilege('authenticated', v_repl::regprocedure, 'EXECUTE')
     OR has_function_privilege('anon', v_repl::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the replenishment ACL changed';
  END IF;
  IF v_repl_code NOT LIKE '%hashtextextended(p_request_id::text, 168168)%'
     OR v_repl_code NOT LIKE '%_phoenix_replenishment_fingerprint_v1(%'
     OR v_repl_code NOT LIKE '%request_id_conflict%'
     OR v_repl_code NOT LIKE '%forbidden_outlet_stock_replenish%'
     OR v_repl_code NOT LIKE '%route_not_active%'
     OR v_repl_code NOT LIKE '%source_must_be_pharmacy%'
     OR v_repl_code NOT LIKE '%destination_must_be_emergency_outlet%'
     OR v_repl_code NOT LIKE '%health_center_rescue_cart_forbidden%'
     OR v_repl_code NOT LIKE '%rescue_cart_requires_hospital%'
     OR v_repl_code NOT LIKE '%crash_cabinet_requires_non_emergency_context%'
     OR v_repl_code NOT LIKE '%cross_facility_route_forbidden%'
     OR v_repl_code NOT LIKE '%phoenix_inventory_fefo_batches(%'
     OR v_repl_code NOT LIKE '%fefo_override_required%'
     OR v_repl_code NOT LIKE '%insufficient_source_stock%'
     OR v_repl_code NOT LIKE '%outlet_quantity_cannot_go_negative%'
     OR v_repl_code NOT LIKE '%stock_lock_identity_mismatch%'
     OR v_repl_code NOT LIKE '%''replenish_send''%'
     OR v_repl_code NOT LIKE '%''replenish_receive''%'
     OR v_repl_code NOT LIKE '%material_identity_key%'
     OR v_repl_code NOT LIKE '%phoenix_project_outlet_availability(%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the replaced replenishment body lost a 168 mechanic';
  END IF;

  -- 169's reversal must be untouched and must NOT have acquired the gate.
  IF pg_get_functiondef('public.phoenix_reverse_outlet_replenishment(uuid,uuid,uuid,integer,text,text)'::regprocedure)
     LIKE '%initial_provisioning_required_before_replenishment%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the 169 reversal was modified';
  END IF;

  -- ── 6j. NON-REGRESSION — 166's objects are exactly as 166 left them.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouse_dispatches'
      AND column_name='is_initial_provisioning'
      AND data_type='boolean' AND is_nullable='NO' AND column_default='false'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): is_initial_provisioning changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouse_dispatches'
      AND column_name='initial_provisioning_consumed_at'
      AND data_type='timestamp with time zone' AND is_nullable='YES'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): initial_provisioning_consumed_at changed';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conname='wd_initial_provisioning_consumed_chk') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): wd_initial_provisioning_consumed_chk was dropped';
  END IF;
  SELECT indexdef INTO v_idx FROM pg_indexes
  WHERE schemaname='public' AND indexname='warehouse_dispatches_initial_provisioning_once_uniq';
  IF v_idx IS NULL
     OR v_idx NOT LIKE 'CREATE UNIQUE INDEX%'
     OR v_idx NOT LIKE '%(destination_distribution_point_id)%'
     OR v_idx NOT LIKE '%initial_provisioning_consumed_at IS NOT NULL%'
     OR v_idx NOT LIKE '%draft%' OR v_idx NOT LIKE '%sent%' OR v_idx NOT LIKE '%partially_accepted%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the 166 one-shot invariant index changed';
  END IF;
  -- 166's consumption stamp still lives on the receive wrapper, untouched.
  IF pg_get_functiondef('public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text,text)'::regprocedure)
     NOT LIKE '%initial_provisioning_consumed_at = now()%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the 166 consumption stamp was disturbed';
  END IF;

  -- ── 6k. NON-REGRESSION — 180 stays inside its own concern.
  -- The routine emergency replenishment corridor (168) and its reversal (169)
  -- are the outlets' legal ongoing supply after provisioning; 180 must not have
  -- touched them.
  IF to_regprocedure('public.phoenix_replenish_emergency_outlet(uuid,uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the 168 replenishment corridor is missing';
  END IF;
  -- Exactly two balance truths.
  IF (SELECT count(*) FROM pg_class
      WHERE relname IN ('pharmacy_stock','rescue_cart_stock','crash_cabinet_stock','facility_stock')) <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): a second balance ledger exists';
  END IF;
  -- The dispatch status vocabulary the 166 invariant reads is unchanged.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='warehouse_dispatches_status_chk')
     <> $chk$CHECK ((status = ANY (ARRAY['draft'::text, 'sent'::text, 'partially_accepted'::text, 'accepted'::text, 'rejected'::text, 'cancelled'::text])))$chk$ THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the dispatch status vocabulary changed';
  END IF;
  -- 177's public QR remains the ONLY anonymous function surface: 180 adds none.
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname LIKE '%warehouse_dispatch%'
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): a warehouse-dispatch function became anon-reachable';
  END IF;

  RAISE NOTICE '180 VERIFY OK.';
END;
$verify$;

COMMIT;

-- ============================================================================
-- ROLLBACK (manual):
--   Re-apply, verbatim and in this order, the three historical function bodies
--   this migration replaced — each as a CREATE OR REPLACE of its own unchanged
--   signature:
--
--     1. the ordinary dispatch creator, from migration 070 lines 617-711;
--     2. the initial-provisioning creator, from migration 166 lines 244-339;
--     3. the emergency replenishment RPC, from migration 168 lines 170-683.
--
--   then
--     DROP FUNCTION public._phoenix_180_delegate_create_warehouse_dispatch(
--       uuid, uuid, text, text, text, text, text);
--
--   (The three restores are described rather than spelled out here on purpose:
--   a literal declaration inside a comment reads as a real one to the
--   movement-writer discovery guard, which resolves each writer by its LAST
--   declaration in the corpus.)
--
--   Rolling back REOPENS all three bypasses this migration closes. It creates,
--   alters and deletes no data, so a rollback loses nothing except the
--   boundaries themselves.
-- ============================================================================
-- END OF MIGRATION 180
-- ============================================================================

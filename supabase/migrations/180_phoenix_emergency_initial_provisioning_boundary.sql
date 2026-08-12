-- ============================================================================
-- R1.2 — EMERGENCY-OUTLET INITIAL-PROVISIONING AUTHORITY BOUNDARY (180)
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 179, via the Supabase SQL Editor, after reading this file in full.
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
-- 166 is not wrong; it is incomplete — it closed one door in a room with two.
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
-- This change is network-wide, and it CLOSES a corridor that live data may be
-- using. Before applying to Production the authorised operator must run the
-- inventory query recorded in this PR's description over ALL organizations and
-- confirm that no live crash_cabinet / rescue_cart would be stranded: every
-- such outlet must either still have its one-shot initial-provisioning
-- lifecycle available, or already be reachable by an ACTIVE 168 replenishment
-- route from a legal pharmacy. An outlet that has consumed its lifecycle and
-- has no active route would, after this migration, have no legal inbound
-- corridor at all. This migration deliberately does not repair such a row: it
-- cannot invent a route, and silently leaving the bypass open is the defect.
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
  v_ord_def    text;
  v_ini_def    text;
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

  -- ── Idempotency guard: this migration is not re-runnable.
  IF to_regprocedure(v_core) IS NOT NULL THEN
    RAISE EXCEPTION '180_precondition_failed: the 180 internal core already exists';
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
  -- 180 — THE AUTHORITY BOUNDARY
  -- ══════════════════════════════════════════════════════════════════════════
  -- Warehouse/depot direct supply to an emergency outlet is legal ONLY through
  -- the dedicated initial-provisioning authority. This refusal is
  -- unconditional: it consults no lifecycle row, no consumed_at stamp, no
  -- dispatch history and no balance, so it holds identically before, during and
  -- after the one-shot lifecycle, and after any later depletion or return.
  --
  -- Placed after the permission gate and before the INSERT: an unauthorised
  -- caller is already gone (and learns nothing about this outlet's corridor),
  -- and no dispatch row can exist by the time this raises.
  --
  -- crash_cabinet / rescue_cart are the 168/169 emergency destination types.
  -- pharmacy — including an ER pharmacy carrying
  -- clinical_location_kind='emergency' — is untouched and stays legal here.
  IF p_authority = 'ordinary'
     AND v_point.point_type IN ('crash_cabinet', 'rescue_cart') THEN
    RAISE EXCEPTION 'emergency_outlet_requires_initial_provisioning: %', v_point.point_type
      USING ERRCODE = '23514';
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
-- 4. GRANTS — the internal core is reachable from NOWHERE but the two wrappers
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

-- ============================================================================
-- 5. COMMENTS
-- ============================================================================
COMMENT ON FUNCTION public._phoenix_180_delegate_create_warehouse_dispatch(uuid, uuid, text, text, text, text, text) IS
  'R1.2 INTERNAL — the single trusted dispatch-creation core. Owns migration 070''s authentication, warehouse validation, per-warehouse advisory lock, destination row lock, pairing, organization match, scoped permission check, INSERT and creation audit, plus the emergency-outlet authority gate. p_authority is ''ordinary'' or ''initial'' and is supplied ONLY by the two SECURITY DEFINER public wrappers, never by a client: EXECUTE is revoked from PUBLIC, anon, authenticated and service_role, so the owner — and therefore only those two wrappers — can invoke it. Under ''ordinary'' authority a crash_cabinet or rescue_cart destination raises emergency_outlet_requires_initial_provisioning (23514) before any row is created — unconditionally, consulting no lifecycle state and no balance.';

COMMENT ON FUNCTION public.phoenix_create_warehouse_dispatch(uuid, uuid, text, text, text, text) IS
  'R1.2: creates a DRAFT ordinary warehouse dispatch. Signature and return shape unchanged since 070; the body now delegates to _phoenix_180_delegate_create_warehouse_dispatch with ORDINARY authority, hard-coded here. Warehouse/depot -> pharmacy remains legal. Warehouse/depot -> crash_cabinet or rescue_cart is ALWAYS refused with emergency_outlet_requires_initial_provisioning: those outlets are supplied from a warehouse only through phoenix_create_initial_provisioning_dispatch (166), and thereafter through the routine pharmacy->emergency replenishment corridor (168).';

COMMENT ON FUNCTION public.phoenix_create_initial_provisioning_dispatch(uuid, uuid, text, text, text, text) IS
  'E-4 / R1.2: creates a warehouse dispatch flagged as the destination outlet''s one-time initial provisioning. Signature, semantics, one-shot invariant, named errors and audit are migration 166''s, unchanged; it now delegates to _phoenix_180_delegate_create_warehouse_dispatch with INITIAL authority instead of to the ordinary public creator, so the emergency corridor can be closed to ordinary dispatch without closing it to this one. Raises initial_provisioning_already_exists_for_outlet (23505) when the outlet already has an open or consumed lifecycle.';

-- ============================================================================
-- 6. VERIFY — in-transaction, fails the whole migration
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
  v_core_code  text;
  v_ord_code   text;
  v_ini_code   text;
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

  -- ── 6e. The gate itself: present, keyed on both emergency types, applied to
  -- ORDINARY authority only, and blind to lifecycle state and balance.
  IF v_core_code NOT LIKE '%emergency_outlet_requires_initial_provisioning%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the core does not raise the emergency-corridor error';
  END IF;
  IF v_core_code NOT LIKE '%crash_cabinet%' OR v_core_code NOT LIKE '%rescue_cart%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the gate does not name both emergency outlet types';
  END IF;
  IF v_core_code NOT LIKE '%p_authority = ''ordinary''%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (180): the gate is not conditioned on ORDINARY authority';
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

  -- ── 6i. NON-REGRESSION — 166's objects are exactly as 166 left them.
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

  -- ── 6j. NON-REGRESSION — 180 stays inside its own concern.
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
--   Restore migration 070's creator body verbatim (070:617-711) as
--     CREATE OR REPLACE FUNCTION public.phoenix_create_warehouse_dispatch(...)
--   restore migration 166's RPC body verbatim (166:244-339) as
--     CREATE OR REPLACE FUNCTION public.phoenix_create_initial_provisioning_dispatch(...)
--   then
--     DROP FUNCTION public._phoenix_180_delegate_create_warehouse_dispatch(
--       uuid, uuid, text, text, text, text, text);
--
--   Rolling back REOPENS the emergency-outlet bypass this migration closes. It
--   creates, alters and deletes no data, so a rollback loses nothing except the
--   boundary itself.
-- ============================================================================
-- END OF MIGRATION 180
-- ============================================================================

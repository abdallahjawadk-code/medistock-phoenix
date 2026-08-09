-- ============================================================================
-- ORGANIZATION-CLASS-AND-WAREHOUSE-FACILITY-ASSIGNMENT-170  (Stage E · E7-1)
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 169, via the Supabase SQL Editor, after reading this file in
-- full.
--
-- NOT APPLIED BY THIS PR. Authored and replayed on a disposable PostgreSQL rig
-- only. Migrations 001-169 are immutable and are NOT edited here.
--
-- Stage E / E7-1 (backend/admin identity hardening). Apply after 169.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- The Production pre-launch organization reset removed every legacy
-- NULL-`institution_class` organization. That legacy condition — 164 leaving
-- `institution_class` nullable only because existing rows could not be safely
-- guessed — no longer exists, so E-7's target behavior can now be enforced as
-- a database hard guarantee rather than a UI convention:
--
--   A. `organizations.institution_class` becomes NOT NULL. Every organization
--      created from this point forward MUST declare exactly one of
--      `hospital | health_sector | specialized_center` at creation. The
--      existing 3-value CHECK (`organizations_institution_class_chk`, 164) is
--      preserved byte-identical — no Postgres enum type, no fourth value, no
--      `health_center` (health centres remain `organization_facilities` rows
--      under a `health_sector`, never a peer organization class).
--
--      CANONICAL_DEMO_FIXTURE_RECONCILIATION (narrow, not generic backfill):
--      the preflight ALSO reconciles ONLY the two fixed-UUID Migration-004
--      demo-seed organizations (`...0001` "Babil General Hospital", `...0002`
--      "Al-Hilla Teaching Hospital" — both unambiguously named as hospitals in
--      004 itself) from NULL to `hospital`, and ONLY when the row found under
--      that exact UUID still carries a byte-identical Migration-004 identity
--      fingerprint (name, name_ar, code, status, city). No other organization
--      — by UUID, by name pattern, or by any other inference — is ever
--      touched. A row found under one of these two UUIDs whose fingerprint
--      does not match aborts the whole migration (`canonical_demo_fixture_
--      identity_mismatch`) rather than being silently classified or silently
--      skipped. A fixture UUID not present at all (current Production has
--      zero organizations) is a pure no-op — this never INSERTs a row. The
--      global zero-NULL gate below still runs AFTER this narrow step and
--      still fails closed on any OTHER NULL row, with no backfill path for
--      anything but these two exact identities.
--
--   B/C. `institution_class` becomes immutable once set: a
--      `BEFORE UPDATE OF institution_class` trigger
--      (`_phoenix_organizations_institution_class_immutable_v1`) rejects any
--      non-NULL -> different-non-NULL or non-NULL -> NULL transition, while
--      leaving every ordinary UPDATE (name/city/email/status, or an UPDATE
--      that re-sets the SAME class value) completely unaffected — Postgres
--      only fires an `OF <column>` trigger when that column is present in the
--      UPDATE's SET list at all.
--
--   D. `warehouses.facility_id` (164) has shipped since Migration 164 with
--      NO authorized writer anywhere in 001-169: `phoenix_create_warehouse`,
--      `phoenix_update_warehouse` and `phoenix_set_warehouse_active` (074,
--      immutable, NOT CREATE OR REPLACE'd here) never touch it, and
--      `phoenix_upsert_organization_facility` (164) only writes
--      `organization_facilities` rows themselves. This migration adds the
--      sole authorized writer, `phoenix_assign_warehouse_facility`, PLUS a
--      hard database boundary — `_phoenix_warehouse_facility_assignment_guard_v1`
--      as a `BEFORE UPDATE OF facility_id` trigger on `warehouses` — so the
--      invariant cannot be bypassed by any raw authenticated UPDATE that
--      manages to slip past the RPC. The RPC itself is a thin, auditable
--      front door: it authorizes, locks the row, and issues the UPDATE; ALL
--      substantive validation (facility validity, warehouse-kind rule,
--      same-organization rule, and the 19-table operational-dependency
--      guard) lives ONLY in the trigger, so a raw client UPDATE hits the
--      exact same wall the RPC does — there is no second, weaker corridor.
--      The trigger is also the SOLE writer of the facility-assignment audit
--      row, so a call through the RPC never double-logs.
--
-- Accepted product rule (owner-authorized, this gate):
--   NULL -> facility, facility A -> facility B, and facility -> NULL are all
--   permitted ONLY while the warehouse has ZERO operational dependencies.
--   Once operationally used — by ANY of the 19 dependency classes below,
--   regardless of active/inactive/archived/completed/cancelled/historical
--   status — facility identity becomes immutable through normal operations.
--   This is deliberately NOT limited to active routes: reassigning a
--   warehouse's facility after real stock/movement history exists would
--   retroactively recontextualize that history under a new facility identity
--   even though Migration 168's own movement-time Shape H/I revalidation
--   (Addendum §F, 168:341-421) already guarantees no FUTURE transaction can
--   silently misbehave from a stale route — the guard here protects
--   historical provenance integrity, not transactional safety, which 168
--   already provides.
--
-- No legacy `phoenix_classify_organization`-style transition RPC: there is no
-- longer any pre-launch NULL-class organization left to classify.
--
-- Migrations 001-169, `phoenix_create_warehouse`, `phoenix_update_warehouse`,
-- `phoenix_set_warehouse_active` and `warehouse_kind` semantics are NOT
-- touched. Zero new tables, columns, indexes, permission keys, or RLS policy
-- changes.
--
-- ROLLBACK (manual, if ever required before a later migration depends on this):
--   DROP FUNCTION IF EXISTS public.phoenix_assign_warehouse_facility(uuid, uuid);
--   DROP TRIGGER IF EXISTS warehouses_facility_assignment_guard_trg ON public.warehouses;
--   DROP FUNCTION IF EXISTS public._phoenix_warehouse_facility_assignment_guard_v1();
--   DROP TRIGGER IF EXISTS organizations_institution_class_immutable_trg ON public.organizations;
--   DROP FUNCTION IF EXISTS public._phoenix_organizations_institution_class_immutable_v1();
--   ALTER TABLE public.organizations ALTER COLUMN institution_class DROP NOT NULL;
-- ============================================================================

begin;

-- ── PREFLIGHT: fail closed if the world is not what this migration expects ──
DO $preflight$
DECLARE
  v_null_orgs   integer;
  v_chk_def     text;
  v_fixture     RECORD;
  v_org         RECORD;
BEGIN
  IF to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (170): public.organizations is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'organizations'
      AND column_name = 'institution_class'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (170): organizations.institution_class (164) is absent';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_chk_def
  FROM pg_constraint
  WHERE conname = 'organizations_institution_class_chk';
  IF v_chk_def IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (170): organizations_institution_class_chk (164) is absent';
  END IF;
  -- Exact-equality proof, not mere substring containment: the constraint
  -- must admit ONLY {hospital, specialized_center, health_sector} — nothing
  -- more, nothing less. This is Migration 164's byte-identical definition
  -- (`CHECK (institution_class IN ('hospital','specialized_center',
  -- 'health_sector'))`), compared against Postgres's own normalized
  -- pg_get_constraintdef() rendering of that same expression (a single-column
  -- IN-list is always rendered as `col = ANY (ARRAY[...])`). A LIKE '%x%'
  -- substring check would still pass for a constraint that admits a 4th or
  -- 5th value alongside the three canonical ones; exact string equality does
  -- not.
  IF v_chk_def <> 'CHECK ((institution_class = ANY (ARRAY[''hospital''::text, ''specialized_center''::text, ''health_sector''::text])))' THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (170): organizations_institution_class_chk no longer defines exactly {hospital, specialized_center, health_sector}';
  END IF;

  IF to_regclass('public.warehouses') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (170): public.warehouses is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouses' AND column_name = 'facility_id'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (170): warehouses.facility_id (164) is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'warehouses_facility_org_fk' AND contype = 'f'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (170): warehouses_facility_org_fk (164) is absent';
  END IF;
  IF to_regclass('public.organization_facilities') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (170): public.organization_facilities (164) is absent';
  END IF;
  IF to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (170): public.audit_logs is absent';
  END IF;
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (170): public.profiles is absent';
  END IF;

  -- ── CANONICAL_DEMO_FIXTURE_RECONCILIATION ────────────────────────────────
  -- Reconciles ONLY the two fixed-UUID Migration-004 canonical demo-seed
  -- organizations — both unambiguously named as hospitals in 004 itself
  -- ("Babil General Hospital" / "Al-Hilla Teaching Hospital") — when, and
  -- only when, they are found on this database with a byte-identical
  -- Migration-004 identity fingerprint (name, name_ar, code, status, city;
  -- the full set of stable identity columns 004 explicitly inserts). This is
  -- NOT generic backfill, NOT legacy-organization classification, and NOT
  -- name/code pattern inference: no organization other than these two exact
  -- fixed UUIDs is ever inspected or written by this loop. A row found under
  -- one of these UUIDs whose fingerprint does not match aborts the whole
  -- migration (fail closed) rather than being silently reconciled or
  -- silently skipped — a fixed UUID alone is never sufficient proof of
  -- identity. On a database where Migration 004 never ran (current
  -- Production has zero organizations at the time of writing), both lookups
  -- find nothing and this block is a pure no-op: it only ever UPDATEs a
  -- pre-existing row, it never INSERTs one.
  FOR v_fixture IN
    SELECT * FROM (VALUES
      ('00000000-0000-0000-0000-000000000001'::uuid, 'Babil General Hospital'::text,
       'مستشفى بابل العام'::text, 'babil-main'::text, 'active'::text, 'Babil'::text),
      ('00000000-0000-0000-0000-000000000002'::uuid, 'Al-Hilla Teaching Hospital'::text,
       'مستشفى الحلة التعليمي'::text, 'hilla-teaching'::text, 'active'::text, 'Al-Hilla'::text)
    ) AS f(id, name, name_ar, code, status, city)
  LOOP
    SELECT o.id, o.name, o.name_ar, o.code, o.status, o.city, o.institution_class
      INTO v_org
      FROM public.organizations o
      WHERE o.id = v_fixture.id;

    IF NOT FOUND THEN
      CONTINUE; -- no row under this fixed UUID (e.g. current Production) — nothing to reconcile
    END IF;

    IF v_org.name IS DISTINCT FROM v_fixture.name
       OR v_org.name_ar IS DISTINCT FROM v_fixture.name_ar
       OR v_org.code IS DISTINCT FROM v_fixture.code
       OR v_org.status IS DISTINCT FROM v_fixture.status
       OR v_org.city IS DISTINCT FROM v_fixture.city THEN
      RAISE EXCEPTION 'canonical_demo_fixture_identity_mismatch' USING
        ERRCODE = '23514',
        DETAIL = format(
          'organization %s does not match its Migration-004 canonical fixture identity — refusing to reconcile institution_class',
          v_fixture.id
        );
    END IF;

    IF v_org.institution_class IS NULL THEN
      UPDATE public.organizations SET institution_class = 'hospital' WHERE id = v_fixture.id;
    ELSIF v_org.institution_class <> 'hospital' THEN
      RAISE EXCEPTION 'canonical_demo_fixture_unexpected_class' USING
        ERRCODE = '23514',
        DETAIL = format(
          'organization %s (Migration-004 canonical hospital fixture) already has institution_class=%s, expected hospital or NULL',
          v_fixture.id, v_org.institution_class
        );
    END IF;
    -- ELSE: already 'hospital' — allowed unchanged (idempotent re-apply).
  END LOOP;

  -- The hard NOT NULL precondition: zero NULL institution_class rows remain,
  -- evaluated AFTER the narrow canonical-fixture reconciliation immediately
  -- above. No backfill, no inference from name/name_ar/code/city/warehouse/
  -- point/profile is performed anywhere in this migration for any
  -- organization OTHER than the two exact fixtures above — a single
  -- remaining NULL row (fixtures aside) aborts here.
  SELECT count(*) INTO v_null_orgs FROM public.organizations WHERE institution_class IS NULL;
  IF v_null_orgs <> 0 THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (170): % organization row(s) still have NULL institution_class — SET NOT NULL refused', v_null_orgs;
  END IF;
END;
$preflight$;

-- ============================================================================
-- A. organizations.institution_class — hard NOT NULL requirement
-- ============================================================================
-- Existing 3-value CHECK (organizations_institution_class_chk, 164) is
-- untouched. No Postgres enum type introduced. No 'health_center' value.
ALTER TABLE public.organizations
  ALTER COLUMN institution_class SET NOT NULL;

-- ============================================================================
-- B/C. organizations.institution_class — immutability after first set
-- ============================================================================
-- BEFORE UPDATE OF institution_class only fires when that column is present
-- in the UPDATE's own SET list, so every other organization column (name,
-- name_ar, code, city, contact_email, status, ...) is completely unaffected
-- by this trigger's existence.
CREATE FUNCTION public._phoenix_organizations_institution_class_immutable_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- OLD.institution_class is NOT NULL for every row once this migration's own
  -- ALTER above has applied; the NULL-OLD branch below only matters for the
  -- (now impossible, but harmless) case where this trigger ran before the
  -- ALTER in some hypothetical replay ordering — first classification must
  -- never be blocked.
  IF OLD.institution_class IS NOT NULL
     AND NEW.institution_class IS DISTINCT FROM OLD.institution_class THEN
    RAISE EXCEPTION 'organization_institution_class_immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organizations_institution_class_immutable_trg
  BEFORE UPDATE OF institution_class ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_organizations_institution_class_immutable_v1();

-- ============================================================================
-- D.1 warehouse facility-assignment hard guard trigger (the real boundary)
-- ============================================================================
-- BEFORE UPDATE OF facility_id only fires when facility_id is present in the
-- UPDATE's SET list. Fires identically whether the UPDATE originates from
-- phoenix_assign_warehouse_facility (below) or from ANY raw authenticated
-- client UPDATE — there is no second, weaker corridor. This function is the
-- SOLE writer of the facility-assignment audit row (no double-logging).
CREATE FUNCTION public._phoenix_warehouse_facility_assignment_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_org_class  text;
  v_facility   public.organization_facilities%ROWTYPE;
  v_point_ids  uuid[];
BEGIN
  -- No-op: facility_id present in the SET list but the value is unchanged.
  -- No validation, no audit row.
  IF NEW.facility_id IS NOT DISTINCT FROM OLD.facility_id THEN
    RETURN NEW;
  END IF;

  -- ── Authorization — independently re-verified here, not merely trusted
  --    from the calling RPC, because this trigger is the hard boundary a raw
  --    UPDATE must also pass through. ──────────────────────────────────────
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT p.role INTO v_actor_role
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  IF v_actor_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'forbidden_warehouse_facility_assign' USING ERRCODE = '42501';
  END IF;

  -- ── Concurrency: make the raw-UPDATE path no weaker than the RPC path ───
  -- The RPC (D.2) already serializes against a concurrent INSERT into any of
  -- the 12 directly-FK'd dependency tables, or a concurrent first
  -- distribution_points INSERT (which transitively covers dependency classes
  -- 14-19), because its own `SELECT ... FOR UPDATE` acquires a lock that
  -- conflicts with the `FOR KEY SHARE` lock Postgres's own FK enforcement
  -- takes on this row when such an INSERT references it. A raw client
  -- UPDATE, however, only acquires the weaker `FOR NO KEY UPDATE` lock
  -- Postgres gives automatically to a plain UPDATE that does not touch a
  -- referenced key column — which does NOT conflict with `FOR KEY SHARE` —
  -- so without this explicit escalation, a concurrent dependency-row INSERT
  -- could commit invisibly between this trigger's snapshot and this
  -- transaction's own commit (classic write-skew). Re-acquiring FOR UPDATE
  -- here is always immediately granted when this transaction already holds
  -- a weaker lock on its own row (lock upgrade, never a self-deadlock), and
  -- is a harmless no-op when reached via the RPC (which already holds it).
  -- Whichever side — this UPDATE or a concurrent dependency INSERT —
  -- reaches this row's lock first now forces the other to wait, so the
  -- dependency-guard EXISTS checks below always observe a fully serialized
  -- view: either this facility change commits first and any dependency is
  -- created afterward against the new context, or a concurrent dependency
  -- commits first and this assignment is rejected by the checks below.
  PERFORM 1 FROM public.warehouses WHERE id = NEW.id FOR UPDATE;

  -- ── Non-NULL target: facility/warehouse validity ────────────────────────
  IF NEW.facility_id IS NOT NULL THEN
    IF NEW.warehouse_kind IS DISTINCT FROM 'institution' THEN
      RAISE EXCEPTION 'warehouse_kind_not_institution' USING ERRCODE = '23514';
    END IF;

    SELECT institution_class INTO v_org_class
    FROM public.organizations WHERE id = NEW.organization_id FOR SHARE;
    IF v_org_class IS DISTINCT FROM 'health_sector' THEN
      RAISE EXCEPTION 'warehouse_organization_not_health_sector' USING ERRCODE = '23514';
    END IF;

    SELECT * INTO v_facility
    FROM public.organization_facilities WHERE id = NEW.facility_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'facility_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_facility.organization_id IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'target_facility_organization_mismatch' USING ERRCODE = '23514';
    END IF;
    IF v_facility.facility_class NOT IN ('primary_health_center', 'subordinate_health_center') THEN
      RAISE EXCEPTION 'invalid_facility_class' USING ERRCODE = '23514';
    END IF;
    IF v_facility.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'facility_not_active' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- ── Setup-time-only mutation contract: the 19-table operational-dependency
  --    guard. Applies to EVERY real change (NULL->facility, facility->facility,
  --    facility->NULL) — first assignment is not exempt, because a warehouse
  --    can already carry operational history under "no facility" (sector-level)
  --    identity. Every branch checks ALL rows regardless of status. ─────────
  SELECT array_agg(id) INTO v_point_ids
  FROM public.distribution_points WHERE warehouse_id = NEW.id;

  IF
    -- 1-12: direct warehouse-level dependencies
    EXISTS (SELECT 1 FROM public.warehouse_stock WHERE warehouse_id = NEW.id)
    OR EXISTS (SELECT 1 FROM public.warehouse_stock_movements WHERE warehouse_id = NEW.id)
    OR EXISTS (SELECT 1 FROM public.warehouse_dispatches WHERE warehouse_id = NEW.id)
    OR EXISTS (SELECT 1 FROM public.warehouse_quarantine_stock WHERE warehouse_id = NEW.id)
    OR EXISTS (SELECT 1 FROM public.warehouse_transfers
                 WHERE source_warehouse_id = NEW.id OR destination_warehouse_id = NEW.id)
    OR EXISTS (SELECT 1 FROM public.warehouse_transfer_requests
                 WHERE source_warehouse_id = NEW.id OR destination_warehouse_id = NEW.id)
    OR EXISTS (SELECT 1 FROM public.warehouse_return_shipments
                 WHERE source_warehouse_id = NEW.id OR destination_warehouse_id = NEW.id)
    OR EXISTS (SELECT 1 FROM public.warehouse_return_requests
                 WHERE source_warehouse_id = NEW.id OR destination_warehouse_id = NEW.id)
    OR EXISTS (SELECT 1 FROM public.warehouse_supply_routes
                 WHERE source_warehouse_id = NEW.id OR target_warehouse_id = NEW.id)
    OR EXISTS (SELECT 1 FROM public.outlet_return_requests WHERE destination_warehouse_id = NEW.id)
    OR EXISTS (SELECT 1 FROM public.outlet_return_shipments WHERE destination_warehouse_id = NEW.id)
    OR EXISTS (SELECT 1 FROM public.procurement_orders WHERE warehouse_id = NEW.id)
    -- 13: distribution_points existence itself is already an operational commitment
    OR v_point_ids IS NOT NULL
    -- 14-19: reachable through this warehouse's own distribution_points
    OR EXISTS (SELECT 1 FROM public.outlet_stock WHERE distribution_point_id = ANY(v_point_ids))
    OR EXISTS (SELECT 1 FROM public.outlet_stock_movements WHERE distribution_point_id = ANY(v_point_ids))
    OR EXISTS (SELECT 1 FROM public.outlet_replenishment_routes
                 WHERE source_point_id = ANY(v_point_ids) OR destination_point_id = ANY(v_point_ids))
    OR EXISTS (SELECT 1 FROM public.item_availability WHERE distribution_point_id = ANY(v_point_ids))
    OR EXISTS (SELECT 1 FROM public.item_availability_movements WHERE distribution_point_id = ANY(v_point_ids))
    OR EXISTS (SELECT 1 FROM public.phoenix_movement_dispense_context WHERE distribution_point_id = ANY(v_point_ids))
    OR EXISTS (SELECT 1 FROM public.inter_org_exchange_requests
                 WHERE source_distribution_point_id = ANY(v_point_ids)
                    OR target_distribution_point_id = ANY(v_point_ids))
  THEN
    RAISE EXCEPTION 'warehouse_facility_reassignment_blocked_operational_dependency' USING ERRCODE = '23514';
  END IF;

  -- ── Sole audit writer for the actual state change ───────────────────────
  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    NEW.organization_id, v_actor, v_actor_role,
    'warehouse_facility.assigned', 'warehouse', NEW.id, NEW.name,
    jsonb_build_object(
      'warehouse_id', NEW.id,
      'organization_id', NEW.organization_id,
      'old_facility_id', OLD.facility_id,
      'new_facility_id', NEW.facility_id
    )
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER warehouses_facility_assignment_guard_trg
  BEFORE UPDATE OF facility_id ON public.warehouses
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_warehouse_facility_assignment_guard_v1();

-- ============================================================================
-- D.2 phoenix_assign_warehouse_facility — the supported application API
-- ============================================================================
-- Thin front door: authorizes, locks the warehouse row, issues the UPDATE.
-- ALL substantive validation lives in the trigger above (D.1) so a raw
-- UPDATE hits the identical wall. p_facility_id NULL clears the assignment.
CREATE FUNCTION public.phoenix_assign_warehouse_facility(
  p_warehouse_id uuid,
  p_facility_id  uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_warehouse  public.warehouses%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT p.role INTO v_actor_role
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  IF v_actor_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'forbidden_warehouse_facility_assign' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_warehouse FROM public.warehouses WHERE id = p_warehouse_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Fires warehouses_facility_assignment_guard_trg (D.1), which performs
  -- every remaining check and, on success, writes the single audit row.
  UPDATE public.warehouses SET facility_id = p_facility_id WHERE id = p_warehouse_id;

  RETURN jsonb_build_object(
    'ok', true,
    'warehouse_id', p_warehouse_id,
    'old_facility_id', v_warehouse.facility_id,
    'new_facility_id', p_facility_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_assign_warehouse_facility(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_assign_warehouse_facility(uuid, uuid) TO authenticated;

-- ============================================================================
-- VERIFY (in-transaction) — abort the whole migration on any failure
-- ============================================================================
DO $verify$
DECLARE
  v_col_nullable   text;
  v_chk_def        text;
  v_immutable_src  text;
  v_guard_src      text;
  v_rpc_src        text;
  v_fixture_class  text;
BEGIN
  -- A. NOT NULL applied, CHECK preserved
  SELECT is_nullable INTO v_col_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'institution_class';
  IF v_col_nullable <> 'NO' THEN
    RAISE EXCEPTION 'VERIFY FAILED (170): organizations.institution_class is not NOT NULL';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_chk_def
  FROM pg_constraint WHERE conname = 'organizations_institution_class_chk';
  -- Exact-equality proof — see the identical check in PREFLIGHT for why a
  -- substring LIKE check is insufficient to prove "exactly these 3 values".
  IF v_chk_def <> 'CHECK ((institution_class = ANY (ARRAY[''hospital''::text, ''specialized_center''::text, ''health_sector''::text])))' THEN
    RAISE EXCEPTION 'VERIFY FAILED (170): organizations_institution_class_chk no longer defines exactly {hospital, specialized_center, health_sector}';
  END IF;

  -- CANONICAL_DEMO_FIXTURE_RECONCILIATION self-consistency: IF either fixed
  -- Migration-004 fixture UUID exists on this database (it never does on a
  -- fresh Production, which has zero organizations), its institution_class
  -- must now be exactly 'hospital' — either PREFLIGHT's own reconciliation
  -- just set it, or it was already 'hospital', or PREFLIGHT would have
  -- raised before reaching this point. This is a redundant, defense-in-depth
  -- re-proof, not a new code path.
  FOR v_fixture_class IN
    SELECT institution_class FROM public.organizations
    WHERE id IN ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002')
  LOOP
    IF v_fixture_class IS DISTINCT FROM 'hospital' THEN
      RAISE EXCEPTION 'VERIFY FAILED (170): a canonical Migration-004 demo fixture organization does not have institution_class=hospital after reconciliation';
    END IF;
  END LOOP;

  -- B/C. immutability function + trigger
  IF to_regprocedure('public._phoenix_organizations_institution_class_immutable_v1()') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (170): immutability function missing';
  END IF;
  SELECT pg_get_functiondef(to_regprocedure('public._phoenix_organizations_institution_class_immutable_v1()'))
    INTO v_immutable_src;
  IF v_immutable_src NOT LIKE '%organization_institution_class_immutable%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (170): immutability error token missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'organizations' AND t.tgname = 'organizations_institution_class_immutable_trg'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (170): organizations_institution_class_immutable_trg missing';
  END IF;

  -- D. guard function + trigger + RPC
  IF to_regprocedure('public._phoenix_warehouse_facility_assignment_guard_v1()') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (170): warehouse facility guard function missing';
  END IF;
  SELECT pg_get_functiondef(to_regprocedure('public._phoenix_warehouse_facility_assignment_guard_v1()'))
    INTO v_guard_src;
  IF v_guard_src NOT LIKE '%warehouse_facility_reassignment_blocked_operational_dependency%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (170): dependency-guard error token missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'warehouses' AND t.tgname = 'warehouses_facility_assignment_guard_trg'
      AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (170): warehouses_facility_assignment_guard_trg missing';
  END IF;

  IF to_regprocedure('public.phoenix_assign_warehouse_facility(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (170): phoenix_assign_warehouse_facility missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'phoenix_assign_warehouse_facility'
      AND grantee IN ('PUBLIC', 'anon')
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (170): phoenix_assign_warehouse_facility is executable by PUBLIC/anon';
  END IF;

  -- Predecessor immutability: the three 074 warehouse RPCs are untouched signatures
  IF to_regprocedure('public.phoenix_create_warehouse(uuid, text, text, text, text, boolean)') IS NULL
     OR to_regprocedure('public.phoenix_update_warehouse(uuid, text, text, text)') IS NULL
     OR to_regprocedure('public.phoenix_set_warehouse_active(uuid, boolean, text)') IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (170): a 074 warehouse-management RPC signature changed unexpectedly';
  END IF;
END;
$verify$;

commit;

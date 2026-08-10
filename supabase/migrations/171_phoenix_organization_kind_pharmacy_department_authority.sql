-- ============================================================================
-- ORGANIZATION-KIND-AND-PHARMACY-DEPARTMENT-AUTHORITY-171  (Stage E · E7-1 follow-up)
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply after 170, via the Supabase SQL Editor, after reading this file in
-- full.
--
-- NOT APPLIED BY THIS PR. Authored and replayed on a disposable PostgreSQL rig
-- only. Migrations 001-170 are immutable and are NOT edited here.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE GAP THIS CLOSES
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 170 made organizations.institution_class NOT NULL, correctly
-- closing the legacy NULL-classification gap for every organization this
-- system has ever created — all of which have been, and remain, real
-- care-delivery institutions (hospital | specialized_center | health_sector).
--
-- Owner-confirmed (Stage E7-1 architecture reconciliation, this gate): a
-- Pharmacy Department central supply authority is a genuinely distinct kind
-- of organizational actor, architecturally separate from a care-delivery
-- institution — it owns central-supply warehouses and participates in the
-- Migration-077 direct central->institution corridor, but it does not itself
-- deliver care and must never be forced into hospital/specialized_center/
-- health_sector to satisfy 170's blanket NOT NULL. This migration introduces
-- that distinction as a new, narrow, orthogonal discriminator rather than a
-- fourth institution_class value or a sentinel.
--
--   A. organizations.organization_kind (NEW) — exactly two values:
--        care_institution              (the only kind that has ever existed)
--        pharmacy_department_authority (new)
--      NOT NULL DEFAULT 'care_institution'. The default is intentionally
--      permanent (not migration-time-only): there is no centralized writer
--      for organizations anywhere in this codebase (no RPC, no frontend
--      service — every organization has only ever been created by raw INSERT,
--      scattered across ~90 fixture files and one real demo seed), so
--      dropping the default would break every one of them identically to how
--      170's own NOT NULL requirement broke 13+ predecessor fixtures — the
--      exact cascade this follow-up itself was born from. The CHECK
--      constraints below (organization_kind's own 2-value membership, and
--      the conditional institution_class contract) already fail closed
--      against any INVALID row; the default only decides what an unspecified
--      writer becomes, and every writer that has ever existed meant
--      care_institution.
--
--   B. organizations.institution_class SET NOT NULL (170) is relaxed —
--      forward-only, exactly as 170's own documented manual rollback step
--      anticipated (170:104). It is replaced, not removed: a new conditional
--      CHECK (organizations_kind_institution_class_chk) enforces the
--      equivalent-but-conditional guarantee — every care_institution row
--      still requires a non-NULL, three-value-only institution_class, exactly
--      as before; a pharmacy_department_authority row is now required to
--      have institution_class NULL, always. 164's own institution_class
--      3-value CHECK (organizations_institution_class_chk) is untouched — a
--      SQL CHECK is vacuously satisfied by NULL, so it already permitted this
--      shape without modification.
--
--   C. organizations.organization_kind is immutable once set (a new trigger,
--      modeled byte-for-byte on 170's own institution_class immutability
--      trigger): only an ACTUAL value change is rejected
--      (NEW.organization_kind IS DISTINCT FROM OLD.organization_kind); a
--      same-value UPDATE is a harmless no-op, identical semantics to 170's
--      own pattern.
--
--   D. warehouses — a NEW one-way ownership guard: a warehouse whose owning
--      organization is pharmacy_department_authority MUST have
--      warehouse_kind='central'. The inverse is explicitly NOT imposed: a
--      care_institution may continue to own a central-kind warehouse exactly
--      as it always has (Migration 004's own canonical "Central Pharmacy
--      Warehouse" owned by a real hospital, and the already-corrected fixture
--      file 115, both depend on this remaining true). Enforced at the DB
--      boundary via a new trigger (no existing trigger reaches warehouse_kind
--      or organization_id — 170's own facility-assignment guard only reaches
--      facility_id), covering INSERT, UPDATE OF warehouse_kind, and
--      UPDATE OF organization_id alike.
--
--      The same guard also enforces, on the UPDATE (reassignment) path only,
--      that a warehouse becoming pharmacy_department_authority-owned must
--      have ZERO distribution_points at the moment of reassignment — a fresh
--      INSERT can never have pre-existing distribution_points (they can only
--      ever reference an already-existing warehouse via their own FK), so
--      this check is meaningful only for UPDATE. This closes the indirect
--      path an outlet could otherwise reach a Pharmacy Department authority
--      through warehouse-ownership reassignment rather than direct
--      distribution_point creation.
--
--   E. distribution_points — a NEW guard: a distribution_point may not be
--      created on, or reassigned onto, a warehouse whose owning organization
--      is pharmacy_department_authority. Pharmacy Department warehouses are
--      supply-tier stock nodes, never patient-dispensing institutions.
--      Covers INSERT and UPDATE OF warehouse_id — the exact two paths
--      Migration 168's own fixture already demonstrates are real
--      (`UPDATE distribution_points SET warehouse_id=...` is genuine,
--      exercised code, not hypothetical).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- CONCURRENCY — the D/E guards above must serialize against EACH OTHER
-- ─────────────────────────────────────────────────────────────────────────────
-- Two transactions can each independently observe a "safe" pre-image and
-- both commit into an invalid joint state:
--   TX-A: reassigns warehouse W's organization_id to a pharmacy_department_
--         authority org (checks: does W have zero distribution_points? sees
--         none yet).
--   TX-B: attaches a NEW distribution_point to warehouse W (checks: is W's
--         owning org pharmacy_department_authority? sees no, not yet).
-- Without synchronization both checks can pass concurrently and both commit,
-- landing on the exact invalid state this migration exists to forbid.
--
-- Fixed with the SAME technique 170 already uses and has already proven (its
-- own 8 genuine two-transaction concurrency tests) for the identical class of
-- problem (a raw UPDATE only takes the Postgres-automatic FOR NO KEY UPDATE
-- lock, which does NOT conflict with the FOR KEY SHARE / FOR SHARE a
-- concurrent dependent-row write needs):
--   * The warehouse guard (D), on the UPDATE/reassignment path into
--     pharmacy_department_authority, explicitly re-acquires
--     `SELECT ... FOR UPDATE` on its own row before checking for existing
--     distribution_points — upgrading the lock, exactly 170's own documented
--     technique (170:340-343: "always immediately granted when this
--     transaction already holds a weaker lock on its own row (lock upgrade,
--     never a self-deadlock)").
--   * The distribution_points guard (E) explicitly takes
--     `SELECT ... FOR SHARE OF w` on the target warehouse row before deciding
--     whether to allow the write.
-- FOR UPDATE conflicts with FOR SHARE (and vice versa): whichever side
-- reaches the warehouse row's lock first forces the other to wait, so
-- whichever check runs second always observes the first's already-committed
-- result — one succeeds, one is correctly rejected, and the joint state is
-- always valid at commit. Proven by a genuine two-transaction test in this
-- migration's own dynamic test file, on two independent raw connections,
-- exactly like 170's own concurrency proofs.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS DELIBERATELY NOT TOUCHED
-- ─────────────────────────────────────────────────────────────────────────────
-- No RBAC/RLS change: phoenix_profile_has_scoped_permission (062) scopes by
-- organization_id/warehouse_id/distribution_point_id only, never by
-- institution_class or organization_kind — traced and confirmed, not
-- assumed. No new permission or role is introduced.
--
-- Migration 077's entire direct central->institution corridor
-- (phoenix_assert_direct_supply_endpoints and everything built on it) is
-- untouched and untouchable here — traced across its full ~2827 lines, it
-- never references institution_class and has no organization-kind-aware
-- logic to redefine. It already treats any two organizations as valid
-- source/destination, which is exactly what a pharmacy_department_authority
-- source needs.
--
-- No facility guard is added: Migration 164's own composite FK
-- (of_parent_class_fk, requiring the exact pair (organization_id,
-- institution_class)=(id,'health_sector')) already makes it structurally
-- impossible for a NULL-institution_class row — which every
-- pharmacy_department_authority row now is — to ever be a facility parent,
-- with zero new code. Its RPC-level defensive check
-- (phoenix_upsert_organization_facility's `IF v_org.institution_class IS
-- NULL THEN RAISE 'organization_institution_class_required'`, 164:396-397,
-- and phoenix_upsert_outlet_replenishment_route's identical guard at
-- 164:639-640) was unreachable dead code the moment 170 shipped NOT NULL;
-- this migration makes it live and correct again, unmodified, for a new but
-- equally-legitimate NULL state.
--
-- No provenance change: supply_type/purchase_origin (088) live on
-- warehouse_stock/movement rows, independent of organization_kind or
-- institution_class — confirmed by direct read of 088's ADD COLUMN
-- statements, which never touch organizations.
--
-- Zero new tables. Zero second inventory/stock truth. Zero RPC redefinition.
--
-- ROLLBACK (manual, if ever required before a later migration depends on this):
--   DROP TRIGGER IF EXISTS distribution_points_owner_kind_guard_trg ON public.distribution_points;
--   DROP FUNCTION IF EXISTS public._phoenix_distribution_points_owner_kind_guard_v1();
--   DROP TRIGGER IF EXISTS warehouses_owner_kind_guard_trg ON public.warehouses;
--   DROP FUNCTION IF EXISTS public._phoenix_warehouses_owner_kind_guard_v1();
--   DROP TRIGGER IF EXISTS organizations_kind_immutable_trg ON public.organizations;
--   DROP FUNCTION IF EXISTS public._phoenix_organizations_kind_immutable_v1();
--   ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_kind_institution_class_chk;
--   ALTER TABLE public.organizations ALTER COLUMN institution_class SET NOT NULL;
--   ALTER TABLE public.organizations DROP COLUMN IF EXISTS organization_kind;
-- ============================================================================

begin;

-- ── PREFLIGHT: fail closed if the world is not what this migration expects ──
DO $preflight$
DECLARE
  v_col_nullable text;
  v_chk_def      text;
BEGIN
  IF to_regclass('public.organizations') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (171): public.organizations is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'institution_class'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (171): organizations.institution_class (164) is absent';
  END IF;

  SELECT is_nullable INTO v_col_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'institution_class';
  IF v_col_nullable <> 'NO' THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (171): organizations.institution_class is not currently NOT NULL — expected 170 to have applied';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_chk_def
  FROM pg_constraint WHERE conname = 'organizations_institution_class_chk';
  IF v_chk_def <> 'CHECK ((institution_class = ANY (ARRAY[''hospital''::text, ''specialized_center''::text, ''health_sector''::text])))' THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (171): organizations_institution_class_chk (164) no longer defines exactly {hospital, specialized_center, health_sector}';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'organizations' AND t.tgname = 'organizations_institution_class_immutable_trg' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (171): organizations_institution_class_immutable_trg (170) is absent';
  END IF;

  IF to_regclass('public.warehouses') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (171): public.warehouses is absent';
  END IF;
  IF to_regclass('public.distribution_points') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (171): public.distribution_points is absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouses' AND column_name = 'warehouse_kind'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED (171): warehouses.warehouse_kind is absent';
  END IF;
END;
$preflight$;

-- ============================================================================
-- A. organizations.organization_kind — the new, narrow, orthogonal discriminator
-- ============================================================================
-- DEFAULT is intentionally permanent — see the header comment. Applying a
-- NOT NULL column with a DEFAULT backfills every existing row (currently zero
-- in Production; every fixture/demo row created to date is a real care
-- institution — see the header comment) deterministically to
-- 'care_institution', converting nothing to 'pharmacy_department_authority'
-- without explicit evidence, exactly as required.
ALTER TABLE public.organizations
  ADD COLUMN organization_kind text NOT NULL DEFAULT 'care_institution';

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_organization_kind_chk
  CHECK (organization_kind IN ('care_institution', 'pharmacy_department_authority'));

COMMENT ON COLUMN public.organizations.organization_kind IS
  'STAGE-E-E7-1-171: the top-level organizational-actor discriminator — '
  'care_institution | pharmacy_department_authority. Orthogonal to '
  'institution_class (164), which classifies ONLY care_institution rows. '
  'Immutable once set (see organizations_kind_immutable_trg below).';

-- ============================================================================
-- B. organizations.institution_class — relax 170's blanket NOT NULL, replace
--    with the conditional contract
-- ============================================================================
ALTER TABLE public.organizations
  ALTER COLUMN institution_class DROP NOT NULL;

-- 164's own 3-value membership CHECK (organizations_institution_class_chk) is
-- untouched — it already permits NULL vacuously. This new constraint adds
-- the REQUIREMENT half: exactly non-NULL for care_institution, exactly NULL
-- for pharmacy_department_authority. No sentinel, no fourth value.
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_kind_institution_class_chk
  CHECK (
    (organization_kind = 'care_institution' AND institution_class IS NOT NULL)
    OR
    (organization_kind = 'pharmacy_department_authority' AND institution_class IS NULL)
  );

-- ============================================================================
-- C. organizations.organization_kind — immutability (modeled on 170's own
--    institution_class immutability trigger, byte-for-byte in spirit)
-- ============================================================================
CREATE FUNCTION public._phoenix_organizations_kind_immutable_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Same-value UPDATE (e.g. an UPDATE ... SET organization_kind = organization_kind
  -- as part of a broader row rewrite) is a harmless no-op, exactly as 170's
  -- own institution_class trigger treats a same-value re-set.
  IF NEW.organization_kind IS DISTINCT FROM OLD.organization_kind THEN
    RAISE EXCEPTION 'organization_kind_immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organizations_kind_immutable_trg
  BEFORE UPDATE OF organization_kind ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_organizations_kind_immutable_v1();

-- ============================================================================
-- D. warehouses — one-way ownership guard: pharmacy_department_authority
--    implies warehouse_kind='central'. NO inverse restriction on
--    care_institution (Migration 004's own canonical hospital-owned central
--    warehouse, and fixture 115, both depend on this remaining unrestricted).
--    Also closes the indirect-outlet path: a warehouse gaining a
--    pharmacy_department_authority owner via reassignment must have zero
--    distribution_points at that moment (see the concurrency note above).
-- ============================================================================
CREATE FUNCTION public._phoenix_warehouses_owner_kind_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner_kind text;
BEGIN
  -- No-op: neither organization_id nor warehouse_kind actually changed.
  IF TG_OP = 'UPDATE'
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
     AND NEW.warehouse_kind IS NOT DISTINCT FROM OLD.warehouse_kind THEN
    RETURN NEW;
  END IF;

  SELECT organization_kind INTO v_owner_kind
  FROM public.organizations WHERE id = NEW.organization_id;

  -- An organization_id that doesn't resolve is a pre-existing FK violation
  -- this migration does not need to anticipate — nothing to gate here.
  IF v_owner_kind IS DISTINCT FROM 'pharmacy_department_authority' THEN
    RETURN NEW;
  END IF;

  IF NEW.warehouse_kind <> 'central' THEN
    RAISE EXCEPTION 'pharmacy_department_authority_requires_central_warehouse' USING ERRCODE = '23514';
  END IF;

  -- Existing-outlet check: meaningful only on reassignment (UPDATE) — a fresh
  -- INSERT can never have a pre-existing distribution_point, since a
  -- distribution_point's own FK requires an already-existing warehouse row.
  IF TG_OP = 'UPDATE' THEN
    -- Lock upgrade, exactly 170's own proven technique (170:340-343):
    -- immediately granted (this row is already locked, weaker, by the
    -- UPDATE itself), never a self-deadlock. Whichever side — this
    -- reassignment or a concurrent distribution_point write onto this same
    -- warehouse (which takes FOR SHARE, see the companion guard below) —
    -- reaches this row's lock first forces the other to wait.
    PERFORM 1 FROM public.warehouses WHERE id = NEW.id FOR UPDATE;

    IF EXISTS (SELECT 1 FROM public.distribution_points WHERE warehouse_id = NEW.id) THEN
      RAISE EXCEPTION 'pharmacy_department_authority_warehouse_has_outlets' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER warehouses_owner_kind_guard_trg
  BEFORE INSERT OR UPDATE OF organization_id, warehouse_kind ON public.warehouses
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_warehouses_owner_kind_guard_v1();

-- ============================================================================
-- E. distribution_points — a Pharmacy Department authority's warehouse may
--    never gain an outlet, at creation or by reassignment.
-- ============================================================================
CREATE FUNCTION public._phoenix_distribution_points_owner_kind_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner_org  uuid;
  v_owner_kind text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.warehouse_id IS NOT DISTINCT FROM OLD.warehouse_id THEN
    RETURN NEW;
  END IF;

  -- Two separate steps, deliberately not one JOINed query: FOR SHARE on a
  -- single-table scan of warehouses is the well-tested case for
  -- EvalPlanQual (Postgres's concurrent-update re-check) to correctly
  -- re-fetch the LATEST committed organization_id once unblocked. Reading
  -- organizations afterward, as its own plain (unlocked) statement, then
  -- always sees whichever organization_id step 1 just resolved — never a
  -- value pinned to a snapshot taken before this row's lock was granted.
  -- FOR SHARE here conflicts with the warehouse guard's FOR UPDATE (D
  -- above), giving the same two-sided serialization 170 already proved for
  -- the facility-assignment/dependency race — see the concurrency note in
  -- this file's header.
  SELECT organization_id INTO v_owner_org
  FROM public.warehouses WHERE id = NEW.warehouse_id
  FOR SHARE;

  SELECT organization_kind INTO v_owner_kind
  FROM public.organizations WHERE id = v_owner_org;

  IF v_owner_kind = 'pharmacy_department_authority' THEN
    RAISE EXCEPTION 'pharmacy_department_authority_warehouse_no_outlets' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER distribution_points_owner_kind_guard_trg
  BEFORE INSERT OR UPDATE OF warehouse_id ON public.distribution_points
  FOR EACH ROW
  EXECUTE FUNCTION public._phoenix_distribution_points_owner_kind_guard_v1();

-- ============================================================================
-- VERIFY (in-transaction) — abort the whole migration on any failure
-- ============================================================================
DO $verify$
DECLARE
  v_col_nullable   text;
  v_kind_col_nullable text;
  v_chk_def        text;
  v_bad_rows       integer;
BEGIN
  -- A. organization_kind exists, NOT NULL, 2-value CHECK, default backfilled everything
  SELECT is_nullable INTO v_kind_col_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'organization_kind';
  IF v_kind_col_nullable IS NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (171): organizations.organization_kind is absent';
  END IF;
  IF v_kind_col_nullable <> 'NO' THEN
    RAISE EXCEPTION 'VERIFY FAILED (171): organizations.organization_kind is not NOT NULL';
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_chk_def
  FROM pg_constraint WHERE conname = 'organizations_organization_kind_chk';
  IF v_chk_def IS NULL OR v_chk_def NOT LIKE '%care_institution%' OR v_chk_def NOT LIKE '%pharmacy_department_authority%' THEN
    RAISE EXCEPTION 'VERIFY FAILED (171): organizations_organization_kind_chk missing or incomplete';
  END IF;

  SELECT count(*) INTO v_bad_rows FROM public.organizations WHERE organization_kind IS NULL;
  IF v_bad_rows <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (171): % organization row(s) still have NULL organization_kind after backfill', v_bad_rows;
  END IF;

  -- B. institution_class nullable at column level again, conditional CHECK present and correct
  SELECT is_nullable INTO v_col_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'institution_class';
  IF v_col_nullable <> 'YES' THEN
    RAISE EXCEPTION 'VERIFY FAILED (171): organizations.institution_class is still NOT NULL at the column level';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_kind_institution_class_chk'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (171): organizations_kind_institution_class_chk is absent';
  END IF;

  -- Fail-closed data proof: no care_institution row has NULL class, no
  -- pharmacy_department_authority row has non-NULL class. Redundant with the
  -- CHECK above (defense in depth, matching 170's own VERIFY style).
  SELECT count(*) INTO v_bad_rows FROM public.organizations
  WHERE (organization_kind = 'care_institution' AND institution_class IS NULL)
     OR (organization_kind = 'pharmacy_department_authority' AND institution_class IS NOT NULL);
  IF v_bad_rows <> 0 THEN
    RAISE EXCEPTION 'VERIFY FAILED (171): % organization row(s) violate the kind/institution_class contract', v_bad_rows;
  END IF;

  -- 164's own CHECK must remain byte-identical (still exactly the 3 values)
  SELECT pg_get_constraintdef(oid) INTO v_chk_def
  FROM pg_constraint WHERE conname = 'organizations_institution_class_chk';
  IF v_chk_def <> 'CHECK ((institution_class = ANY (ARRAY[''hospital''::text, ''specialized_center''::text, ''health_sector''::text])))' THEN
    RAISE EXCEPTION 'VERIFY FAILED (171): organizations_institution_class_chk (164) was modified — it must remain untouched';
  END IF;

  -- C. organization_kind immutability trigger present
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'organizations' AND t.tgname = 'organizations_kind_immutable_trg' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (171): organizations_kind_immutable_trg is absent';
  END IF;

  -- D. warehouse ownership guard present
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'warehouses' AND t.tgname = 'warehouses_owner_kind_guard_trg' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (171): warehouses_owner_kind_guard_trg is absent';
  END IF;

  -- E. distribution_points guard present
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'distribution_points' AND t.tgname = 'distribution_points_owner_kind_guard_trg' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (171): distribution_points_owner_kind_guard_trg is absent';
  END IF;

  -- 170's own institution_class immutability trigger must remain untouched
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relname = 'organizations' AND t.tgname = 'organizations_institution_class_immutable_trg' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (171): organizations_institution_class_immutable_trg (170) is missing after 171 applied';
  END IF;
END;
$verify$;

commit;

-- ============================================================================
-- INVENTORY-DERIVED-AVAILABILITY-083-A  (Blocker 3, step 1 of the staged cutover)
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply AFTER 082. Additive + one corrective function replacement. Applies no
-- REVOKE and drops nothing — the parity-gated cutover (which revokes the manual
-- availability writers) is a SEPARATE, later migration, per the adopted owner
-- decision that writers are retired only once parity is proven.
--
-- VERIFICATION STATUS: EXECUTED on a disposable PostgreSQL 18.4 cluster with
-- 001→083 in order via tools/pg-rig. See docs/phoenix/migration-083-*.md.
-- Production is 17.6.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS DOES
-- ─────────────────────────────────────────────────────────────────────────────
-- A. REPAIR a latent defect found by driving the real outlet chain: migration
--    067's projection writer `phoenix_project_outlet_availability` upserts into
--    item_availability with a SEVEN-column ON CONFLICT, but item_availability's
--    live identity index (created in 061) is EIGHT-column — it carries
--    COALESCE(internal_batch_reference,''). A 7-column ON CONFLICT cannot infer
--    an 8-column index, so outlet dispatch receipt raises
--    'no unique or exclusion constraint matching the ON CONFLICT specification'
--    on every call. Latent in production only because the outlet corridor is not
--    yet mounted. This aligns the ON CONFLICT and the projection SUM to the real
--    8-column identity.
--
-- B. ADD the server-authoritative, READ-ONLY availability projection
--    `phoenix_available_stock(distribution_point_id)`. It derives physical
--    availability ONLY from canonical outlet_stock — never from a manually
--    written quantity — aggregating every batch/lot without double counting,
--    excluding expired quantity from the usable figure, and deriving the
--    condition through the SAME audited policy used by 067
--    (phoenix_derive_outlet_availability_condition — migration 052's precedence
--    and 9-month near-expiry window, unchanged; no new business rule invented).
--    RLS-scoped: forbidden and nonexistent are indistinguishable (both empty).
--
-- item_availability is NOT dropped and NOT made read-only here. It remains a
-- compatibility cache; this RPC is the new authority a consumer reads instead of
-- trusting item_availability.quantity. Catalogue visibility (053's removed_at)
-- is deliberately NOT consulted — physical availability is independent of
-- whether a catalogue row is hidden.
-- ============================================================================

BEGIN;

-- ── Apply-time fail-closed preconditions (owner decision 12) ────────────────
DO $precond$
BEGIN
  IF to_regclass('public.outlet_stock') IS NULL
     OR to_regclass('public.warehouse_stock') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: canonical stock tables missing — apply 065/067 first';
  END IF;
  IF to_regprocedure('public.phoenix_derive_outlet_availability_condition(integer, date)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: audited condition policy missing — apply 067 first';
  END IF;
  -- The repair in Part A depends on the 8-column identity index existing exactly
  -- as audited. If a later migration changed item_availability's identity, this
  -- migration must not be applied blindly — recompute the ON CONFLICT first.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public'
       AND indexname='item_availability_dp_sci_conc_form_nat_batch_exp_ibr_uniq'
       AND indexdef LIKE '%internal_batch_reference%'
  ) THEN
    RAISE EXCEPTION 'precondition failed: item_availability 8-column identity index not found as audited — the ON CONFLICT repair in Part A would be wrong; re-audit before applying';
  END IF;
END;
$precond$;

-- ── Part A. Repair the outlet→item_availability projection writer ───────────
-- Identical to 067's function except: the SUM and the ON CONFLICT now match the
-- real 8-column identity (adding COALESCE(internal_batch_reference,'')). Because
-- outlet_stock's own identity is also 8-column, each projected row maps 1:1, so
-- the SUM is exact and cannot double count.
CREATE OR REPLACE FUNCTION public.phoenix_project_outlet_availability(
  p_outlet_stock_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stock     public.outlet_stock%ROWTYPE;
  v_available integer;
  v_condition text;
  v_port_name text;
  v_id        uuid;
BEGIN
  SELECT * INTO v_stock FROM public.outlet_stock WHERE id = p_outlet_stock_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'outlet_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- item_availability_identity_chk requires local_item_id OR port_name. A
  -- projected outlet row has no local_item, so it carries the outlet's name.
  SELECT d.name INTO v_port_name
    FROM public.distribution_points d WHERE d.id = v_stock.distribution_point_id;

  SELECT COALESCE(sum(s.available_quantity), 0)
    INTO v_available
  FROM public.outlet_stock s
  WHERE s.distribution_point_id = v_stock.distribution_point_id
    AND s.scientific_name = v_stock.scientific_name
    AND COALESCE(s.concentration, '')  = COALESCE(v_stock.concentration, '')
    AND COALESCE(s.dosage_form, '')    = COALESCE(v_stock.dosage_form, '')
    AND COALESCE(s.national_code, '')  = COALESCE(v_stock.national_code, '')
    AND COALESCE(s.batch_number, '')   = COALESCE(v_stock.batch_number, '')
    AND COALESCE(s.expiry_date, DATE '0001-01-01')
        = COALESCE(v_stock.expiry_date, DATE '0001-01-01')
    AND COALESCE(s.internal_batch_reference, '')
        = COALESCE(v_stock.internal_batch_reference, '');

  v_condition := public.phoenix_derive_outlet_availability_condition(
    v_available, v_stock.expiry_date
  );

  PERFORM set_config('phoenix.dispatch_write', 'on', true);

  INSERT INTO public.item_availability (
    distribution_point_id, organization_id, port_name,
    scientific_name, trade_name, concentration, dosage_form,
    national_code, batch_number, internal_batch_reference, expiry_date,
    quantity, condition, price, supply_type, source_kind, last_updated_by
  ) VALUES (
    v_stock.distribution_point_id, v_stock.organization_id, v_port_name,
    v_stock.scientific_name, v_stock.trade_name, v_stock.concentration, v_stock.dosage_form,
    v_stock.national_code, v_stock.batch_number, v_stock.internal_batch_reference,
    v_stock.expiry_date,
    v_available, v_condition, v_stock.unit_price, v_stock.supply_type_text,
    'warehouse_dispatch', v_stock.updated_by
  )
  ON CONFLICT (
    distribution_point_id,
    scientific_name,
    COALESCE(concentration, ''),
    COALESCE(dosage_form, ''),
    COALESCE(national_code, ''),
    COALESCE(batch_number, ''),
    COALESCE(expiry_date, DATE '0001-01-01'),
    COALESCE(internal_batch_reference, '')
  )
  WHERE scientific_name IS NOT NULL
  DO UPDATE SET
    quantity        = EXCLUDED.quantity,
    condition       = EXCLUDED.condition,
    source_kind     = 'warehouse_dispatch',
    trade_name      = COALESCE(EXCLUDED.trade_name, item_availability.trade_name),
    price           = COALESCE(EXCLUDED.price, item_availability.price),
    supply_type     = COALESCE(EXCLUDED.supply_type, item_availability.supply_type),
    last_updated_by = EXCLUDED.last_updated_by,
    removed_at      = NULL,
    removed_by      = NULL,
    removal_reason  = NULL
  RETURNING id INTO v_id;

  PERFORM set_config('phoenix.dispatch_write', 'off', true);

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_project_outlet_availability(uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.phoenix_project_outlet_availability(uuid) IS
  'INVENTORY-DERIVED-AVAILABILITY-083-A: repaired 067 projection writer. SUM and '
  'ON CONFLICT now match item_availability''s real 8-column identity (adds '
  'internal_batch_reference), fixing the ON-CONFLICT-inference failure that broke '
  'outlet dispatch receipt. Server-only; no role holds EXECUTE.';

-- ── Part B. Server-authoritative READ-ONLY availability projection ──────────
-- Derived ONLY from canonical outlet_stock. Aggregates every batch/lot for a
-- material identity without double counting; usable_quantity excludes expired.
CREATE OR REPLACE FUNCTION public.phoenix_available_stock(
  p_distribution_point_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
  v_role  text;
  v_dp_org uuid;
  v_items jsonb;
  v_empty jsonb := jsonb_build_object(
    'ok', true, 'scope', 'distribution_point',
    'distribution_point_id', NULL, 'source', 'canonical_projection',
    'items', '[]'::jsonb);
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT p.organization_id, p.role INTO v_org, v_role
    FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RETURN v_empty;  -- same empty shape: no active profile
  END IF;

  IF p_distribution_point_id IS NULL THEN
    RETURN v_empty;
  END IF;

  SELECT d.organization_id INTO v_dp_org
    FROM public.distribution_points d WHERE d.id = p_distribution_point_id;

  -- Forbidden and nonexistent are INDISTINGUISHABLE: both fall through to the
  -- same empty result. The RPC never reveals that a point exists but is off-scope.
  IF NOT FOUND
     OR NOT (v_role = 'super_admin' OR (v_org IS NOT NULL AND v_dp_org = v_org)) THEN
    RETURN v_empty;
  END IF;

  -- Aggregate outlet_stock by BATCH-LEVEL identity (the granularity
  -- item_availability represents). Each row is one canonical lot; summing across
  -- rows sharing an 8-part identity cannot double count because outlet_stock's
  -- own unique index makes that identity singular. usable_quantity zeroes out
  -- anything the audited policy classifies expired or missing.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'scientific_name', t.scientific_name,
           'trade_name',      t.trade_name,
           'concentration',   t.concentration,
           'dosage_form',     t.dosage_form,
           'national_code',   t.national_code,
           'batch_number',    t.batch_number,
           'expiry_date',     t.expiry_date,
           'on_hand_quantity', t.on_hand_quantity,
           'available_quantity', t.available_quantity,
           'usable_quantity', CASE WHEN t.condition IN ('expired','missing') THEN 0
                                   ELSE t.available_quantity END,
           'condition',       t.condition,
           'is_usable',       t.condition NOT IN ('expired','missing')
         ) ORDER BY t.scientific_name, t.expiry_date NULLS LAST), '[]'::jsonb)
    INTO v_items
  FROM (
    SELECT s.scientific_name, s.trade_name, s.concentration, s.dosage_form,
           s.national_code, s.batch_number, s.expiry_date,
           sum(s.on_hand_quantity)   AS on_hand_quantity,
           sum(s.available_quantity) AS available_quantity,
           public.phoenix_derive_outlet_availability_condition(
             sum(s.available_quantity)::integer, s.expiry_date) AS condition
      FROM public.outlet_stock s
     WHERE s.distribution_point_id = p_distribution_point_id
     GROUP BY s.scientific_name, s.trade_name, s.concentration, s.dosage_form,
              s.national_code, s.batch_number, s.expiry_date,
              s.internal_batch_reference
  ) t;

  RETURN jsonb_build_object(
    'ok', true,
    'scope', 'distribution_point',
    'distribution_point_id', p_distribution_point_id,
    'source', 'canonical_projection',
    'items', v_items
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_available_stock(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.phoenix_available_stock(uuid) TO authenticated;

COMMENT ON FUNCTION public.phoenix_available_stock(uuid) IS
  'INVENTORY-DERIVED-AVAILABILITY-083-B: server-authoritative, read-only physical '
  'availability for an outlet, derived ONLY from canonical outlet_stock. '
  'Aggregates every batch/lot without double counting; usable_quantity excludes '
  'expired/missing; condition via the audited 067 policy. RLS-scoped — forbidden '
  'and nonexistent return the same empty result. Independent of catalogue '
  'visibility (053 removed_at). This is the projection consumers must read '
  'instead of trusting item_availability.quantity.';

COMMIT;

-- ============================================================================
-- POST-CONDITIONS — run AFTER apply. Read-only.
-- ============================================================================
-- 1. The projection is least-granted and pinned:
--    SELECT prosecdef, provolatile, proconfig FROM pg_proc
--     WHERE proname='phoenix_available_stock';
--    -- expect prosecdef=t, provolatile='s', {search_path=public, pg_temp}
--
-- 2. authenticated may EXECUTE the read projection; anon may not:
--    SELECT has_function_privilege('authenticated','public.phoenix_available_stock(uuid)','EXECUTE'); -- t
--    SELECT has_function_privilege('anon','public.phoenix_available_stock(uuid)','EXECUTE');          -- f
--
-- 3. The repaired writer holds no client EXECUTE (server-only):
--    SELECT has_function_privilege('authenticated','public.phoenix_project_outlet_availability(uuid)','EXECUTE'); -- f
--
-- ============================================================================
-- ROLLBACK / CONTAINMENT
-- ============================================================================
-- Additive read function + a corrective replacement. To revert Part B:
--   DROP FUNCTION IF EXISTS public.phoenix_available_stock(uuid);
-- Part A's repair should NOT be reverted (reverting reinstates the broken
-- 7-column ON CONFLICT); if needed, re-apply 067's body verbatim.
-- ============================================================================

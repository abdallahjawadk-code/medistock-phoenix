-- ============================================================================
-- REPORT-SNAPSHOTS-AND-EXECUTIVE-OVERVIEW-119   ***PREPARED - DO NOT APPLY TO PRODUCTION***
--
-- MANUAL APPLY ONLY (SQL Editor), after owner review, after 118. Never via
-- `supabase db push`.
--
-- WHY
-- The Decision Intelligence Reports feature needs two things neither
-- StatusCenterScreen nor ReportsScreen provide today:
--   1. An IMMUTABLE, server-numbered, QR-verifiable "official report
--      snapshot" — the same discipline as a warehouse receipt (089/090), but
--      for a report instead of a stock movement.
--   2. A canonical, organization-scoped, read-only aggregate RPC for the
--      Executive Overview report section, so the live screen and any
--      official snapshot of it are computed by the SAME function — never two
--      competing classification engines.
--
-- THE CONTRACT
--   * phoenix_report_snapshots is INSERT-only via a SECURITY DEFINER RPC;
--     no direct authenticated/anon write grant exists, and a BEFORE
--     UPDATE/DELETE trigger forbids mutation outright — an official report,
--     once created, cannot be edited, reclassified, or backdated.
--   * official_number is server-stamped (RP-YYYY-nnnnnn, 090's trigger
--     pattern) from a REVOKEd sequence — never client-supplied.
--   * qr_payload follows movement-trace.ts's namespaced-opaque-uuid
--     convention (phxrpt:1:<type-code>:<uuid>) — no material/balance/party
--     data in the code itself; every reader must re-resolve through RLS.
--   * phoenix_executive_overview aggregates EXISTING canonical sources only:
--     item_availability.condition (083/084's already-computed 6-value
--     classification — no new classification math here) and
--     warehouse_stock/outlet_stock.supply_type + purchase_origin (088's
--     provenance columns) for the kimadia/aid/purchase-central/
--     purchase-supplementary breakdown. Both reads are organization-scoped.
--   * phoenix_create_report_snapshot's payload IS the output of
--     phoenix_executive_overview for that same organization at that same
--     moment — the snapshot freezes exactly what the live screen would have
--     shown, computed once by one function.
--   * reports.view (already seeded 062) is the authority for both reading
--     the live aggregate and creating a snapshot of it: a snapshot is simply
--     an immutable copy of data the actor could already see. No new
--     permission key is introduced.
--   * idempotent on p_request_id with a request fingerprint, exactly like
--     every other write RPC in this codebase (065/087/089/115/116).
--
-- report_type is a CLOSED, single-value vocabulary for now
-- ('executive_overview') — deliberately narrow. Widening it to the other 10
-- report sections is follow-up work; the table/RPC/QR/numbering scaffolding
-- here is built to extend, not to be rebuilt.
--
-- PRECONDITIONS: 001 (item_availability), 060/067 (warehouse_stock/
-- outlet_stock), 062 (phoenix_profile_has_scoped_permission, reports.view),
-- 088 (supply_type/purchase_origin) applied. FORWARD-ONLY.
-- ============================================================================

BEGIN;

DO $precond$
BEGIN
  IF to_regclass('public.item_availability') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 001 item_availability is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'warehouse_stock'
       AND column_name = 'purchase_origin'
  ) THEN
    RAISE EXCEPTION 'precondition failed: 088 warehouse_stock.purchase_origin is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'outlet_stock'
       AND column_name = 'purchase_origin'
  ) THEN
    RAISE EXCEPTION 'precondition failed: 088 outlet_stock.purchase_origin is missing';
  END IF;
  IF to_regprocedure('public.phoenix_profile_has_scoped_permission(uuid,text,uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondition failed: 062/091 phoenix_profile_has_scoped_permission is missing';
  END IF;
  IF to_regclass('public.phoenix_report_snapshots') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: 119 already applied';
  END IF;
END;
$precond$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. phoenix_report_snapshots — the immutable official-report ledger.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.phoenix_report_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  report_type        text NOT NULL CHECK (report_type IN ('executive_overview')),
  official_number    text,
  request_id         uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  filters            jsonb NOT NULL DEFAULT '{}'::jsonb,
  reporting_period   jsonb,
  source_as_of       timestamptz NOT NULL,
  payload            jsonb NOT NULL,
  qr_payload         text NOT NULL,
  created_by         uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_by_role    text NOT NULL,
  created_by_name    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id)
);

CREATE UNIQUE INDEX phoenix_report_snapshots_official_number_uniq
  ON public.phoenix_report_snapshots (official_number) WHERE official_number IS NOT NULL;
CREATE INDEX phoenix_report_snapshots_org_type_idx
  ON public.phoenix_report_snapshots (organization_id, report_type, created_at DESC);

ALTER TABLE public.phoenix_report_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "report_snapshots_select_scoped" ON public.phoenix_report_snapshots
  FOR SELECT TO authenticated
  USING (public.phoenix_profile_has_scoped_permission(auth.uid(), 'reports.view', organization_id));

REVOKE ALL ON TABLE public.phoenix_report_snapshots FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.phoenix_report_snapshots FROM authenticated;
GRANT SELECT ON TABLE public.phoenix_report_snapshots TO authenticated;

-- Defense in depth: even the table owner's own SECURITY DEFINER writer never
-- issues an UPDATE/DELETE, but a stray future edit must still be refused
-- outright rather than silently succeed — an official report, once created,
-- is a permanent record.
CREATE OR REPLACE FUNCTION public.phoenix_forbid_report_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'report_snapshot_is_immutable' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER phoenix_report_snapshots_forbid_mutation
  BEFORE UPDATE OR DELETE ON public.phoenix_report_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_forbid_report_snapshot_mutation();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Server-owned official numbering — 090's trigger-stamp pattern.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE SEQUENCE public.phoenix_report_snapshot_number_seq;
REVOKE ALL ON SEQUENCE public.phoenix_report_snapshot_number_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_stamp_report_snapshot_official_number()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.official_number IS NOT NULL THEN
    RETURN NEW; -- idempotent replay keeps its original number
  END IF;
  NEW.official_number := 'RP-' || to_char(now(), 'YYYY') || '-' ||
    lpad(nextval('public.phoenix_report_snapshot_number_seq')::text, 6, '0');
  RETURN NEW;
END;
$$;
CREATE TRIGGER phoenix_report_snapshots_stamp_official
  BEFORE INSERT ON public.phoenix_report_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_stamp_report_snapshot_official_number();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. phoenix_executive_overview — the canonical live aggregate.
--    Aggregates ONLY: no classification math is performed here. Reads
--    item_availability.condition (083/084) and warehouse_stock/
--    outlet_stock.supply_type + purchase_origin (088) as already computed.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_executive_overview(
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor              uuid := auth.uid();
  v_classification     jsonb;
  v_materials_tracked  integer;
  v_warehouse_totals   jsonb;
  v_outlet_totals      jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id_required' USING ERRCODE = '23514';
  END IF;
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'reports.view', p_organization_id, NULL, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_reports_view' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_object_agg(condition, n), '{}'::jsonb)
    INTO v_classification
  FROM (
    SELECT condition, count(*)::int AS n
      FROM public.item_availability
     WHERE organization_id = p_organization_id
     GROUP BY condition
  ) c;

  SELECT count(DISTINCT local_item_id)::int
    INTO v_materials_tracked
  FROM public.item_availability
  WHERE organization_id = p_organization_id;

  SELECT COALESCE(jsonb_object_agg(bucket, qty), '{}'::jsonb)
    INTO v_warehouse_totals
  FROM (
    SELECT
      CASE
        WHEN supply_type = 'purchase' THEN 'purchase_' || purchase_origin
        WHEN supply_type IS NULL THEN 'unclassified'
        ELSE supply_type
      END AS bucket,
      sum(on_hand_quantity)::bigint AS qty
    FROM public.warehouse_stock
    WHERE organization_id = p_organization_id
    GROUP BY 1
  ) w;

  SELECT COALESCE(jsonb_object_agg(bucket, qty), '{}'::jsonb)
    INTO v_outlet_totals
  FROM (
    SELECT
      CASE
        WHEN supply_type = 'purchase' THEN 'purchase_' || purchase_origin
        WHEN supply_type IS NULL THEN 'unclassified'
        ELSE supply_type
      END AS bucket,
      sum(on_hand_quantity)::bigint AS qty
    FROM public.outlet_stock
    WHERE organization_id = p_organization_id
    GROUP BY 1
  ) o;

  RETURN jsonb_build_object(
    'organization_id', p_organization_id,
    'as_of', now(),
    'materials_tracked', v_materials_tracked,
    'classification_counts', v_classification,
    'supply_source_totals', jsonb_build_object(
      'warehouse', v_warehouse_totals,
      'outlet', v_outlet_totals
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_executive_overview(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_executive_overview(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. phoenix_create_report_snapshot — the ONLY writer.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.phoenix_create_report_snapshot(
  p_request_id       uuid,
  p_organization_id  uuid,
  p_report_type      text,
  p_filters          jsonb DEFAULT '{}'::jsonb,
  p_reporting_period jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_actor_name   text;
  v_filters      jsonb := COALESCE(p_filters, '{}'::jsonb);
  v_payload      jsonb;
  v_fingerprint  text;
  v_existing     public.phoenix_report_snapshots%ROWTYPE;
  v_row          public.phoenix_report_snapshots%ROWTYPE;
  v_qr_code      text;
  v_new_id       uuid := gen_random_uuid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_report_type IS NULL OR p_report_type NOT IN ('executive_overview') THEN
    RAISE EXCEPTION 'invalid_report_type' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'reports.view', p_organization_id, NULL, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_reports_view' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name
    INTO v_actor_role, v_actor_name
  FROM public.profiles p
  WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- The payload IS the live canonical function's output, computed ONCE here —
  -- the snapshot and the live screen can never disagree about how a number
  -- was derived, only about WHEN it was frozen.
  v_payload := public.phoenix_executive_overview(p_organization_id);

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'organization_id', p_organization_id,
    'report_type', p_report_type,
    'filters', v_filters,
    'reporting_period', p_reporting_period
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 119119));

  SELECT * INTO v_existing
  FROM public.phoenix_report_snapshots
  WHERE request_id = p_request_id;

  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'id', v_existing.id, 'official_number', v_existing.official_number,
      'qr_payload', v_existing.qr_payload, 'created_at', v_existing.created_at
    );
  END IF;

  v_qr_code := CASE p_report_type WHEN 'executive_overview' THEN 'xov' ELSE 'rpt' END;

  -- id is minted BEFORE insert (not left to the column default) so the QR
  -- payload can embed the row's real id in the same statement — the
  -- immutability trigger forbids ANY later UPDATE, including from this RPC.
  INSERT INTO public.phoenix_report_snapshots (
    id, organization_id, report_type, request_id, request_fingerprint,
    filters, reporting_period, source_as_of, payload, qr_payload,
    created_by, created_by_role, created_by_name
  ) VALUES (
    v_new_id, p_organization_id, p_report_type, p_request_id, v_fingerprint,
    v_filters, p_reporting_period, now(), v_payload,
    -- namespaced/versioned/opaque, matching movement-trace.ts's phxmv
    -- convention: no material/balance data in the code itself.
    'phxrpt:1:' || v_qr_code || ':' || v_new_id::text,
    v_actor, v_actor_role, v_actor_name
  )
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    p_organization_id, v_actor, v_actor_role,
    'reports.snapshot_created', 'phoenix_report_snapshots', v_row.id,
    v_row.official_number,
    jsonb_build_object('report_type', p_report_type, 'request_id', p_request_id)
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'id', v_row.id, 'official_number', v_row.official_number,
    'qr_payload', v_row.qr_payload, 'created_at', v_row.created_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_create_report_snapshot(
  uuid, uuid, text, jsonb, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_create_report_snapshot(
  uuid, uuid, text, jsonb, jsonb
) TO authenticated;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS (read-only, after apply):
--   phoenix_report_snapshots: RLS enabled; authenticated has SELECT only;
--   UPDATE/DELETE always raises report_snapshot_is_immutable, even as the
--   function owner (the trigger fires unconditionally, before any RPC body
--   could otherwise reach one).
--   A snapshot's official_number matches ^RP-\d{4}-\d{6}$; a replayed
--   request_id returns idempotent_replay:true with the SAME id/number;
--   a changed payload under the same request_id raises request_id_conflict.
--   phoenix_executive_overview and phoenix_create_report_snapshot both raise
--   forbidden_reports_view for a caller lacking reports.view on that org, and
--   are silently org-isolated (a foreign org's data is never visible).
-- RECONCILIATION: two new functions, one new table, one new sequence, two new
-- triggers. No existing table/RPC modified; item_availability and warehouse_
-- stock/outlet_stock are read-only here.
-- ROLLBACK: DROP TABLE public.phoenix_report_snapshots CASCADE;
--   DROP FUNCTION public.phoenix_executive_overview(uuid);
--   DROP FUNCTION public.phoenix_create_report_snapshot(uuid,uuid,text,jsonb,jsonb);
--   DROP FUNCTION public.phoenix_stamp_report_snapshot_official_number();
--   DROP FUNCTION public.phoenix_forbid_report_snapshot_mutation();
--   DROP SEQUENCE public.phoenix_report_snapshot_number_seq;
-- ============================================================================

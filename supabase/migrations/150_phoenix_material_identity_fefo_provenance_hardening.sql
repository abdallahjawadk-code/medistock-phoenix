-- ============================================================================
-- 150 · Canonical Material Identity + Inventory Intelligence Isolation (6B-1)
-- ============================================================================
-- Scope:
--   * versioned, inspectable material identity (no fuzzy/unit equivalence);
--   * unit-aware stock-lot uniqueness with an atomic collision preflight;
--   * material-isolated alerts, suggestions, commitments and Draft validation;
--   * conservative legacy backfill.
--
-- Explicitly out of scope:
--   * FEFO send-writer / raw-RPC grant hardening (6B-2);
--   * outlet-return aggregate-cap hardening (6B-3);
--   * movement/report/RBAC/public-signature changes.
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regprocedure('public.phoenix_create_transfer_draft_from_suggestion(uuid,text)') IS NULL
     OR to_regprocedure('public.phoenix_inventory_suggestion_commitments(uuid)') IS NULL
     OR to_regclass('public.inventory_transfer_suggestions') IS NULL THEN
    RAISE EXCEPTION '150_precondition_failed: migration_149_contract_missing';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'warehouse_stock'
      AND column_name = 'material_identity_key'
  ) THEN
    RAISE EXCEPTION '150_precondition_failed: already_applied';
  END IF;
END;
$preflight$;

-- A canonical component is length-prefixed, so neither separators nor the
-- explicit NULL marker can make two tuples ambiguous. Empty/whitespace is NULL.
CREATE FUNCTION public._phoenix_material_identity_component_v1(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN NULLIF(btrim(p_value), '') IS NULL THEN 'N'
    ELSE 'V' || octet_length(lower(btrim(p_value)))::text || ':' || lower(btrim(p_value))
  END
$$;

CREATE FUNCTION public._phoenix_material_identity_v1(
  p_central_item_id uuid,
  p_scientific_name text,
  p_national_code text,
  p_concentration text,
  p_dosage_form text,
  p_unit text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT 'material:v1'
    || '|central=' || public._phoenix_material_identity_component_v1(p_central_item_id::text)
    || '|scientific=' || public._phoenix_material_identity_component_v1(p_scientific_name)
    || '|national=' || public._phoenix_material_identity_component_v1(p_national_code)
    || '|concentration=' || public._phoenix_material_identity_component_v1(p_concentration)
    || '|form=' || public._phoenix_material_identity_component_v1(p_dosage_form)
    || '|unit=' || public._phoenix_material_identity_component_v1(p_unit)
$$;

REVOKE ALL ON FUNCTION public._phoenix_material_identity_component_v1(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._phoenix_material_identity_v1(uuid,text,text,text,text,text)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._phoenix_material_identity_v1(uuid,text,text,text,text,text) IS
  '150 internal canonical material tuple. Exact normalized snapshots remain in '
  'the identity even when central_item_id is present; NULL national code is an '
  'explicit value, never a wildcard. No fuzzy matching or unit conversion.';

-- Material identity is distinct from lot and provenance identity. Stock rows
-- expose the former as a generated, non-writable value; their unique indexes
-- add location + batch + expiry + supply provenance to form lot identity.
ALTER TABLE public.warehouse_stock
  ADD COLUMN material_identity_version smallint NOT NULL DEFAULT 1
    CHECK (material_identity_version = 1),
  ADD COLUMN material_identity_key text GENERATED ALWAYS AS (
    public._phoenix_material_identity_v1(
      central_item_id, scientific_name, national_code, concentration, dosage_form, unit
    )
  ) STORED;

ALTER TABLE public.outlet_stock
  ADD COLUMN material_identity_version smallint NOT NULL DEFAULT 1
    CHECK (material_identity_version = 1),
  ADD COLUMN material_identity_key text GENERATED ALWAYS AS (
    public._phoenix_material_identity_v1(
      central_item_id, scientific_name, national_code, concentration, dosage_form, unit
    )
  ) STORED;

ALTER TABLE public.warehouse_quarantine_stock
  ADD COLUMN material_identity_version smallint NOT NULL DEFAULT 1
    CHECK (material_identity_version = 1),
  ADD COLUMN material_identity_key text GENERATED ALWAYS AS (
    public._phoenix_material_identity_v1(
      central_item_id, scientific_name, national_code, concentration, dosage_form, unit
    )
  ) STORED;

-- Stable, explicit collision failure. No row is merged, deleted or selected.
DO $collision_preflight$
DECLARE
  v_table text;
  v_collisions bigint;
BEGIN
  SELECT count(*) INTO v_collisions
  FROM (
    SELECT warehouse_id, material_identity_key,
           COALESCE(batch_number, '') AS batch_key,
           COALESCE(expiry_date, DATE '0001-01-01') AS expiry_key,
           COALESCE(internal_batch_reference, '') AS internal_key,
           COALESCE(supply_type, '') AS supply_key,
           COALESCE(purchase_origin, '') AS origin_key
    FROM public.warehouse_stock
    GROUP BY warehouse_id, material_identity_key, COALESCE(batch_number, ''),
             COALESCE(expiry_date, DATE '0001-01-01'),
             COALESCE(internal_batch_reference, ''), COALESCE(supply_type, ''),
             COALESCE(purchase_origin, '')
    HAVING count(*) > 1
  ) q;
  IF v_collisions > 0 THEN
    RAISE EXCEPTION '150_material_identity_collision: warehouse_stock:%', v_collisions;
  END IF;

  SELECT count(*) INTO v_collisions
  FROM (
    SELECT distribution_point_id, material_identity_key,
           COALESCE(batch_number, '') AS batch_key,
           COALESCE(expiry_date, DATE '0001-01-01') AS expiry_key,
           COALESCE(internal_batch_reference, '') AS internal_key,
           COALESCE(supply_type, '') AS supply_key,
           COALESCE(purchase_origin, '') AS origin_key
    FROM public.outlet_stock
    GROUP BY distribution_point_id, material_identity_key, COALESCE(batch_number, ''),
             COALESCE(expiry_date, DATE '0001-01-01'),
             COALESCE(internal_batch_reference, ''), COALESCE(supply_type, ''),
             COALESCE(purchase_origin, '')
    HAVING count(*) > 1
  ) q;
  IF v_collisions > 0 THEN
    RAISE EXCEPTION '150_material_identity_collision: outlet_stock:%', v_collisions;
  END IF;

  SELECT count(*) INTO v_collisions
  FROM (
    SELECT warehouse_id, material_identity_key,
           COALESCE(batch_number, '') AS batch_key,
           COALESCE(expiry_date, DATE '0001-01-01') AS expiry_key,
           COALESCE(internal_batch_reference, '') AS internal_key,
           quarantine_reason, COALESCE(supply_type, '') AS supply_key,
           COALESCE(purchase_origin, '') AS origin_key
    FROM public.warehouse_quarantine_stock
    GROUP BY warehouse_id, material_identity_key, COALESCE(batch_number, ''),
             COALESCE(expiry_date, DATE '0001-01-01'),
             COALESCE(internal_batch_reference, ''), quarantine_reason,
             COALESCE(supply_type, ''), COALESCE(purchase_origin, '')
    HAVING count(*) > 1
  ) q;
  IF v_collisions > 0 THEN
    RAISE EXCEPTION '150_material_identity_collision: warehouse_quarantine_stock:%', v_collisions;
  END IF;
END;
$collision_preflight$;

-- Build and validate the replacement keys before retiring the previous keys.
CREATE UNIQUE INDEX warehouse_stock_identity_v150_uniq
  ON public.warehouse_stock (
    warehouse_id, material_identity_key,
    COALESCE(batch_number, ''), COALESCE(expiry_date, DATE '0001-01-01'),
    COALESCE(internal_batch_reference, ''), COALESCE(supply_type, ''),
    COALESCE(purchase_origin, '')
  );
CREATE UNIQUE INDEX outlet_stock_identity_v150_uniq
  ON public.outlet_stock (
    distribution_point_id, material_identity_key,
    COALESCE(batch_number, ''), COALESCE(expiry_date, DATE '0001-01-01'),
    COALESCE(internal_batch_reference, ''), COALESCE(supply_type, ''),
    COALESCE(purchase_origin, '')
  );
CREATE UNIQUE INDEX wqs_identity_v150_uniq
  ON public.warehouse_quarantine_stock (
    warehouse_id, material_identity_key,
    COALESCE(batch_number, ''), COALESCE(expiry_date, DATE '0001-01-01'),
    COALESCE(internal_batch_reference, ''), quarantine_reason,
    COALESCE(supply_type, ''), COALESCE(purchase_origin, '')
  );

DROP INDEX public.warehouse_stock_identity_uniq;
DROP INDEX public.outlet_stock_identity_uniq;
DROP INDEX public.wqs_identity_uniq;
ALTER INDEX public.warehouse_stock_identity_v150_uniq RENAME TO warehouse_stock_identity_uniq;
ALTER INDEX public.outlet_stock_identity_v150_uniq RENAME TO outlet_stock_identity_uniq;
ALTER INDEX public.wqs_identity_v150_uniq RENAME TO wqs_identity_uniq;

-- Intelligence state is internal and additive. Existing SELECT shapes remain
-- unchanged because callers enumerate columns rather than SELECT *.
ALTER TABLE public.inventory_alerts
  ADD COLUMN central_item_id uuid REFERENCES public.central_items(id) ON DELETE RESTRICT,
  ADD COLUMN concentration text,
  ADD COLUMN dosage_form text,
  ADD COLUMN unit text,
  ADD COLUMN source_stock_id uuid,
  ADD COLUMN internal_batch_reference text,
  ADD COLUMN supply_type text,
  ADD COLUMN purchase_origin text,
  ADD COLUMN material_identity_version smallint,
  ADD COLUMN material_identity_key text,
  ADD COLUMN material_identity_state text NOT NULL DEFAULT 'legacy_unresolved',
  ADD CONSTRAINT inventory_alerts_material_state_chk
    CHECK (
      (material_identity_state = 'resolved'
       AND material_identity_version = 1 AND material_identity_key IS NOT NULL)
      OR
      (material_identity_state = 'legacy_unresolved'
       AND material_identity_version IS NULL AND material_identity_key IS NULL)
    );

ALTER TABLE public.inventory_transfer_suggestions
  ADD COLUMN central_item_id uuid REFERENCES public.central_items(id) ON DELETE RESTRICT,
  ADD COLUMN concentration text,
  ADD COLUMN dosage_form text,
  ADD COLUMN unit text,
  ADD COLUMN material_identity_version smallint,
  ADD COLUMN material_identity_key text,
  ADD COLUMN material_identity_state text NOT NULL DEFAULT 'legacy_unresolved',
  ADD CONSTRAINT inventory_suggestions_material_state_chk
    CHECK (
      (material_identity_state = 'resolved'
       AND material_identity_version = 1 AND material_identity_key IS NOT NULL)
      OR
      (material_identity_state = 'legacy_unresolved'
       AND material_identity_version IS NULL AND material_identity_key IS NULL)
    );

CREATE INDEX inventory_alerts_material_scope_idx
  ON public.inventory_alerts (
    organization_id, scope_kind, scope_id, material_identity_key, status
  );
CREATE INDEX inventory_suggestions_source_material_idx
  ON public.inventory_transfer_suggestions (
    source_organization_id, source_scope_kind, source_scope_id,
    material_identity_key, status
  );
CREATE INDEX inventory_suggestions_target_material_idx
  ON public.inventory_transfer_suggestions (
    target_organization_id, target_scope_kind, target_scope_id,
    material_identity_key, status
  );

-- Alerts are mapped only when the live scope has exactly one material identity
-- compatible with the historical name/code. Ambiguity remains unresolved.
WITH candidates AS (
  SELECT a.id,
         min(x.central_item_id::text)::uuid AS central_item_id,
         min(x.concentration) AS concentration,
         min(x.dosage_form) AS dosage_form,
         min(x.unit) AS unit,
         min(x.material_identity_key) AS material_identity_key
  FROM public.inventory_alerts a
  JOIN (
    SELECT organization_id, 'warehouse'::text AS scope_kind, warehouse_id AS scope_id,
           central_item_id, scientific_name, national_code, concentration, dosage_form,
           unit, material_identity_key
    FROM public.warehouse_stock
    UNION ALL
    SELECT organization_id, 'outlet', distribution_point_id, central_item_id,
           scientific_name, national_code, concentration, dosage_form, unit,
           material_identity_key
    FROM public.outlet_stock
  ) x
    ON x.organization_id = a.organization_id
   AND x.scope_kind = a.scope_kind AND x.scope_id = a.scope_id
   AND lower(btrim(x.scientific_name)) = lower(btrim(a.scientific_name))
   AND x.national_code IS NOT DISTINCT FROM a.national_code
  GROUP BY a.id
  HAVING count(DISTINCT x.material_identity_key) = 1
)
UPDATE public.inventory_alerts a
SET central_item_id = c.central_item_id,
    concentration = c.concentration,
    dosage_form = c.dosage_form,
    unit = c.unit,
    material_identity_version = 1,
    material_identity_key = c.material_identity_key,
    material_identity_state = 'resolved'
FROM candidates c
WHERE a.id = c.id;

-- A suggestion's exact source stock is authoritative for deterministic
-- backfill. Missing polymorphic source rows remain conservatively unresolved.
UPDATE public.inventory_transfer_suggestions s
SET central_item_id = x.central_item_id,
    scientific_name = x.scientific_name,
    national_code = x.national_code,
    concentration = x.concentration,
    dosage_form = x.dosage_form,
    unit = x.unit,
    material_identity_version = 1,
    material_identity_key = x.material_identity_key,
    material_identity_state = 'resolved'
FROM (
  SELECT id, organization_id, 'warehouse'::text AS scope_kind, warehouse_id AS scope_id,
         central_item_id, scientific_name, national_code, concentration, dosage_form,
         unit, material_identity_key
  FROM public.warehouse_stock
  UNION ALL
  SELECT id, organization_id, 'outlet', distribution_point_id, central_item_id,
         scientific_name, national_code, concentration, dosage_form, unit,
         material_identity_key
  FROM public.outlet_stock
) x
WHERE x.id = s.source_stock_id
  AND x.organization_id = s.source_organization_id
  AND x.scope_kind = s.source_scope_kind
  AND x.scope_id = s.source_scope_id;

COMMENT ON COLUMN public.inventory_alerts.material_identity_state IS
  'resolved=v1 tuple proven from one live material; legacy_unresolved=historical '
  'shape lacked enough fields or matched multiple variants. Never guessed.';
COMMENT ON COLUMN public.inventory_transfer_suggestions.material_identity_state IS
  'resolved=v1 tuple proven from exact source stock; legacy_unresolved remains '
  'conservatively committed and cannot generate or create a new Draft.';

-- ============================================================================
-- Material-isolated alert recompute. Threshold rows retain their original
-- CRUD/schema and precedence. A wildcard is policy applied independently to
-- each live material variant, never an aggregation identity.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_recompute_inventory_alerts(
  p_organization_id uuid,
  p_scope_kind text DEFAULT NULL,
  p_scope_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_upserted integer := 0;
  v_cleared integer := 0;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_scope_kind IS NOT NULL AND p_scope_kind NOT IN ('warehouse','outlet') THEN
    RAISE EXCEPTION 'invalid_scope_kind';
  END IF;
  IF p_scope_id IS NOT NULL THEN
    IF p_scope_kind IS NULL THEN RAISE EXCEPTION 'scope_id_requires_scope_kind'; END IF;
    IF public.phoenix_inventory_scope_org(p_scope_kind,p_scope_id)
       IS DISTINCT FROM p_organization_id THEN
      RAISE EXCEPTION 'scope_not_in_organization';
    END IF;
    IF NOT (
      public.phoenix_my_role() = 'super_admin'
      OR (p_scope_kind='warehouse' AND public.phoenix_profile_has_scoped_permission(
            v_actor,'inventory.recompute',p_organization_id,p_scope_id,NULL))
      OR (p_scope_kind='outlet' AND public.phoenix_profile_has_scoped_permission(
            v_actor,'inventory.recompute',p_organization_id,NULL,p_scope_id))
    ) THEN RAISE EXCEPTION 'not_authorized_inventory_recompute'; END IF;
  ELSIF NOT (
    public.phoenix_my_role() = 'super_admin'
    OR public.phoenix_profile_has_scoped_permission(
         v_actor,'inventory.recompute',p_organization_id,NULL,NULL)
  ) THEN
    RAISE EXCEPTION 'not_authorized_inventory_recompute';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('inv_recompute:' || p_organization_id::text,0)
  );

  CREATE TEMP TABLE _stock150 ON COMMIT DROP AS
    SELECT 'warehouse'::text AS scope_kind, ws.warehouse_id AS scope_id,
           ws.id AS stock_id, ws.central_item_id, ws.scientific_name,
           ws.national_code, ws.concentration, ws.dosage_form, ws.unit,
           ws.material_identity_key, ws.batch_number, ws.internal_batch_reference,
           ws.expiry_date, ws.supply_type, ws.purchase_origin,
           ws.on_hand_quantity, ws.available_quantity
    FROM public.warehouse_stock ws
    WHERE ws.organization_id=p_organization_id
      AND (p_scope_kind IS NULL OR p_scope_kind='warehouse')
      AND (p_scope_id IS NULL OR ws.warehouse_id=p_scope_id)
    UNION ALL
    SELECT 'outlet', os.distribution_point_id, os.id, os.central_item_id,
           os.scientific_name, os.national_code, os.concentration,
           os.dosage_form, os.unit, os.material_identity_key, os.batch_number,
           os.internal_batch_reference, os.expiry_date, os.supply_type,
           os.purchase_origin, os.on_hand_quantity, os.available_quantity
    FROM public.outlet_stock os
    WHERE os.organization_id=p_organization_id
      AND (p_scope_kind IS NULL OR p_scope_kind='outlet')
      AND (p_scope_id IS NULL OR os.distribution_point_id=p_scope_id);

  CREATE TEMP TABLE _agg150 ON COMMIT DROP AS
    SELECT scope_kind,scope_id,material_identity_key,
           max(central_item_id::text)::uuid AS central_item_id,
           max(scientific_name) AS scientific_name,
           max(national_code) AS national_code,
           max(concentration) AS concentration,
           max(dosage_form) AS dosage_form,
           max(unit) AS unit,
           sum(on_hand_quantity)::integer AS on_hand,
           sum(available_quantity)::integer AS available
    FROM _stock150
    GROUP BY scope_kind,scope_id,material_identity_key;

  CREATE TEMP TABLE _thr150 ON COMMIT DROP AS
    SELECT t.*
    FROM public.inventory_signal_thresholds t
    WHERE t.organization_id=p_organization_id AND t.is_active
      AND (p_scope_kind IS NULL OR t.scope_kind=p_scope_kind)
      AND (p_scope_id IS NULL OR t.scope_id IS NULL OR t.scope_id=p_scope_id);

  CREATE TEMP TABLE _now150 (
    alert_key text PRIMARY KEY,
    scope_kind text, scope_id uuid, signal_type text, severity text, expiry_tier text,
    scientific_name text, national_code text, batch_number text, expiry_date date,
    observed_on_hand integer, observed_available integer,
    threshold_reorder_point integer, threshold_target_max integer,
    near_expiry_days integer, days_to_expiry integer,
    central_item_id uuid, concentration text, dosage_form text, unit text,
    source_stock_id uuid, internal_batch_reference text, supply_type text,
    purchase_origin text, material_identity_version smallint,
    material_identity_key text, material_identity_state text
  ) ON COMMIT DROP;

  -- One position per canonical material. Threshold selection is:
  -- scope+coded > scope+wildcard > org+coded > org+wildcard.
  INSERT INTO _now150
  SELECT
    p_organization_id::text || '|' || a.scope_kind || '|' || a.scope_id::text
      || '|' || sig.signal_type || '|' || a.material_identity_key || '||',
    a.scope_kind,a.scope_id,sig.signal_type,sig.severity,NULL,
    a.scientific_name,a.national_code,NULL,NULL,a.on_hand,a.available,
    cfg.reorder_point,cfg.target_max,NULL,NULL,
    a.central_item_id,a.concentration,a.dosage_form,a.unit,
    NULL,NULL,NULL,NULL,1,a.material_identity_key,'resolved'
  FROM _agg150 a
  CROSS JOIN LATERAL (
    SELECT t.reorder_point,t.target_max,t.scope_id
    FROM _thr150 t
    WHERE t.scope_kind=a.scope_kind
      AND (t.scope_id=a.scope_id OR t.scope_id IS NULL)
      AND lower(btrim(t.scientific_name))=lower(btrim(a.scientific_name))
      AND (t.national_code IS NULL OR t.national_code=a.national_code)
    ORDER BY (t.scope_id IS NOT NULL) DESC,(t.national_code IS NOT NULL) DESC,t.id
    LIMIT 1
  ) cfg
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN cfg.scope_id IS NOT NULL AND cfg.reorder_point>0 AND a.on_hand=0 THEN 'missing'
      WHEN cfg.reorder_point IS NOT NULL AND a.on_hand>0
           AND a.available<=cfg.reorder_point THEN 'low_stock'
      WHEN cfg.target_max IS NOT NULL AND a.available>cfg.target_max THEN 'surplus'
      ELSE NULL END AS signal_type,
      CASE
        WHEN cfg.scope_id IS NOT NULL AND cfg.reorder_point>0 AND a.on_hand=0 THEN 'high'
        WHEN cfg.reorder_point IS NOT NULL AND a.on_hand>0
             AND a.available<=cfg.reorder_point THEN 'medium'
        ELSE 'low' END AS severity
  ) sig
  WHERE sig.signal_type IS NOT NULL;

  -- A scope-specific expectation with no live variant cannot safely invent
  -- concentration/form/unit. Preserve it as unresolved and never suggest it.
  INSERT INTO _now150
  SELECT
    p_organization_id::text || '|' || t.scope_kind || '|' || t.scope_id::text
      || '|missing|legacy:v1|' || lower(btrim(t.scientific_name)) || '|'
      || COALESCE(t.national_code,'<wildcard>') || '||',
    t.scope_kind,t.scope_id,'missing','high',NULL,t.scientific_name,
    t.national_code,NULL,NULL,0,0,t.reorder_point,t.target_max,NULL,NULL,
    NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'legacy_unresolved'
  FROM _thr150 t
  WHERE t.scope_id IS NOT NULL AND COALESCE(t.reorder_point,0)>0
    AND NOT EXISTS (
      SELECT 1 FROM _agg150 a
      WHERE a.scope_kind=t.scope_kind AND a.scope_id=t.scope_id
        AND lower(btrim(a.scientific_name))=lower(btrim(t.scientific_name))
        AND (t.national_code IS NULL OR t.national_code=a.national_code)
    )
  ON CONFLICT (alert_key) DO NOTHING;

  -- Date fingerprints include the canonical material and exact stock row; two
  -- lots can never disappear through ON CONFLICT merely because display fields
  -- happen to match.
  INSERT INTO _now150
  SELECT
    p_organization_id::text || '|' || s.scope_kind || '|' || s.scope_id::text
      || '|' || sig.signal_type || '|' || s.material_identity_key
      || '|stock:' || s.stock_id::text,
    s.scope_kind,s.scope_id,sig.signal_type,sig.severity,sig.tier,
    s.scientific_name,s.national_code,s.batch_number,s.expiry_date,
    s.on_hand_quantity,s.available_quantity,NULL,NULL,win.eff_days,
    s.expiry_date-current_date,s.central_item_id,s.concentration,s.dosage_form,
    s.unit,s.stock_id,s.internal_batch_reference,s.supply_type,s.purchase_origin,
    1,s.material_identity_key,'resolved'
  FROM _stock150 s
  CROSS JOIN LATERAL (
    SELECT COALESCE((
      SELECT t.near_expiry_days FROM _thr150 t
      WHERE t.scope_kind=s.scope_kind
        AND (t.scope_id=s.scope_id OR t.scope_id IS NULL)
        AND lower(btrim(t.scientific_name))=lower(btrim(s.scientific_name))
        AND (t.national_code IS NULL OR t.national_code=s.national_code)
      ORDER BY (t.scope_id IS NOT NULL) DESC,(t.national_code IS NOT NULL) DESC,t.id
      LIMIT 1
    ),270) AS eff_days
  ) win
  CROSS JOIN LATERAL (
    SELECT CASE WHEN s.expiry_date<current_date THEN 'expired' ELSE 'near_expiry' END,
           CASE
             WHEN s.expiry_date<current_date THEN 'expired'
             WHEN s.expiry_date<=(current_date+interval '3 months')::date THEN 'critical_3m'
             WHEN s.expiry_date<=(current_date+interval '6 months')::date THEN 'warning_6m'
             ELSE 'watch_9m' END,
           CASE
             WHEN s.expiry_date<current_date
               OR s.expiry_date<=(current_date+interval '3 months')::date THEN 'high'
             WHEN s.expiry_date<=(current_date+interval '6 months')::date THEN 'medium'
             ELSE 'low' END
  ) sig(signal_type,tier,severity)
  WHERE s.on_hand_quantity>0 AND s.expiry_date IS NOT NULL
    AND (s.expiry_date<current_date
         OR s.expiry_date<=(current_date+win.eff_days));

  INSERT INTO public.inventory_alerts AS al (
    organization_id,scope_kind,scope_id,signal_type,severity,expiry_tier,
    scientific_name,national_code,batch_number,expiry_date,observed_on_hand,
    observed_available,threshold_reorder_point,threshold_target_max,
    near_expiry_days,days_to_expiry,alert_key,status,first_observed_at,
    last_observed_at,central_item_id,concentration,dosage_form,unit,
    source_stock_id,internal_batch_reference,supply_type,purchase_origin,
    material_identity_version,material_identity_key,material_identity_state
  )
  SELECT p_organization_id,n.scope_kind,n.scope_id,n.signal_type,n.severity,
    n.expiry_tier,n.scientific_name,n.national_code,n.batch_number,n.expiry_date,
    n.observed_on_hand,n.observed_available,n.threshold_reorder_point,
    n.threshold_target_max,n.near_expiry_days,n.days_to_expiry,n.alert_key,
    'open',now(),now(),n.central_item_id,n.concentration,n.dosage_form,n.unit,
    n.source_stock_id,n.internal_batch_reference,n.supply_type,n.purchase_origin,
    n.material_identity_version,n.material_identity_key,n.material_identity_state
  FROM _now150 n
  WHERE (p_scope_kind IS NULL OR n.scope_kind=p_scope_kind)
    AND (p_scope_id IS NULL OR n.scope_id=p_scope_id)
  ON CONFLICT (alert_key) DO UPDATE SET
    severity=EXCLUDED.severity,expiry_tier=EXCLUDED.expiry_tier,
    observed_on_hand=EXCLUDED.observed_on_hand,
    observed_available=EXCLUDED.observed_available,
    threshold_reorder_point=EXCLUDED.threshold_reorder_point,
    threshold_target_max=EXCLUDED.threshold_target_max,
    near_expiry_days=EXCLUDED.near_expiry_days,
    days_to_expiry=EXCLUDED.days_to_expiry,last_observed_at=now(),updated_at=now(),
    occurrence_count=al.occurrence_count+(CASE WHEN al.cleared_at IS NOT NULL THEN 1 ELSE 0 END),
    status=CASE WHEN al.cleared_at IS NOT NULL THEN 'open' ELSE al.status END,
    auto_resolved=CASE WHEN al.cleared_at IS NOT NULL THEN false ELSE al.auto_resolved END,
    reason=CASE WHEN al.cleared_at IS NOT NULL THEN NULL ELSE al.reason END,
    resolved_at=CASE WHEN al.cleared_at IS NOT NULL THEN NULL ELSE al.resolved_at END,
    resolved_by=CASE WHEN al.cleared_at IS NOT NULL THEN NULL ELSE al.resolved_by END,
    dismissed_at=CASE WHEN al.cleared_at IS NOT NULL THEN NULL ELSE al.dismissed_at END,
    dismissed_by=CASE WHEN al.cleared_at IS NOT NULL THEN NULL ELSE al.dismissed_by END,
    first_observed_at=CASE WHEN al.cleared_at IS NOT NULL THEN now() ELSE al.first_observed_at END,
    cleared_at=NULL,central_item_id=EXCLUDED.central_item_id,
    concentration=EXCLUDED.concentration,dosage_form=EXCLUDED.dosage_form,
    unit=EXCLUDED.unit,source_stock_id=EXCLUDED.source_stock_id,
    internal_batch_reference=EXCLUDED.internal_batch_reference,
    supply_type=EXCLUDED.supply_type,purchase_origin=EXCLUDED.purchase_origin,
    material_identity_version=EXCLUDED.material_identity_version,
    material_identity_key=EXCLUDED.material_identity_key,
    material_identity_state=EXCLUDED.material_identity_state;
  GET DIAGNOSTICS v_upserted=ROW_COUNT;

  UPDATE public.inventory_alerts a
  SET status=CASE WHEN a.status IN ('open','acknowledged','in_progress')
                  THEN 'resolved' ELSE a.status END,
      auto_resolved=CASE WHEN a.status IN ('open','acknowledged','in_progress')
                         THEN true ELSE a.auto_resolved END,
      reason=CASE WHEN a.status IN ('open','acknowledged','in_progress')
                  THEN 'auto: condition no longer present at recompute' ELSE a.reason END,
      resolved_at=CASE WHEN a.status IN ('open','acknowledged','in_progress')
                       THEN now() ELSE a.resolved_at END,
      cleared_at=now(),updated_at=now()
  WHERE a.organization_id=p_organization_id
    AND (p_scope_kind IS NULL OR a.scope_kind=p_scope_kind)
    AND (p_scope_id IS NULL OR a.scope_id=p_scope_id)
    AND a.cleared_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM _now150 n WHERE n.alert_key=a.alert_key);
  GET DIAGNOSTICS v_cleared=ROW_COUNT;

  RETURN jsonb_build_object(
    'organization_id',p_organization_id,'scope_kind',p_scope_kind,
    'scope_id',p_scope_id,'violations',(SELECT count(*) FROM _now150),
    'upserted',v_upserted,'cleared',v_cleared
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_recompute_inventory_alerts(uuid,text,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_recompute_inventory_alerts(uuid,text,uuid)
  TO authenticated;

-- ============================================================================
-- Exact live-position bridge. The five-argument legacy helper keeps its private
-- signature; a transaction-local identity context lets the 149 Draft delegate
-- use this exact implementation without changing its public signature.
-- ============================================================================
CREATE FUNCTION public._phoenix_live_suggestion_scope_position_v1(
  p_organization_id uuid,
  p_scope_kind text,
  p_scope_id uuid,
  p_scientific_name text,
  p_national_code text,
  p_material_identity_key text
)
RETURNS TABLE (live_available integer, reorder_point integer, target_max integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sum integer := 0;
  v_reorder integer;
  v_target integer;
  r record;
BEGIN
  IF p_scope_kind NOT IN ('warehouse','outlet') THEN RAISE EXCEPTION 'invalid_scope_kind'; END IF;
  IF p_material_identity_key IS NULL THEN RAISE EXCEPTION 'material_identity_required'; END IF;
  IF public.phoenix_inventory_scope_org(p_scope_kind,p_scope_id)
     IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'scope_not_in_organization';
  END IF;

  IF p_scope_kind='warehouse' THEN
    FOR r IN
      SELECT ws.available_quantity
      FROM public.warehouse_stock ws
      WHERE ws.organization_id=p_organization_id AND ws.warehouse_id=p_scope_id
        AND ws.material_identity_key=p_material_identity_key
      ORDER BY ws.id FOR UPDATE
    LOOP
      v_sum:=v_sum+COALESCE(r.available_quantity,0);
    END LOOP;
  ELSE
    FOR r IN
      SELECT os.available_quantity
      FROM public.outlet_stock os
      WHERE os.organization_id=p_organization_id
        AND os.distribution_point_id=p_scope_id
        AND os.material_identity_key=p_material_identity_key
      ORDER BY os.id FOR UPDATE
    LOOP
      v_sum:=v_sum+COALESCE(r.available_quantity,0);
    END LOOP;
  END IF;

  SELECT t.reorder_point,t.target_max
    INTO v_reorder,v_target
  FROM public.inventory_signal_thresholds t
  WHERE t.organization_id=p_organization_id AND t.scope_kind=p_scope_kind
    AND (t.scope_id=p_scope_id OR t.scope_id IS NULL) AND t.is_active
    AND lower(btrim(t.scientific_name))=lower(btrim(p_scientific_name))
    AND (t.national_code IS NULL OR t.national_code=p_national_code)
  ORDER BY (t.scope_id IS NOT NULL) DESC,(t.national_code IS NOT NULL) DESC,t.id
  FOR UPDATE
  LIMIT 1;

  RETURN QUERY SELECT v_sum,v_reorder,v_target;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_live_suggestion_scope_position_v1(
  uuid,text,uuid,text,text,text
) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._phoenix_live_suggestion_scope_position(
  p_organization_id uuid,
  p_scope_kind text,
  p_scope_id uuid,
  p_scientific_name text,
  p_national_code text
)
RETURNS TABLE (live_available integer, reorder_point integer, target_max integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text := NULLIF(current_setting('phoenix.material_identity_v1',true),'');
  v_count integer;
BEGIN
  IF v_key IS NULL THEN
    IF p_scope_kind='warehouse' THEN
      SELECT count(DISTINCT ws.material_identity_key),min(ws.material_identity_key)
        INTO v_count,v_key
      FROM public.warehouse_stock ws
      WHERE ws.organization_id=p_organization_id AND ws.warehouse_id=p_scope_id
        AND lower(btrim(ws.scientific_name))=lower(btrim(p_scientific_name))
        AND ws.national_code IS NOT DISTINCT FROM p_national_code;
    ELSIF p_scope_kind='outlet' THEN
      SELECT count(DISTINCT os.material_identity_key),min(os.material_identity_key)
        INTO v_count,v_key
      FROM public.outlet_stock os
      WHERE os.organization_id=p_organization_id
        AND os.distribution_point_id=p_scope_id
        AND lower(btrim(os.scientific_name))=lower(btrim(p_scientific_name))
        AND os.national_code IS NOT DISTINCT FROM p_national_code;
    ELSE
      RAISE EXCEPTION 'invalid_scope_kind';
    END IF;
    IF v_count<>1 THEN RAISE EXCEPTION 'material_identity_ambiguous'; END IF;
  END IF;

  RETURN QUERY
  SELECT * FROM public._phoenix_live_suggestion_scope_position_v1(
    p_organization_id,p_scope_kind,p_scope_id,p_scientific_name,p_national_code,v_key
  );
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_live_suggestion_scope_position(
  uuid,text,uuid,text,text
) FROM PUBLIC, anon, authenticated;

-- The existing 149 commitment derivation is preserved byte-for-byte as a
-- private delegate. During an exact Draft revalidation, unrelated variants are
-- filtered from the delegate's historical name/code SUMs.
ALTER FUNCTION public.phoenix_inventory_suggestion_commitments(uuid)
  RENAME TO _phoenix_150_delegate_inventory_suggestion_commitments;
REVOKE ALL ON FUNCTION public._phoenix_150_delegate_inventory_suggestion_commitments(uuid)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.phoenix_inventory_suggestion_commitments(p_suggestion_id uuid)
RETURNS TABLE (
  source_commitment integer,
  target_commitment integer,
  batch_commitment integer,
  provenance_commitment integer,
  commitment_state text,
  truth_source text,
  is_active boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_context text := NULLIF(current_setting('phoenix.material_identity_v1',true),'');
  v_key text;
BEGIN
  IF v_context IS NOT NULL THEN
    SELECT s.material_identity_key INTO v_key
    FROM public.inventory_transfer_suggestions s WHERE s.id=p_suggestion_id;
    IF v_key IS DISTINCT FROM v_context THEN
      RETURN QUERY SELECT 0,0,0,0,'identity_filtered'::text,
                          'material_identity_context'::text,false;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY
  SELECT * FROM public._phoenix_150_delegate_inventory_suggestion_commitments(
    p_suggestion_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_inventory_suggestion_commitments(uuid)
  FROM PUBLIC, anon, authenticated;

-- Exact source-stock validation is executed before the 149 conservation guard
-- (trigger names sort alphabetically). It acquires only canonical advisory
-- resources; the existing guard continues to own suggestion/provenance/stock
-- row locks in the established order.
CREATE FUNCTION public._phoenix_inventory_suggestion_identity_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_key text;
  v_central uuid;
  v_name text;
  v_code text;
  v_concentration text;
  v_form text;
  v_unit text;
BEGIN
  IF NEW.material_identity_state<>'resolved'
     OR NEW.material_identity_version<>1 OR NEW.material_identity_key IS NULL THEN
    IF NEW.status IN ('open','accepted') THEN
      RAISE EXCEPTION 'guard_150_material_identity_unresolved';
    END IF;
    RETURN NEW;
  END IF;

  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    'inv_material:' || NEW.material_identity_key
  ]);

  IF NEW.source_scope_kind='warehouse' THEN
    SELECT ws.material_identity_key,ws.central_item_id,ws.scientific_name,
           ws.national_code,ws.concentration,ws.dosage_form,ws.unit
      INTO v_key,v_central,v_name,v_code,v_concentration,v_form,v_unit
    FROM public.warehouse_stock ws
    WHERE ws.id=NEW.source_stock_id
      AND ws.organization_id=NEW.source_organization_id
      AND ws.warehouse_id=NEW.source_scope_id;
  ELSE
    SELECT os.material_identity_key,os.central_item_id,os.scientific_name,
           os.national_code,os.concentration,os.dosage_form,os.unit
      INTO v_key,v_central,v_name,v_code,v_concentration,v_form,v_unit
    FROM public.outlet_stock os
    WHERE os.id=NEW.source_stock_id
      AND os.organization_id=NEW.source_organization_id
      AND os.distribution_point_id=NEW.source_scope_id;
  END IF;

  IF v_key IS NULL OR v_key IS DISTINCT FROM NEW.material_identity_key THEN
    RAISE EXCEPTION 'guard_150_source_material_identity_mismatch';
  END IF;
  IF NEW.central_item_id IS DISTINCT FROM v_central
     OR lower(btrim(NEW.scientific_name)) IS DISTINCT FROM lower(btrim(v_name))
     OR NEW.national_code IS DISTINCT FROM v_code
     OR lower(btrim(COALESCE(NEW.concentration,'')))
        IS DISTINCT FROM lower(btrim(COALESCE(v_concentration,'')))
     OR lower(btrim(COALESCE(NEW.dosage_form,'')))
        IS DISTINCT FROM lower(btrim(COALESCE(v_form,'')))
     OR lower(btrim(COALESCE(NEW.unit,'')))
        IS DISTINCT FROM lower(btrim(COALESCE(v_unit,''))) THEN
    RAISE EXCEPTION 'guard_150_source_material_snapshot_mismatch';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_inventory_suggestion_identity_guard_v1()
  FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS a150_inventory_suggestion_identity_guard
  ON public.inventory_transfer_suggestions;
CREATE TRIGGER a150_inventory_suggestion_identity_guard
  BEFORE INSERT OR UPDATE ON public.inventory_transfer_suggestions
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_inventory_suggestion_identity_guard_v1();

-- ============================================================================
-- Intra-organization allocation. Need, headroom, source batches and all
-- commitment SUMs are joined by the exact v1 material tuple.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.phoenix_suggest_inventory_transfers(
  p_organization_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_is_super boolean;
  v_need record;
  v_src record;
  v_batch record;
  v_take integer;
  v_need_remaining integer;
  v_src_remaining integer;
  v_upserted integer := 0;
  v_rows integer;
  v_key text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  v_is_super:=(public.phoenix_my_role()='super_admin');
  PERFORM pg_advisory_xact_lock(
    hashtextextended('inv_suggest:' || p_organization_id::text,0)
  );

  CREATE TEMP TABLE _scopes150 (
    scope_kind text,scope_id uuid,PRIMARY KEY(scope_kind,scope_id)
  ) ON COMMIT DROP;
  INSERT INTO _scopes150
  SELECT 'warehouse',w.id FROM public.warehouses w
  WHERE w.organization_id=p_organization_id
    AND (v_is_super OR public.phoenix_profile_has_scoped_permission(
      v_actor,'inventory.suggest_transfers',p_organization_id,w.id,NULL))
  UNION ALL
  SELECT 'outlet',dp.id FROM public.distribution_points dp
  WHERE dp.organization_id=p_organization_id
    AND (v_is_super OR public.phoenix_profile_has_scoped_permission(
      v_actor,'inventory.suggest_transfers',p_organization_id,NULL,dp.id));
  IF NOT EXISTS(SELECT 1 FROM _scopes150) THEN
    RAISE EXCEPTION 'not_authorized_inventory_suggest';
  END IF;

  UPDATE public.inventory_transfer_suggestions s
  SET status='expired',updated_at=now()
  WHERE s.source_organization_id=p_organization_id
    AND s.target_organization_id=p_organization_id AND s.status='open'
    AND EXISTS(SELECT 1 FROM _scopes150 sc
      WHERE sc.scope_kind=s.source_scope_kind AND sc.scope_id=s.source_scope_id)
    AND EXISTS(SELECT 1 FROM _scopes150 sc
      WHERE sc.scope_kind=s.target_scope_kind AND sc.scope_id=s.target_scope_id)
    AND NOT EXISTS(
      SELECT 1 FROM public.phoenix_inventory_suggestion_commitments(s.id) c
      WHERE c.commitment_state='open_fresh'
    );

  CREATE TEMP TABLE _need150 ON COMMIT DROP AS
  SELECT a.id AS alert_id,a.scope_kind,a.scope_id,a.scientific_name,
         a.national_code,a.central_item_id,a.concentration,a.dosage_form,a.unit,
         a.material_identity_key,
         greatest(coalesce(a.threshold_reorder_point,0)
                    -coalesce(a.observed_available,0),1) AS deficit,
         greatest(coalesce(a.threshold_reorder_point,0)
                    -coalesce(a.observed_available,0),1)
           -coalesce((
             SELECT sum(c.target_commitment)
             FROM public.inventory_transfer_suggestions s
             CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
             WHERE s.target_scope_kind=a.scope_kind AND s.target_scope_id=a.scope_id
               AND s.target_organization_id=a.organization_id
               AND s.material_identity_state='resolved'
               AND s.material_identity_key=a.material_identity_key AND c.is_active
           ),0) AS remaining,
         CASE a.severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END AS prio
  FROM public.inventory_alerts a
  WHERE a.organization_id=p_organization_id
    AND a.material_identity_state='resolved'
    AND a.status IN ('open','acknowledged','in_progress')
    AND a.signal_type IN ('missing','low_stock')
    AND EXISTS(SELECT 1 FROM _scopes150 sc
      WHERE sc.scope_kind=a.scope_kind AND sc.scope_id=a.scope_id);

  CREATE TEMP TABLE _src150 ON COMMIT DROP AS
  SELECT a.id AS alert_id,a.scope_kind,a.scope_id,a.scientific_name,
         a.national_code,a.central_item_id,a.concentration,a.dosage_form,a.unit,
         a.material_identity_key,
         greatest(coalesce(a.observed_available,0)
                    -coalesce(a.threshold_target_max,0),0) AS headroom,
         greatest(coalesce(a.observed_available,0)
                    -coalesce(a.threshold_target_max,0),0)
           -coalesce((
             SELECT sum(c.source_commitment)
             FROM public.inventory_transfer_suggestions s
             CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
             WHERE s.source_scope_kind=a.scope_kind AND s.source_scope_id=a.scope_id
               AND s.source_organization_id=a.organization_id
               AND s.material_identity_state='resolved'
               AND s.material_identity_key=a.material_identity_key AND c.is_active
           ),0) AS remaining
  FROM public.inventory_alerts a
  WHERE a.organization_id=p_organization_id
    AND a.material_identity_state='resolved'
    AND a.status IN ('open','acknowledged','in_progress')
    AND a.signal_type='surplus'
    AND EXISTS(SELECT 1 FROM _scopes150 sc
      WHERE sc.scope_kind=a.scope_kind AND sc.scope_id=a.scope_id);

  CREATE TEMP TABLE _batch150 ON COMMIT DROP AS
  SELECT b.*,b.transferable_quantity-coalesce((
    SELECT sum(CASE WHEN b.dispatch_line_id IS NULL
                    THEN c.batch_commitment ELSE c.provenance_commitment END)
    FROM public.inventory_transfer_suggestions s
    CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
    WHERE s.source_stock_id=b.stock_id
      AND s.provenance_dispatch_line_id IS NOT DISTINCT FROM b.dispatch_line_id
      AND c.is_active
  ),0) AS remaining
  FROM (
    SELECT 'warehouse'::text AS scope_kind,ws.warehouse_id AS scope_id,
           ws.material_identity_key,ws.id AS stock_id,ws.batch_number,
           ws.expiry_date,ws.available_quantity,
           ws.available_quantity AS transferable_quantity,
           NULL::uuid AS dispatch_line_id,NULL::uuid AS inbound_movement_id
    FROM public.warehouse_stock ws
    WHERE ws.organization_id=p_organization_id AND ws.available_quantity>0
      AND (ws.expiry_date IS NULL OR ws.expiry_date>=current_date)
      AND EXISTS(SELECT 1 FROM _scopes150 sc
        WHERE sc.scope_kind='warehouse' AND sc.scope_id=ws.warehouse_id)
    UNION ALL
    SELECT 'outlet',os.distribution_point_id,os.material_identity_key,os.id,
           os.batch_number,os.expiry_date,os.available_quantity,
           least(os.available_quantity,
                 coalesce(wdl.received_quantity,0)-wdl.returned_quantity),
           wdl.id,osm.id
    FROM public.outlet_stock os
    JOIN public.warehouse_dispatch_lines wdl
      ON wdl.resulting_outlet_stock_id=os.id
     AND wdl.organization_id=os.organization_id
     AND wdl.status IN ('accepted','accepted_with_difference')
    JOIN public.outlet_stock_movements osm
      ON osm.dispatch_line_id=wdl.id AND osm.movement_type='dispatch_receive'
     AND osm.outlet_stock_id=os.id AND osm.organization_id=os.organization_id
    WHERE os.organization_id=p_organization_id AND os.available_quantity>0
      AND (os.expiry_date IS NULL OR os.expiry_date>=current_date)
      AND (coalesce(wdl.received_quantity,0)-wdl.returned_quantity)>0
      AND EXISTS(SELECT 1 FROM _scopes150 sc
        WHERE sc.scope_kind='outlet' AND sc.scope_id=os.distribution_point_id)
  ) b;

  CREATE TEMP TABLE _stock_cap150 ON COMMIT DROP AS
  SELECT b.stock_id,max(b.available_quantity)-coalesce((
    SELECT sum(c.batch_commitment)
    FROM public.inventory_transfer_suggestions s
    CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id) c
    WHERE s.source_stock_id=b.stock_id AND c.is_active
  ),0) AS remaining
  FROM _batch150 b GROUP BY b.stock_id;

  FOR v_need IN
    SELECT * FROM _need150 WHERE remaining>0
    ORDER BY prio DESC,material_identity_key,scope_id,alert_id
  LOOP
    v_need_remaining:=v_need.remaining;
    FOR v_src IN
      SELECT s.*,CASE
        WHEN s.scope_kind='warehouse' AND v_need.scope_kind='outlet'
          AND EXISTS(SELECT 1 FROM public.distribution_points dp
            WHERE dp.id=v_need.scope_id AND dp.warehouse_id=s.scope_id
              AND dp.organization_id=p_organization_id)
          THEN 'warehouse_to_outlet'
        WHEN s.scope_kind='outlet' AND v_need.scope_kind='warehouse'
          AND EXISTS(SELECT 1 FROM public.distribution_points dp
            WHERE dp.id=s.scope_id AND dp.warehouse_id=v_need.scope_id
              AND dp.organization_id=p_organization_id)
          THEN 'outlet_to_warehouse'
        WHEN s.scope_kind='warehouse' AND v_need.scope_kind='warehouse'
          AND EXISTS(SELECT 1 FROM public.warehouses sw
            WHERE sw.id=s.scope_id AND sw.warehouse_kind='central'
              AND sw.status='active')
          AND EXISTS(SELECT 1 FROM public.warehouses tw
            WHERE tw.id=v_need.scope_id AND tw.warehouse_kind='institution'
              AND tw.status='active')
          THEN 'central_to_institution'
        ELSE NULL END AS route_kind
      FROM _src150 s
      WHERE s.remaining>0
        AND s.material_identity_key=v_need.material_identity_key
        AND NOT(s.scope_kind=v_need.scope_kind AND s.scope_id=v_need.scope_id)
      ORDER BY s.remaining DESC,s.scope_id,s.alert_id
    LOOP
      EXIT WHEN v_need_remaining<=0;
      CONTINUE WHEN v_src.route_kind IS NULL;
      SELECT remaining INTO v_src_remaining FROM _src150
      WHERE alert_id=v_src.alert_id;
      CONTINUE WHEN v_src_remaining<=0;

      FOR v_batch IN
        SELECT b.*,sc.remaining AS stock_remaining
        FROM _batch150 b JOIN _stock_cap150 sc ON sc.stock_id=b.stock_id
        WHERE b.scope_kind=v_src.scope_kind AND b.scope_id=v_src.scope_id
          AND b.material_identity_key=v_src.material_identity_key
          AND b.remaining>0 AND sc.remaining>0
        ORDER BY b.expiry_date ASC NULLS LAST,b.stock_id,
                 coalesce(b.dispatch_line_id,
                   '00000000-0000-0000-0000-000000000000'::uuid)
      LOOP
        EXIT WHEN v_need_remaining<=0 OR v_src_remaining<=0;
        CONTINUE WHEN v_src.route_kind='outlet_to_warehouse'
                      AND v_batch.dispatch_line_id IS NULL;
        v_take:=least(v_need_remaining,v_src_remaining,
                      v_batch.remaining,v_batch.stock_remaining);
        CONTINUE WHEN v_take<=0;

        v_key:=p_organization_id::text || '|' || v_src.scope_kind || '|'
          || v_src.scope_id::text || '|' || v_need.scope_kind || '|'
          || v_need.scope_id::text || '|' || v_need.material_identity_key
          || '|' || v_batch.stock_id::text || '|'
          || coalesce(v_batch.dispatch_line_id::text,'');

        INSERT INTO public.inventory_transfer_suggestions AS su (
          source_organization_id,target_organization_id,scientific_name,national_code,
          central_item_id,concentration,dosage_form,unit,
          material_identity_version,material_identity_key,material_identity_state,
          source_scope_kind,source_scope_id,target_scope_kind,target_scope_id,route_kind,
          source_stock_id,suggested_quantity,fefo_batch_number,fefo_expiry_date,
          source_batch_available_snapshot,source_surplus_snapshot,
          target_shortfall_snapshot,provenance_dispatch_line_id,
          provenance_inbound_movement_id,rationale,suggestion_key,status,
          first_suggested_at,last_suggested_at,last_validated_at
        ) VALUES (
          p_organization_id,p_organization_id,v_need.scientific_name,
          v_need.national_code,v_need.central_item_id,v_need.concentration,
          v_need.dosage_form,v_need.unit,1,v_need.material_identity_key,'resolved',
          v_src.scope_kind,v_src.scope_id,v_need.scope_kind,v_need.scope_id,
          v_src.route_kind,v_batch.stock_id,v_take,v_batch.batch_number,
          v_batch.expiry_date,v_batch.available_quantity,v_src.headroom,
          v_need.deficit,
          CASE WHEN v_src.route_kind='outlet_to_warehouse'
               THEN v_batch.dispatch_line_id END,
          CASE WHEN v_src.route_kind='outlet_to_warehouse'
               THEN v_batch.inbound_movement_id END,
          'deterministic allocation: exact material identity and one FEFO batch',
          v_key,'open',now(),now(),now()
        )
        ON CONFLICT(suggestion_key) WHERE status='open' DO UPDATE SET
          suggested_quantity=EXCLUDED.suggested_quantity,
          route_kind=EXCLUDED.route_kind,
          fefo_batch_number=EXCLUDED.fefo_batch_number,
          fefo_expiry_date=EXCLUDED.fefo_expiry_date,
          source_batch_available_snapshot=EXCLUDED.source_batch_available_snapshot,
          source_surplus_snapshot=EXCLUDED.source_surplus_snapshot,
          target_shortfall_snapshot=EXCLUDED.target_shortfall_snapshot,
          provenance_inbound_movement_id=EXCLUDED.provenance_inbound_movement_id,
          last_suggested_at=now(),last_validated_at=now(),updated_at=now();
        GET DIAGNOSTICS v_rows=ROW_COUNT;
        CONTINUE WHEN v_rows=0;

        v_upserted:=v_upserted+1;
        v_need_remaining:=v_need_remaining-v_take;
        v_src_remaining:=v_src_remaining-v_take;
        UPDATE _src150 SET remaining=remaining-v_take WHERE alert_id=v_src.alert_id;
        UPDATE _batch150 SET remaining=remaining-v_take
        WHERE stock_id=v_batch.stock_id
          AND dispatch_line_id IS NOT DISTINCT FROM v_batch.dispatch_line_id
          AND scope_kind=v_batch.scope_kind AND scope_id=v_batch.scope_id;
        UPDATE _stock_cap150 SET remaining=remaining-v_take
        WHERE stock_id=v_batch.stock_id;
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'organization_id',p_organization_id,'suggestions',v_upserted,'superseded',0
  );
END;
$$;

-- Cross-organization public parameters cannot name concentration/form/unit.
-- Therefore the call proceeds only when the active source/target alerts prove
-- exactly one common canonical identity; ambiguity is a stable fail-closed
-- error rather than a guessed material.
CREATE OR REPLACE FUNCTION public.phoenix_suggest_cross_org_inventory_transfer(
  p_source_organization_id uuid,
  p_source_warehouse_id uuid,
  p_target_organization_id uuid,
  p_target_warehouse_id uuid,
  p_scientific_name text,
  p_national_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid:=auth.uid();
  v_name text:=NULLIF(btrim(p_scientific_name),'');
  v_code text:=NULLIF(btrim(p_national_code),'');
  v_lock_a text;
  v_lock_b text;
  v_identity_count integer;
  v_material_key text;
  v_source record;
  v_target record;
  v_batch record;
  v_surplus integer;
  v_shortfall integer;
  v_batch_remaining integer;
  v_take integer;
  v_minted integer:=0;
  v_rows integer;
  v_key text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF public.phoenix_my_role()<>'super_admin' THEN
    RAISE EXCEPTION 'cross_org_suggestion_requires_super_admin';
  END IF;
  IF v_name IS NULL THEN RAISE EXCEPTION 'scientific_name_required'; END IF;
  IF p_source_organization_id=p_target_organization_id THEN
    RAISE EXCEPTION 'use_intra_org_suggest_for_same_org';
  END IF;

  v_lock_a:=least(p_source_organization_id::text,p_target_organization_id::text);
  v_lock_b:=greatest(p_source_organization_id::text,p_target_organization_id::text);
  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    'inv_suggest:' || v_lock_a,'inv_suggest:' || v_lock_b
  ]);

  IF NOT EXISTS(
    SELECT 1 FROM public.warehouses sw
    JOIN public.warehouses tw ON tw.id=p_target_warehouse_id
    WHERE sw.id=p_source_warehouse_id AND sw.warehouse_kind='central'
      AND sw.status='active' AND sw.organization_id=p_source_organization_id
      AND tw.warehouse_kind='institution' AND tw.status='active'
      AND tw.organization_id=p_target_organization_id
  ) THEN RAISE EXCEPTION 'no_active_central_institution_pairing'; END IF;

  SELECT count(DISTINCT sa.material_identity_key),min(sa.material_identity_key)
    INTO v_identity_count,v_material_key
  FROM public.inventory_alerts sa
  WHERE sa.organization_id=p_source_organization_id
    AND sa.scope_kind='warehouse' AND sa.scope_id=p_source_warehouse_id
    AND sa.signal_type='surplus'
    AND sa.status IN ('open','acknowledged','in_progress')
    AND sa.material_identity_state='resolved'
    AND lower(btrim(sa.scientific_name))=lower(v_name)
    AND sa.national_code IS NOT DISTINCT FROM v_code
    AND EXISTS(
      SELECT 1 FROM public.inventory_alerts ta
      WHERE ta.organization_id=p_target_organization_id
        AND ta.scope_kind='warehouse' AND ta.scope_id=p_target_warehouse_id
        AND ta.signal_type IN ('missing','low_stock')
        AND ta.status IN ('open','acknowledged','in_progress')
        AND ta.material_identity_state='resolved'
        AND ta.material_identity_key=sa.material_identity_key
    );
  IF v_identity_count<>1 THEN RAISE EXCEPTION 'material_identity_ambiguous'; END IF;

  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    'inv_material:' || v_material_key
  ]);

  SELECT * INTO v_source FROM public.inventory_alerts a
  WHERE a.organization_id=p_source_organization_id
    AND a.scope_kind='warehouse' AND a.scope_id=p_source_warehouse_id
    AND a.signal_type='surplus' AND a.status IN ('open','acknowledged','in_progress')
    AND a.material_identity_state='resolved'
    AND a.material_identity_key=v_material_key
  ORDER BY a.last_observed_at DESC,a.id LIMIT 1;
  SELECT * INTO v_target FROM public.inventory_alerts a
  WHERE a.organization_id=p_target_organization_id
    AND a.scope_kind='warehouse' AND a.scope_id=p_target_warehouse_id
    AND a.signal_type IN ('missing','low_stock')
    AND a.status IN ('open','acknowledged','in_progress')
    AND a.material_identity_state='resolved'
    AND a.material_identity_key=v_material_key
  ORDER BY a.last_observed_at DESC,a.id LIMIT 1;

  v_surplus:=greatest(coalesce(v_source.observed_available,0)
                      -coalesce(v_source.threshold_target_max,0),0);
  v_shortfall:=greatest(coalesce(v_target.threshold_reorder_point,0)
                        -coalesce(v_target.observed_available,0),1);
  IF v_surplus<=0 THEN RAISE EXCEPTION 'no_source_surplus'; END IF;
  IF v_shortfall<=0 THEN RAISE EXCEPTION 'no_target_shortfall'; END IF;

  v_surplus:=v_surplus-coalesce((
    SELECT sum(c.source_commitment)
    FROM public.inventory_transfer_suggestions s
    CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id)c
    WHERE s.source_organization_id=p_source_organization_id
      AND s.source_scope_kind='warehouse' AND s.source_scope_id=p_source_warehouse_id
      AND s.material_identity_state='resolved'
      AND s.material_identity_key=v_material_key AND c.is_active
  ),0);
  v_shortfall:=v_shortfall-coalesce((
    SELECT sum(c.target_commitment)
    FROM public.inventory_transfer_suggestions s
    CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id)c
    WHERE s.target_organization_id=p_target_organization_id
      AND s.target_scope_kind='warehouse' AND s.target_scope_id=p_target_warehouse_id
      AND s.material_identity_state='resolved'
      AND s.material_identity_key=v_material_key AND c.is_active
  ),0);
  IF v_surplus<=0 THEN RAISE EXCEPTION 'source_surplus_already_committed'; END IF;
  IF v_shortfall<=0 THEN RAISE EXCEPTION 'target_shortfall_already_covered'; END IF;

  UPDATE public.inventory_transfer_suggestions s
  SET status='expired',updated_at=now()
  WHERE s.route_kind='central_to_institution'
    AND s.source_organization_id=p_source_organization_id
    AND s.target_organization_id=p_target_organization_id
    AND s.source_scope_id=p_source_warehouse_id
    AND s.target_scope_id=p_target_warehouse_id
    AND s.material_identity_key=v_material_key AND s.status='open'
    AND NOT EXISTS(
      SELECT 1 FROM public.phoenix_inventory_suggestion_commitments(s.id)c
      WHERE c.commitment_state='open_fresh'
    );

  FOR v_batch IN
    SELECT ws.* FROM public.warehouse_stock ws
    WHERE ws.organization_id=p_source_organization_id
      AND ws.warehouse_id=p_source_warehouse_id
      AND ws.material_identity_key=v_material_key AND ws.available_quantity>0
      AND (ws.expiry_date IS NULL OR ws.expiry_date>=current_date)
    ORDER BY ws.expiry_date ASC NULLS LAST,ws.id
  LOOP
    EXIT WHEN v_surplus<=0 OR v_shortfall<=0;
    v_batch_remaining:=v_batch.available_quantity-coalesce((
      SELECT sum(c.batch_commitment)
      FROM public.inventory_transfer_suggestions s
      CROSS JOIN LATERAL public.phoenix_inventory_suggestion_commitments(s.id)c
      WHERE s.source_stock_id=v_batch.id AND c.is_active
    ),0);
    CONTINUE WHEN v_batch_remaining<=0;
    v_take:=least(v_surplus,v_shortfall,v_batch_remaining);
    CONTINUE WHEN v_take<=0;

    v_key:='xorg|' || p_source_warehouse_id::text || '|'
      || p_target_warehouse_id::text || '|' || v_material_key || '|'
      || v_batch.id::text;
    INSERT INTO public.inventory_transfer_suggestions AS su (
      source_organization_id,target_organization_id,scientific_name,national_code,
      central_item_id,concentration,dosage_form,unit,
      material_identity_version,material_identity_key,material_identity_state,
      source_scope_kind,source_scope_id,target_scope_kind,target_scope_id,route_kind,
      source_stock_id,suggested_quantity,fefo_batch_number,fefo_expiry_date,
      source_batch_available_snapshot,source_surplus_snapshot,
      target_shortfall_snapshot,rationale,suggestion_key,status,
      first_suggested_at,last_suggested_at,last_validated_at
    ) VALUES (
      p_source_organization_id,p_target_organization_id,v_batch.scientific_name,
      v_batch.national_code,v_batch.central_item_id,v_batch.concentration,
      v_batch.dosage_form,v_batch.unit,1,v_material_key,'resolved',
      'warehouse',p_source_warehouse_id,'warehouse',p_target_warehouse_id,
      'central_to_institution',v_batch.id,v_take,v_batch.batch_number,
      v_batch.expiry_date,v_batch.available_quantity,
      greatest(coalesce(v_source.observed_available,0)
               -coalesce(v_source.threshold_target_max,0),0),
      greatest(coalesce(v_target.threshold_reorder_point,0)
               -coalesce(v_target.observed_available,0),1),
      'cross-org recommendation: exact canonical material and one FEFO batch',
      v_key,'open',now(),now(),now()
    )
    ON CONFLICT(suggestion_key) WHERE status='open' DO UPDATE SET
      suggested_quantity=EXCLUDED.suggested_quantity,
      fefo_batch_number=EXCLUDED.fefo_batch_number,
      fefo_expiry_date=EXCLUDED.fefo_expiry_date,
      source_batch_available_snapshot=EXCLUDED.source_batch_available_snapshot,
      source_surplus_snapshot=EXCLUDED.source_surplus_snapshot,
      target_shortfall_snapshot=EXCLUDED.target_shortfall_snapshot,
      last_suggested_at=now(),last_validated_at=now(),updated_at=now();
    GET DIAGNOSTICS v_rows=ROW_COUNT;
    CONTINUE WHEN v_rows=0;
    v_minted:=v_minted+1;
    v_surplus:=v_surplus-v_take;
    v_shortfall:=v_shortfall-v_take;
  END LOOP;
  IF v_minted=0 THEN RAISE EXCEPTION 'no_eligible_fefo_batch'; END IF;
  RETURN jsonb_build_object(
    'route_kind','central_to_institution','suggestions',v_minted
  );
END;
$$;

-- ============================================================================
-- Draft bridge capsule. The complete 149 writer remains the private delegate.
-- The wrapper supplies exact identity context to its position/commitment reads,
-- validates source identity before delegation and validates the resulting
-- document line afterwards. Any mismatch raises in the same transaction and
-- rolls the whole Draft back; no stock movement is introduced.
-- ============================================================================
ALTER FUNCTION public.phoenix_create_transfer_draft_from_suggestion(uuid,text)
  RENAME TO _phoenix_150_delegate_create_transfer_draft_from_suggestion;
REVOKE ALL ON FUNCTION public._phoenix_150_delegate_create_transfer_draft_from_suggestion(
  uuid,text
) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.phoenix_create_transfer_draft_from_suggestion(
  p_suggestion_id uuid,
  p_document_number text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_s public.inventory_transfer_suggestions%ROWTYPE;
  v_source_key text;
  v_result jsonb;
  v_line_key text;
  v_line_id uuid;
  v_line record;
BEGIN
  SELECT * INTO v_s FROM public.inventory_transfer_suggestions
  WHERE id=p_suggestion_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'suggestion_not_found'; END IF;
  IF v_s.material_identity_state<>'resolved'
     OR v_s.material_identity_version<>1 OR v_s.material_identity_key IS NULL THEN
    RAISE EXCEPTION 'suggestion_material_identity_unresolved';
  END IF;

  IF v_s.source_scope_kind='warehouse' THEN
    SELECT ws.material_identity_key INTO v_source_key
    FROM public.warehouse_stock ws
    WHERE ws.id=v_s.source_stock_id
      AND ws.organization_id=v_s.source_organization_id
      AND ws.warehouse_id=v_s.source_scope_id;
  ELSE
    SELECT os.material_identity_key INTO v_source_key
    FROM public.outlet_stock os
    WHERE os.id=v_s.source_stock_id
      AND os.organization_id=v_s.source_organization_id
      AND os.distribution_point_id=v_s.source_scope_id;
  END IF;
  IF v_source_key IS DISTINCT FROM v_s.material_identity_key THEN
    RAISE EXCEPTION 'suggestion_source_material_identity_mismatch';
  END IF;

  PERFORM public._phoenix_lock_inventory_resources(ARRAY[
    'inv_material:' || v_s.material_identity_key
  ]);
  PERFORM set_config('phoenix.material_identity_v1',v_s.material_identity_key,true);

  v_result:=public._phoenix_150_delegate_create_transfer_draft_from_suggestion(
    p_suggestion_id,p_document_number
  );

  IF v_s.route_kind='central_to_institution' THEN
    v_line_id:=(v_result->>'warehouse_transfer_request_line_id')::uuid;
    SELECT l.* INTO v_line FROM public.warehouse_transfer_request_lines l
    WHERE l.id=v_line_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'draft_line_id_missing'; END IF;
    v_line_key:=public._phoenix_material_identity_v1(
      v_line.central_item_id,v_line.scientific_name,v_s.national_code,
      v_line.concentration,v_line.dosage_form,v_line.unit
    );
  ELSIF v_s.route_kind='warehouse_to_outlet' THEN
    v_line_id:=(v_result->>'warehouse_dispatch_line_id')::uuid;
    SELECT l.* INTO v_line FROM public.warehouse_dispatch_lines l
    WHERE l.id=v_line_id AND l.warehouse_stock_id=v_s.source_stock_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'draft_line_id_missing'; END IF;
    v_line_key:=public._phoenix_material_identity_v1(
      v_line.central_item_id,v_line.scientific_name,v_line.national_code,
      v_line.concentration,v_line.dosage_form,v_line.unit
    );
  ELSIF v_s.route_kind='outlet_to_warehouse' THEN
    v_line_id:=(v_result->>'outlet_return_request_line_id')::uuid;
    SELECT l.* INTO v_line FROM public.outlet_return_request_lines l
    WHERE l.id=v_line_id AND l.source_outlet_stock_id=v_s.source_stock_id
      AND l.original_dispatch_line_id=v_s.provenance_dispatch_line_id
      AND l.original_inbound_movement_id=v_s.provenance_inbound_movement_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'draft_line_id_missing'; END IF;
    v_line_key:=public._phoenix_material_identity_v1(
      v_line.central_item_id,v_line.scientific_name,v_line.national_code,
      v_line.concentration,v_line.dosage_form,v_line.unit
    );
  ELSE
    RAISE EXCEPTION 'unsupported_route_kind: %',v_s.route_kind;
  END IF;

  IF v_line_key IS DISTINCT FROM v_s.material_identity_key THEN
    RAISE EXCEPTION 'draft_line_material_identity_mismatch';
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_create_transfer_draft_from_suggestion(uuid,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_create_transfer_draft_from_suggestion(uuid,text)
  TO authenticated;

-- Preserve generator ACLs/signatures exactly.
REVOKE ALL ON FUNCTION public.phoenix_suggest_inventory_transfers(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_suggest_inventory_transfers(uuid)
  TO authenticated;
REVOKE ALL ON FUNCTION public.phoenix_suggest_cross_org_inventory_transfer(
  uuid,uuid,uuid,uuid,text,text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_suggest_cross_org_inventory_transfer(
  uuid,uuid,uuid,uuid,text,text
) TO authenticated;

-- ============================================================================
-- Deployment self-check: fail atomically if the capsule is incomplete.
-- ============================================================================
DO $verify$
DECLARE
  v_def text;
  v_index text;
BEGIN
  IF (SELECT provolatile FROM pg_proc
      WHERE oid='public._phoenix_material_identity_v1(uuid,text,text,text,text,text)'::regprocedure)
     <> 'i' THEN
    RAISE EXCEPTION '150_verify_failed: material_identity_not_immutable';
  END IF;
  IF EXISTS (
       SELECT 1
       FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(
         COALESCE(p.proacl,acldefault('f',p.proowner))
       ) a
       WHERE p.oid=
         'public._phoenix_material_identity_v1(uuid,text,text,text,text,text)'::regprocedure
         AND a.grantee=0 AND a.privilege_type='EXECUTE'
     )
     OR has_function_privilege('anon',
       'public._phoenix_material_identity_v1(uuid,text,text,text,text,text)','EXECUTE')
     OR has_function_privilege('authenticated',
       'public._phoenix_material_identity_v1(uuid,text,text,text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION '150_verify_failed: internal_identity_helper_executable';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouse_stock'
      AND column_name='material_identity_key' AND is_generated='ALWAYS'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='outlet_stock'
      AND column_name='material_identity_key' AND is_generated='ALWAYS'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouse_quarantine_stock'
      AND column_name='material_identity_key' AND is_generated='ALWAYS'
  ) THEN
    RAISE EXCEPTION '150_verify_failed: stock_material_identity_missing';
  END IF;

  SELECT pg_get_indexdef(indexrelid) INTO v_index
  FROM pg_index WHERE indexrelid='public.warehouse_stock_identity_uniq'::regclass;
  IF v_index NOT ILIKE '%material_identity_key%'
     OR v_index NOT ILIKE '%batch_number%'
     OR v_index NOT ILIKE '%internal_batch_reference%'
     OR v_index NOT ILIKE '%supply_type%'
     OR v_index NOT ILIKE '%purchase_origin%' THEN
    RAISE EXCEPTION '150_verify_failed: warehouse_lot_identity_incomplete';
  END IF;
  SELECT pg_get_indexdef(indexrelid) INTO v_index
  FROM pg_index WHERE indexrelid='public.outlet_stock_identity_uniq'::regclass;
  IF v_index NOT ILIKE '%material_identity_key%' THEN
    RAISE EXCEPTION '150_verify_failed: outlet_lot_identity_incomplete';
  END IF;
  SELECT pg_get_indexdef(indexrelid) INTO v_index
  FROM pg_index WHERE indexrelid='public.wqs_identity_uniq'::regclass;
  IF v_index NOT ILIKE '%material_identity_key%'
     OR v_index NOT ILIKE '%quarantine_reason%' THEN
    RAISE EXCEPTION '150_verify_failed: quarantine_lot_identity_incomplete';
  END IF;

  IF to_regprocedure('public.phoenix_recompute_inventory_alerts(uuid,text,uuid)') IS NULL
     OR to_regprocedure('public.phoenix_suggest_inventory_transfers(uuid)') IS NULL
     OR to_regprocedure(
       'public.phoenix_suggest_cross_org_inventory_transfer(uuid,uuid,uuid,uuid,text,text)'
     ) IS NULL
     OR to_regprocedure(
       'public.phoenix_create_transfer_draft_from_suggestion(uuid,text)'
     ) IS NULL THEN
    RAISE EXCEPTION '150_verify_failed: public_signature_missing';
  END IF;

  IF has_function_privilege('anon',
       'public.phoenix_recompute_inventory_alerts(uuid,text,uuid)','EXECUTE')
     OR has_function_privilege('anon',
       'public.phoenix_suggest_inventory_transfers(uuid)','EXECUTE')
     OR has_function_privilege('anon',
       'public.phoenix_suggest_cross_org_inventory_transfer(uuid,uuid,uuid,uuid,text,text)',
       'EXECUTE')
     OR has_function_privilege('anon',
       'public.phoenix_create_transfer_draft_from_suggestion(uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION '150_verify_failed: anon_execute_regression';
  END IF;

  v_def:=pg_get_functiondef(
    'public.phoenix_recompute_inventory_alerts(uuid,text,uuid)'::regprocedure
  );
  IF v_def NOT ILIKE '%material_identity_key%'
     OR v_def NOT ILIKE '%GROUP BY scope_kind,scope_id,material_identity_key%'
     OR v_def NOT ILIKE '%''legacy_unresolved''%'
     OR v_def ILIKE '%INSERT INTO public.warehouse_stock_movements%'
     OR v_def ILIKE '%INSERT INTO public.outlet_stock_movements%' THEN
    RAISE EXCEPTION '150_verify_failed: alert_identity_or_movement_boundary';
  END IF;

  v_def:=pg_get_functiondef(
    'public.phoenix_suggest_inventory_transfers(uuid)'::regprocedure
  );
  IF v_def NOT ILIKE '%s.material_identity_key=a.material_identity_key%'
     OR v_def NOT ILIKE '%b.material_identity_key=v_src.material_identity_key%'
     OR v_def ILIKE '%INSERT INTO public.warehouse_stock_movements%'
     OR v_def ILIKE '%INSERT INTO public.outlet_stock_movements%' THEN
    RAISE EXCEPTION '150_verify_failed: suggestion_identity_or_movement_boundary';
  END IF;

  v_def:=pg_get_functiondef(
    'public.phoenix_create_transfer_draft_from_suggestion(uuid,text)'::regprocedure
  );
  IF v_def NOT ILIKE '%draft_line_material_identity_mismatch%'
     OR v_def ILIKE '%INSERT INTO public.warehouse_stock_movements%'
     OR v_def ILIKE '%INSERT INTO public.outlet_stock_movements%' THEN
    RAISE EXCEPTION '150_verify_failed: draft_identity_or_movement_boundary';
  END IF;

  -- Reports/RBAC remain untouched: canonical report RPCs and the FEFO override
  -- permission still exist, while their definitions/defaults are not replaced.
  IF to_regprocedure(
       'public.phoenix_movement_timeline(uuid,integer,timestamptz,uuid)'
     ) IS NULL
     OR to_regprocedure(
       'public.phoenix_movement_ledger_report(uuid,timestamptz,timestamptz,text,text,uuid,text,text,integer,integer)'
     ) IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.permission_keys p WHERE p.key='inventory.fefo_override'
     ) THEN
    RAISE EXCEPTION '150_verify_failed: report_or_rbac_contract_missing';
  END IF;
END;
$verify$;

COMMENT ON COLUMN public.warehouse_stock.material_identity_key IS
  'Material identity only. Lot identity additionally includes location, batch, '
  'internal reference, expiry and supply provenance in warehouse_stock_identity_uniq.';
COMMENT ON COLUMN public.outlet_stock.material_identity_key IS
  'Material identity only; provenance identity remains original line/movement linkage.';
COMMENT ON COLUMN public.warehouse_quarantine_stock.material_identity_key IS
  'Material identity only; quarantine reason and lot/provenance fields remain separate.';

COMMIT;

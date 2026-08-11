-- ============================================================================
-- STAGE-G-G3.1 — CANONICAL AUTHENTICATED AVAILABILITY HARDENING (179)
--
-- DEFECT (reproduced on a disposable 001->178 rig, current master):
-- Migration 176's authenticated read model reconstructs physical identity from
-- RAW material columns:
--
--   GROUP BY organization_id, distribution_point_id, scientific_name,
--            COALESCE(concentration,''), COALESCE(dosage_form,''),
--            COALESCE(national_code,''), COALESCE(batch_number,''),
--            COALESCE(expiry_date,'0001-01-01'),
--            COALESCE(internal_batch_reference,'')
--
-- `unit` is ABSENT from that grouping, and outlet_stock.material_identity_key
-- is never used. So two canonically DISTINCT materials that differ only by unit
-- are summed into one row:
--
--   5 box  (…|unit=V3:box)     -+
--                               +-->  ONE row, quantity = 8
--   3 strip(…|unit=V5:strip)   -+
--
-- Migration 150 is authoritative for physical material identity and includes
-- `unit` as an identity component, so those two rows are different materials.
-- Summing them is not a rounding difference — it reports stock that does not
-- exist in either unit.
--
-- The read model also published NO row-level unit at all. The only unit any
-- consumer could reach was local_items -> central_items.unit, i.e. CATALOGUE
-- metadata belonging to the local item, not to the physical stock identity. The
-- authenticated UI rendered `quantity + central_items.unit`, so the merged row
-- above displayed as "8 tablet" — a quantity that never existed, in a unit that
-- belonged to neither physical identity.
--
-- FIX (all three parts are one defect):
--   1. Group physical rows by outlet_stock.material_identity_key — the
--      GENERATED ALWAYS column Migration 150 already maintains — plus the lot
--      dimensions Migration 176 already used. No new identity dimension is
--      invented and no second identity algorithm is written.
--   2. Publish an additive row-level `unit`, taken from the canonical
--      outlet_stock identity that the row represents. NULL stays NULL. There is
--      NO central_items.unit fallback, in either direction.
--   3. Anchor row_key for stock-backed rows to that canonical identity, so
--      unit-distinct identities can never share a row identity.
--
-- WHY row_key HAD TO CHANGE (the only non-additive change in this migration):
-- item_availability has NO unit column, so ONE catalogue row cannot distinguish
-- 5 box from 3 strip. Once the canonical group is split, BOTH physical rows
-- match that single catalogue row, and 176's
--   CASE WHEN catalogue_id IS NOT NULL THEN 'catalogue:'||catalogue_id …
-- would emit the SAME row_key for two different physical materials. Today the
-- collision is invisible only because the two rows are wrongly merged first.
-- So every row backed by canonical stock now derives row_key from the physical
-- identity; only catalogue-ONLY rows (no physical stock) keep the catalogue
-- form. `id` and `catalogue_item_availability_id` keep their exact previous
-- meaning and are NOT repurposed as physical identity.
--
-- ENCODING: the stock row_key is a LOSSLESS encoding of that canonical tuple,
-- not a hash of it. A delimiter-joined string is only unambiguous if no
-- component can contain the delimiter, and batch_number /
-- internal_batch_reference are free text that can contain '|' and date-like
-- substrings. Measured on the rig, these two tuples collide under concat_ws and
-- stay distinct under jsonb:
--   (batch 'X|2027-01-01|Y', expiry 2030-01-01, ref '')
--   (batch 'X',              expiry 2027-01-01, ref 'Y|2030-01-01|')
-- To be accurate about severity: that exact pair is NOT reachable in today's
-- schema, because outlet_stock_internal_ref_rule_chk makes batch_number and
-- internal_batch_reference mutually exclusive, so one of them is always empty.
-- jsonb_build_array removes the whole class anyway by quoting and escaping
-- every element.
--
-- Hashing that injective serialization then put the ambiguity straight back.
-- md5 is a finite 128-bit mapping, so it cannot support the "unique per
-- physical row" guarantee this column advertises to its consumers — and no
-- digest can: sha256 only makes a collision unlikely, never impossible. The
-- jsonb text is therefore hex-encoded whole,
-- encode(convert_to(...,'UTF8'),'hex'): deterministic, reversible, free of
-- separator and control characters, safe as a React key, and injective by
-- construction rather than by probability. The 'stock:v1:' prefix names the
-- encoding, so a future change is a new version rather than a silent
-- reinterpretation of the same string.
--
-- CATALOGUE METADATA MATCHING: Migration 150's identity normalizes every
-- material component with lower(btrim(...)), so ONE canonical group can hold
-- outlet_stock rows whose RAW spellings differ — case only, since the btrim
-- CHECKs already forbid padding. Such variants coexist because
-- outlet_stock_identity_uniq also keys on supply_type/purchase_origin, which
-- this read model aggregates over. Pairing item_availability by RAW equality
-- against a min() representative therefore DETACHED catalogue metadata from the
-- physical row whenever the catalogue held the other spelling. Reproduced on
-- the rig: one physical row with no local_item_id/notes/price, plus a SEPARATE
-- catalogue-only zero row for the same conceptual material — a duplicate
-- material in the UI, and removed_at stranded on the row carrying no stock.
-- The pairing is now layered and fail-safe:
--   1. exact RAW match — what 176 always did. Provably at most ONE per
--      canonical group: any catalogue row able to satisfy that predicate has
--      scientific_name NOT NULL (outlet_stock.scientific_name is non-empty by
--      outlet_stock_sci_name_chk and NULL never equates), so it is covered by
--      item_availability_dp_sci_conc_form_nat_batch_exp_ibr_uniq, whose columns
--      are exactly this predicate's columns.
--   2. otherwise a Migration-150-NORMALIZED match, applied ONLY when exactly
--      one catalogue row matches.
--   3. otherwise no catalogue metadata at all.
-- Step 2 needs that guard because item_availability's own uniqueness is RAW:
-- two catalogue rows differing only in case ARE insertable at one point
-- (measured on the rig), so attaching either would be an arbitrary pick and
-- attaching both would multiply the physical row. Ambiguity instead degrades to
-- exactly today's behaviour. Only the MATERIAL components are normalized — the
-- lot dimensions stay exact, matching Migration 150's own scope — and the
-- normalization is case/whitespace only, reusing 150's helper rather than
-- inventing a second algorithm. It is never fuzzy. A catalogue row that no
-- group selected still surfaces as a catalogue-only row, so nothing disappears.
--
-- NOT CHANGED: the signature, every existing response key, SECURITY DEFINER,
-- search_path, the anon revocation, the authenticated/service_role grants,
-- organization scoping, the forbidden/nonexistent-point indistinguishability,
-- removed_at metadata, and item_availability's status as OPTIONAL metadata that
-- never becomes physical quantity/condition truth. There are still exactly two
-- stock truths (warehouse_stock, outlet_stock); this read model adds none.
-- Migrations 150/176/177/178 are NOT edited.
-- ============================================================================

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.outlet_stock') IS NULL
     OR to_regclass('public.item_availability') IS NULL
     OR to_regclass('public.distribution_points') IS NULL
     OR to_regclass('public.local_items') IS NULL
     OR to_regclass('public.central_items') IS NULL THEN
    RAISE EXCEPTION '179 preflight failed: required tables missing';
  END IF;

  -- The whole fix rests on Migration 150's generated identity column. If it is
  -- absent, or no longer generated, fail rather than silently regrouping on raw
  -- columns again.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='outlet_stock'
       AND column_name='material_identity_key' AND is_generated='ALWAYS'
  ) THEN
    RAISE EXCEPTION '179 preflight failed: outlet_stock.material_identity_key is missing or not GENERATED ALWAYS';
  END IF;

  IF to_regprocedure('public._phoenix_material_identity_v1(uuid,text,text,text,text,text)') IS NULL THEN
    RAISE EXCEPTION '179 preflight failed: Migration-150 canonical identity helper missing';
  END IF;

  -- The catalogue metadata match normalizes with Migration 150's OWN component
  -- helper rather than a second lower/btrim algorithm. If it is gone, fail
  -- rather than silently falling back to raw-only matching.
  IF to_regprocedure('public._phoenix_material_identity_component_v1(text)') IS NULL THEN
    RAISE EXCEPTION '179 preflight failed: Migration-150 canonical component helper missing';
  END IF;

  -- The RAW catalogue pairing yields at most one row per canonical group ONLY
  -- because item_availability's own uniqueness covers exactly that predicate's
  -- columns. That is what makes step 1 a proof rather than an assumption, so
  -- assert the index itself rather than trusting it to still be there.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND tablename='item_availability'
       AND indexname='item_availability_dp_sci_conc_form_nat_batch_exp_ibr_uniq'
  ) THEN
    RAISE EXCEPTION '179 preflight failed: item_availability raw uniqueness index missing';
  END IF;

  -- 179 REPLACES an existing read model; it never installs a new surface.
  IF to_regprocedure('public.phoenix_outlet_availability_read_model(uuid)') IS NULL THEN
    RAISE EXCEPTION '179 preflight failed: Migration-176 authenticated read model missing';
  END IF;

  IF to_regprocedure('public.phoenix_derive_outlet_availability_condition(integer,date)') IS NULL THEN
    RAISE EXCEPTION '179 preflight failed: canonical outlet condition helper missing';
  END IF;

  -- Baseline ACL must already be the one 176 established, or this migration is
  -- being applied to a database whose security posture is not what it assumes.
  IF has_function_privilege('anon','public.phoenix_outlet_availability_read_model(uuid)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION '179 preflight failed: anon already holds EXECUTE on the authenticated read model';
  END IF;
  IF NOT has_function_privilege('authenticated','public.phoenix_outlet_availability_read_model(uuid)'::regprocedure,'EXECUTE')
     OR NOT has_function_privilege('service_role','public.phoenix_outlet_availability_read_model(uuid)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION '179 preflight failed: authenticated/service_role baseline grant missing';
  END IF;

  -- Migration 177's anonymous Public QR contract is a DIFFERENT surface and must
  -- be intact and untouched (176 asserted the same thing).
  IF to_regprocedure('public.get_public_qr_payload(text)') IS NULL
     OR NOT has_function_privilege('anon','public.get_public_qr_payload(text)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION '179 preflight failed: public QR anonymous contract is not intact';
  END IF;

  -- Hotfix 178 must still be in place; 179 must never be the migration that
  -- silently lands on a database where the P0 repair went missing.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='distribution_points_wh_org_fk'
       AND conrelid='public.distribution_points'::regclass AND contype='f'
  ) THEN
    RAISE EXCEPTION '179 preflight failed: Hotfix-178 ownership FK is missing';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.phoenix_outlet_availability_read_model(p_distribution_point_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_role text;
  v_point_org uuid;
  v_rows jsonb;
  v_empty jsonb := jsonb_build_object(
    'ok', true, 'scope', 'distribution_point', 'distribution_point_id', NULL,
    'source', 'canonical_outlet_stock', 'rows', '[]'::jsonb
  );
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE='28000'; END IF;
  SELECT p.organization_id,p.role INTO v_org,v_role FROM public.profiles p WHERE p.id=v_actor AND p.status='active';
  IF NOT FOUND OR p_distribution_point_id IS NULL THEN RETURN v_empty; END IF;
  SELECT d.organization_id INTO v_point_org FROM public.distribution_points d WHERE d.id=p_distribution_point_id;
  IF NOT FOUND OR NOT (v_role='super_admin' OR (v_org IS NOT NULL AND v_org=v_point_org)) THEN RETURN v_empty; END IF;

  WITH canonical AS (
    -- Physical identity is material_identity_key (Migration 150, GENERATED
    -- ALWAYS), NOT a re-derivation from raw columns. unit, central_item_id,
    -- scientific_name, national_code, concentration and dosage_form are all
    -- COMPONENTS of that key, so each is constant inside a group and min() is
    -- an exact representative — the same technique Migration 177 uses. The lot
    -- dimensions below are exactly the ones Migration 176 already grouped on;
    -- supply_type and purchase_origin stay aggregated-over, as before.
    SELECT s.organization_id,s.distribution_point_id,
      s.material_identity_key,
      min(s.scientific_name) AS scientific_name,
      COALESCE(min(s.concentration),'') AS concentration_key,
      COALESCE(min(s.dosage_form),'') AS dosage_form_key,
      COALESCE(min(s.national_code),'') AS national_code_key,
      COALESCE(s.batch_number,'') AS batch_number_key,
      COALESCE(s.expiry_date,DATE '0001-01-01') AS expiry_date_key,
      COALESCE(s.internal_batch_reference,'') AS internal_batch_reference_key,
      -- Migration-150 normalized material components. Each is CONSTANT inside
      -- the group (they are the very components material_identity_key is built
      -- from), so applying the helper to the min() representative yields the
      -- group's shared value exactly. Used only to pair catalogue metadata.
      public._phoenix_material_identity_component_v1(min(s.scientific_name)) AS scientific_name_norm,
      public._phoenix_material_identity_component_v1(min(s.concentration))   AS concentration_norm,
      public._phoenix_material_identity_component_v1(min(s.dosage_form))     AS dosage_form_norm,
      public._phoenix_material_identity_component_v1(min(s.national_code))   AS national_code_norm,
      -- The physical row unit. Constant within the group because it is part of
      -- the identity; never a catalogue value.
      min(s.unit) AS unit,
      MAX(s.trade_name) AS trade_name,MAX(s.unit_price) AS unit_price,MAX(s.updated_at) AS updated_at,
      SUM(s.on_hand_quantity)::integer AS on_hand_quantity,
      SUM(s.available_quantity)::integer AS available_quantity,
      -- LOSSLESS canonical row identity — see this file's ENCODING header. Every
      -- element below is a GROUP BY key, so this is the group's own identity,
      -- and it is also what the catalogue match keys on further down.
      'stock:v1:'||encode(convert_to(jsonb_build_array(
        p_distribution_point_id::text,
        s.material_identity_key,
        COALESCE(s.batch_number,''),
        COALESCE(s.expiry_date,DATE '0001-01-01')::text,
        COALESCE(s.internal_batch_reference,''))::text,'UTF8'),'hex') AS row_key
    FROM public.outlet_stock s
    WHERE s.distribution_point_id=p_distribution_point_id
    -- central_item_id is a COMPONENT of material_identity_key, so grouping by
    -- it cannot split a canonical group.
    GROUP BY s.organization_id,s.distribution_point_id,s.material_identity_key,s.central_item_id,
      COALESCE(s.batch_number,''),COALESCE(s.expiry_date,DATE '0001-01-01'),
      COALESCE(s.internal_batch_reference,'')
  ), catalogue AS (
    SELECT ia.*,
      COALESCE(ia.concentration,'') AS concentration_key,
      COALESCE(ia.dosage_form,'') AS dosage_form_key,
      COALESCE(ia.national_code,'') AS national_code_key,
      COALESCE(ia.batch_number,'') AS batch_number_key,
      COALESCE(ia.expiry_date,DATE '0001-01-01') AS expiry_date_key,
      COALESCE(ia.internal_batch_reference,'') AS internal_batch_reference_key,
      public._phoenix_material_identity_component_v1(ia.scientific_name) AS scientific_name_norm,
      public._phoenix_material_identity_component_v1(ia.concentration)   AS concentration_norm,
      public._phoenix_material_identity_component_v1(ia.dosage_form)     AS dosage_form_norm,
      public._phoenix_material_identity_component_v1(ia.national_code)   AS national_code_norm
    FROM public.item_availability ia WHERE ia.distribution_point_id=p_distribution_point_id
  ), raw_match AS (
    -- STEP 1 — exact RAW pairing, byte-for-byte what Migration 176 did. At most
    -- ONE per canonical group (see this file's CATALOGUE METADATA MATCHING
    -- header for why the unique index makes that a proof, not a hope), so it
    -- can never multiply a physical row.
    SELECT c.row_key,ia.id AS catalogue_id
    FROM canonical c JOIN catalogue ia
      ON ia.scientific_name=c.scientific_name
     AND ia.concentration_key=c.concentration_key
     AND ia.dosage_form_key=c.dosage_form_key
     AND ia.national_code_key=c.national_code_key
     AND ia.batch_number_key=c.batch_number_key
     AND ia.expiry_date_key=c.expiry_date_key
     AND ia.internal_batch_reference_key=c.internal_batch_reference_key
  ), norm_match AS (
    -- STEP 2 — Migration-150-normalized pairing for the MATERIAL components
    -- only; the lot dimensions stay exact. HAVING count(*)=1 is the fail-safe:
    -- item_availability's uniqueness is RAW, so two case-variant catalogue rows
    -- can coexist at one point, and an ambiguous group takes NO metadata rather
    -- than an arbitrary one. array_agg()[1] (not min(uuid), which is not
    -- available on every supported server) reads the single surviving row.
    SELECT c.row_key,(array_agg(ia.id))[1] AS catalogue_id
    FROM canonical c JOIN catalogue ia
      ON ia.scientific_name_norm=c.scientific_name_norm
     AND ia.concentration_norm=c.concentration_norm
     AND ia.dosage_form_norm=c.dosage_form_norm
     AND ia.national_code_norm=c.national_code_norm
     AND ia.batch_number_key=c.batch_number_key
     AND ia.expiry_date_key=c.expiry_date_key
     AND ia.internal_batch_reference_key=c.internal_batch_reference_key
    GROUP BY c.row_key
    HAVING count(*)=1
  ), selected AS (
    -- Exactly one catalogue candidate per canonical group, or none. RAW wins,
    -- so a pairing that already worked keeps working unchanged.
    SELECT c.*,COALESCE(rm.catalogue_id,nm.catalogue_id) AS selected_catalogue_id
    FROM canonical c
    LEFT JOIN raw_match  rm ON rm.row_key=c.row_key
    LEFT JOIN norm_match nm ON nm.row_key=c.row_key
  ), joined AS (
    SELECT c.organization_id AS canonical_org_id,c.distribution_point_id AS canonical_point_id,
      c.material_identity_key AS canonical_material_identity_key,
      c.scientific_name AS canonical_scientific_name,c.concentration_key AS canonical_concentration_key,
      c.dosage_form_key AS canonical_dosage_form_key,c.national_code_key AS canonical_national_code_key,
      c.batch_number_key AS canonical_batch_number_key,c.expiry_date_key AS canonical_expiry_date_key,
      c.internal_batch_reference_key AS canonical_internal_ref_key,c.trade_name AS canonical_trade_name,
      c.row_key AS canonical_row_key,
      c.unit AS canonical_unit,
      c.unit_price AS canonical_unit_price,c.updated_at AS canonical_updated_at,c.on_hand_quantity,c.available_quantity,
      ia.id AS catalogue_id,ia.local_item_id,ia.organization_id AS catalogue_org_id,ia.port_name,
      ia.scientific_name AS catalogue_scientific_name,ia.trade_name AS catalogue_trade_name,
      ia.concentration AS catalogue_concentration,ia.dosage_form AS catalogue_dosage_form,
      ia.national_code AS catalogue_national_code,ia.batch_number AS catalogue_batch_number,
      ia.expiry_date AS catalogue_expiry_date,ia.internal_batch_reference AS catalogue_internal_ref,
      ia.notes,ia.supply_type,ia.price,ia.removed_at,ia.updated_at AS catalogue_updated_at
    -- The pairing decision was already made, deterministically and at most
    -- once, in `selected`. FULL OUTER preserves both open ends exactly as
    -- before: a canonical group with no catalogue candidate keeps its physical
    -- row, and a catalogue row NO group selected still surfaces on its own —
    -- including both members of an ambiguous pair, so nothing is dropped. One
    -- catalogue row may legitimately be selected by SEVERAL canonical groups
    -- (5 box and 3 strip share one unit-less catalogue row); that fans the
    -- catalogue metadata out to each physical row, which is correct, and is not
    -- row multiplication because each physical row still appears once.
    FROM selected c
    FULL OUTER JOIN catalogue ia ON ia.id=c.selected_catalogue_id
  ), shaped AS (
    SELECT j.catalogue_id AS id,j.catalogue_id AS catalogue_item_availability_id,
      -- Stock-backed rows are identified by their PHYSICAL identity, so two
      -- unit-distinct materials sharing one catalogue row stay distinct. Only a
      -- row with no physical stock at all falls back to the catalogue form. The
      -- value is the LOSSLESS encoding computed in `canonical` — carried
      -- through rather than recomputed, so the string the client keys on and
      -- the string the catalogue match keys on cannot drift apart.
      CASE WHEN j.canonical_row_key IS NOT NULL
        THEN j.canonical_row_key
        ELSE 'catalogue:'||j.catalogue_id::text END AS row_key,
      j.local_item_id,p_distribution_point_id AS distribution_point_id,
      COALESCE(j.canonical_org_id,j.catalogue_org_id) AS organization_id,
      COALESCE(j.available_quantity,0) AS quantity,
      -- The physical unit of THIS row's canonical identity. '' collapses to
      -- NULL exactly as Migration 177 projects its public row unit. There is no
      -- central_items.unit fallback in either direction: a catalogue unit
      -- describes the local item, not this physical stock identity.
      NULLIF(j.canonical_unit,'') AS unit,
      public.phoenix_derive_outlet_availability_condition(COALESCE(j.available_quantity,0),COALESCE(j.catalogue_expiry_date,NULLIF(j.canonical_expiry_date_key,DATE '0001-01-01'))) AS condition,
      COALESCE(j.catalogue_batch_number,NULLIF(j.canonical_batch_number_key,'')) AS batch_number,
      COALESCE(j.catalogue_national_code,NULLIF(j.canonical_national_code_key,'')) AS national_code,
      COALESCE(j.catalogue_expiry_date,NULLIF(j.canonical_expiry_date_key,DATE '0001-01-01')) AS expiry_date,
      j.notes,COALESCE(j.catalogue_updated_at,j.canonical_updated_at) AS updated_at,j.port_name,j.supply_type,j.removed_at,
      COALESCE(j.canonical_scientific_name,j.catalogue_scientific_name) AS scientific_name,
      COALESCE(j.catalogue_trade_name,j.canonical_trade_name) AS trade_name,
      COALESCE(j.catalogue_dosage_form,NULLIF(j.canonical_dosage_form_key,'')) AS dosage_form,
      COALESCE(j.catalogue_concentration,NULLIF(j.canonical_concentration_key,'')) AS concentration,
      COALESCE(j.price,j.canonical_unit_price) AS price,
      COALESCE(j.catalogue_internal_ref,NULLIF(j.canonical_internal_ref_key,'')) AS internal_batch_reference,
      COALESCE(j.on_hand_quantity,0) AS canonical_on_hand_quantity,
      COALESCE(j.available_quantity,0) AS canonical_available_quantity,
      CASE WHEN public.phoenix_derive_outlet_availability_condition(COALESCE(j.available_quantity,0),COALESCE(j.catalogue_expiry_date,NULLIF(j.canonical_expiry_date_key,DATE '0001-01-01'))) IN ('expired','missing') THEN 0 ELSE COALESCE(j.available_quantity,0) END AS canonical_usable_quantity,
      CASE WHEN li.id IS NULL THEN NULL ELSE jsonb_build_object('id',li.id,'local_code',li.local_code,
        'central_items',CASE WHEN ci.id IS NULL THEN NULL ELSE jsonb_build_object('id',ci.id,'name',ci.name,'name_ar',ci.name_ar,'unit',ci.unit,'barcode',ci.barcode) END) END AS local_items
    FROM joined j
    LEFT JOIN public.local_items li ON li.id=j.local_item_id
    LEFT JOIN public.central_items ci ON ci.id=li.central_item_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'catalogue_item_availability_id', s.catalogue_item_availability_id,
    'row_key', s.row_key,
    'local_item_id', s.local_item_id,
    'distribution_point_id', s.distribution_point_id,
    'organization_id', s.organization_id,
    'quantity', s.quantity,
    'unit', s.unit,
    'condition', s.condition,
    'batch_number', s.batch_number,
    'national_code', s.national_code,
    'expiry_date', s.expiry_date,
    'notes', s.notes,
    'updated_at', s.updated_at,
    'port_name', s.port_name,
    'supply_type', s.supply_type,
    'removed_at', s.removed_at,
    'scientific_name', s.scientific_name,
    'trade_name', s.trade_name,
    'dosage_form', s.dosage_form,
    'concentration', s.concentration,
    'price', s.price,
    'internal_batch_reference', s.internal_batch_reference,
    'canonical_on_hand_quantity', s.canonical_on_hand_quantity,
    'canonical_available_quantity', s.canonical_available_quantity,
    'canonical_usable_quantity', s.canonical_usable_quantity,
    'local_items', s.local_items
  ) ORDER BY s.updated_at DESC NULLS LAST,s.row_key),'[]'::jsonb)
  INTO v_rows FROM shaped s;

  RETURN jsonb_build_object('ok',true,'scope','distribution_point','distribution_point_id',p_distribution_point_id,'source','canonical_outlet_stock','rows',v_rows);
END;
$function$;

-- CREATE OR REPLACE preserves the existing ACL; these restate Migration 176's
-- contract verbatim so the posture is visible in this file rather than implied.
REVOKE ALL ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) TO service_role;

COMMENT ON FUNCTION public.phoenix_outlet_availability_read_model(uuid) IS
  'STAGE-G-G3.1 (179): authenticated outlet availability, grouped by the canonical outlet_stock.material_identity_key (Migration 150) instead of raw material columns, so unit-distinct identities such as 5 box and 3 strip can never be summed into 8. Publishes an additive row-level `unit` taken from the canonical identity the row represents; NULL stays NULL and central_items.unit is never a fallback in either direction. Stock-backed rows carry a row_key that is a LOSSLESS hex encoding of the jsonb-serialized canonical tuple (prefix stock:v1:) rather than a digest of it, so its per-physical-row uniqueness is a construction rather than a probability; catalogue-only rows keep the catalogue form. item_availability metadata is paired to a physical row by exact raw match first and, only when exactly one candidate matches, by Migration 150 normalization — so a canonical group no longer detaches from a catalogue row that merely spells the material differently, and ambiguous candidates attach nothing instead of guessing. Physical quantity and condition still come only from canonical outlet_stock — item_availability remains optional metadata and never becomes stock truth. Signature, every prior response key, SECURITY DEFINER, search_path, organization scoping and the anon revocation are unchanged.';

DO $verify$
DECLARE
  v_src     text;
  v_secdef  boolean;
  v_config  text[];
BEGIN
  SELECT p.prosrc,p.prosecdef,p.proconfig INTO v_src,v_secdef,v_config
  FROM pg_proc p WHERE p.oid='public.phoenix_outlet_availability_read_model(uuid)'::regprocedure;

  IF v_src IS NULL THEN
    RAISE EXCEPTION '179 verify failed: read model missing after replace';
  END IF;

  -- 1. Canonical grouping must be identity-based.
  IF v_src NOT LIKE '%s.material_identity_key%' THEN
    RAISE EXCEPTION '179 verify failed: read model does not group on material_identity_key';
  END IF;

  -- 2. The raw-column grouping that caused the defect must not come back. The
  --    old GROUP BY re-derived identity from scientific_name + COALESCE(...)
  --    material columns; assert that shape is gone.
  IF v_src LIKE '%GROUP BY s.organization_id,s.distribution_point_id,s.scientific_name%' THEN
    RAISE EXCEPTION '179 verify failed: raw-column physical grouping was reintroduced';
  END IF;

  -- 3. Physical unit must be projected, and must never fall back to catalogue.
  IF v_src NOT LIKE '%NULLIF(j.canonical_unit,%' THEN
    RAISE EXCEPTION '179 verify failed: row-level canonical unit is not projected';
  END IF;
  IF v_src LIKE '%COALESCE(j.canonical_unit%ci.unit%'
     OR v_src LIKE '%COALESCE(ci.unit%' THEN
    RAISE EXCEPTION '179 verify failed: physical unit can fall back to the catalogue unit';
  END IF;

  -- 3b. The stock row_key must stay a LOSSLESS encoding of the canonical tuple.
  --     A digest cannot support the per-physical-row uniqueness this column
  --     advertises to its consumers, so a hash here is a contract regression
  --     rather than a style choice — md5 and sha alike.
  IF v_src NOT LIKE '%stock:v1:%' OR v_src NOT LIKE '%encode(convert_to(%' THEN
    RAISE EXCEPTION '179 verify failed: stock row_key is not the lossless v1 encoding';
  END IF;
  IF v_src LIKE '%md5(%' OR v_src LIKE '%digest(%' THEN
    RAISE EXCEPTION '179 verify failed: a hash reappeared in the physical row identity';
  END IF;

  -- 3c. Catalogue metadata pairing must stay layered and fail-safe: Migration
  --     150's own normalization, and no arbitrary pick when two catalogue rows
  --     normalize onto one identity.
  IF v_src NOT LIKE '%_phoenix_material_identity_component_v1%' THEN
    RAISE EXCEPTION '179 verify failed: catalogue match abandoned the Migration-150 component helper';
  END IF;
  IF v_src NOT LIKE '%HAVING count(*)=1%' THEN
    RAISE EXCEPTION '179 verify failed: ambiguous catalogue candidates are no longer fail-safe';
  END IF;

  -- 4/5. item_availability must not become physical quantity/condition truth.
  IF v_src NOT LIKE '%COALESCE(j.available_quantity,0) AS quantity%' THEN
    RAISE EXCEPTION '179 verify failed: quantity is no longer canonical-only';
  END IF;
  IF v_src LIKE '%COALESCE(ia.quantity%' OR v_src LIKE '%j.catalogue_quantity%'
     OR v_src LIKE '%COALESCE(ia.condition%' THEN
    RAISE EXCEPTION '179 verify failed: cache quantity/condition leaked into physical truth';
  END IF;

  -- 6. Organization scoping must survive.
  IF v_src NOT LIKE '%v_role=%super_admin%' OR v_src NOT LIKE '%v_org=v_point_org%' THEN
    RAISE EXCEPTION '179 verify failed: organization scoping was weakened';
  END IF;

  -- 7. Signature and security context unchanged.
  IF to_regprocedure('public.phoenix_outlet_availability_read_model(uuid)') IS NULL THEN
    RAISE EXCEPTION '179 verify failed: expected signature is gone';
  END IF;
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION '179 verify failed: read model is no longer SECURITY DEFINER';
  END IF;
  IF v_config IS NULL OR NOT ('search_path=public, pg_temp' = ANY (v_config)) THEN
    RAISE EXCEPTION '179 verify failed: read model lost its explicit search_path';
  END IF;

  -- 8/9. ACL contract.
  IF has_function_privilege('anon','public.phoenix_outlet_availability_read_model(uuid)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION '179 verify failed: anon gained EXECUTE on the authenticated read model';
  END IF;
  IF NOT has_function_privilege('authenticated','public.phoenix_outlet_availability_read_model(uuid)'::regprocedure,'EXECUTE')
     OR NOT has_function_privilege('service_role','public.phoenix_outlet_availability_read_model(uuid)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION '179 verify failed: authenticated/service_role grant lost';
  END IF;

  -- 10. Migration 177's Public QR surface must be untouched by this migration.
  IF to_regprocedure('public.get_public_qr_payload(text)') IS NULL
     OR NOT has_function_privilege('anon','public.get_public_qr_payload(text)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION '179 verify failed: public QR anonymous contract changed';
  END IF;

  -- Hotfix 178 must still stand.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='distribution_points_wh_org_fk'
       AND conrelid='public.distribution_points'::regclass AND contype='f'
  ) THEN
    RAISE EXCEPTION '179 verify failed: Hotfix-178 ownership FK disappeared';
  END IF;
END;
$verify$;

COMMIT;

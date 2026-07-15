-- =============================================================================
-- MediStock Phoenix V2 — Migration 059: Public QR Concentration (additive)
-- =============================================================================
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard → SQL Editor after reading this file in full.
-- Apply ONLY after migration 058 is confirmed applied and healthy.
--
-- Prerequisites: Migrations 001–058 must already be applied.
--
-- PUBLIC-QR-CONCENTRATION-059-A
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DOES
-- ─────────────────────────────────────────────────────────────────────────────
--   Migration 058 additively added 'dosage_form' to the two per-material item
--   objects returned by get_public_qr_payload. It did NOT add the material's
--   concentration/strength, even though operators can enter it and it is
--   stored on item_availability.concentration (added in migration 020,
--   alongside dosage_form).
--
--   concentration (e.g. "500 mg", "250 mg/5 ml", "٥٠٠ ملغم") is descriptive
--   clinical information — exactly analogous to the already-public dosage_form
--   and material name. It is not price, batch, supply type, national code,
--   contact, identity, dispatch, or any internal/operational field. Surfacing
--   it lets the public tell apart two materials that share the same scientific
--   name and dosage form but differ in strength — the single most common
--   real-world ambiguity on a pharmacy shelf (Paracetamol 500 mg tablet vs
--   Paracetamol 125 mg tablet).
--
--   This migration ADDITIVELY adds a single new field, 'concentration', to the
--   same two per-material item objects migration 058 touched:
--     • the distribution_point branch's items[] objects
--     • the local_item branch's availability[] objects
--   Its value is item_availability.concentration verbatim (JSON null when null
--   — no default, no normalization, no translation, no derivation from the
--   material name, no cross-table substitution).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
--   • Does NOT change the RPC name, parameter signature, or return type.
--   • Does NOT change SECURITY DEFINER or SET search_path = public.
--   • Does NOT change any GRANT (anon + authenticated EXECUTE, as since 003).
--   • Does NOT grant anon any direct item_availability access — the RPC
--     remains the only anon path (avail_select_anon stays `using (false)`,
--     migration 027).
--   • Does NOT add concentration to the warehouse branch: that branch returns
--     no per-material object at all (only point-level item_count), so there is
--     nowhere material-scoped to put it. Same reasoning migration 058 used.
--   • Does NOT add concentration to organization / point / token / warehouse
--     metadata — material objects only.
--   • Does NOT expose price, entered_price, supply_type, national_code,
--     batch_number, trade_name, notes, actor snapshots, movement records, or
--     any warehouse-dispatch field.
--   • Does NOT touch tables, columns, RLS, policies, or migrations 001–058.
--   • No DELETE, no TRUNCATE, no DROP, no ALTER TABLE.
--
--   The function body below is byte-for-byte identical to migration 058's,
--   except for the four additions marked "059:" — two per material branch
--   (one derived-subquery thread + one JSON key emission).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
--   Re-apply migration 058's `create or replace function get_public_qr_payload`
--   block verbatim. No data rollback is required or possible to need: this
--   migration reads an existing column and writes nothing. Existing
--   concentration data stays in item_availability either way, and every QR
--   link/public_id remains valid.
-- =============================================================================

begin;

-- =============================================================================
-- Replace get_public_qr_payload — additively add concentration to the two
-- per-material item objects. Body is otherwise byte-for-byte identical to
-- migration 058's definition. The only additions are marked "059:" below.
-- =============================================================================

create or replace function get_public_qr_payload(p_public_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token   qr_tokens%rowtype;
  v_target  qr_targets%rowtype;
  v_org     organizations%rowtype;
  v_payload jsonb;
begin
  -- resolve token (unchanged)
  select * into v_token
  from qr_tokens
  where public_id = p_public_id and status = 'active'
  limit 1;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'QR_NOT_FOUND_OR_DISABLED'
    );
  end if;

  -- resolve target (unchanged)
  select * into v_target from qr_targets where id = v_token.qr_target_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND');
  end if;

  -- resolve org (unchanged)
  select * into v_org from organizations where id = v_target.organization_id;

  -- record scan (unchanged)
  update qr_tokens
  set last_scanned_at = now(), scan_count = scan_count + 1
  where id = v_token.id;

  -- build payload based on target type
  case v_target.target_type

    when 'distribution_point' then
      -- D4 (preserved from migration 027): reject archived/inactive distribution points
      if not exists (
        select 1 from distribution_points
        where id = v_target.target_id and status = 'active'
      ) then
        return jsonb_build_object('ok', false, 'error', 'DISTRIBUTION_POINT_NOT_ACTIVE');
      end if;

      select jsonb_build_object(
        'ok',          true,
        'target_type', 'distribution_point',
        'org_name',    v_org.name,
        'org_name_ar', v_org.name_ar,
        'point_label', coalesce(v_target.label, dp.name),
        'items', (
          -- Items aggregation with D6 + D7 fixes applied via a derived subquery.
          -- The outer jsonb_build_object reads computed columns from the subquery
          -- so effective_condition and expiry_bucket are each evaluated once.
          select jsonb_agg(jsonb_build_object(
            -- D6: public-safe display name via COALESCE fallback chain
            'name',          derived.row_name,
            'name_ar',       derived.row_name_ar,
            'unit',          derived.row_unit,
            -- 059 (PUBLIC-QR-CONCENTRATION-059-A): additive public field,
            -- sourced verbatim from item_availability.concentration (JSON null
            -- when null). Threaded through `derived` like ia_dosage_form below.
            'concentration', derived.ia_concentration,
            -- 058 (PUBLIC-QR-DOSAGE-FORM-IMPLEMENT-A): additive public field,
            -- sourced verbatim from item_availability.dosage_form (JSON null
            -- when null). Threaded through `derived` like ia_quantity below.
            'dosage_form',   derived.ia_dosage_form,
            -- D7 (+ quantity-zero fix): computed condition (overrides manual
            -- ia.condition when expiry triggers, or quantity <= 0)
            'condition',     derived.effective_condition,
            -- D7: expiry bucket for 9/6/3/expired threshold badge on frontend
            'expiry_bucket', derived.expiry_bucket,
            -- D2 (preserved + extended to use effective_condition)
            'quantity',      case when derived.effective_condition = 'expired'
                               then null
                               else derived.ia_quantity
                             end,
            -- D3 (preserved + extended to use effective_condition)
            'expiry_date',   case when derived.effective_condition in ('near_expiry', 'expired')
                               then derived.ia_expiry_date
                               else null
                             end
          ) order by derived.row_name_ar)
          from (
            select
              -- D6: public-safe name fallback:
              --   1. central item English name  (when local_item_id IS NOT NULL)
              --   2. central item Arabic name   (cross-fallback for same item)
              --   3. ia.scientific_name         (when local_item_id IS NULL)
              --   4. safe English placeholder
              coalesce(ci.name,    ci.name_ar, ia.scientific_name, 'Unnamed material')   as row_name,
              coalesce(ci.name_ar, ci.name,    ia.scientific_name, 'مادة غير مسماة')   as row_name_ar,
              -- unit: from central_items when available; null for scientific_name-only rows
              ci.unit                                                                       as row_unit,
              -- 059: concentration threaded through so the outer jsonb object can
              -- read it (no `ia` alias is in scope there), sourced from
              -- item_availability.concentration verbatim.
              ia.concentration                                                              as ia_concentration,
              -- 058: dosage form threaded through so the outer jsonb object can
              -- read it (no `ia` alias is in scope there), sourced from
              -- item_availability.dosage_form verbatim.
              ia.dosage_form                                                                as ia_dosage_form,
              ia.quantity                                                                   as ia_quantity,
              ia.expiry_date                                                                as ia_expiry_date,
              -- D7 (+ quantity-zero fix): effective_condition overrides
              -- ia.condition when expiry_date triggers a threshold, or when
              -- quantity has been zeroed out by a normal quantity movement
              -- without a matching condition change (QR-EFFECTIVE-CONDITION-
              -- QUANTITY-ZERO-052-A).
              case
                when ia.expiry_date is not null
                  and ia.expiry_date < current_date
                  then 'expired'
                -- NEW (052): quantity zeroed by a normal quantity movement,
                -- without a matching condition change, is now shown as missing.
                when ia.quantity <= 0
                  then 'missing'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '3 months')::date
                  then 'near_expiry'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '6 months')::date
                  then 'near_expiry'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '9 months')::date
                  then 'near_expiry'
                else ia.condition
              end as effective_condition,
              -- D7: expiry_bucket for fine-grained frontend threshold display
              -- (unchanged by this migration — purely expiry-driven)
              case
                when ia.expiry_date is not null
                  and ia.expiry_date < current_date
                  then 'expired'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '3 months')::date
                  then '3_months'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '6 months')::date
                  then '6_months'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '9 months')::date
                  then '9_months'
                else null
              end as expiry_bucket
            from item_availability ia
            -- D6: LEFT JOIN so scientific_name-only rows (local_item_id = NULL) are included
            left join local_items li on li.id = ia.local_item_id
            left join central_items ci on ci.id = li.central_item_id
            where ia.distribution_point_id = v_target.target_id
          ) derived
        )
      )
      into v_payload
      from distribution_points dp
      where dp.id = v_target.target_id;

    when 'warehouse' then
      -- warehouse branch: unchanged from migration 027/028/052/058 — this branch
      -- only returns point-level item_count, with no per-item object of any
      -- kind, so no concentration (and no dosage_form) is added here.
      select jsonb_build_object(
        'ok',              true,
        'target_type',     'warehouse',
        'org_name',        v_org.name,
        'org_name_ar',     v_org.name_ar,
        'warehouse_label', coalesce(v_target.label, wh.name),
        'points', (
          select jsonb_agg(jsonb_build_object(
            'point_id',      dp.id,
            'point_name',    dp.name,
            'point_name_ar', dp.name_ar,
            'item_count', (
              select count(*) from item_availability
              where distribution_point_id = dp.id
            )
          ) order by dp.name_ar)
          from distribution_points dp
          where dp.warehouse_id = wh.id and dp.status = 'active'
        )
      )
      into v_payload
      from warehouses wh
      where wh.id = v_target.target_id;

    when 'local_item' then
      -- local_item branch: D7 fix applied; D6 does not apply here
      -- (this branch already filters by a specific local_item_id).
      select jsonb_build_object(
        'ok',           true,
        'target_type',  'local_item',
        'org_name',     v_org.name,
        'org_name_ar',  v_org.name_ar,
        'item_name',    ci.name,
        'item_name_ar', ci.name_ar,
        'unit',         ci.unit,
        'availability', (
          select jsonb_agg(jsonb_build_object(
            'point_name',    dp.name,
            'point_name_ar', dp.name_ar,
            -- 059 (PUBLIC-QR-CONCENTRATION-059-A): additive public field,
            -- sourced verbatim from item_availability.concentration (JSON null
            -- when null). Threaded through `derived` like ia_dosage_form below.
            'concentration', derived.ia_concentration,
            -- 058 (PUBLIC-QR-DOSAGE-FORM-IMPLEMENT-A): additive public field,
            -- sourced verbatim from item_availability.dosage_form (JSON null
            -- when null). Threaded through `derived` like ia_quantity below.
            'dosage_form',   derived.ia_dosage_form,
            -- D7 (+ quantity-zero fix): computed condition
            'condition',     derived.effective_condition,
            'expiry_bucket', derived.expiry_bucket,
            -- D2 (preserved + extended)
            'quantity',      case when derived.effective_condition = 'expired'
                               then null
                               else derived.ia_quantity
                             end,
            -- D3 (preserved + extended)
            'expiry_date',   case when derived.effective_condition in ('near_expiry', 'expired')
                               then derived.ia_expiry_date
                               else null
                             end
          ) order by dp.name_ar)
          from (
            select
              -- 059: concentration threaded through so the outer jsonb object
              -- can read it, sourced from item_availability.concentration verbatim.
              ia.concentration                                                     as ia_concentration,
              -- 058: dosage form threaded through so the outer jsonb object can
              -- read it, sourced from item_availability.dosage_form verbatim.
              ia.dosage_form                                                       as ia_dosage_form,
              ia.quantity                                                          as ia_quantity,
              ia.expiry_date                                                       as ia_expiry_date,
              ia.distribution_point_id,
              -- D7 (+ quantity-zero fix): effective_condition
              case
                when ia.expiry_date is not null
                  and ia.expiry_date < current_date
                  then 'expired'
                -- NEW (052): quantity zeroed by a normal quantity movement,
                -- without a matching condition change, is now shown as missing.
                when ia.quantity <= 0
                  then 'missing'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '3 months')::date
                  then 'near_expiry'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '6 months')::date
                  then 'near_expiry'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '9 months')::date
                  then 'near_expiry'
                else ia.condition
              end as effective_condition,
              -- D7: expiry_bucket (unchanged by this migration)
              case
                when ia.expiry_date is not null
                  and ia.expiry_date < current_date
                  then 'expired'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '3 months')::date
                  then '3_months'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '6 months')::date
                  then '6_months'
                when ia.expiry_date is not null
                  and ia.expiry_date <= (current_date + interval '9 months')::date
                  then '9_months'
                else null
              end as expiry_bucket
            from item_availability ia
            where ia.local_item_id = v_target.target_id
          ) derived
          join distribution_points dp on dp.id = derived.distribution_point_id
        )
      )
      into v_payload
      from local_items li
      join central_items ci on ci.id = li.central_item_id
      where li.id = v_target.target_id;

    else
      return jsonb_build_object('ok', false, 'error', 'UNKNOWN_TARGET_TYPE');
  end case;

  return coalesce(v_payload, jsonb_build_object('ok', false, 'error', 'PAYLOAD_BUILD_FAILED'));
end;
$$;

-- Grants: unchanged from migration 003 / 027 / 028 / 052 / 058
revoke all on function get_public_qr_payload(text) from authenticated;
grant execute on function get_public_qr_payload(text) to anon, authenticated;

-- =============================================================================
-- VERIFY
-- =============================================================================

do $$
declare
  v_policy_qual text;
  v_fn_exists   boolean;
  v_fn_def      text;
  v_fn_security boolean;
  v_fn_body     text;
  v_conc_json   int;
  v_conc_src    int;
  v_dosage_json int;
  v_dosage_src  int;
begin
  -- V1: avail_select_anon must remain using (false) — anon has NO direct
  -- item_availability SELECT; the RPC remains the only anon path.
  select qual into v_policy_qual
  from pg_policies
  where schemaname = 'public'
    and tablename  = 'item_availability'
    and policyname = 'avail_select_anon'
    and roles @> array['anon'::name];

  assert v_policy_qual is not null,
    'VERIFY FAILED: avail_select_anon policy not found for anon on item_availability';

  assert v_policy_qual = 'false',
    'VERIFY FAILED: avail_select_anon should remain using (false), got: ' || v_policy_qual;

  -- V2: get_public_qr_payload function must exist
  select exists (
    select 1 from information_schema.routines
    where routine_schema = 'public'
      and routine_name   = 'get_public_qr_payload'
      and routine_type   = 'FUNCTION'
  ) into v_fn_exists;

  assert v_fn_exists,
    'VERIFY FAILED: get_public_qr_payload function missing after migration';

  -- V3: function must still be SECURITY DEFINER
  select p.prosecdef into v_fn_security
  from pg_proc p
  where p.proname = 'get_public_qr_payload';

  assert v_fn_security is true,
    'VERIFY FAILED: get_public_qr_payload is no longer SECURITY DEFINER';

  -- V4: signature unchanged — exactly one function named get_public_qr_payload
  -- taking a single text argument and returning jsonb.
  assert exists (
    select 1 from pg_proc p
    where p.proname = 'get_public_qr_payload'
      and pg_get_function_identity_arguments(p.oid) = 'p_public_id text'
      and pg_get_function_result(p.oid) = 'jsonb'
  ), 'VERIFY FAILED: get_public_qr_payload signature/return type changed (expected (p_public_id text) returns jsonb)';

  -- V5: SET search_path = public preserved (catalog proconfig, not body text)
  assert exists (
    select 1 from pg_proc p
    where p.proname = 'get_public_qr_payload'
      and p.proconfig @> array['search_path=public']
  ), 'VERIFY FAILED: SET search_path = public not present in proconfig';

  -- Full definition (for marker checks) and body only (for destructive checks).
  select pg_get_functiondef(oid) into v_fn_def  from pg_proc where proname = 'get_public_qr_payload';
  select prosrc              into v_fn_body from pg_proc where proname = 'get_public_qr_payload';

  -- V6: SET search_path preserved in definition text too
  assert v_fn_def ilike '%SET search_path%public%',
    'VERIFY FAILED: SET search_path = public not found in RPC definition';

  -- 059: concentration added to the JSON output in EXACTLY the two intended
  -- material branches (distribution_point items[] + local_item availability[]).
  v_conc_json := (length(v_fn_def) - length(replace(v_fn_def, '''concentration'',', ''))) / length('''concentration'',');
  assert v_conc_json = 2,
    'VERIFY FAILED (059): expected exactly 2 ''concentration'' JSON keys (distribution_point + local_item), found ' || v_conc_json;

  -- 059: sourced from item_availability.concentration (threaded as
  -- ia.concentration in each branch's derived subquery) — exactly twice.
  v_conc_src := (length(lower(v_fn_def)) - length(replace(lower(v_fn_def), 'ia.concentration', ''))) / length('ia.concentration');
  assert v_conc_src = 2,
    'VERIFY FAILED (059): expected exactly 2 ia.concentration source references, found ' || v_conc_src;

  -- 058 preserved: dosage_form still present in exactly the same two branches.
  v_dosage_json := (length(v_fn_def) - length(replace(v_fn_def, '''dosage_form'',', ''))) / length('''dosage_form'',');
  assert v_dosage_json = 2,
    'VERIFY FAILED (058 preserved): expected exactly 2 ''dosage_form'' JSON keys (distribution_point + local_item), found ' || v_dosage_json;

  v_dosage_src := (length(lower(v_fn_def)) - length(replace(lower(v_fn_def), 'ia.dosage_form', ''))) / length('ia.dosage_form');
  assert v_dosage_src = 2,
    'VERIFY FAILED (058 preserved): expected exactly 2 ia.dosage_form source references, found ' || v_dosage_src;

  -- D4 (preserved): DISTRIBUTION_POINT_NOT_ACTIVE guard still present
  assert v_fn_def ilike '%DISTRIBUTION_POINT_NOT_ACTIVE%',
    'VERIFY FAILED (D4): DISTRIBUTION_POINT_NOT_ACTIVE guard not found in RPC';

  -- D6: LEFT JOIN must be present (not plain JOIN) in function body
  assert v_fn_def ilike '%left join local_items%',
    'VERIFY FAILED (D6): LEFT JOIN on local_items not found in RPC';

  -- D6: scientific_name fallback present in output
  assert v_fn_def ilike '%scientific_name%',
    'VERIFY FAILED (D6): scientific_name fallback not found in RPC';

  -- D7: effective_condition computed from expiry_date (expired branch)
  assert v_fn_def ilike '%expiry_date < current_date%',
    'VERIFY FAILED (D7): expiry_date < current_date comparison not found in RPC';

  -- D7: expiry_bucket field present in output
  assert v_fn_def ilike '%expiry_bucket%',
    'VERIFY FAILED (D7): expiry_bucket field not found in RPC output';

  -- 052 quantity-zero fix preserved: the branch must appear exactly twice.
  assert (length(lower(v_fn_def)) - length(replace(lower(v_fn_def), 'when ia.quantity <= 0', ''))) / length('when ia.quantity <= 0') = 2,
    'VERIFY FAILED (052 preserved): expected exactly 2 occurrences of the quantity<=0 branch';

  -- Scan bookkeeping preserved
  assert v_fn_def ilike '%last_scanned_at = now()%' and v_fn_def ilike '%scan_count = scan_count + 1%',
    'VERIFY FAILED: scan_count / last_scanned_at update not found in RPC';

  -- Privacy fields still absent from the RPC output
  assert v_fn_def not ilike '%''batch_number''%',
    'VERIFY FAILED (privacy): batch_number found in RPC output — must not be returned';

  assert v_fn_def not ilike '%''price''%',
    'VERIFY FAILED (privacy): price found in RPC output — must not be returned';

  assert v_fn_def not ilike '%''entered_price''%',
    'VERIFY FAILED (privacy): entered_price found in RPC output — must not be returned';

  assert v_fn_def not ilike '%''trade_name''%',
    'VERIFY FAILED (privacy): trade_name found in RPC output — must not be returned';

  assert v_fn_def not ilike '%''notes''%',
    'VERIFY FAILED (privacy): notes found in RPC output — must not be returned';

  assert v_fn_def not ilike '%''supply_type''%',
    'VERIFY FAILED (privacy): supply_type found in RPC output — must not be returned';

  assert v_fn_def not ilike '%''national_code''%',
    'VERIFY FAILED (privacy): national_code found in RPC output — must not be returned';

  assert v_fn_def not ilike '%service_role%',
    'VERIFY FAILED (security): service_role found in RPC body — must not be present';

  assert v_fn_def not ilike '%auth.admin%',
    'VERIFY FAILED (security): auth.admin found in RPC body — must not be present';

  assert v_fn_def not ilike '%actor_name_snapshot%'
     and v_fn_def not ilike '%actor_email_snapshot%',
    'VERIFY FAILED (privacy): actor snapshot field found in RPC — must not be returned';

  -- Destructive-keyword check against the function BODY only (prosrc), so
  -- descriptive words in the header comment cannot trip it.
  assert v_fn_body !~* '\mdrop\s+table\M'
     and v_fn_body !~* '\mtruncate\M'
     and v_fn_body !~* '\mdelete\s+from\M',
    'VERIFY FAILED (safety): destructive statement found in RPC body';

  -- Still references the expected tables/objects — no scoping regression
  assert v_fn_def ilike '%qr_tokens%' and v_fn_def ilike '%qr_targets%',
    'VERIFY FAILED: qr_tokens/qr_targets resolution missing from RPC';

  assert v_fn_def ilike '%item_availability%',
    'VERIFY FAILED: item_availability reference missing from RPC';

  -- V7: grants unchanged — anon + authenticated EXECUTE both present.
  assert exists (
    select 1 from information_schema.routine_privileges
    where routine_schema = 'public'
      and routine_name   = 'get_public_qr_payload'
      and grantee        = 'anon'
      and privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: anon lost EXECUTE on get_public_qr_payload';

  assert exists (
    select 1 from information_schema.routine_privileges
    where routine_schema = 'public'
      and routine_name   = 'get_public_qr_payload'
      and grantee        = 'authenticated'
      and privilege_type = 'EXECUTE'
  ), 'VERIFY FAILED: authenticated lost EXECUTE on get_public_qr_payload';

  raise notice 'Migration 059 verification passed: get_public_qr_payload now additively returns concentration (from item_availability.concentration) in the distribution_point and local_item material objects only. Migration 058 dosage_form preserved in both branches. Signature, return type, SECURITY DEFINER, SET search_path, grants, anon RLS (avail_select_anon = false), scan bookkeeping, D4/D6/D7 and the 052 quantity<=0 rule all preserved; no private field added, no destructive/schema/RLS change.';
end $$;

commit;

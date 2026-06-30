-- =============================================================================
-- MediStock Phoenix V2 — Migration 028: Public QR Expiry & Scientific-Name Fix
-- =============================================================================
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard → SQL Editor after reading this file in full.
-- Apply ONLY after migration 027 is confirmed applied and healthy.
--
-- Prerequisites: Migrations 001–027 must already be applied.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DEFECTS FIXED
-- ─────────────────────────────────────────────────────────────────────────────
--
-- D6 [FUNCTIONAL GAP] — Scientific-name-only items invisible on public QR
--   Migration 019 (availability editor) made item_availability.local_item_id
--   nullable to support a new editor path that uses scientific_name as the
--   upsert key instead of local_item_id. Rows entered via this path have
--   local_item_id = NULL and scientific_name populated.
--   The distribution_point branch of get_public_qr_payload (migrations 003,
--   027) joins item_availability to local_items and central_items using INNER
--   JOINs. Rows where local_item_id IS NULL are excluded, making any
--   scientific-name-only item invisible on the public QR scan result.
--   Fix: replace INNER JOINs with LEFT JOINs; use COALESCE to produce a
--   public-safe display name from central item names → scientific_name →
--   safe fallback. Only name, unit are derived from the fallback path.
--   Unsafe fields (trade_name, dosage_form, concentration, price, notes,
--   batch_number, supply_type) are NOT included in the public output.
--
-- D7 [DATA INTEGRITY] — Expiry state based on manual condition, not expiry_date
--   The existing RPC returns ia.condition directly as the public item condition.
--   condition is manually set by operators. A material may have
--   condition = 'available' while its expiry_date is within 9, 6, or 3 months,
--   or even already expired. The public QR would then display it as 'available'
--   with no warning, which is medically misleading.
--   Fix: compute an effective_condition from expiry_date using date-only
--   arithmetic (no timezone ambiguity). If expiry_date is set and triggers a
--   threshold, the effective_condition overrides the manual ia.condition:
--     • expiry_date <  current_date                → 'expired'
--     • expiry_date <= current_date + 3 months     → 'near_expiry' (3_months)
--     • expiry_date <= current_date + 6 months     → 'near_expiry' (6_months)
--     • expiry_date <= current_date + 9 months     → 'near_expiry' (9_months)
--     • expiry_date >  current_date + 9 months     → use ia.condition unchanged
--     • expiry_date IS NULL                        → use ia.condition unchanged
--   A new expiry_bucket field is returned so the frontend can show the exact
--   9 / 6 / 3 / expired threshold badge without additional computation.
--   D2 (expired → quantity null) and D3 (expiry_date guarded) from migration 027
--   are preserved and extended to use effective_condition instead of ia.condition.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS NOT CHANGED
-- ─────────────────────────────────────────────────────────────────────────────
--   • D1 (avail_select_anon using false) from migration 027 is fully preserved.
--   • D4 (distribution_point status = 'active' guard) is fully preserved.
--   • Token resolution, scan counter, org resolution, grants: unchanged.
--   • warehouse branch: unchanged (shows only item_count, no item details).
--   • All RLS policies on item_availability: unchanged.
--   • No new tables, columns, or indexes.
--   • No DROP TABLE, DROP COLUMN, TRUNCATE, destructive DELETE, unsafe CASCADE.
--   • No auth.users writes. No elevated-credential exposure. No anon write.
--   • No DELETE grant. No broad grants. No service_role exposure.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SAFETY GUARANTEES
-- ─────────────────────────────────────────────────────────────────────────────
--   • Public output does NOT include: actor_name_snapshot, actor_email_snapshot,
--     token_hash, batch_number, price, notes, trade_name, dosage_form,
--     concentration, supply_type, last_updated_by, or any auth user identifier.
--   • Expired items still show quantity = null (D2 preserved, using effective_condition).
--   • expiry_date still only returned for near_expiry / expired (D3 preserved,
--     using effective_condition so auto-computed near_expiry also returns date).
--   • scientific_name is used only as a display name fallback. It is a
--     pharmacological name (e.g. "Amoxicillin") intended for clinical use;
--     it is not an internal identifier or sensitive operational field.
--   • All changes are idempotent: CREATE OR REPLACE FUNCTION. Safe to re-run.
-- =============================================================================

begin;

-- =============================================================================
-- FIX D6 + D7: Replace get_public_qr_payload with hardened version
-- =============================================================================
-- Changes from migration 027:
--   distribution_point branch:
--     • INNER JOIN local_items → LEFT JOIN (D6: include scientific_name rows)
--     • INNER JOIN central_items → LEFT JOIN (D6: same)
--     • Name columns use COALESCE: ci.name/name_ar → ia.scientific_name → fallback (D6)
--     • Derived subquery computes effective_condition and expiry_bucket (D7)
--     • D2/D3 guards now use effective_condition instead of ia.condition (D7 extension)
--   local_item branch:
--     • Derived subquery computes effective_condition and expiry_bucket (D7)
--     • D2/D3 guards now use effective_condition instead of ia.condition (D7 extension)
--   warehouse branch: unchanged
--   Everything else: unchanged

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
            -- D7: computed condition (overrides manual ia.condition when expiry triggers)
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
              ia.quantity                                                                   as ia_quantity,
              ia.expiry_date                                                                as ia_expiry_date,
              -- D7: effective_condition overrides ia.condition when expiry_date triggers threshold
              case
                when ia.expiry_date is not null
                  and ia.expiry_date < current_date
                  then 'expired'
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
      -- warehouse branch: unchanged from migration 027
      -- Only shows point-level item_count; no individual item details to guard.
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
            -- D7: computed condition
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
              ia.quantity                                                          as ia_quantity,
              ia.expiry_date                                                       as ia_expiry_date,
              ia.distribution_point_id,
              -- D7: effective_condition
              case
                when ia.expiry_date is not null
                  and ia.expiry_date < current_date
                  then 'expired'
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
              -- D7: expiry_bucket
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

-- Grants: unchanged from migration 003 / 027
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
begin
  -- V1 (D1 preserved): avail_select_anon must remain using (false)
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

  -- V3: inspect function body for all required markers
  select pg_get_functiondef(oid) into v_fn_def
  from pg_proc where proname = 'get_public_qr_payload';

  -- D4 (preserved): DISTRIBUTION_POINT_NOT_ACTIVE guard still present
  assert v_fn_def ilike '%DISTRIBUTION_POINT_NOT_ACTIVE%',
    'VERIFY FAILED (D4): DISTRIBUTION_POINT_NOT_ACTIVE guard not found in RPC';

  -- D6: LEFT JOIN must be present (not plain JOIN) in function body
  assert v_fn_def ilike '%left join local_items%',
    'VERIFY FAILED (D6): LEFT JOIN on local_items not found in RPC';

  -- D6: scientific_name fallback present in output
  assert v_fn_def ilike '%scientific_name%',
    'VERIFY FAILED (D6): scientific_name fallback not found in RPC';

  -- D6: public-safe fallback name present
  assert v_fn_def ilike '%Unnamed material%',
    'VERIFY FAILED (D6): Unnamed material fallback not found in RPC';

  -- D7: effective_condition computed from expiry_date (expired branch)
  assert v_fn_def ilike '%expiry_date < current_date%',
    'VERIFY FAILED (D7): expiry_date < current_date comparison not found in RPC';

  -- D7: 9-month threshold present
  assert v_fn_def ilike '%interval ''9 months''%',
    'VERIFY FAILED (D7): 9-month interval threshold not found in RPC';

  -- D7: 6-month threshold present
  assert v_fn_def ilike '%interval ''6 months''%',
    'VERIFY FAILED (D7): 6-month interval threshold not found in RPC';

  -- D7: 3-month threshold present
  assert v_fn_def ilike '%interval ''3 months''%',
    'VERIFY FAILED (D7): 3-month interval threshold not found in RPC';

  -- D7: expiry_bucket field present in output
  assert v_fn_def ilike '%expiry_bucket%',
    'VERIFY FAILED (D7): expiry_bucket field not found in RPC output';

  -- D7: expired forces quantity null (using effective_condition)
  assert v_fn_def ilike '%effective_condition = ''expired''%',
    'VERIFY FAILED (D7): effective_condition guard for expired not found in RPC';

  -- D7: near_expiry/expired returns expiry_date
  assert v_fn_def ilike '%effective_condition in (''near_expiry'', ''expired'')%',
    'VERIFY FAILED (D7): effective_condition in (near_expiry, expired) guard not found in RPC';

  -- Privacy: unsafe fields absent from function body
  assert v_fn_def not ilike '%''batch_number''%',
    'VERIFY FAILED (privacy): batch_number found in RPC output — must not be returned';

  assert v_fn_def not ilike '%''price''%',
    'VERIFY FAILED (privacy): price found in RPC output — must not be returned';

  assert v_fn_def not ilike '%''trade_name''%',
    'VERIFY FAILED (privacy): trade_name found in RPC output — must not be returned';

  assert v_fn_def not ilike '%''notes''%',
    'VERIFY FAILED (privacy): notes found in RPC output — must not be returned';

  assert v_fn_def not ilike '%''supply_type''%',
    'VERIFY FAILED (privacy): supply_type found in RPC output — must not be returned';

  assert v_fn_def not ilike '%service_role%',
    'VERIFY FAILED (security): service_role found in RPC body — must not be present';

  assert v_fn_def not ilike '%actor_name_snapshot%',
    'VERIFY FAILED (privacy): actor_name_snapshot found in RPC — must not be returned';

  assert v_fn_def not ilike '%actor_email_snapshot%',
    'VERIFY FAILED (privacy): actor_email_snapshot found in RPC — must not be returned';

  raise notice 'Migration 028 verification passed: D1 preserved (anon direct access denied), D4 preserved (dp status check), D6 fixed (LEFT JOIN + scientific_name fallback), D7 fixed (effective_condition from expiry_date, expiry_bucket, 9/6/3 months, expired → quantity null) — all verified.';
end $$;

commit;

-- =============================================================================
-- POST-APPLY MANUAL VERIFICATION (run in Supabase SQL Editor)
-- =============================================================================
--
-- 1. Confirm avail_select_anon is still using (false):
--    SELECT policyname, cmd, qual, roles
--    FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'item_availability'
--    ORDER BY policyname;
--    Expected: avail_select_anon | SELECT | false | {anon}
--
-- 2. Confirm function grants unchanged:
--    SELECT grantee, privilege_type
--    FROM information_schema.routine_privileges
--    WHERE routine_schema = 'public' AND routine_name = 'get_public_qr_payload';
--    Expected rows: anon | EXECUTE, authenticated | EXECUTE
--
-- 3. D6 smoke: scan a QR for a distribution point that has scientific_name-only
--    rows (local_item_id = NULL). Confirm items now appear in payload.
--    SELECT get_public_qr_payload('<public_id>');
--    Look for items with name = scientific_name value (not 'Unnamed material').
--
-- 4. D7 smoke: scan a QR for a distribution point that has a row with
--    condition = 'available' but expiry_date within 3 months.
--    Confirm payload shows condition = 'near_expiry' and expiry_bucket = '3_months'.
--    SELECT get_public_qr_payload('<public_id>');
--
-- 5. D7 smoke: scan a QR for a row with condition = 'available' but
--    expiry_date < current_date.
--    Confirm payload shows condition = 'expired', quantity = null.
--
-- 6. D7 smoke: scan a QR for a row with expiry_date > current_date + 9 months.
--    Confirm payload shows condition from ia.condition (unmodified), expiry_bucket = null,
--    and expiry_date = null (D3: not returned for non-expiry conditions).
--
-- 7. D7 smoke: scan a QR for a row with expiry_date = null.
--    Confirm condition = ia.condition, expiry_bucket = null.
--
-- 8. Disabled QR still blocked:
--    SELECT get_public_qr_payload('<disabled_public_id>');
--    Expected: {"ok": false, "error": "QR_NOT_FOUND_OR_DISABLED"}
--
-- 9. Archived/inactive distribution point still blocked:
--    SELECT get_public_qr_payload('<public_id_for_archived_dp>');
--    Expected: {"ok": false, "error": "DISTRIBUTION_POINT_NOT_ACTIVE"}
--
-- =============================================================================
-- END OF MIGRATION 028
-- MEDISTOCK_PHOENIX_PUBLIC_QR_D6_D7_V1
-- =============================================================================

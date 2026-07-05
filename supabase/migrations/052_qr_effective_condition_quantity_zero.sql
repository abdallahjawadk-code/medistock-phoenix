-- =============================================================================
-- MediStock Phoenix V2 — Migration 052: QR Effective Condition Quantity-Zero Fix
-- =============================================================================
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard → SQL Editor after reading this file in full.
-- Apply ONLY after migration 051 is confirmed applied and healthy.
--
-- Prerequisites: Migrations 001–051 must already be applied.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- BUG (found by QR-AVAILABILITY-REMOVAL-CONSISTENCY-A)
-- ─────────────────────────────────────────────────────────────────────────────
--   The public QR payload is generated live by get_public_qr_payload (latest
--   definition: migration 028). Its effective_condition CASE overrides the
--   manually-stored ia.condition only when expiry_date crosses a threshold —
--   it never looks at ia.quantity.
--
--   The dedicated "remove from outlet" paths (single-item remove in
--   InstitutionScreen.tsx, and clear_port_availability / migration 042) both
--   set quantity = 0 AND condition = 'missing' together, so those are already
--   correctly hidden from "available" on the public QR page.
--
--   However, the ordinary quantity-movement RPC
--   (phoenix_apply_availability_movement, migration 034 — used by
--   AdjustQuantityModal for set_exact / add / subtract / correction) can
--   independently bring ia.quantity down to exactly 0 WITHOUT touching
--   ia.condition. phoenix_upsert_availability (migration 035) hard-guards
--   quantity out of its own UPDATE path specifically so quantity only ever
--   changes through the movement RPC — confirming this is a real, reachable
--   path, and that it never touches condition.
--
--   Result: a row with quantity = 0, condition = 'available' (or any
--   non-'missing' condition) is returned by get_public_qr_payload with
--   effective_condition = 'available', so the public QR page renders it as
--   "Available: 0 units" — a zero-stock item shown to the public as in stock.
--
--   Note: the frontend already fixed the equivalent problem for internal
--   screens — withEffectiveAvailabilityStatus() in
--   src/shared/supabase/services/availability.service.ts derives
--   effective_status = 'missing' when quantity <= 0 for getAvailabilityByPoint
--   / getLowStockItems / getAvailabilityByOrg. That JS-side fix cannot reach
--   the public QR page because the payload is built entirely inside this SQL
--   function — this migration ports the same rule into the RPC.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- FIX
-- ─────────────────────────────────────────────────────────────────────────────
--   Treat ia.quantity <= 0 as 'missing' in get_public_qr_payload's
--   effective_condition CASE, in BOTH branches that compute it
--   (distribution_point and local_item — the only two branches with item-level
--   effective_condition; the warehouse branch only returns item_count and has
--   no effective_condition to fix).
--
--   New precedence (matches computeEffectiveStatus in
--   src/shared/lib/status/canonical.ts):
--     1. expiry_date <  current_date                → 'expired'
--     2. ia.quantity <= 0                            → 'missing'   (NEW)
--     3. expiry_date <= current_date + 3 months     → 'near_expiry' (3_months)
--     4. expiry_date <= current_date + 6 months     → 'near_expiry' (6_months)
--     5. expiry_date <= current_date + 9 months     → 'near_expiry' (9_months)
--     6. otherwise                                   → ia.condition unchanged
--
--   expiry_bucket is NOT changed by this migration — it remains purely
--   expiry-driven (a quantity-zero row with a healthy expiry date still gets
--   expiry_bucket = null; the frontend already renders 'missing' condition
--   with an 'err' badge regardless of expiry_bucket).
--
--   D2 (expired → quantity null) and D3 (expiry_date only for
--   near_expiry/expired) already key off effective_condition, so they need no
--   changes — a quantity<=0 row now gets effective_condition = 'missing',
--   which is outside both of those guards, so its (already-zero) quantity and
--   its expiry_date (if any) continue to pass through unchanged.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS NOT CHANGED
-- ─────────────────────────────────────────────────────────────────────────────
--   • Function signature: get_public_qr_payload(p_public_id text) returns jsonb — unchanged.
--   • SECURITY DEFINER / SET search_path = public — unchanged.
--   • Grants: unchanged (revoke from authenticated, grant execute to anon + authenticated).
--   • Token resolution, scan counter, org resolution: unchanged.
--   • warehouse branch: unchanged (no effective_condition there).
--   • D1 (avail_select_anon using false), D4 (distribution_point status guard),
--     D6 (LEFT JOIN + scientific_name fallback): unchanged, fully preserved.
--   • expiry_bucket computation: unchanged.
--   • No table/column/index changes. No RLS/policy changes. No new grants.
--   • No data mutation — this migration only replaces a function definition.
--   • No DROP TABLE, DROP COLUMN, TRUNCATE, destructive DELETE, unsafe CASCADE.
--   • No service_role exposure. No auth.admin usage.
--   • All changes are idempotent: CREATE OR REPLACE FUNCTION. Safe to re-run.
-- =============================================================================

begin;

-- =============================================================================
-- FIX: Replace get_public_qr_payload — add quantity<=0 -> 'missing' branch
-- =============================================================================
-- Body is otherwise byte-for-byte identical to migration 028's definition.
-- Only the effective_condition CASE in the distribution_point and local_item
-- branches gained one new WHEN clause each (marked "NEW" below).

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
      -- warehouse branch: unchanged from migration 027/028 — this branch
      -- only returns point-level item_count, with no per-item condition
      -- field of any kind, so it needs no change in this migration.
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

-- Grants: unchanged from migration 003 / 027 / 028
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
  v_fn_security text;
begin
  -- V1: avail_select_anon must remain using (false) — unchanged by this migration
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

  assert v_fn_security::text = 'true',
    'VERIFY FAILED: get_public_qr_payload is no longer SECURITY DEFINER';

  -- V4: inspect function body for all required markers
  select pg_get_functiondef(oid) into v_fn_def
  from pg_proc where proname = 'get_public_qr_payload';

  -- SET search_path preserved
  assert v_fn_def ilike '%SET search_path%public%',
    'VERIFY FAILED: SET search_path = public not found in RPC';

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

  -- QUANTITY-ZERO FIX: the new branch must be present
  assert v_fn_def ilike '%ia.quantity <= 0%',
    'VERIFY FAILED (052): ia.quantity <= 0 branch not found in RPC';

  -- QUANTITY-ZERO FIX: it must map to 'missing'
  assert v_fn_def ilike '%when ia.quantity <= 0%then ''missing''%'
      or v_fn_def ~* 'when ia\.quantity <= 0\s*\n\s*then ''missing''',
    'VERIFY FAILED (052): ia.quantity <= 0 does not map to ''missing''';

  -- QUANTITY-ZERO FIX: the new branch must appear exactly twice — once in
  -- the distribution_point branch's derived subquery, once in the
  -- local_item branch's derived subquery. The warehouse branch has no
  -- effective_condition and must not gain one.
  assert (length(v_fn_def) - length(replace(lower(v_fn_def), 'when ia.quantity <= 0', ''))) / length('when ia.quantity <= 0') = 2,
    'VERIFY FAILED (052): expected exactly 2 occurrences of the new quantity<=0 branch (distribution_point + local_item), found a different count';

  -- Privacy fields still absent
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

  assert v_fn_def not ilike '%auth.admin%',
    'VERIFY FAILED (security): auth.admin found in RPC body — must not be present';

  assert v_fn_def not ilike '%whatsapp%'
     and v_fn_def not ilike '%graph.facebook%'
     and v_fn_def not ilike '%bearer%',
    'VERIFY FAILED: WhatsApp/Graph API/Bearer token reference found in RPC body — must not be present';

  assert v_fn_def not ilike '%actor_name_snapshot%',
    'VERIFY FAILED (privacy): actor_name_snapshot found in RPC — must not be returned';

  assert v_fn_def not ilike '%actor_email_snapshot%',
    'VERIFY FAILED (privacy): actor_email_snapshot found in RPC — must not be returned';

  -- Still references the expected tables/objects — no scoping regression
  assert v_fn_def ilike '%qr_tokens%' and v_fn_def ilike '%qr_targets%',
    'VERIFY FAILED: qr_tokens/qr_targets resolution missing from RPC';

  assert v_fn_def ilike '%item_availability%',
    'VERIFY FAILED: item_availability reference missing from RPC';

  -- V5: grants unchanged
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

  raise notice 'Migration 052 verification passed: get_public_qr_payload now treats ia.quantity <= 0 as effective_condition = ''missing'' in both the distribution_point and local_item branches, in addition to the existing expiry-based overrides (D7). Signature, SECURITY DEFINER, SET search_path, grants, D1/D4/D6 guarantees all preserved.';
end $$;

commit;

-- =============================================================================
-- POST-APPLY MANUAL VERIFICATION (run in Supabase SQL Editor)
-- =============================================================================
--
-- 1. Confirm function grants unchanged:
--    SELECT grantee, privilege_type
--    FROM information_schema.routine_privileges
--    WHERE routine_schema = 'public' AND routine_name = 'get_public_qr_payload';
--    Expected rows: anon | EXECUTE, authenticated | EXECUTE
--
-- 2. Quantity-zero smoke test: scan a QR for a distribution point that has a
--    row with condition = 'available' but quantity = 0 (reachable via the
--    normal quantity-movement / AdjustQuantityModal flow, NOT the dedicated
--    "remove from outlet" action).
--    SELECT get_public_qr_payload('<public_id>');
--    Expected: that item's "condition" is now "missing" (not "available"),
--    and its "quantity" field is still 0 (unchanged — only 'expired' nulls
--    quantity, per D2).
--
-- 3. Regression: a healthy row (quantity > 0, condition = 'available',
--    expiry_date far in the future) still returns condition = 'available'.
--
-- 4. Regression: an already-'missing' row (from clear_port_availability or
--    single-item remove) still returns condition = 'missing' as before.
--
-- 5. Regression: an expired row (expiry_date < current_date) still returns
--    condition = 'expired' and quantity = null, regardless of its stored
--    quantity value — the expired branch is checked before the new
--    quantity<=0 branch, so precedence is unchanged for expired rows.
--
-- 6. Regression: a near-expiry row with quantity > 0 still returns
--    condition = 'near_expiry' with the correct expiry_bucket.
--
-- 7. Disabled QR still blocked:
--    SELECT get_public_qr_payload('<disabled_public_id>');
--    Expected: {"ok": false, "error": "QR_NOT_FOUND_OR_DISABLED"}
--
-- 8. Archived/inactive distribution point still blocked:
--    SELECT get_public_qr_payload('<public_id_for_archived_dp>');
--    Expected: {"ok": false, "error": "DISTRIBUTION_POINT_NOT_ACTIVE"}
--
-- =============================================================================
-- END OF MIGRATION 052
-- QR-EFFECTIVE-CONDITION-QUANTITY-ZERO-052-A
-- =============================================================================

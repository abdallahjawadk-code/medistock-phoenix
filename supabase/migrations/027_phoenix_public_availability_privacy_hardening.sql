-- =============================================================================
-- MediStock Phoenix V2 — Migration 027: Public Availability Privacy Hardening
-- =============================================================================
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard → SQL Editor after reading this file in full.
--
-- Prerequisites: Migrations 001–026 must already be applied.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DEFECTS FIXED
-- ─────────────────────────────────────────────────────────────────────────────
--
-- D1 [CRITICAL] — avail_select_anon policy is `using (true)`
--   The RLS policy on item_availability for the anon role uses `using (true)`,
--   granting unrestricted direct SELECT on every column of every row across all
--   organisations. Exposed fields include: actor_name_snapshot (staff full name),
--   actor_email_snapshot (staff email), price, batch_number, notes,
--   scientific_name, trade_name, dosage_form, concentration, supply_type,
--   organization_id, distribution_point_id, last_updated_by (auth user UUID),
--   and all actor-identity-snapshot columns added by migrations 013–014.
--   The public QR flow does not query item_availability directly — it goes
--   exclusively through the SECURITY DEFINER RPC get_public_qr_payload(), which
--   runs as the function owner and therefore bypasses RLS entirely. Restricting
--   the anon policy does NOT break public QR scan results.
--   Fix: replace using (true) with using (false). All direct anon reads are
--   denied. The SECURITY DEFINER RPC continues to work as before.
--   Documented as a "residual gap" in migration 019 (lines 69–83).
--
-- D2 [HIGH] — get_public_qr_payload returns non-null quantity for expired items
--   The RPC (migration 003) returns ia.quantity for all conditions. The frontend
--   (PublicQrScreen.tsx) hides this with `variant !== 'err'`, but a direct API
--   caller sees the raw JSON. A non-zero quantity on an expired drug implies it
--   is usable stock and is medically misleading.
--   Fix: null out quantity when ia.condition = 'expired' in all three
--   target-type branches.
--
-- D3 [MEDIUM] — get_public_qr_payload returns expiry_date for all conditions
--   The RPC returns ia.expiry_date regardless of condition. The frontend only
--   renders it for near_expiry / expired items, but raw callers see internal
--   procurement expiry dates for available, surplus, and low_stock items.
--   Fix: return expiry_date only when condition IN ('near_expiry', 'expired');
--   otherwise return null.
--
-- D4 [MEDIUM] — distribution_point branch has no status = 'active' guard
--   archive_entity() for a distribution_point (migration 003) sets
--   status = 'archived' but does NOT disable the QR token. If a token stays
--   active after archiving, the public QR scan returns item data for a retired
--   point. The warehouse branch already filters sub-points by
--   dp.status = 'active'; the distribution_point branch did not.
--   Fix: explicit check before payload build; returns
--   DISTRIBUTION_POINT_NOT_ACTIVE if the point is not active.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- DEFECTS DOCUMENTED BUT NOT FIXED HERE (see audit doc)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- D5: qrtk_select_anon allows enumeration of all active QR public_ids without
--     pagination restriction. Risk: low (public_ids are embedded in physical QR
--     codes by design; enumeration yields no data beyond what a scanner sees).
--     Addressed in audit doc; separate migration if policy decides to restrict.
--
-- D6: The distribution_point branch of the RPC inner-joins local_items, so
--     items entered via the new AvailabilityEditor (scientific_name path,
--     local_item_id = NULL, added by migrations 019–020) are invisible on
--     the public QR page. This is a functional gap, not a privacy concern.
--     Separate migration scope.
--
-- D7: near_expiry is manually assigned, not auto-computed from expiry_date.
--     An admin may fail to mark an item as near_expiry even though its
--     expiry_date is within the warning window. Pre-existing design gap;
--     separate migration scope.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SAFETY GUARANTEES
-- ─────────────────────────────────────────────────────────────────────────────
--   - No DROP TABLE, DROP COLUMN, TRUNCATE, destructive DELETE, unsafe CASCADE.
--   - No auth.users writes. No elevated-credential exposure. No anon write. No DELETE
--     grant. No broad grants.
--   - No new tables, columns, or indexes.
--   - Does NOT weaken any existing authenticated-user RLS policy.
--   - Does NOT break any authenticated-user screen or service.
--   - Does NOT touch the intake, OCR, Excel, DocIntel, or data-reset paths.
--   - All changes are idempotent: DROP POLICY IF EXISTS → CREATE POLICY;
--     CREATE OR REPLACE FUNCTION. Safe to re-run.
--   - Preserves all valid public QR access for active tokens pointing to
--     active distribution points, active warehouses, and active local items.
--   - Scan counter (last_scanned_at, scan_count) still updates on each scan.
-- =============================================================================

begin;

-- =============================================================================
-- FIX D1: Restrict avail_select_anon — deny direct anon table access
-- =============================================================================
-- The SECURITY DEFINER RPC bypasses RLS; restricting the anon policy here does
-- NOT affect QR scan results served through get_public_qr_payload().

drop policy if exists "avail_select_anon" on item_availability;

create policy "avail_select_anon" on item_availability
  for select to anon
  using (false);
-- Anon role MUST go through the get_public_qr_payload() SECURITY DEFINER RPC.
-- Direct anon SELECT on this table is now denied at RLS level.

-- =============================================================================
-- FIX D2 + D3 + D4: Harden get_public_qr_payload RPC
-- =============================================================================
-- Structural changes from the migration 003 original:
--   distribution_point branch: added status = 'active' guard before payload build (D4)
--   All item-level aggregations: quantity null for expired (D2)
--   All item-level aggregations: expiry_date returned only for near_expiry/expired (D3)
-- Everything else (token resolution, scan counter, org resolution, grants) unchanged.

create or replace function get_public_qr_payload(p_public_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token     qr_tokens%rowtype;
  v_target    qr_targets%rowtype;
  v_org       organizations%rowtype;
  v_payload   jsonb;
begin
  -- resolve token
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

  -- resolve target
  select * into v_target from qr_targets where id = v_token.qr_target_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND');
  end if;

  -- resolve org
  select * into v_org from organizations where id = v_target.organization_id;

  -- record scan (unchanged)
  update qr_tokens
  set last_scanned_at = now(), scan_count = scan_count + 1
  where id = v_token.id;

  -- build payload based on target type
  case v_target.target_type

    when 'distribution_point' then
      -- D4: reject archived/inactive distribution points
      -- archive_entity() does not automatically disable the QR token, so an
      -- active token may point at a non-active point after archiving.
      if not exists (
        select 1 from distribution_points
        where id = v_target.target_id and status = 'active'
      ) then
        return jsonb_build_object('ok', false, 'error', 'DISTRIBUTION_POINT_NOT_ACTIVE');
      end if;

      select jsonb_build_object(
        'ok',           true,
        'target_type',  'distribution_point',
        'org_name',     v_org.name,
        'org_name_ar',  v_org.name_ar,
        'point_label',  coalesce(v_target.label, dp.name),
        'items', (
          select jsonb_agg(jsonb_build_object(
            'name',       ci.name,
            'name_ar',    ci.name_ar,
            'condition',  ia.condition,
            -- D2: null quantity for expired — non-zero count on expired drug is misleading
            'quantity',   case when ia.condition = 'expired' then null else ia.quantity end,
            'unit',       ci.unit,
            -- D3: expiry_date only for near_expiry / expired — internal dates not public
            'expiry_date', case when ia.condition in ('near_expiry', 'expired') then ia.expiry_date else null end
          ) order by ci.name_ar)
          from item_availability ia
          join local_items li on li.id = ia.local_item_id
          join central_items ci on ci.id = li.central_item_id
          where ia.distribution_point_id = v_target.target_id
        )
      )
      into v_payload
      from distribution_points dp
      where dp.id = v_target.target_id;

    when 'warehouse' then
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
            'condition',     ia.condition,
            -- D2: null quantity for expired
            'quantity',      case when ia.condition = 'expired' then null else ia.quantity end,
            -- D3: expiry_date only for near_expiry / expired
            'expiry_date',   case when ia.condition in ('near_expiry', 'expired') then ia.expiry_date else null end
          ) order by dp.name_ar)
          from item_availability ia
          join distribution_points dp on dp.id = ia.distribution_point_id
          where ia.local_item_id = v_target.target_id
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

-- Grants: unchanged from migration 003
revoke all on function get_public_qr_payload(text) from authenticated;
grant execute on function get_public_qr_payload(text) to anon, authenticated;

-- =============================================================================
-- VERIFY
-- =============================================================================

do $$
declare
  v_policy_qual   text;
  v_fn_exists     boolean;
  v_fn_def        text;
begin
  -- V1: avail_select_anon must exist for anon role with qual = 'false'
  select qual into v_policy_qual
  from pg_policies
  where schemaname = 'public'
    and tablename  = 'item_availability'
    and policyname = 'avail_select_anon'
    and roles @> array['anon'::name];

  assert v_policy_qual is not null,
    'VERIFY FAILED (D1): avail_select_anon policy not found for anon on item_availability';

  assert v_policy_qual = 'false',
    'VERIFY FAILED (D1): avail_select_anon should be using (false), got: ' || v_policy_qual;

  -- V2: get_public_qr_payload function must still exist
  select exists (
    select 1 from information_schema.routines
    where routine_schema = 'public'
      and routine_name   = 'get_public_qr_payload'
      and routine_type   = 'FUNCTION'
  ) into v_fn_exists;

  assert v_fn_exists,
    'VERIFY FAILED: get_public_qr_payload function missing after migration';

  -- V3–V5: inspect function body for the three RPC fixes
  select pg_get_functiondef(oid) into v_fn_def
  from pg_proc where proname = 'get_public_qr_payload';

  assert v_fn_def ilike '%DISTRIBUTION_POINT_NOT_ACTIVE%',
    'VERIFY FAILED (D4): DISTRIBUTION_POINT_NOT_ACTIVE guard not found in RPC';

  assert v_fn_def ilike '%condition = ''expired'' then null%',
    'VERIFY FAILED (D2): null quantity for expired not found in RPC';

  assert v_fn_def ilike '%near_expiry%expired%then ia.expiry_date%',
    'VERIFY FAILED (D3): expiry_date guard for near_expiry/expired not found in RPC';

  raise notice 'Migration 027 verification passed: D1 (anon direct access denied), D2 (expired quantity null), D3 (expiry_date guarded), D4 (dp status check) — all verified.';
end $$;

commit;

-- =============================================================================
-- POST-APPLY MANUAL VERIFICATION (run in Supabase SQL Editor)
-- =============================================================================
--
-- 1. Confirm avail_select_anon is now using (false):
--    SELECT policyname, cmd, qual, roles
--    FROM pg_policies
--    WHERE schemaname = 'public' AND tablename = 'item_availability'
--    ORDER BY policyname;
--    Expected: avail_select_anon | SELECT | false | {anon}
--
-- 2. Confirm function grants are unchanged:
--    SELECT grantee, privilege_type
--    FROM information_schema.routine_privileges
--    WHERE routine_schema = 'public' AND routine_name = 'get_public_qr_payload';
--    Expected rows: anon | EXECUTE, authenticated | EXECUTE
--
-- 3. Functional smoke test (scan a real QR code and confirm items still appear).
--
-- 4. Verify direct anon table access is now denied:
--    SET LOCAL ROLE anon;
--    SELECT count(*) FROM item_availability;   -- expect: 0 rows (RLS blocks)
--    RESET ROLE;
--
-- 5. Verify expired quantity is null in QR payload:
--    SELECT get_public_qr_payload('<public_id_of_a_point_with_expired_items>');
--    Expect: items with condition='expired' have "quantity": null
--
-- =============================================================================
-- END OF MIGRATION 027
-- MEDISTOCK_PHOENIX_PUBLIC_QR_PRIVACY_V1
-- =============================================================================

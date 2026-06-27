-- =============================================================================
-- MediStock Phoenix V2 — Migration 003: RPC Lifecycle
-- Apply AFTER 002_phoenix_rls_policies.sql.
-- Apply manually via Supabase SQL Editor after review.
--
-- RPCs:
--   1. get_public_qr_payload      — anon-safe QR scan result
--   2. create_qr_for_target       — create QR for allowlisted entity types
--   3. disable_qr_token           — disable a QR token (never deletes parent)
--   4. archive_entity             — soft-archive allowlisted entity
--   5. get_entity_purge_impact    — preview before purge (read-only)
--   6. purge_entity_with_all_data — safe purge: QR-first, parent-last, allowlist-only
--
-- Allowlist for archive/purge: warehouse | distribution_point | local_item
-- QR-only actions NEVER touch parent entity.
-- =============================================================================

-- =============================================================================
-- 1. GET_PUBLIC_QR_PAYLOAD
--    Called by anon after scanning a QR code.
--    Returns item availability list for the scanned target.
--    Revokes itself if token is disabled.
-- =============================================================================
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

  -- record scan
  update qr_tokens
  set last_scanned_at = now(), scan_count = scan_count + 1
  where id = v_token.id;

  -- build payload based on target type
  case v_target.target_type
    when 'distribution_point' then
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
            'quantity',   ia.quantity,
            'unit',       ci.unit,
            'expiry_date', ia.expiry_date
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
        'ok',           true,
        'target_type',  'warehouse',
        'org_name',     v_org.name,
        'org_name_ar',  v_org.name_ar,
        'warehouse_label', coalesce(v_target.label, wh.name),
        'points', (
          select jsonb_agg(jsonb_build_object(
            'point_id',    dp.id,
            'point_name',  dp.name,
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
            'point_name',   dp.name,
            'point_name_ar', dp.name_ar,
            'condition',    ia.condition,
            'quantity',     ia.quantity,
            'expiry_date',  ia.expiry_date
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

revoke all on function get_public_qr_payload(text) from authenticated;
grant execute on function get_public_qr_payload(text) to anon, authenticated;

-- =============================================================================
-- 2. CREATE_QR_FOR_TARGET
--    Creates a qr_target + qr_token for an allowlisted entity.
--    Allowlist: warehouse | distribution_point | local_item
--    Idempotent: if active token already exists, returns it.
-- =============================================================================
create or replace function create_qr_for_target(
  p_target_type  text,
  p_target_id    uuid,
  p_label        text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role        text;
  v_org_id      uuid;
  v_target_id   uuid;
  v_token_id    uuid;
  v_public_id   text;
  v_plain_token text;
  v_token_hash  text;
  v_allowed_types text[] := array['warehouse', 'distribution_point', 'local_item'];
begin
  v_role   := phoenix_my_role();
  v_org_id := phoenix_my_org();

  -- only super_admin, hospital_admin, warehouse_manager may create QR
  if v_role not in ('super_admin', 'hospital_admin', 'warehouse_manager') then
    return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  end if;

  -- enforce allowlist
  if p_target_type != all(v_allowed_types) then
    return jsonb_build_object(
      'ok', false,
      'error', 'TARGET_TYPE_NOT_ALLOWLISTED',
      'allowed', v_allowed_types
    );
  end if;

  -- verify target belongs to caller's org (or caller is super_admin)
  case p_target_type
    when 'warehouse' then
      if not exists (
        select 1 from warehouses
        where id = p_target_id
          and (v_role = 'super_admin' or organization_id = v_org_id)
      ) then
        return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND_OR_FORBIDDEN');
      end if;
      select organization_id into v_org_id from warehouses where id = p_target_id;

    when 'distribution_point' then
      if not exists (
        select 1 from distribution_points
        where id = p_target_id
          and (v_role = 'super_admin' or organization_id = v_org_id)
      ) then
        return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND_OR_FORBIDDEN');
      end if;
      select organization_id into v_org_id from distribution_points where id = p_target_id;

    when 'local_item' then
      if not exists (
        select 1 from local_items
        where id = p_target_id
          and (v_role = 'super_admin' or organization_id = v_org_id)
      ) then
        return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND_OR_FORBIDDEN');
      end if;
      select organization_id into v_org_id from local_items where id = p_target_id;
  end case;

  -- idempotent: return existing active token if present
  select qt.id, qt.public_id into v_token_id, v_public_id
  from qr_tokens qt
  join qr_targets qtr on qtr.id = qt.qr_target_id
  where qtr.target_type = p_target_type::qr_target_type
    and qtr.target_id = p_target_id
    and qt.status = 'active'
  limit 1;

  if found then
    return jsonb_build_object(
      'ok',        true,
      'created',   false,
      'token_id',  v_token_id,
      'public_id', v_public_id
    );
  end if;

  -- upsert qr_target
  insert into qr_targets (organization_id, target_type, target_id, label)
  values (v_org_id, p_target_type::qr_target_type, p_target_id, p_label)
  on conflict (target_type, target_id) do update set label = excluded.label
  returning id into v_target_id;

  -- generate token
  v_plain_token := encode(gen_random_bytes(32), 'hex');
  v_token_hash  := encode(digest(v_plain_token, 'sha256'), 'hex');
  v_public_id   := encode(gen_random_bytes(12), 'hex');

  insert into qr_tokens (qr_target_id, organization_id, public_id, token_hash, created_by)
  values (v_target_id, v_org_id, v_public_id, v_token_hash, auth.uid())
  returning id into v_token_id;

  -- audit
  insert into audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label)
  values (v_org_id, auth.uid(), v_role, 'qr_created', p_target_type, p_target_id, p_label);

  return jsonb_build_object(
    'ok',        true,
    'created',   true,
    'token_id',  v_token_id,
    'public_id', v_public_id
  );
end;
$$;

revoke all on function create_qr_for_target(text, uuid, text) from anon;
grant execute on function create_qr_for_target(text, uuid, text) to authenticated;

-- =============================================================================
-- 3. DISABLE_QR_TOKEN
--    Disables a QR token. NEVER touches the parent entity.
--    QR-only action: parent stays exactly as it was.
-- =============================================================================
create or replace function disable_qr_token(
  p_token_id     uuid,
  p_reason       text default 'manual_disable'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role    text;
  v_org_id  uuid;
  v_token   qr_tokens%rowtype;
begin
  v_role   := phoenix_my_role();
  v_org_id := phoenix_my_org();

  if v_role not in ('super_admin', 'hospital_admin', 'warehouse_manager') then
    return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  end if;

  select * into v_token from qr_tokens where id = p_token_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'TOKEN_NOT_FOUND');
  end if;

  if v_role != 'super_admin' and v_token.organization_id != v_org_id then
    return jsonb_build_object('ok', false, 'error', 'FORBIDDEN_ORG');
  end if;

  if v_token.status = 'disabled' then
    return jsonb_build_object('ok', true, 'already_disabled', true);
  end if;

  update qr_tokens
  set status       = 'disabled',
      disabled_at  = now(),
      disabled_by  = auth.uid(),
      disable_reason = p_reason
  where id = p_token_id;

  insert into audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id)
  values (v_token.organization_id, auth.uid(), v_role, 'qr_disabled', 'qr_token', p_token_id);

  return jsonb_build_object('ok', true, 'disabled', true);
end;
$$;

revoke all on function disable_qr_token(uuid, text) from anon;
grant execute on function disable_qr_token(uuid, text) to authenticated;

-- =============================================================================
-- 4. ARCHIVE_ENTITY
--    Soft-archives an allowlisted entity (sets archived_at/by/reason).
--    Allowlist: warehouse | distribution_point | local_item
--    Does NOT disable QR — call disable_qr_token separately if needed.
-- =============================================================================
create or replace function archive_entity(
  p_entity_type  text,
  p_entity_id    uuid,
  p_reason       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role    text;
  v_org_id  uuid;
  v_allowed text[] := array['warehouse', 'distribution_point', 'local_item'];
  v_rows    int;
begin
  v_role   := phoenix_my_role();
  v_org_id := phoenix_my_org();

  if v_role not in ('super_admin', 'hospital_admin') then
    return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  end if;

  if p_entity_type != all(v_allowed) then
    return jsonb_build_object('ok', false, 'error', 'ENTITY_TYPE_NOT_ALLOWLISTED');
  end if;

  if p_reason is null or trim(p_reason) = '' then
    return jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED');
  end if;

  case p_entity_type
    when 'warehouse' then
      update warehouses
      set status = 'archived', archived_at = now(), archived_by = auth.uid(), archive_reason = p_reason
      where id = p_entity_id
        and (v_role = 'super_admin' or organization_id = v_org_id)
        and archived_at is null;
      get diagnostics v_rows = row_count;

    when 'distribution_point' then
      update distribution_points
      set status = 'archived', archived_at = now(), archived_by = auth.uid(), archive_reason = p_reason
      where id = p_entity_id
        and (v_role = 'super_admin' or organization_id = v_org_id)
        and archived_at is null;
      get diagnostics v_rows = row_count;

    when 'local_item' then
      update local_items
      set status = 'archived', archived_at = now(), archived_by = auth.uid(), archive_reason = p_reason
      where id = p_entity_id
        and (v_role = 'super_admin' or organization_id = v_org_id)
        and archived_at is null;
      get diagnostics v_rows = row_count;
  end case;

  if v_rows = 0 then
    return jsonb_build_object('ok', false, 'error', 'NOT_FOUND_OR_ALREADY_ARCHIVED');
  end if;

  insert into audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload)
  values (v_org_id, auth.uid(), v_role, 'archived', p_entity_type, p_entity_id,
          jsonb_build_object('reason', p_reason));

  return jsonb_build_object('ok', true, 'archived', true);
end;
$$;

revoke all on function archive_entity(text, uuid, text) from anon;
grant execute on function archive_entity(text, uuid, text) to authenticated;

-- =============================================================================
-- 5. GET_ENTITY_PURGE_IMPACT
--    Read-only preview of what will be deleted if purge is confirmed.
--    Returns counts for all child records.
--    Allowlist: warehouse | distribution_point | local_item
-- =============================================================================
create or replace function get_entity_purge_impact(
  p_entity_type text,
  p_entity_id   uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role    text;
  v_org_id  uuid;
  v_allowed text[] := array['warehouse', 'distribution_point', 'local_item'];
  v_impact  jsonb;
begin
  v_role   := phoenix_my_role();
  v_org_id := phoenix_my_org();

  if v_role not in ('super_admin', 'hospital_admin') then
    return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  end if;

  if p_entity_type != all(v_allowed) then
    return jsonb_build_object('ok', false, 'error', 'ENTITY_TYPE_NOT_ALLOWLISTED');
  end if;

  case p_entity_type
    when 'warehouse' then
      -- guard: must exist and belong to caller's org
      if not exists (
        select 1 from warehouses
        where id = p_entity_id
          and (v_role = 'super_admin' or organization_id = v_org_id)
      ) then
        return jsonb_build_object('ok', false, 'error', 'NOT_FOUND_OR_FORBIDDEN');
      end if;

      select jsonb_build_object(
        'ok',                   true,
        'entity_type',          'warehouse',
        'entity_id',            p_entity_id,
        'distribution_points',  (select count(*) from distribution_points where warehouse_id = p_entity_id),
        'item_availability',    (
          select count(*) from item_availability ia
          join distribution_points dp on dp.id = ia.distribution_point_id
          where dp.warehouse_id = p_entity_id
        ),
        'qr_tokens',            (
          select count(*) from qr_tokens qt
          join qr_targets qtr on qtr.id = qt.qr_target_id
          where (qtr.target_type = 'warehouse' and qtr.target_id = p_entity_id)
             or (qtr.target_type = 'distribution_point' and qtr.target_id in (
               select id from distribution_points where warehouse_id = p_entity_id
             ))
        ),
        'audit_logs',           (select count(*) from audit_logs where entity_id = p_entity_id)
      ) into v_impact;

    when 'distribution_point' then
      if not exists (
        select 1 from distribution_points
        where id = p_entity_id
          and (v_role = 'super_admin' or organization_id = v_org_id)
      ) then
        return jsonb_build_object('ok', false, 'error', 'NOT_FOUND_OR_FORBIDDEN');
      end if;

      select jsonb_build_object(
        'ok',                true,
        'entity_type',       'distribution_point',
        'entity_id',         p_entity_id,
        'item_availability', (select count(*) from item_availability where distribution_point_id = p_entity_id),
        'qr_tokens',         (
          select count(*) from qr_tokens qt
          join qr_targets qtr on qtr.id = qt.qr_target_id
          where qtr.target_type = 'distribution_point' and qtr.target_id = p_entity_id
        ),
        'audit_logs',        (select count(*) from audit_logs where entity_id = p_entity_id)
      ) into v_impact;

    when 'local_item' then
      if not exists (
        select 1 from local_items
        where id = p_entity_id
          and (v_role = 'super_admin' or organization_id = v_org_id)
      ) then
        return jsonb_build_object('ok', false, 'error', 'NOT_FOUND_OR_FORBIDDEN');
      end if;

      select jsonb_build_object(
        'ok',                true,
        'entity_type',       'local_item',
        'entity_id',         p_entity_id,
        'item_availability', (select count(*) from item_availability where local_item_id = p_entity_id),
        'qr_tokens',         (
          select count(*) from qr_tokens qt
          join qr_targets qtr on qtr.id = qt.qr_target_id
          where qtr.target_type = 'local_item' and qtr.target_id = p_entity_id
        ),
        'audit_logs',        (select count(*) from audit_logs where entity_id = p_entity_id)
      ) into v_impact;
  end case;

  return v_impact;
end;
$$;

revoke all on function get_entity_purge_impact(text, uuid) from anon;
grant execute on function get_entity_purge_impact(text, uuid) to authenticated;

-- =============================================================================
-- 6. PURGE_ENTITY_WITH_ALL_DATA
--    Hard-delete an allowlisted entity and all its children.
--    SAFE ORDER: QR tokens first → QR targets → child rows → parent last.
--    Uses unambiguous variable names (v_*) throughout.
--    Requires: p_confirmation must equal 'CONFIRM_PURGE_' || p_entity_id::text
--    Allowlist: warehouse | distribution_point | local_item
--
-- MEDISTOCK_PHOENIX_PURGE_V1 — marker for verification
-- =============================================================================
create or replace function purge_entity_with_all_data(
  p_entity_type  text,
  p_entity_id    uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role          text;
  v_org_id        uuid;
  v_allowed       text[] := array['warehouse', 'distribution_point', 'local_item'];
  v_required_conf text;
  v_entity_org_id uuid;
  v_impact        jsonb;
begin
  -- MEDISTOCK_PHOENIX_PURGE_V1
  v_role   := phoenix_my_role();
  v_org_id := phoenix_my_org();

  -- only super_admin may hard-delete
  if v_role != 'super_admin' then
    return jsonb_build_object('ok', false, 'error', 'SUPER_ADMIN_ONLY');
  end if;

  -- enforce allowlist
  if p_entity_type != all(v_allowed) then
    return jsonb_build_object('ok', false, 'error', 'ENTITY_TYPE_NOT_ALLOWLISTED');
  end if;

  -- require exact confirmation phrase to prevent accidental calls
  v_required_conf := 'CONFIRM_PURGE_' || p_entity_id::text;
  if p_confirmation is distinct from v_required_conf then
    return jsonb_build_object(
      'ok', false,
      'error', 'CONFIRMATION_MISMATCH',
      'required', v_required_conf
    );
  end if;

  -- resolve and validate entity
  case p_entity_type
    when 'warehouse' then
      select organization_id into v_entity_org_id
      from warehouses where id = p_entity_id;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'ENTITY_NOT_FOUND');
      end if;

    when 'distribution_point' then
      select organization_id into v_entity_org_id
      from distribution_points where id = p_entity_id;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'ENTITY_NOT_FOUND');
      end if;

    when 'local_item' then
      select organization_id into v_entity_org_id
      from local_items where id = p_entity_id;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'ENTITY_NOT_FOUND');
      end if;
  end case;

  -- get impact for audit snapshot
  v_impact := get_entity_purge_impact(p_entity_type, p_entity_id);

  -- ===== SAFE DELETE ORDER =====

  case p_entity_type

    when 'warehouse' then
      -- 1. Disable+delete QR tokens for all child distribution_points
      update qr_tokens set status = 'disabled', disabled_at = now(), disabled_by = auth.uid(),
        disable_reason = 'parent_warehouse_purged'
      where qr_target_id in (
        select qtr.id from qr_targets qtr
        where qtr.target_type = 'distribution_point'
          and qtr.target_id in (select id from distribution_points where warehouse_id = p_entity_id)
      );
      delete from qr_targets
      where target_type = 'distribution_point'
        and target_id in (select id from distribution_points where warehouse_id = p_entity_id);

      -- 2. Disable+delete QR tokens for the warehouse itself
      update qr_tokens set status = 'disabled', disabled_at = now(), disabled_by = auth.uid(),
        disable_reason = 'warehouse_purged'
      where qr_target_id in (
        select id from qr_targets where target_type = 'warehouse' and target_id = p_entity_id
      );
      delete from qr_targets where target_type = 'warehouse' and target_id = p_entity_id;

      -- 3. Delete item_availability for all distribution_points
      delete from item_availability
      where distribution_point_id in (
        select id from distribution_points where warehouse_id = p_entity_id
      );

      -- 4. Delete distribution_points
      delete from distribution_points where warehouse_id = p_entity_id;

      -- 5. Delete warehouse (parent last)
      delete from warehouses where id = p_entity_id;

    when 'distribution_point' then
      -- 1. Disable+delete QR tokens for this point
      update qr_tokens set status = 'disabled', disabled_at = now(), disabled_by = auth.uid(),
        disable_reason = 'distribution_point_purged'
      where qr_target_id in (
        select id from qr_targets
        where target_type = 'distribution_point' and target_id = p_entity_id
      );
      delete from qr_targets
      where target_type = 'distribution_point' and target_id = p_entity_id;

      -- 2. Delete item_availability
      delete from item_availability where distribution_point_id = p_entity_id;

      -- 3. Delete parent (point)
      delete from distribution_points where id = p_entity_id;

    when 'local_item' then
      -- 1. Disable+delete QR tokens for this local_item
      update qr_tokens set status = 'disabled', disabled_at = now(), disabled_by = auth.uid(),
        disable_reason = 'local_item_purged'
      where qr_target_id in (
        select id from qr_targets
        where target_type = 'local_item' and target_id = p_entity_id
      );
      delete from qr_targets
      where target_type = 'local_item' and target_id = p_entity_id;

      -- 2. Delete item_availability records for this local_item
      delete from item_availability where local_item_id = p_entity_id;

      -- 3. Delete local_item (parent last)
      delete from local_items where id = p_entity_id;

  end case;

  -- audit (written after purge so entity_id refers to what was deleted)
  insert into audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, payload
  ) values (
    v_entity_org_id, auth.uid(), v_role, 'purged', p_entity_type, p_entity_id,
    v_impact
  );

  return jsonb_build_object(
    'ok',          true,
    'purged',      true,
    'entity_type', p_entity_type,
    'entity_id',   p_entity_id,
    'impact',      v_impact
  );
end;
$$;

revoke all on function purge_entity_with_all_data(text, uuid, text) from anon;
grant execute on function purge_entity_with_all_data(text, uuid, text) to authenticated;

-- =============================================================================
-- VERIFY MARKER
-- Run to confirm live version:
--   select pg_get_functiondef('purge_entity_with_all_data'::regproc)
--     like '%MEDISTOCK_PHOENIX_PURGE_V1%' as marker_present;
-- =============================================================================

-- =============================================================================
-- END OF MIGRATION 003
-- Verify RPCs exist:
--   select routine_name from information_schema.routines
--   where routine_schema = 'public' and routine_type = 'FUNCTION'
--   order by routine_name;
-- Expected among results:
--   archive_entity, create_qr_for_target, disable_qr_token,
--   get_entity_purge_impact, get_public_qr_payload, purge_entity_with_all_data
-- =============================================================================

-- =============================================================================
-- MediStock Phoenix V2 — Migration 007: Clear Port Availability RPC
-- Apply manually via Supabase SQL Editor after review.
-- DO NOT run with `npx supabase db push`.
--
-- Purpose:
--   Safe RPC to clear all item_availability rows for a distribution point.
--   Used by the hierarchical deletion wizard before archiving/deleting a port.
--   Does NOT delete the port or its QR. Role and org scoped.
-- =============================================================================

create or replace function clear_port_availability(
  p_point_id          uuid,
  p_confirmation      text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id   uuid;
  v_role       text;
  v_org_id     uuid;
  v_point_org  uuid;
  v_count      int;
  v_required   text;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  end if;

  select role, organization_id into v_role, v_org_id
  from profiles where id = v_actor_id;

  if v_role not in ('super_admin', 'hospital_admin', 'warehouse_manager') then
    return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  end if;

  select organization_id into v_point_org
  from distribution_points where id = p_point_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'POINT_NOT_FOUND');
  end if;

  if v_role != 'super_admin' and v_point_org != v_org_id then
    return jsonb_build_object('ok', false, 'error', 'FORBIDDEN_ORG');
  end if;

  v_required := 'CLEAR_PORT_ITEMS_' || p_point_id::text;
  if p_confirmation is distinct from v_required then
    return jsonb_build_object(
      'ok', false,
      'error', 'CONFIRMATION_MISMATCH',
      'required', v_required
    );
  end if;

  select count(*) into v_count
  from item_availability where distribution_point_id = p_point_id;

  delete from item_availability where distribution_point_id = p_point_id;

  insert into audit_logs (
    organization_id, actor_id, actor_role, action,
    entity_type, entity_id, payload
  ) values (
    v_point_org, v_actor_id, v_role, 'port_items_cleared',
    'distribution_point', p_point_id,
    jsonb_build_object('items_cleared', v_count)
  );

  return jsonb_build_object('ok', true, 'cleared', v_count);
end;
$$;

revoke all on function clear_port_availability(uuid, text) from anon;
grant execute on function clear_port_availability(uuid, text) to authenticated;

-- =============================================================================
-- END OF MIGRATION 007
-- =============================================================================

-- =============================================================================
-- MediStock Phoenix V2 — Migration 005: Guarded Role Assignment RPC
-- Apply AFTER 004_phoenix_seed_demo_data.sql.
-- Apply manually via Supabase SQL Editor after review.
-- DO NOT run with `npx supabase db push`.
--
-- Purpose:
--   Defense-in-depth RPC for role assignment. While existing RLS policies on
--   profiles already prevent escalation (hospital_admin WITH CHECK blocks
--   super_admin, profiles_update_own blocks self-promotion), this RPC
--   centralizes the security contract, adds audit logging, and returns
--   structured errors.
--
-- RPC: assign_profile_role(p_target_id uuid, p_new_role text)
--
-- Security contract:
--   - super_admin: can assign any valid role to any profile
--   - hospital_admin: can assign non-super_admin roles within own org only
--   - hospital_admin: CANNOT assign super_admin (enforced here AND by RLS)
--   - hospital_admin: CANNOT change profiles outside own org
--   - No user can change their own role (self-escalation blocked)
--   - warehouse_manager, point_operator, viewer: CANNOT assign roles
--   - Unknown/invalid roles are rejected
-- =============================================================================

create or replace function assign_profile_role(
  p_target_id  uuid,
  p_new_role   text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id     uuid;
  v_actor_role   text;
  v_actor_org_id uuid;
  v_target       profiles%rowtype;
  v_allowed_roles text[] := array[
    'super_admin', 'hospital_admin', 'warehouse_manager', 'point_operator', 'viewer'
  ];
begin
  -- Resolve actor
  v_actor_id := auth.uid();
  if v_actor_id is null then
    return jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED');
  end if;

  select role, organization_id into v_actor_role, v_actor_org_id
  from profiles where id = v_actor_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'ACTOR_PROFILE_NOT_FOUND');
  end if;

  -- Only admin roles may assign
  if v_actor_role not in ('super_admin', 'hospital_admin') then
    return jsonb_build_object('ok', false, 'error', 'INSUFFICIENT_ROLE');
  end if;

  -- Validate new role against allowlist
  if p_new_role != all(v_allowed_roles) then
    return jsonb_build_object(
      'ok', false,
      'error', 'INVALID_ROLE',
      'allowed', v_allowed_roles
    );
  end if;

  -- Resolve target profile
  select * into v_target from profiles where id = p_target_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND');
  end if;

  -- Block self-assignment
  if p_target_id = v_actor_id then
    return jsonb_build_object('ok', false, 'error', 'CANNOT_CHANGE_OWN_ROLE');
  end if;

  -- hospital_admin restrictions
  if v_actor_role = 'hospital_admin' then
    -- Cannot assign super_admin
    if p_new_role = 'super_admin' then
      return jsonb_build_object('ok', false, 'error', 'CANNOT_ESCALATE_TO_SUPER_ADMIN');
    end if;

    -- Cannot modify profiles outside own org
    if v_target.organization_id is distinct from v_actor_org_id then
      return jsonb_build_object('ok', false, 'error', 'CANNOT_MODIFY_OTHER_ORG');
    end if;

    -- Cannot demote/change a super_admin
    if v_target.role = 'super_admin' then
      return jsonb_build_object('ok', false, 'error', 'CANNOT_MODIFY_SUPER_ADMIN');
    end if;
  end if;

  -- No-op if role is already the target
  if v_target.role = p_new_role then
    return jsonb_build_object('ok', true, 'changed', false, 'reason', 'ALREADY_ASSIGNED');
  end if;

  -- Apply the role change
  update profiles
  set role = p_new_role, updated_at = now()
  where id = p_target_id;

  -- Audit log
  insert into audit_logs (
    organization_id, actor_id, actor_role, action,
    entity_type, entity_id, entity_label, payload
  ) values (
    v_target.organization_id,
    v_actor_id,
    v_actor_role,
    'role_assigned',
    'profile',
    p_target_id,
    v_target.full_name,
    jsonb_build_object(
      'previous_role', v_target.role,
      'new_role', p_new_role
    )
  );

  return jsonb_build_object(
    'ok', true,
    'changed', true,
    'previous_role', v_target.role,
    'new_role', p_new_role
  );
end;
$$;

revoke all on function assign_profile_role(uuid, text) from anon;
grant execute on function assign_profile_role(uuid, text) to authenticated;

-- =============================================================================
-- END OF MIGRATION 005
-- Verify RPC exists:
--   select routine_name from information_schema.routines
--   where routine_schema = 'public' and routine_name = 'assign_profile_role';
-- =============================================================================

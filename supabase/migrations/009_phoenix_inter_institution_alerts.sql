-- =============================================================================
-- MediStock Phoenix V2 — Migration 009: Scoped Inter-Institution Alerts RPC
-- Apply AFTER 008_phoenix_org_status_contacts.sql.
-- Apply manually via Supabase SQL Editor after review.
-- DO NOT run with `npx supabase db push`.
--
-- Purpose:
--   Securely compute inter-institution exchange alerts server-side so that a
--   non-super user only ever receives alerts where THEIR organization is the
--   source or the target party. Cross-institution matching and counterpart
--   contact lookup happen inside this SECURITY DEFINER function — never by
--   handing every institution's raw reports to the browser.
--
-- Alert rules (matches src/features/status/exchange-alerts.ts):
--   near_expiry + missing                -> high
--   surplus     + missing (has quantity) -> high
--   surplus     + missing (no quantity)  -> low
--   surplus     + scarce                 -> medium
--   near_expiry + scarce                 -> medium
--   same organization                    -> excluded
--   inactive / resolved reports          -> excluded
--   no auto-transfer / no auto-approval  -> manual_action_required = true
--
-- Isolation:
--   super_admin           -> all alerts, all institution names + contacts
--   non-super (org-scoped)-> only alerts where own org is source OR target;
--                            counterpart name + contact returned for that
--                            matching alert only.
-- =============================================================================

create or replace function get_scoped_inter_institution_alerts()
returns table (
  alert_id                    text,
  priority                    text,
  item_name                   text,
  item_name_ar                text,
  source_organization_id      uuid,
  source_organization_name    text,
  source_organization_name_ar text,
  target_organization_id      uuid,
  target_organization_name    text,
  target_organization_name_ar text,
  source_status_type          text,
  target_status_type          text,
  source_quantity             numeric,
  source_unit                 text,
  source_expiry_date          date,
  target_quantity             numeric,
  target_unit                 text,
  source_contact_name         text,
  source_contact_phone        text,
  target_contact_name         text,
  target_contact_phone        text,
  recommendation_kind         text,
  manual_action_required      boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id   uuid;
  v_role       text;
  v_org_id     uuid;
begin
  v_actor_id := auth.uid();
  if v_actor_id is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  select role, organization_id into v_role, v_org_id
  from profiles where id = v_actor_id;

  if v_role is null then
    raise exception 'ACTOR_PROFILE_NOT_FOUND';
  end if;

  return query
  with active_reports as (
    select r.id, r.organization_id, r.item_id, r.item_name, r.item_name_ar,
           r.status_type, r.quantity, r.unit, r.expiry_date
    from institution_item_status_reports r
    where r.is_active = true
  ),
  sources as (
    select * from active_reports where status_type in ('surplus', 'near_expiry')
  ),
  targets as (
    select * from active_reports where status_type in ('scarce', 'missing')
  ),
  matched as (
    select
      s.id   as src_id,
      t.id   as tgt_id,
      s.organization_id as src_org,
      t.organization_id as tgt_org,
      s.status_type as src_status,
      t.status_type as tgt_status,
      coalesce(s.item_name, t.item_name)       as m_item_name,
      coalesce(s.item_name_ar, t.item_name_ar) as m_item_name_ar,
      s.quantity   as src_qty,
      s.unit       as src_unit,
      s.expiry_date as src_expiry,
      t.quantity   as tgt_qty,
      t.unit       as tgt_unit,
      case
        when s.status_type = 'near_expiry' and t.status_type = 'missing' then 'high'
        when s.status_type = 'surplus' and t.status_type = 'missing' and s.quantity is not null then 'high'
        when s.status_type = 'surplus' and t.status_type = 'scarce' then 'medium'
        when s.status_type = 'near_expiry' and t.status_type = 'scarce' then 'medium'
        when s.status_type = 'surplus' and t.status_type = 'missing' and s.quantity is null then 'low'
        else null
      end as m_priority
    from sources s
    join targets t
      on s.organization_id <> t.organization_id
     and (
          (s.item_id is not null and s.item_id = t.item_id)
       or (nullif(btrim(lower(s.item_name)), '') is not null
            and btrim(lower(s.item_name)) = btrim(lower(t.item_name)))
       or (nullif(btrim(lower(s.item_name_ar)), '') is not null
            and btrim(lower(s.item_name_ar)) = btrim(lower(t.item_name_ar)))
         )
  )
  select
    m.src_id || ':' || m.tgt_id                       as alert_id,
    m.m_priority                                       as priority,
    m.m_item_name                                      as item_name,
    m.m_item_name_ar                                   as item_name_ar,
    m.src_org                                          as source_organization_id,
    so.name                                            as source_organization_name,
    so.name_ar                                         as source_organization_name_ar,
    m.tgt_org                                          as target_organization_id,
    to_.name                                           as target_organization_name,
    to_.name_ar                                        as target_organization_name_ar,
    m.src_status                                       as source_status_type,
    m.tgt_status                                       as target_status_type,
    m.src_qty                                          as source_quantity,
    m.src_unit                                         as source_unit,
    m.src_expiry                                       as source_expiry_date,
    m.tgt_qty                                          as target_quantity,
    m.tgt_unit                                         as target_unit,
    sc.display_name                                    as source_contact_name,
    sc.phone                                           as source_contact_phone,
    tc.display_name                                    as target_contact_name,
    tc.phone                                           as target_contact_phone,
    case when m.src_status = 'near_expiry' then 'expiry_match' else 'surplus_match' end as recommendation_kind,
    true                                               as manual_action_required
  from matched m
  join organizations so on so.id = m.src_org
  join organizations to_ on to_.id = m.tgt_org
  left join lateral (
    select c.display_name, c.phone
    from organization_status_contacts c
    where c.organization_id = m.src_org and c.is_active = true
    order by c.is_primary desc, c.created_at asc
    limit 1
  ) sc on true
  left join lateral (
    select c.display_name, c.phone
    from organization_status_contacts c
    where c.organization_id = m.tgt_org and c.is_active = true
    order by c.is_primary desc, c.created_at asc
    limit 1
  ) tc on true
  where m.m_priority is not null
    and (
      v_role = 'super_admin'
      or m.src_org = v_org_id
      or m.tgt_org = v_org_id
    )
  order by
    case m.m_priority when 'high' then 3 when 'medium' then 2 else 1 end desc;
end;
$$;

revoke all on function get_scoped_inter_institution_alerts() from anon;
grant execute on function get_scoped_inter_institution_alerts() to authenticated;

-- =============================================================================
-- END OF MIGRATION 009
-- Verify:
--   select routine_name from information_schema.routines
--   where routine_schema = 'public'
--     and routine_name = 'get_scoped_inter_institution_alerts';
-- Smoke test (as authenticated non-super): every returned row must have
--   source_organization_id = my org OR target_organization_id = my org.
-- =============================================================================

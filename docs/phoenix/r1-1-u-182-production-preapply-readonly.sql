-- R1.1-U / Migration 182 operator gate — READ ONLY.
-- Run against Production only through the authorized read-only channel.
-- This statement performs no DDL, DML, function call, lock, or migration write.
--
-- It answers, in one row per section, everything an independent reviewer needs
-- before authorizing 182:
--   * is the ceiling exactly 181, and is 182 genuinely absent;
--   * does the pre-182 world already contain anything 182 would refuse;
--   * which health sectors, centres and institution_admins exist to be affected.
--
-- Every classification is STRUCTURAL. No organization name, no Production
-- identifier, and nothing that would need editing between environments.
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE CEILING IS PROVED STRUCTURALLY, NOT FROM THE MIGRATION LEDGER
-- ─────────────────────────────────────────────────────────────────────────────
-- A migration applied by hand through the SQL editor does NOT write
-- supabase_migrations.schema_migrations, which is exactly how this project
-- applies them. That ledger therefore UNDERSTATES the true ceiling and must
-- never decide anything. This artifact proves the ceiling from the catalogue
-- instead — 181's own objects present, 182's own objects absent — which is both
-- immune to that gap and lets the identical file run on a disposable rig, where
-- the ledger does not exist at all. (A missing relation is a PARSE error in
-- PostgreSQL, so it cannot be guarded with to_regclass inside one statement.)
--
-- The operator may still read the ledger for information, separately:
--   SELECT version, name FROM supabase_migrations.schema_migrations
--    ORDER BY version DESC LIMIT 5;
WITH ceiling AS (
  SELECT
    -- 181 is the expected ceiling: its canonical writer must exist...
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='phoenix_create_health_center_warehouse') AS ceiling_181_objects,
    -- ...and 181's NULL-warehouse outlet boundary must be the closed form.
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='_phoenix_health_sector_outlet_topology_guard_v1'
        AND pg_get_functiondef(p.oid) LIKE '%warehouse_id IS NULL leaves it owned by no health centre%')
                                                                                       AS ceiling_181_closed
),
-- 182 is idempotency-guarded on these exact objects; all must be ABSENT.
target_objects AS (
  SELECT
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name='profile_scope_assignments'
        AND column_name='facility_id')                                     AS facility_id_column,
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='phoenix_profile_has_facility_assignment') AS facility_helper,
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='phoenix_admin_assign_facility_scopes')    AS service_writer,
    (SELECT count(*) FROM pg_trigger
      WHERE tgname='profiles_health_center_manager_org_guard_trg')          AS profile_role_guard,
    (SELECT count(*) FROM pg_indexes
      WHERE schemaname='public' AND indexname='psa_active_facility_uniq')   AS facility_unique_index,
    (SELECT count(*) FROM pg_constraint WHERE conname='psa_facility_org_fk') AS facility_fk
),
-- The preconditions 182 fails closed on; all must be PRESENT.
preconditions AS (
  SELECT
    (SELECT count(*) FROM pg_constraint WHERE conname='organization_facilities_id_org_uniq') AS fk_target_unique,
    (SELECT count(*) FROM pg_constraint WHERE conname='of_parent_is_health_sector_chk')      AS facilities_are_sector_only,
    (SELECT count(*) FROM pg_constraint WHERE conname='psa_scope_type_chk')                  AS scope_type_chk,
    (SELECT count(*) FROM pg_constraint WHERE conname='profile_scope_assignments_scope_type_check') AS scope_type_check_2,
    (SELECT count(*) FROM pg_constraint WHERE conname='psa_target_matches_scope_chk')        AS target_match_chk,
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='phoenix_create_health_center_warehouse')       AS migration_181_applied,
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='phoenix_admin_provision_profile')              AS provisioning_contract
),
role_counts AS (
  SELECT
    count(*)                                                        AS profiles_total,
    count(*) FILTER (WHERE role='super_admin')                      AS super_admin,
    count(*) FILTER (WHERE role='institution_admin')                AS institution_admin,
    count(*) FILTER (WHERE role='central_warehouse_manager')        AS central_warehouse_manager,
    count(*) FILTER (WHERE role='warehouse_officer')                AS warehouse_officer,
    count(*) FILTER (WHERE role='outlet_officer')                   AS outlet_officer,
    -- MUST be 0 before 182: the migration refuses to apply otherwise.
    count(*) FILTER (WHERE role='health_center_manager')            AS health_center_manager,
    count(*) FILTER (WHERE role NOT IN ('super_admin','institution_admin',
      'central_warehouse_manager','warehouse_officer','outlet_officer'))    AS unrecognised_role_rows
  FROM public.profiles
),
scope_counts AS (
  SELECT
    count(*)                                                        AS assignments_total,
    count(*) FILTER (WHERE is_active)                               AS assignments_active,
    count(*) FILTER (WHERE scope_type='warehouse' AND is_active)    AS active_warehouse_scopes,
    count(*) FILTER (WHERE scope_type='distribution_point' AND is_active) AS active_point_scopes,
    -- Any other scope_type would be unexpected for a pre-182 database.
    count(*) FILTER (WHERE scope_type NOT IN ('warehouse','distribution_point')) AS unexpected_scope_type_rows
  FROM public.profile_scope_assignments
),
sector_evidence AS (
  SELECT
    count(*)                                                        AS health_sectors_total,
    count(*) FILTER (WHERE status='active')                         AS health_sectors_active,
    coalesce(jsonb_agg(jsonb_build_object(
      'organization_id', id, 'code', code, 'status', status,
      'active_health_centers', (
        SELECT count(*) FROM public.organization_facilities f
         WHERE f.organization_id = o.id AND f.status='active'
           AND f.facility_class IN ('primary_health_center','subordinate_health_center')),
      'inactive_health_centers', (
        SELECT count(*) FROM public.organization_facilities f
         WHERE f.organization_id = o.id AND f.status <> 'active'),
      'institution_admins', (
        SELECT count(*) FROM public.profiles p
         WHERE p.organization_id = o.id AND p.role='institution_admin' AND p.status='active')
    ) ORDER BY id) FILTER (WHERE id IS NOT NULL), '[]'::jsonb)      AS sectors
  FROM public.organizations o
  WHERE o.organization_kind='care_institution' AND o.institution_class='health_sector'
),
facility_evidence AS (
  SELECT
    count(*)                                                        AS facilities_total,
    count(*) FILTER (WHERE status='active')                         AS facilities_active,
    count(*) FILTER (WHERE facility_class NOT IN
      ('primary_health_center','subordinate_health_center'))         AS facilities_wrong_class,
    count(*) FILTER (WHERE parent_institution_class <> 'health_sector') AS facilities_wrong_parent
  FROM public.organization_facilities
),
admin_evidence AS (
  SELECT
    count(*) FILTER (WHERE p.status='active')                        AS active_institution_admins,
    count(*) FILTER (WHERE p.status='active' AND o.institution_class='health_sector')
                                                                    AS active_sector_admins,
    count(*) FILTER (WHERE p.status='active' AND o.institution_class IS DISTINCT FROM 'health_sector')
                                                                    AS active_non_sector_admins
  FROM public.profiles p
  JOIN public.organizations o ON o.id = p.organization_id
  WHERE p.role='institution_admin'
),
-- Shapes that would make 182 ambiguous or that it would refuse outright.
ambiguity AS (
  SELECT
    (SELECT count(*) FROM public.profiles WHERE role='health_center_manager')   AS pre_existing_manager_profiles,
    (SELECT count(*) FROM public.profile_scope_assignments
      WHERE scope_type NOT IN ('warehouse','distribution_point'))                AS pre_existing_foreign_scope_rows,
    (SELECT count(*) FROM public.role_permission_defaults
      WHERE role='health_center_manager')                                        AS pre_existing_role_defaults,
    -- An active assignment whose profile organization already disagrees would
    -- fail the trigger the first time it is rewritten; worth knowing beforehand.
    (SELECT count(*) FROM public.profile_scope_assignments a
      JOIN public.profiles p ON p.id = a.profile_id
     WHERE a.is_active AND a.organization_id IS DISTINCT FROM p.organization_id) AS drifted_active_assignments
)
SELECT
  CASE
    -- Structural first, deliberately: a complete 182 object set means the
    -- migration is present whatever the ledger says.
    WHEN t.facility_id_column + t.facility_helper + t.service_writer
       + t.profile_role_guard + t.facility_unique_index + t.facility_fk = 6
                                                      THEN 'ALREADY_APPLIED_STOP'
    WHEN c.ceiling_181_objects = 0 OR c.ceiling_181_closed = 0
      OR pc.migration_181_applied = 0                 THEN 'CEILING_NOT_181_STOP'
    -- Any NON-EMPTY but incomplete subset is a half-applied database.
    WHEN t.facility_id_column + t.facility_helper + t.service_writer
       + t.profile_role_guard + t.facility_unique_index + t.facility_fk > 0
                                                      THEN 'PARTIAL_182_OBJECTS_STOP'
    WHEN pc.fk_target_unique = 0 OR pc.facilities_are_sector_only = 0
      OR pc.scope_type_chk = 0 OR pc.scope_type_check_2 = 0
      OR pc.target_match_chk = 0 OR pc.provisioning_contract = 0
                                                      THEN 'PRECONDITION_MISSING_STOP'
    WHEN a.pre_existing_manager_profiles > 0
      OR a.pre_existing_foreign_scope_rows > 0
      OR a.pre_existing_role_defaults > 0
      OR a.drifted_active_assignments > 0
      OR r.unrecognised_role_rows > 0                 THEN 'AMBIGUOUS_STOP'
    ELSE 'TARGET_READY'
  END AS classification,
  c.ceiling_181_objects, c.ceiling_181_closed,
  t.facility_id_column, t.facility_helper, t.service_writer,
  t.profile_role_guard, t.facility_unique_index, t.facility_fk,
  pc.fk_target_unique, pc.facilities_are_sector_only, pc.scope_type_chk,
  pc.scope_type_check_2, pc.target_match_chk, pc.migration_181_applied,
  pc.provisioning_contract,
  r.profiles_total, r.super_admin, r.institution_admin, r.central_warehouse_manager,
  r.warehouse_officer, r.outlet_officer, r.health_center_manager, r.unrecognised_role_rows,
  s.assignments_total, s.assignments_active, s.active_warehouse_scopes,
  s.active_point_scopes, s.unexpected_scope_type_rows,
  se.health_sectors_total, se.health_sectors_active, se.sectors,
  fe.facilities_total, fe.facilities_active, fe.facilities_wrong_class, fe.facilities_wrong_parent,
  ae.active_institution_admins, ae.active_sector_admins, ae.active_non_sector_admins,
  a.pre_existing_manager_profiles, a.pre_existing_foreign_scope_rows,
  a.pre_existing_role_defaults, a.drifted_active_assignments
FROM ceiling c, target_objects t, preconditions pc, role_counts r,
     scope_counts s, sector_evidence se, facility_evidence fe,
     admin_evidence ae, ambiguity a;

-- ============================================================================
-- R1-a CANDIDATE 02 — authorization closure (D7/D22). PLACEHOLDER (no migration
-- number): NOT part of the numbered chain, NOT approved for apply.
--
-- INTENTIONALLY BEHAVIOUR-CHANGING (unlike candidate 01): it removes the
-- super_admin cross-organization permit from every Central Needs entry point:
--   * one authority predicate, phoenix_cn_policy.actor_scope_org(key)
--   * guard_v1 body replaced (same signature, order and codes)
--   * RESTRICTIVE read policy on every public central_needs_% relation
--   * authority trigger on plan revisions (no column list, fail closed)
--   * capability seal extended to the catalog-derived relation set, the new
--     schema and the explicit ACL manifest
--   * key central_needs.manual_need.set registered, NO defaults, NO grants
--     (string / labels / is_dangerous are a [DEP-D3 / Q-K] record: OWNER-DEPENDENT)
--
-- M224-RBAC-ROOT-FIX (owner decision, 2026-10-21): eligibility is NOT a role class.
-- A caller is eligible when they are an ACTIVE member (profiles.organization_id) of a
-- live pharmacy_department_authority, hold the explicit key in the permission matrix
-- (phoenix_profile_has_permission), act for that home organization only, and never
-- approve their own work (SoD, candidate 03). Therefore:
--   * actor_scope_org carries no role predicate;
--   * _phoenix_central_needs_role_eligible_v1() (M211, used by every RESTRICTIVE
--     policy) is re-based on PDA membership: same signature, strictly boolean;
--   * the migration no longer refuses an organization that has no staffed maker and
--     checker yet: it records the permission-based readiness (NOTICE + an owner-only
--     helper) and the per-organization activation (R1-b 01) refuses while unstaffed.
--
-- Contract: R1-0 ADR rev4d §9.1–§9.8. Requires candidate 01 to be applied.
-- Relations covered in this file: the 13 legacy + central_needs_manual_need_events
-- (14). The remaining three (withdrawals, coverage acknowledgements, cutover
-- inventory) are added, with their policies, by the later candidate that creates
-- them; the seal manifest below is restated there.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- PRELUDE (fail closed)
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  r record;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'R1a02_requires_read_committed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'R1a02_precondition_failed: applier must be rolsuper or rolbypassrls';
  END IF;
  IF to_regclass('public.central_needs_manual_need_events') IS NULL THEN
    RAISE EXCEPTION 'R1a02_precondition_failed: candidate 01 not applied';
  END IF;
  IF to_regnamespace('phoenix_cn_policy') IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.permission_keys WHERE key = 'central_needs.manual_need.set') THEN
    RAISE EXCEPTION 'R1a02_precondition_failed: R1-a authorization objects already present';
  END IF;

  -- Structural ownership (ADR §9.5): every organization that owns a plan must be a
  -- live pharmacy-department authority, otherwise its plans would have no eligible
  -- scope at all. STAFFING is deliberately NOT a migration precondition any more: an
  -- unstaffed organization is dormant (recoverable by a permission grant, which is
  -- administered outside Central Needs), not locked out; the lockout guard moved to
  -- the per-organization activation (R1-b 01), where Excel closes for that organization.
  FOR r IN SELECT DISTINCT p.organization_id AS org FROM public.central_needs_plans p LOOP
    IF NOT EXISTS (SELECT 1 FROM public.organizations o
                    WHERE o.id = r.org AND o.organization_kind = 'pharmacy_department_authority' AND o.archived_at IS NULL) THEN
      RAISE EXCEPTION 'R1a02_precondition_failed: plan-owning organization % is not a live pharmacy_department_authority', r.org;
    END IF;
  END LOOP;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. The policy schema (PF-1): not exposed, USAGE for authenticated only.
-- ---------------------------------------------------------------------------
CREATE SCHEMA phoenix_cn_policy;
REVOKE ALL ON SCHEMA phoenix_cn_policy FROM PUBLIC, anon, service_role;
GRANT USAGE ON SCHEMA phoenix_cn_policy TO authenticated;
COMMENT ON SCHEMA phoenix_cn_policy IS
  'R1-a: single Central Needs authority predicate. Not exposed through the Data API; holds functions only.';

-- ---------------------------------------------------------------------------
-- 2. The single authority predicate (PF-2). Returns the caller's home PDA
--    organization when ALL of §9.2 a–g hold, else NULL. Never raises on an
--    authorization outcome; no super_admin exception; no auth.role()/auth.jwt().
--    M224-RBAC-ROOT-FIX: no role predicate either. Membership (active profile of
--    a live PDA) + the explicit key from the permission matrix are the authority.
-- ---------------------------------------------------------------------------
CREATE FUNCTION phoenix_cn_policy.actor_scope_org(p_key text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org   uuid;
BEGIN
  IF v_actor IS NULL OR p_key IS NULL
     OR p_key NOT IN ('central_needs.view', 'central_needs.import', 'central_needs.edit',
                      'central_needs.approve', 'central_needs.manual_need.set') THEN
    RETURN NULL;
  END IF;
  SELECT p.organization_id INTO v_org
    FROM public.profiles p
   WHERE p.id = v_actor
     AND p.status = 'active'
     AND p.organization_id IS NOT NULL;
  IF v_org IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations o
                  WHERE o.id = v_org AND o.organization_kind = 'pharmacy_department_authority' AND o.archived_at IS NULL) THEN
    RETURN NULL;
  END IF;
  IF NOT COALESCE(public.phoenix_profile_has_permission(v_actor, p_key), false) THEN RETURN NULL; END IF;
  IF p_key = 'central_needs.manual_need.set'
     AND NOT COALESCE(public.phoenix_profile_has_permission(v_actor, 'central_needs.view'), false) THEN
    RETURN NULL;
  END IF;
  RETURN v_org;
END;
$$;
REVOKE ALL ON FUNCTION phoenix_cn_policy.actor_scope_org(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION phoenix_cn_policy.actor_scope_org(text) TO authenticated;

CREATE FUNCTION public.phoenix_central_needs_actor_authorized(p_organization_id uuid, p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(phoenix_cn_policy.actor_scope_org(p_key) = p_organization_id, false)
$$;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_actor_authorized(uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_actor_authorized(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2b. M224-RBAC-ROOT-FIX: the M211 eligibility predicate, re-based on membership.
--     Same signature, still STABLE SECURITY DEFINER and strictly boolean (never
--     NULL, see M211), so every RESTRICTIVE *_role_eligible_restrictive policy and
--     guard_v1 now mean "an ACTIVE member of a live pharmacy_department_authority",
--     whatever the member's role. The name is historical. A care institution or
--     outlet actor still never qualifies (its home is not a PDA), and a member
--     still needs the explicit key: this predicate is a boundary, never a grant.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_role_eligible_v1()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT true
      FROM public.profiles p
      JOIN public.organizations o ON o.id = p.organization_id
     WHERE p.id = auth.uid()
       AND p.status = 'active'
       AND o.organization_kind = 'pharmacy_department_authority'
       AND o.archived_at IS NULL), false);
$$;
REVOKE ALL ON FUNCTION public._phoenix_central_needs_role_eligible_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._phoenix_central_needs_role_eligible_v1() TO authenticated;
COMMENT ON FUNCTION public._phoenix_central_needs_role_eligible_v1() IS
  'M224-RBAC-ROOT-FIX: true when the caller is an ACTIVE member of a live pharmacy_department_authority (no role class). Applied by every RESTRICTIVE *_role_eligible_restrictive policy and by guard_v1; the explicit key and the home-organization scope are still required by phoenix_cn_policy.actor_scope_org.';

-- ---------------------------------------------------------------------------
-- 2c. Staffing readiness (owner-only, read-only). The SAME membership + key rule
--     as actor_scope_org, evaluated for every active member of one organization:
--       maker   = view + edit + manual_need.set   (opens, enters, submits)
--       checker = view + approve                  (approves / rejects)
--     ready   = a maker and a DIFFERENT checker exist (SoD stays possible).
--     Used by the per-organization activation (R1-b 01) to refuse a lockout; it
--     never authorizes anything and returns counts only (no identities).
-- ---------------------------------------------------------------------------
CREATE FUNCTION phoenix_private.central_needs_staffing_readiness_v1(p_org uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH members AS (
    SELECT p.id,
           COALESCE(public.phoenix_profile_has_permission(p.id, 'central_needs.view'), false)            AS v,
           COALESCE(public.phoenix_profile_has_permission(p.id, 'central_needs.edit'), false)            AS e,
           COALESCE(public.phoenix_profile_has_permission(p.id, 'central_needs.manual_need.set'), false) AS m,
           COALESCE(public.phoenix_profile_has_permission(p.id, 'central_needs.approve'), false)         AS a
      FROM public.profiles p
      JOIN public.organizations o ON o.id = p.organization_id
     WHERE p.organization_id = p_org
       AND p.status = 'active'
       AND o.organization_kind = 'pharmacy_department_authority'
       AND o.archived_at IS NULL
  ),
  makers AS (SELECT id FROM members WHERE v AND e AND m),
  checkers AS (SELECT id FROM members WHERE v AND a)
  SELECT jsonb_build_object(
           'organization_id', p_org,
           'active_members', (SELECT count(*) FROM members),
           'makers', (SELECT count(*) FROM makers),
           'checkers', (SELECT count(*) FROM checkers),
           'ready', EXISTS (SELECT 1 FROM makers mk JOIN checkers ck ON ck.id <> mk.id))
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_staffing_readiness_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Key registration — inert (no role defaults, no grants). [DEP-D3 / Q-K]
-- ---------------------------------------------------------------------------
INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous)
VALUES ('central_needs.manual_need.set', 'central_needs', 'manual_need.set',
        'Enter manual annual needs', 'إدخال الاحتياجات السنوية يدويًا', false);

-- ---------------------------------------------------------------------------
-- 4. guard_v1: same signature, order and codes; the authority is the predicate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_guard_v1(p_organization_id uuid, p_permission_key text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id_required' USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM public.organizations WHERE id = p_organization_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Membership boundary (2b). The code is kept so every existing client mapping keeps its meaning.
  IF NOT public._phoenix_central_needs_role_eligible_v1() THEN
    RAISE EXCEPTION 'forbidden_central_needs_role' USING ERRCODE = '42501',
      DETAIL = 'the caller is not an active member of a live pharmacy_department_authority',
      HINT = 'Central Needs is restricted to active members of a Pharmacy Department authority holding the explicit key.';
  END IF;

  -- R1-a (D7/D22): the single predicate; no super_admin exception, no cross-organization permit.
  IF phoenix_cn_policy.actor_scope_org(p_permission_key) IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'forbidden_central_needs' USING ERRCODE = '42501',
      DETAIL = format('permission=%s organization=%s', p_permission_key, p_organization_id);
  END IF;

  PERFORM public._phoenix_central_needs_assert_org_live_v1(p_organization_id);

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor;
  RETURN v_actor_role;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. RESTRICTIVE read policy on every public central_needs_% relation (PF-3).
--    One constant policy name per table: '<table>_r1_actor_scope_restrictive' would exceed
--    PostgreSQL's 63-byte identifier limit for the longer table names (found by the rig).
-- ---------------------------------------------------------------------------
DO $pol$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT c.relname
             FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'central\_needs\_%'
            ORDER BY c.relname LOOP
    EXECUTE format(
      'CREATE POLICY r1_actor_scope_restrictive ON public.%I AS RESTRICTIVE FOR SELECT TO authenticated USING (organization_id = (SELECT phoenix_cn_policy.actor_scope_org(%L)))',
      t.relname, 'central_needs.view');
  END LOOP;
END
$pol$;

-- ---------------------------------------------------------------------------
-- 6. Authority trigger on plan revisions (ADR §9.3 c): no column list.
--    Transition whitelist = the census of M209-M220 flows (draft->submitted,
--    submitted->approved|rejected, approved->superseded); anything else fails.
-- ---------------------------------------------------------------------------
CREATE FUNCTION phoenix_private.central_needs_revision_authority_gate_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_key text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF phoenix_cn_policy.actor_scope_org('central_needs.edit') IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'forbidden_central_needs' USING ERRCODE = '42501', DETAIL = 'revision insert';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'submitted' THEN
    v_key := 'central_needs.edit';
  ELSIF OLD.status = 'submitted' AND NEW.status IN ('approved', 'rejected') THEN
    v_key := 'central_needs.approve';
  ELSIF OLD.status = 'approved' AND NEW.status = 'superseded' THEN
    v_key := 'central_needs.approve';
  ELSE
    RAISE EXCEPTION 'central_needs_status_transition_forbidden' USING ERRCODE = '23514',
      DETAIL = format('%s -> %s revision=%s', OLD.status, NEW.status, OLD.id);
  END IF;

  IF phoenix_cn_policy.actor_scope_org(v_key) IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'forbidden_central_needs' USING ERRCODE = '42501',
      DETAIL = format('%s -> %s requires %s', OLD.status, NEW.status, v_key);
  END IF;

  IF OLD.status = 'approved' AND NEW.status = 'superseded' THEN
    -- supersession is only ever the other half of an approval in THIS transaction: a
    -- same-transaction APPROVE attestation of a different revision of the same plan,
    -- which is still 'submitted' (the approval flow supersedes first) or already 'approved'.
    IF NOT EXISTS (
      SELECT 1
        FROM phoenix_private.central_needs_lifecycle_attestations a
        JOIN public.central_needs_plan_revisions r2 ON r2.id = a.plan_revision_id
       WHERE a.phase = 'approve' AND a.txid = pg_catalog.txid_current()
         AND r2.plan_id = OLD.plan_id AND r2.id <> OLD.id
         AND r2.status IN ('submitted', 'approved')) THEN
      RAISE EXCEPTION 'central_needs_supersession_without_approval' USING ERRCODE = '23514',
        DETAIL = format('revision=%s', OLD.id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_revision_authority_gate_v1() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER central_needs_plan_revisions_r1_20_authority_gate
  BEFORE INSERT OR UPDATE ON public.central_needs_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_revision_authority_gate_v1();

-- ---------------------------------------------------------------------------
-- 7. Capability seal (ADR §9.7): catalog-derived relation set compared with the
--    manifest, phoenix_cn_policy guarded, explicit ACL manifest checked.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION phoenix_private.central_needs_capability_breaches_v1()
RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH
  nonroot AS (
    SELECT r.oid, r.rolname
      FROM pg_catalog.pg_roles r
     WHERE NOT r.rolsuper
       AND r.rolname !~ '^pg_'
       AND r.oid <> (SELECT d.datdba FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
  ),
  guarded_schema AS (
    SELECT n.oid, n.nspname, n.nspowner
      FROM pg_catalog.pg_namespace n
     WHERE n.nspname IN ('public', 'phoenix_private', 'phoenix_cn_policy')
  ),
  manifest(relname) AS (
    VALUES ('central_needs_plans'), ('central_needs_plan_revisions'), ('central_needs_source_files'),
           ('central_needs_import_sessions'), ('central_needs_source_records'), ('central_needs_record_mappings'),
           ('central_needs_field_overrides'), ('central_needs_import_batches'), ('central_needs_import_batch_entries'),
           ('central_needs_beneficiary_column_mappings'), ('central_needs_beneficiary_regions'),
           ('central_needs_need_lines'), ('central_needs_need_line_sources'), ('central_needs_manual_need_events')
  ),
  cn AS (
    SELECT c.oid, c.relowner, n.nspname, c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE (n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'central\_needs\_%')
        OR (n.nspname = 'phoenix_private' AND c.relname = 'central_needs_lifecycle_attestations')
  ),
  acl_manifest(sig) AS (
    VALUES ('phoenix_cn_policy.actor_scope_org(text)'),
           ('public.phoenix_central_needs_actor_authorized(uuid,text)'),
           ('phoenix_private.central_needs_source_mode_immutable_v1()'),
           ('phoenix_private.central_needs_lineage_mode_v1()'),
           ('phoenix_private.central_needs_manual_event_guard_v1()'),
           ('phoenix_private.central_needs_manual_projection_guard_v1()'),
           ('phoenix_private.central_needs_revision_authority_gate_v1()'),
           ('public._phoenix_central_needs_assert_manual_projection_v1()')
  )
  -- (a) no non-root write, TRUNCATE, REFERENCES, TRIGGER or MAINTAIN on any
  --     Central Needs relation or on the private store
  SELECT pg_catalog.format('%s holds %s on %I.%I', u.rolname, p.priv, cn.nspname, cn.relname)
    FROM nonroot u
   CROSS JOIN cn
   CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')) AS p(priv)
   WHERE u.oid <> cn.relowner
     AND pg_catalog.has_table_privilege(u.oid, cn.oid, p.priv)
  UNION ALL
  SELECT pg_catalog.format('%s holds a column-level %s on %I.%I', u.rolname, p.priv, cn.nspname, cn.relname)
    FROM nonroot u
   CROSS JOIN cn
   CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(priv)
   WHERE u.oid <> cn.relowner
     AND NOT pg_catalog.has_table_privilege(u.oid, cn.oid, p.priv)
     AND pg_catalog.has_any_column_privilege(u.oid, cn.oid, p.priv)
  UNION ALL
  -- (b) no non-root TRIGGER on any relation of the application schema
  SELECT pg_catalog.format('%s holds TRIGGER on public.%I', u.rolname, c.relname)
    FROM nonroot u
   CROSS JOIN pg_catalog.pg_class c
    JOIN guarded_schema s ON s.oid = c.relnamespace AND s.nspname = 'public'
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND u.oid <> c.relowner
     AND pg_catalog.has_table_privilege(u.oid, c.oid, 'TRIGGER')
  UNION ALL
  -- (c) no non-root CREATE on public, the private schema or the policy schema
  SELECT pg_catalog.format('%s holds %s on schema %I', u.rolname, p.priv, s.nspname)
    FROM nonroot u
   CROSS JOIN guarded_schema s
   CROSS JOIN (VALUES ('CREATE')) AS p(priv)
   WHERE u.oid <> s.nspowner
     AND pg_catalog.has_schema_privilege(u.oid, s.oid, p.priv)
  UNION ALL
  -- (d) no object in a guarded schema owned by an API role
  SELECT pg_catalog.format('%s owns %s %I.%I', r.rolname, o.kind, s.nspname, o.name)
    FROM (SELECT c.relowner AS owner, 'relation' AS kind, c.relname::text AS name, c.relnamespace AS ns FROM pg_catalog.pg_class c
          UNION ALL
          SELECT p.proowner, 'routine', p.proname::text, p.pronamespace FROM pg_catalog.pg_proc p
          UNION ALL
          SELECT t.typowner, 'type', t.typname::text, t.typnamespace FROM pg_catalog.pg_type t
          UNION ALL
          SELECT o.oprowner, 'operator', o.oprname::text, o.oprnamespace FROM pg_catalog.pg_operator o) AS o
    JOIN guarded_schema s ON s.oid = o.ns
    JOIN pg_catalog.pg_roles r ON r.oid = o.owner
   WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
  UNION ALL
  -- (e1) the catalog-derived relation set must equal the manifest
  SELECT pg_catalog.format('unlisted_central_needs_relation %I', c.relname)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'central\_needs\_%'
     AND c.relname NOT IN (SELECT relname FROM manifest)
  UNION ALL
  SELECT pg_catalog.format('missing_central_needs_relation %I', m.relname)
    FROM manifest m
   WHERE pg_catalog.to_regclass(pg_catalog.format('public.%I', m.relname)) IS NULL
  UNION ALL
  -- (e2) the explicit ACL manifest: PUBLIC, anon or service_role must not EXECUTE
  SELECT pg_catalog.format('routine %s is executable by %s', m.sig, w.who)
    FROM acl_manifest m
   CROSS JOIN LATERAL (SELECT pg_catalog.to_regprocedure(m.sig) AS oid) r
   CROSS JOIN (VALUES ('anon'), ('service_role')) AS w(who)
   WHERE r.oid IS NOT NULL AND pg_catalog.has_function_privilege(w.who, r.oid, 'EXECUTE')
  UNION ALL
  SELECT pg_catalog.format('routine %s is executable by PUBLIC', m.sig)
    FROM acl_manifest m
   CROSS JOIN LATERAL (SELECT pg_catalog.to_regprocedure(m.sig) AS oid) r
   JOIN pg_catalog.pg_proc p ON p.oid = r.oid
   WHERE EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a WHERE a.grantee = 0)
  UNION ALL
  SELECT pg_catalog.format('manifest routine %s is missing', m.sig)
    FROM acl_manifest m
   WHERE pg_catalog.to_regprocedure(m.sig) IS NULL
  UNION ALL
  -- (e3) the policy schema: USAGE for authenticated only
  SELECT pg_catalog.format('%s holds USAGE on schema phoenix_cn_policy', w.who)
    FROM (VALUES ('anon'), ('service_role')) AS w(who)
   WHERE pg_catalog.to_regnamespace('phoenix_cn_policy') IS NOT NULL
     AND pg_catalog.has_schema_privilege(w.who, 'phoenix_cn_policy', 'USAGE')
  UNION ALL
  SELECT 'PUBLIC holds a privilege on schema phoenix_cn_policy'
   WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n,
                        pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
                  WHERE n.nspname = 'phoenix_cn_policy' AND a.grantee = 0)
$$;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_n int;
  v_order text[];
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_catalog.pg_policy po JOIN pg_catalog.pg_class c ON c.oid = po.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname LIKE 'central\_needs\_%' AND po.polname = 'r1_actor_scope_restrictive'
     AND NOT po.polpermissive AND po.polcmd = 'r';
  IF v_n <> 14 THEN RAISE EXCEPTION 'VERIFY FAILED (R1a02): expected 14 restrictive policies, found %', v_n; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'central\_needs\_%') <> 14 THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a02): relation manifest differs from the catalog';
  END IF;
  SELECT array_agg(t.tgname::text ORDER BY t.tgname::text COLLATE "C") INTO v_order
    FROM pg_catalog.pg_trigger t
   WHERE t.tgrelid = 'public.central_needs_plan_revisions'::regclass AND NOT t.tgisinternal
     AND (t.tgtype & 2) = 2;                       -- BEFORE
  IF v_order IS DISTINCT FROM ARRAY['central_needs_plan_revisions_c5_approval_gate', 'central_needs_plan_revisions_c6_submission_gate',
       'central_needs_plan_revisions_m220_active_item_gate', 'central_needs_plan_revisions_r1_10_source_mode',
       'central_needs_plan_revisions_r1_20_authority_gate', 'set_updated_at'] THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a02): BEFORE trigger order on plan revisions is %', v_order;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
              WHERE t.tgname = 'central_needs_plan_revisions_r1_20_authority_gate' AND cardinality(t.tgattr::int2[]) <> 0) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a02): authority trigger must have no column list';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = 'phoenix_cn_policy.actor_scope_org(text)'::regprocedure
              AND (p.prosrc ~* 'auth\.role\s*\(' OR p.prosrc ~* 'auth\.jwt\s*\(' OR p.prosrc ~* 'super_admin''\s*THEN\s+RETURN')) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a02): predicate must not use auth.role()/auth.jwt() or a super_admin early return';
  END IF;
  -- M224-RBAC-ROOT-FIX: neither eligibility routine may name a role; the membership predicate stays strictly boolean.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              WHERE p.oid IN ('phoenix_cn_policy.actor_scope_org(text)'::regprocedure,
                              'public._phoenix_central_needs_role_eligible_v1()'::regprocedure,
                              'phoenix_private.central_needs_staffing_readiness_v1(uuid)'::regprocedure)
                AND (p.prosrc ~ 'super_admin|central_warehouse_manager|institution_admin|warehouse_officer|outlet_officer|health_center_manager'
                     OR p.prosrc ~* '\.role\M')) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a02): an eligibility routine still names a role';
  END IF;
  IF public._phoenix_central_needs_role_eligible_v1() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a02): the membership predicate must be false (never NULL) without an identity';
  END IF;
  IF EXISTS (SELECT 1 FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS w(who)
              WHERE pg_catalog.has_function_privilege(w.who, 'phoenix_private.central_needs_staffing_readiness_v1(uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a02): the staffing readiness helper is reachable by an API role';
  END IF;
  IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a02): capability seal reports breaches: %',
      (SELECT string_agg(b, '; ') FROM phoenix_private.central_needs_capability_breaches_v1() AS b);
  END IF;
  IF EXISTS (SELECT 1 FROM public.role_permission_defaults WHERE permission_key = 'central_needs.manual_need.set')
     OR EXISTS (SELECT 1 FROM public.profile_permission_overrides WHERE permission_key = 'central_needs.manual_need.set') THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a02): the new key must have no defaults and no grants';
  END IF;
END
$verify$;

-- Readiness record (non-blocking): counts only, one NOTICE per plan-owning organization.
DO $readiness$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT DISTINCT p.organization_id AS org FROM public.central_needs_plans p ORDER BY 1 LOOP
    RAISE NOTICE 'R1a02 staffing readiness: %', phoenix_private.central_needs_staffing_readiness_v1(r.org);
  END LOOP;
END
$readiness$;

COMMIT;

-- ============================================================================
-- 153 — Retire the legacy inter-organization exchange status writer
--
-- The legacy exchange workflow never became a production caller of the
-- canonical stock/custody ledgers. Its transition RPC can still write the
-- historical item_availability projection and legacy movement table, so this
-- migration closes that executable boundary without dropping or rewriting it.
--
-- Scope is intentionally exact:
--   * fail closed unless the one reviewed overload is present;
--   * derive the real status vocabulary from the table CHECK and the terminal
--     set from the active-request partial index;
--   * refuse retirement while any non-terminal legacy request exists;
--   * revoke every external EXECUTE path and retain owner-only execution;
--   * preserve the function body/signature/security settings and all data,
--     table structure, policies, permission keys, and role defaults.
-- ============================================================================

BEGIN;

DO $migration$
DECLARE
  v_signature constant text :=
    'public.phoenix_update_inter_org_exchange_status(uuid,text,integer,integer,text,text)';
  v_expected_statuses constant text[] := ARRAY[
    'cancelled', 'completed', 'dispatched', 'received', 'requested',
    'source_approved', 'source_rejected'
  ]::text[];
  v_expected_terminal_statuses constant text[] := ARRAY[
    'cancelled', 'completed', 'source_rejected'
  ]::text[];
  v_expected_non_terminal_statuses constant text[] := ARRAY[
    'dispatched', 'received', 'requested', 'source_approved'
  ]::text[];
  v_external_roles constant text[] := ARRAY[
    'anon', 'authenticated', 'service_role'
  ]::text[];

  v_fn_count integer;
  v_fn_oid oid;
  v_fn_owner oid;
  v_body_hash_before text;
  v_body_hash_after text;
  v_definition_hash_before text;
  v_definition_hash_after text;
  v_security_definer_before boolean;
  v_search_path_before text[];
  v_status_constraint_count integer;
  v_active_index_count integer;
  v_statuses text[];
  v_terminal_statuses text[];
  v_non_terminal_statuses text[];
  v_live_request_count bigint;
  v_table_schema_hash_before text;
  v_table_schema_hash_after text;
  v_policy_hash_before text;
  v_policy_hash_after text;
  v_permission_key_hash_before text;
  v_permission_key_hash_after text;
  v_role_default_hash_before text;
  v_role_default_hash_after text;
  v_xact_dml_before bigint;
  v_xact_dml_after bigint;
BEGIN
  SELECT count(*), max(p.oid::bigint)::oid
    INTO v_fn_count, v_fn_oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'phoenix_update_inter_org_exchange_status';

  IF v_fn_count <> 1
     OR v_fn_oid IS DISTINCT FROM to_regprocedure(v_signature)::oid THEN
    RAISE EXCEPTION
      'ABORT 153: expected exactly one phoenix_update_inter_org_exchange_status overload with signature %, found %',
      v_signature, v_fn_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(v_external_roles) AS expected(role_name)
    LEFT JOIN pg_roles r ON r.rolname = expected.role_name
    WHERE r.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'ABORT 153: required Supabase external role is missing';
  END IF;

  SELECT count(*)
    INTO v_status_constraint_count
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_attribute a
    ON a.attrelid = t.oid
   AND a.attname = 'status'
   AND NOT a.attisdropped
  WHERE n.nspname = 'public'
    AND t.relname = 'inter_org_exchange_requests'
    AND c.contype = 'c'
    AND c.conkey = ARRAY[a.attnum]::smallint[];

  IF v_status_constraint_count <> 1 THEN
    RAISE EXCEPTION
      'ABORT 153: expected one status-only CHECK on inter_org_exchange_requests, found %',
      v_status_constraint_count;
  END IF;

  SELECT array_agg(DISTINCT captures[1] ORDER BY captures[1])
    INTO v_statuses
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_attribute a
    ON a.attrelid = t.oid
   AND a.attname = 'status'
   AND NOT a.attisdropped
  CROSS JOIN LATERAL regexp_matches(
    pg_get_constraintdef(c.oid, true),
    '''([^'']+)''',
    'g'
  ) AS matches(captures)
  WHERE n.nspname = 'public'
    AND t.relname = 'inter_org_exchange_requests'
    AND c.contype = 'c'
    AND c.conkey = ARRAY[a.attnum]::smallint[];

  IF v_statuses IS DISTINCT FROM v_expected_statuses THEN
    RAISE EXCEPTION
      'ABORT 153: legacy status CHECK drift; expected %, found %',
      v_expected_statuses, v_statuses;
  END IF;

  SELECT count(*)
    INTO v_active_index_count
  FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_class t ON t.oid = x.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'inter_org_exchange_requests'
    AND i.relname = 'inter_org_exchange_requests_active_alert_key_uq'
    AND x.indisunique
    AND x.indpred IS NOT NULL;

  IF v_active_index_count <> 1 THEN
    RAISE EXCEPTION
      'ABORT 153: active-request terminal-status index is missing or ambiguous';
  END IF;

  SELECT array_agg(DISTINCT captures[1] ORDER BY captures[1])
    INTO v_terminal_statuses
  FROM pg_index x
  JOIN pg_class i ON i.oid = x.indexrelid
  JOIN pg_class t ON t.oid = x.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  CROSS JOIN LATERAL regexp_matches(
    pg_get_expr(x.indpred, x.indrelid, true),
    '''([^'']+)''',
    'g'
  ) AS matches(captures)
  WHERE n.nspname = 'public'
    AND t.relname = 'inter_org_exchange_requests'
    AND i.relname = 'inter_org_exchange_requests_active_alert_key_uq'
    AND x.indisunique
    AND x.indpred IS NOT NULL;

  IF v_terminal_statuses IS DISTINCT FROM v_expected_terminal_statuses THEN
    RAISE EXCEPTION
      'ABORT 153: legacy terminal-status contract drift; expected %, found %',
      v_expected_terminal_statuses, v_terminal_statuses;
  END IF;

  SELECT array_agg(status ORDER BY status)
    INTO v_non_terminal_statuses
  FROM unnest(v_statuses) AS allowed(status)
  WHERE NOT (status = ANY(v_terminal_statuses));

  IF v_non_terminal_statuses IS DISTINCT FROM v_expected_non_terminal_statuses THEN
    RAISE EXCEPTION
      'ABORT 153: derived non-terminal status contract drift; expected %, found %',
      v_expected_non_terminal_statuses, v_non_terminal_statuses;
  END IF;

  -- Prevent a request from becoming live between the preflight and COMMIT.
  LOCK TABLE public.inter_org_exchange_requests IN SHARE MODE;

  SELECT count(*)
    INTO v_live_request_count
  FROM public.inter_org_exchange_requests
  WHERE status = ANY(v_non_terminal_statuses);

  IF v_live_request_count <> 0 THEN
    RAISE EXCEPTION
      'ABORT 153: % live legacy exchange request(s) remain in non-terminal statuses %',
      v_live_request_count, v_non_terminal_statuses;
  END IF;

  SELECT p.proowner, md5(p.prosrc), md5(pg_get_functiondef(p.oid)),
         p.prosecdef, p.proconfig
    INTO v_fn_owner, v_body_hash_before, v_definition_hash_before,
         v_security_definer_before, v_search_path_before
  FROM pg_proc p
  WHERE p.oid = v_fn_oid;

  IF NOT v_security_definer_before
     OR v_search_path_before IS DISTINCT FROM ARRAY['search_path=public']::text[] THEN
    RAISE EXCEPTION
      'ABORT 153: reviewed SECURITY DEFINER/search_path contract has drifted';
  END IF;

  SELECT md5(COALESCE(string_agg(entry, E'\n' ORDER BY entry), ''))
    INTO v_table_schema_hash_before
  FROM (
    SELECT format(
      'relation|%s|%s|%s|%s|%s',
      c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
      COALESCE(c.relacl::text, '')
    ) AS entry
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')

    UNION ALL

    SELECT format(
      'column|%s|%s|%s|%s|%s|%s',
      c.relname, a.attnum, a.attname,
      format_type(a.atttypid, a.atttypmod), a.attnotnull,
      COALESCE(pg_get_expr(d.adbin, d.adrelid, true), '')
    )
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND a.attnum > 0
      AND NOT a.attisdropped

    UNION ALL

    SELECT format(
      'constraint|%s|%s|%s',
      c.relname, k.conname, pg_get_constraintdef(k.oid, true)
    )
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')

    UNION ALL

    SELECT format(
      'index|%s|%s|%s',
      t.relname, i.relname, pg_get_indexdef(x.indexrelid, 0, true)
    )
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relkind IN ('r', 'p')
  ) AS table_schema(entry);

  SELECT md5(COALESCE(string_agg(entry, E'\n' ORDER BY entry), ''))
    INTO v_policy_hash_before
  FROM (
    SELECT format(
      '%s|%s|%s|%s|%s|%s|%s',
      t.relname, p.polname, p.polcmd, p.polpermissive, p.polroles::text,
      COALESCE(pg_get_expr(p.polqual, p.polrelid, true), ''),
      COALESCE(pg_get_expr(p.polwithcheck, p.polrelid, true), '')
    ) AS entry
    FROM pg_policy p
    JOIN pg_class t ON t.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
  ) AS policies(entry);

  SELECT md5(COALESCE(
           jsonb_agg(to_jsonb(k) ORDER BY k.key)::text,
           '[]'
         ))
    INTO v_permission_key_hash_before
  FROM public.permission_keys k;

  SELECT md5(COALESCE(
           jsonb_agg(to_jsonb(r) ORDER BY r.role, r.permission_key)::text,
           '[]'
         ))
    INTO v_role_default_hash_before
  FROM public.role_permission_defaults r;

  SELECT COALESCE(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)
    INTO v_xact_dml_before
  FROM pg_stat_xact_user_tables;

  EXECUTE
    'REVOKE ALL PRIVILEGES ON FUNCTION '
    'public.phoenix_update_inter_org_exchange_status('
    'uuid,text,integer,integer,text,text'
    ') FROM PUBLIC, anon, authenticated, service_role';

  SELECT count(*), max(p.oid::bigint)::oid
    INTO v_fn_count, v_fn_oid
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'phoenix_update_inter_org_exchange_status';

  IF v_fn_count <> 1
     OR v_fn_oid IS DISTINCT FROM to_regprocedure(v_signature)::oid THEN
    RAISE EXCEPTION 'VERIFY FAILED (153): function signature/overload changed';
  END IF;

  SELECT md5(p.prosrc), md5(pg_get_functiondef(p.oid))
    INTO v_body_hash_after, v_definition_hash_after
  FROM pg_proc p
  WHERE p.oid = v_fn_oid;

  IF v_body_hash_after IS DISTINCT FROM v_body_hash_before
     OR v_definition_hash_after IS DISTINCT FROM v_definition_hash_before THEN
    RAISE EXCEPTION 'VERIFY FAILED (153): function body or definition changed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(
      COALESCE(p.proacl, acldefault('f', p.proowner))
    ) AS acl
    WHERE p.oid = v_fn_oid
      AND acl.privilege_type = 'EXECUTE'
      AND acl.grantee <> v_fn_owner
  ) THEN
    RAISE EXCEPTION
      'VERIFY FAILED (153): a non-owner EXECUTE ACL remains on the retired writer';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_roles r
    WHERE r.rolname = ANY(v_external_roles)
      AND has_function_privilege(r.oid, v_fn_oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION
      'VERIFY FAILED (153): an external principal still reaches EXECUTE directly or through PUBLIC';
  END IF;

  IF NOT has_function_privilege(v_fn_owner, v_fn_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (153): function owner lost EXECUTE';
  END IF;

  SELECT md5(COALESCE(string_agg(entry, E'\n' ORDER BY entry), ''))
    INTO v_table_schema_hash_after
  FROM (
    SELECT format(
      'relation|%s|%s|%s|%s|%s',
      c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
      COALESCE(c.relacl::text, '')
    ) AS entry
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')

    UNION ALL

    SELECT format(
      'column|%s|%s|%s|%s|%s|%s',
      c.relname, a.attnum, a.attname,
      format_type(a.atttypid, a.atttypmod), a.attnotnull,
      COALESCE(pg_get_expr(d.adbin, d.adrelid, true), '')
    )
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND a.attnum > 0
      AND NOT a.attisdropped

    UNION ALL

    SELECT format(
      'constraint|%s|%s|%s',
      c.relname, k.conname, pg_get_constraintdef(k.oid, true)
    )
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')

    UNION ALL

    SELECT format(
      'index|%s|%s|%s',
      t.relname, i.relname, pg_get_indexdef(x.indexrelid, 0, true)
    )
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relkind IN ('r', 'p')
  ) AS table_schema(entry);

  SELECT md5(COALESCE(string_agg(entry, E'\n' ORDER BY entry), ''))
    INTO v_policy_hash_after
  FROM (
    SELECT format(
      '%s|%s|%s|%s|%s|%s|%s',
      t.relname, p.polname, p.polcmd, p.polpermissive, p.polroles::text,
      COALESCE(pg_get_expr(p.polqual, p.polrelid, true), ''),
      COALESCE(pg_get_expr(p.polwithcheck, p.polrelid, true), '')
    ) AS entry
    FROM pg_policy p
    JOIN pg_class t ON t.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
  ) AS policies(entry);

  SELECT md5(COALESCE(
           jsonb_agg(to_jsonb(k) ORDER BY k.key)::text,
           '[]'
         ))
    INTO v_permission_key_hash_after
  FROM public.permission_keys k;

  SELECT md5(COALESCE(
           jsonb_agg(to_jsonb(r) ORDER BY r.role, r.permission_key)::text,
           '[]'
         ))
    INTO v_role_default_hash_after
  FROM public.role_permission_defaults r;

  SELECT COALESCE(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)
    INTO v_xact_dml_after
  FROM pg_stat_xact_user_tables;

  IF v_table_schema_hash_after IS DISTINCT FROM v_table_schema_hash_before THEN
    RAISE EXCEPTION 'VERIFY FAILED (153): public table structure or ACL changed';
  END IF;
  IF v_policy_hash_after IS DISTINCT FROM v_policy_hash_before THEN
    RAISE EXCEPTION 'VERIFY FAILED (153): RLS policy changed';
  END IF;
  IF v_permission_key_hash_after IS DISTINCT FROM v_permission_key_hash_before THEN
    RAISE EXCEPTION 'VERIFY FAILED (153): permission_keys data changed';
  END IF;
  IF v_role_default_hash_after IS DISTINCT FROM v_role_default_hash_before THEN
    RAISE EXCEPTION 'VERIFY FAILED (153): role_permission_defaults data changed';
  END IF;
  IF v_xact_dml_after IS DISTINCT FROM v_xact_dml_before THEN
    RAISE EXCEPTION 'VERIFY FAILED (153): user-table DML occurred';
  END IF;

  RAISE NOTICE
    '153 verified: statuses=%, terminal=%, non_terminal=%; legacy writer is owner-only',
    v_statuses, v_terminal_statuses, v_non_terminal_statuses;
END;
$migration$;

COMMIT;

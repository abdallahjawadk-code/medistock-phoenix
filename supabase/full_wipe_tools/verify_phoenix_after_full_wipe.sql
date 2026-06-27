-- =============================================================================
-- MediStock Phoenix — Verify After Full Wipe + Rebuild
-- Run AFTER all 4 migrations are applied.
-- Expected final line: OK_FULL_WIPE_PHOENIX_READY
--                  or: BAD_FULL_WIPE_REVIEW_REQUIRED
-- =============================================================================

do $$
declare
  v_pass   boolean := true;
  v_ok     text    := '';
  v_bad    text    := '';
  v_label  text;
  v_result boolean;
begin

  /* 1. public schema */
  v_label := 'public schema exists';
  v_result := exists (select 1 from pg_namespace where nspname = 'public');
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  /* 2. 10 tables */
  v_label := 'table: organizations';
  v_result := to_regclass('public.organizations') is not null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'table: profiles';
  v_result := to_regclass('public.profiles') is not null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'table: warehouses';
  v_result := to_regclass('public.warehouses') is not null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'table: distribution_points';
  v_result := to_regclass('public.distribution_points') is not null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'table: central_items';
  v_result := to_regclass('public.central_items') is not null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'table: local_items';
  v_result := to_regclass('public.local_items') is not null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'table: item_availability';
  v_result := to_regclass('public.item_availability') is not null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'table: qr_targets';
  v_result := to_regclass('public.qr_targets') is not null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'table: qr_tokens';
  v_result := to_regclass('public.qr_tokens') is not null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'table: audit_logs';
  v_result := to_regclass('public.audit_logs') is not null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  /* 3. RLS enabled on all 10 */
  v_label := 'RLS: organizations';
  v_result := coalesce((select relrowsecurity from pg_class where relname = 'organizations'
    and relnamespace = 'public'::regnamespace), false);
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'RLS: profiles';
  v_result := coalesce((select relrowsecurity from pg_class where relname = 'profiles'
    and relnamespace = 'public'::regnamespace), false);
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'RLS: warehouses';
  v_result := coalesce((select relrowsecurity from pg_class where relname = 'warehouses'
    and relnamespace = 'public'::regnamespace), false);
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'RLS: distribution_points';
  v_result := coalesce((select relrowsecurity from pg_class where relname = 'distribution_points'
    and relnamespace = 'public'::regnamespace), false);
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'RLS: central_items';
  v_result := coalesce((select relrowsecurity from pg_class where relname = 'central_items'
    and relnamespace = 'public'::regnamespace), false);
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'RLS: local_items';
  v_result := coalesce((select relrowsecurity from pg_class where relname = 'local_items'
    and relnamespace = 'public'::regnamespace), false);
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'RLS: item_availability';
  v_result := coalesce((select relrowsecurity from pg_class where relname = 'item_availability'
    and relnamespace = 'public'::regnamespace), false);
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'RLS: qr_targets';
  v_result := coalesce((select relrowsecurity from pg_class where relname = 'qr_targets'
    and relnamespace = 'public'::regnamespace), false);
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'RLS: qr_tokens';
  v_result := coalesce((select relrowsecurity from pg_class where relname = 'qr_tokens'
    and relnamespace = 'public'::regnamespace), false);
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'RLS: audit_logs';
  v_result := coalesce((select relrowsecurity from pg_class where relname = 'audit_logs'
    and relnamespace = 'public'::regnamespace), false);
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  /* 4. Triggers */
  v_label := 'trigger: set_updated_at on organizations';
  v_result := exists (select 1 from information_schema.triggers
    where trigger_schema = 'public' and event_object_table = 'organizations'
      and trigger_name = 'set_updated_at');
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'trigger: on_auth_user_created (phoenix version)';
  v_result := exists (select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where c.relname = 'users' and t.tgname = 'on_auth_user_created');
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  /* 5. RPCs */
  v_label := 'rpc: phoenix_my_role';
  v_result := exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'phoenix_my_role');
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'rpc: get_public_qr_payload';
  v_result := exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_public_qr_payload');
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'rpc: create_qr_for_target';
  v_result := exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_qr_for_target');
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'rpc: disable_qr_token';
  v_result := exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'disable_qr_token');
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'rpc: archive_entity';
  v_result := exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'archive_entity');
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'rpc: get_entity_purge_impact';
  v_result := exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_entity_purge_impact');
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'rpc: purge_entity_with_all_data';
  v_result := exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'purge_entity_with_all_data');
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  /* 6. Purge marker */
  v_label := 'purge rpc has MEDISTOCK_PHOENIX_PURGE_V1 marker';
  v_result := exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'purge_entity_with_all_data'
      and pg_get_functiondef(p.oid) like '%MEDISTOCK_PHOENIX_PURGE_V1%');
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  /* 7. Old tables gone */
  v_label := 'old table drug_status is gone';
  v_result := to_regclass('public.drug_status') is null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'old table drug_points is gone';
  v_result := to_regclass('public.drug_points') is null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'old table central_drugs is gone';
  v_result := to_regclass('public.central_drugs') is null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'old table qr_access_tokens is gone';
  v_result := to_regclass('public.qr_access_tokens') is null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'old table qr_entry_registry is gone';
  v_result := to_regclass('public.qr_entry_registry') is null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'old table document_intake_batches gone';
  v_result := to_regclass('public.document_intake_batches') is null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'old table excel_import_batches gone';
  v_result := to_regclass('public.excel_import_batches') is null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'old table ocr_import_batches gone';
  v_result := to_regclass('public.ocr_import_batches') is null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'old table drug_name_aliases gone';
  v_result := to_regclass('public.drug_name_aliases') is null;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  /* 8. Old RPCs gone */
  v_label := 'old rpc purge_drug_point_with_all_data is gone';
  v_result := not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'purge_drug_point_with_all_data');
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'old rpc upsert_document_intake_rows is gone';
  v_result := not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'upsert_document_intake_rows');
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'old rpc get_point_purge_impact is gone';
  v_result := not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'get_point_purge_impact');
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  /* 9. Seed data */
  v_label := 'seed: at least 2 organizations';
  v_result := (select count(*) from organizations) >= 2;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'seed: at least 8 central items';
  v_result := (select count(*) from central_items) >= 8;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'seed: at least 8 availability records';
  v_result := (select count(*) from item_availability) >= 8;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'seed: at least 2 qr tokens';
  v_result := (select count(*) from qr_tokens) >= 2;
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  /* 10. Admin profile (always passes — human must verify) */
  v_ok := v_ok || '  [OK]  super_admin check: verify manually after profile creation' || E'\n';

  /* 11. Supabase internals survive */
  v_label := 'auth schema still exists';
  v_result := exists (select 1 from pg_namespace where nspname = 'auth');
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'storage schema still exists';
  v_result := exists (select 1 from pg_namespace where nspname = 'storage');
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  v_label := 'extensions schema still exists';
  v_result := exists (select 1 from pg_namespace where nspname = 'extensions');
  if v_result then v_ok := v_ok || '  [OK]  ' || v_label || E'\n';
  else             v_bad := v_bad || '  [BAD] ' || v_label || E'\n'; v_pass := false; end if;

  /* VERDICT */
  if v_pass then
    raise notice E'\n=== PASSED ===\n%\nVERDICT: OK_FULL_WIPE_PHOENIX_READY', v_ok;
  else
    raise notice E'\n=== PASSED ===\n%\n=== FAILED ===\n%\nVERDICT: BAD_FULL_WIPE_REVIEW_REQUIRED', v_ok, v_bad;
    raise exception 'BAD_FULL_WIPE_REVIEW_REQUIRED — see notices above';
  end if;
end $$;

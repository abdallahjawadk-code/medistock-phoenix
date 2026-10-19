-- Phase-1 baseline VERIFY (read-only). (The M182 recorded-body proof is a step-level check at M182, see the overlay test; later migrations redefine those functions.) One row per check; every row must be ok = true. Run after the baseline build on the SAME target.
SELECT 'M085 effect: authenticated has NO EXECUTE on the manual availability writers' AS check,
       NOT has_function_privilege('authenticated', 'public.phoenix_upsert_availability(uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text)', 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.phoenix_apply_availability_movement(uuid, text, integer, text, text)', 'EXECUTE') AS ok
UNION ALL SELECT 'M085 effect: service_role keeps EXECUTE',
       has_function_privilege('service_role', 'public.phoenix_upsert_availability(uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text)', 'EXECUTE')
       AND has_function_privilege('service_role', 'public.phoenix_apply_availability_movement(uuid, text, integer, text, text)', 'EXECUTE')
UNION ALL SELECT 'M023 policies present (dp_read_perm / dp_insert_perm / dp_update_perm)',
       (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='distribution_points' AND policyname IN ('dp_read_perm','dp_insert_perm','dp_update_perm')) = 3
UNION ALL SELECT 'M221 procurement guard triggers present (>= 12)',
       (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'phoenix_pda_%guard%') >= 12
UNION ALL SELECT 'Demo protection mechanisms present (M140-M145: manifest, purge function, purger role)',
       to_regclass('public.phoenix_demo_manifest') IS NOT NULL AND to_regprocedure('public.phoenix_demo_purge(text,boolean)') IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'phoenix_demo_purger')
UNION ALL SELECT 'No R1 object present yet (Phase 1 contains no R1)',
       to_regclass('public.central_needs_manual_need_events') IS NULL AND NOT EXISTS (SELECT 1 FROM public.permission_keys WHERE key IN ('central_needs.manual_need.set','central_needs.material_review'))
UNION ALL SELECT 'Demo rows from M004 present (informational: true either way)', true;

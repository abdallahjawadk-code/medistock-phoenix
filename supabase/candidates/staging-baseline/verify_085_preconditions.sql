-- M085 precondition PROOF (read-only). Run in the SAME session, immediately before the attestation GUC is set. Returns one row per condition.
-- The attestation is NOT a bypass: it may be set only when every row below is ok = true AND a named owner attestation exists for the one
-- condition SQL cannot prove (P5: no client reaches a manual quantity writer).
SELECT 'P1 083 derived projection present' AS check,
       to_regprocedure('public.phoenix_available_stock(uuid)') IS NOT NULL AS ok, '' AS detail
UNION ALL
SELECT 'P2 084 visibility setter present',
       to_regprocedure('public.phoenix_set_availability_visibility(uuid, boolean, text)') IS NOT NULL, ''
UNION ALL
-- Parity: the manual quantity route is being retired; any manual-source availability row with a non-zero quantity is a hand-typed stock
-- figure with no derived counterpart proven equal. Zero such rows = parity holds vacuously; otherwise parity must be PROVEN by the owner.
SELECT 'P3 no hand-typed (manual-source) availability quantity exists',
       (SELECT count(*) FROM public.item_availability WHERE source_kind = 'manual' AND coalesce(quantity,0) <> 0) = 0,
       'manual rows with quantity<>0: ' || (SELECT count(*) FROM public.item_availability WHERE source_kind = 'manual' AND coalesce(quantity,0) <> 0)
UNION ALL
SELECT 'P4 actual EXECUTE privileges: authenticated HAS EXECUTE on BOTH manual writers now (has_function_privilege), and neither PUBLIC nor anon can execute either',
       CASE WHEN to_regprocedure('public.phoenix_upsert_availability(uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text)') IS NULL OR to_regprocedure('public.phoenix_apply_availability_movement(uuid, text, integer, text, text)') IS NULL THEN false
            ELSE has_function_privilege('authenticated', to_regprocedure('public.phoenix_upsert_availability(uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text)')::oid, 'EXECUTE')
             AND has_function_privilege('authenticated', to_regprocedure('public.phoenix_apply_availability_movement(uuid, text, integer, text, text)')::oid, 'EXECUTE')
             AND NOT EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                               LEFT JOIN pg_roles r ON r.oid = a.grantee
                              WHERE p.oid IN (to_regprocedure('public.phoenix_upsert_availability(uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text)')::oid, to_regprocedure('public.phoenix_apply_availability_movement(uuid, text, integer, text, text)')::oid)
                                AND a.privilege_type = 'EXECUTE' AND (a.grantee = 0 OR r.rolname = 'anon'))
       END,
       CASE WHEN to_regprocedure('public.phoenix_upsert_availability(uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text)') IS NULL OR to_regprocedure('public.phoenix_apply_availability_movement(uuid, text, integer, text, text)') IS NULL THEN 'a writer is MISSING'
            ELSE 'authenticated: upsert=' || has_function_privilege('authenticated', to_regprocedure('public.phoenix_upsert_availability(uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text)')::oid, 'EXECUTE')::text
                 || ' apply=' || has_function_privilege('authenticated', to_regprocedure('public.phoenix_apply_availability_movement(uuid, text, integer, text, text)')::oid, 'EXECUTE')::text || '; grantees: '
                 || coalesce((SELECT string_agg(p.proname || ' <- ' || coalesce(r.rolname, CASE WHEN a.grantee = 0 THEN 'PUBLIC' END), ', ' ORDER BY p.proname, 2)
                                FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a LEFT JOIN pg_roles r ON r.oid = a.grantee
                               WHERE p.oid IN (to_regprocedure('public.phoenix_upsert_availability(uuid, text, text, text, text, integer, text, date, text, text, text, numeric, text)')::oid, to_regprocedure('public.phoenix_apply_availability_movement(uuid, text, integer, text, text)')::oid) AND a.privilege_type = 'EXECUTE'), 'no EXECUTE grantee') END
UNION ALL
-- Informational: other SECURITY DEFINER bodies that call a writer keep working (M085 revokes EXECUTE from authenticated only; definers run as owner).
SELECT 'P4b callers of the writers inside other functions (informational)', true,
       coalesce((SELECT string_agg(p.proname, ',' ORDER BY p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname NOT IN ('phoenix_upsert_availability', 'phoenix_apply_availability_movement')
                    AND (p.prosrc ILIKE '%phoenix_upsert_availability(%' OR p.prosrc ILIKE '%phoenix_apply_availability_movement(%')), 'none')
UNION ALL
SELECT 'P5 no client reaches a manual quantity writer (NOT provable in SQL - requires a named owner attestation, see builder)', true, 'out-of-band';

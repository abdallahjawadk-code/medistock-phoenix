-- D24 content fingerprint. READ-ONLY. Run with psql -X -A -t on the SOURCE (inside a read-only session) and again on the RESTORED copy; the two JSON documents must be identical.
-- Covers schema shape, every public table's exact row count AND an order-independent digest of its rows, the application schemas, and the set of Auth user ids (ids only, no personal data).
-- It deliberately does NOT cover the storage schema (not part of a logical dump of public + phoenix_*): Storage is proven separately by the manifest.
SELECT json_build_object(
  'pg_major',                  (SELECT current_setting('server_version_num')::int / 10000),
  'tables',                    (SELECT count(*) FROM pg_tables WHERE schemaname = 'public'),
  'policies',                  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
  'functions',                 (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')),
  'extension_functions',       (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')),
  'triggers',                  (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace),
  'constraints',               (SELECT count(*) FROM pg_constraint k WHERE k.connamespace = 'public'::regnamespace),
  'indexes',                   (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'),
  'function_definitions_md5',  (SELECT md5(coalesce(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid::regprocedure::text), '')) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')),
  'app_schemas',               (SELECT coalesce(json_agg(json_build_object('s', n.nspname, 'rels', (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid), 'fns', (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = n.oid)) ORDER BY n.nspname), '[]'::json) FROM pg_namespace n WHERE n.nspname LIKE 'phoenix\_%'),
  'row_counts',                (SELECT coalesce(json_object_agg(c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text::bigint ORDER BY c.relname), '{}'::json) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')),
  'row_digests',               (SELECT coalesce(json_object_agg(c.relname, (xpath('/row/d/text()', query_to_xml(format('select md5(coalesce(string_agg(t::text, ''|'' order by t::text), '''')) as d from public.%I t', c.relname), false, true, '')))[1]::text ORDER BY c.relname), '{}'::json) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')),
  'auth_user_count',           (SELECT count(*) FROM auth.users),
  'auth_user_ids_md5',         (SELECT md5(coalesce(string_agg(id::text, '|' ORDER BY id::text), '')) FROM auth.users)
)::text AS fingerprint;

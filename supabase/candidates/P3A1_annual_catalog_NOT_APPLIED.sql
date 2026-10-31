-- P3-A1: owner/year annual catalog. UNNUMBERED, NOT APPLIED TO HOSTED DATABASES.
-- Requires the exact accepted 001..235 + P1 reservation candidate.
-- No canonical catalog writes, need quantities, approval, allocation or stock effects.
BEGIN;
SET LOCAL search_path = pg_catalog, pg_temp;

DO $pre$
DECLARE actual text;
BEGIN
  IF to_regclass('public.central_needs_catalog_years') IS NOT NULL THEN
    RAISE EXCEPTION 'P3A1_precondition_failed: annual catalog already exists';
  END IF;
  SELECT md5(prosrc) INTO actual FROM pg_proc
   WHERE oid=to_regprocedure('phoenix_private.central_needs_capability_breaches_v1()');
  IF actual IS DISTINCT FROM 'a0bd1f740bcc96adfb074073a9b2f587' THEN
    RAISE EXCEPTION 'P3A1_precondition_failed: P1 capability body drift';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p
    WHERE p.oid=to_regprocedure('phoenix_private.central_needs_capability_breaches_v1()')
      AND (p.prosecdef OR p.proowner<>(SELECT datdba FROM pg_database WHERE datname=current_database())
        OR has_function_privilege('authenticated',p.oid,'EXECUTE')
        OR has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('service_role',p.oid,'EXECUTE'))) THEN
    RAISE EXCEPTION 'P3A1_precondition_failed: capability owner or ACL drift';
  END IF;
  IF EXISTS (SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'P3A1_precondition_failed: capability seal';
  END IF;
END $pre$;

CREATE FUNCTION phoenix_private.annual_catalog_utf16_length_v1(p_text text) RETURNS integer
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
  -- Match the A0 parser's JavaScript string.length for supplementary Unicode.
  SELECT coalesce(sum(CASE WHEN ch='' THEN 0 WHEN ascii(ch)>65535 THEN 2 ELSE 1 END),0)::integer
  FROM regexp_split_to_table(p_text,'') AS ch
$$;

CREATE FUNCTION phoenix_private.annual_catalog_trim_v1(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,pg_temp AS $$
  -- Exactly ECMAScript WhiteSpace + LineTerminator, shared by A0's trim().
  -- Used for validation/search/reasons only; raw source and canonical values stay exact.
  SELECT btrim(p_text,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
$$;

CREATE TABLE public.central_needs_catalog_years (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  planning_year integer NOT NULL CHECK (planning_year BETWEEN 2000 AND 2100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,planning_year)
);
CREATE TABLE public.central_needs_annual_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  planning_year integer NOT NULL,
  central_item_id uuid NOT NULL REFERENCES public.central_items(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('preparing','active','retired')),
  current_field_version_id uuid NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,planning_year,id),
  UNIQUE (organization_id,planning_year,central_item_id),
  FOREIGN KEY (organization_id,planning_year)
    REFERENCES public.central_needs_catalog_years(organization_id,planning_year) ON DELETE RESTRICT
);
CREATE TABLE public.central_needs_annual_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  planning_year integer NOT NULL,
  annual_item_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields)='object'),
  canonical_snapshot jsonb NOT NULL CHECK (jsonb_typeof(canonical_snapshot)='object'),
  canonical_fingerprint text NOT NULL CHECK (canonical_fingerprint ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (phoenix_private.annual_catalog_utf16_length_v1(phoenix_private.annual_catalog_trim_v1(reason)) BETWEEN 1 AND 2000),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,planning_year,annual_item_id,id),
  UNIQUE (organization_id,planning_year,annual_item_id,version_number),
  FOREIGN KEY (organization_id,planning_year,annual_item_id)
    REFERENCES public.central_needs_annual_items(organization_id,planning_year,id) ON DELETE RESTRICT
);
ALTER TABLE public.central_needs_annual_items ADD CONSTRAINT annual_item_head_fk
  FOREIGN KEY (organization_id,planning_year,id,current_field_version_id)
  REFERENCES public.central_needs_annual_versions(organization_id,planning_year,annual_item_id,id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE public.central_needs_annual_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  planning_year integer NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  filename text NOT NULL CHECK (phoenix_private.annual_catalog_utf16_length_v1(filename) BETWEEN 1 AND 255),
  parser jsonb NOT NULL CHECK (jsonb_typeof(parser)='object'),
  attestation text NOT NULL DEFAULT 'client_attested' CHECK (attestation='client_attested'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,planning_year,id),
  UNIQUE (organization_id,planning_year,sha256,parser),
  FOREIGN KEY (organization_id,planning_year)
    REFERENCES public.central_needs_catalog_years(organization_id,planning_year) ON DELETE RESTRICT
);
CREATE TABLE public.central_needs_annual_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  planning_year integer NOT NULL,
  annual_item_id uuid NOT NULL,
  source_id uuid NOT NULL,
  sheet_index integer NOT NULL CHECK (sheet_index BETWEEN 0 AND 999),
  sheet_name text NOT NULL CHECK (phoenix_private.annual_catalog_utf16_length_v1(sheet_name) BETWEEN 1 AND 255),
  row_index integer NOT NULL CHECK (row_index BETWEEN 0 AND 9999),
  block_id text NOT NULL CHECK (phoenix_private.annual_catalog_utf16_length_v1(block_id) BETWEEN 1 AND 200),
  mapping_reference text NOT NULL CHECK (phoenix_private.annual_catalog_utf16_length_v1(mapping_reference) BETWEEN 1 AND 500),
  classification jsonb,
  fields jsonb NOT NULL CHECK (jsonb_typeof(fields)='object'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,planning_year,id),
  UNIQUE (organization_id,planning_year,source_id,sheet_index,block_id,row_index,mapping_reference),
  FOREIGN KEY (organization_id,planning_year,annual_item_id)
    REFERENCES public.central_needs_annual_items(organization_id,planning_year,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,planning_year,source_id)
    REFERENCES public.central_needs_annual_sources(organization_id,planning_year,id) ON DELETE RESTRICT
);
CREATE INDEX annual_occurrences_item_idx
 ON public.central_needs_annual_occurrences(organization_id,planning_year,annual_item_id,id);
CREATE TABLE public.central_needs_annual_request_contexts (
  request_id uuid PRIMARY KEY REFERENCES public.central_needs_material_requests(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL,
  planning_year integer NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,planning_year,request_id),
  FOREIGN KEY (request_id,organization_id)
    REFERENCES public.central_needs_material_requests(id,organization_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,planning_year)
    REFERENCES public.central_needs_catalog_years(organization_id,planning_year) ON DELETE RESTRICT
);
CREATE TABLE public.central_needs_annual_request_resolutions (
  request_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  planning_year integer NOT NULL,
  annual_item_id uuid NOT NULL,
  field_version_id uuid NOT NULL,
  request_version integer NOT NULL CHECK (request_version > 0),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (organization_id,planning_year,request_id)
    REFERENCES public.central_needs_annual_request_contexts(organization_id,planning_year,request_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,planning_year,annual_item_id,field_version_id)
    REFERENCES public.central_needs_annual_versions(organization_id,planning_year,annual_item_id,id) ON DELETE RESTRICT
);
CREATE TABLE public.central_needs_annual_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  planning_year integer NOT NULL,
  actor_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (phoenix_private.annual_catalog_utf16_length_v1(idempotency_key) BETWEEN 8 AND 128),
  action text NOT NULL,
  intent jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id,actor_id,idempotency_key),
  FOREIGN KEY (organization_id,planning_year)
    REFERENCES public.central_needs_catalog_years(organization_id,planning_year) ON DELETE RESTRICT
);

-- RPC-only data: RLS is an additional boundary, not a substitute for revoking DML.
DO $tables$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['central_needs_catalog_years','central_needs_annual_items',
    'central_needs_annual_versions','central_needs_annual_sources','central_needs_annual_occurrences',
    'central_needs_annual_request_contexts','central_needs_annual_request_resolutions','central_needs_annual_receipts']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
    EXECUTE format('CREATE POLICY r1_actor_scope_restrictive ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
      USING (organization_id = (SELECT phoenix_cn_policy.actor_scope_org(''central_needs.view'')))
      WITH CHECK (false)',t);
    IF t NOT IN ('central_needs_catalog_years','central_needs_annual_items') THEN
      EXECUTE format('CREATE TRIGGER annual_append_only BEFORE UPDATE OR DELETE ON public.%I
        FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1()',t);
    END IF;
    EXECUTE format('CREATE TRIGGER annual_no_truncate BEFORE TRUNCATE ON public.%I
      FOR EACH STATEMENT EXECUTE FUNCTION phoenix_private.central_needs_append_only_v1()',t);
  END LOOP;
END $tables$;

CREATE FUNCTION phoenix_private.annual_catalog_identity_guard_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'annual_catalog_history_required' USING ERRCODE='23514';
  END IF;
  IF (NEW.organization_id,NEW.planning_year,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM (OLD.organization_id,OLD.planning_year,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'annual_catalog_scope_immutable' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='central_needs_annual_items' THEN
    IF (NEW.id,NEW.central_item_id) IS DISTINCT FROM (OLD.id,OLD.central_item_id) THEN
      RAISE EXCEPTION 'annual_catalog_identity_immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.current_field_version_id IS DISTINCT FROM OLD.current_field_version_id AND NOT EXISTS (
      SELECT 1 FROM public.central_needs_annual_versions n
      JOIN public.central_needs_annual_versions o ON o.id=OLD.current_field_version_id
      WHERE n.id=NEW.current_field_version_id AND n.organization_id=OLD.organization_id
        AND n.planning_year=OLD.planning_year AND n.annual_item_id=OLD.id
        AND n.version_number=o.version_number+1) THEN
      RAISE EXCEPTION 'annual_catalog_version_sequence_invalid' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER annual_year_identity BEFORE UPDATE OR DELETE ON public.central_needs_catalog_years
 FOR EACH ROW EXECUTE FUNCTION phoenix_private.annual_catalog_identity_guard_v1();
CREATE TRIGGER annual_item_identity BEFORE UPDATE OR DELETE ON public.central_needs_annual_items
 FOR EACH ROW EXECUTE FUNCTION phoenix_private.annual_catalog_identity_guard_v1();

CREATE FUNCTION phoenix_private.annual_catalog_guard_v1(p_org uuid,p_year integer,p_write boolean)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE v_role text;
BEGIN
  IF p_year IS NULL OR p_year NOT BETWEEN 2000 AND 2100 OR p_write IS NULL THEN
    RAISE EXCEPTION 'annual_catalog_scope_invalid' USING ERRCODE='23514';
  END IF;
  IF p_write AND current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'annual_catalog_requires_read_committed' USING ERRCODE='25000';
  END IF;
  v_role:=public._phoenix_central_needs_guard_v1(p_org,'central_needs.view');
  -- Stabilize mutable profile and owner attributes; then re-evaluate the live predicate.
  PERFORM 1 FROM public.profiles WHERE id=auth.uid() FOR SHARE;
  PERFORM 1 FROM public.organizations WHERE id=p_org FOR SHARE;
  v_role:=public._phoenix_central_needs_guard_v1(p_org,'central_needs.view');
  IF p_write THEN PERFORM public._phoenix_central_needs_guard_v1(p_org,'central_needs.edit'); END IF;
  RETURN v_role;
END $$;

CREATE FUNCTION phoenix_private.annual_catalog_year_v1(p_org uuid,p_year integer,p_write boolean)
RETURNS public.central_needs_catalog_years
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE y public.central_needs_catalog_years%ROWTYPE;
BEGIN
  IF p_write THEN
    SELECT * INTO y FROM public.central_needs_catalog_years
     WHERE organization_id=p_org AND planning_year=p_year FOR UPDATE;
  ELSE
    SELECT * INTO y FROM public.central_needs_catalog_years
     WHERE organization_id=p_org AND planning_year=p_year;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'annual_catalog_year_missing' USING ERRCODE='P0002'; END IF;
  IF p_write AND y.status<>'active' THEN
    RAISE EXCEPTION 'annual_catalog_year_inactive' USING ERRCODE='23514';
  END IF;
  RETURN y;
END $$;

CREATE FUNCTION phoenix_private.annual_catalog_hash_v1(p_json jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT encode(sha256(convert_to(p_json::text,'UTF8')),'hex')
$$;
CREATE FUNCTION phoenix_private.annual_catalog_canonical_v1(p_id uuid,p_lock boolean) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE c public.central_items%ROWTYPE;
BEGIN
  IF p_lock THEN SELECT * INTO c FROM public.central_items WHERE id=p_id FOR SHARE;
  ELSE SELECT * INTO c FROM public.central_items WHERE id=p_id; END IF;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('canonicalItemId',c.id,'scientificName',c.name,'nameAr',c.name_ar,
    'nationalCode',c.national_code,'barcode',c.barcode,'dosageForm',c.dosage_form,
    'concentration',c.concentration,'unit',c.unit,'status',c.status);
END $$;
CREATE FUNCTION phoenix_private.annual_catalog_missing_v1(p_snapshot jsonb) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE missing text[]:='{}'; f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['scientificName','nationalCode','unit'] LOOP
    IF nullif(phoenix_private.annual_catalog_trim_v1(p_snapshot->>f),'') IS NULL THEN missing:=array_append(missing,f); END IF;
  END LOOP;
  IF nullif(phoenix_private.annual_catalog_trim_v1(p_snapshot->>'unit'),'') IS NOT NULL AND
     p_snapshot->>'unit' NOT IN ('box','vial','ampoule','tablet','bottle','tube','sachet','other','test') THEN
    missing:=array_append(missing,'unit');
  END IF;
  RETURN missing;
END $$;
CREATE FUNCTION phoenix_private.annual_catalog_fields_v1(p_snapshot jsonb,p_reason text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE fields jsonb:='{}'; f text; v text;
BEGIN
  FOREACH f IN ARRAY ARRAY['scientificName','nameAr','nationalCode','barcode','dosageForm','concentration','unit'] LOOP
    v:=p_snapshot->>f;
    fields:=fields||jsonb_build_object(f,CASE WHEN nullif(phoenix_private.annual_catalog_trim_v1(v),'') IS NULL
      THEN jsonb_build_object('state','missing','reason','canonical_missing')
      ELSE jsonb_build_object('state','known','value',v,'origins',jsonb_build_array(jsonb_build_object(
        'kind','canonical','canonicalItemId',p_snapshot->>'canonicalItemId','decisionReference',p_reason))) END);
  END LOOP;
  RETURN fields;
END $$;
CREATE FUNCTION phoenix_private.annual_catalog_reason_v1(p_reason text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF p_reason IS NULL OR phoenix_private.annual_catalog_utf16_length_v1(phoenix_private.annual_catalog_trim_v1(p_reason)) NOT BETWEEN 1 AND 2000 OR p_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'annual_catalog_reason_required' USING ERRCODE='23514';
  END IF;
  RETURN phoenix_private.annual_catalog_trim_v1(p_reason);
END $$;
CREATE FUNCTION phoenix_private.annual_catalog_replay_v1(p_org uuid,p_year integer,p_key text,p_action text,p_intent jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE r public.central_needs_annual_receipts%ROWTYPE;
BEGIN
  IF p_key IS NULL OR phoenix_private.annual_catalog_utf16_length_v1(p_key) NOT BETWEEN 8 AND 128 OR p_key<>phoenix_private.annual_catalog_trim_v1(p_key) OR p_key ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'annual_catalog_idempotency_key_invalid' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_org::text||':'||auth.uid()::text||':'||p_key,310001));
  SELECT * INTO r FROM public.central_needs_annual_receipts
   WHERE organization_id=p_org AND actor_id=auth.uid() AND idempotency_key=p_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF r.planning_year IS DISTINCT FROM p_year OR r.action IS DISTINCT FROM p_action OR r.intent IS DISTINCT FROM p_intent THEN
    RAISE EXCEPTION 'annual_catalog_idempotency_conflict' USING ERRCODE='23505';
  END IF;
  IF r.result ? 'membership' THEN
    RETURN r.result||jsonb_build_object('idempotentReplay',true,'selectable',false,
      'selectionBlockers',coalesce(r.result->'selectionBlockers','[]'::jsonb)||jsonb_build_array('receipt_replay_requires_refresh'));
  END IF;
  RETURN r.result||jsonb_build_object('idempotentReplay',true);
END $$;
CREATE FUNCTION phoenix_private.annual_catalog_receipt_v1(
 p_org uuid,p_year integer,p_key text,p_action text,p_intent jsonb,p_result jsonb,p_role text,p_entity uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  INSERT INTO public.central_needs_annual_receipts(organization_id,planning_year,actor_id,idempotency_key,action,intent,result)
   VALUES(p_org,p_year,auth.uid(),p_key,p_action,p_intent,p_result||jsonb_build_object('idempotentReplay',false));
  INSERT INTO public.audit_logs(organization_id,actor_id,actor_role,action,entity_type,entity_id,payload)
   VALUES(p_org,auth.uid(),p_role,'central_needs.annual_catalog.'||p_action,'annual_catalog',p_entity,
     jsonb_build_object('planning_year',p_year,'intent_sha256',phoenix_private.annual_catalog_hash_v1(p_intent),
       'annual_item_id',p_result#>>'{membership,annualItemId}','request_id',p_result->>'requestId'));
  RETURN p_result||jsonb_build_object('idempotentReplay',false);
END $$;

CREATE FUNCTION phoenix_private.annual_catalog_object_v1(p_value jsonb,p_allowed text[],p_required text[])
RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'annual_catalog_payload_invalid' USING ERRCODE='23514';
  END IF;
  IF NOT (p_value ?& p_required) OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_value) k WHERE NOT(k=ANY(p_allowed))) THEN
    RAISE EXCEPTION 'annual_catalog_payload_invalid' USING ERRCODE='23514';
  END IF;
END $$;
CREATE FUNCTION phoenix_private.annual_catalog_text_v1(p_value jsonb,p_max integer,p_empty boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE t text;
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'annual_catalog_text_invalid' USING ERRCODE='23514';
  END IF;
  t:=p_value#>>'{}';
  IF phoenix_private.annual_catalog_utf16_length_v1(t)>p_max OR (NOT p_empty AND nullif(phoenix_private.annual_catalog_trim_v1(t),'') IS NULL) OR t ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'annual_catalog_text_invalid' USING ERRCODE='23514';
  END IF;
END $$;
CREATE FUNCTION phoenix_private.annual_catalog_cell_v1(p_cell jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE r integer; c integer; n integer; letters text:=''; k text; value_type text;
BEGIN
  PERFORM phoenix_private.annual_catalog_object_v1(p_cell,
    ARRAY['coordinate','presence','valueType','rawValue','errorCode','formattedText','formula','isFormula','hasComment'],
    ARRAY['coordinate','presence','rawValue','isFormula','hasComment']);
  PERFORM phoenix_private.annual_catalog_object_v1(p_cell->'coordinate',ARRAY['row','col','a1'],ARRAY['row','col','a1']);
  IF jsonb_typeof(p_cell#>'{coordinate,row}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_cell#>'{coordinate,col}') IS DISTINCT FROM 'number'
    OR (p_cell#>>'{coordinate,row}') !~ '^[0-9]{1,4}$'
    OR (p_cell#>>'{coordinate,col}') !~ '^[0-9]{1,3}$' THEN
    RAISE EXCEPTION 'annual_catalog_coordinate_invalid' USING ERRCODE='23514';
  END IF;
  r:=(p_cell#>>'{coordinate,row}')::integer; c:=(p_cell#>>'{coordinate,col}')::integer;
  IF c>255 OR jsonb_typeof(p_cell#>'{coordinate,a1}') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'annual_catalog_coordinate_invalid' USING ERRCODE='23514';
  END IF;
  n:=c+1;
  WHILE n>0 LOOP n:=n-1; letters:=chr(65+n%26)||letters; n:=n/26; END LOOP;
  IF p_cell#>>'{coordinate,a1}' IS DISTINCT FROM letters||(r+1)::text THEN
    RAISE EXCEPTION 'annual_catalog_coordinate_invalid' USING ERRCODE='23514';
  END IF;
  IF jsonb_typeof(p_cell->'isFormula') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p_cell->'hasComment') IS DISTINCT FROM 'boolean'
    OR p_cell->>'presence' NOT IN ('missing','blank','value') OR p_cell->>'presence' IS NULL THEN
    RAISE EXCEPTION 'annual_catalog_cell_invalid' USING ERRCODE='23514';
  END IF;
  FOREACH k IN ARRAY ARRAY['formattedText','formula','errorCode'] LOOP
    IF p_cell ? k AND (jsonb_typeof(p_cell->k) IS DISTINCT FROM 'string' OR phoenix_private.annual_catalog_utf16_length_v1(p_cell->>k)>16000) THEN
      RAISE EXCEPTION 'annual_catalog_cell_invalid' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF (p_cell->>'isFormula')::boolean IS DISTINCT FROM (p_cell ? 'formula') THEN
    RAISE EXCEPTION 'annual_catalog_cell_invalid' USING ERRCODE='23514';
  END IF;
  IF p_cell->>'presence'<>'value' THEN
    IF p_cell->'rawValue' IS DISTINCT FROM 'null'::jsonb OR p_cell ? 'valueType' THEN
      RAISE EXCEPTION 'annual_catalog_cell_invalid' USING ERRCODE='23514';
    END IF;
  ELSE
    value_type:=p_cell->>'valueType';
    IF value_type IS NULL OR value_type NOT IN ('number','string','boolean','date','error')
      OR (value_type IN ('number','date') AND jsonb_typeof(p_cell->'rawValue') IS DISTINCT FROM 'number')
      OR (value_type IN ('string','error') AND jsonb_typeof(p_cell->'rawValue') IS DISTINCT FROM 'string')
      OR (value_type='boolean' AND jsonb_typeof(p_cell->'rawValue') IS DISTINCT FROM 'boolean')
      OR phoenix_private.annual_catalog_utf16_length_v1(p_cell->>'rawValue')>16000 THEN
      RAISE EXCEPTION 'annual_catalog_cell_invalid' USING ERRCODE='23514';
    END IF;
  END IF;
END $$;
CREATE FUNCTION phoenix_private.annual_catalog_observation_v1(p_observation jsonb,p_field text,p_row integer)
RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $$
DECLARE w jsonb; c jsonb; h jsonb; expected_state text; expected_reason text; v text;
BEGIN
  PERFORM phoenix_private.annual_catalog_object_v1(p_observation,ARRAY['state','text','reason','witness'],ARRAY['state','witness']);
  w:=p_observation->'witness';
  IF w='null'::jsonb THEN
    IF p_observation IS DISTINCT FROM jsonb_build_object('state','missing','reason','unmapped','witness',NULL) THEN
      RAISE EXCEPTION 'annual_catalog_observation_invalid' USING ERRCODE='23514';
    END IF;
    RETURN;
  END IF;
  PERFORM phoenix_private.annual_catalog_object_v1(w,ARRAY['field','cell','header'],ARRAY['field','cell','header']);
  IF w->>'field' IS DISTINCT FROM p_field THEN
    RAISE EXCEPTION 'annual_catalog_observation_invalid' USING ERRCODE='23514';
  END IF;
  c:=w->'cell'; h:=w->'header';
  PERFORM phoenix_private.annual_catalog_cell_v1(c);
  PERFORM phoenix_private.annual_catalog_cell_v1(h);
  IF (c#>>'{coordinate,row}')::integer<>p_row OR h#>>'{coordinate,col}' IS DISTINCT FROM c#>>'{coordinate,col}'
    OR (h#>>'{coordinate,row}')::integer>=p_row
    OR h->>'presence' IS DISTINCT FROM 'value' OR h->>'valueType' IS DISTINCT FROM 'string'
    OR h->'isFormula' IS DISTINCT FROM 'false'::jsonb OR nullif(phoenix_private.annual_catalog_trim_v1(h->>'rawValue'),'') IS NULL
    OR phoenix_private.annual_catalog_utf16_length_v1(h->>'rawValue')>4000 THEN
    RAISE EXCEPTION 'annual_catalog_header_invalid' USING ERRCODE='23514';
  END IF;
  v:=c->>'rawValue';
  IF c->>'presence'='missing' THEN expected_state:='missing'; expected_reason:='missing_cell';
  ELSIF c->>'presence'='blank' THEN expected_state:='missing'; expected_reason:='blank';
  ELSIF (c->>'isFormula')::boolean THEN expected_state:='invalid'; expected_reason:='formula';
  ELSIF c->>'valueType'<>'string' THEN expected_state:='invalid'; expected_reason:='non_text';
  ELSIF phoenix_private.annual_catalog_utf16_length_v1(v)>4000 THEN expected_state:='invalid'; expected_reason:='text_too_long';
  ELSIF v ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' THEN expected_state:='invalid'; expected_reason:='control_text';
  ELSIF nullif(phoenix_private.annual_catalog_trim_v1(v),'') IS NULL THEN expected_state:='missing'; expected_reason:='empty_text';
  ELSE expected_state:='value'; END IF;
  IF expected_state='value' THEN
    IF p_observation IS DISTINCT FROM jsonb_build_object('state','value','text',v,'witness',w) THEN
      RAISE EXCEPTION 'annual_catalog_observation_invalid' USING ERRCODE='23514';
    END IF;
  ELSIF p_observation IS DISTINCT FROM jsonb_build_object('state',expected_state,'reason',expected_reason,'witness',w) THEN
    RAISE EXCEPTION 'annual_catalog_observation_invalid' USING ERRCODE='23514';
  END IF;
END $$;

CREATE FUNCTION phoenix_private.annual_catalog_capture_v1(p_org uuid,p_year integer,p_item uuid,p_occurrences jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE o jsonb; s jsonb; v_parser jsonb; v_classification jsonb; f text; col text; cols text[];
  src public.central_needs_annual_sources%ROWTYPE; prior public.central_needs_annual_occurrences%ROWTYPE;
  v_row_index integer; v_sheet_index integer;
  fields constant text[]:=ARRAY['scientificName','nameAr','nationalCode','currentNationalCode','previousNationalCode','barcode','dosageForm','concentration','unit'];
BEGIN
  IF jsonb_typeof(p_occurrences) IS DISTINCT FROM 'array' OR octet_length(p_occurrences::text)>2097152 THEN
    RAISE EXCEPTION 'annual_catalog_source_limit' USING ERRCODE='23514';
  END IF;
  IF jsonb_array_length(p_occurrences)>100 THEN
    RAISE EXCEPTION 'annual_catalog_source_limit' USING ERRCODE='23514';
  END IF;
  FOR o IN SELECT value FROM jsonb_array_elements(p_occurrences) LOOP
    PERFORM phoenix_private.annual_catalog_object_v1(o,ARRAY['occurrenceKey','scope','source','classification','fields'],
      ARRAY['occurrenceKey','scope','source','classification','fields']);
    PERFORM phoenix_private.annual_catalog_text_v1(o->'occurrenceKey',2000);
    IF o->'scope' IS DISTINCT FROM jsonb_build_object('ownerOrgId',p_org,'planningYear',p_year) THEN
      RAISE EXCEPTION 'annual_catalog_source_scope_mismatch' USING ERRCODE='23514';
    END IF;
    s:=o->'source'; v_parser:=s->'parser'; v_classification:=nullif(o->'classification','null'::jsonb);
    PERFORM phoenix_private.annual_catalog_object_v1(s,
      ARRAY['sourceId','filename','sha256','parser','sheetIndex','sheetName','row','blockId','mappingReference'],
      ARRAY['sourceId','filename','sha256','parser','sheetIndex','sheetName','row','blockId','mappingReference']);
    PERFORM phoenix_private.annual_catalog_text_v1(s->'sourceId',500);
    PERFORM phoenix_private.annual_catalog_text_v1(s->'filename',255);
    PERFORM phoenix_private.annual_catalog_text_v1(s->'sheetName',255);
    PERFORM phoenix_private.annual_catalog_text_v1(s->'blockId',200);
    PERFORM phoenix_private.annual_catalog_text_v1(s->'mappingReference',500);
    IF s->>'filename' ~ '[/\\]' OR s->>'sha256' !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(s->'sha256') IS DISTINCT FROM 'string'
      OR jsonb_typeof(s->'row') IS DISTINCT FROM 'number' OR s->>'row' !~ '^[0-9]{1,4}$'
      OR jsonb_typeof(s->'sheetIndex') IS DISTINCT FROM 'number' OR s->>'sheetIndex' !~ '^[0-9]{1,3}$' THEN
      RAISE EXCEPTION 'annual_catalog_source_invalid' USING ERRCODE='23514';
    END IF;
    v_row_index:=(s->>'row')::integer; v_sheet_index:=(s->>'sheetIndex')::integer;
    PERFORM phoenix_private.annual_catalog_object_v1(v_parser,
      ARRAY['contractVersion','sheetjsVersion','sheetjsTarballSha256','runtime'],
      ARRAY['contractVersion','sheetjsVersion','sheetjsTarballSha256','runtime']);
    IF v_parser->>'contractVersion' IS DISTINCT FROM '1.2.0' OR v_parser->>'sheetjsVersion' IS DISTINCT FROM '0.20.3'
      OR v_parser->>'sheetjsTarballSha256' IS DISTINCT FROM '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8'
      OR v_parser->>'runtime' IS NULL OR v_parser->>'runtime' NOT IN ('node','browser_worker') THEN
      RAISE EXCEPTION 'annual_catalog_parser_contract_mismatch' USING ERRCODE='23514';
    END IF;
    IF v_classification IS NOT NULL THEN
      PERFORM phoenix_private.annual_catalog_object_v1(v_classification,ARRAY['label','origin','reference'],ARRAY['label','origin','reference']);
      PERFORM phoenix_private.annual_catalog_text_v1(v_classification->'label',500);
      PERFORM phoenix_private.annual_catalog_text_v1(v_classification->'reference',500);
      IF v_classification->>'origin' IS NULL OR v_classification->>'origin' NOT IN ('source','proposed') THEN
        RAISE EXCEPTION 'annual_catalog_classification_invalid' USING ERRCODE='23514';
      END IF;
    END IF;
    PERFORM phoenix_private.annual_catalog_object_v1(o->'fields',fields,fields);
    cols:='{}';
    FOREACH f IN ARRAY fields LOOP
      PERFORM phoenix_private.annual_catalog_observation_v1(o#>ARRAY['fields',f],f,v_row_index);
      col:=o#>>ARRAY['fields',f,'witness','cell','coordinate','col'];
      IF col IS NOT NULL THEN
        IF col=ANY(cols) THEN RAISE EXCEPTION 'annual_catalog_duplicate_column' USING ERRCODE='23514'; END IF;
        cols:=array_append(cols,col);
      END IF;
    END LOOP;
    IF o#>'{fields,scientificName,witness}'='null'::jsonb THEN
      RAISE EXCEPTION 'annual_catalog_name_mapping_required' USING ERRCODE='23514';
    END IF;
    SELECT * INTO src FROM public.central_needs_annual_sources
     WHERE organization_id=p_org AND planning_year=p_year AND sha256=s->>'sha256' AND public.central_needs_annual_sources.parser=v_parser;
    IF FOUND THEN
      IF src.filename IS DISTINCT FROM s->>'filename' THEN
        RAISE EXCEPTION 'annual_catalog_source_metadata_conflict' USING ERRCODE='23514';
      END IF;
    ELSE
      INSERT INTO public.central_needs_annual_sources(organization_id,planning_year,sha256,filename,parser,created_by)
       VALUES(p_org,p_year,s->>'sha256',s->>'filename',v_parser,auth.uid()) RETURNING * INTO src;
    END IF;
    SELECT * INTO prior FROM public.central_needs_annual_occurrences
     WHERE organization_id=p_org AND planning_year=p_year AND source_id=src.id
       AND public.central_needs_annual_occurrences.sheet_index=v_sheet_index
       AND public.central_needs_annual_occurrences.row_index=v_row_index
       AND block_id=s->>'blockId' AND mapping_reference=s->>'mappingReference';
    IF FOUND THEN
      IF (prior.annual_item_id,prior.sheet_name,prior.classification,prior.fields)
        IS DISTINCT FROM (p_item,s->>'sheetName',v_classification,o->'fields') THEN
        RAISE EXCEPTION 'annual_catalog_witness_conflict' USING ERRCODE='23514';
      END IF;
    ELSE
      INSERT INTO public.central_needs_annual_occurrences(organization_id,planning_year,annual_item_id,source_id,
        sheet_index,sheet_name,row_index,block_id,mapping_reference,classification,fields,created_by)
      VALUES(p_org,p_year,p_item,src.id,v_sheet_index,s->>'sheetName',v_row_index,s->>'blockId',s->>'mappingReference',v_classification,o->'fields',auth.uid());
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.central_needs_annual_occurrences
       WHERE organization_id=p_org AND planning_year=p_year AND annual_item_id=p_item)>500 THEN
    RAISE EXCEPTION 'annual_catalog_item_source_limit' USING ERRCODE='23514';
  END IF;
END $$;

CREATE FUNCTION phoenix_private.annual_catalog_item_result_v1(p_org uuid,p_year integer,p_item uuid,p_version uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE i public.central_needs_annual_items%ROWTYPE; v public.central_needs_annual_versions%ROWTYPE;
  y public.central_needs_catalog_years%ROWTYPE; c jsonb; keys jsonb; blockers text[]:='{}'; drift boolean;
  scope jsonb:=jsonb_build_object('ownerOrgId',p_org,'planningYear',p_year);
BEGIN
  SELECT * INTO i FROM public.central_needs_annual_items WHERE organization_id=p_org AND planning_year=p_year AND id=p_item;
  IF NOT FOUND THEN RAISE EXCEPTION 'annual_catalog_item_missing' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v FROM public.central_needs_annual_versions WHERE organization_id=p_org AND planning_year=p_year
    AND annual_item_id=p_item AND id=coalesce(p_version,i.current_field_version_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'annual_catalog_version_missing' USING ERRCODE='P0002'; END IF;
  SELECT * INTO y FROM public.central_needs_catalog_years WHERE organization_id=p_org AND planning_year=p_year;
  c:=phoenix_private.annual_catalog_canonical_v1(i.central_item_id,false);
  drift:=v.canonical_fingerprint IS DISTINCT FROM phoenix_private.annual_catalog_hash_v1(c);
  IF y.status<>'active' THEN blockers:=array_append(blockers,'year_inactive'); END IF;
  IF i.status<>'active' THEN blockers:=array_append(blockers,'member_'||i.status); END IF;
  IF v.id<>i.current_field_version_id THEN blockers:=array_append(blockers,'historical_version'); END IF;
  IF c IS NULL OR c->>'status' IS DISTINCT FROM 'active' THEN blockers:=array_append(blockers,'canonical_inactive'); END IF;
  IF drift THEN blockers:=array_append(blockers,'canonical_drift'); END IF;
  blockers:=blockers||phoenix_private.annual_catalog_missing_v1(v.canonical_snapshot);
  SELECT coalesce(jsonb_agg(o.id ORDER BY o.id),'[]'::jsonb) INTO keys FROM public.central_needs_annual_occurrences o
    WHERE o.organization_id=p_org AND o.planning_year=p_year AND o.annual_item_id=p_item;
  RETURN jsonb_build_object('scope',scope,
    'membership',jsonb_build_object('scope',scope,'annualItemId',i.id,'canonicalItemId',i.central_item_id,
      'status',i.status,'currentFieldVersionId',i.current_field_version_id,'occurrenceKeys',keys),
    'fieldVersion',jsonb_build_object('scope',scope,'annualItemId',i.id,'fieldVersionId',v.id,
      'versionNumber',v.version_number,'fields',v.fields),
    'canonicalFingerprint',v.canonical_fingerprint,'canonicalDrift',drift,
    'selectable',cardinality(blockers)=0,'selectionBlockers',to_jsonb(blockers),
    'sourceOccurrenceCount',jsonb_array_length(keys),'sourceAttestation','client_attested');
END $$;

CREATE FUNCTION public.phoenix_central_needs_annual_catalog_contract() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
 SELECT jsonb_build_object('version',1,'scope','owner_year','canonicalSnapshots',true,
   'sourceAttestation','client_attested','quantityBinding',false)
$$;
CREATE FUNCTION public.phoenix_central_needs_open_catalog_year(
 p_organization_id uuid,p_planning_year integer,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE role_name text; result jsonb; intent jsonb; y public.central_needs_catalog_years%ROWTYPE;
BEGIN
  role_name:=phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,true);
  intent:=jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year);
  result:=phoenix_private.annual_catalog_replay_v1(p_organization_id,p_planning_year,p_idempotency_key,'open_year',intent);
  IF result IS NOT NULL THEN RETURN result; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_planning_year::text,310002));
  INSERT INTO public.central_needs_catalog_years(organization_id,planning_year,created_by)
    VALUES(p_organization_id,p_planning_year,auth.uid()) ON CONFLICT DO NOTHING;
  y:=phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,true);
  result:=jsonb_build_object('scope',intent,'year',jsonb_build_object(
    'planningYear',y.planning_year,'status',y.status,'createdAt',y.created_at));
  RETURN phoenix_private.annual_catalog_receipt_v1(p_organization_id,p_planning_year,p_idempotency_key,'open_year',intent,result,role_name,NULL);
END $$;
CREATE FUNCTION public.phoenix_central_needs_list_catalog_years(
 p_organization_id uuid,p_limit integer,p_after_year integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE rows jsonb; next_year integer;
BEGIN
  PERFORM phoenix_private.annual_catalog_guard_v1(p_organization_id,2000,false);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR (p_after_year IS NOT NULL AND p_after_year NOT BETWEEN 2000 AND 2100) THEN
    RAISE EXCEPTION 'annual_catalog_page_invalid' USING ERRCODE='23514';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('planningYear',planning_year,'status',status,'createdAt',created_at)
    ORDER BY planning_year DESC),'[]'::jsonb) INTO rows
    FROM (SELECT * FROM public.central_needs_catalog_years WHERE organization_id=p_organization_id
      AND (p_after_year IS NULL OR planning_year<p_after_year) ORDER BY planning_year DESC LIMIT p_limit+1) page;
  IF jsonb_array_length(rows)>p_limit THEN
    next_year:=(rows->(p_limit-1)->>'planningYear')::integer; rows:=rows-p_limit;
  END IF;
  RETURN jsonb_build_object('ownerOrgId',p_organization_id,'years',rows,'nextAfterYear',next_year);
END $$;
CREATE FUNCTION public.phoenix_central_needs_preview_annual_canonical(
 p_organization_id uuid,p_planning_year integer,p_central_item_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE c jsonb; y public.central_needs_catalog_years%ROWTYPE; missing text[];
BEGIN
  PERFORM phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,false);
  y:=phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,false);
  c:=phoenix_private.annual_catalog_canonical_v1(p_central_item_id,false);
  IF c IS NULL THEN RAISE EXCEPTION 'annual_catalog_canonical_missing' USING ERRCODE='P0002'; END IF;
  missing:=phoenix_private.annual_catalog_missing_v1(c);
  RETURN jsonb_build_object('scope',jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year),
    'canonicalItemId',p_central_item_id,'canonicalSnapshot',c,'canonicalFingerprint',phoenix_private.annual_catalog_hash_v1(c),
    'eligible',y.status='active' AND c->>'status'='active' AND cardinality(missing)=0,'missingRequired',to_jsonb(missing));
END $$;
CREATE FUNCTION public.phoenix_central_needs_get_annual_catalog_item(
 p_organization_id uuid,p_planning_year integer,p_annual_item_id uuid,p_field_version_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  PERFORM phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,false);
  PERFORM phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,false);
  RETURN phoenix_private.annual_catalog_item_result_v1(p_organization_id,p_planning_year,p_annual_item_id,p_field_version_id);
END $$;
CREATE FUNCTION public.phoenix_central_needs_search_annual_catalog(
 p_organization_id uuid,p_planning_year integer,p_query text,p_limit integer,p_cursor jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE query_text text:=phoenix_private.annual_catalog_trim_v1(p_query); after_rank integer:=-1; after_id uuid; page record;
  items jsonb:='[]'; next_cursor jsonb; last_id uuid; last_rank integer; count_rows integer:=0;
BEGIN
  PERFORM phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,false);
  PERFORM phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,false);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR query_text IS NULL OR phoenix_private.annual_catalog_utf16_length_v1(query_text)>200 OR query_text ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'annual_catalog_page_invalid' USING ERRCODE='23514';
  END IF;
  IF p_cursor IS NOT NULL THEN
    PERFORM phoenix_private.annual_catalog_object_v1(p_cursor,ARRAY['ownerOrgId','planningYear','query','rank','annualItemId'],
      ARRAY['ownerOrgId','planningYear','query','rank','annualItemId']);
    IF p_cursor->'ownerOrgId' IS DISTINCT FROM to_jsonb(p_organization_id)
      OR p_cursor->'planningYear' IS DISTINCT FROM to_jsonb(p_planning_year)
      OR p_cursor->'query' IS DISTINCT FROM to_jsonb(query_text)
      OR p_cursor->'rank' NOT IN ('0'::jsonb,'1'::jsonb) OR p_cursor->'rank'='null'::jsonb
      OR jsonb_typeof(p_cursor->'annualItemId') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'annual_catalog_cursor_scope_mismatch' USING ERRCODE='23514';
    END IF;
    after_rank:=(p_cursor->>'rank')::integer; after_id:=(p_cursor->>'annualItemId')::uuid;
  END IF;
  FOR page IN
    SELECT * FROM (
      SELECT i.id,CASE WHEN query_text<>'' AND v.canonical_snapshot->>'nationalCode'=query_text THEN 0 ELSE 1 END rank
      FROM public.central_needs_annual_items i JOIN public.central_needs_annual_versions v
        ON (v.organization_id,v.planning_year,v.annual_item_id,v.id)=(i.organization_id,i.planning_year,i.id,i.current_field_version_id)
      WHERE i.organization_id=p_organization_id AND i.planning_year=p_planning_year
        AND (query_text='' OR position(lower(query_text) IN lower(coalesce(v.canonical_snapshot->>'scientificName','')))>0
          OR position(lower(query_text) IN lower(coalesce(v.canonical_snapshot->>'nameAr','')))>0
          OR position(lower(query_text) IN lower(coalesce(v.canonical_snapshot->>'nationalCode','')))>0)
    ) scoped WHERE rank>after_rank OR (rank=after_rank AND id>after_id)
    ORDER BY rank,id LIMIT p_limit+1
  LOOP
    count_rows:=count_rows+1;
    IF count_rows>p_limit THEN
      next_cursor:=jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year,
        'query',query_text,'rank',last_rank,'annualItemId',last_id); EXIT;
    END IF;
    items:=items||jsonb_build_array(phoenix_private.annual_catalog_item_result_v1(p_organization_id,p_planning_year,page.id,NULL));
    last_id:=page.id; last_rank:=page.rank;
  END LOOP;
  RETURN jsonb_build_object('scope',jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year),
    'items',items,'nextCursor',next_cursor);
END $$;
CREATE FUNCTION public.phoenix_central_needs_list_annual_catalog_occurrences(
 p_organization_id uuid,p_planning_year integer,p_annual_item_id uuid,p_limit integer,p_after_occurrence_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE page record; rows jsonb:='[]'; next_id uuid; last_id uuid; n integer:=0;
  scope jsonb:=jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year);
BEGIN
  PERFORM phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,false);
  PERFORM phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,false);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'annual_catalog_page_invalid' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.central_needs_annual_items
    WHERE organization_id=p_organization_id AND planning_year=p_planning_year AND id=p_annual_item_id) THEN
    RAISE EXCEPTION 'annual_catalog_item_missing' USING ERRCODE='P0002';
  END IF;
  IF p_after_occurrence_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.central_needs_annual_occurrences
    WHERE organization_id=p_organization_id AND planning_year=p_planning_year AND annual_item_id=p_annual_item_id AND id=p_after_occurrence_id) THEN
    RAISE EXCEPTION 'annual_catalog_cursor_scope_mismatch' USING ERRCODE='23514';
  END IF;
  FOR page IN SELECT o.*,s.filename,s.sha256,s.parser FROM public.central_needs_annual_occurrences o
    JOIN public.central_needs_annual_sources s ON (s.organization_id,s.planning_year,s.id)=(o.organization_id,o.planning_year,o.source_id)
    WHERE o.organization_id=p_organization_id AND o.planning_year=p_planning_year AND o.annual_item_id=p_annual_item_id
      AND (p_after_occurrence_id IS NULL OR o.id>p_after_occurrence_id) ORDER BY o.id LIMIT p_limit+1
  LOOP
    n:=n+1;
    IF n>p_limit THEN next_id:=last_id; EXIT; END IF;
    rows:=rows||jsonb_build_array(jsonb_build_object('occurrenceKey',page.id,'scope',scope,
      'source',jsonb_build_object('sourceId',page.source_id,'filename',page.filename,'sha256',page.sha256,'parser',page.parser,
        'sheetIndex',page.sheet_index,'sheetName',page.sheet_name,'row',page.row_index,'blockId',page.block_id,'mappingReference',page.mapping_reference),
      'classification',page.classification,'fields',page.fields));
    last_id:=page.id;
  END LOOP;
  RETURN jsonb_build_object('scope',scope,'annualItemId',p_annual_item_id,'occurrences',rows,
    'nextAfterOccurrenceId',next_id,'attestation','client_attested');
END $$;

-- Mutations share a private snapshot writer; it is never an authenticated surface.
CREATE FUNCTION phoenix_private.annual_catalog_write_item_v1(
 p_org uuid,p_year integer,p_item uuid,p_canonical uuid,p_expected_version uuid,p_expected_fingerprint text,p_occurrences jsonb,p_reason text)
RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE i public.central_needs_annual_items%ROWTYPE; c jsonb; fingerprint text; reason text;
  item_id uuid:=coalesce(p_item,gen_random_uuid()); version_id uuid:=gen_random_uuid(); next_version integer:=1; item_status text;
BEGIN
  reason:=phoenix_private.annual_catalog_reason_v1(p_reason);
  IF p_item IS NOT NULL THEN
    SELECT * INTO i FROM public.central_needs_annual_items WHERE organization_id=p_org AND planning_year=p_year AND id=p_item;
    IF NOT FOUND THEN RAISE EXCEPTION 'annual_catalog_item_missing' USING ERRCODE='P0002'; END IF;
    p_canonical:=i.central_item_id;
  END IF;
  c:=phoenix_private.annual_catalog_canonical_v1(p_canonical,true);
  IF c IS NULL OR c->>'status' IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'annual_catalog_canonical_inactive' USING ERRCODE='23514';
  END IF;
  fingerprint:=phoenix_private.annual_catalog_hash_v1(c);
  IF p_expected_fingerprint IS NULL OR p_expected_fingerprint !~ '^[0-9a-f]{64}$' OR fingerprint IS DISTINCT FROM p_expected_fingerprint THEN
    RAISE EXCEPTION 'annual_catalog_canonical_stale' USING ERRCODE='23514';
  END IF;
  item_status:=CASE WHEN cardinality(phoenix_private.annual_catalog_missing_v1(c))=0 THEN 'active' ELSE 'preparing' END;
  IF p_item IS NULL THEN
    IF EXISTS(SELECT 1 FROM public.central_needs_annual_items WHERE organization_id=p_org AND planning_year=p_year AND central_item_id=p_canonical) THEN
      RAISE EXCEPTION 'annual_catalog_membership_exists' USING ERRCODE='23505';
    END IF;
    INSERT INTO public.central_needs_annual_items(id,organization_id,planning_year,central_item_id,status,current_field_version_id,created_by)
      VALUES(item_id,p_org,p_year,p_canonical,item_status,version_id,auth.uid());
  ELSE
    SELECT * INTO i FROM public.central_needs_annual_items WHERE organization_id=p_org AND planning_year=p_year AND id=p_item FOR UPDATE;
    IF i.status='retired' THEN RAISE EXCEPTION 'annual_catalog_member_retired' USING ERRCODE='23514'; END IF;
    IF p_expected_version IS NULL OR i.current_field_version_id IS DISTINCT FROM p_expected_version THEN
      RAISE EXCEPTION 'annual_catalog_version_stale' USING ERRCODE='23514';
    END IF;
    SELECT version_number+1 INTO next_version FROM public.central_needs_annual_versions
      WHERE organization_id=p_org AND planning_year=p_year AND annual_item_id=p_item AND id=i.current_field_version_id;
  END IF;
  PERFORM phoenix_private.annual_catalog_capture_v1(p_org,p_year,item_id,p_occurrences);
  INSERT INTO public.central_needs_annual_versions(id,organization_id,planning_year,annual_item_id,version_number,
    fields,canonical_snapshot,canonical_fingerprint,reason,created_by)
    VALUES(version_id,p_org,p_year,item_id,next_version,phoenix_private.annual_catalog_fields_v1(c,reason),c,fingerprint,reason,auth.uid());
  IF p_item IS NOT NULL THEN
    UPDATE public.central_needs_annual_items SET current_field_version_id=version_id,status=item_status
      WHERE organization_id=p_org AND planning_year=p_year AND id=p_item;
  END IF;
  RETURN item_id;
END $$;
CREATE FUNCTION public.phoenix_central_needs_add_annual_catalog_item(
 p_organization_id uuid,p_planning_year integer,p_central_item_id uuid,p_expected_canonical_fingerprint text,
 p_occurrences jsonb,p_reason text,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE role_name text; intent jsonb; result jsonb; item_id uuid;
BEGIN
  role_name:=phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,true);
  intent:=jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year,'canonicalItemId',p_central_item_id,
    'expectedCanonicalFingerprint',p_expected_canonical_fingerprint,'occurrences',p_occurrences,'reason',p_reason);
  result:=phoenix_private.annual_catalog_replay_v1(p_organization_id,p_planning_year,p_idempotency_key,'add_item',intent);
  IF result IS NOT NULL THEN RETURN result; END IF;
  PERFORM phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,true);
  item_id:=phoenix_private.annual_catalog_write_item_v1(p_organization_id,p_planning_year,NULL,p_central_item_id,NULL,
    p_expected_canonical_fingerprint,p_occurrences,p_reason);
  result:=phoenix_private.annual_catalog_item_result_v1(p_organization_id,p_planning_year,item_id,NULL);
  RETURN phoenix_private.annual_catalog_receipt_v1(p_organization_id,p_planning_year,p_idempotency_key,'add_item',intent,result,role_name,item_id);
END $$;
CREATE FUNCTION public.phoenix_central_needs_refresh_annual_catalog_item(
 p_organization_id uuid,p_planning_year integer,p_annual_item_id uuid,p_expected_field_version_id uuid,
 p_expected_canonical_fingerprint text,p_occurrences jsonb,p_reason text,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE role_name text; intent jsonb; result jsonb; item_id uuid;
BEGIN
  role_name:=phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,true);
  intent:=jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year,'annualItemId',p_annual_item_id,
    'expectedFieldVersionId',p_expected_field_version_id,'expectedCanonicalFingerprint',p_expected_canonical_fingerprint,
    'occurrences',p_occurrences,'reason',p_reason);
  result:=phoenix_private.annual_catalog_replay_v1(p_organization_id,p_planning_year,p_idempotency_key,'refresh_item',intent);
  IF result IS NOT NULL THEN RETURN result; END IF;
  PERFORM phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,true);
  IF p_annual_item_id IS NULL THEN RAISE EXCEPTION 'annual_catalog_item_missing' USING ERRCODE='P0002'; END IF;
  item_id:=phoenix_private.annual_catalog_write_item_v1(p_organization_id,p_planning_year,p_annual_item_id,NULL,p_expected_field_version_id,
    p_expected_canonical_fingerprint,p_occurrences,p_reason);
  result:=phoenix_private.annual_catalog_item_result_v1(p_organization_id,p_planning_year,item_id,NULL);
  RETURN phoenix_private.annual_catalog_receipt_v1(p_organization_id,p_planning_year,p_idempotency_key,'refresh_item',intent,result,role_name,item_id);
END $$;

-- Existing lawful material registration, with an immutable annual context.
CREATE FUNCTION public.phoenix_central_needs_create_annual_material_request(
 p_organization_id uuid,p_planning_year integer,p_descriptor jsonb,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE role_name text; intent jsonb; result jsonb; request_result jsonb; request_id uuid; k text; internal_key text;
BEGIN
  role_name:=phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,true);
  intent:=jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year,'descriptor',p_descriptor);
  result:=phoenix_private.annual_catalog_replay_v1(p_organization_id,p_planning_year,p_idempotency_key,'create_request',intent);
  IF result IS NOT NULL THEN RETURN result; END IF;
  PERFORM phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,true);
  PERFORM phoenix_private.annual_catalog_object_v1(p_descriptor,
    ARRAY['scientificName','nameAr','tradeName','strength','dosageForm','unit','barcode','nationalCode','note'],ARRAY['scientificName','unit']);
  IF octet_length(p_descriptor::text)>16000 THEN RAISE EXCEPTION 'annual_catalog_payload_invalid' USING ERRCODE='23514'; END IF;
  FOR k IN SELECT jsonb_object_keys(p_descriptor) LOOP
    IF p_descriptor->k<>'null'::jsonb THEN PERFORM phoenix_private.annual_catalog_text_v1(p_descriptor->k,2000,true); END IF;
  END LOOP;
  internal_key:='annual-v1:'||phoenix_private.annual_catalog_hash_v1(jsonb_build_array(p_organization_id,p_planning_year,auth.uid(),p_idempotency_key));
  request_result:=public.phoenix_central_needs_create_material_request_with_code(
    p_organization_id,p_descriptor->>'scientificName',p_descriptor->>'nameAr',p_descriptor->>'tradeName',
    p_descriptor->>'strength',p_descriptor->>'dosageForm',p_descriptor->>'unit',p_descriptor->>'barcode',
    p_descriptor->>'nationalCode',p_descriptor->>'note','manual_typed','{}'::jsonb,NULL,internal_key);
  request_id:=(request_result->>'request_id')::uuid;
  INSERT INTO public.central_needs_annual_request_contexts(request_id,organization_id,planning_year,created_by)
    VALUES(request_id,p_organization_id,p_planning_year,auth.uid());
  result:=jsonb_build_object('scope',jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year),
    'requestId',request_id,'status',request_result->>'status','version',(request_result->>'version')::integer);
  RETURN phoenix_private.annual_catalog_receipt_v1(p_organization_id,p_planning_year,p_idempotency_key,'create_request',intent,result,role_name,request_id);
END $$;
CREATE FUNCTION public.phoenix_central_needs_complete_annual_material_request(
 p_organization_id uuid,p_planning_year integer,p_request_id uuid,p_expected_request_version integer,
 p_expected_canonical_fingerprint text,p_reason text,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE role_name text; intent jsonb; result jsonb; req public.central_needs_material_requests%ROWTYPE;
  i public.central_needs_annual_items%ROWTYPE; c jsonb; item_id uuid; reason text;
BEGIN
  role_name:=phoenix_private.annual_catalog_guard_v1(p_organization_id,p_planning_year,true);
  intent:=jsonb_build_object('ownerOrgId',p_organization_id,'planningYear',p_planning_year,'requestId',p_request_id,
    'expectedRequestVersion',p_expected_request_version,'expectedCanonicalFingerprint',p_expected_canonical_fingerprint,'reason',p_reason);
  result:=phoenix_private.annual_catalog_replay_v1(p_organization_id,p_planning_year,p_idempotency_key,'complete_request',intent);
  IF result IS NOT NULL THEN RETURN result; END IF;
  PERFORM phoenix_private.annual_catalog_year_v1(p_organization_id,p_planning_year,true);
  reason:=phoenix_private.annual_catalog_reason_v1(p_reason);
  IF NOT EXISTS(SELECT 1 FROM public.central_needs_annual_request_contexts
    WHERE organization_id=p_organization_id AND planning_year=p_planning_year AND request_id=p_request_id) THEN
    RAISE EXCEPTION 'annual_catalog_request_context_missing' USING ERRCODE='P0002';
  END IF;
  SELECT * INTO req FROM public.central_needs_material_requests
    WHERE organization_id=p_organization_id AND id=p_request_id FOR SHARE;
  IF req.version IS DISTINCT FROM p_expected_request_version OR req.status NOT IN ('approved_new','resolved_existing') OR req.resolved_item_id IS NULL THEN
    RAISE EXCEPTION 'annual_catalog_request_not_resolved' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM public.central_needs_annual_request_resolutions WHERE request_id=p_request_id) THEN
    RAISE EXCEPTION 'annual_catalog_request_already_completed' USING ERRCODE='23505';
  END IF;
  c:=phoenix_private.annual_catalog_canonical_v1(req.resolved_item_id,true);
  IF c IS NULL OR c->>'status' IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'annual_catalog_canonical_inactive' USING ERRCODE='23514';
  END IF;
  IF p_expected_canonical_fingerprint IS NULL OR phoenix_private.annual_catalog_hash_v1(c) IS DISTINCT FROM p_expected_canonical_fingerprint THEN
    RAISE EXCEPTION 'annual_catalog_canonical_stale' USING ERRCODE='23514';
  END IF;
  SELECT * INTO i FROM public.central_needs_annual_items WHERE organization_id=p_organization_id AND planning_year=p_planning_year
    AND central_item_id=req.resolved_item_id FOR UPDATE;
  IF FOUND THEN
    item_id:=i.id;
    result:=phoenix_private.annual_catalog_item_result_v1(p_organization_id,p_planning_year,item_id,NULL);
    IF result->'selectable' IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'annual_catalog_existing_member_not_eligible' USING ERRCODE='23514';
    END IF;
  ELSE
    item_id:=phoenix_private.annual_catalog_write_item_v1(p_organization_id,p_planning_year,NULL,req.resolved_item_id,NULL,
      p_expected_canonical_fingerprint,'[]'::jsonb,reason);
    result:=phoenix_private.annual_catalog_item_result_v1(p_organization_id,p_planning_year,item_id,NULL);
  END IF;
  INSERT INTO public.central_needs_annual_request_resolutions(request_id,organization_id,planning_year,annual_item_id,field_version_id,request_version,created_by)
    VALUES(p_request_id,p_organization_id,p_planning_year,item_id,(result#>>'{fieldVersion,fieldVersionId}')::uuid,req.version,auth.uid());
  result:=result||jsonb_build_object('requestId',p_request_id);
  RETURN phoenix_private.annual_catalog_receipt_v1(p_organization_id,p_planning_year,p_idempotency_key,'complete_request',intent,result,role_name,item_id);
END $$;

REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_identity_guard_v1() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_guard_v1(uuid,integer,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_year_v1(uuid,integer,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_hash_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_canonical_v1(uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_missing_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_fields_v1(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_reason_v1(text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_replay_v1(uuid,integer,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_receipt_v1(uuid,integer,text,text,jsonb,jsonb,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_object_v1(jsonb,text[],text[]) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_text_v1(jsonb,integer,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_cell_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_observation_v1(jsonb,text,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_capture_v1(uuid,integer,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_item_result_v1(uuid,integer,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_annual_catalog_contract() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_open_catalog_year(uuid,integer,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_list_catalog_years(uuid,integer,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_preview_annual_canonical(uuid,integer,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_get_annual_catalog_item(uuid,integer,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_search_annual_catalog(uuid,integer,text,integer,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_list_annual_catalog_occurrences(uuid,integer,uuid,integer,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_write_item_v1(uuid,integer,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_add_annual_catalog_item(uuid,integer,uuid,text,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_refresh_annual_catalog_item(uuid,integer,uuid,uuid,text,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_create_annual_material_request(uuid,integer,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.phoenix_central_needs_complete_annual_material_request(uuid,integer,uuid,integer,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_annual_catalog_contract() TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_open_catalog_year(uuid,integer,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_list_catalog_years(uuid,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_preview_annual_canonical(uuid,integer,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_get_annual_catalog_item(uuid,integer,uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_search_annual_catalog(uuid,integer,text,integer,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_list_annual_catalog_occurrences(uuid,integer,uuid,integer,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_add_annual_catalog_item(uuid,integer,uuid,text,jsonb,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_refresh_annual_catalog_item(uuid,integer,uuid,uuid,text,jsonb,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_create_annual_material_request(uuid,integer,jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_complete_annual_material_request(uuid,integer,uuid,integer,text,text,text) TO authenticated;

REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_utf16_length_v1(text) FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION phoenix_private.annual_catalog_trim_v1(text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION phoenix_private.central_needs_capability_breaches_v1()
RETURNS SETOF text
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH
  annual_relations(relname) AS (VALUES ('central_needs_catalog_years'), ('central_needs_annual_items'), ('central_needs_annual_versions'), ('central_needs_annual_sources'), ('central_needs_annual_occurrences'), ('central_needs_annual_request_contexts'), ('central_needs_annual_request_resolutions'), ('central_needs_annual_receipts')),
  annual_writers(sig) AS (VALUES ('phoenix_private.annual_catalog_capture_v1(uuid,integer,uuid,jsonb)'), ('phoenix_private.annual_catalog_receipt_v1(uuid,integer,text,text,jsonb,jsonb,text,uuid)'), ('phoenix_private.annual_catalog_write_item_v1(uuid,integer,uuid,uuid,uuid,text,jsonb,text)'), ('public.phoenix_central_needs_open_catalog_year(uuid,integer,text)'), ('public.phoenix_central_needs_create_annual_material_request(uuid,integer,jsonb,text)'), ('public.phoenix_central_needs_complete_annual_material_request(uuid,integer,uuid,integer,text,text,text)')),
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
           ('central_needs_need_lines'), ('central_needs_need_line_sources'), ('central_needs_manual_need_events'),
           ('central_needs_revision_withdrawals'), ('central_needs_manual_coverage_acknowledgements'), ('central_needs_cutover_inventory'),
           ('central_needs_material_requests'), ('central_needs_material_request_events'), ('central_needs_material_request_links'), ('central_needs_dossier_intakes'), ('central_needs_dossier_documents'), ('central_needs_dossier_receipts'), ('central_needs_catalog_years'), ('central_needs_annual_items'), ('central_needs_annual_versions'), ('central_needs_annual_sources'), ('central_needs_annual_occurrences'), ('central_needs_annual_request_contexts'), ('central_needs_annual_request_resolutions'), ('central_needs_annual_receipts')
  ),
  cn AS (
    SELECT c.oid, c.relowner, n.nspname, c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE (n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'central\_needs\_%')
        OR (n.nspname = 'phoenix_private' AND c.relname = 'central_needs_lifecycle_attestations')
  ),
  acl_manifest(sig) AS (
    VALUES
           ('phoenix_private.annual_catalog_trim_v1(text)'),
           ('phoenix_private.annual_catalog_utf16_length_v1(text)'),
           ('phoenix_private.annual_catalog_identity_guard_v1()'),
           ('phoenix_private.annual_catalog_guard_v1(uuid,integer,boolean)'),
           ('phoenix_private.annual_catalog_year_v1(uuid,integer,boolean)'),
           ('phoenix_private.annual_catalog_hash_v1(jsonb)'),
           ('phoenix_private.annual_catalog_canonical_v1(uuid,boolean)'),
           ('phoenix_private.annual_catalog_missing_v1(jsonb)'),
           ('phoenix_private.annual_catalog_fields_v1(jsonb,text)'),
           ('phoenix_private.annual_catalog_reason_v1(text)'),
           ('phoenix_private.annual_catalog_replay_v1(uuid,integer,text,text,jsonb)'),
           ('phoenix_private.annual_catalog_receipt_v1(uuid,integer,text,text,jsonb,jsonb,text,uuid)'),
           ('phoenix_private.annual_catalog_object_v1(jsonb,text[],text[])'),
           ('phoenix_private.annual_catalog_text_v1(jsonb,integer,boolean)'),
           ('phoenix_private.annual_catalog_cell_v1(jsonb)'),
           ('phoenix_private.annual_catalog_observation_v1(jsonb,text,integer)'),
           ('phoenix_private.annual_catalog_capture_v1(uuid,integer,uuid,jsonb)'),
           ('phoenix_private.annual_catalog_item_result_v1(uuid,integer,uuid,uuid)'),
           ('public.phoenix_central_needs_annual_catalog_contract()'),
           ('public.phoenix_central_needs_open_catalog_year(uuid,integer,text)'),
           ('public.phoenix_central_needs_list_catalog_years(uuid,integer,integer)'),
           ('public.phoenix_central_needs_preview_annual_canonical(uuid,integer,uuid)'),
           ('public.phoenix_central_needs_get_annual_catalog_item(uuid,integer,uuid,uuid)'),
           ('public.phoenix_central_needs_search_annual_catalog(uuid,integer,text,integer,jsonb)'),
           ('public.phoenix_central_needs_list_annual_catalog_occurrences(uuid,integer,uuid,integer,uuid)'),
           ('phoenix_private.annual_catalog_write_item_v1(uuid,integer,uuid,uuid,uuid,text,jsonb,text)'),
           ('public.phoenix_central_needs_add_annual_catalog_item(uuid,integer,uuid,text,jsonb,text,text)'),
           ('public.phoenix_central_needs_refresh_annual_catalog_item(uuid,integer,uuid,uuid,text,jsonb,text,text)'),
           ('public.phoenix_central_needs_create_annual_material_request(uuid,integer,jsonb,text)'),
           ('public.phoenix_central_needs_complete_annual_material_request(uuid,integer,uuid,integer,text,text,text)'),
           ('phoenix_private.central_needs_add_manual_need_line_reserved_v1(boolean,uuid,uuid,uuid,uuid,text,text,text,uuid,text)'),
           ('public.phoenix_central_needs_begin_dossier_workbook(uuid,text,text,text,jsonb,jsonb,jsonb,uuid)'),
           ('public.phoenix_central_needs_apply_dossier_workbook_batch(uuid,integer)'),
           ('phoenix_private.central_needs_dossier_intake_fence_v1()'), ('public.phoenix_central_needs_import_dossier_workbook(uuid,text,text,text,jsonb)'),
           ('public.phoenix_central_needs_dossier_sources(uuid)'),
           ('public.phoenix_central_needs_download_dossier_source(uuid)'),
           ('public.phoenix_central_needs_open_dossier_correction(uuid,integer,uuid,text)'),
           ('public.phoenix_central_needs_dossier_revisions(uuid)'),
           ('public.phoenix_central_needs_dossier_lifecycle(uuid,integer,uuid)'),
           ('phoenix_private.central_needs_lock_plan_id_v1(uuid)'),
           ('public.phoenix_central_needs_open_dossier(uuid,integer,text,text)'),
           ('public.phoenix_central_needs_list_dossiers(uuid,integer)'),
           ('public.phoenix_central_needs_annual_summary(uuid,integer)'),
           ('phoenix_private.central_needs_dossier_approval_guard_v1()'),
           ('public.phoenix_central_needs_create_material_request_with_code(uuid,text,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)'),
           ('public.phoenix_central_needs_update_material_request_with_code(uuid,integer,text,text,text,text,text,text,text,text,text)'),
           ('phoenix_private.central_needs_national_code_v1(text)'),
           ('public.phoenix_central_needs_feature_contract()'),
           ('public.phoenix_central_needs_resolve_material_existing_with_code(uuid,integer,uuid,text,text,boolean)'),
           ('public.phoenix_central_needs_approve_material_with_code(uuid,integer,uuid[],text,text)'),
           ('public.phoenix_central_needs_material_request_code_candidates(uuid)'),
           ('phoenix_cn_policy.actor_scope_org(text)'),
           ('public.phoenix_central_needs_actor_authorized(uuid,text)'),
           ('phoenix_private.central_needs_source_mode_immutable_v1()'),
           ('phoenix_private.central_needs_lineage_mode_v1()'),
           ('phoenix_private.central_needs_manual_event_guard_v1()'),
           ('phoenix_private.central_needs_manual_projection_guard_v1()'),
           ('phoenix_private.central_needs_revision_authority_gate_v1()'),
           ('public._phoenix_central_needs_assert_manual_projection_v1()'),
           ('phoenix_cn_policy.excel_sod_enabled()'),
           ('phoenix_private.central_needs_append_only_v1()'),
           ('phoenix_private.central_needs_sod_excluded_v1(uuid,uuid)'),
           ('phoenix_private.central_needs_manual_quantity_v1(text)'),
           ('phoenix_private.central_needs_manual_scope_v1(uuid,uuid,uuid)'),
           ('phoenix_private.central_needs_coverage_digest_v1(uuid,uuid)'),
           ('phoenix_private.central_needs_effective_predecessor_v1(uuid)'),
           ('public.phoenix_central_needs_open_manual_plan_revision(uuid,integer)'),
           ('public.phoenix_central_needs_open_manual_correction_revision(uuid,integer,uuid,text)'),
           ('public.phoenix_central_needs_carry_forward_manual_lines(uuid,uuid)'),
           ('public.phoenix_central_needs_add_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)'),
           ('public.phoenix_central_needs_correct_manual_need_line(uuid,uuid,uuid,uuid,text,text,text,uuid,text)'),
           ('public.phoenix_central_needs_void_manual_need_line(uuid,uuid,uuid,uuid,text,text,uuid,text)'),
           ('public.phoenix_central_needs_withdraw_draft_revision(uuid,uuid,text,text)'),
           ('public.phoenix_central_needs_acknowledge_manual_coverage(uuid,text,text)'),
           ('phoenix_private.central_needs_excel_review_blockers_v1(uuid)'),
           ('phoenix_private.central_needs_submission_state_digest_v1(uuid)'),
           ('public._phoenix_central_needs_review_blockers_v1(uuid)'),
           ('phoenix_cn_policy.material_reviewer_org()'),
           ('phoenix_private.central_material_norm_v1(text)'),
           ('phoenix_private.central_material_name_key_v1(text,text,text,text)'),
           ('phoenix_private.central_material_identity_key_v1(text,text,text,text,text)'),
           ('phoenix_private.central_material_lock_catalog_v1(text,text,text,text,text)'),
           ('phoenix_private.central_material_candidates_v1(text,text,text,text,text)'),
           ('phoenix_private.central_material_transition_guard_v1()'),
           ('phoenix_private.central_material_load_v1(uuid,integer)'),
           ('phoenix_private.central_material_event_v1(uuid,text,text,jsonb)'),
           ('phoenix_private.central_material_assert_reviewer_v1(uuid,uuid,uuid,boolean)'),
           ('public.phoenix_central_needs_create_material_request_draft(uuid,text,text,text,text,text,text,text,text,text,jsonb,uuid,text)'),
           ('public.phoenix_central_needs_update_material_request_draft(uuid,integer,text,text,text,text,text,text,text,text)'),
           ('public.phoenix_central_needs_submit_material_request(uuid,integer)'),
           ('public.phoenix_central_needs_start_material_review(uuid,integer)'),
           ('public.phoenix_central_needs_request_material_info(uuid,integer,text)'),
           ('public.phoenix_central_needs_resolve_material_existing(uuid,integer,uuid,text)'),
           ('public.phoenix_central_needs_approve_new_material(uuid,integer,uuid[],text)'),
           ('public.phoenix_central_needs_reject_material_request(uuid,integer,text)'),
           ('public.phoenix_central_needs_cancel_material_request(uuid,integer,text)'),
           ('public.phoenix_central_needs_link_material_request_to_draft(uuid,uuid)'),
           ('public.phoenix_central_needs_list_material_requests(uuid)'),
           ('public.phoenix_central_needs_list_material_request_events(uuid)'),
           ('public.phoenix_central_needs_material_request_candidates(uuid)'),
           ('public.phoenix_central_needs_my_material_capabilities(uuid)')
  ),
  expected_catalog_writers(proname) AS (
    VALUES
      ('phoenix_central_needs_resolve_material_existing_with_code'),
           ('phoenix_central_needs_approve_material_with_code'),
           ('phoenix_central_needs_create_material_request_with_code'),
           ('phoenix_central_needs_update_material_request_with_code'),
           ('phoenix_central_needs_create_material_request_draft'),
           ('phoenix_central_needs_update_material_request_draft'),
           ('phoenix_central_needs_submit_material_request'),
           ('phoenix_central_needs_start_material_review'),
           ('phoenix_central_needs_request_material_info'),
           ('phoenix_central_needs_resolve_material_existing'),
           ('phoenix_central_needs_approve_new_material'),
           ('phoenix_central_needs_reject_material_request'),
           ('phoenix_central_needs_cancel_material_request'),
           ('phoenix_central_needs_link_material_request_to_draft'),
           ('central_material_event_v1')
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
  -- A1 RPC-only provenance/receipts have no direct SELECT or column SELECT surface.
  SELECT pg_catalog.format('%s holds SELECT on RPC-only annual relation %I', u.rolname, c.relname)
    FROM nonroot u CROSS JOIN annual_relations a
    JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass(pg_catalog.format('public.%I',a.relname))
   WHERE u.oid<>c.relowner AND (pg_catalog.has_table_privilege(u.oid,c.oid,'SELECT')
     OR pg_catalog.has_any_column_privilege(u.oid,c.oid,'SELECT'))
  UNION ALL
  -- A1 exact writer OIDs: a new name, schema or overload does not gain annual authority.
  SELECT pg_catalog.format('unlisted_annual_catalog_writer %s.%s', n.nspname,p.proname)
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog','information_schema')
     AND pg_catalog.regexp_replace(p.prosrc,'--[^\n]*','','g')
       ~* '(insert\s+into|update|delete\s+from|truncate|merge\s+into)\s+(only\s+)?(table\s+)?("?public"?\.)?"?(central_needs_catalog_years|central_needs_annual_[a-z_]+)\y'
     AND NOT EXISTS(SELECT 1 FROM annual_writers w WHERE pg_catalog.to_regprocedure(w.sig)=p.oid)
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
  -- P1: a batch-only implementation is never an authenticated API surface.
  SELECT 'private workbook reservation writer is executable by authenticated'
   WHERE pg_catalog.has_function_privilege('authenticated',
     'phoenix_private.central_needs_add_manual_need_line_reserved_v1(boolean,uuid,uuid,uuid,uuid,text,text,text,uuid,text)'::regprocedure,
     'EXECUTE')
  UNION ALL
  -- A1: exact private helpers never become authenticated API entry points.
  SELECT pg_catalog.format('private annual helper %s is executable by authenticated', a.sig)
    FROM (VALUES ('phoenix_private.annual_catalog_trim_v1(text)'), ('phoenix_private.annual_catalog_utf16_length_v1(text)'), ('phoenix_private.annual_catalog_identity_guard_v1()'), ('phoenix_private.annual_catalog_guard_v1(uuid,integer,boolean)'), ('phoenix_private.annual_catalog_year_v1(uuid,integer,boolean)'), ('phoenix_private.annual_catalog_hash_v1(jsonb)'), ('phoenix_private.annual_catalog_canonical_v1(uuid,boolean)'), ('phoenix_private.annual_catalog_missing_v1(jsonb)'), ('phoenix_private.annual_catalog_fields_v1(jsonb,text)'), ('phoenix_private.annual_catalog_reason_v1(text)'), ('phoenix_private.annual_catalog_replay_v1(uuid,integer,text,text,jsonb)'), ('phoenix_private.annual_catalog_receipt_v1(uuid,integer,text,text,jsonb,jsonb,text,uuid)'), ('phoenix_private.annual_catalog_object_v1(jsonb,text[],text[])'), ('phoenix_private.annual_catalog_text_v1(jsonb,integer,boolean)'), ('phoenix_private.annual_catalog_cell_v1(jsonb)'), ('phoenix_private.annual_catalog_observation_v1(jsonb,text,integer)'), ('phoenix_private.annual_catalog_capture_v1(uuid,integer,uuid,jsonb)'), ('phoenix_private.annual_catalog_item_result_v1(uuid,integer,uuid,uuid)'), ('phoenix_private.annual_catalog_write_item_v1(uuid,integer,uuid,uuid,uuid,text,jsonb,text)')) a(sig)
   WHERE pg_catalog.has_function_privilege('authenticated', pg_catalog.to_regprocedure(a.sig), 'EXECUTE')
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
  UNION ALL
  -- M4' (t1): every manifest relation has FORCED row level security
  SELECT pg_catalog.format('relation %I lacks forced row level security', m.relname)
    FROM manifest m JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(pg_catalog.format('public.%I', m.relname))
   WHERE NOT (c.relrowsecurity AND c.relforcerowsecurity)
  UNION ALL
  -- M4' (t2): ... and the restrictive actor-scope policy
  SELECT pg_catalog.format('relation %I lacks the restrictive actor-scope policy', m.relname)
    FROM manifest m JOIN pg_catalog.pg_class c ON c.oid = pg_catalog.to_regclass(pg_catalog.format('public.%I', m.relname))
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy po WHERE po.polrelid = c.oid AND po.polname = 'r1_actor_scope_restrictive' AND NOT po.polpermissive)
  UNION ALL
  -- M4' (t3): every SECURITY DEFINER routine of the ACL manifest pins its search_path
  SELECT pg_catalog.format('manifest routine %s has no pinned search_path', m.sig)
    FROM acl_manifest m JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(m.sig)
   WHERE p.prosecdef AND NOT EXISTS (SELECT 1 FROM pg_catalog.unnest(COALESCE(p.proconfig, ARRAY[]::text[])) cfg WHERE cfg LIKE 'search_path=%')
  UNION ALL
  -- M4' (t4): STRUCTURAL - a relation with a foreign key to the plan revisions or to the request relations must be in the manifest, whatever its name
  SELECT pg_catalog.format('unlisted_fk_dependent_relation %I', t.relname)
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class t ON t.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
   WHERE con.contype = 'f' AND n.nspname = 'public'
     AND con.confrelid IN (pg_catalog.to_regclass('public.central_needs_plan_revisions'), pg_catalog.to_regclass('public.central_needs_material_requests'))
     AND t.relname NOT IN (SELECT relname FROM manifest)
  UNION ALL
  -- M4' (t5): STRUCTURAL - a routine that writes central_items or the request relations must be on the expected list, whatever its name
  SELECT pg_catalog.format('unlisted_catalog_writer %s.%s', n.nspname, p.proname)
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND pg_catalog.regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
         ~* '(insert\s+into|update|delete\s+from|truncate|merge\s+into)\s+(only\s+)?(table\s+)?("?public"?\.)?"?(central_items|central_needs_material_[a-z_]+)\y'
     AND p.proname NOT IN (SELECT proname FROM expected_catalog_writers)
$$;

DO $verify$
BEGIN
  IF EXISTS(SELECT 1 FROM phoenix_private.central_needs_capability_breaches_v1()) THEN
    RAISE EXCEPTION 'P3A1_verify_failed: capability seal';
  END IF;
END $verify$;
COMMIT;

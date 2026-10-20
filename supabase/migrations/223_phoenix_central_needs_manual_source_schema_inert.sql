-- MIGRATION 223 (R1-a 01). D9 CLOSED: numbered from supabase/candidates/R1a_01_manual_source_schema_inert.sql WITHOUT any change to the SQL below.
-- The bytes after this prelude are exactly the candidate (SHA-256 c53a7d1cd022373e90d5ff49a01f5e9f21afbf517ae2f26428d1c311cb1f5f1e) that Staging already carries in its ledger;
-- wording below that says "PLACEHOLDER", "NOT part of the numbered chain" or "D9 open" predates this numbering and is superseded by this prelude.
-- ============================================================================
-- R1-a CANDIDATE 01 — manual-source schema, projection guard and quantity
-- grammar. PLACEHOLDER (no migration number): NOT part of the numbered chain,
-- NOT approved for apply, NOT applied to any shared database. D9 numbering and
-- Q-S (precision/scale) are open; the quantity bound is therefore expressed only
-- as the canonical-text grammar below, never as a numeric typmod.
--
-- INERT: nothing here lets a manual revision be created through an RPC (no
-- writer routine is added in this file); Excel behaviour is byte-unchanged
-- (new columns default to 'excel'; the integrity function gains one skip clause).
--
-- Contract: R1-0 ADR rev4d §4.1–§4.4, §4.11.
-- ============================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- PRELUDE (fail closed)
-- ---------------------------------------------------------------------------
DO $pre$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'R1a01_requires_read_committed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'R1a01_precondition_failed: applier must be rolsuper or rolbypassrls (definer routines rely on it)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
              WHERE attrelid = 'public.central_needs_plan_revisions'::regclass AND attname = 'source_mode' AND NOT attisdropped)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
              WHERE attrelid = 'public.central_needs_need_lines'::regclass AND attname = 'lineage_mode' AND NOT attisdropped)
     OR to_regclass('public.central_needs_manual_need_events') IS NOT NULL THEN
    RAISE EXCEPTION 'R1a01_precondition_failed: R1-a objects already present';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'central\_needs\_%') <> 13 THEN
    RAISE EXCEPTION 'R1a01_precondition_failed: expected exactly the 13 legacy central_needs relations';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Revision-level mode (ADR §4.1). Constant default = metadata-only add.
-- ---------------------------------------------------------------------------
ALTER TABLE public.central_needs_plan_revisions
  ADD COLUMN source_mode text NOT NULL DEFAULT 'excel';
ALTER TABLE public.central_needs_plan_revisions
  ADD CONSTRAINT central_needs_plan_revisions_source_mode_chk CHECK (source_mode IN ('excel', 'manual'));

CREATE OR REPLACE FUNCTION phoenix_private.central_needs_source_mode_immutable_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.source_mode IS DISTINCT FROM OLD.source_mode THEN
    RAISE EXCEPTION 'central_needs_source_mode_immutable' USING ERRCODE = '23514',
      DETAIL = format('revision=%s', OLD.id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_source_mode_immutable_v1() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER central_needs_plan_revisions_r1_10_source_mode
  BEFORE UPDATE ON public.central_needs_plan_revisions
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_source_mode_immutable_v1();

-- ---------------------------------------------------------------------------
-- 2. Line-level discriminator (ADR §4.2): set from the revision, never trusted.
-- ---------------------------------------------------------------------------
ALTER TABLE public.central_needs_need_lines
  ADD COLUMN lineage_mode text NOT NULL DEFAULT 'excel';
ALTER TABLE public.central_needs_need_lines
  ADD CONSTRAINT central_needs_need_lines_lineage_mode_chk CHECK (lineage_mode IN ('excel', 'manual'));

CREATE OR REPLACE FUNCTION phoenix_private.central_needs_lineage_mode_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_mode text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT r.source_mode INTO v_mode
      FROM public.central_needs_plan_revisions r
     WHERE r.id = NEW.plan_revision_id;
    NEW.lineage_mode := COALESCE(v_mode, 'excel');
    RETURN NEW;
  END IF;
  IF NEW.lineage_mode IS DISTINCT FROM OLD.lineage_mode THEN
    RAISE EXCEPTION 'central_needs_lineage_mode_immutable' USING ERRCODE = '23514',
      DETAIL = format('need_line=%s', OLD.id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_lineage_mode_v1() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER central_needs_need_lines_r1_05_lineage_mode
  BEFORE INSERT OR UPDATE ON public.central_needs_need_lines
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_lineage_mode_v1();

-- ---------------------------------------------------------------------------
-- 3. Manual provenance: append-only event chain (ADR §4.3, §4.11).
--    quantity_text is the canonical decimal grammar; `quantity` is STORED
--    (PostgreSQL 18 would otherwise default a generated column to VIRTUAL).
--    No numeric typmod anywhere (Q-S open): a typmod would round or pad.
--    actor_id has NO foreign key on purpose: ON DELETE SET NULL would be an
--    UPDATE of an append-only relation.
-- ---------------------------------------------------------------------------
CREATE TABLE public.central_needs_manual_need_events (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id             uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  plan_id                     uuid        NOT NULL,
  plan_revision_id            uuid        NOT NULL,
  beneficiary_organization_id uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  central_item_id             uuid        NOT NULL REFERENCES public.central_items(id) ON DELETE RESTRICT,
  target_warehouse_id         uuid        REFERENCES public.warehouses(id) ON DELETE RESTRICT,
  event_seq                   integer     NOT NULL,
  event_kind                  text        NOT NULL,
  quantity_text               text,
  quantity                    numeric     GENERATED ALWAYS AS (
                                CASE WHEN quantity_text ~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$'
                                     THEN quantity_text::numeric ELSE NULL END) STORED,
  approved_unit               text,
  supersedes_event_id         uuid        REFERENCES public.central_needs_manual_need_events(id) ON DELETE RESTRICT,
  carried_from_event_id       uuid        REFERENCES public.central_needs_manual_need_events(id) ON DELETE RESTRICT,
  reason                      text        NOT NULL,
  reference                   text,
  actor_id                    uuid        NOT NULL,
  actor_role                  text        NOT NULL,
  idempotency_key             text        NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT clock_timestamp(),
  txid                        bigint      NOT NULL DEFAULT pg_catalog.txid_current(),
  need_line_id                uuid,
  CONSTRAINT central_needs_manual_need_events_revision_org_fk
    FOREIGN KEY (plan_revision_id, organization_id)
    REFERENCES public.central_needs_plan_revisions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT central_needs_manual_need_events_plan_org_fk
    FOREIGN KEY (plan_id, organization_id)
    REFERENCES public.central_needs_plans(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT central_needs_manual_need_events_kind_chk
    CHECK (event_kind IN ('add', 'correct', 'void', 'carried_forward')),
  CONSTRAINT central_needs_manual_need_events_seq_chk CHECK (event_seq >= 1),
  CONSTRAINT central_needs_manual_need_events_quantity_grammar_chk
    CHECK (quantity_text IS NULL
           OR (quantity_text ~ '^(0|[1-9][0-9]*)([.][0-9]*[1-9])?$' AND char_length(quantity_text) <= 256)),
  CONSTRAINT central_needs_manual_need_events_void_shape_chk
    CHECK ((event_kind = 'void') = (quantity_text IS NULL)),
  CONSTRAINT central_needs_manual_need_events_unit_shape_chk
    CHECK (event_kind = 'void' OR approved_unit IS NOT NULL),
  CONSTRAINT central_needs_manual_need_events_first_event_chk
    CHECK (event_seq > 1 OR (event_kind IN ('add', 'carried_forward') AND supersedes_event_id IS NULL)),
  CONSTRAINT central_needs_manual_need_events_chain_chk
    CHECK (event_seq = 1 OR supersedes_event_id IS NOT NULL),
  CONSTRAINT central_needs_manual_need_events_carry_chk
    CHECK ((event_kind = 'carried_forward') = (carried_from_event_id IS NOT NULL)),
  CONSTRAINT central_needs_manual_need_events_reason_chk
    CHECK (btrim(reason) <> '' AND char_length(reason) <= 2000),
  CONSTRAINT central_needs_manual_need_events_reference_chk
    CHECK (reference IS NULL OR char_length(reference) <= 200),
  CONSTRAINT central_needs_manual_need_events_idempotency_chk
    CHECK (char_length(idempotency_key) BETWEEN 8 AND 128),
  CONSTRAINT central_needs_manual_need_events_line_seq_key
    UNIQUE NULLS NOT DISTINCT (plan_revision_id, beneficiary_organization_id, central_item_id, target_warehouse_id, event_seq),
  CONSTRAINT central_needs_manual_need_events_supersedes_key UNIQUE (supersedes_event_id),
  CONSTRAINT central_needs_manual_need_events_plan_idempotency_key UNIQUE (plan_id, idempotency_key)
);
CREATE INDEX central_needs_manual_need_events_revision_idx ON public.central_needs_manual_need_events (plan_revision_id);
CREATE INDEX central_needs_manual_need_events_org_idx ON public.central_needs_manual_need_events (organization_id);

ALTER TABLE public.central_needs_manual_need_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.central_needs_manual_need_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.central_needs_manual_need_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.central_needs_manual_need_events TO authenticated, service_role;

CREATE POLICY central_needs_manual_need_events_select_authorized
  ON public.central_needs_manual_need_events FOR SELECT TO authenticated
  USING (public.phoenix_status_center_authorized(organization_id, 'central_needs.view'));
CREATE POLICY central_needs_manual_need_events_role_eligible_restrictive
  ON public.central_needs_manual_need_events AS RESTRICTIVE TO authenticated
  USING (public._phoenix_central_needs_role_eligible_v1())
  WITH CHECK (public._phoenix_central_needs_role_eligible_v1());

COMMENT ON TABLE public.central_needs_manual_need_events IS
  'R1-a: append-only provenance chain of MANUAL annual-need lines. One chain per logical line (revision, beneficiary, item, warehouse). Never holds Excel record/cell/session identifiers, batch, expiry, price or supply origin. quantity_text is the canonical decimal; quantity is its STORED numeric.';

-- Append-only / draft-manual-only triggers -----------------------------------
CREATE OR REPLACE FUNCTION phoenix_private.central_needs_manual_event_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_status text;
  v_mode   text;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'central_needs_manual_event_immutable' USING ERRCODE = '23514', DETAIL = 'truncate';
  ELSIF TG_OP IN ('UPDATE', 'DELETE') THEN
    RAISE EXCEPTION 'central_needs_manual_event_immutable' USING ERRCODE = '23514', DETAIL = lower(TG_OP);
  END IF;
  SELECT r.status, r.source_mode INTO v_status, v_mode
    FROM public.central_needs_plan_revisions r
   WHERE r.id = NEW.plan_revision_id AND r.organization_id = NEW.organization_id;
  IF v_status IS DISTINCT FROM 'draft' OR v_mode IS DISTINCT FROM 'manual' THEN
    RAISE EXCEPTION 'central_needs_manual_event_revision_not_draft' USING ERRCODE = '23514',
      DETAIL = format('revision=%s status=%s mode=%s', NEW.plan_revision_id, v_status, v_mode);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_manual_event_guard_v1() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER central_needs_manual_need_events_r1_10_insert_guard
  BEFORE INSERT ON public.central_needs_manual_need_events
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_manual_event_guard_v1();
CREATE TRIGGER central_needs_manual_need_events_r1_10_immutable
  BEFORE UPDATE OR DELETE ON public.central_needs_manual_need_events
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_manual_event_guard_v1();
CREATE TRIGGER central_needs_manual_need_events_r1_10_truncate
  BEFORE TRUNCATE ON public.central_needs_manual_need_events
  FOR EACH STATEMENT EXECUTE FUNCTION phoenix_private.central_needs_manual_event_guard_v1();

-- ---------------------------------------------------------------------------
-- 4. Projection guard: no manual projection change without a same-transaction
--    event (ADR §4.4.1). Reads events only; writes nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION phoenix_private.central_needs_manual_projection_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_row   public.central_needs_need_lines%ROWTYPE;
  v_ev    public.central_needs_manual_need_events%ROWTYPE;
  v_found boolean;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM public.central_needs_need_lines WHERE lineage_mode = 'manual') THEN
      RAISE EXCEPTION 'manual_projection_change_without_event' USING ERRCODE = '42501', DETAIL = 'truncate';
    END IF;
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;
  IF v_row.lineage_mode IS DISTINCT FROM 'manual' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT e.* INTO v_ev
    FROM public.central_needs_manual_need_events e
   WHERE e.plan_revision_id = v_row.plan_revision_id
     AND e.beneficiary_organization_id = v_row.beneficiary_organization_id
     AND e.central_item_id = v_row.central_item_id
     AND e.target_warehouse_id IS NOT DISTINCT FROM v_row.target_warehouse_id
     AND e.txid = pg_catalog.txid_current()
   ORDER BY e.event_seq DESC
   LIMIT 1;
  v_found := FOUND;

  IF TG_OP = 'INSERT' THEN
    IF NOT v_found OR v_ev.event_kind NOT IN ('add', 'carried_forward')
       OR v_ev.quantity IS DISTINCT FROM NEW.approved_quantity
       OR v_ev.approved_unit IS DISTINCT FROM NEW.approved_unit THEN
      RAISE EXCEPTION 'manual_projection_change_without_event' USING ERRCODE = '42501',
        DETAIL = format('insert line=%s', NEW.id);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NOT v_found OR v_ev.event_kind <> 'correct'
       OR v_ev.quantity IS DISTINCT FROM NEW.approved_quantity
       OR NEW.plan_revision_id IS DISTINCT FROM OLD.plan_revision_id
       OR NEW.beneficiary_organization_id IS DISTINCT FROM OLD.beneficiary_organization_id
       OR NEW.central_item_id IS DISTINCT FROM OLD.central_item_id
       OR NEW.target_warehouse_id IS DISTINCT FROM OLD.target_warehouse_id
       OR NEW.approved_unit IS DISTINCT FROM OLD.approved_unit THEN
      RAISE EXCEPTION 'manual_projection_change_without_event' USING ERRCODE = '42501',
        DETAIL = format('update line=%s', OLD.id);
    END IF;
    RETURN NEW;
  ELSE
    IF NOT v_found OR v_ev.event_kind <> 'void' THEN
      RAISE EXCEPTION 'manual_projection_change_without_event' USING ERRCODE = '42501',
        DETAIL = format('delete line=%s', OLD.id);
    END IF;
    RETURN OLD;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION phoenix_private.central_needs_manual_projection_guard_v1() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER central_needs_need_lines_r1_10_manual_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.central_needs_need_lines
  FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_manual_projection_guard_v1();
CREATE TRIGGER central_needs_need_lines_r1_10_manual_truncate
  BEFORE TRUNCATE ON public.central_needs_need_lines
  FOR EACH STATEMENT EXECUTE FUNCTION phoenix_private.central_needs_manual_projection_guard_v1();

-- ---------------------------------------------------------------------------
-- 5. Deferred state assertion at COMMIT (ADR §4.4.2).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_assert_manual_projection_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rev   uuid;
  v_ben   uuid;
  v_item  uuid;
  v_wh    uuid;
  v_mode  text;
  v_last  public.central_needs_manual_need_events%ROWTYPE;
  v_rows  integer;
  v_line  public.central_needs_need_lines%ROWTYPE;
  v_count integer;
  v_max   integer;
  v_bad   integer;
  v_kind  text;
BEGIN
  IF TG_TABLE_NAME = 'central_needs_need_lines' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.lineage_mode <> 'manual' THEN RETURN NULL; END IF;
      v_rev := OLD.plan_revision_id; v_ben := OLD.beneficiary_organization_id;
      v_item := OLD.central_item_id; v_wh := OLD.target_warehouse_id;
    ELSE
      IF NEW.lineage_mode <> 'manual' THEN RETURN NULL; END IF;
      v_rev := NEW.plan_revision_id; v_ben := NEW.beneficiary_organization_id;
      v_item := NEW.central_item_id; v_wh := NEW.target_warehouse_id;
    END IF;
  ELSE
    v_rev := NEW.plan_revision_id; v_ben := NEW.beneficiary_organization_id;
    v_item := NEW.central_item_id; v_wh := NEW.target_warehouse_id;
  END IF;

  SELECT r.source_mode INTO v_mode FROM public.central_needs_plan_revisions r WHERE r.id = v_rev;

  SELECT e.* INTO v_last
    FROM public.central_needs_manual_need_events e
   WHERE e.plan_revision_id = v_rev AND e.beneficiary_organization_id = v_ben
     AND e.central_item_id = v_item AND e.target_warehouse_id IS NOT DISTINCT FROM v_wh
   ORDER BY e.event_seq DESC LIMIT 1;
  IF NOT FOUND THEN
    -- no chain: a manual projection row may not exist at all
    IF EXISTS (SELECT 1 FROM public.central_needs_need_lines l
                WHERE l.plan_revision_id = v_rev AND l.beneficiary_organization_id = v_ben
                  AND l.central_item_id = v_item AND l.target_warehouse_id IS NOT DISTINCT FROM v_wh
                  AND l.lineage_mode = 'manual') THEN
      RAISE EXCEPTION 'manual_projection_without_chain' USING ERRCODE = '23514',
        DETAIL = format('revision=%s item=%s', v_rev, v_item);
    END IF;
    RETURN NULL;
  END IF;

  -- chain integrity: gapless sequence, each event supersedes the previous one
  SELECT count(*), max(event_seq) INTO v_count, v_max
    FROM public.central_needs_manual_need_events e
   WHERE e.plan_revision_id = v_rev AND e.beneficiary_organization_id = v_ben
     AND e.central_item_id = v_item AND e.target_warehouse_id IS NOT DISTINCT FROM v_wh;
  IF v_count <> v_max THEN
    RAISE EXCEPTION 'manual_event_chain_gap' USING ERRCODE = '23514', DETAIL = format('revision=%s item=%s', v_rev, v_item);
  END IF;
  SELECT count(*) INTO v_bad
    FROM public.central_needs_manual_need_events e
    LEFT JOIN public.central_needs_manual_need_events p ON p.id = e.supersedes_event_id
   WHERE e.plan_revision_id = v_rev AND e.beneficiary_organization_id = v_ben
     AND e.central_item_id = v_item AND e.target_warehouse_id IS NOT DISTINCT FROM v_wh
     AND e.event_seq > 1
     AND (p.id IS NULL OR p.event_seq <> e.event_seq - 1
          OR p.plan_revision_id <> e.plan_revision_id OR p.beneficiary_organization_id <> e.beneficiary_organization_id
          OR p.central_item_id <> e.central_item_id OR p.target_warehouse_id IS DISTINCT FROM e.target_warehouse_id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'manual_event_chain_broken' USING ERRCODE = '23514', DETAIL = format('revision=%s item=%s', v_rev, v_item);
  END IF;

  IF v_mode IS DISTINCT FROM 'manual' THEN
    RAISE EXCEPTION 'manual_events_on_non_manual_revision' USING ERRCODE = '23514', DETAIL = format('revision=%s', v_rev);
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.central_needs_need_lines l
   WHERE l.plan_revision_id = v_rev AND l.beneficiary_organization_id = v_ben
     AND l.central_item_id = v_item AND l.target_warehouse_id IS NOT DISTINCT FROM v_wh;

  IF v_last.event_kind = 'void' THEN
    IF v_rows <> 0 THEN
      RAISE EXCEPTION 'manual_projection_present_after_void' USING ERRCODE = '23514', DETAIL = format('revision=%s item=%s', v_rev, v_item);
    END IF;
  ELSE
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'manual_projection_missing_for_live_event' USING ERRCODE = '23514', DETAIL = format('revision=%s item=%s rows=%s', v_rev, v_item, v_rows);
    END IF;
    SELECT * INTO v_line FROM public.central_needs_need_lines l
     WHERE l.plan_revision_id = v_rev AND l.beneficiary_organization_id = v_ben
       AND l.central_item_id = v_item AND l.target_warehouse_id IS NOT DISTINCT FROM v_wh;
    IF v_line.lineage_mode <> 'manual'
       OR v_line.approved_quantity IS DISTINCT FROM v_last.quantity
       OR v_line.approved_unit IS DISTINCT FROM v_last.approved_unit
       OR v_line.mapping_reason IS DISTINCT FROM v_last.reason
       OR v_line.mapped_by IS DISTINCT FROM v_last.actor_id
       OR v_line.unit_conversion_state <> 'canonical' THEN
      RAISE EXCEPTION 'manual_projection_disagrees_with_last_event' USING ERRCODE = '23514',
        DETAIL = format('revision=%s item=%s event=%s', v_rev, v_item, v_last.id);
    END IF;
    IF EXISTS (SELECT 1 FROM public.central_needs_need_line_sources s WHERE s.need_line_id = v_line.id) THEN
      RAISE EXCEPTION 'manual_line_has_source_lineage' USING ERRCODE = '23514', DETAIL = format('need_line=%s', v_line.id);
    END IF;
    -- beneficiary rule (same as the Excel path): a care institution
    IF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = v_ben AND o.organization_kind = 'care_institution') THEN
      RAISE EXCEPTION 'manual_line_beneficiary_not_care_institution' USING ERRCODE = '23514', DETAIL = format('beneficiary=%s', v_ben);
    END IF;
    -- scope exclusivity: institution-level XOR warehouse-split for one (revision, beneficiary, item)
    IF v_wh IS NULL THEN
      IF EXISTS (SELECT 1 FROM public.central_needs_need_lines l
                  WHERE l.plan_revision_id = v_rev AND l.beneficiary_organization_id = v_ben
                    AND l.central_item_id = v_item AND l.target_warehouse_id IS NOT NULL) THEN
        RAISE EXCEPTION 'manual_line_scope_conflict' USING ERRCODE = '23514', DETAIL = format('revision=%s item=%s', v_rev, v_item);
      END IF;
    ELSIF EXISTS (SELECT 1 FROM public.central_needs_need_lines l
                   WHERE l.plan_revision_id = v_rev AND l.beneficiary_organization_id = v_ben
                     AND l.central_item_id = v_item AND l.target_warehouse_id IS NULL) THEN
      RAISE EXCEPTION 'manual_line_scope_conflict' USING ERRCODE = '23514', DETAIL = format('revision=%s item=%s', v_rev, v_item);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public._phoenix_central_needs_assert_manual_projection_v1() FROM PUBLIC, anon, authenticated, service_role;

CREATE CONSTRAINT TRIGGER central_needs_need_lines_r1_20_assert_manual
  AFTER INSERT OR UPDATE OR DELETE ON public.central_needs_need_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_central_needs_assert_manual_projection_v1();
CREATE CONSTRAINT TRIGGER central_needs_manual_need_events_r1_20_assert_manual
  AFTER INSERT ON public.central_needs_manual_need_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_central_needs_assert_manual_projection_v1();

-- ---------------------------------------------------------------------------
-- 6. The existing integrity function: exactly ONE added clause (ADR §4.4.4).
--    Body otherwise byte-identical to the live definition (generated by the
--    build script from the pinned definition; see R1a_01.build.md).
-- ---------------------------------------------------------------------------
-- source definition md5 (live rig, M217/M218 chain, LF-normalized): ff357d83f1f879e29b0ed882bc8dc3fa
CREATE OR REPLACE FUNCTION public._phoenix_central_needs_assert_need_line_integrity_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_line_ids uuid[];
  v_line_id  uuid;
  v_line     public.central_needs_need_lines%ROWTYPE;
  v_links    bigint;
  v_sum      numeric;
  v_bad      record;
  v_bad_ben  record;
  v_bad_region record;
  v_scope_session uuid;
  v_scope_sheet   integer;
  v_c5_links      uuid[] := ARRAY[]::uuid[];
  v_c5_link       uuid;
  v_c5_reason     text;
  v_c5_row        record;
BEGIN
  IF TG_TABLE_NAME = 'central_needs_need_lines' THEN
    v_line_ids := ARRAY[NEW.id];
  ELSIF TG_TABLE_NAME = 'central_needs_beneficiary_column_mappings' THEN
    -- 213 ADDITION — a privileged UPDATE (re-pointing beneficiary) or DELETE
    -- of a mapping row must be re-checked against every need line any of its
    -- physical column's cells already feeds. The RPC path can never reach
    -- this state (phoenix_central_needs_set_need_line always re-resolves the
    -- CURRENT mapping), so this exists purely as defence in depth against a
    -- privileged session bypassing set_beneficiary_columns entirely.
    SELECT coalesce(array_agg(DISTINCT ls.need_line_id), ARRAY[]::uuid[])
      INTO v_line_ids
      FROM public.central_needs_need_line_sources ls
      JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
     WHERE r.import_session_id = COALESCE(NEW.import_session_id, OLD.import_session_id)
       AND (r.source_provenance->>'sheetIndex')::integer       = COALESCE(NEW.sheet_index, OLD.sheet_index)
       AND (r.source_provenance->'coordinate'->>'col')::integer = COALESCE(NEW.column_index, OLD.column_index);

    -- A mapping whose physical column already feeds a need line cannot be
    -- DELETED outright (unlike an UPDATE, there is then no mapping left at
    -- all to compare a line's beneficiary against, so the ordinary per-line
    -- comparison below would find nothing and silently pass).
    --
    -- 216 T5' — the ONE permitted case of an in-use delete: the governed
    -- convert_column path, judged at COMMIT. It passes only when the column
    -- is region-governed and every linked cell of it lies inside exactly one
    -- ACTIVE beneficiary region naming its line's beneficiary. Anything else
    -- keeps the unchanged refusal below.
    IF TG_OP = 'DELETE' AND cardinality(v_line_ids) > 0
       AND NOT public._phoenix_central_needs_region_column_covered_v1(
             OLD.import_session_id, OLD.sheet_index, OLD.column_index) THEN
      RAISE EXCEPTION 'beneficiary_column_mapping_in_use' USING ERRCODE = '23514',
        DETAIL = format('session=%s sheet=%s column=%s need_lines=%s',
                        OLD.import_session_id, OLD.sheet_index, OLD.column_index, v_line_ids),
        HINT = 'This physical column already feeds one or more need lines and cannot be unmapped directly.';
    END IF;
  ELSIF TG_TABLE_NAME = 'central_needs_beneficiary_regions' THEN
    -- 216 ADDITION (a) — a region version was inserted or retired. Only those
    -- two events change coverage; the FK actor nulling (T1 transition (b))
    -- does not, and a delete is impossible (T1). Every need-line-linked cell
    -- of the touched (session, sheet) must pass the linked-cell rule in the
    -- state being committed — not only cells of the changed rectangle.
    IF TG_OP = 'UPDATE' AND NOT (OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL) THEN
      RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' THEN
      v_scope_session := OLD.import_session_id;
      v_scope_sheet   := OLD.sheet_index;
    ELSE
      v_scope_session := NEW.import_session_id;
      v_scope_sheet   := NEW.sheet_index;
    END IF;
    SELECT * INTO v_bad_region
      FROM public._phoenix_central_needs_region_linked_cell_violations_v1(v_scope_session, v_scope_sheet)
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'beneficiary_region_in_use' USING ERRCODE = '23514',
        DETAIL = format('session=%s sheet=%s source_record=%s need_line=%s line_beneficiary=%s failure=%s',
                        v_scope_session, v_scope_sheet, v_bad_region.source_record_id,
                        v_bad_region.need_line_id, v_bad_region.line_beneficiary, v_bad_region.failure),
        HINT = 'A cell already feeding a need line would lose or switch its beneficiary region.';
    END IF;
    SELECT coalesce(array_agg(DISTINCT ls.need_line_id), ARRAY[]::uuid[])
      INTO v_line_ids
      FROM public.central_needs_need_line_sources ls
      JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
     WHERE r.import_session_id = v_scope_session
       AND (public._phoenix_central_needs_m213_coordinate_v1(r.source_provenance->>'sheetIndex') = v_scope_sheet
            OR public._phoenix_central_needs_m213_coordinate_v1(r.source_provenance->>'sheetIndex') IS NULL);
  ELSIF TG_OP = 'DELETE' THEN
    v_line_ids := ARRAY[OLD.need_line_id];
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.need_line_id IS DISTINCT FROM NEW.need_line_id THEN
      v_line_ids := ARRAY[NEW.need_line_id, OLD.need_line_id];
    ELSE
      v_line_ids := ARRAY[NEW.need_line_id];
    END IF;
  ELSE
    v_line_ids := ARRAY[NEW.need_line_id];
  END IF;

  FOREACH v_line_id IN ARRAY v_line_ids
  LOOP
    SELECT * INTO v_line FROM public.central_needs_need_lines WHERE id = v_line_id;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    -- R1-a: manual lines are judged only by the manual assertion (R1a_01 section 5), never here.
    IF v_line.lineage_mode IS DISTINCT FROM 'excel' THEN
      CONTINUE;
    END IF;

    SELECT count(*), coalesce(sum(designated_quantity), 0)
      INTO v_links, v_sum
      FROM public.central_needs_need_line_sources
     WHERE need_line_id = v_line.id;

    IF v_links = 0 THEN
      RAISE EXCEPTION 'need_line_requires_source_lineage' USING ERRCODE = '23514',
        DETAIL = format('need_line=%s', v_line.id),
        HINT = 'Every operational need line must name at least one immutable source record.';
    END IF;

    IF v_sum <> v_line.approved_quantity THEN
      RAISE EXCEPTION 'need_line_quantity_provenance_mismatch' USING ERRCODE = '23514',
        DETAIL = format('need_line=%s approved=%s designated_sum=%s',
                        v_line.id, v_line.approved_quantity, v_sum);
    END IF;

    SELECT r.target_entity, m.central_item_id, m.decision
      INTO v_bad
      FROM public.central_needs_need_line_sources ls
      JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
      LEFT JOIN public.central_needs_record_mappings m
             ON m.import_session_id = r.import_session_id
            AND m.target_entity     = r.target_entity
     WHERE ls.need_line_id = v_line.id
       AND (m.id IS NULL
            OR m.decision <> 'mapped'
            OR m.central_item_id IS DISTINCT FROM v_line.central_item_id)
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'need_line_material_mapping_conflict' USING ERRCODE = '23514',
        DETAIL = format('need_line=%s item=%s source_entity=%s mapped_item=%s decision=%s',
                        v_line.id, v_line.central_item_id, v_bad.target_entity,
                        coalesce(v_bad.central_item_id::text, '(none)'),
                        coalesce(v_bad.decision, '(none)')),
        HINT = 'Change the canonical mapping through the mapping workflow first; a source reviewed as one material cannot feed a line for another.';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM public.central_needs_need_lines a
        JOIN public.central_needs_need_lines b
          ON b.plan_revision_id            = a.plan_revision_id
         AND b.beneficiary_organization_id = a.beneficiary_organization_id
         AND b.central_item_id             = a.central_item_id
       WHERE a.plan_revision_id            = v_line.plan_revision_id
         AND a.beneficiary_organization_id = v_line.beneficiary_organization_id
         AND a.central_item_id             = v_line.central_item_id
         AND a.target_warehouse_id IS NULL
         AND b.target_warehouse_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'need_line_scope_mixes_institution_and_warehouse' USING ERRCODE = '23514',
        DETAIL = format('revision=%s beneficiary=%s item=%s',
                        v_line.plan_revision_id, v_line.beneficiary_organization_id,
                        v_line.central_item_id),
        HINT = 'An annual requirement is either institution-level or split by warehouse, never both.';
    END IF;

    -- 213 ADDITION — every linked cell's CONFIRMED column mapping (when one
    -- exists) must agree with this line's beneficiary. A cell with no
    -- mapping at all is not re-flagged here; the RPC path already forbids
    -- reaching this state through it. This clause catches only a mapping
    -- that existed and was changed, or a privileged bypass of the RPC.
    SELECT r.id AS source_record_id, cm.decision AS column_decision,
           cm.beneficiary_organization_id AS mapped_beneficiary
      INTO v_bad_ben
      FROM public.central_needs_need_line_sources ls
      JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
      JOIN public.central_needs_beneficiary_column_mappings cm
        ON cm.import_session_id = r.import_session_id
       AND cm.sheet_index       = (r.source_provenance->>'sheetIndex')::integer
       AND cm.column_index      = (r.source_provenance->'coordinate'->>'col')::integer
     WHERE ls.need_line_id = v_line.id
       -- (independent review finding 1) a column reviewed as non_beneficiary
       -- never agrees with any line, whatever the line's beneficiary.
       AND (cm.decision IS DISTINCT FROM 'beneficiary'
            OR cm.beneficiary_organization_id IS DISTINCT FROM v_line.beneficiary_organization_id)
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'beneficiary_column_mapping_conflict' USING ERRCODE = '23514',
        DETAIL = format('need_line=%s source_record=%s column_decision=%s mapped_beneficiary=%s line_beneficiary=%s',
                        v_line.id, v_bad_ben.source_record_id, v_bad_ben.column_decision,
                        coalesce(v_bad_ben.mapped_beneficiary::text, '(none)'),
                        v_line.beneficiary_organization_id),
        HINT = 'This linked cell''s confirmed column belongs to a different beneficiary than the line. Re-map the column or correct the line through the explicit delete path.';
    END IF;

    -- 216 ADDITION (b) — every linked cell in a REGION-GOVERNED column must lie
    -- inside exactly one ACTIVE beneficiary region naming this line's
    -- beneficiary. A cell there whose row cannot be located also fails.
    -- Columns no ACTIVE region spans are judged by the M213 clause above only.
    SELECT r.id AS source_record_id, g.covering_count, g.covering_decision,
           g.covering_beneficiary_id
      INTO v_bad_region
      FROM public.central_needs_need_line_sources ls
      JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
      CROSS JOIN LATERAL public._phoenix_central_needs_resolve_region_v1(r.import_session_id, r.source_provenance) g
     WHERE ls.need_line_id = v_line.id
       AND g.column_governed
       AND NOT (g.covering_count = 1
                AND g.covering_decision = 'beneficiary'
                AND g.covering_beneficiary_id = v_line.beneficiary_organization_id)
     LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'beneficiary_region_mapping_conflict' USING ERRCODE = '23514',
        DETAIL = format('need_line=%s source_record=%s covering_regions=%s region_decision=%s region_beneficiary=%s line_beneficiary=%s',
                        v_line.id, v_bad_region.source_record_id, v_bad_region.covering_count,
                        coalesce(v_bad_region.covering_decision, '(none)'),
                        coalesce(v_bad_region.covering_beneficiary_id::text, '(none)'),
                        v_line.beneficiary_organization_id),
        HINT = 'This linked cell''s ACTIVE beneficiary region does not name the line''s beneficiary. Correct the line through the explicit delete path.';
    END IF;
  END LOOP;

  -- 217 ADDITION (C5 §9/§11) — the shared quantity-lineage helper judges ONLY
  -- the touched link(s), after every M212/M213/M216 clause above (they keep
  -- their precedence): a need_line_sources INSERT; an UPDATE that changes
  -- need_line_id, source_record_id, designated_quantity or applied_override_id;
  -- a need_lines UPDATE that moves plan_revision_id or organization_id (all of
  -- its links). A DELETE, a mapping event or a region event never runs it. The
  -- table and the operation are tested BEFORE any table-specific field is read.
  IF TG_TABLE_NAME = 'central_needs_need_line_sources' THEN
    IF TG_OP = 'INSERT' THEN
      v_c5_links := ARRAY[NEW.id];
    ELSIF TG_OP = 'UPDATE' THEN
      IF (NEW.need_line_id, NEW.source_record_id, NEW.designated_quantity, NEW.applied_override_id)
         IS DISTINCT FROM (OLD.need_line_id, OLD.source_record_id, OLD.designated_quantity, OLD.applied_override_id) THEN
        v_c5_links := ARRAY[NEW.id];
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'central_needs_need_lines' THEN
    IF TG_OP = 'UPDATE' THEN
      IF (NEW.plan_revision_id, NEW.organization_id) IS DISTINCT FROM (OLD.plan_revision_id, OLD.organization_id) THEN
        SELECT coalesce(array_agg(ls.id ORDER BY ls.id), ARRAY[]::uuid[])
          INTO v_c5_links
          FROM public.central_needs_need_line_sources ls
         WHERE ls.need_line_id = NEW.id;
      END IF;
    END IF;
  END IF;

  FOREACH v_c5_link IN ARRAY v_c5_links
  LOOP
    v_c5_reason := public._phoenix_central_needs_quantity_lineage_violation_v1(v_c5_link);
    IF v_c5_reason IS NOT NULL THEN
      SELECT r.import_session_id, ls.source_record_id, ls.need_line_id
        INTO v_c5_row
        FROM public.central_needs_need_line_sources ls
        JOIN public.central_needs_source_records r ON r.id = ls.source_record_id
       WHERE ls.id = v_c5_link;
      RAISE EXCEPTION 'need_line_quantity_lineage_unsafe' USING ERRCODE = '23514',
        DETAIL = format('session=%s source_record=%s need_line=%s reason=%s',
                        v_c5_row.import_session_id, v_c5_row.source_record_id, v_c5_row.need_line_id, v_c5_reason),
        HINT = 'A need-line source link written outside the canonical RPC does not carry a safe quantity lineage.';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$function$;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                  WHERE a.attrelid = 'public.central_needs_plan_revisions'::regclass AND a.attname = 'source_mode'
                    AND a.attnotnull AND pg_get_expr(d.adbin, d.adrelid) LIKE '''excel''%') THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a01): source_mode shape';
  END IF;
  IF EXISTS (SELECT 1 FROM public.central_needs_plan_revisions WHERE source_mode <> 'excel')
     OR EXISTS (SELECT 1 FROM public.central_needs_need_lines WHERE lineage_mode <> 'excel') THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a01): existing rows must read excel';
  END IF;
  IF (SELECT attgenerated FROM pg_catalog.pg_attribute
       WHERE attrelid = 'public.central_needs_manual_need_events'::regclass AND attname = 'quantity') <> 's' THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a01): events.quantity must be GENERATED ... STORED';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
              WHERE attrelid = 'public.central_needs_manual_need_events'::regclass AND attname IN ('quantity', 'quantity_text')
                AND atttypmod <> -1) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a01): no numeric typmod (Q-S is open)';
  END IF;
  SELECT count(*) INTO v_n FROM pg_catalog.pg_trigger t
   WHERE NOT t.tgisinternal AND t.tgname IN (
     'central_needs_plan_revisions_r1_10_source_mode', 'central_needs_need_lines_r1_05_lineage_mode',
     'central_needs_need_lines_r1_10_manual_guard', 'central_needs_need_lines_r1_10_manual_truncate',
     'central_needs_need_lines_r1_20_assert_manual', 'central_needs_manual_need_events_r1_20_assert_manual',
     'central_needs_manual_need_events_r1_10_insert_guard', 'central_needs_manual_need_events_r1_10_immutable',
     'central_needs_manual_need_events_r1_10_truncate');
  IF v_n <> 9 THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a01): expected 9 R1-a triggers, found %', v_n;
  END IF;
  -- explicit ACLs: owner-only EXECUTE on every function added or replaced here
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid IN (
       'phoenix_private.central_needs_source_mode_immutable_v1()'::regprocedure,
       'phoenix_private.central_needs_lineage_mode_v1()'::regprocedure,
       'phoenix_private.central_needs_manual_event_guard_v1()'::regprocedure,
       'phoenix_private.central_needs_manual_projection_guard_v1()'::regprocedure,
       'public._phoenix_central_needs_assert_manual_projection_v1()'::regprocedure,
       'public._phoenix_central_needs_assert_need_line_integrity_v1()'::regprocedure)
       AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
            OR has_function_privilege('service_role', p.oid, 'EXECUTE')
            OR EXISTS (SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a WHERE a.grantee = 0))) THEN
    RAISE EXCEPTION 'VERIFY FAILED (R1a01): a function is executable by PUBLIC, anon, authenticated or service_role';
  END IF;
END
$verify$;

COMMIT;

-- ===========================================================================
-- PDA-PROC-1 / M221 - PHARMACY DEPARTMENT AUTHORITY: NO SUPPLEMENTARY
--                     (LOCAL) PROCUREMENT STATE, FOR ANY WRITER
--
-- WHY THIS MIGRATION EXISTS
--   An organization whose organization_kind is 'pharmacy_department_authority'
--   (PDA, M171) supplies care institutions from its central warehouses; it
--   does not purchase locally. Nothing in 001-220 says so for procurement:
--   no procurement RPC and no procurement table reads organization_kind.
--   phoenix_procurement_save_supplier needs no warehouse, so a super_admin
--   (or a PDA institution_admin holding local_procurement.manage) can create
--   a PDA supplier through it; and service_role, which holds direct INSERT,
--   UPDATE and DELETE on warehouse_stock and on the procurement tables, or the
--   owner, can write a PDA supplier, a PDA-labelled order line, order event,
--   receipt, receipt line or return under a CARE order, re-label a supplier,
--   an order or an order line onto a PDA, or write a supplementary lot owned
--   by a PDA. Orders are already closed by the
--   M184 procurement root guard (an institution warehouse is required and a
--   PDA owns central warehouses only), but with a warehouse token, not with
--   this invariant's.
--
-- THE INVARIANT - the persistent procurement-state boundary
--   A row of procurement_suppliers, procurement_orders,
--   procurement_order_lines, procurement_order_events, procurement_receipts,
--   procurement_receipt_lines or procurement_returns may be written for an
--   organization - and a warehouse_stock lot with
--   purchase_origin = 'supplementary' (WHATEVER its supply_type) may enter an
--   organization's domain - only when organizations.organization_kind of
--   NEW.organization_id is exactly 'care_institution'. A PDA, a missing
--   organization (never eligible: a data-modifying CTE could otherwise create
--   the organization after this check and before the foreign key check) and
--   any other kind are refused. super_admin is no exception, and neither is
--   the owner, service_role or a superuser session. Eligibility is read from
--   the canonical column only - never from a role, a permission, a warehouse
--   type or a name.
--
--   The stock predicate is purchase_origin alone, on purpose: the M088 CHECK
--   ((supply_type = 'purchase') = (purchase_origin IS NOT NULL)) evaluates to
--   UNKNOWN - and therefore passes - for supply_type NULL with
--   purchase_origin 'supplementary'. purchase_origin 'central', aid, kimadia
--   and unspecified provenance are untouched. M088 is not modified.
--
-- ORDER LINES, ORDER EVENTS, RECEIPTS, RECEIPT LINES AND RETURNS - THE CHILDREN
--   The application RPCs copy the organization of the parent order, but each
--   of these tables carries its own organization_id with no foreign key tying
--   it to the parent's (row-level security reads receipts and returns by it),
--   and service_role can INSERT, UPDATE and DELETE them directly, so a
--   PDA-labelled child under a care order is refused at write time (INSERT).
--   UPDATE: procurement_order_lines has no immutability trigger, so its
--   UPDATE OF organization_id is guarded too. The other four need no UPDATE
--   guard: the M087 immutability triggers (procurement_order_events_immutable,
--   procurement_receipts_immutable, procurement_receipt_lines_immutable,
--   procurement_returns_immutable; latest body M141
--   phoenix_procurement_forbid_mutation) refuse every UPDATE except two
--   byte-identical-content fills (the demo marker and the ledger pointers), so
--   organization_id can never change; the prelude pins all four and the
--   dynamic suite proves it. (M141 carries a stale comment claiming M087 never
--   made procurement_order_events immutable; M087:403 does.)
--
-- QUARANTINE - DELIBERATELY NOT GUARDED
--   warehouse_quarantine_stock is a custody, return and exception
--   destination. The canonical return, recall and exception flows (M088,
--   M128, M135, M157, M162, M185) write it preserving supply_type and
--   purchase_origin, so a PDA central warehouse may legitimately take a
--   returned supplementary lot into quarantine custody. Holding custody is not
--   operating local procurement, and a guard there could strand a legal
--   return. The dynamic suite proves M221 adds no rejection to that path.
--
-- WHAT THIS MIGRATION CHANGES (and nothing else)
--   1. public._phoenix_pda_supplementary_procurement_guard_v1() - ONE new
--      SECURITY DEFINER trigger function (owner-only: EXECUTE revoked from
--      PUBLIC, anon, authenticated and service_role; search_path pg_catalog,
--      pg_temp; every application object schema-qualified; no write; no
--      dynamic SQL). It reads only the kind of NEW.organization_id and
--      refuses with
--        pharmacy_department_supplementary_procurement_forbidden
--      SQLSTATE 23514 (a business constraint refusal, the M171/M183/M184
--      convention; no procurement writer catches 23514), with a STATIC detail
--      that carries no identifier, table name or kind. On warehouse_stock it
--      first returns at once unless purchase_origin is 'supplementary'.
--   2. Twelve BEFORE ROW triggers on that function, named phoenix_pda_* so
--      they fire before every existing BEFORE trigger of their tables (byte
--      order) and the refusal surfaces with this token:
--        procurement_suppliers      INSERT; UPDATE OF organization_id
--        procurement_orders         INSERT; UPDATE OF organization_id
--        procurement_order_lines    INSERT; UPDATE OF organization_id
--        procurement_order_events   INSERT
--        procurement_receipts       INSERT
--        procurement_receipt_lines  INSERT
--        procurement_returns        INSERT
--        warehouse_stock            INSERT WHEN purchase_origin = supplementary;
--                                   UPDATE OF purchase_origin, organization_id
--                                   WHEN the row becomes, or moves as,
--                                   supplementary.
--      The WHEN clauses and column lists keep every unrelated write away from
--      the function: aid, kimadia, purchase/central and unspecified stock,
--      quantity and metadata updates, and every procurement status change
--      never call it.
--
-- WHAT THIS MIGRATION IS NOT
--   Forward-only. No RPC is created or replaced: none of the procurement
--   family (save_supplier, create_order, add/remove_order_line,
--   submit/decide/cancel/receive_order, return_to_supplier,
--   phoenix_subpurchase_direct_entry, _phoenix_procurement_post_receipt_line),
--   no quarantine, return, recall or exception RPC, and not the read-only
--   phoenix_subpurchase_duplicate_candidates, which returns only the caller
--   organization's own supplementary lots - none can exist for a PDA once
--   this holds. No table, column, constraint, index, policy, grant, default
--   privilege or permission key; no business row written; migrations 001-220
--   (M088 included) untouched.
--
-- ACTIVATION
--   READ COMMITTED; applied by the owner of the eight guarded tables with
--   row-level security bypass (the definer lookup must see every
--   organization). LOCAL lock_timeout = 3s (bounded wait, no NOWAIT: an
--   autovacuum worker is cancelled for a waiting lock, never for NOWAIT) and
--   statement_timeout = 60s from the first read on. The prelude - catalog
--   reads and plain counts, before any lock - refuses deterministically:
--     221_already_applied                    the function and all 12 triggers
--     221_precondition_failed: partial M221 object set
--     221_precondition_failed: ...           isolation, applier, schema drift
--     221_precondition_failed: legacy non-care procurement rows present
--       (DETAIL: table names and counts only) - a supplier, order, order
--       line, receipt, receipt line, return or order event whose organization
--       is not an existing care institution, or a warehouse_stock lot with
--       purchase_origin 'supplementary' so owned.
--   Then SHARE ROW EXCLUSIVE on the eight guarded tables (what CREATE TRIGGER
--   takes), held to COMMIT, so no writer is half-way through while the
--   triggers attach. VERIFY re-runs the census of the eight guarded tables
--   UNDER that lock and pins the function and the exact twelve bindings.
--
-- RESIDUALS (reported, deliberately not closed here)
--   * CROSS-CARE CHILD LABEL MISMATCH (deferred, separate defect): the guard
--     judges the kind of a row's OWN organization_id, so raw owner or
--     service_role SQL can still label a child row with care institution A
--     under care institution B's order. M221 enforces only the PDA exclusion;
--     child/parent organization consistency is left to a later Director
--     decision.
--   * Raw owner or service_role SQL into outlet_stock or
--     warehouse_quarantine_stock (custody, out of scope; a PDA has no
--     outlets).
--   * A superuser session with session_replication_role = replica disables
--     ordinary triggers.
-- ===========================================================================

BEGIN;

-- Every unqualified name in this migration resolves in pg_catalog (and the
-- session's own temporary schema last): nothing in public can shadow it.
SET LOCAL search_path = pg_catalog, pg_temp;
-- Bounded from the first read on: a lock not granted within 3s, or a read
-- that runs away, fails M221 closed.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ----------------------------------------------------------------------------
-- 0. Preconditions - catalog reads and plain SELECT counts only, BEFORE any
--    lock, so every refusal here is deterministic.
-- ----------------------------------------------------------------------------
DO $prelude$
DECLARE
  v_me       oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user);
  v_super    boolean;
  v_bypass   boolean;
  v_fn       oid := pg_catalog.to_regprocedure('public._phoenix_pda_supplementary_procurement_guard_v1()');
  v_triggers integer;
  v_kinds    text[];
  v_census   text;
  v_row      record;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION '221_precondition_failed: READ COMMITTED isolation is required'
      USING DETAIL = pg_catalog.format('transaction_isolation=%s', pg_catalog.current_setting('transaction_isolation'));
  END IF;

  -- 1. Idempotence: all of M221 present -> already applied; any part -> partial.
  SELECT pg_catalog.count(*) INTO v_triggers
    FROM pg_catalog.pg_trigger t
   WHERE t.tgname IN ('phoenix_pda_supplier_insert_guard', 'phoenix_pda_supplier_reassign_guard',
                      'phoenix_pda_order_insert_guard', 'phoenix_pda_order_reassign_guard',
                      'phoenix_pda_order_line_insert_guard', 'phoenix_pda_order_line_reassign_guard',
                      'phoenix_pda_order_event_insert_guard',
                      'phoenix_pda_receipt_insert_guard', 'phoenix_pda_receipt_line_insert_guard',
                      'phoenix_pda_return_insert_guard',
                      'phoenix_pda_supplementary_stock_insert_guard', 'phoenix_pda_supplementary_stock_reforge_guard');
  IF v_fn IS NOT NULL AND v_triggers = 12 THEN
    RAISE EXCEPTION '221_already_applied';
  END IF;
  IF v_fn IS NOT NULL OR v_triggers > 0 THEN
    RAISE EXCEPTION '221_precondition_failed: partial M221 object set'
      USING DETAIL = pg_catalog.format('function_present=%s triggers_present=%s', (v_fn IS NOT NULL)::text, v_triggers);
  END IF;

  -- 2. The applier: bypasses row-level security (the definer lookup must see
  --    every organization) and owns the eight guarded tables (CREATE TRIGGER).
  SELECT r.rolsuper, r.rolbypassrls INTO v_super, v_bypass FROM pg_catalog.pg_roles r WHERE r.oid = v_me;
  IF NOT (v_super OR v_bypass) THEN
    RAISE EXCEPTION '221_precondition_failed: the applying role must bypass row-level security'
      USING DETAIL = pg_catalog.format('role=%s', current_user);
  END IF;

  -- 3. Schema: every relation and column the three guards and the census read.
  FOR v_row IN
    SELECT x.rel FROM (VALUES ('organizations'), ('warehouses'), ('procurement_suppliers'), ('procurement_orders'),
                              ('warehouse_stock'), ('procurement_order_lines'), ('procurement_receipts'),
                              ('procurement_receipt_lines'), ('procurement_returns'), ('procurement_order_events')) AS x(rel)
  LOOP
    IF pg_catalog.to_regclass('public.' || v_row.rel) IS NULL THEN
      RAISE EXCEPTION '221_precondition_failed: schema drift: table public.% is absent', v_row.rel;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c
              WHERE c.oid IN ('public.procurement_suppliers'::pg_catalog.regclass, 'public.procurement_orders'::pg_catalog.regclass,
                              'public.procurement_order_lines'::pg_catalog.regclass, 'public.procurement_order_events'::pg_catalog.regclass,
                              'public.procurement_receipts'::pg_catalog.regclass, 'public.procurement_receipt_lines'::pg_catalog.regclass,
                              'public.procurement_returns'::pg_catalog.regclass, 'public.warehouse_stock'::pg_catalog.regclass)
                AND c.relowner <> v_me) THEN
    RAISE EXCEPTION '221_precondition_failed: M221 must be applied by the owner of the eight guarded tables'
      USING DETAIL = pg_catalog.format('role=%s', current_user);
  END IF;

  FOR v_row IN
    SELECT x.rel, x.col, x.typ, x.nn
      FROM (VALUES ('organizations', 'id', 'uuid', true),
                   ('organizations', 'organization_kind', 'text', true),
                   ('procurement_suppliers', 'organization_id', 'uuid', true),
                   ('procurement_orders', 'organization_id', 'uuid', true),
                   ('warehouse_stock', 'organization_id', 'uuid', true),
                   ('warehouse_stock', 'purchase_origin', 'text', false),
                   ('procurement_order_lines', 'organization_id', 'uuid', true),
                   ('procurement_receipts', 'organization_id', 'uuid', true),
                   ('procurement_receipt_lines', 'organization_id', 'uuid', true),
                   ('procurement_returns', 'organization_id', 'uuid', true),
                   ('procurement_order_events', 'organization_id', 'uuid', true)) AS x(rel, col, typ, nn)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                    WHERE a.attrelid = pg_catalog.to_regclass('public.' || v_row.rel) AND a.attname = v_row.col
                      AND NOT a.attisdropped AND a.atttypid = pg_catalog.to_regtype(v_row.typ)
                      AND (a.attnotnull OR NOT v_row.nn)) THEN
      RAISE EXCEPTION '221_precondition_failed: schema drift: public.%.% is not % %', v_row.rel, v_row.col, v_row.typ,
        CASE WHEN v_row.nn THEN 'NOT NULL' ELSE '(nullable)' END;
    END IF;
  END LOOP;

  -- The judged vocabulary: exactly the two M171 kinds.
  SELECT pg_catalog.array_agg(DISTINCT m.captures[1] ORDER BY m.captures[1])
    INTO v_kinds
    FROM pg_catalog.pg_constraint c
    CROSS JOIN LATERAL pg_catalog.regexp_matches(pg_catalog.pg_get_constraintdef(c.oid, true), '''([^'']+)''', 'g') AS m(captures)
   WHERE c.conrelid = 'public.organizations'::pg_catalog.regclass
     AND c.conname = 'organizations_organization_kind_chk'
     AND c.contype = 'c';
  IF v_kinds IS DISTINCT FROM ARRAY['care_institution', 'pharmacy_department_authority']::text[] THEN
    RAISE EXCEPTION '221_precondition_failed: schema drift: organization_kind vocabulary is not {care_institution, pharmacy_department_authority}'
      USING DETAIL = pg_catalog.format('found=%s', coalesce(v_kinds, ARRAY[]::text[]));
  END IF;

  -- The kind is immutable (M171), so the guard judges a value that cannot
  -- change under it; the lookup must see every organization row.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'public.organizations'::pg_catalog.regclass
                    AND t.tgname = 'organizations_kind_immutable_trg'
                    AND t.tgtype = 19 AND t.tgenabled = 'O' AND NOT t.tgisinternal
                    AND pg_catalog.array_to_string(t.tgattr::pg_catalog.int2[], ',')
                        = (SELECT a.attnum::text FROM pg_catalog.pg_attribute a
                            WHERE a.attrelid = 'public.organizations'::pg_catalog.regclass
                              AND a.attname = 'organization_kind' AND NOT a.attisdropped)) THEN
    RAISE EXCEPTION '221_precondition_failed: schema drift: organizations_kind_immutable_trg is not the enabled M171 BEFORE UPDATE OF organization_kind trigger';
  END IF;
  IF (SELECT c.relforcerowsecurity FROM pg_catalog.pg_class c WHERE c.oid = 'public.organizations'::pg_catalog.regclass) THEN
    RAISE EXCEPTION '221_precondition_failed: schema drift: public.organizations forces row-level security';
  END IF;

  -- The independent second barrier of the order boundary (on which the
  -- receipt/return closure rests): a PDA owns central warehouses only (M171)
  -- and the M184 order root guard requires an institution warehouse.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'public.warehouses'::pg_catalog.regclass
                    AND t.tgname = 'warehouses_owner_kind_guard_trg' AND t.tgenabled = 'O' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION '221_precondition_failed: schema drift: warehouses_owner_kind_guard_trg is absent or disabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = 'public.procurement_orders'::pg_catalog.regclass
                    AND t.tgname = 'phoenix_procurement_order_root_guard' AND t.tgenabled = 'O' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION '221_precondition_failed: schema drift: phoenix_procurement_order_root_guard is absent or disabled';
  END IF;

  -- UPDATE of procurement_order_events, procurement_receipts,
  -- procurement_receipt_lines and procurement_returns (organization_id
  -- included) is refused for every role by the M087 immutability triggers
  -- (latest body M141), so M221 guards their INSERT only. Pin those four
  -- BEFORE UPDATE OR DELETE ROW triggers. procurement_order_lines has none,
  -- which is why its UPDATE OF organization_id is guarded below.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t
       WHERE t.tgrelid IN ('public.procurement_order_events'::pg_catalog.regclass, 'public.procurement_receipts'::pg_catalog.regclass,
                           'public.procurement_receipt_lines'::pg_catalog.regclass, 'public.procurement_returns'::pg_catalog.regclass)
         AND t.tgname IN ('procurement_order_events_immutable', 'procurement_receipts_immutable', 'procurement_receipt_lines_immutable',
                          'procurement_returns_immutable')
         AND t.tgname = (SELECT c.relname FROM pg_catalog.pg_class c WHERE c.oid = t.tgrelid) || '_immutable'
         AND t.tgtype = 27 AND t.tgenabled = 'O' AND NOT t.tgisinternal
         AND t.tgfoid = pg_catalog.to_regprocedure('public.phoenix_procurement_forbid_mutation()')) <> 4 THEN
    RAISE EXCEPTION '221_precondition_failed: schema drift: the M087 order-event, receipt, receipt-line and return immutability triggers are absent or changed';
  END IF;

  -- 4. Legacy census: nothing the invariant forbids may already exist - every
  --    procurement table and supplementary warehouse_stock. Counts only; the
  --    DETAIL names tables, never rows.
  SELECT pg_catalog.string_agg(pg_catalog.format('%s=%s', x.rel, x.n), ', ' ORDER BY x.ord) INTO v_census
    FROM (SELECT 1 AS ord, 'procurement_suppliers'::text AS rel, pg_catalog.count(*) AS n
            FROM public.procurement_suppliers t
           WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')
          UNION ALL
          SELECT 2, 'procurement_orders', pg_catalog.count(*)
            FROM public.procurement_orders t
           WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')
          UNION ALL
          SELECT 3, 'warehouse_stock', pg_catalog.count(*)
            FROM public.warehouse_stock t
           WHERE t.purchase_origin = 'supplementary'
             AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')
          UNION ALL
          SELECT 4, 'procurement_order_lines', pg_catalog.count(*)
            FROM public.procurement_order_lines t
           WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')
          UNION ALL
          SELECT 5, 'procurement_receipts', pg_catalog.count(*)
            FROM public.procurement_receipts t
           WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')
          UNION ALL
          SELECT 6, 'procurement_receipt_lines', pg_catalog.count(*)
            FROM public.procurement_receipt_lines t
           WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')
          UNION ALL
          SELECT 7, 'procurement_returns', pg_catalog.count(*)
            FROM public.procurement_returns t
           WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')
          UNION ALL
          SELECT 8, 'procurement_order_events', pg_catalog.count(*)
            FROM public.procurement_order_events t
           WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')) x
   WHERE x.n > 0;
  IF v_census IS NOT NULL THEN
    RAISE EXCEPTION '221_precondition_failed: legacy non-care procurement rows present'
      USING DETAIL = v_census;
  END IF;
END
$prelude$;

-- ----------------------------------------------------------------------------
-- 0b. The activation lock, held to COMMIT: SHARE ROW EXCLUSIVE (what CREATE
--     TRIGGER takes) on the eight guarded tables. It conflicts with every row
--     writer of them, so none is half-way through while the triggers attach
--     and VERIFY's census sees every committed row; readers continue.
-- ----------------------------------------------------------------------------
LOCK TABLE public.procurement_suppliers, public.procurement_orders, public.procurement_order_lines,
           public.procurement_order_events, public.procurement_receipts, public.procurement_receipt_lines,
           public.procurement_returns, public.warehouse_stock IN SHARE ROW EXCLUSIVE MODE;

-- ----------------------------------------------------------------------------
-- 1. The guard - owner-only SECURITY DEFINER (it must read every organization
--    whatever the writer may see), pinned search_path, writes nothing.
-- ----------------------------------------------------------------------------
CREATE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_kind text;
BEGIN
  -- PDA-PROC-1: only warehouse_stock carries provenance. The field read sits
  -- in this NESTED block so the procurement tables (which have no
  -- purchase_origin column) never resolve it. purchase_origin alone decides:
  -- the M088 CHECK lets supply_type NULL pass with 'supplementary'.
  IF TG_TABLE_NAME = 'warehouse_stock' THEN
    IF NEW.purchase_origin IS DISTINCT FROM 'supplementary' THEN
      RETURN NEW;
    END IF;
  END IF;

  -- PDA-PROC-1: the canonical classification. A missing organization is
  -- NEVER eligible (fail closed), and neither is any kind but care_institution.
  SELECT o.organization_kind INTO v_kind
    FROM public.organizations o
   WHERE o.id = NEW.organization_id;
  IF NOT FOUND OR v_kind IS DISTINCT FROM 'care_institution' THEN
    RAISE EXCEPTION 'pharmacy_department_supplementary_procurement_forbidden'
      USING ERRCODE = '23514',
            DETAIL = 'Supplementary procurement is limited to care institutions.';
  END IF;
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1() FROM PUBLIC, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. The twelve bindings - narrow events only.
-- ----------------------------------------------------------------------------
CREATE TRIGGER phoenix_pda_supplier_insert_guard
  BEFORE INSERT ON public.procurement_suppliers
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1();

CREATE TRIGGER phoenix_pda_supplier_reassign_guard
  BEFORE UPDATE OF organization_id ON public.procurement_suppliers
  FOR EACH ROW
  WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1();

CREATE TRIGGER phoenix_pda_order_insert_guard
  BEFORE INSERT ON public.procurement_orders
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1();

CREATE TRIGGER phoenix_pda_order_reassign_guard
  BEFORE UPDATE OF organization_id ON public.procurement_orders
  FOR EACH ROW
  WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1();

CREATE TRIGGER phoenix_pda_order_line_insert_guard
  BEFORE INSERT ON public.procurement_order_lines
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1();

CREATE TRIGGER phoenix_pda_order_line_reassign_guard
  BEFORE UPDATE OF organization_id ON public.procurement_order_lines
  FOR EACH ROW
  WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id)
  EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1();

CREATE TRIGGER phoenix_pda_order_event_insert_guard
  BEFORE INSERT ON public.procurement_order_events
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1();

CREATE TRIGGER phoenix_pda_receipt_insert_guard
  BEFORE INSERT ON public.procurement_receipts
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1();

CREATE TRIGGER phoenix_pda_receipt_line_insert_guard
  BEFORE INSERT ON public.procurement_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1();

CREATE TRIGGER phoenix_pda_return_insert_guard
  BEFORE INSERT ON public.procurement_returns
  FOR EACH ROW EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1();

CREATE TRIGGER phoenix_pda_supplementary_stock_insert_guard
  BEFORE INSERT ON public.warehouse_stock
  FOR EACH ROW
  WHEN (NEW.purchase_origin = 'supplementary')
  EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1();

CREATE TRIGGER phoenix_pda_supplementary_stock_reforge_guard
  BEFORE UPDATE OF purchase_origin, organization_id ON public.warehouse_stock
  FOR EACH ROW
  WHEN (NEW.purchase_origin = 'supplementary'
        AND (OLD.purchase_origin IS DISTINCT FROM NEW.purchase_origin
             OR OLD.organization_id IS DISTINCT FROM NEW.organization_id))
  EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1();

COMMENT ON FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1() IS
  'PDA-PROC-1 (221) internal: supplementary (local) procurement state is limited to care institutions. BEFORE ROW guard on procurement_suppliers, procurement_orders, procurement_order_lines, procurement_order_events, procurement_receipts, procurement_receipt_lines, procurement_returns and warehouse_stock rows with purchase_origin supplementary (any supply_type): NEW.organization_id must be an existing organization whose organization_kind is care_institution, else pharmacy_department_supplementary_procurement_forbidden (23514, static detail). Missing organization never eligible; no role is an exception. Writes nothing. Not reachable by any non-owner role.';

COMMENT ON TRIGGER phoenix_pda_supplier_insert_guard ON public.procurement_suppliers IS
  'PDA-PROC-1 (221): a supplier may be created only for a care institution.';
COMMENT ON TRIGGER phoenix_pda_supplier_reassign_guard ON public.procurement_suppliers IS
  'PDA-PROC-1 (221): a supplier may be re-labelled only onto a care institution.';
COMMENT ON TRIGGER phoenix_pda_order_insert_guard ON public.procurement_orders IS
  'PDA-PROC-1 (221): a procurement order may be created only for a care institution.';
COMMENT ON TRIGGER phoenix_pda_order_reassign_guard ON public.procurement_orders IS
  'PDA-PROC-1 (221): a procurement order may be re-labelled only onto a care institution.';
COMMENT ON TRIGGER phoenix_pda_order_line_insert_guard ON public.procurement_order_lines IS
  'PDA-PROC-1 (221): a procurement order line may be recorded only for a care institution.';
COMMENT ON TRIGGER phoenix_pda_order_line_reassign_guard ON public.procurement_order_lines IS
  'PDA-PROC-1 (221): a procurement order line may be re-labelled only onto a care institution (the table has no immutability trigger).';
COMMENT ON TRIGGER phoenix_pda_order_event_insert_guard ON public.procurement_order_events IS
  'PDA-PROC-1 (221): a procurement order event may be recorded only for a care institution (UPDATE is refused by procurement_order_events_immutable).';
COMMENT ON TRIGGER phoenix_pda_receipt_insert_guard ON public.procurement_receipts IS
  'PDA-PROC-1 (221): a procurement receipt may be recorded only for a care institution (UPDATE is refused by procurement_receipts_immutable).';
COMMENT ON TRIGGER phoenix_pda_receipt_line_insert_guard ON public.procurement_receipt_lines IS
  'PDA-PROC-1 (221): a procurement receipt line may be recorded only for a care institution (UPDATE is refused by procurement_receipt_lines_immutable).';
COMMENT ON TRIGGER phoenix_pda_return_insert_guard ON public.procurement_returns IS
  'PDA-PROC-1 (221): a return to supplier may be recorded only for a care institution (UPDATE is refused by procurement_returns_immutable).';
COMMENT ON TRIGGER phoenix_pda_supplementary_stock_insert_guard ON public.warehouse_stock IS
  'PDA-PROC-1 (221): a lot with purchase_origin supplementary (any supply_type) may be created only for a care institution; other provenance never calls the guard.';
COMMENT ON TRIGGER phoenix_pda_supplementary_stock_reforge_guard ON public.warehouse_stock IS
  'PDA-PROC-1 (221): an existing lot may become, or move as, purchase_origin supplementary only for a care institution; quantity and metadata updates never call the guard.';

-- ----------------------------------------------------------------------------
-- 3. VERIFY - catalog reads and plain SELECTs, under the activation lock.
--    Fails the migration rather than ship a half-applied contract.
-- ----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_me     oid := (SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname = current_user);
  v_fn     oid := pg_catalog.to_regprocedure('public._phoenix_pda_supplementary_procurement_guard_v1()');
  v_found  text[];
  v_census text;
BEGIN
  -- A. The function: public, plpgsql, VOLATILE, SECURITY DEFINER, RETURNS
  --    trigger, pinned search_path, owned by the migration owner.
  IF v_fn IS NULL OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p
        WHERE p.oid = v_fn AND p.pronamespace = 'public'::pg_catalog.regnamespace
          AND p.prosecdef AND p.provolatile = 'v' AND p.prokind = 'f' AND NOT p.proretset
          AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
          AND p.prolang = (SELECT l.oid FROM pg_catalog.pg_language l WHERE l.lanname = 'plpgsql')
          AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
          AND p.proowner = v_me) THEN
    RAISE EXCEPTION 'VERIFY FAILED (221): the guard must be a VOLATILE SECURITY DEFINER plpgsql trigger function in public, owned by the migration owner, pinned to pg_catalog, pg_temp';
  END IF;

  -- B. Owner-only: no EXECUTE for PUBLIC, anon, authenticated or service_role.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
              WHERE p.oid = v_fn AND a.grantee = 0)
     OR pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED (221): the guard is executable by PUBLIC, anon, authenticated or service_role';
  END IF;

  -- C. Exactly the twelve bindings: relation, name, type, enabled, column
  --    list and the whole definition (events, WHEN text, function).
  SELECT pg_catalog.array_agg(s.x ORDER BY s.x COLLATE "C") INTO v_found
    FROM (SELECT pg_catalog.format('%s|%s|%s|%s|%s|%s', c.relname, t.tgname, t.tgtype, t.tgenabled,
                                   coalesce((SELECT pg_catalog.string_agg(a.attname::text, ',' ORDER BY k.ord)
                                               FROM pg_catalog.unnest(t.tgattr::pg_catalog.int2[]) WITH ORDINALITY AS k(attnum, ord)
                                               JOIN pg_catalog.pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.attnum), '-'),
                                   pg_catalog.pg_get_triggerdef(t.oid)) AS x
            FROM pg_catalog.pg_trigger t
            JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
           WHERE t.tgfoid = v_fn AND NOT t.tgisinternal) s;
  IF v_found IS DISTINCT FROM ARRAY[
       'procurement_order_events|phoenix_pda_order_event_insert_guard|7|O|-|CREATE TRIGGER phoenix_pda_order_event_insert_guard BEFORE INSERT ON public.procurement_order_events FOR EACH ROW EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1()',
       'procurement_order_lines|phoenix_pda_order_line_insert_guard|7|O|-|CREATE TRIGGER phoenix_pda_order_line_insert_guard BEFORE INSERT ON public.procurement_order_lines FOR EACH ROW EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1()',
       'procurement_order_lines|phoenix_pda_order_line_reassign_guard|19|O|organization_id|CREATE TRIGGER phoenix_pda_order_line_reassign_guard BEFORE UPDATE OF organization_id ON public.procurement_order_lines FOR EACH ROW WHEN ((old.organization_id IS DISTINCT FROM new.organization_id)) EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1()',
       'procurement_orders|phoenix_pda_order_insert_guard|7|O|-|CREATE TRIGGER phoenix_pda_order_insert_guard BEFORE INSERT ON public.procurement_orders FOR EACH ROW EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1()',
       'procurement_orders|phoenix_pda_order_reassign_guard|19|O|organization_id|CREATE TRIGGER phoenix_pda_order_reassign_guard BEFORE UPDATE OF organization_id ON public.procurement_orders FOR EACH ROW WHEN ((old.organization_id IS DISTINCT FROM new.organization_id)) EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1()',
       'procurement_receipt_lines|phoenix_pda_receipt_line_insert_guard|7|O|-|CREATE TRIGGER phoenix_pda_receipt_line_insert_guard BEFORE INSERT ON public.procurement_receipt_lines FOR EACH ROW EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1()',
       'procurement_receipts|phoenix_pda_receipt_insert_guard|7|O|-|CREATE TRIGGER phoenix_pda_receipt_insert_guard BEFORE INSERT ON public.procurement_receipts FOR EACH ROW EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1()',
       'procurement_returns|phoenix_pda_return_insert_guard|7|O|-|CREATE TRIGGER phoenix_pda_return_insert_guard BEFORE INSERT ON public.procurement_returns FOR EACH ROW EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1()',
       'procurement_suppliers|phoenix_pda_supplier_insert_guard|7|O|-|CREATE TRIGGER phoenix_pda_supplier_insert_guard BEFORE INSERT ON public.procurement_suppliers FOR EACH ROW EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1()',
       'procurement_suppliers|phoenix_pda_supplier_reassign_guard|19|O|organization_id|CREATE TRIGGER phoenix_pda_supplier_reassign_guard BEFORE UPDATE OF organization_id ON public.procurement_suppliers FOR EACH ROW WHEN ((old.organization_id IS DISTINCT FROM new.organization_id)) EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1()',
       'warehouse_stock|phoenix_pda_supplementary_stock_insert_guard|7|O|-|CREATE TRIGGER phoenix_pda_supplementary_stock_insert_guard BEFORE INSERT ON public.warehouse_stock FOR EACH ROW WHEN ((new.purchase_origin = ''supplementary''::text)) EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1()',
       'warehouse_stock|phoenix_pda_supplementary_stock_reforge_guard|19|O|purchase_origin,organization_id|CREATE TRIGGER phoenix_pda_supplementary_stock_reforge_guard BEFORE UPDATE OF purchase_origin, organization_id ON public.warehouse_stock FOR EACH ROW WHEN (((new.purchase_origin = ''supplementary''::text) AND ((old.purchase_origin IS DISTINCT FROM new.purchase_origin) OR (old.organization_id IS DISTINCT FROM new.organization_id)))) EXECUTE FUNCTION public._phoenix_pda_supplementary_procurement_guard_v1()'
     ]::text[] THEN
    RAISE EXCEPTION 'VERIFY FAILED (221): the guard is not bound by exactly the twelve reviewed triggers'
      USING DETAIL = pg_catalog.array_to_string(coalesce(v_found, ARRAY[]::text[]), E'\n');
  END IF;

  -- D. Each guard fires first among its table's BEFORE ROW triggers (same
  --    timing fires in byte order of the name), so its token surfaces first.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
               JOIN pg_catalog.pg_trigger o ON o.tgrelid = t.tgrelid AND o.tgfoid <> v_fn AND NOT o.tgisinternal
                                           AND (o.tgtype & 3) = 3
              WHERE t.tgfoid = v_fn AND NOT t.tgisinternal
                AND o.tgname COLLATE "C" < t.tgname COLLATE "C") THEN
    RAISE EXCEPTION 'VERIFY FAILED (221): a guard trigger does not fire before every other BEFORE ROW trigger of its table';
  END IF;

  -- E. The census of the eight guarded tables, re-run UNDER the lock: a row a
  --    writer committed between the prelude and the lock is seen here.
  SELECT pg_catalog.string_agg(pg_catalog.format('%s=%s', x.rel, x.n), ', ' ORDER BY x.ord) INTO v_census
    FROM (SELECT 1 AS ord, 'procurement_suppliers'::text AS rel, pg_catalog.count(*) AS n
            FROM public.procurement_suppliers t
           WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')
          UNION ALL
          SELECT 2, 'procurement_orders', pg_catalog.count(*)
            FROM public.procurement_orders t
           WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')
          UNION ALL
          SELECT 3, 'procurement_order_lines', pg_catalog.count(*)
            FROM public.procurement_order_lines t
           WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')
          UNION ALL
          SELECT 4, 'procurement_order_events', pg_catalog.count(*)
            FROM public.procurement_order_events t
           WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')
          UNION ALL
          SELECT 5, 'procurement_receipts', pg_catalog.count(*)
            FROM public.procurement_receipts t
           WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')
          UNION ALL
          SELECT 6, 'procurement_receipt_lines', pg_catalog.count(*)
            FROM public.procurement_receipt_lines t
           WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')
          UNION ALL
          SELECT 7, 'procurement_returns', pg_catalog.count(*)
            FROM public.procurement_returns t
           WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')
          UNION ALL
          SELECT 8, 'warehouse_stock', pg_catalog.count(*)
            FROM public.warehouse_stock t
           WHERE t.purchase_origin = 'supplementary'
             AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = t.organization_id AND o.organization_kind = 'care_institution')) x
   WHERE x.n > 0;
  IF v_census IS NOT NULL THEN
    RAISE EXCEPTION 'VERIFY FAILED (221): legacy non-care procurement rows present'
      USING DETAIL = v_census;
  END IF;
END
$verify$;

COMMIT;

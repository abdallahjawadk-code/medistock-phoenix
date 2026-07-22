-- ============================================================================
-- INSTITUTION-LOCAL-PROCUREMENT-087-A
--
-- MANUAL APPLY ONLY. DO NOT use `supabase db push` or any automated runner.
-- Apply via Supabase Dashboard -> SQL Editor after reading this file in full,
-- and ONLY after migrations 001-084 and 086 are confirmed applied and healthy.
-- (085 is a PREPARED-ONLY cutover file and is NOT a precondition here.)
--
-- VERIFICATION STATUS: executed on a disposable PostgreSQL 18.4 cluster with
-- 001-084 + 086 + 087 in order via tools/pg-rig, exercised by the dynamic
-- test suite supabase/migrations/__tests__/087-local-procurement.dynamic.test.ts.
-- Production is NOT touched by this file until an operator applies it by hand.
--
-- STRATEGY: EXPAND, additive, backward-compatible by construction.
--   * Modifies NONE of 001-086. Every object here is NEW: six tables, one
--     sequence, helper functions, RPCs, RLS policies, permission keys.
--   * The ONLY shared surfaces it writes are warehouse_stock and
--     warehouse_stock_movements — through the exact 065 receipt discipline
--     (identity-resolved lot merge, append-only movement, advisory-lock-first
--     ordering) with NEW reference types, so no existing uniqueness or
--     idempotency contract is disturbed.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS ADDS
-- ─────────────────────────────────────────────────────────────────────────────
-- Institutions purchase locally (سوق محلي / مورد محلي) as well as receiving
-- central supply. This migration models that purchase end-to-end WITHOUT ever
-- letting a client write stock:
--
--   suppliers            institution-scoped supplier registry
--   purchase orders      order + lines with product/batch/price provenance
--   approvals            submitted -> approved/rejected, separation of duty
--   receiving            guarded receipt RPC -> warehouse_stock ledger ONLY
--   returns              supplier return pinned to the original receipt line
--
-- LIFECYCLE (text + CHECK, never an enum):
--   draft -> submitted -> approved | rejected
--   approved -> partially_received -> received
--   draft | submitted | approved (no receipts) -> cancelled
--
-- STOCK ENTERS ONLY THE PURCHASING INSTITUTION WAREHOUSE, only through
-- phoenix_procurement_receive_order, which:
--   * is idempotent on a caller request UUID (advisory-lock-first, fingerprint
--     bound — a replay with different content fails closed with 23505);
--   * enforces an expected order generation (40001 on conflict, skipped for a
--     genuine lost-response replay — the 078/086 discipline);
--   * caps every line at its ordered quantity (over-receipt fails closed);
--   * posts each line to warehouse_stock via the 065 lot-identity merge and an
--     append-only 'add' movement (reference_type 'procurement_receipt_line',
--     at most once per receipt line, structurally);
--   * never lets quantities go negative (receipts add; returns re-check
--     unreserved availability under the row lock).
--
-- RETURNS preserve provenance: a supplier return names the RECEIPT LINE it
-- undoes, which pins the order line, the batch-identified warehouse_stock lot,
-- the price and the invoice. Returned totals are capped at the received
-- quantity of that line, forever.
--
-- OCR: no OCR object appears in this file ON PURPOSE. OCR may only pre-fill a
-- reviewable DRAFT order in the client; every value still passes through the
-- same RPCs and the same review/approval gates as a hand-typed order.
--
-- AUTHORITY — new permission keys, module 'local_procurement':
--   .view      read the procurement workspace          (RLS + RPC)
--   .manage    suppliers, order composing, submit, cancel
--   .approve   approve/reject a submitted order        (never the submitter)
--   .receive   post a receipt into the institution warehouse
--   .return    post a supplier return
-- All checks go through phoenix_profile_has_scoped_permission (062): an
-- operational role must be assigned to the purchasing warehouse; oversight
-- roles answer organization-wide; super_admin is platform-wide.
-- ============================================================================

BEGIN;

-- ── PRECONDITIONS (this transaction ABORTS if any fails) ────────────────────
DO $guard$
BEGIN
  IF to_regclass('public.warehouse_stock') IS NULL
     OR to_regclass('public.warehouse_stock_movements') IS NULL THEN
    RAISE EXCEPTION 'ABORT 087: warehouse ledger absent — apply 060/065 first.';
  END IF;
  IF to_regclass('public.warehouses') IS NULL OR to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'ABORT 087: warehouses/audit_logs absent — apply 060/001 first.';
  END IF;
  IF to_regprocedure('public.phoenix_profile_has_scoped_permission(uuid, text, uuid, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 087: phoenix_profile_has_scoped_permission absent — apply 062 first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='warehouses'
                   AND column_name='warehouse_kind') THEN
    RAISE EXCEPTION 'ABORT 087: warehouses.warehouse_kind absent — apply 066 first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='warehouse_stock'
                   AND column_name='movement_seq') THEN
    RAISE EXCEPTION 'ABORT 087: warehouse_stock.movement_seq absent — apply 078 first.';
  END IF;
  IF to_regclass('public.permission_keys') IS NULL
     OR to_regclass('public.role_permission_defaults') IS NULL THEN
    RAISE EXCEPTION 'ABORT 087: permission matrix absent — apply 010 first.';
  END IF;
  IF to_regclass('public.procurement_suppliers') IS NOT NULL THEN
    RAISE EXCEPTION 'ABORT 087: procurement_suppliers already exists (087 already applied?).';
  END IF;
END;
$guard$;

-- ============================================================================
-- 1. TABLES
-- ============================================================================

-- 1a. Suppliers — institution-scoped reference data.
CREATE TABLE public.procurement_suppliers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  name            text NOT NULL CHECK (btrim(name) = name AND name <> ''),
  name_ar         text,
  contact_person  text,
  phone           text,
  email           text,
  address         text,
  tax_number      text,
  notes           text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Composite target so child rows can prove same-organization structurally.
  CONSTRAINT procurement_suppliers_id_org_uniq UNIQUE (id, organization_id)
);

-- One supplier name per institution (case-insensitive).
CREATE UNIQUE INDEX procurement_suppliers_org_name_uniq
  ON public.procurement_suppliers (organization_id, lower(name));
CREATE INDEX procurement_suppliers_org_status_idx
  ON public.procurement_suppliers (organization_id, status);

-- 1b. Purchase orders.
CREATE TABLE public.procurement_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  warehouse_id       uuid NOT NULL,
  supplier_id        uuid NOT NULL,
  order_number       text NOT NULL CHECK (btrim(order_number) = order_number AND order_number <> ''),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN (
                       'draft', 'submitted', 'approved', 'rejected',
                       'partially_received', 'received', 'cancelled')),
  invoice_number     text,
  invoice_date       date,
  external_reference text,
  currency           text,
  notes              text,
  -- OCR provenance flag ONLY — an OCR-assisted order is still a reviewable
  -- draft that walks the same lifecycle; nothing branches on this value.
  ocr_assisted       boolean NOT NULL DEFAULT false,
  -- Server-owned optimistic-concurrency generation (the 078/086 discipline).
  -- Advanced by trigger on every real change; clients READ it and pass it back
  -- as p_expected_generation; any client-supplied value is overwritten.
  order_generation   bigint NOT NULL DEFAULT 0,
  submitted_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  submitted_at       timestamptz,
  decided_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at         timestamptz,
  decision_notes     text,
  cancelled_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_at       timestamptz,
  cancel_reason      text,
  created_by         uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT procurement_orders_org_number_uniq UNIQUE (organization_id, order_number),
  -- The destination warehouse must belong to the purchasing institution.
  CONSTRAINT procurement_orders_wh_org_fk
    FOREIGN KEY (warehouse_id, organization_id)
    REFERENCES public.warehouses (id, organization_id) ON DELETE RESTRICT,
  -- The supplier must belong to the same institution.
  CONSTRAINT procurement_orders_supplier_org_fk
    FOREIGN KEY (supplier_id, organization_id)
    REFERENCES public.procurement_suppliers (id, organization_id) ON DELETE RESTRICT
);

CREATE INDEX procurement_orders_org_status_idx
  ON public.procurement_orders (organization_id, status);
CREATE INDEX procurement_orders_wh_status_idx
  ON public.procurement_orders (warehouse_id, status);
CREATE INDEX procurement_orders_supplier_idx
  ON public.procurement_orders (supplier_id);
CREATE INDEX procurement_orders_created_idx
  ON public.procurement_orders (created_at);

-- Generation bump: every REAL change to the order row advances the generation,
-- exactly once, server-side. A no-op UPDATE (used by nothing today) does not.
CREATE OR REPLACE FUNCTION public.phoenix_procurement_order_bump_generation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $bump$
BEGIN
  NEW.order_generation := OLD.order_generation;
  IF (to_jsonb(NEW) - 'order_generation') IS DISTINCT FROM (to_jsonb(OLD) - 'order_generation') THEN
    NEW.order_generation := OLD.order_generation + 1;
  END IF;
  RETURN NEW;
END;
$bump$;

REVOKE ALL ON FUNCTION public.phoenix_procurement_order_bump_generation() FROM PUBLIC;

CREATE TRIGGER procurement_orders_bump_generation
  BEFORE UPDATE ON public.procurement_orders
  FOR EACH ROW
  EXECUTE FUNCTION public.phoenix_procurement_order_bump_generation();

-- 1c. Order lines — the product/quantity/price provenance of the purchase.
CREATE TABLE public.procurement_order_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES public.procurement_orders(id) ON DELETE RESTRICT,
  organization_id   uuid NOT NULL,
  central_item_id   uuid,
  scientific_name   text NOT NULL CHECK (btrim(scientific_name) = scientific_name AND scientific_name <> ''),
  trade_name        text,
  concentration     text,
  dosage_form       text,
  unit              text,
  national_code     text,
  batch_number      text,
  expiry_date       date,
  ordered_quantity  integer NOT NULL CHECK (ordered_quantity > 0),
  -- Maintained ONLY by phoenix_procurement_receive_order. Over-receipt is
  -- impossible by CHECK, not just by RPC discipline.
  received_quantity integer NOT NULL DEFAULT 0
    CHECK (received_quantity >= 0),
  unit_price        numeric CHECK (unit_price IS NULL OR unit_price >= 0),
  currency          text,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT procurement_order_lines_cap_chk
    CHECK (received_quantity <= ordered_quantity)
);

CREATE INDEX procurement_order_lines_order_idx
  ON public.procurement_order_lines (order_id);
CREATE INDEX procurement_order_lines_org_idx
  ON public.procurement_order_lines (organization_id);

-- 1d. Receipts (header) — one guarded posting event, idempotent by request id.
CREATE SEQUENCE public.procurement_receipt_number_seq;

CREATE TABLE public.procurement_receipts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES public.procurement_orders(id) ON DELETE RESTRICT,
  organization_id     uuid NOT NULL,
  warehouse_id        uuid NOT NULL,
  supplier_id         uuid NOT NULL,
  receipt_number      text NOT NULL UNIQUE,
  request_id          uuid NOT NULL UNIQUE,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  invoice_number      text,
  notes               text,
  received_by         uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  received_by_role    text,
  received_by_name    text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX procurement_receipts_order_idx
  ON public.procurement_receipts (order_id);
CREATE INDEX procurement_receipts_org_idx
  ON public.procurement_receipts (organization_id, created_at);

-- 1e. Receipt lines — what actually arrived, batch-identified, and WHERE it
-- landed on the canonical ledger (warehouse_stock lot + movement).
CREATE TABLE public.procurement_receipt_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id            uuid NOT NULL REFERENCES public.procurement_receipts(id) ON DELETE RESTRICT,
  order_line_id         uuid NOT NULL REFERENCES public.procurement_order_lines(id) ON DELETE RESTRICT,
  organization_id       uuid NOT NULL,
  quantity              integer NOT NULL CHECK (quantity > 0),
  batch_number          text,
  has_no_batch_number   boolean NOT NULL,
  national_code         text,
  has_no_national_code  boolean NOT NULL,
  expiry_date           date,
  unit_price            numeric CHECK (unit_price IS NULL OR unit_price >= 0),
  warehouse_stock_id    uuid REFERENCES public.warehouse_stock(id) ON DELETE RESTRICT,
  movement_id           uuid REFERENCES public.warehouse_stock_movements(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- The explicit-acknowledgement discipline of 065: a blank is a statement.
  CONSTRAINT procurement_receipt_lines_batch_flag_chk
    CHECK (has_no_batch_number = (batch_number IS NULL)),
  CONSTRAINT procurement_receipt_lines_code_flag_chk
    CHECK (has_no_national_code = (national_code IS NULL))
);

CREATE INDEX procurement_receipt_lines_receipt_idx
  ON public.procurement_receipt_lines (receipt_id);
CREATE INDEX procurement_receipt_lines_order_line_idx
  ON public.procurement_receipt_lines (order_line_id);

-- One receipt line posts to the ledger AT MOST ONCE — structural, like 068's
-- transfer-line rule, whatever request id or code path is used.
CREATE UNIQUE INDEX warehouse_stock_movements_procurement_receipt_once_uniq
  ON public.warehouse_stock_movements (reference_id)
  WHERE reference_type = 'procurement_receipt_line' AND reference_id IS NOT NULL;

-- 1f. Supplier returns — always pinned to the original receipt line.
CREATE TABLE public.procurement_returns (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id          uuid NOT NULL UNIQUE,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  order_id            uuid NOT NULL REFERENCES public.procurement_orders(id) ON DELETE RESTRICT,
  receipt_line_id     uuid NOT NULL REFERENCES public.procurement_receipt_lines(id) ON DELETE RESTRICT,
  organization_id     uuid NOT NULL,
  warehouse_id        uuid NOT NULL,
  quantity            integer NOT NULL CHECK (quantity > 0),
  reason              text NOT NULL CHECK (btrim(reason) <> ''),
  notes               text,
  movement_id         uuid REFERENCES public.warehouse_stock_movements(id) ON DELETE RESTRICT,
  actor_id            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role          text,
  actor_name          text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX procurement_returns_receipt_line_idx
  ON public.procurement_returns (receipt_line_id);
CREATE INDEX procurement_returns_order_idx
  ON public.procurement_returns (order_id);

-- One return row mints AT MOST ONE ledger movement — structural.
CREATE UNIQUE INDEX warehouse_stock_movements_procurement_return_once_uniq
  ON public.warehouse_stock_movements (reference_id)
  WHERE reference_type = 'procurement_return' AND reference_id IS NOT NULL;

-- 1g. Order lifecycle events — the approval/audit trail, append-only.
CREATE TABLE public.procurement_order_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES public.procurement_orders(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL,
  event_type      text NOT NULL CHECK (btrim(event_type) <> ''),
  from_status     text,
  to_status       text,
  actor_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role      text,
  actor_name      text,
  notes           text,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX procurement_order_events_order_idx
  ON public.procurement_order_events (order_id, created_at);

-- ── Immutability: receipts, receipt lines, returns and events are history. ──
CREATE OR REPLACE FUNCTION public.phoenix_procurement_forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $immutable$
BEGIN
  -- The ONE sanctioned update: the write RPC stamps ledger pointers onto a
  -- history row it created in the same transaction — receipt lines get their
  -- warehouse_stock_id + movement_id, returns get their movement_id. The
  -- pointer may only be FILLED (NULL -> value), never changed afterwards.
  -- Everything else is history.
  -- Nested IFs on purpose: OLD/NEW are `record` here, so a field reference is
  -- resolved only when its expression actually evaluates — the outer table
  -- check must decide BEFORE any table-specific field is touched.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'procurement_receipt_lines' THEN
    IF NEW.id = OLD.id
       AND to_jsonb(NEW) - 'warehouse_stock_id' - 'movement_id'
           = to_jsonb(OLD) - 'warehouse_stock_id' - 'movement_id'
       AND OLD.warehouse_stock_id IS NULL AND OLD.movement_id IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'procurement_returns' THEN
    IF NEW.id = OLD.id
       AND to_jsonb(NEW) - 'movement_id' = to_jsonb(OLD) - 'movement_id'
       AND OLD.movement_id IS NULL THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'procurement_history_is_immutable' USING ERRCODE = '42501';
END;
$immutable$;

REVOKE ALL ON FUNCTION public.phoenix_procurement_forbid_mutation() FROM PUBLIC;

CREATE TRIGGER procurement_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.procurement_receipts
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_procurement_forbid_mutation();
CREATE TRIGGER procurement_receipt_lines_immutable
  BEFORE UPDATE OR DELETE ON public.procurement_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_procurement_forbid_mutation();
CREATE TRIGGER procurement_returns_immutable
  BEFORE UPDATE OR DELETE ON public.procurement_returns
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_procurement_forbid_mutation();
CREATE TRIGGER procurement_order_events_immutable
  BEFORE UPDATE OR DELETE ON public.procurement_order_events
  FOR EACH ROW EXECUTE FUNCTION public.phoenix_procurement_forbid_mutation();

-- ============================================================================
-- 2. READ RULE + RLS
-- ============================================================================

-- The single procurement read rule, so headers, lines, receipts and returns can
-- never drift apart (068 discipline). Warehouse-scoped: an operational role
-- must be assigned to the purchasing warehouse; oversight roles answer
-- organization-wide; super_admin is platform-wide (all inside 062's helper).
CREATE OR REPLACE FUNCTION public.phoenix_can_read_local_procurement(
  p_organization_id uuid,
  p_warehouse_id    uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.phoenix_profile_has_scoped_permission(
    auth.uid(), 'local_procurement.view', p_organization_id, p_warehouse_id, NULL
  );
$$;

REVOKE ALL ON FUNCTION public.phoenix_can_read_local_procurement(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_can_read_local_procurement(uuid, uuid) TO authenticated;

-- Suppliers are organization-level reference data with no single warehouse, so
-- the read (and manage — section 3a) authority is: the org-wide answer, OR the
-- same key on ANY active institution warehouse of that organization the caller
-- is assigned to. Omitting the resource is thus never MORE permissive than
-- naming one — it is the union of the nameable ones.
CREATE OR REPLACE FUNCTION public.phoenix_procurement_org_authority(
  p_profile_id      uuid,
  p_permission_key  text,
  p_organization_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_profile_id IS NULL OR p_organization_id IS NULL THEN
    RETURN false;
  END IF;
  IF public.phoenix_profile_has_scoped_permission(
       p_profile_id, p_permission_key, p_organization_id, NULL, NULL) THEN
    RETURN true;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM public.warehouses w
    WHERE w.organization_id = p_organization_id
      AND w.status = 'active'
      AND w.warehouse_kind = 'institution'
      AND public.phoenix_profile_has_scoped_permission(
            p_profile_id, p_permission_key, p_organization_id, w.id, NULL)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_procurement_org_authority(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_procurement_org_authority(uuid, text, uuid) TO authenticated;

ALTER TABLE public.procurement_suppliers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procurement_orders         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procurement_order_lines    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procurement_receipts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procurement_receipt_lines  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procurement_returns        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procurement_order_events   ENABLE ROW LEVEL SECURITY;

CREATE POLICY procurement_suppliers_select_scoped
  ON public.procurement_suppliers FOR SELECT TO authenticated
  USING (public.phoenix_procurement_org_authority(
           auth.uid(), 'local_procurement.view', organization_id));

CREATE POLICY procurement_orders_select_scoped
  ON public.procurement_orders FOR SELECT TO authenticated
  USING (public.phoenix_can_read_local_procurement(organization_id, warehouse_id));

CREATE POLICY procurement_order_lines_select_scoped
  ON public.procurement_order_lines FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.procurement_orders o
    WHERE o.id = order_id
      AND public.phoenix_can_read_local_procurement(o.organization_id, o.warehouse_id)));

CREATE POLICY procurement_receipts_select_scoped
  ON public.procurement_receipts FOR SELECT TO authenticated
  USING (public.phoenix_can_read_local_procurement(organization_id, warehouse_id));

CREATE POLICY procurement_receipt_lines_select_scoped
  ON public.procurement_receipt_lines FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.procurement_receipts r
    WHERE r.id = receipt_id
      AND public.phoenix_can_read_local_procurement(r.organization_id, r.warehouse_id)));

CREATE POLICY procurement_returns_select_scoped
  ON public.procurement_returns FOR SELECT TO authenticated
  USING (public.phoenix_can_read_local_procurement(organization_id, warehouse_id));

CREATE POLICY procurement_order_events_select_scoped
  ON public.procurement_order_events FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.procurement_orders o
    WHERE o.id = order_id
      AND public.phoenix_can_read_local_procurement(o.organization_id, o.warehouse_id)));

-- Clients READ these tables (RLS-scoped) and never write them: every mutation
-- goes through a SECURITY DEFINER RPC below.
GRANT SELECT ON public.procurement_suppliers,
                public.procurement_orders,
                public.procurement_order_lines,
                public.procurement_receipts,
                public.procurement_receipt_lines,
                public.procurement_returns,
                public.procurement_order_events
  TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.procurement_suppliers,
                public.procurement_orders,
                public.procurement_order_lines,
                public.procurement_receipts,
                public.procurement_receipt_lines,
                public.procurement_returns,
                public.procurement_order_events
  FROM authenticated, anon;
REVOKE ALL ON public.procurement_suppliers,
                public.procurement_orders,
                public.procurement_order_lines,
                public.procurement_receipts,
                public.procurement_receipt_lines,
                public.procurement_returns,
                public.procurement_order_events
  FROM anon;
REVOKE ALL ON SEQUENCE public.procurement_receipt_number_seq FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 3. INTERNAL HELPERS (never granted to clients)
-- ============================================================================

-- Append one lifecycle event. Internal: called only from the RPCs below,
-- inside their transaction.
CREATE OR REPLACE FUNCTION public._phoenix_procurement_log_event(
  p_order      public.procurement_orders,
  p_event_type text,
  p_from       text,
  p_to         text,
  p_actor      uuid,
  p_actor_role text,
  p_actor_name text,
  p_notes      text DEFAULT NULL,
  p_payload    jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.procurement_order_events (
    order_id, organization_id, event_type, from_status, to_status,
    actor_id, actor_role, actor_name, notes, payload
  ) VALUES (
    p_order.id, p_order.organization_id, p_event_type, p_from, p_to,
    p_actor, p_actor_role, p_actor_name, NULLIF(btrim(p_notes), ''), COALESCE(p_payload, '{}'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public._phoenix_procurement_log_event(
  public.procurement_orders, text, text, text, uuid, text, text, text, jsonb
) FROM PUBLIC, anon, authenticated;

-- Resolve actor role/name or fail closed. Internal.
CREATE OR REPLACE FUNCTION public._phoenix_procurement_actor(
  p_actor uuid,
  OUT o_role text,
  OUT o_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  SELECT p.role, p.full_name INTO o_role, o_name
  FROM public.profiles p
  WHERE p.id = p_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_procurement_actor(uuid) FROM PUBLIC, anon, authenticated;

-- Post ONE receipt line to the canonical warehouse ledger. This is the 065
-- receipt discipline verbatim in structure: insert-or-identity-merge the lot,
-- append an 'add' movement, never negative, provenance snapshotted. The
-- reference is the RECEIPT LINE id with reference_type
-- 'procurement_receipt_line', so the partial unique index makes double-posting
-- a receipt line structurally impossible. Internal: authorization happened in
-- the caller under the order row lock.
CREATE OR REPLACE FUNCTION public._phoenix_procurement_post_receipt_line(
  p_receipt_line public.procurement_receipt_lines,
  p_order        public.procurement_orders,
  p_line         public.procurement_order_lines,
  p_actor        uuid,
  p_actor_role   text,
  p_actor_name   text,
  OUT o_warehouse_stock_id uuid,
  OUT o_movement_id        uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_internal_ref text;
  v_source_doc   text := COALESCE(NULLIF(btrim(COALESCE(p_order.invoice_number, '')), ''), p_order.order_number);
  v_stock        public.warehouse_stock%ROWTYPE;
  v_before       integer;
  v_after        integer;
BEGIN
  -- A no-batch receipt line gets a stable private identity derived from the
  -- receipt line id, so independent no-batch receipts never merge (065's WSNB
  -- discipline, distinct PRNB namespace).
  v_internal_ref := CASE
    WHEN p_receipt_line.has_no_batch_number
      THEN 'PRNB-' || replace(p_receipt_line.id::text, '-', '')
    ELSE NULL
  END;

  INSERT INTO public.warehouse_stock (
    organization_id, warehouse_id, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code,
    batch_number, has_no_batch_number, internal_batch_reference,
    expiry_date, on_hand_quantity, reserved_quantity,
    unit_price, price_basis, currency, supply_type_text,
    source_document_number, notes, created_by, updated_by
  ) VALUES (
    p_order.organization_id, p_order.warehouse_id, p_line.central_item_id,
    p_line.scientific_name, p_line.trade_name, p_line.concentration, p_line.dosage_form, p_line.unit,
    p_receipt_line.national_code, p_receipt_line.has_no_national_code,
    p_receipt_line.batch_number, p_receipt_line.has_no_batch_number, v_internal_ref,
    p_receipt_line.expiry_date, 0, 0,
    p_receipt_line.unit_price, 'purchase', COALESCE(p_line.currency, p_order.currency), 'local_procurement',
    v_source_doc, NULL, p_actor, p_actor
  )
  ON CONFLICT DO NOTHING;

  SELECT *
    INTO v_stock
  FROM public.warehouse_stock s
  WHERE s.warehouse_id = p_order.warehouse_id
    AND s.scientific_name = p_line.scientific_name
    AND COALESCE(s.concentration, '') = COALESCE(p_line.concentration, '')
    AND COALESCE(s.dosage_form, '') = COALESCE(p_line.dosage_form, '')
    AND COALESCE(s.national_code, '') = COALESCE(p_receipt_line.national_code, '')
    AND COALESCE(s.batch_number, '') = COALESCE(p_receipt_line.batch_number, '')
    AND COALESCE(s.expiry_date, DATE '0001-01-01')
        = COALESCE(p_receipt_line.expiry_date, DATE '0001-01-01')
    AND COALESCE(s.internal_batch_reference, '') = COALESCE(v_internal_ref, '')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_identity_resolution_failed'
      USING ERRCODE = 'P0002';
  END IF;

  -- A receipt may fill an absent catalog link, never silently relink one (065).
  IF v_stock.central_item_id IS NOT NULL
     AND p_line.central_item_id IS NOT NULL
     AND v_stock.central_item_id IS DISTINCT FROM p_line.central_item_id THEN
    RAISE EXCEPTION 'warehouse_stock_central_item_conflict' USING ERRCODE = '23514';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before + p_receipt_line.quantity;

  UPDATE public.warehouse_stock
     SET on_hand_quantity       = v_after,
         central_item_id        = COALESCE(v_stock.central_item_id, p_line.central_item_id),
         trade_name             = COALESCE(p_line.trade_name, trade_name),
         unit                   = COALESCE(p_line.unit, unit),
         unit_price             = COALESCE(p_receipt_line.unit_price, unit_price),
         price_basis            = COALESCE(price_basis, 'purchase'),
         currency               = COALESCE(p_line.currency, p_order.currency, currency),
         supply_type_text       = COALESCE(supply_type_text, 'local_procurement'),
         source_document_number = COALESCE(v_source_doc, source_document_number),
         updated_by             = p_actor
   WHERE id = v_stock.id;

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id,
    movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reference_type, reference_id,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot
  ) VALUES (
    v_stock.id, p_order.organization_id, p_order.warehouse_id,
    'add',
    v_before, p_receipt_line.quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'local_procurement_receipt', 'procurement_receipt_line', p_receipt_line.id,
    v_source_doc, p_actor, p_actor_role, p_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference
  )
  RETURNING id INTO o_movement_id;

  o_warehouse_stock_id := v_stock.id;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_procurement_post_receipt_line(
  public.procurement_receipt_lines, public.procurement_orders,
  public.procurement_order_lines, uuid, text, text
) FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 4. SUPPLIER RPC
-- ============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_procurement_save_supplier(
  p_organization_id uuid,
  p_supplier_id     uuid DEFAULT NULL,
  p_name            text DEFAULT NULL,
  p_name_ar         text DEFAULT NULL,
  p_contact_person  text DEFAULT NULL,
  p_phone           text DEFAULT NULL,
  p_email           text DEFAULT NULL,
  p_address         text DEFAULT NULL,
  p_tax_number      text DEFAULT NULL,
  p_notes           text DEFAULT NULL,
  p_status          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_actor_name text;
  v_name       text := NULLIF(btrim(COALESCE(p_name, '')), '');
  v_status     text := NULLIF(btrim(COALESCE(p_status, '')), '');
  v_supplier   public.procurement_suppliers%ROWTYPE;
  v_created    boolean := false;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_status IS NOT NULL AND v_status NOT IN ('active', 'inactive') THEN
    RAISE EXCEPTION 'invalid_supplier_status' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_procurement_org_authority(
    v_actor, 'local_procurement.manage', p_organization_id
  ) THEN
    RAISE EXCEPTION 'forbidden_local_procurement_manage' USING ERRCODE = '42501';
  END IF;

  SELECT o_role, o_name INTO v_actor_role, v_actor_name
  FROM public._phoenix_procurement_actor(v_actor);

  IF p_supplier_id IS NULL THEN
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'supplier_name_required' USING ERRCODE = '23514';
    END IF;
    BEGIN
      INSERT INTO public.procurement_suppliers (
        organization_id, name, name_ar, contact_person, phone, email,
        address, tax_number, notes, status, created_by, updated_by
      ) VALUES (
        p_organization_id, v_name, NULLIF(btrim(COALESCE(p_name_ar, '')), ''),
        NULLIF(btrim(COALESCE(p_contact_person, '')), ''), NULLIF(btrim(COALESCE(p_phone, '')), ''),
        NULLIF(btrim(COALESCE(p_email, '')), ''), NULLIF(btrim(COALESCE(p_address, '')), ''),
        NULLIF(btrim(COALESCE(p_tax_number, '')), ''), NULLIF(btrim(COALESCE(p_notes, '')), ''),
        COALESCE(v_status, 'active'), v_actor, v_actor
      )
      RETURNING * INTO v_supplier;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'supplier_name_exists' USING ERRCODE = '23505';
    END;
    v_created := true;
  ELSE
    SELECT * INTO v_supplier
    FROM public.procurement_suppliers
    WHERE id = p_supplier_id AND organization_id = p_organization_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'supplier_not_found' USING ERRCODE = 'P0002';
    END IF;
    BEGIN
      UPDATE public.procurement_suppliers SET
        name           = COALESCE(v_name, name),
        name_ar        = COALESCE(NULLIF(btrim(COALESCE(p_name_ar, '')), ''), name_ar),
        contact_person = COALESCE(NULLIF(btrim(COALESCE(p_contact_person, '')), ''), contact_person),
        phone          = COALESCE(NULLIF(btrim(COALESCE(p_phone, '')), ''), phone),
        email          = COALESCE(NULLIF(btrim(COALESCE(p_email, '')), ''), email),
        address        = COALESCE(NULLIF(btrim(COALESCE(p_address, '')), ''), address),
        tax_number     = COALESCE(NULLIF(btrim(COALESCE(p_tax_number, '')), ''), tax_number),
        notes          = COALESCE(NULLIF(btrim(COALESCE(p_notes, '')), ''), notes),
        status         = COALESCE(v_status, status),
        updated_by     = v_actor,
        updated_at     = now()
      WHERE id = v_supplier.id
      RETURNING * INTO v_supplier;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'supplier_name_exists' USING ERRCODE = '23505';
    END;
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    p_organization_id, v_actor, v_actor_role,
    CASE WHEN v_created THEN 'local_procurement.supplier_created'
         ELSE 'local_procurement.supplier_updated' END,
    'procurement_suppliers', v_supplier.id, v_supplier.name,
    jsonb_build_object('status', v_supplier.status)
  );

  RETURN jsonb_build_object('ok', true, 'supplier_id', v_supplier.id, 'created', v_created);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_procurement_save_supplier(
  uuid, uuid, text, text, text, text, text, text, text, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_procurement_save_supplier(
  uuid, uuid, text, text, text, text, text, text, text, text, text
) TO authenticated;

-- ============================================================================
-- 5. ORDER COMPOSITION RPCs (draft only)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_procurement_create_order(
  p_warehouse_id       uuid,
  p_supplier_id        uuid,
  p_order_number       text,
  p_invoice_number     text DEFAULT NULL,
  p_invoice_date       date DEFAULT NULL,
  p_external_reference text DEFAULT NULL,
  p_currency           text DEFAULT NULL,
  p_notes              text DEFAULT NULL,
  p_ocr_assisted       boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_actor_name text;
  v_wh         public.warehouses%ROWTYPE;
  v_supplier   public.procurement_suppliers%ROWTYPE;
  v_number     text := NULLIF(btrim(COALESCE(p_order_number, '')), '');
  v_order      public.procurement_orders%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_warehouse_id IS NULL OR p_supplier_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_and_supplier_required' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'order_number_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_wh FROM public.warehouses WHERE id = p_warehouse_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_wh.warehouse_kind <> 'institution' OR v_wh.status <> 'active' THEN
    RAISE EXCEPTION 'destination_must_be_active_institution_warehouse' USING ERRCODE = '23514';
  END IF;

  -- THE IDOR GATE: scoped authority on the PURCHASING warehouse.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'local_procurement.manage', v_wh.organization_id, p_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_local_procurement_manage' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_supplier
  FROM public.procurement_suppliers
  WHERE id = p_supplier_id AND organization_id = v_wh.organization_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'supplier_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_supplier.status <> 'active' THEN
    RAISE EXCEPTION 'supplier_inactive' USING ERRCODE = '23514';
  END IF;

  SELECT o_role, o_name INTO v_actor_role, v_actor_name
  FROM public._phoenix_procurement_actor(v_actor);

  BEGIN
    INSERT INTO public.procurement_orders (
      organization_id, warehouse_id, supplier_id, order_number, status,
      invoice_number, invoice_date, external_reference, currency, notes,
      ocr_assisted, created_by
    ) VALUES (
      v_wh.organization_id, p_warehouse_id, p_supplier_id, v_number, 'draft',
      NULLIF(btrim(COALESCE(p_invoice_number, '')), ''), p_invoice_date,
      NULLIF(btrim(COALESCE(p_external_reference, '')), ''),
      NULLIF(btrim(COALESCE(p_currency, '')), ''), NULLIF(btrim(COALESCE(p_notes, '')), ''),
      COALESCE(p_ocr_assisted, false), v_actor
    )
    RETURNING * INTO v_order;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'order_number_exists' USING ERRCODE = '23505';
  END;

  PERFORM public._phoenix_procurement_log_event(
    v_order, 'created', NULL, 'draft', v_actor, v_actor_role, v_actor_name, NULL,
    jsonb_build_object('ocr_assisted', COALESCE(p_ocr_assisted, false)));

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_order.organization_id, v_actor, v_actor_role,
    'local_procurement.order_created', 'procurement_orders', v_order.id, v_number,
    jsonb_build_object('warehouse_id', p_warehouse_id, 'supplier_id', p_supplier_id,
                       'ocr_assisted', COALESCE(p_ocr_assisted, false))
  );

  RETURN jsonb_build_object('ok', true, 'order_id', v_order.id, 'status', v_order.status,
                            'order_generation', v_order.order_generation);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_procurement_create_order(
  uuid, uuid, text, text, date, text, text, text, boolean
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_procurement_create_order(
  uuid, uuid, text, text, date, text, text, text, boolean
) TO authenticated;

-- Shared draft-write authorization: lock the order, check scoped manage
-- authority on the purchasing warehouse, require draft status. Internal.
CREATE OR REPLACE FUNCTION public._phoenix_procurement_lock_draft_order(
  p_order_id uuid,
  p_actor    uuid
)
RETURNS public.procurement_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.procurement_orders%ROWTYPE;
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'order_id_required' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_order FROM public.procurement_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.phoenix_profile_has_scoped_permission(
    p_actor, 'local_procurement.manage', v_order.organization_id, v_order.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_local_procurement_manage' USING ERRCODE = '42501';
  END IF;
  IF v_order.status <> 'draft' THEN
    RAISE EXCEPTION 'order_not_draft' USING ERRCODE = '23514';
  END IF;
  RETURN v_order;
END;
$$;

REVOKE ALL ON FUNCTION public._phoenix_procurement_lock_draft_order(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_procurement_update_order(
  p_order_id           uuid,
  p_supplier_id        uuid DEFAULT NULL,
  p_invoice_number     text DEFAULT NULL,
  p_invoice_date       date DEFAULT NULL,
  p_external_reference text DEFAULT NULL,
  p_currency           text DEFAULT NULL,
  p_notes              text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_order    public.procurement_orders%ROWTYPE;
  v_supplier public.procurement_suppliers%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  v_order := public._phoenix_procurement_lock_draft_order(p_order_id, v_actor);

  IF p_supplier_id IS NOT NULL AND p_supplier_id IS DISTINCT FROM v_order.supplier_id THEN
    SELECT * INTO v_supplier
    FROM public.procurement_suppliers
    WHERE id = p_supplier_id AND organization_id = v_order.organization_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'supplier_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_supplier.status <> 'active' THEN
      RAISE EXCEPTION 'supplier_inactive' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.procurement_orders SET
    supplier_id        = COALESCE(p_supplier_id, supplier_id),
    invoice_number     = COALESCE(NULLIF(btrim(COALESCE(p_invoice_number, '')), ''), invoice_number),
    invoice_date       = COALESCE(p_invoice_date, invoice_date),
    external_reference = COALESCE(NULLIF(btrim(COALESCE(p_external_reference, '')), ''), external_reference),
    currency           = COALESCE(NULLIF(btrim(COALESCE(p_currency, '')), ''), currency),
    notes              = COALESCE(NULLIF(btrim(COALESCE(p_notes, '')), ''), notes),
    updated_at         = now()
  WHERE id = v_order.id
  RETURNING * INTO v_order;

  RETURN jsonb_build_object('ok', true, 'order_id', v_order.id,
                            'order_generation', v_order.order_generation);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_procurement_update_order(
  uuid, uuid, text, date, text, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_procurement_update_order(
  uuid, uuid, text, date, text, text, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_procurement_add_order_line(
  p_order_id         uuid,
  p_scientific_name  text,
  p_ordered_quantity integer,
  p_central_item_id  uuid DEFAULT NULL,
  p_trade_name       text DEFAULT NULL,
  p_concentration    text DEFAULT NULL,
  p_dosage_form      text DEFAULT NULL,
  p_unit             text DEFAULT NULL,
  p_national_code    text DEFAULT NULL,
  p_batch_number     text DEFAULT NULL,
  p_expiry_date      date DEFAULT NULL,
  p_unit_price       numeric DEFAULT NULL,
  p_currency         text DEFAULT NULL,
  p_notes            text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_order public.procurement_orders%ROWTYPE;
  v_name  text := NULLIF(btrim(COALESCE(p_scientific_name, '')), '');
  v_line  public.procurement_order_lines%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'scientific_name_required' USING ERRCODE = '23514';
  END IF;
  IF p_ordered_quantity IS NULL OR p_ordered_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF p_unit_price IS NOT NULL AND p_unit_price < 0 THEN
    RAISE EXCEPTION 'unit_price_must_be_non_negative' USING ERRCODE = '23514';
  END IF;

  v_order := public._phoenix_procurement_lock_draft_order(p_order_id, v_actor);

  INSERT INTO public.procurement_order_lines (
    order_id, organization_id, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, batch_number, expiry_date,
    ordered_quantity, unit_price, currency, notes
  ) VALUES (
    v_order.id, v_order.organization_id, p_central_item_id,
    v_name, NULLIF(btrim(COALESCE(p_trade_name, '')), ''),
    NULLIF(btrim(COALESCE(p_concentration, '')), ''),
    NULLIF(btrim(COALESCE(p_dosage_form, '')), ''),
    NULLIF(btrim(COALESCE(p_unit, '')), ''),
    NULLIF(btrim(COALESCE(p_national_code, '')), ''),
    NULLIF(btrim(COALESCE(p_batch_number, '')), ''),
    p_expiry_date, p_ordered_quantity, p_unit_price,
    NULLIF(btrim(COALESCE(p_currency, '')), ''), NULLIF(btrim(COALESCE(p_notes, '')), '')
  )
  RETURNING * INTO v_line;

  -- A line change is an ORDER change: advance the order generation so a
  -- submit/approve racing this edit conflicts instead of acting on stale lines.
  UPDATE public.procurement_orders SET updated_at = now() WHERE id = v_order.id;

  RETURN jsonb_build_object('ok', true, 'order_line_id', v_line.id);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_procurement_add_order_line(
  uuid, text, integer, uuid, text, text, text, text, text, text, date, numeric, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_procurement_add_order_line(
  uuid, text, integer, uuid, text, text, text, text, text, text, date, numeric, text, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_procurement_remove_order_line(
  p_order_line_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_line  public.procurement_order_lines%ROWTYPE;
  v_order public.procurement_orders%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_order_line_id IS NULL THEN
    RAISE EXCEPTION 'order_line_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_line FROM public.procurement_order_lines WHERE id = p_order_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_order := public._phoenix_procurement_lock_draft_order(v_line.order_id, v_actor);

  DELETE FROM public.procurement_order_lines WHERE id = p_order_line_id;
  UPDATE public.procurement_orders SET updated_at = now() WHERE id = v_order.id;

  RETURN jsonb_build_object('ok', true, 'order_line_id', p_order_line_id);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_procurement_remove_order_line(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_procurement_remove_order_line(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_procurement_update_order_line(
  p_order_line_id    uuid,
  p_scientific_name  text DEFAULT NULL,
  p_ordered_quantity integer DEFAULT NULL,
  p_central_item_id  uuid DEFAULT NULL,
  p_trade_name       text DEFAULT NULL,
  p_concentration    text DEFAULT NULL,
  p_dosage_form      text DEFAULT NULL,
  p_unit             text DEFAULT NULL,
  p_national_code    text DEFAULT NULL,
  p_batch_number     text DEFAULT NULL,
  p_expiry_date      date DEFAULT NULL,
  p_unit_price       numeric DEFAULT NULL,
  p_currency         text DEFAULT NULL,
  p_notes            text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_line  public.procurement_order_lines%ROWTYPE;
  v_order public.procurement_orders%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_order_line_id IS NULL THEN
    RAISE EXCEPTION 'order_line_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_ordered_quantity IS NOT NULL AND p_ordered_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF p_unit_price IS NOT NULL AND p_unit_price < 0 THEN
    RAISE EXCEPTION 'unit_price_must_be_non_negative' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_line FROM public.procurement_order_lines WHERE id = p_order_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_order := public._phoenix_procurement_lock_draft_order(v_line.order_id, v_actor);

  UPDATE public.procurement_order_lines SET
    scientific_name  = COALESCE(NULLIF(btrim(COALESCE(p_scientific_name, '')), ''), scientific_name),
    ordered_quantity = COALESCE(p_ordered_quantity, ordered_quantity),
    central_item_id  = COALESCE(p_central_item_id, central_item_id),
    trade_name       = COALESCE(NULLIF(btrim(COALESCE(p_trade_name, '')), ''), trade_name),
    concentration    = COALESCE(NULLIF(btrim(COALESCE(p_concentration, '')), ''), concentration),
    dosage_form      = COALESCE(NULLIF(btrim(COALESCE(p_dosage_form, '')), ''), dosage_form),
    unit             = COALESCE(NULLIF(btrim(COALESCE(p_unit, '')), ''), unit),
    national_code    = COALESCE(NULLIF(btrim(COALESCE(p_national_code, '')), ''), national_code),
    batch_number     = COALESCE(NULLIF(btrim(COALESCE(p_batch_number, '')), ''), batch_number),
    expiry_date      = COALESCE(p_expiry_date, expiry_date),
    unit_price       = COALESCE(p_unit_price, unit_price),
    currency         = COALESCE(NULLIF(btrim(COALESCE(p_currency, '')), ''), currency),
    notes            = COALESCE(NULLIF(btrim(COALESCE(p_notes, '')), ''), notes),
    updated_at       = now()
  WHERE id = p_order_line_id;

  UPDATE public.procurement_orders SET updated_at = now() WHERE id = v_order.id;

  RETURN jsonb_build_object('ok', true, 'order_line_id', p_order_line_id);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_procurement_update_order_line(
  uuid, text, integer, uuid, text, text, text, text, text, text, date, numeric, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_procurement_update_order_line(
  uuid, text, integer, uuid, text, text, text, text, text, text, date, numeric, text, text
) TO authenticated;

-- ============================================================================
-- 6. LIFECYCLE RPCs — submit / decide / cancel
-- ============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_procurement_submit_order(
  p_order_id            uuid,
  p_expected_generation bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_actor_name text;
  v_order      public.procurement_orders%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  v_order := public._phoenix_procurement_lock_draft_order(p_order_id, v_actor);

  IF p_expected_generation IS NOT NULL
     AND v_order.order_generation IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'procurement_order_generation_conflict'
      USING ERRCODE = '40001',
            DETAIL  = format('expected generation %s, canonical generation %s',
                             p_expected_generation, v_order.order_generation);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.procurement_order_lines WHERE order_id = v_order.id) THEN
    RAISE EXCEPTION 'order_has_no_lines' USING ERRCODE = '23514';
  END IF;

  SELECT o_role, o_name INTO v_actor_role, v_actor_name
  FROM public._phoenix_procurement_actor(v_actor);

  UPDATE public.procurement_orders SET
    status       = 'submitted',
    submitted_by = v_actor,
    submitted_at = now(),
    updated_at   = now()
  WHERE id = v_order.id
  RETURNING * INTO v_order;

  PERFORM public._phoenix_procurement_log_event(
    v_order, 'submitted', 'draft', 'submitted', v_actor, v_actor_role, v_actor_name);

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_order.organization_id, v_actor, v_actor_role,
    'local_procurement.order_submitted', 'procurement_orders', v_order.id, v_order.order_number,
    jsonb_build_object('warehouse_id', v_order.warehouse_id)
  );

  RETURN jsonb_build_object('ok', true, 'order_id', v_order.id, 'status', v_order.status,
                            'order_generation', v_order.order_generation);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_procurement_submit_order(uuid, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_procurement_submit_order(uuid, bigint) TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_procurement_decide_order(
  p_order_id            uuid,
  p_approve             boolean,
  p_notes               text DEFAULT NULL,
  p_expected_generation bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_actor_name text;
  v_order      public.procurement_orders%ROWTYPE;
  v_to         text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'order_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_approve IS NULL THEN
    RAISE EXCEPTION 'decision_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_order FROM public.procurement_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'local_procurement.approve', v_order.organization_id, v_order.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_local_procurement_approve' USING ERRCODE = '42501';
  END IF;

  IF v_order.status <> 'submitted' THEN
    RAISE EXCEPTION 'order_not_submitted' USING ERRCODE = '23514';
  END IF;

  -- SEPARATION OF DUTY: whoever submitted a purchase must never approve it.
  IF v_order.submitted_by IS NOT DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'approver_must_differ_from_submitter' USING ERRCODE = '42501';
  END IF;

  IF p_expected_generation IS NOT NULL
     AND v_order.order_generation IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'procurement_order_generation_conflict'
      USING ERRCODE = '40001',
            DETAIL  = format('expected generation %s, canonical generation %s',
                             p_expected_generation, v_order.order_generation);
  END IF;

  SELECT o_role, o_name INTO v_actor_role, v_actor_name
  FROM public._phoenix_procurement_actor(v_actor);

  v_to := CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;

  UPDATE public.procurement_orders SET
    status         = v_to,
    decided_by     = v_actor,
    decided_at     = now(),
    decision_notes = NULLIF(btrim(COALESCE(p_notes, '')), ''),
    updated_at     = now()
  WHERE id = v_order.id
  RETURNING * INTO v_order;

  PERFORM public._phoenix_procurement_log_event(
    v_order, v_to, 'submitted', v_to, v_actor, v_actor_role, v_actor_name, p_notes);

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_order.organization_id, v_actor, v_actor_role,
    'local_procurement.order_' || v_to, 'procurement_orders', v_order.id, v_order.order_number,
    jsonb_build_object('warehouse_id', v_order.warehouse_id,
                       'decision_notes', NULLIF(btrim(COALESCE(p_notes, '')), ''))
  );

  RETURN jsonb_build_object('ok', true, 'order_id', v_order.id, 'status', v_order.status,
                            'order_generation', v_order.order_generation);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_procurement_decide_order(uuid, boolean, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_procurement_decide_order(uuid, boolean, text, bigint) TO authenticated;

CREATE OR REPLACE FUNCTION public.phoenix_procurement_cancel_order(
  p_order_id            uuid,
  p_reason              text,
  p_expected_generation bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_actor_name text;
  v_order      public.procurement_orders%ROWTYPE;
  v_reason     text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_from       text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'order_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'cancel_reason_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_order FROM public.procurement_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'local_procurement.manage', v_order.organization_id, v_order.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_local_procurement_manage' USING ERRCODE = '42501';
  END IF;

  IF v_order.status NOT IN ('draft', 'submitted', 'approved') THEN
    RAISE EXCEPTION 'order_not_cancellable' USING ERRCODE = '23514';
  END IF;
  -- An order with a posted receipt is history and cannot be cancelled.
  IF EXISTS (SELECT 1 FROM public.procurement_receipts WHERE order_id = v_order.id) THEN
    RAISE EXCEPTION 'order_has_receipts' USING ERRCODE = '23514';
  END IF;

  IF p_expected_generation IS NOT NULL
     AND v_order.order_generation IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'procurement_order_generation_conflict'
      USING ERRCODE = '40001',
            DETAIL  = format('expected generation %s, canonical generation %s',
                             p_expected_generation, v_order.order_generation);
  END IF;

  SELECT o_role, o_name INTO v_actor_role, v_actor_name
  FROM public._phoenix_procurement_actor(v_actor);

  v_from := v_order.status;

  UPDATE public.procurement_orders SET
    status        = 'cancelled',
    cancelled_by  = v_actor,
    cancelled_at  = now(),
    cancel_reason = v_reason,
    updated_at    = now()
  WHERE id = v_order.id
  RETURNING * INTO v_order;

  PERFORM public._phoenix_procurement_log_event(
    v_order, 'cancelled', v_from, 'cancelled', v_actor, v_actor_role, v_actor_name, v_reason);

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_order.organization_id, v_actor, v_actor_role,
    'local_procurement.order_cancelled', 'procurement_orders', v_order.id, v_order.order_number,
    jsonb_build_object('from_status', v_from, 'reason', v_reason)
  );

  RETURN jsonb_build_object('ok', true, 'order_id', v_order.id, 'status', v_order.status,
                            'order_generation', v_order.order_generation);
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_procurement_cancel_order(uuid, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_procurement_cancel_order(uuid, text, bigint) TO authenticated;

-- ============================================================================
-- 7. GUARDED RECEIPT RPC — the ONLY door stock enters through
-- ============================================================================
-- p_lines: JSON array of
--   { "order_line_id": uuid, "quantity": int > 0,
--     "batch_number": text|null, "has_no_batch_number": bool,
--     "expiry_date": "YYYY-MM-DD"|null, "unit_price": number|null }
-- The national code is NEVER taken from the receipt payload: it comes from the
-- reviewed order line, so receiving cannot silently relabel a product.
CREATE OR REPLACE FUNCTION public.phoenix_procurement_receive_order(
  p_request_id          uuid,
  p_order_id            uuid,
  p_lines               jsonb,
  p_expected_generation bigint DEFAULT NULL,
  p_notes               text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_actor_name  text;
  v_notes       text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_order       public.procurement_orders%ROWTYPE;
  v_existing    public.procurement_receipts%ROWTYPE;
  v_receipt     public.procurement_receipts%ROWTYPE;
  v_fingerprint text;
  v_normalized  jsonb;
  v_item        jsonb;
  v_line        public.procurement_order_lines%ROWTYPE;
  v_line_id     uuid;
  v_qty         integer;
  v_batch       text;
  v_no_batch    boolean;
  v_expiry      date;
  v_price       numeric;
  v_receipt_line public.procurement_receipt_lines%ROWTYPE;
  v_stock_id    uuid;
  v_movement_id uuid;
  v_out_lines   jsonb := '[]'::jsonb;
  v_all_received boolean;
  v_new_status  text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'order_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'receipt_lines_required' USING ERRCODE = '23514';
  END IF;

  -- Normalize the payload deterministically (sorted by order_line_id) and bind
  -- the request id to it. jsonb text form has deterministic key ordering;
  -- SHA-256 is a consistency checksum only, never authentication.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'order_line_id', e->>'order_line_id',
           'quantity',      (e->>'quantity'),
           'batch_number',  NULLIF(btrim(COALESCE(e->>'batch_number', '')), ''),
           'has_no_batch_number', (e->>'has_no_batch_number'),
           'expiry_date',   NULLIF(btrim(COALESCE(e->>'expiry_date', '')), ''),
           'unit_price',    NULLIF(btrim(COALESCE(e->>'unit_price', '')), '')
         ) ORDER BY e->>'order_line_id'), '[]'::jsonb)
    INTO v_normalized
  FROM jsonb_array_elements(p_lines) e;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'procurement_receive',
    'order_id', p_order_id,
    'lines', v_normalized,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  -- Serialize retries BEFORE any row lock (065's advisory-lock-first order).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 87087));

  SELECT * INTO v_existing
  FROM public.procurement_receipts r
  WHERE r.request_id = p_request_id;

  IF FOUND THEN
    -- A replay must be THE SAME semantic request; anything else fails closed.
    IF v_existing.order_id IS DISTINCT FROM p_order_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'receipt_line_id', l.id,
             'order_line_id', l.order_line_id,
             'quantity', l.quantity,
             'warehouse_stock_id', l.warehouse_stock_id,
             'movement_id', l.movement_id)), '[]'::jsonb)
      INTO v_out_lines
    FROM public.procurement_receipt_lines l
    WHERE l.receipt_id = v_existing.id;
    SELECT * INTO v_order FROM public.procurement_orders WHERE id = p_order_id;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'receipt_id', v_existing.id, 'receipt_number', v_existing.receipt_number,
      'order_status', v_order.status, 'lines', v_out_lines
    );
  END IF;

  SELECT * INTO v_order FROM public.procurement_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- THE IDOR GATE: receipt authority scoped to the purchasing warehouse.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'local_procurement.receive', v_order.organization_id, v_order.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_local_procurement_receive' USING ERRCODE = '42501';
  END IF;

  IF v_order.status NOT IN ('approved', 'partially_received') THEN
    RAISE EXCEPTION 'order_not_receivable' USING ERRCODE = '23514';
  END IF;

  -- Optimistic concurrency (078/086 discipline): checked under the order row
  -- lock, AFTER the idempotent-replay short-circuit, so a genuine retry and
  -- the generation guard never fight.
  IF p_expected_generation IS NOT NULL
     AND v_order.order_generation IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'procurement_order_generation_conflict'
      USING ERRCODE = '40001',
            DETAIL  = format('expected generation %s, canonical generation %s',
                             p_expected_generation, v_order.order_generation);
  END IF;

  SELECT o_role, o_name INTO v_actor_role, v_actor_name
  FROM public._phoenix_procurement_actor(v_actor);

  -- Reject duplicate order lines inside one payload: the cap check below is
  -- per-line-lock, and a duplicated line must not slip through it in halves.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) e
    GROUP BY e->>'order_line_id' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate_order_line_in_payload' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.procurement_receipts (
    order_id, organization_id, warehouse_id, supplier_id,
    receipt_number, request_id, request_fingerprint,
    invoice_number, notes, received_by, received_by_role, received_by_name
  ) VALUES (
    v_order.id, v_order.organization_id, v_order.warehouse_id, v_order.supplier_id,
    'PR-' || to_char(now(), 'YYYY') || '-' ||
      lpad(nextval('public.procurement_receipt_number_seq')::text, 6, '0'),
    p_request_id, v_fingerprint,
    v_order.invoice_number, v_notes, v_actor, v_actor_role, v_actor_name
  )
  RETURNING * INTO v_receipt;

  FOR v_item IN
    SELECT e FROM jsonb_array_elements(p_lines) e ORDER BY e->>'order_line_id'
  LOOP
    BEGIN
      v_line_id := (v_item->>'order_line_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid_order_line_id' USING ERRCODE = '23514';
    END;
    IF v_item->>'quantity' IS NULL OR NOT (v_item->>'quantity' ~ '^[0-9]+$') THEN
      RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
    END IF;
    v_qty      := (v_item->>'quantity')::integer;
    v_batch    := NULLIF(btrim(COALESCE(v_item->>'batch_number', '')), '');
    v_no_batch := COALESCE((v_item->>'has_no_batch_number')::boolean, false);
    v_expiry   := NULLIF(btrim(COALESCE(v_item->>'expiry_date', '')), '')::date;
    v_price    := NULLIF(btrim(COALESCE(v_item->>'unit_price', '')), '')::numeric;

    IF v_qty <= 0 THEN
      RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
    END IF;
    IF v_no_batch IS DISTINCT FROM (v_batch IS NULL) THEN
      RAISE EXCEPTION 'batch_number_flag_mismatch' USING ERRCODE = '23514';
    END IF;
    IF v_price IS NOT NULL AND v_price < 0 THEN
      RAISE EXCEPTION 'unit_price_must_be_non_negative' USING ERRCODE = '23514';
    END IF;

    SELECT * INTO v_line
    FROM public.procurement_order_lines
    WHERE id = v_line_id AND order_id = v_order.id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'order_line_not_found' USING ERRCODE = 'P0002';
    END IF;

    -- Over-receipt fails closed, per line, under the line lock.
    IF v_line.received_quantity + v_qty > v_line.ordered_quantity THEN
      RAISE EXCEPTION 'received_quantity_exceeds_ordered'
        USING ERRCODE = '23514',
              DETAIL  = format('line %s: ordered %s, already received %s, attempted %s',
                               v_line.id, v_line.ordered_quantity,
                               v_line.received_quantity, v_qty);
    END IF;

    INSERT INTO public.procurement_receipt_lines (
      receipt_id, order_line_id, organization_id, quantity,
      batch_number, has_no_batch_number,
      national_code, has_no_national_code,
      expiry_date, unit_price
    ) VALUES (
      v_receipt.id, v_line.id, v_order.organization_id, v_qty,
      v_batch, v_no_batch,
      v_line.national_code, v_line.national_code IS NULL,
      COALESCE(v_expiry, v_line.expiry_date),
      COALESCE(v_price, v_line.unit_price)
    )
    RETURNING * INTO v_receipt_line;

    SELECT o_warehouse_stock_id, o_movement_id
      INTO v_stock_id, v_movement_id
    FROM public._phoenix_procurement_post_receipt_line(
      v_receipt_line, v_order, v_line, v_actor, v_actor_role, v_actor_name);

    UPDATE public.procurement_receipt_lines
       SET warehouse_stock_id = v_stock_id, movement_id = v_movement_id
     WHERE id = v_receipt_line.id;

    UPDATE public.procurement_order_lines
       SET received_quantity = received_quantity + v_qty, updated_at = now()
     WHERE id = v_line.id;

    v_out_lines := v_out_lines || jsonb_build_object(
      'receipt_line_id', v_receipt_line.id,
      'order_line_id', v_line.id,
      'quantity', v_qty,
      'warehouse_stock_id', v_stock_id,
      'movement_id', v_movement_id);
  END LOOP;

  SELECT bool_and(l.received_quantity >= l.ordered_quantity)
    INTO v_all_received
  FROM public.procurement_order_lines l
  WHERE l.order_id = v_order.id;

  v_new_status := CASE WHEN COALESCE(v_all_received, false) THEN 'received'
                       ELSE 'partially_received' END;

  PERFORM public._phoenix_procurement_log_event(
    v_order, 'receipt_posted', v_order.status, v_new_status,
    v_actor, v_actor_role, v_actor_name, v_notes,
    jsonb_build_object('receipt_id', v_receipt.id, 'receipt_number', v_receipt.receipt_number,
                       'lines', v_out_lines));

  UPDATE public.procurement_orders SET
    status     = v_new_status,
    updated_at = now()
  WHERE id = v_order.id
  RETURNING * INTO v_order;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_order.organization_id, v_actor, v_actor_role,
    'local_procurement.receipt_posted', 'procurement_receipts', v_receipt.id,
    v_receipt.receipt_number,
    jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number,
                       'order_status', v_new_status, 'request_id', p_request_id)
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'receipt_id', v_receipt.id, 'receipt_number', v_receipt.receipt_number,
    'order_status', v_new_status, 'lines', v_out_lines
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_procurement_receive_order(
  uuid, uuid, jsonb, bigint, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_procurement_receive_order(
  uuid, uuid, jsonb, bigint, text
) TO authenticated;

-- ============================================================================
-- 8. SUPPLIER RETURN RPC — provenance-pinned, capped, never negative
-- ============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_procurement_return_to_supplier(
  p_request_id          uuid,
  p_receipt_line_id     uuid,
  p_quantity            integer,
  p_reason              text,
  p_notes               text DEFAULT NULL,
  p_expected_generation bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_actor_name   text;
  v_reason       text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_notes        text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_fingerprint  text;
  v_existing     public.procurement_returns%ROWTYPE;
  v_receipt_line public.procurement_receipt_lines%ROWTYPE;
  v_receipt      public.procurement_receipts%ROWTYPE;
  v_order        public.procurement_orders%ROWTYPE;
  v_stock        public.warehouse_stock%ROWTYPE;
  v_returned     integer;
  v_return       public.procurement_returns%ROWTYPE;
  v_movement_id  uuid;
  v_before       integer;
  v_after        integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_receipt_line_id IS NULL THEN
    RAISE EXCEPTION 'receipt_line_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'return_reason_required' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'procurement_return',
    'receipt_line_id', p_receipt_line_id,
    'quantity', p_quantity,
    'reason', v_reason,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 87087));

  SELECT * INTO v_existing FROM public.procurement_returns WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.receipt_line_id IS DISTINCT FROM p_receipt_line_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'return_id', v_existing.id, 'movement_id', v_existing.movement_id,
      'quantity', v_existing.quantity
    );
  END IF;

  SELECT * INTO v_receipt_line
  FROM public.procurement_receipt_lines WHERE id = p_receipt_line_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'receipt_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_receipt FROM public.procurement_receipts WHERE id = v_receipt_line.receipt_id;

  -- Lock the order first (same order as receive), then the stock row: two
  -- concurrent procurement writers always meet in the same sequence.
  SELECT * INTO v_order FROM public.procurement_orders WHERE id = v_receipt.order_id FOR UPDATE;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'local_procurement.return', v_order.organization_id, v_order.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_local_procurement_return' USING ERRCODE = '42501';
  END IF;

  SELECT o_role, o_name INTO v_actor_role, v_actor_name
  FROM public._phoenix_procurement_actor(v_actor);

  -- Cap: total returned against this receipt line never exceeds what that
  -- line actually received. Checked under the order lock, so two concurrent
  -- returns cannot both fit inside the remainder.
  SELECT COALESCE(sum(quantity), 0) INTO v_returned
  FROM public.procurement_returns
  WHERE receipt_line_id = p_receipt_line_id;

  IF v_returned + p_quantity > v_receipt_line.quantity THEN
    RAISE EXCEPTION 'return_exceeds_received'
      USING ERRCODE = '23514',
            DETAIL  = format('receipt line %s: received %s, already returned %s, attempted %s',
                             p_receipt_line_id, v_receipt_line.quantity, v_returned, p_quantity);
  END IF;

  IF v_receipt_line.warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'receipt_line_has_no_stock_reference' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_stock
  FROM public.warehouse_stock WHERE id = v_receipt_line.warehouse_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Optimistic concurrency against the CANONICAL stock generation (078).
  IF p_expected_generation IS NOT NULL
     AND v_stock.movement_seq IS DISTINCT FROM p_expected_generation THEN
    RAISE EXCEPTION 'warehouse_stock_generation_conflict'
      USING ERRCODE = '40001',
            DETAIL  = format('expected generation %s, canonical generation %s',
                             p_expected_generation, v_stock.movement_seq);
  END IF;

  -- Never negative, never into reserved stock.
  IF v_stock.on_hand_quantity - v_stock.reserved_quantity < p_quantity THEN
    RAISE EXCEPTION 'insufficient_unreserved_stock'
      USING ERRCODE = '23514',
            DETAIL  = format('on hand %s, reserved %s, attempted return %s',
                             v_stock.on_hand_quantity, v_stock.reserved_quantity, p_quantity);
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before - p_quantity;

  INSERT INTO public.procurement_returns (
    request_id, request_fingerprint, order_id, receipt_line_id,
    organization_id, warehouse_id, quantity, reason, notes,
    actor_id, actor_role, actor_name
  ) VALUES (
    p_request_id, v_fingerprint, v_order.id, p_receipt_line_id,
    v_order.organization_id, v_order.warehouse_id, p_quantity, v_reason, v_notes,
    v_actor, v_actor_role, v_actor_name
  )
  RETURNING * INTO v_return;

  UPDATE public.warehouse_stock
     SET on_hand_quantity = v_after, updated_by = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id,
    movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reference_type, reference_id,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot
  ) VALUES (
    v_stock.id, v_order.organization_id, v_order.warehouse_id,
    'subtract',
    v_before, -p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    v_reason, 'procurement_return', v_return.id,
    v_receipt.receipt_number, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference
  )
  RETURNING id INTO v_movement_id;

  -- Stamp the ledger pointer onto the otherwise-immutable return record — the
  -- trigger's one sanctioned NULL->value fill, in the same transaction.
  UPDATE public.procurement_returns
     SET movement_id = v_movement_id
   WHERE id = v_return.id;

  PERFORM public._phoenix_procurement_log_event(
    v_order, 'return_posted', NULL, v_order.status, v_actor, v_actor_role, v_actor_name, v_reason,
    jsonb_build_object('return_id', v_return.id, 'receipt_line_id', p_receipt_line_id,
                       'quantity', p_quantity, 'movement_id', v_movement_id));

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_order.organization_id, v_actor, v_actor_role,
    'local_procurement.return_posted', 'procurement_returns', v_return.id,
    v_stock.scientific_name,
    jsonb_build_object('order_id', v_order.id, 'receipt_line_id', p_receipt_line_id,
                       'quantity', p_quantity, 'movement_id', v_movement_id,
                       'quantity_before', v_before, 'quantity_after', v_after)
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'return_id', v_return.id, 'movement_id', v_movement_id,
    'quantity', p_quantity,
    'quantity_before', v_before, 'quantity_after', v_after
  );
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_procurement_return_to_supplier(
  uuid, uuid, integer, text, text, bigint
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_procurement_return_to_supplier(
  uuid, uuid, integer, text, text, bigint
) TO authenticated;

-- ============================================================================
-- 9. PERMISSION KEYS + ROLE DEFAULTS
-- ============================================================================

INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous) VALUES
  ('local_procurement.view',    'local_procurement', 'view',    'View local procurement',        'عرض المشتريات المحلية',        false),
  ('local_procurement.manage',  'local_procurement', 'manage',  'Compose local purchase orders', 'إنشاء طلبات الشراء المحلية',   false),
  ('local_procurement.approve', 'local_procurement', 'approve', 'Approve local purchase orders', 'الموافقة على طلبات الشراء',    false),
  ('local_procurement.receive', 'local_procurement', 'receive', 'Receive local purchases',       'استلام المشتريات المحلية',     false),
  ('local_procurement.return',  'local_procurement', 'return',  'Return to local supplier',      'إرجاع إلى المورد المحلي',      false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
SELECT 'super_admin', k.key, true
FROM public.permission_keys k
WHERE k.key LIKE 'local_procurement.%'
ON CONFLICT (role, permission_key) DO NOTHING;

-- SEPARATION OF DUTY: the officer who composes and receives never approves;
-- the oversight roles that approve never do the data entry.
INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  ('institution_admin', 'local_procurement.view',    true),
  ('institution_admin', 'local_procurement.manage',  true),
  ('institution_admin', 'local_procurement.approve', true),
  ('institution_admin', 'local_procurement.receive', false),
  ('institution_admin', 'local_procurement.return',  false),
  ('hospital_admin',    'local_procurement.view',    true),
  ('hospital_admin',    'local_procurement.manage',  true),
  ('hospital_admin',    'local_procurement.approve', true),
  ('hospital_admin',    'local_procurement.receive', false),
  ('hospital_admin',    'local_procurement.return',  false),
  ('warehouse_officer', 'local_procurement.view',    true),
  ('warehouse_officer', 'local_procurement.manage',  true),
  ('warehouse_officer', 'local_procurement.approve', false),
  ('warehouse_officer', 'local_procurement.receive', true),
  ('warehouse_officer', 'local_procurement.return',  true),
  ('monthly_status_officer', 'local_procurement.view',    true),
  ('monthly_status_officer', 'local_procurement.manage',  false),
  ('monthly_status_officer', 'local_procurement.approve', false),
  ('monthly_status_officer', 'local_procurement.receive', false),
  ('monthly_status_officer', 'local_procurement.return',  false),
  ('viewer',            'local_procurement.view',    true),
  ('viewer',            'local_procurement.manage',  false),
  ('viewer',            'local_procurement.approve', false),
  ('viewer',            'local_procurement.receive', false),
  ('viewer',            'local_procurement.return',  false),
  ('port_officer',      'local_procurement.view',    false),
  ('port_officer',      'local_procurement.manage',  false),
  ('port_officer',      'local_procurement.approve', false),
  ('port_officer',      'local_procurement.receive', false),
  ('port_officer',      'local_procurement.return',  false),
  ('transfer_manager',  'local_procurement.view',    true),
  ('transfer_manager',  'local_procurement.manage',  false),
  ('transfer_manager',  'local_procurement.approve', false),
  ('transfer_manager',  'local_procurement.receive', false),
  ('transfer_manager',  'local_procurement.return',  false)
ON CONFLICT (role, permission_key) DO NOTHING;

COMMIT;

-- ============================================================================
-- POST-CONDITIONS — run AFTER apply. Read-only.
-- ============================================================================
-- 1. Tables present with RLS:
--    SELECT relname, relrowsecurity FROM pg_class
--     WHERE relname LIKE 'procurement_%' AND relkind = 'r';
--    -- expect 6 rows (suppliers, orders, order_lines, receipts, receipt_lines,
--    --                 returns) + procurement_order_events, all relrowsecurity=t
-- 2. Clients cannot write any procurement table:
--    SELECT has_table_privilege('authenticated','public.procurement_orders','INSERT'); -- f
--    SELECT has_table_privilege('authenticated','public.procurement_receipts','UPDATE'); -- f
-- 3. RPCs least-granted:
--    SELECT has_function_privilege('anon',
--      'public.phoenix_procurement_receive_order(uuid, uuid, jsonb, bigint, text)','EXECUTE'); -- f
--    SELECT has_function_privilege('authenticated',
--      'public.phoenix_procurement_receive_order(uuid, uuid, jsonb, bigint, text)','EXECUTE'); -- t
-- 4. Once-only ledger indexes:
--    SELECT indexname FROM pg_indexes WHERE tablename='warehouse_stock_movements'
--     AND indexname LIKE '%procurement%'; -- 2 rows
-- 5. Permission keys:
--    SELECT count(*) FROM permission_keys WHERE key LIKE 'local_procurement.%'; -- 5
-- ============================================================================
-- ROLLBACK / CONTAINMENT (drop in reverse dependency order)
-- ============================================================================
--   DROP FUNCTION IF EXISTS public.phoenix_procurement_return_to_supplier(uuid, uuid, integer, text, text, bigint);
--   DROP FUNCTION IF EXISTS public.phoenix_procurement_receive_order(uuid, uuid, jsonb, bigint, text);
--   DROP FUNCTION IF EXISTS public.phoenix_procurement_cancel_order(uuid, text, bigint);
--   DROP FUNCTION IF EXISTS public.phoenix_procurement_decide_order(uuid, boolean, text, bigint);
--   DROP FUNCTION IF EXISTS public.phoenix_procurement_submit_order(uuid, bigint);
--   DROP FUNCTION IF EXISTS public.phoenix_procurement_update_order_line(uuid, text, integer, uuid, text, text, text, text, text, text, date, numeric, text, text);
--   DROP FUNCTION IF EXISTS public.phoenix_procurement_remove_order_line(uuid);
--   DROP FUNCTION IF EXISTS public.phoenix_procurement_add_order_line(uuid, text, integer, uuid, text, text, text, text, text, text, date, numeric, text, text);
--   DROP FUNCTION IF EXISTS public.phoenix_procurement_update_order(uuid, uuid, text, date, text, text, text);
--   DROP FUNCTION IF EXISTS public._phoenix_procurement_lock_draft_order(uuid, uuid);
--   DROP FUNCTION IF EXISTS public.phoenix_procurement_create_order(uuid, uuid, text, text, date, text, text, text, boolean);
--   DROP FUNCTION IF EXISTS public.phoenix_procurement_save_supplier(uuid, uuid, text, text, text, text, text, text, text, text, text);
--   DROP FUNCTION IF EXISTS public._phoenix_procurement_post_receipt_line(public.procurement_receipt_lines, public.procurement_orders, public.procurement_order_lines, uuid, text, text);
--   DROP FUNCTION IF EXISTS public._phoenix_procurement_actor(uuid);
--   DROP FUNCTION IF EXISTS public._phoenix_procurement_log_event(public.procurement_orders, text, text, text, uuid, text, text, text, jsonb);
--   DROP FUNCTION IF EXISTS public.phoenix_procurement_org_authority(uuid, text, uuid);
--   DROP FUNCTION IF EXISTS public.phoenix_can_read_local_procurement(uuid, uuid);
--   DROP INDEX IF EXISTS public.warehouse_stock_movements_procurement_return_once_uniq;
--   DROP INDEX IF EXISTS public.warehouse_stock_movements_procurement_receipt_once_uniq;
--   DROP TABLE IF EXISTS public.procurement_order_events;
--   DROP TABLE IF EXISTS public.procurement_returns;
--   DROP TABLE IF EXISTS public.procurement_receipt_lines;
--   DROP TABLE IF EXISTS public.procurement_receipts;
--   DROP TABLE IF EXISTS public.procurement_order_lines;
--   DROP TABLE IF EXISTS public.procurement_orders;
--   DROP TABLE IF EXISTS public.procurement_suppliers;
--   DROP SEQUENCE IF EXISTS public.procurement_receipt_number_seq;
--   DROP FUNCTION IF EXISTS public.phoenix_procurement_order_bump_generation();
--   DROP FUNCTION IF EXISTS public.phoenix_procurement_forbid_mutation();
--   DELETE FROM public.role_permission_defaults WHERE permission_key LIKE 'local_procurement.%';
--   DELETE FROM public.permission_keys WHERE key LIKE 'local_procurement.%';
-- ============================================================================

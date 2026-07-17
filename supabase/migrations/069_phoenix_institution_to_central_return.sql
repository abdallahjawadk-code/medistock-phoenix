-- ============================================================================
-- INSTITUTION-TO-CENTRAL-RETURN-069-A
--
-- MANUAL APPLY ONLY. DO NOT use supabase db push or any automated runner.
--
-- VERIFICATION STATUS: pre-merge validation did not include execution against a
-- disposable PostgreSQL database; validation used static analysis, tests, CI,
-- and Supabase dry-run. Section 13's post-conditions are analysis, not a
-- proven runtime guarantee. Apply to a staging/preview database and confirm
-- every post-condition passes BEFORE this is treated as ready for production.
--
-- STRATEGY: Expand -> Frontend Migration -> Contract. This is an EXPAND step.
-- It is ADDITIVE AND BACKWARD-COMPATIBLE BY CONSTRUCTION.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS COMPLETES
-- ─────────────────────────────────────────────────────────────────────────────
-- 068 built central -> institution supply, but explicitly deferred the reverse
-- leg: "No RETURN path (institution -> central). Deferred to 069 ... so both
-- directions are designed together, once." 069 is that direction:
--
--   institution --request--> asks to send stock back (excess/near-expiry/
--                             quality issue), OR
--   central     --recall---> asks the institution to send stock back
--                             (recall/mis-shipment) — EITHER side may open it
--   central     --review----> accepts in full/in part, or rejects, per line
--   institution --send------> stock leaves the institution warehouse
--               --in transit-> owned by neither balance, same as 068
--   central     --receive---> stock re-enters the central warehouse
--
-- Scope note (deliberately split from this file): the outlet -> institution
-- return (067's dispatch/outlet_stock domain) is a SEPARATE physical model —
-- dispatch has no route table (any warehouse may dispatch to any outlet in
-- its org) and no existing "accept a return" permission key, so it needs its
-- own design pass rather than a mechanical mirror of this one. Tracked as a
-- follow-up migration, not built here, so this file stays reviewable as one
-- coherent piece — the same reasoning 068 used to keep the return path out of
-- itself in the first place.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE PHYSICAL MOVER IS ALWAYS THE INSTITUTION, REGARDLESS OF WHO ASKED
-- ─────────────────────────────────────────────────────────────────────────────
-- Only whoever physically holds the stock can ship it. A central-side RECALL
-- does not let central move institution stock directly — it only opens the
-- same request row a receiver-initiated return would, with
-- requested_by_side='sender' instead of 'receiver'. Whoever holds the goods
-- (the institution) still executes SEND; whoever gets them back (central)
-- still executes REVIEW and RECEIVE. Initiation side changes WHO may open the
-- request and WHO may cancel it; it never changes WHO may move stock.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- REUSING 066's ROUTE, IN REVERSE
-- ─────────────────────────────────────────────────────────────────────────────
-- 066's warehouse_supply_routes is structurally pinned central->institution by
-- CHECK (warehouse_supply_routes_source_is_central /
-- ...target_is_institution) — it cannot be repointed to express
-- institution->central without violating its own guarantee. A return does not
-- need a new route table: it reuses the SAME approved route, read backwards.
-- The return tables' composite FKs reference the EXISTING
-- (id, source_warehouse_id, target_warehouse_id) unique key from 066/068, but
-- with the return table's OWN columns (source=institution, destination=
-- central) matched in the OPPOSITE order: (route_id, destination_warehouse_id,
-- source_warehouse_id) -> routes(id, source_warehouse_id, target_warehouse_id).
-- No new unique constraint on warehouse_supply_routes is required.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT A RETURN LINE MUST POINT AT: A SPECIFIC RECEIVED BATCH, NEVER A MATERIAL
-- ─────────────────────────────────────────────────────────────────────────────
-- 068's request lines name a MATERIAL because the central warehouse picks the
-- lot at send time. A return is the opposite: the institution is returning
-- stock it already has, from a SPECIFIC prior receipt
-- (warehouse_transfer_lines row, 068's RECEIVE result). Every return line
-- carries original_transfer_line_id NOT NULL, and every quantity is bounded
-- by what that specific line has LEFT to return
-- (received_quantity - returned_quantity), never by a freeform ask.
--
-- warehouse_transfer_lines gains one additive column, returned_quantity,
-- exactly mirroring warehouse_transfer_request_lines.fulfilled_quantity's
-- role in 068: incremented once, at RETURN-SEND time (when the institution's
-- custody of that quantity ends), never at receive.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY RETURN-SEND MUST NOT REFUSE EXPIRED BATCHES (UNLIKE 068's FORWARD SEND)
-- ─────────────────────────────────────────────────────────────────────────────
-- 068's SEND refuses to ship an expired batch onward to a new custodian who
-- would then have to dispose of it. A RETURN is frequently OF an expired or
-- near-expiry batch, going back to the party equipped to dispose of or credit
-- it. phoenix_send_warehouse_return_shipment_line therefore has NO expiry
-- check — this is a deliberate, named divergence from the forward SEND
-- contract, not an oversight; a test asserts the absence explicitly.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- REUSED, NOT WIDENED: 'dispatch_return' WAS ALREADY IN 060's CHECK
-- ─────────────────────────────────────────────────────────────────────────────
-- warehouse_stock_movements.movement_type has included 'dispatch_return'
-- since 060, unused until now — 069 spends it for the institution-side debit,
-- exactly as 068 spent 060's 'dispatch_send' for the forward debit. The
-- central-side credit reuses 'add' again, exactly as 068's RECEIVE did. No
-- ALTER, no DROP, no widened CHECK anywhere in this file.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DELIBERATELY DOES **NOT** DO
-- ─────────────────────────────────────────────────────────────────────────────
--   * No DROP, no RENAME, no REVOKE against any pre-existing object.
--   * No outlet -> institution return (067's domain) — a follow-up migration.
--   * No cancellation of an in-transit return shipment — symmetric with 068's
--     own rule for the forward direction; a return, once sent, is done.
--   * No RBAC enforcement change. Enforcement stays OFF; organization/
--     warehouse scope enforcement (phoenix_profile_has_scoped_permission)
--     stays ON, independent of that toggle, as it always has.
--   * No data backfill. No route is created. No row is rewritten.
--   * No frontend in this PR — DB layer only.
-- ============================================================================

begin;

-- ============================================================================
-- 0. PRECONDITIONS
-- ============================================================================
DO $guard$
BEGIN
  IF to_regclass('public.warehouse_transfers') IS NULL
     OR to_regclass('public.warehouse_transfer_lines') IS NULL
     OR to_regclass('public.warehouse_transfer_requests') IS NULL
     OR to_regclass('public.warehouse_supply_routes') IS NULL
     OR to_regclass('public.warehouse_stock') IS NULL
     OR to_regclass('public.warehouse_stock_movements') IS NULL THEN
    RAISE EXCEPTION 'ABORT 069: expected 060/066/068 schema is absent. Apply earlier migrations first.';
  END IF;

  IF to_regprocedure('public.phoenix_send_warehouse_transfer_line(uuid,uuid,uuid,integer,text,uuid,text,text)') IS NULL
     OR to_regprocedure('public.phoenix_receive_warehouse_transfer_line(uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 069: 068 SEND/RECEIVE RPCs are absent. Apply 068 first.';
  END IF;

  IF to_regprocedure('public.phoenix_profile_has_scoped_permission(uuid,text,uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 069: 062 scope helper is absent. Apply 062 first.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_supply_routes_id_endpoints_uniq') THEN
    RAISE EXCEPTION 'ABORT 069: warehouse_supply_routes_id_endpoints_uniq (068) is absent.';
  END IF;

  RAISE NOTICE '069 preconditions OK.';
END;
$guard$;

-- ============================================================================
-- 1. warehouse_transfer_lines gains returned_quantity — additive column
-- ============================================================================
-- Mirrors fulfilled_quantity's role on warehouse_transfer_request_lines: a
-- running total, incremented once per return-send, that bounds how much of
-- THIS specific received line can ever be asked for again.
DO $$ BEGIN
  ALTER TABLE public.warehouse_transfer_lines
    ADD COLUMN returned_quantity integer NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.warehouse_transfer_lines
    ADD CONSTRAINT wtl_returned_qty_chk
    CHECK (returned_quantity >= 0 AND returned_quantity <= COALESCE(received_quantity, 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 2. warehouse_return_requests — either side asks
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.warehouse_return_requests (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Reuses 066's route, READ IN REVERSE: institution (route.target) is the
  -- physical source of a return; central (route.source) is its destination.
  route_id                  uuid NOT NULL,

  source_warehouse_id       uuid NOT NULL,   -- institution: physical holder
  source_organization_id    uuid NOT NULL,
  destination_warehouse_id  uuid NOT NULL,   -- central: receives it back
  destination_organization_id uuid NOT NULL,

  return_number             text NOT NULL,
  status                    text NOT NULL DEFAULT 'draft',

  -- WHO opened this. Never changes who may SEND (always institution) or
  -- RECEIVE/REVIEW (always central) — only who may CREATE and CANCEL it.
  requested_by_side         text NOT NULL,
  notes                     text,

  requested_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_at              timestamptz,
  reviewed_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at               timestamptz,
  cancelled_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_at              timestamptz,
  cancellation_reason       text,

  created_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT wrr_id_src_org_uniq UNIQUE (id, source_organization_id),

  -- Column order is REVERSED relative to 068's wtr_route_endpoints_fk: this
  -- table's source is the route's TARGET, and this table's destination is
  -- the route's SOURCE. Same unique key from 066/068, opposite mapping.
  CONSTRAINT wrr_route_endpoints_fk
    FOREIGN KEY (route_id, destination_warehouse_id, source_warehouse_id)
    REFERENCES public.warehouse_supply_routes (id, source_warehouse_id, target_warehouse_id)
    ON DELETE RESTRICT,

  CONSTRAINT wrr_source_wh_org_fk
    FOREIGN KEY (source_warehouse_id, source_organization_id)
    REFERENCES public.warehouses (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT wrr_dest_wh_org_fk
    FOREIGN KEY (destination_warehouse_id, destination_organization_id)
    REFERENCES public.warehouses (id, organization_id) ON DELETE RESTRICT,

  CONSTRAINT wrr_no_self_return
    CHECK (source_warehouse_id <> destination_warehouse_id),

  CONSTRAINT wrr_requested_by_side_chk
    CHECK (requested_by_side IN ('receiver', 'sender')),

  CONSTRAINT wrr_status_chk
    CHECK (status IN (
      'draft', 'submitted', 'approved', 'partially_approved', 'rejected',
      'cancelled', 'partially_fulfilled', 'fulfilled'
    )),

  CONSTRAINT wrr_number_chk
    CHECK (btrim(return_number) = return_number AND return_number <> ''),

  CONSTRAINT wrr_requested_at_chk
    CHECK (
      CASE WHEN status = 'draft' THEN requested_at IS NULL
           WHEN status = 'cancelled' THEN true
           ELSE requested_at IS NOT NULL
      END
    ),

  CONSTRAINT wrr_cancel_chk
    CHECK (
      CASE WHEN status = 'cancelled'
           THEN cancelled_at IS NOT NULL
                AND cancellation_reason IS NOT NULL AND btrim(cancellation_reason) <> ''
           ELSE cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL
      END
    ),

  CONSTRAINT wrr_reviewed_at_chk
    CHECK (
      CASE WHEN status IN ('approved', 'partially_approved', 'rejected',
                            'partially_fulfilled', 'fulfilled')
           THEN reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL
           ELSE reviewed_at IS NULL AND reviewed_by IS NULL
      END
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS wrr_src_org_number_uniq
  ON public.warehouse_return_requests (source_organization_id, btrim(return_number));

CREATE INDEX IF NOT EXISTS wrr_route_idx  ON public.warehouse_return_requests (route_id);
CREATE INDEX IF NOT EXISTS wrr_source_idx ON public.warehouse_return_requests (source_warehouse_id, status);
CREATE INDEX IF NOT EXISTS wrr_dest_idx   ON public.warehouse_return_requests (destination_warehouse_id, status);

COMMENT ON TABLE public.warehouse_return_requests IS
  'INSTITUTION-TO-CENTRAL-RETURN-069-A: either the institution (requested_by_side'
  '=''receiver'') or central (=''sender'', a recall) may open this, but the '
  'institution always physically SENDs and central always REVIEWs/RECEIVEs, '
  'regardless of who asked. Reuses 066''s route in reverse. Written only by '
  'SECURITY DEFINER RPCs; no direct client write path.';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.warehouse_return_requests
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 3. warehouse_return_request_lines — one specific received batch per line
-- ============================================================================
-- Unlike 068's request lines (a MATERIAL, batch chosen later), a return line
-- names an EXACT prior receipt: original_transfer_line_id. Snapshot fields
-- are copied at creation for display/audit and are immutable thereafter —
-- the RPC copies them from the original line, the client never types them.

CREATE TABLE IF NOT EXISTS public.warehouse_return_request_lines (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_request_id         uuid NOT NULL,
  source_organization_id    uuid NOT NULL,

  original_transfer_line_id uuid NOT NULL REFERENCES public.warehouse_transfer_lines(id) ON DELETE RESTRICT,

  -- Immutable snapshot, copied from the original line at creation.
  scientific_name            text NOT NULL,
  concentration               text,
  dosage_form                 text,
  unit                         text,
  national_code                text,
  batch_number                 text,
  internal_batch_reference     text,
  expiry_date                  date,

  reason_code                text NOT NULL,
  reason_text                 text,

  requested_quantity         integer NOT NULL,
  approved_quantity          integer,
  fulfilled_quantity         integer NOT NULL DEFAULT 0,
  status                      text NOT NULL DEFAULT 'pending',

  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT wrrl_request_org_fk
    FOREIGN KEY (return_request_id, source_organization_id)
    REFERENCES public.warehouse_return_requests (id, source_organization_id)
    ON DELETE CASCADE,

  CONSTRAINT wrrl_sci_name_chk
    CHECK (btrim(scientific_name) = scientific_name AND scientific_name <> ''),
  CONSTRAINT wrrl_reason_code_chk
    CHECK (reason_code IN ('excess', 'wrong_item', 'near_expiry', 'expired', 'quality_issue', 'recall', 'other')),
  CONSTRAINT wrrl_requested_qty_chk  CHECK (requested_quantity > 0),
  CONSTRAINT wrrl_approved_qty_chk
    CHECK (approved_quantity IS NULL
           OR (approved_quantity >= 0 AND approved_quantity <= requested_quantity)),
  CONSTRAINT wrrl_fulfilled_qty_chk  CHECK (fulfilled_quantity >= 0),
  CONSTRAINT wrrl_fulfilled_le_requested_chk
    CHECK (fulfilled_quantity <= requested_quantity),
  CONSTRAINT wrrl_fulfilled_requires_approval_chk
    CHECK (approved_quantity IS NOT NULL OR fulfilled_quantity = 0),
  CONSTRAINT wrrl_fulfilled_le_approved_chk
    CHECK (approved_quantity IS NULL OR fulfilled_quantity <= approved_quantity),

  CONSTRAINT wrrl_status_chk
    CHECK (status IN (
      'pending', 'approved', 'rejected', 'partially_fulfilled', 'fulfilled', 'cancelled'
    )),

  CONSTRAINT wrrl_status_qty_consistency_chk
    CHECK (
      CASE status
        WHEN 'pending'              THEN approved_quantity IS NULL AND fulfilled_quantity = 0
        WHEN 'approved'             THEN approved_quantity IS NOT NULL AND approved_quantity > 0
                                          AND fulfilled_quantity = 0
        WHEN 'rejected'             THEN approved_quantity = 0 AND fulfilled_quantity = 0
        WHEN 'cancelled'            THEN fulfilled_quantity = 0
        WHEN 'partially_fulfilled'  THEN approved_quantity IS NOT NULL
                                          AND fulfilled_quantity > 0
                                          AND fulfilled_quantity < approved_quantity
        WHEN 'fulfilled'            THEN approved_quantity IS NOT NULL
                                          AND fulfilled_quantity = approved_quantity
        ELSE false
      END
    )
);

-- A given prior receipt can be named at most once per return request — a
-- second line for the same original_transfer_line_id would make "how much
-- of THIS batch is being returned?" ambiguous, same reasoning as 068's
-- one-material-per-request rule.
CREATE UNIQUE INDEX IF NOT EXISTS wrrl_request_original_line_uniq
  ON public.warehouse_return_request_lines (return_request_id, original_transfer_line_id);

CREATE INDEX IF NOT EXISTS wrrl_request_idx ON public.warehouse_return_request_lines (return_request_id);
CREATE INDEX IF NOT EXISTS wrrl_original_idx ON public.warehouse_return_request_lines (original_transfer_line_id);

COMMENT ON TABLE public.warehouse_return_request_lines IS
  'INSTITUTION-TO-CENTRAL-RETURN-069-A: one specific prior receipt '
  '(original_transfer_line_id) per line, never a freeform material. Bounded '
  'at the RPC level by that line''s own remaining returnable quantity '
  '(received_quantity - returned_quantity). approved_quantity gates '
  'fulfilled_quantity exactly as in 068''s request lines.';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.warehouse_return_request_lines
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 4. warehouse_return_shipments — the institution sends it back
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.warehouse_return_shipments (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  route_id                  uuid NOT NULL,
  return_request_id         uuid REFERENCES public.warehouse_return_requests(id) ON DELETE RESTRICT,

  source_warehouse_id       uuid NOT NULL,   -- institution
  source_organization_id    uuid NOT NULL,
  destination_warehouse_id  uuid NOT NULL,   -- central
  destination_organization_id uuid NOT NULL,

  shipment_number            text NOT NULL,
  status                     text NOT NULL DEFAULT 'in_transit',
  document_number             text,
  notes                       text,

  sent_by                     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  sent_at                      timestamptz NOT NULL DEFAULT now(),

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT wrs_id_source_org_uniq UNIQUE (id, source_organization_id),

  CONSTRAINT wrs_route_endpoints_fk
    FOREIGN KEY (route_id, destination_warehouse_id, source_warehouse_id)
    REFERENCES public.warehouse_supply_routes (id, source_warehouse_id, target_warehouse_id)
    ON DELETE RESTRICT,

  CONSTRAINT wrs_source_wh_org_fk
    FOREIGN KEY (source_warehouse_id, source_organization_id)
    REFERENCES public.warehouses (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT wrs_dest_wh_org_fk
    FOREIGN KEY (destination_warehouse_id, destination_organization_id)
    REFERENCES public.warehouses (id, organization_id) ON DELETE RESTRICT,

  CONSTRAINT wrs_no_self_return
    CHECK (source_warehouse_id <> destination_warehouse_id),

  -- Symmetric with 068's warehouse_transfers: no 'draft' (the row IS the
  -- send), no 'cancelled' (stock on a truck cannot be un-sent by an UPDATE).
  CONSTRAINT wrs_status_chk
    CHECK (status IN ('in_transit', 'partially_received', 'received')),

  CONSTRAINT wrs_number_chk
    CHECK (btrim(shipment_number) = shipment_number AND shipment_number <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS wrs_source_org_number_uniq
  ON public.warehouse_return_shipments (source_organization_id, btrim(shipment_number));

CREATE INDEX IF NOT EXISTS wrs_route_idx   ON public.warehouse_return_shipments (route_id);
CREATE INDEX IF NOT EXISTS wrs_request_idx ON public.warehouse_return_shipments (return_request_id);
CREATE INDEX IF NOT EXISTS wrs_source_idx  ON public.warehouse_return_shipments (source_warehouse_id, status);
CREATE INDEX IF NOT EXISTS wrs_dest_idx    ON public.warehouse_return_shipments (destination_warehouse_id, status);

COMMENT ON TABLE public.warehouse_return_shipments IS
  'INSTITUTION-TO-CENTRAL-RETURN-069-A: one institution->central return '
  'shipment. No draft, no cancelled — symmetric with 068''s warehouse_transfers. '
  'Endpoints pinned to an approved route (reversed) by composite FK.';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.warehouse_return_shipments
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 5. warehouse_return_shipment_lines — one returned batch per line
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.warehouse_return_shipment_lines (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id                uuid NOT NULL,
  source_organization_id     uuid NOT NULL,
  source_warehouse_stock_id  uuid NOT NULL,
  return_request_line_id     uuid REFERENCES public.warehouse_return_request_lines(id) ON DELETE SET NULL,
  original_transfer_line_id  uuid NOT NULL REFERENCES public.warehouse_transfer_lines(id) ON DELETE RESTRICT,

  central_item_id             uuid REFERENCES public.central_items(id) ON DELETE RESTRICT,

  -- Immutable snapshots, taken at send time (061/068 precedent).
  scientific_name              text NOT NULL,
  trade_name                    text,
  concentration                  text,
  dosage_form                    text,
  unit                            text,
  national_code                   text,
  has_no_national_code            boolean NOT NULL DEFAULT false,
  batch_number                     text,
  has_no_batch_number               boolean NOT NULL DEFAULT false,
  internal_batch_reference          text,
  expiry_date                       date,
  unit_price                        numeric(20,3),
  price_basis                        text,
  currency                            text,
  supply_type_text                    text,

  sent_quantity                 integer NOT NULL,
  received_quantity              integer,
  status                          text NOT NULL DEFAULT 'in_transit',
  difference_reason                text,

  received_by                        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  received_at                         timestamptz,
  resulting_warehouse_stock_id         uuid REFERENCES public.warehouse_stock(id) ON DELETE SET NULL,

  created_at                            timestamptz NOT NULL DEFAULT now(),
  updated_at                             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT wrsl_shipment_org_fk
    FOREIGN KEY (shipment_id, source_organization_id)
    REFERENCES public.warehouse_return_shipments (id, source_organization_id) ON DELETE CASCADE,

  CONSTRAINT wrsl_stock_org_fk
    FOREIGN KEY (source_warehouse_stock_id, source_organization_id)
    REFERENCES public.warehouse_stock (id, organization_id) ON DELETE RESTRICT,

  CONSTRAINT wrsl_status_chk
    CHECK (status IN ('in_transit', 'received', 'received_with_difference', 'rejected')),

  CONSTRAINT wrsl_sci_name_chk
    CHECK (btrim(scientific_name) = scientific_name AND scientific_name <> ''),
  CONSTRAINT wrsl_sent_qty_chk      CHECK (sent_quantity > 0),
  CONSTRAINT wrsl_received_qty_chk  CHECK (received_quantity IS NULL OR received_quantity >= 0),
  CONSTRAINT wrsl_received_le_sent_chk
    CHECK (received_quantity IS NULL OR received_quantity <= sent_quantity),
  CONSTRAINT wrsl_unit_price_chk    CHECK (unit_price IS NULL OR unit_price >= 0),

  CONSTRAINT wrsl_has_no_national_code_chk
    CHECK (has_no_national_code = (national_code IS NULL)),
  CONSTRAINT wrsl_has_no_batch_number_chk
    CHECK (has_no_batch_number = (batch_number IS NULL)),

  CONSTRAINT wrsl_decision_chk
    CHECK (
      CASE status
        WHEN 'in_transit' THEN
          received_quantity IS NULL AND received_at IS NULL AND difference_reason IS NULL
        WHEN 'received' THEN
          received_quantity = sent_quantity AND received_at IS NOT NULL
        WHEN 'received_with_difference' THEN
          received_quantity IS NOT NULL AND received_quantity < sent_quantity
          AND received_at IS NOT NULL
          AND difference_reason IS NOT NULL AND btrim(difference_reason) <> ''
        WHEN 'rejected' THEN
          received_quantity = 0 AND received_at IS NOT NULL
          AND difference_reason IS NOT NULL AND btrim(difference_reason) <> ''
        ELSE false
      END
    )
);

CREATE INDEX IF NOT EXISTS wrsl_shipment_idx ON public.warehouse_return_shipment_lines (shipment_id);
CREATE INDEX IF NOT EXISTS wrsl_stock_idx    ON public.warehouse_return_shipment_lines (source_warehouse_stock_id);
CREATE INDEX IF NOT EXISTS wrsl_reqline_idx  ON public.warehouse_return_shipment_lines (return_request_line_id);
CREATE INDEX IF NOT EXISTS wrsl_original_idx ON public.warehouse_return_shipment_lines (original_transfer_line_id);
CREATE INDEX IF NOT EXISTS wrsl_in_transit_idx
  ON public.warehouse_return_shipment_lines (shipment_id) WHERE status = 'in_transit';

COMMENT ON TABLE public.warehouse_return_shipment_lines IS
  'INSTITUTION-TO-CENTRAL-RETURN-069-A: one returned batch per line, '
  'snapshotted at send. Deliberately has NO expiry-refusal check at send — '
  'unlike 068''s forward SEND, a return is frequently OF an expired batch.';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.warehouse_return_shipment_lines
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 6. Idempotency for return movements — reusing 065/068's ledger contract
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_stock_movements_return_once_uniq
  ON public.warehouse_stock_movements (reference_id)
  WHERE reference_type IN ('warehouse_return_send', 'warehouse_return_receive')
    AND reference_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE public.warehouse_stock_movements
    ADD CONSTRAINT warehouse_stock_movements_return_fingerprint_chk
    CHECK (
      reference_type IS NULL
      OR reference_type NOT IN ('warehouse_return_send', 'warehouse_return_receive')
      OR (request_fingerprint IS NOT NULL AND request_fingerprint ~ '^[0-9a-f]{64}$')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS warehouse_stock_movements_return_line_once_uniq
  ON public.warehouse_stock_movements (reference_id)
  WHERE reference_type = 'warehouse_return_shipment_line' AND reference_id IS NOT NULL;

-- ============================================================================
-- 7. Permission keys
-- ============================================================================
INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous) VALUES
  ('warehouse_transfer.return_request', 'warehouse_transfer', 'return_request', 'Request a return to central',      'طلب إرجاع إلى المركزي',      false),
  ('warehouse_transfer.recall',         'warehouse_transfer', 'recall',         'Recall stock from an institution',  'استدعاء مخزون من مؤسسة',     false),
  ('warehouse_transfer.review_return',  'warehouse_transfer', 'review_return',  'Review a return request',           'مراجعة طلب إرجاع',           false),
  ('warehouse_transfer.return_send',    'warehouse_transfer', 'return_send',    'Send a return to central',          'إرسال إرجاع إلى المركزي',    false),
  ('warehouse_transfer.return_receive', 'warehouse_transfer', 'return_receive', 'Receive a return at central',       'استلام إرجاع في المركزي',    false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
SELECT 'super_admin', k.key, true
FROM public.permission_keys k
WHERE k.key LIKE 'warehouse_transfer.%'
ON CONFLICT (role, permission_key) DO NOTHING;

-- Separation of duty, extended: the institution side may ask for and execute
-- a return (never recall/review/receive it); the central side may recall,
-- review and receive a return (never request or execute the physical send of
-- its own recall) — mirrors 068's send/receive split exactly.
INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  ('central_warehouse_manager', 'warehouse_transfer.return_request', false),
  ('central_warehouse_manager', 'warehouse_transfer.recall',         true),
  ('central_warehouse_manager', 'warehouse_transfer.review_return',  true),
  ('central_warehouse_manager', 'warehouse_transfer.return_send',    false),
  ('central_warehouse_manager', 'warehouse_transfer.return_receive', true),
  ('warehouse_officer',         'warehouse_transfer.return_request', true),
  ('warehouse_officer',         'warehouse_transfer.recall',         false),
  ('warehouse_officer',         'warehouse_transfer.review_return',  false),
  ('warehouse_officer',         'warehouse_transfer.return_send',    true),
  ('warehouse_officer',         'warehouse_transfer.return_receive', false),
  ('outlet_officer',            'warehouse_transfer.return_request', false),
  ('outlet_officer',            'warehouse_transfer.recall',         false),
  ('outlet_officer',            'warehouse_transfer.review_return',  false),
  ('outlet_officer',            'warehouse_transfer.return_send',    false),
  ('outlet_officer',            'warehouse_transfer.return_receive', false)
ON CONFLICT (role, permission_key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
SELECT r.role, k.key, false
FROM (VALUES ('institution_admin'),('port_officer'),('monthly_status_officer'),('viewer'),
             ('hospital_admin'),('warehouse_manager'),('point_operator'),('transfer_manager')) AS r(role)
CROSS JOIN (VALUES ('warehouse_transfer.return_request'),('warehouse_transfer.recall'),
                   ('warehouse_transfer.review_return'),('warehouse_transfer.return_send'),
                   ('warehouse_transfer.return_receive')) AS k(key)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ============================================================================
-- 8. RETURN REQUEST LIFECYCLE — either side asks, central always reviews
-- ============================================================================
-- Contract mirrors 068 section 8: advisory lock first, row lock second,
-- phoenix_profile_has_scoped_permission gate (never a role literal), audit
-- written for every transition. None of these RPCs moves stock, so none
-- writes warehouse_stock_movements; each is idempotency-safe by construction
-- (one-way status flip under a row lock plus an explicit precondition).

-- 8a. REQUEST (receiver-initiated) — the institution asks to send stock back.
CREATE OR REPLACE FUNCTION public.phoenix_request_warehouse_return(
  p_route_id             uuid,
  p_source_warehouse_id  uuid,
  p_return_number        text,
  p_notes                text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_route       public.warehouse_supply_routes%ROWTYPE;
  v_src_org     uuid;
  v_dest_org    uuid;
  v_number      text := NULLIF(btrim(p_return_number), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_request     public.warehouse_return_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_route_id IS NULL OR p_source_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'route_and_source_required' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'return_number_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_source_warehouse_id::text, 69069));

  SELECT * INTO v_route
  FROM public.warehouse_supply_routes WHERE id = p_route_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'supply_route_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_route.is_active THEN
    RAISE EXCEPTION 'supply_route_inactive' USING ERRCODE = '23514';
  END IF;

  -- The institution is the route's TARGET — a caller cannot open a return
  -- against a warehouse the route does not actually connect it to.
  IF p_source_warehouse_id IS DISTINCT FROM v_route.target_warehouse_id THEN
    RAISE EXCEPTION 'source_not_route_target' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO v_src_org
  FROM public.warehouses WHERE id = p_source_warehouse_id AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_warehouse_not_found_or_inactive' USING ERRCODE = 'P0002';
  END IF;

  SELECT organization_id INTO v_dest_org
  FROM public.warehouses WHERE id = v_route.source_warehouse_id AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'destination_warehouse_not_found_or_inactive' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.return_request', v_src_org, p_source_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_return_request' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.warehouse_return_requests (
    route_id, source_warehouse_id, source_organization_id,
    destination_warehouse_id, destination_organization_id,
    return_number, status, requested_by_side, notes, created_by
  ) VALUES (
    p_route_id, p_source_warehouse_id, v_src_org,
    v_route.source_warehouse_id, v_dest_org,
    v_number, 'draft', 'receiver', v_notes, v_actor
  )
  RETURNING * INTO v_request;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_src_org, v_actor, v_actor_role,
    'warehouse_transfer.return_requested', 'warehouse_return_requests', v_request.id, v_number,
    jsonb_build_object('route_id', p_route_id, 'source_warehouse_id', p_source_warehouse_id)
  );

  RETURN jsonb_build_object('ok', true, 'return_request_id', v_request.id, 'status', v_request.status);
END;
$$;

-- 8b. RECALL (sender-initiated) — central asks the institution to send stock
-- back. Same row, same lifecycle — only requested_by_side and the permission
-- gate differ from REQUEST.
CREATE OR REPLACE FUNCTION public.phoenix_recall_warehouse_transfer(
  p_route_id             uuid,
  p_source_warehouse_id  uuid,
  p_return_number        text,
  p_notes                text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_route       public.warehouse_supply_routes%ROWTYPE;
  v_src_org     uuid;
  v_dest_org    uuid;
  v_number      text := NULLIF(btrim(p_return_number), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_request     public.warehouse_return_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_route_id IS NULL OR p_source_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'route_and_source_required' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'return_number_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_source_warehouse_id::text, 69069));

  SELECT * INTO v_route
  FROM public.warehouse_supply_routes WHERE id = p_route_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'supply_route_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_route.is_active THEN
    RAISE EXCEPTION 'supply_route_inactive' USING ERRCODE = '23514';
  END IF;

  IF p_source_warehouse_id IS DISTINCT FROM v_route.target_warehouse_id THEN
    RAISE EXCEPTION 'source_not_route_target' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO v_src_org
  FROM public.warehouses WHERE id = p_source_warehouse_id AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_warehouse_not_found_or_inactive' USING ERRCODE = 'P0002';
  END IF;

  -- THE IDOR GATE. Central's authority is scoped to the DESTINATION
  -- (its own) warehouse, resolved from the route — a recall is central
  -- exercising authority over ITS OWN warehouse's incoming returns, never
  -- over the institution's.
  SELECT organization_id INTO v_dest_org
  FROM public.warehouses WHERE id = v_route.source_warehouse_id AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'destination_warehouse_not_found_or_inactive' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.recall', v_dest_org, v_route.source_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_recall' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.warehouse_return_requests (
    route_id, source_warehouse_id, source_organization_id,
    destination_warehouse_id, destination_organization_id,
    return_number, status, requested_by_side, notes, created_by
  ) VALUES (
    p_route_id, p_source_warehouse_id, v_src_org,
    v_route.source_warehouse_id, v_dest_org,
    v_number, 'draft', 'sender', v_notes, v_actor
  )
  RETURNING * INTO v_request;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_dest_org, v_actor, v_actor_role,
    'warehouse_transfer.recall_requested', 'warehouse_return_requests', v_request.id, v_number,
    jsonb_build_object('route_id', p_route_id, 'source_warehouse_id', p_source_warehouse_id)
  );

  RETURN jsonb_build_object('ok', true, 'return_request_id', v_request.id, 'status', v_request.status);
END;
$$;

-- 8c. ADD LINE — while the request is still a draft. Names an EXACT prior
-- receipt, bounded by what THAT line has left to return.
CREATE OR REPLACE FUNCTION public.phoenix_add_warehouse_return_request_line(
  p_return_request_id         uuid,
  p_original_transfer_line_id uuid,
  p_requested_quantity        integer,
  p_reason_code                text,
  p_reason_text                 text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor    uuid := auth.uid();
  v_request  public.warehouse_return_requests%ROWTYPE;
  v_orig     public.warehouse_transfer_lines%ROWTYPE;
  v_remaining integer;
  v_line_id  uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_return_request_id IS NULL OR p_original_transfer_line_id IS NULL THEN
    RAISE EXCEPTION 'request_and_original_line_required' USING ERRCODE = '23514';
  END IF;
  IF p_requested_quantity IS NULL OR p_requested_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF p_reason_code IS NULL THEN
    RAISE EXCEPTION 'reason_code_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_request
  FROM public.warehouse_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.return_request',
    v_request.source_organization_id, v_request.source_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_return_request' USING ERRCODE = '42501';
  END IF;

  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'return_request_not_draft' USING ERRCODE = '23514';
  END IF;

  -- Lock the original receipt while we read its remaining returnable
  -- quantity, so a concurrent add-line against the SAME original line cannot
  -- both pass the same remaining-quantity check.
  SELECT * INTO v_orig
  FROM public.warehouse_transfer_lines WHERE id = p_original_transfer_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original_transfer_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- The batch must actually have been received AT THIS institution — an
  -- IDOR-prevention pattern identical to 068's stock/route-source check.
  IF v_orig.resulting_warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'original_line_not_received' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.warehouse_stock s
    WHERE s.id = v_orig.resulting_warehouse_stock_id
      AND s.organization_id = v_request.source_organization_id
  ) THEN
    RAISE EXCEPTION 'original_line_not_at_this_institution' USING ERRCODE = '42501';
  END IF;

  v_remaining := COALESCE(v_orig.received_quantity, 0) - v_orig.returned_quantity;
  IF p_requested_quantity > v_remaining THEN
    RAISE EXCEPTION 'requested_quantity_exceeds_returnable' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.warehouse_return_request_lines (
    return_request_id, source_organization_id, original_transfer_line_id,
    scientific_name, concentration, dosage_form, unit,
    national_code, batch_number, internal_batch_reference, expiry_date,
    reason_code, reason_text, requested_quantity
  ) VALUES (
    v_request.id, v_request.source_organization_id, v_orig.id,
    v_orig.scientific_name, v_orig.concentration, v_orig.dosage_form, v_orig.unit,
    v_orig.national_code, v_orig.batch_number, v_orig.internal_batch_reference, v_orig.expiry_date,
    p_reason_code, NULLIF(btrim(p_reason_text), ''), p_requested_quantity
  )
  RETURNING id INTO v_line_id;

  RETURN jsonb_build_object('ok', true, 'return_request_line_id', v_line_id);
END;
$$;

-- 8d. DELETE LINE — draft-only; a real delete, mirrors 068's line CRUD.
CREATE OR REPLACE FUNCTION public.phoenix_delete_warehouse_return_request_line(
  p_return_request_line_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_line    public.warehouse_return_request_lines%ROWTYPE;
  v_request public.warehouse_return_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_return_request_line_id IS NULL THEN
    RAISE EXCEPTION 'return_request_line_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_line
  FROM public.warehouse_return_request_lines WHERE id = p_return_request_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_request
  FROM public.warehouse_return_requests WHERE id = v_line.return_request_id FOR UPDATE;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.return_request',
    v_request.source_organization_id, v_request.source_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_return_request' USING ERRCODE = '42501';
  END IF;

  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'return_request_not_draft' USING ERRCODE = '23514';
  END IF;

  DELETE FROM public.warehouse_return_request_lines WHERE id = v_line.id;

  RETURN jsonb_build_object('ok', true, 'deleted', true, 'return_request_line_id', v_line.id);
END;
$$;

-- 8e. SUBMIT — draft -> submitted. Only whoever OPENED it may submit it,
-- regardless of side, mirroring 068's submit permission (scoped to the
-- creator's own side). Requires an ACTIVE route, checked again NOW.
CREATE OR REPLACE FUNCTION public.phoenix_submit_warehouse_return_request(
  p_return_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_request    public.warehouse_return_requests%ROWTYPE;
  v_route      public.warehouse_supply_routes%ROWTYPE;
  v_line_count integer;
  v_permission_key text;
  v_org        uuid;
  v_warehouse  uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_return_request_id IS NULL THEN
    RAISE EXCEPTION 'return_request_id_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_return_request_id::text, 69069));

  SELECT * INTO v_request
  FROM public.warehouse_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Only the side that opened it may submit it: 'receiver' submits with the
  -- .return_request key scoped to its own (source/institution) warehouse;
  -- 'sender' submits with .recall scoped to its own (destination/central)
  -- warehouse.
  IF v_request.requested_by_side = 'receiver' THEN
    v_permission_key := 'warehouse_transfer.return_request';
    v_org := v_request.source_organization_id;
    v_warehouse := v_request.source_warehouse_id;
  ELSE
    v_permission_key := 'warehouse_transfer.recall';
    v_org := v_request.destination_organization_id;
    v_warehouse := v_request.destination_warehouse_id;
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(v_actor, v_permission_key, v_org, v_warehouse, NULL) THEN
    RAISE EXCEPTION 'forbidden_warehouse_return_submit' USING ERRCODE = '42501';
  END IF;

  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'return_request_not_draft' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_route
  FROM public.warehouse_supply_routes WHERE id = v_request.route_id FOR SHARE;
  IF NOT FOUND OR NOT v_route.is_active THEN
    RAISE EXCEPTION 'supply_route_inactive' USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO v_line_count
  FROM public.warehouse_return_request_lines WHERE return_request_id = v_request.id;
  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'return_request_has_no_lines' USING ERRCODE = '23514';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  UPDATE public.warehouse_return_requests
     SET status = 'submitted', requested_by = v_actor, requested_at = now()
   WHERE id = v_request.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_org, v_actor, v_actor_role,
    'warehouse_transfer.return_submitted', 'warehouse_return_requests', v_request.id,
    v_request.return_number, jsonb_build_object('line_count', v_line_count)
  );

  RETURN jsonb_build_object('ok', true, 'return_request_id', v_request.id, 'status', 'submitted');
END;
$$;

-- 8f. CANCEL — only the side that opened it may cancel it, before it has
-- been reviewed or sent (symmetric with 068's cancel window).
CREATE OR REPLACE FUNCTION public.phoenix_cancel_warehouse_return_request(
  p_return_request_id     uuid,
  p_cancellation_reason    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_request    public.warehouse_return_requests%ROWTYPE;
  v_reason     text := NULLIF(btrim(p_cancellation_reason), '');
  v_permission_key text;
  v_org        uuid;
  v_warehouse  uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_return_request_id IS NULL THEN
    RAISE EXCEPTION 'return_request_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'cancellation_reason_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_return_request_id::text, 69069));

  SELECT * INTO v_request
  FROM public.warehouse_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_request.requested_by_side = 'receiver' THEN
    v_permission_key := 'warehouse_transfer.return_request';
    v_org := v_request.source_organization_id;
    v_warehouse := v_request.source_warehouse_id;
  ELSE
    v_permission_key := 'warehouse_transfer.recall';
    v_org := v_request.destination_organization_id;
    v_warehouse := v_request.destination_warehouse_id;
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(v_actor, v_permission_key, v_org, v_warehouse, NULL) THEN
    RAISE EXCEPTION 'forbidden_warehouse_return_cancel' USING ERRCODE = '42501';
  END IF;

  IF v_request.status NOT IN ('draft', 'submitted') THEN
    RAISE EXCEPTION 'return_request_not_cancellable' USING ERRCODE = '23514';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  UPDATE public.warehouse_return_requests
     SET status = 'cancelled', cancelled_by = v_actor, cancelled_at = now(),
         cancellation_reason = v_reason
   WHERE id = v_request.id;

  UPDATE public.warehouse_return_request_lines
     SET status = 'cancelled'
   WHERE return_request_id = v_request.id AND status = 'pending';

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_org, v_actor, v_actor_role,
    'warehouse_transfer.return_cancelled', 'warehouse_return_requests', v_request.id,
    v_request.return_number,
    jsonb_build_object('reason', v_reason, 'previous_status', v_request.status)
  );

  RETURN jsonb_build_object('ok', true, 'return_request_id', v_request.id, 'status', 'cancelled');
END;
$$;

-- 8g. REVIEW — ALWAYS central, regardless of who opened the request. Central
-- is the side whose warehouse_stock will increase and must decide capacity/
-- acceptance either way.
CREATE OR REPLACE FUNCTION public.phoenix_review_warehouse_return_request(
  p_return_request_id uuid,
  p_decisions          jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor          uuid := auth.uid();
  v_actor_role     text;
  v_request        public.warehouse_return_requests%ROWTYPE;
  v_decision       jsonb;
  v_line_id        uuid;
  v_approved_qty   integer;
  v_line           public.warehouse_return_request_lines%ROWTYPE;
  v_pending_ids    uuid[];
  v_decided_ids    uuid[] := ARRAY[]::uuid[];
  v_approved_count integer := 0;
  v_rejected_count integer := 0;
  v_full_count     integer := 0;
  v_header_status  text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_return_request_id IS NULL THEN
    RAISE EXCEPTION 'return_request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_decisions IS NULL OR jsonb_typeof(p_decisions) <> 'array' OR jsonb_array_length(p_decisions) = 0 THEN
    RAISE EXCEPTION 'decisions_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_return_request_id::text, 69069));

  SELECT * INTO v_request
  FROM public.warehouse_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- THE IDOR GATE: authority is scoped to the DESTINATION (central)
  -- warehouse — the requester (whichever side) can never approve itself.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.review_return',
    v_request.destination_organization_id, v_request.destination_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_review_return' USING ERRCODE = '42501';
  END IF;

  IF v_request.status <> 'submitted' THEN
    RAISE EXCEPTION 'return_request_not_submitted' USING ERRCODE = '23514';
  END IF;

  SELECT array_agg(id) INTO v_pending_ids
  FROM (
    SELECT id FROM public.warehouse_return_request_lines
    WHERE return_request_id = v_request.id AND status = 'pending'
    FOR UPDATE
  ) locked_lines;

  IF v_pending_ids IS NULL THEN
    RAISE EXCEPTION 'return_request_has_no_pending_lines' USING ERRCODE = '23514';
  END IF;

  FOR v_decision IN SELECT * FROM jsonb_array_elements(p_decisions)
  LOOP
    v_line_id      := NULLIF(v_decision->>'line_id', '')::uuid;
    v_approved_qty := NULLIF(v_decision->>'approved_quantity', '')::integer;

    IF v_line_id IS NULL OR v_approved_qty IS NULL OR v_approved_qty < 0 THEN
      RAISE EXCEPTION 'invalid_review_decision' USING ERRCODE = '23514';
    END IF;
    IF NOT (v_line_id = ANY (v_pending_ids)) THEN
      RAISE EXCEPTION 'decision_line_not_pending_for_request' USING ERRCODE = 'P0002';
    END IF;
    IF v_line_id = ANY (v_decided_ids) THEN
      RAISE EXCEPTION 'duplicate_decision_for_line' USING ERRCODE = '23505';
    END IF;

    SELECT * INTO v_line FROM public.warehouse_return_request_lines WHERE id = v_line_id;
    IF v_approved_qty > v_line.requested_quantity THEN
      RAISE EXCEPTION 'approved_quantity_exceeds_requested' USING ERRCODE = '23514';
    END IF;

    UPDATE public.warehouse_return_request_lines
       SET approved_quantity = v_approved_qty,
           status = CASE WHEN v_approved_qty = 0 THEN 'rejected' ELSE 'approved' END
     WHERE id = v_line_id;

    v_decided_ids := array_append(v_decided_ids, v_line_id);
    IF v_approved_qty = 0 THEN
      v_rejected_count := v_rejected_count + 1;
    ELSE
      v_approved_count := v_approved_count + 1;
      IF v_approved_qty = v_line.requested_quantity THEN
        v_full_count := v_full_count + 1;
      END IF;
    END IF;
  END LOOP;

  IF array_length(v_decided_ids, 1) IS DISTINCT FROM array_length(v_pending_ids, 1) THEN
    RAISE EXCEPTION 'all_pending_lines_must_be_decided' USING ERRCODE = '23514';
  END IF;

  v_header_status := CASE
    WHEN v_approved_count = 0 THEN 'rejected'
    WHEN v_rejected_count = 0 AND v_full_count = v_approved_count THEN 'approved'
    ELSE 'partially_approved'
  END;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  UPDATE public.warehouse_return_requests
     SET status = v_header_status, reviewed_by = v_actor, reviewed_at = now()
   WHERE id = v_request.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_request.destination_organization_id, v_actor, v_actor_role,
    'warehouse_transfer.return_reviewed', 'warehouse_return_requests', v_request.id,
    v_request.return_number, jsonb_build_object('decisions', p_decisions, 'result_status', v_header_status)
  );

  RETURN jsonb_build_object('ok', true, 'return_request_id', v_request.id, 'status', v_header_status);
END;
$$;

-- ============================================================================
-- 9. RETURN-SEND — stock leaves the institution warehouse
-- ============================================================================
-- Contract mirrors 068's SEND EXCEPT: no expiry-refusal (see header note),
-- and the request-line cap is against approved_quantity of a RETURN line
-- (already the same shape as 068's fulfilled_quantity gate).

CREATE OR REPLACE FUNCTION public.phoenix_send_warehouse_return_shipment_line(
  p_request_id              uuid,
  p_route_id                uuid,
  p_return_request_line_id  uuid,
  p_quantity                integer,
  p_shipment_number         text,
  p_document_number         text DEFAULT NULL,
  p_notes                   text DEFAULT NULL
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
  v_route        public.warehouse_supply_routes%ROWTYPE;
  v_reqline      public.warehouse_return_request_lines%ROWTYPE;
  v_request      public.warehouse_return_requests%ROWTYPE;
  v_orig         public.warehouse_transfer_lines%ROWTYPE;
  v_stock        public.warehouse_stock%ROWTYPE;
  v_shipment     public.warehouse_return_shipments%ROWTYPE;
  v_existing     public.warehouse_stock_movements%ROWTYPE;
  v_number       text := NULLIF(btrim(p_shipment_number), '');
  v_doc          text := NULLIF(btrim(p_document_number), '');
  v_notes        text := NULLIF(btrim(p_notes), '');
  v_before       integer;
  v_after        integer;
  v_line_id      uuid;
  v_movement_id  uuid;
  v_fingerprint  text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_route_id IS NULL OR p_return_request_line_id IS NULL THEN
    RAISE EXCEPTION 'route_and_line_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'shipment_number_required' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'return_send',
    'route_id', p_route_id,
    'return_request_line_id', p_return_request_line_id,
    'quantity', p_quantity,
    'shipment_number', v_number,
    'document_number', v_doc,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 69069));

  SELECT * INTO v_existing
  FROM public.warehouse_stock_movements m
  WHERE m.reference_type = 'warehouse_return_send' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'warehouse_stock_id', v_existing.warehouse_stock_id,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  SELECT * INTO v_route
  FROM public.warehouse_supply_routes WHERE id = p_route_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'supply_route_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_route.is_active THEN
    RAISE EXCEPTION 'supply_route_inactive' USING ERRCODE = '23514';
  END IF;

  SELECT l.* INTO v_reqline
  FROM public.warehouse_return_request_lines l
  JOIN public.warehouse_return_requests r ON r.id = l.return_request_id
  WHERE l.id = p_return_request_line_id AND r.route_id = p_route_id
  FOR UPDATE OF l;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_line_not_found_for_route' USING ERRCODE = 'P0002';
  END IF;
  IF v_reqline.status NOT IN ('approved', 'partially_fulfilled') THEN
    RAISE EXCEPTION 'return_request_line_not_approved' USING ERRCODE = '23514';
  END IF;
  IF v_reqline.fulfilled_quantity + p_quantity > v_reqline.approved_quantity THEN
    RAISE EXCEPTION 'return_line_would_be_over_fulfilled' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_request
  FROM public.warehouse_return_requests WHERE id = v_reqline.return_request_id FOR UPDATE;

  SELECT * INTO v_orig
  FROM public.warehouse_transfer_lines WHERE id = v_reqline.original_transfer_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original_transfer_line_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_orig.returned_quantity + p_quantity > COALESCE(v_orig.received_quantity, 0) THEN
    RAISE EXCEPTION 'original_line_would_be_over_returned' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_stock
  FROM public.warehouse_stock WHERE id = v_orig.resulting_warehouse_stock_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- The stock must actually sit in the route's TARGET warehouse (the
  -- institution) — the same IDOR-prevention pattern as 068's forward SEND,
  -- reversed.
  IF v_stock.warehouse_id IS DISTINCT FROM v_route.target_warehouse_id THEN
    RAISE EXCEPTION 'stock_not_in_route_target_warehouse' USING ERRCODE = '42501';
  END IF;
  IF v_stock.organization_id IS DISTINCT FROM v_reqline.source_organization_id THEN
    RAISE EXCEPTION 'stock_organization_mismatch' USING ERRCODE = '42501';
  END IF;

  -- THE IDOR GATE. Authority is the actor's scoped assignment to the SOURCE
  -- (institution) warehouse — never a role literal, never the caller's claim.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.return_send', v_stock.organization_id, v_stock.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_return_send' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- Deliberately NO expiry-refusal here — see the file header. A return is
  -- frequently OF an expired batch, going back to the party equipped to
  -- dispose of or credit it.

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before - p_quantity;

  IF v_after < 0 THEN
    RAISE EXCEPTION 'warehouse_quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;
  IF v_after < v_stock.reserved_quantity THEN
    RAISE EXCEPTION 'warehouse_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_shipment
  FROM public.warehouse_return_shipments
  WHERE source_organization_id = v_stock.organization_id
    AND btrim(shipment_number) = v_number
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.warehouse_return_shipments (
      route_id, return_request_id,
      source_warehouse_id, source_organization_id,
      destination_warehouse_id, destination_organization_id,
      shipment_number, status, document_number, notes, sent_by, sent_at
    ) VALUES (
      p_route_id, v_reqline.return_request_id,
      v_route.target_warehouse_id, v_stock.organization_id,
      v_route.source_warehouse_id, v_request.destination_organization_id,
      v_number, 'in_transit', v_doc, v_notes, v_actor, now()
    )
    RETURNING * INTO v_shipment;
  ELSE
    IF v_shipment.route_id IS DISTINCT FROM p_route_id THEN
      RAISE EXCEPTION 'shipment_number_route_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_shipment.status <> 'in_transit' THEN
      RAISE EXCEPTION 'shipment_already_being_received' USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.warehouse_return_request_lines
     SET fulfilled_quantity = fulfilled_quantity + p_quantity,
         status = CASE WHEN fulfilled_quantity + p_quantity >= approved_quantity
                       THEN 'fulfilled' ELSE 'partially_fulfilled' END
   WHERE id = v_reqline.id;

  UPDATE public.warehouse_return_requests
     SET status = CASE WHEN NOT EXISTS (
                         SELECT 1 FROM public.warehouse_return_request_lines x
                         WHERE x.return_request_id = v_reqline.return_request_id
                           AND x.status NOT IN ('fulfilled', 'rejected', 'cancelled'))
                       THEN 'fulfilled' ELSE 'partially_fulfilled' END
   WHERE id = v_reqline.return_request_id;

  UPDATE public.warehouse_transfer_lines
     SET returned_quantity = returned_quantity + p_quantity
   WHERE id = v_orig.id;

  UPDATE public.warehouse_stock
     SET on_hand_quantity = v_after,
         updated_by       = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.warehouse_return_shipment_lines (
    shipment_id, source_organization_id, source_warehouse_stock_id,
    return_request_line_id, original_transfer_line_id, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code,
    batch_number, has_no_batch_number, internal_batch_reference,
    expiry_date, unit_price, price_basis, currency, supply_type_text,
    sent_quantity, status
  ) VALUES (
    v_shipment.id, v_stock.organization_id, v_stock.id,
    v_reqline.id, v_orig.id, v_stock.central_item_id,
    v_stock.scientific_name, v_stock.trade_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.unit,
    v_stock.national_code, v_stock.has_no_national_code,
    v_stock.batch_number, v_stock.has_no_batch_number, v_stock.internal_batch_reference,
    v_stock.expiry_date, v_stock.unit_price, v_stock.price_basis,
    v_stock.currency, v_stock.supply_type_text,
    p_quantity, 'in_transit'
  )
  RETURNING id INTO v_line_id;

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id, movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.warehouse_id, 'dispatch_return',
    v_before, -p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'warehouse_transfer_return', 'warehouse_return_send', p_request_id, v_fingerprint,
    v_doc, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference
  )
  RETURNING id INTO v_movement_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_stock.organization_id, v_actor, v_actor_role,
    'warehouse_transfer.return_send', 'warehouse_return_shipment_lines', v_line_id,
    v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'route_id', p_route_id,
      'shipment_id', v_shipment.id,
      'source_warehouse_id', v_route.target_warehouse_id,
      'destination_warehouse_id', v_route.source_warehouse_id,
      'movement_id', v_movement_id,
      'quantity_before', v_before,
      'quantity_delta', -p_quantity,
      'quantity_after', v_after
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'shipment_id', v_shipment.id,
    'shipment_line_id', v_line_id,
    'warehouse_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'in_transit_quantity', p_quantity,
    'quantity_before', v_before,
    'quantity_delta', -p_quantity,
    'quantity_after', v_after
  );
END;
$$;

-- ============================================================================
-- 10. RETURN-RECEIVE — stock enters the central warehouse
-- ============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_receive_warehouse_return_shipment_line(
  p_request_id         uuid,
  p_shipment_line_id   uuid,
  p_received_quantity  integer,
  p_difference_reason  text DEFAULT NULL,
  p_notes              text DEFAULT NULL
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
  v_line        public.warehouse_return_shipment_lines%ROWTYPE;
  v_shipment    public.warehouse_return_shipments%ROWTYPE;
  v_stock       public.warehouse_stock%ROWTYPE;
  v_existing    public.warehouse_stock_movements%ROWTYPE;
  v_reason      text := NULLIF(btrim(p_difference_reason), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_internal    text;
  v_before      integer;
  v_after       integer;
  v_movement_id uuid;
  v_status      text;
  v_fingerprint text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_shipment_line_id IS NULL THEN
    RAISE EXCEPTION 'request_id_and_line_required' USING ERRCODE = '23514';
  END IF;
  IF p_received_quantity IS NULL OR p_received_quantity < 0 THEN
    RAISE EXCEPTION 'received_quantity_must_be_non_negative' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'return_receive',
    'shipment_line_id', p_shipment_line_id,
    'received_quantity', p_received_quantity,
    'difference_reason', v_reason,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 69069));

  SELECT * INTO v_existing
  FROM public.warehouse_stock_movements m
  WHERE m.reference_type = 'warehouse_return_receive' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'warehouse_stock_id', v_existing.warehouse_stock_id,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  SELECT * INTO v_line
  FROM public.warehouse_return_shipment_lines WHERE id = p_shipment_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_shipment_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF v_line.status <> 'in_transit' THEN
    RAISE EXCEPTION 'return_shipment_line_already_received' USING ERRCODE = '23505';
  END IF;
  IF p_received_quantity > v_line.sent_quantity THEN
    RAISE EXCEPTION 'received_quantity_exceeds_sent' USING ERRCODE = '23514';
  END IF;
  IF p_received_quantity <> v_line.sent_quantity AND v_reason IS NULL THEN
    RAISE EXCEPTION 'difference_reason_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_shipment
  FROM public.warehouse_return_shipments WHERE id = v_line.shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_shipment_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- THE IDOR GATE: authority is scoped to the DESTINATION (central)
  -- warehouse, taken from the shipment, never from the caller. No route/
  -- is_active check here — receiving stock already on a truck must not
  -- depend on the route's CURRENT state, same rule as 068's forward RECEIVE.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.return_receive', v_shipment.destination_organization_id,
    v_shipment.destination_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_return_receive' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  v_status := CASE
    WHEN p_received_quantity = 0 THEN 'rejected'
    WHEN p_received_quantity = v_line.sent_quantity THEN 'received'
    ELSE 'received_with_difference'
  END;

  IF p_received_quantity = 0 THEN
    UPDATE public.warehouse_return_shipment_lines
       SET status = 'rejected', received_quantity = 0,
           difference_reason = v_reason, received_by = v_actor, received_at = now()
     WHERE id = v_line.id;

    UPDATE public.warehouse_return_shipments
       SET status = CASE WHEN NOT EXISTS (
                           SELECT 1 FROM public.warehouse_return_shipment_lines x
                           WHERE x.shipment_id = v_shipment.id AND x.status = 'in_transit')
                         THEN 'received' ELSE 'partially_received' END
     WHERE id = v_shipment.id;

    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role,
      action, entity_type, entity_id, entity_label, payload
    ) VALUES (
      v_shipment.destination_organization_id, v_actor, v_actor_role,
      'warehouse_transfer.return_rejected', 'warehouse_return_shipment_lines', v_line.id,
      v_line.scientific_name,
      jsonb_build_object(
        'request_id', p_request_id, 'shipment_id', v_shipment.id,
        'sent_quantity', v_line.sent_quantity, 'received_quantity', 0,
        'reason', v_reason
      )
    );

    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', false, 'line_status', 'rejected',
      'warehouse_stock_id', NULL, 'movement_id', NULL,
      'quantity_before', 0, 'quantity_delta', 0, 'quantity_after', 0
    );
  END IF;

  v_internal := v_line.internal_batch_reference;

  INSERT INTO public.warehouse_stock (
    organization_id, warehouse_id, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code,
    batch_number, has_no_batch_number, internal_batch_reference,
    expiry_date, on_hand_quantity, reserved_quantity,
    unit_price, price_basis, currency, supply_type_text,
    source_document_number, notes, created_by, updated_by
  ) VALUES (
    v_shipment.destination_organization_id, v_shipment.destination_warehouse_id,
    v_line.central_item_id,
    v_line.scientific_name, v_line.trade_name, v_line.concentration,
    v_line.dosage_form, v_line.unit,
    v_line.national_code, v_line.has_no_national_code,
    v_line.batch_number, v_line.has_no_batch_number, v_internal,
    v_line.expiry_date, 0, 0,
    v_line.unit_price, v_line.price_basis, v_line.currency, v_line.supply_type_text,
    v_shipment.document_number, v_notes, v_actor, v_actor
  )
  ON CONFLICT DO NOTHING;

  SELECT * INTO v_stock
  FROM public.warehouse_stock s
  WHERE s.warehouse_id = v_shipment.destination_warehouse_id
    AND s.scientific_name = v_line.scientific_name
    AND COALESCE(s.concentration, '') = COALESCE(v_line.concentration, '')
    AND COALESCE(s.dosage_form, '')   = COALESCE(v_line.dosage_form, '')
    AND COALESCE(s.national_code, '') = COALESCE(v_line.national_code, '')
    AND COALESCE(s.batch_number, '')  = COALESCE(v_line.batch_number, '')
    AND COALESCE(s.expiry_date, DATE '0001-01-01')
        = COALESCE(v_line.expiry_date, DATE '0001-01-01')
    AND COALESCE(s.internal_batch_reference, '') = COALESCE(v_internal, '')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'destination_stock_identity_resolution_failed' USING ERRCODE = 'P0002';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before + p_received_quantity;

  UPDATE public.warehouse_stock
     SET on_hand_quantity = v_after,
         central_item_id  = COALESCE(v_stock.central_item_id, v_line.central_item_id),
         updated_by       = v_actor
   WHERE id = v_stock.id;

  UPDATE public.warehouse_return_shipment_lines
     SET status = v_status,
         received_quantity = p_received_quantity,
         difference_reason = v_reason,
         received_by = v_actor,
         received_at = now(),
         resulting_warehouse_stock_id = v_stock.id
   WHERE id = v_line.id;

  UPDATE public.warehouse_return_shipments
     SET status = CASE WHEN NOT EXISTS (
                         SELECT 1 FROM public.warehouse_return_shipment_lines x
                         WHERE x.shipment_id = v_shipment.id AND x.status = 'in_transit')
                       THEN 'received' ELSE 'partially_received' END
   WHERE id = v_shipment.id;

  INSERT INTO public.warehouse_stock_movements (
    warehouse_stock_id, organization_id, warehouse_id, movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot,
    dosage_form_snapshot, batch_number_snapshot,
    internal_batch_reference_snapshot
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.warehouse_id, 'add',
    v_before, p_received_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'warehouse_transfer_return', 'warehouse_return_receive', p_request_id, v_fingerprint,
    v_shipment.document_number, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference
  )
  RETURNING id INTO v_movement_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_shipment.destination_organization_id, v_actor, v_actor_role,
    'warehouse_transfer.return_receive', 'warehouse_stock', v_stock.id,
    v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'shipment_id', v_shipment.id,
      'shipment_line_id', v_line.id,
      'movement_id', v_movement_id,
      'line_status', v_status,
      'sent_quantity', v_line.sent_quantity,
      'quantity_before', v_before,
      'quantity_delta', p_received_quantity,
      'quantity_after', v_after,
      'reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'line_status', v_status,
    'shipment_id', v_shipment.id,
    'warehouse_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'quantity_before', v_before,
    'quantity_delta', p_received_quantity,
    'quantity_after', v_after
  );
END;
$$;

-- ============================================================================
-- 11. Function privileges
-- ============================================================================
REVOKE ALL ON FUNCTION public.phoenix_request_warehouse_return(
  uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_request_warehouse_return(
  uuid, uuid, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_recall_warehouse_transfer(
  uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_recall_warehouse_transfer(
  uuid, uuid, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_add_warehouse_return_request_line(
  uuid, uuid, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_add_warehouse_return_request_line(
  uuid, uuid, integer, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_delete_warehouse_return_request_line(
  uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_delete_warehouse_return_request_line(
  uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_submit_warehouse_return_request(
  uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_submit_warehouse_return_request(
  uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_cancel_warehouse_return_request(
  uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_cancel_warehouse_return_request(
  uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_review_warehouse_return_request(
  uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_review_warehouse_return_request(
  uuid, jsonb) TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_send_warehouse_return_shipment_line(
  uuid, uuid, uuid, integer, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_send_warehouse_return_shipment_line(
  uuid, uuid, uuid, integer, text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_receive_warehouse_return_shipment_line(
  uuid, uuid, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_warehouse_return_shipment_line(
  uuid, uuid, integer, text, text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_send_warehouse_return_shipment_line(
  uuid, uuid, uuid, integer, text, text, text) IS
  'INSTITUTION-TO-CENTRAL-RETURN-069-A: idempotent return-send along an ACTIVE '
  'route (reused, reversed). Requires warehouse_transfer.return_send scoped to '
  'the institution (route target) warehouse. Deliberately does NOT refuse '
  'expired batches — see file header.';

COMMENT ON FUNCTION public.phoenix_receive_warehouse_return_shipment_line(
  uuid, uuid, integer, text, text) IS
  'INSTITUTION-TO-CENTRAL-RETURN-069-A: idempotent receipt at central. Requires '
  'warehouse_transfer.return_receive scoped to the central (route source) '
  'warehouse. No route/is_active dependency — completing an in-transit return '
  'must not depend on current route state.';

-- ============================================================================
-- 12. RLS
-- ============================================================================
ALTER TABLE public.warehouse_return_requests      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_return_request_lines  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_return_shipments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_return_shipment_lines ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.warehouse_return_requests      TO authenticated;
GRANT SELECT ON TABLE public.warehouse_return_request_lines TO authenticated;
GRANT SELECT ON TABLE public.warehouse_return_shipments      TO authenticated;
GRANT SELECT ON TABLE public.warehouse_return_shipment_lines TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_return_requests      FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_return_request_lines FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_return_shipments      FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_return_shipment_lines FROM authenticated;

REVOKE ALL ON TABLE public.warehouse_return_requests      FROM anon;
REVOKE ALL ON TABLE public.warehouse_return_request_lines FROM anon;
REVOKE ALL ON TABLE public.warehouse_return_shipments      FROM anon;
REVOKE ALL ON TABLE public.warehouse_return_shipment_lines FROM anon;

CREATE OR REPLACE FUNCTION public.phoenix_can_read_warehouse_return(
  p_source_organization_id      uuid,
  p_source_warehouse_id         uuid,
  p_destination_organization_id uuid,
  p_destination_warehouse_id    uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    auth.uid() IS NOT NULL
    AND (
      public.phoenix_my_role() = 'super_admin'
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'warehouse_transfer.return_request',
           p_source_organization_id, p_source_warehouse_id, NULL)
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'warehouse_transfer.return_send',
           p_source_organization_id, p_source_warehouse_id, NULL)
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'warehouse_transfer.recall',
           p_destination_organization_id, p_destination_warehouse_id, NULL)
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'warehouse_transfer.review_return',
           p_destination_organization_id, p_destination_warehouse_id, NULL)
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'warehouse_transfer.return_receive',
           p_destination_organization_id, p_destination_warehouse_id, NULL)
    );
$$;

REVOKE ALL ON FUNCTION public.phoenix_can_read_warehouse_return(uuid, uuid, uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_can_read_warehouse_return(uuid, uuid, uuid, uuid)
  TO authenticated;

COMMENT ON FUNCTION public.phoenix_can_read_warehouse_return(uuid, uuid, uuid, uuid) IS
  'INSTITUTION-TO-CENTRAL-RETURN-069-A: the single return read rule. Two-sided '
  'across FIVE permission keys because either side may be the one who acted '
  '(requested, recalled, reviewed, sent or received) — each check still proves '
  'scope to its OWN side, never the other''s.';

DROP POLICY IF EXISTS wrr_select_scoped ON public.warehouse_return_requests;
CREATE POLICY wrr_select_scoped
  ON public.warehouse_return_requests FOR SELECT TO authenticated
  USING (public.phoenix_can_read_warehouse_return(
           source_organization_id, source_warehouse_id,
           destination_organization_id, destination_warehouse_id));

DROP POLICY IF EXISTS wrrl_select_scoped ON public.warehouse_return_request_lines;
CREATE POLICY wrrl_select_scoped
  ON public.warehouse_return_request_lines FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.warehouse_return_requests r
    WHERE r.id = return_request_id
      AND public.phoenix_can_read_warehouse_return(
            r.source_organization_id, r.source_warehouse_id,
            r.destination_organization_id, r.destination_warehouse_id)));

DROP POLICY IF EXISTS wrs_select_scoped ON public.warehouse_return_shipments;
CREATE POLICY wrs_select_scoped
  ON public.warehouse_return_shipments FOR SELECT TO authenticated
  USING (public.phoenix_can_read_warehouse_return(
           source_organization_id, source_warehouse_id,
           destination_organization_id, destination_warehouse_id));

DROP POLICY IF EXISTS wrsl_select_scoped ON public.warehouse_return_shipment_lines;
CREATE POLICY wrsl_select_scoped
  ON public.warehouse_return_shipment_lines FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.warehouse_return_shipments t
    WHERE t.id = shipment_id
      AND public.phoenix_can_read_warehouse_return(
            t.source_organization_id, t.source_warehouse_id,
            t.destination_organization_id, t.destination_warehouse_id)));

-- ============================================================================
-- 13. POST-CONDITIONS — proven, not asserted
-- ============================================================================
DO $verify$
DECLARE
  v_def   text;
  v_count integer;
BEGIN
  -- 13a. New objects exist.
  FOREACH v_def IN ARRAY ARRAY[
    'public.warehouse_return_requests', 'public.warehouse_return_request_lines',
    'public.warehouse_return_shipments', 'public.warehouse_return_shipment_lines'
  ] LOOP
    IF to_regclass(v_def) IS NULL THEN
      RAISE EXCEPTION 'ABORT 069: % was not created.', v_def;
    END IF;
  END LOOP;

  -- 13b. Route enforcement is STRUCTURAL, reusing 066/068's composite key.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wrr_route_endpoints_fk' AND contype='f')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wrs_route_endpoints_fk' AND contype='f') THEN
    RAISE EXCEPTION 'ABORT 069: return route enforcement is not a composite FK.';
  END IF;

  -- 13c. Cross-organization by construction.
  FOREACH v_def IN ARRAY ARRAY[
    'wrr_source_wh_org_fk','wrr_dest_wh_org_fk','wrs_source_wh_org_fk','wrs_dest_wh_org_fk'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=v_def AND contype='f') THEN
      RAISE EXCEPTION 'ABORT 069: missing per-side organization pin: %', v_def;
    END IF;
  END LOOP;

  -- 13d. Quantities cannot lie: over-fulfilment / over-approval / over-return.
  FOREACH v_def IN ARRAY ARRAY[
    'wrsl_received_le_sent_chk','wrrl_fulfilled_le_requested_chk',
    'wrrl_fulfilled_le_approved_chk','wrrl_approved_qty_chk',
    'wrrl_fulfilled_requires_approval_chk','wtl_returned_qty_chk'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=v_def) THEN
      RAISE EXCEPTION 'ABORT 069: missing structural quantity guard: %', v_def;
    END IF;
  END LOOP;

  -- 13e. Idempotency is structural for both return movements.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE indexname='warehouse_stock_movements_return_once_uniq'
                   AND indexdef LIKE '%UNIQUE%') THEN
    RAISE EXCEPTION 'ABORT 069: return idempotency index missing.';
  END IF;
  -- 068's own idempotency contract must be untouched.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE indexname='warehouse_stock_movements_transfer_once_uniq') THEN
    RAISE EXCEPTION 'ABORT 069: 068 transfer idempotency index was removed.';
  END IF;

  -- 13f. RPC boundaries — stock-moving RPCs (advisory lock + fingerprint +
  -- route FOR SHARE, learned from 068's live-apply fix).
  FOREACH v_def IN ARRAY ARRAY[
    'public.phoenix_send_warehouse_return_shipment_line(uuid,uuid,uuid,integer,text,text,text)',
    'public.phoenix_receive_warehouse_return_shipment_line(uuid,uuid,integer,text,text)'
  ] LOOP
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%SECURITY DEFINER%',
      'VERIFY FAILED (069): not SECURITY DEFINER: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%SET search_path%',
      'VERIFY FAILED (069): no pinned search_path: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%pg_advisory_xact_lock%',
      'VERIFY FAILED (069): no advisory lock: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%FOR UPDATE%',
      'VERIFY FAILED (069): no row lock: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%phoenix_profile_has_scoped_permission%',
      'VERIFY FAILED (069): no scoped permission gate (IDOR): ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%request_fingerprint%',
      'VERIFY FAILED (069): no idempotency fingerprint: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%INSERT INTO public.audit_logs%',
      'VERIFY FAILED (069): no audit trail: ' || v_def;
  END LOOP;

  -- 13g. SEND locks the route FOR SHARE (not FOR UPDATE) — the exact lesson
  -- from 068's live-apply failure, applied here from the start.
  ASSERT pg_get_functiondef(
    'public.phoenix_send_warehouse_return_shipment_line(uuid,uuid,uuid,integer,text,text,text)'::regprocedure)
    ~ 'FROM public\.warehouse_supply_routes WHERE id = p_route_id FOR SHARE',
    'VERIFY FAILED (069): return-send does not lock the route row FOR SHARE';

  -- 13h. RECEIVE has zero dependency on route state — an in-transit return
  -- must be completable regardless of the route's current activity.
  ASSERT pg_get_functiondef(
    'public.phoenix_receive_warehouse_return_shipment_line(uuid,uuid,integer,text,text)'::regprocedure)
    NOT LIKE '%warehouse_supply_routes%',
    'VERIFY FAILED (069): return-receive must not depend on route state';

  -- 13i. SEND has NO expiry-refusal — deliberate divergence from 068's
  -- forward SEND, asserted so it cannot be silently "fixed" back in later.
  ASSERT pg_get_functiondef(
    'public.phoenix_send_warehouse_return_shipment_line(uuid,uuid,uuid,integer,text,text,text)'::regprocedure)
    NOT LIKE '%expiry_date < current_date%',
    'VERIFY FAILED (069): return-send must not refuse expired batches';

  -- 13j. Request-lifecycle RPCs: advisory lock, route FOR SHARE where they
  -- touch the route, scoped permission, audit.
  FOREACH v_def IN ARRAY ARRAY[
    'public.phoenix_request_warehouse_return(uuid,uuid,text,text)',
    'public.phoenix_recall_warehouse_transfer(uuid,uuid,text,text)',
    'public.phoenix_submit_warehouse_return_request(uuid)',
    'public.phoenix_cancel_warehouse_return_request(uuid,text)',
    'public.phoenix_review_warehouse_return_request(uuid,jsonb)'
  ] LOOP
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%SECURITY DEFINER%',
      'VERIFY FAILED (069): not SECURITY DEFINER: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%SET search_path%',
      'VERIFY FAILED (069): no pinned search_path: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%pg_advisory_xact_lock%',
      'VERIFY FAILED (069): no advisory lock: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%phoenix_profile_has_scoped_permission%',
      'VERIFY FAILED (069): no scoped permission gate (IDOR): ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%INSERT INTO public.audit_logs%',
      'VERIFY FAILED (069): no audit trail: ' || v_def;
  END LOOP;

  FOREACH v_def IN ARRAY ARRAY[
    'public.phoenix_request_warehouse_return(uuid,uuid,text,text)',
    'public.phoenix_recall_warehouse_transfer(uuid,uuid,text,text)',
    'public.phoenix_submit_warehouse_return_request(uuid)'
  ] LOOP
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%public.warehouse_supply_routes%FOR SHARE%',
      'VERIFY FAILED (069): does not lock the route row FOR SHARE before trusting is_active: ' || v_def;
  END LOOP;

  -- 13k. Line CRUD: row lock, scoped permission, draft-only guard.
  FOREACH v_def IN ARRAY ARRAY[
    'public.phoenix_add_warehouse_return_request_line(uuid,uuid,integer,text,text)',
    'public.phoenix_delete_warehouse_return_request_line(uuid)'
  ] LOOP
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%SECURITY DEFINER%',
      'VERIFY FAILED (069): not SECURITY DEFINER: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%FOR UPDATE%',
      'VERIFY FAILED (069): no row lock: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%phoenix_profile_has_scoped_permission%',
      'VERIFY FAILED (069): no scoped permission gate (IDOR): ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%return_request_not_draft%',
      'VERIFY FAILED (069): line CRUD does not require the request to still be draft: ' || v_def;
  END LOOP;

  -- 13l. ADD LINE proves the original receipt actually landed at THIS
  -- institution before trusting its remaining-returnable quantity (IDOR).
  ASSERT pg_get_functiondef(
    'public.phoenix_add_warehouse_return_request_line(uuid,uuid,integer,text,text)'::regprocedure)
    LIKE '%original_line_not_at_this_institution%',
    'VERIFY FAILED (069): add-line does not prove the original receipt belongs to this institution';

  -- 13m. REVIEW is gated by its OWN key, scoped to the DESTINATION (central)
  -- warehouse — the requester (either side) cannot approve itself.
  ASSERT pg_get_functiondef(
    'public.phoenix_review_warehouse_return_request(uuid,jsonb)'::regprocedure)
    LIKE '%warehouse_transfer.review_return%'
    AND pg_get_functiondef(
    'public.phoenix_review_warehouse_return_request(uuid,jsonb)'::regprocedure)
    LIKE '%v_request.destination_organization_id, v_request.destination_warehouse_id%',
    'VERIFY FAILED (069): review is not scoped to the DESTINATION (central) warehouse';

  -- 13n. SEND can only draw against an APPROVED return line, bounded by
  -- what was approved, and against the ORIGINAL line's remaining returnable
  -- quantity — never past what was actually received.
  ASSERT pg_get_functiondef(
    'public.phoenix_send_warehouse_return_shipment_line(uuid,uuid,uuid,integer,text,text,text)'::regprocedure)
    LIKE '%return_request_line_not_approved%'
    AND pg_get_functiondef(
    'public.phoenix_send_warehouse_return_shipment_line(uuid,uuid,uuid,integer,text,text,text)'::regprocedure)
    LIKE '%original_line_would_be_over_returned%',
    'VERIFY FAILED (069): send can draw against an unapproved line or over-return the original receipt';

  -- 13o. anon gained nothing.
  FOREACH v_def IN ARRAY ARRAY[
    'public.warehouse_return_requests','public.warehouse_return_request_lines',
    'public.warehouse_return_shipments','public.warehouse_return_shipment_lines'
  ] LOOP
    IF has_table_privilege('anon', v_def, 'SELECT') THEN
      RAISE EXCEPTION 'ABORT 069: anon can read %', v_def;
    END IF;
  END LOOP;

  -- 13p. No client write path.
  SELECT count(*) INTO v_count
  FROM information_schema.role_table_grants
  WHERE table_schema='public'
    AND table_name IN ('warehouse_return_requests','warehouse_return_request_lines',
                       'warehouse_return_shipments','warehouse_return_shipment_lines')
    AND grantee='authenticated'
    AND privilege_type IN ('INSERT','UPDATE','DELETE');
  ASSERT v_count = 0,
    'VERIFY FAILED (069): authenticated holds a direct return write privilege';

  -- 13q. Separation of duty: the return-requester side must never be the
  -- reviewer/recaller/receiver, and vice versa.
  IF (SELECT allowed FROM public.role_permission_defaults
      WHERE role='warehouse_officer' AND permission_key='warehouse_transfer.recall')
     IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ABORT 069: warehouse_officer must not recall its own institution.';
  END IF;
  IF (SELECT allowed FROM public.role_permission_defaults
      WHERE role='warehouse_officer' AND permission_key='warehouse_transfer.review_return')
     IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ABORT 069: warehouse_officer must not review its own return.';
  END IF;
  IF (SELECT allowed FROM public.role_permission_defaults
      WHERE role='warehouse_officer' AND permission_key='warehouse_transfer.return_receive')
     IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ABORT 069: warehouse_officer must not receive its own return.';
  END IF;
  IF (SELECT allowed FROM public.role_permission_defaults
      WHERE role='central_warehouse_manager' AND permission_key='warehouse_transfer.return_request')
     IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ABORT 069: central_warehouse_manager must not open a receiver-side return request.';
  END IF;
  IF (SELECT allowed FROM public.role_permission_defaults
      WHERE role='central_warehouse_manager' AND permission_key='warehouse_transfer.return_send')
     IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ABORT 069: central_warehouse_manager must not physically send a return.';
  END IF;

  -- 13r. Legacy paths and defaults untouched.
  IF NOT has_function_privilege('authenticated',
      'public.phoenix_send_warehouse_transfer_line(uuid,uuid,uuid,integer,text,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABORT 069: 068 phoenix_send_warehouse_transfer_line lost authenticated EXECUTE.';
  END IF;
  IF NOT has_function_privilege('authenticated',
      'public.phoenix_upsert_availability(uuid,text,text,text,text,integer,text,date,text,text,text,numeric,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABORT 069: phoenix_upsert_availability lost authenticated EXECUTE.';
  END IF;

  -- 13s. Public QR learns nothing about returns.
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='get_public_qr_payload'
  ORDER BY p.oid DESC LIMIT 1;
  ASSERT v_def IS NOT NULL, 'VERIFY FAILED (069): public QR function missing';
  ASSERT v_def NOT ILIKE '%warehouse_return%',
    'VERIFY FAILED (069): return data leaked into public QR';

  RAISE NOTICE '069 verified: institution->central return reuses 066''s route in '
    'reverse, is bidirectionally initiable but always institution-sent/'
    'central-received, cannot over-fulfil, over-approve or over-return the '
    'original receipt, is idempotent and lock-ordered (route FOR SHARE learned '
    'from 068''s live-apply fix), and separates requesting/recalling from '
    'reviewing from sending from receiving.';
END;
$verify$;

commit;

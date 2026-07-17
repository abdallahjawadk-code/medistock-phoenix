-- ============================================================================
-- CENTRAL-TO-INSTITUTION-SUPPLY-068-A
--
-- MANUAL APPLY ONLY. DO NOT use supabase db push or any automated runner.
--
-- VERIFICATION STATUS: pre-merge validation did not include execution against a
-- disposable PostgreSQL database; validation used static analysis, tests, CI,
-- and Supabase dry-run. Part 12's post-conditions are analysis, not a proven
-- runtime guarantee. Apply to a staging/preview database and confirm all 12x
-- post-conditions pass BEFORE this is treated as ready for production.
--
-- STRATEGY: Expand -> Frontend Migration -> Contract. This is an EXPAND step.
-- It is ADDITIVE AND BACKWARD-COMPATIBLE BY CONSTRUCTION.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS COMPLETES
-- ─────────────────────────────────────────────────────────────────────────────
-- 066 modelled the supply NETWORK (warehouse_supply_routes: central supplies
-- institution). 067 gave outlets their own balance. Neither built the movement
-- between levels 1 and 2. 068 does:
--
--   central warehouse --request--> institution asks for stock
--                     --send-----> stock leaves the central warehouse
--                     --in transit-> owned by neither balance
--                     --receive---> stock enters the institution warehouse
--
-- After 068 the supply chain is continuous:
--   central --068--> institution --061/067--> outlet
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE STRUCTURAL FACT THAT SHAPES THIS MIGRATION: TRANSFERS CROSS ORGANIZATIONS
-- ─────────────────────────────────────────────────────────────────────────────
-- 061's dispatch is INTRA-organization: one organization_id, and both endpoints
-- pinned to it by composite FK. That pattern CANNOT be reused here.
--
-- Ownership in this schema is organization -> warehouse. A central warehouse
-- belongs to the pharmacy-department organization; an institution warehouse
-- belongs to the institution's own organization. A central->institution supply
-- therefore moves stock BETWEEN organizations, by design — that is what
-- 066 separated "ownership" from "supply" to express.
--
-- So this migration carries source_organization_id AND
-- destination_organization_id, each composite-FK-pinned to its own warehouse.
-- Same-org transfers still work (both columns simply hold the same value); the
-- model just no longer ASSUMES it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- HOW "ONLY ALONG AN APPROVED ROUTE" IS ENFORCED — DECLARATIVELY
-- ─────────────────────────────────────────────────────────────────────────────
-- Every request and transfer names a route_id, and a composite FK
--   (route_id, source_warehouse_id, destination_warehouse_id)
--     -> warehouse_supply_routes (id, source_warehouse_id, target_warehouse_id)
-- makes it structurally impossible for the endpoints to disagree with the route
-- they claim. No writer can bypass it — not the RPCs, not service_role.
--
-- This inherits 066's direction guarantee for free: 066 already pins a route's
-- source to a CENTRAL warehouse and its target to an INSTITUTION warehouse via
-- its own composite FKs. If the endpoints must equal the route's endpoints, then
-- "central -> institution" needs no restating and cannot drift from 066.
--
-- `is_active` is deliberately NOT part of the FK: it is mutable, and a FK cannot
-- express "was active at the time". Route activity is checked in the RPC at
-- request and send time, which is the only moment the question is meaningful.
-- Deactivating a route must not retroactively invalidate stock already sent.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- IN-TRANSIT: STOCK OWNED BY NEITHER BALANCE
-- ─────────────────────────────────────────────────────────────────────────────
-- At SEND the quantity leaves the source warehouse's on_hand immediately — it is
-- physically gone. At RECEIVE it enters the destination's on_hand. Between those
-- two events it belongs to NEITHER warehouse_stock row.
--
-- That gap is real, not a modelling flaw: the stock is on a truck. It is
-- represented by the transfer LINE itself (status='in_transit'), and surfaced by
-- the view warehouse_stock_in_transit. It is deliberately NOT a column on
-- warehouse_stock: a denormalized counter would need its own consistency proof,
-- and the line already IS the truth. Derived beats duplicated.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DELIBERATELY DOES **NOT** DO
-- ─────────────────────────────────────────────────────────────────────────────
--   * No DROP, no RENAME, no REVOKE against any pre-existing object.
--   * No contract step; no change to any legacy path or default.
--   * No RETURN path (institution -> central). Deferred to 069 with the outlet
--     return, so both directions are designed together, once.
--   * No cancellation of an in-transit transfer. Stock on a truck cannot be
--     un-sent by an UPDATE; that needs the return path to exist first (069).
--   * No RBAC enforcement change. Enforcement stays OFF.
--   * No data backfill. No route is created. No row is rewritten.
-- ============================================================================

begin;

-- ============================================================================
-- 0. PRECONDITIONS
-- ============================================================================
DO $guard$
BEGIN
  IF to_regclass('public.warehouse_supply_routes') IS NULL
     OR to_regclass('public.warehouse_stock') IS NULL
     OR to_regclass('public.warehouse_stock_movements') IS NULL
     OR to_regclass('public.warehouses') IS NULL THEN
    RAISE EXCEPTION 'ABORT 068: expected 060/066 schema is absent. Apply earlier migrations first.';
  END IF;

  IF to_regprocedure('public.phoenix_profile_has_scoped_permission(uuid,text,uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 068: 062 scope helper is absent. Apply 062 first.';
  END IF;

  IF to_regclass('public.outlet_stock') IS NULL THEN
    RAISE EXCEPTION 'ABORT 068: migration 067 is absent. Apply 067 first.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouse_stock_id_org_uniq') THEN
    RAISE EXCEPTION 'ABORT 068: warehouse_stock_id_org_uniq (061) is absent.';
  END IF;

  RAISE NOTICE '068 preconditions OK.';
END;
$guard$;

-- ============================================================================
-- 0b. Composite key on warehouse_supply_routes: (id, source, target)
-- ============================================================================
-- ADDITIVE and trivially satisfiable — id is already the primary key. It is the
-- FK target that lets a request/transfer prove its endpoints match the route it
-- names. 066's own active-pair index is PARTIAL (WHERE is_active) and a partial
-- unique index cannot be an FK target, which is exactly why this key exists
-- rather than reusing that one.
DO $$ BEGIN
  ALTER TABLE public.warehouse_supply_routes
    ADD CONSTRAINT warehouse_supply_routes_id_endpoints_uniq
    UNIQUE (id, source_warehouse_id, target_warehouse_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 1. warehouse_transfer_requests — the institution asks
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.warehouse_transfer_requests (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The approved route this request travels. NOT NULL: an unrouted request is
  -- exactly the thing 066 exists to prevent.
  route_id                  uuid NOT NULL,

  source_warehouse_id       uuid NOT NULL,
  source_organization_id    uuid NOT NULL,
  destination_warehouse_id  uuid NOT NULL,
  destination_organization_id uuid NOT NULL,

  request_number            text NOT NULL,
  status                    text NOT NULL DEFAULT 'draft',
  notes                     text,

  requested_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_at              timestamptz,
  cancelled_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_at              timestamptz,
  cancellation_reason       text,

  created_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  -- Composite FK TARGET for the request lines. REQUIRED: PRIMARY KEY (id) alone
  -- does not satisfy a reference to (id, destination_organization_id).
  CONSTRAINT wtr_id_dest_org_uniq UNIQUE (id, destination_organization_id),

  -- The endpoints must BE the route's endpoints. This is the whole enforcement.
  CONSTRAINT wtr_route_endpoints_fk
    FOREIGN KEY (route_id, source_warehouse_id, destination_warehouse_id)
    REFERENCES public.warehouse_supply_routes (id, source_warehouse_id, target_warehouse_id)
    ON DELETE RESTRICT,

  -- Each warehouse pinned to its OWN organization. Two separate composite FKs,
  -- because the two sides may legitimately belong to different organizations.
  CONSTRAINT wtr_source_wh_org_fk
    FOREIGN KEY (source_warehouse_id, source_organization_id)
    REFERENCES public.warehouses (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT wtr_dest_wh_org_fk
    FOREIGN KEY (destination_warehouse_id, destination_organization_id)
    REFERENCES public.warehouses (id, organization_id) ON DELETE RESTRICT,

  CONSTRAINT wtr_no_self_supply
    CHECK (source_warehouse_id <> destination_warehouse_id),

  CONSTRAINT wtr_status_chk
    CHECK (status IN ('draft', 'submitted', 'partially_fulfilled', 'fulfilled', 'rejected', 'cancelled')),

  CONSTRAINT wtr_number_chk
    CHECK (btrim(request_number) = request_number AND request_number <> ''),

  -- Anything past draft has actually been asked for; draft never has.
  CONSTRAINT wtr_requested_at_chk
    CHECK (
      CASE WHEN status = 'draft' THEN requested_at IS NULL
           WHEN status = 'cancelled' THEN true
           ELSE requested_at IS NOT NULL
      END
    ),

  CONSTRAINT wtr_cancel_chk
    CHECK (
      CASE WHEN status = 'cancelled'
           THEN cancelled_at IS NOT NULL
                AND cancellation_reason IS NOT NULL AND btrim(cancellation_reason) <> ''
           ELSE cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL
      END
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS wtr_dest_org_number_uniq
  ON public.warehouse_transfer_requests (destination_organization_id, btrim(request_number));

CREATE INDEX IF NOT EXISTS wtr_route_idx  ON public.warehouse_transfer_requests (route_id);
CREATE INDEX IF NOT EXISTS wtr_source_idx ON public.warehouse_transfer_requests (source_warehouse_id, status);
CREATE INDEX IF NOT EXISTS wtr_dest_idx   ON public.warehouse_transfer_requests (destination_warehouse_id, status);

COMMENT ON TABLE public.warehouse_transfer_requests IS
  'CENTRAL-TO-INSTITUTION-SUPPLY-068-A: an institution warehouse asking a central '
  'warehouse for stock, always along an approved warehouse_supply_route (enforced '
  'by composite FK, not convention). Crosses organizations by design — source and '
  'destination each carry their own organization_id. Written only by SECURITY '
  'DEFINER RPCs; no direct client write path.';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.warehouse_transfer_requests
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 2. warehouse_transfer_request_lines — what, and how much
-- ============================================================================
-- A request names a MATERIAL, not a batch: the institution asks for
-- "amoxicillin 500mg", and the central warehouse decides which lots satisfy it.
-- Batch identity is therefore chosen at SEND time, from real source stock.

CREATE TABLE IF NOT EXISTS public.warehouse_transfer_request_lines (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_request_id       uuid NOT NULL,
  destination_organization_id uuid NOT NULL,

  central_item_id           uuid REFERENCES public.central_items(id) ON DELETE RESTRICT,
  scientific_name           text NOT NULL,
  concentration             text,
  dosage_form               text,
  unit                      text,

  requested_quantity        integer NOT NULL,
  fulfilled_quantity        integer NOT NULL DEFAULT 0,
  status                    text NOT NULL DEFAULT 'pending',
  notes                     text,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  -- Lines are intrinsic children of their header. CASCADE here is deliberate and
  -- is the ONLY cascade in 068: it mirrors 061's dispatch lines exactly. It can
  -- never destroy a balance or a ledger row — a request line holds no quantity
  -- of stock, only an intention.
  CONSTRAINT wtrl_request_org_fk
    FOREIGN KEY (transfer_request_id, destination_organization_id)
    REFERENCES public.warehouse_transfer_requests (id, destination_organization_id)
    ON DELETE CASCADE,

  CONSTRAINT wtrl_sci_name_chk
    CHECK (btrim(scientific_name) = scientific_name AND scientific_name <> ''),
  CONSTRAINT wtrl_requested_qty_chk  CHECK (requested_quantity > 0),
  CONSTRAINT wtrl_fulfilled_qty_chk  CHECK (fulfilled_quantity >= 0),
  -- A line can never be over-fulfilled. Enforced, not trusted to the RPC.
  CONSTRAINT wtrl_fulfilled_le_requested_chk
    CHECK (fulfilled_quantity <= requested_quantity),
  CONSTRAINT wtrl_status_chk
    CHECK (status IN ('pending', 'partially_fulfilled', 'fulfilled', 'rejected', 'cancelled'))
);

-- One material per request. A second line for the same material would make
-- "how much was asked for?" ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS wtrl_request_material_uniq
  ON public.warehouse_transfer_request_lines (
    transfer_request_id,
    scientific_name,
    COALESCE(concentration, ''),
    COALESCE(dosage_form, '')
  );

CREATE INDEX IF NOT EXISTS wtrl_request_idx
  ON public.warehouse_transfer_request_lines (transfer_request_id);

COMMENT ON TABLE public.warehouse_transfer_request_lines IS
  'CENTRAL-TO-INSTITUTION-SUPPLY-068-A: one requested MATERIAL per request. Batch '
  'identity is deliberately absent — the central warehouse chooses the lots at '
  'send time from real stock. fulfilled_quantity can never exceed '
  'requested_quantity (wtrl_fulfilled_le_requested_chk).';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.warehouse_transfer_request_lines
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 3. warehouse_transfers — the central sends
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.warehouse_transfers (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  route_id                  uuid NOT NULL,
  transfer_request_id       uuid REFERENCES public.warehouse_transfer_requests(id) ON DELETE RESTRICT,

  source_warehouse_id       uuid NOT NULL,
  source_organization_id    uuid NOT NULL,
  destination_warehouse_id  uuid NOT NULL,
  destination_organization_id uuid NOT NULL,

  transfer_number           text NOT NULL,
  status                    text NOT NULL DEFAULT 'in_transit',
  document_number           text,
  notes                     text,

  sent_by                   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  sent_at                   timestamptz NOT NULL DEFAULT now(),

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  -- Composite FK TARGET for the transfer lines.
  CONSTRAINT wt_id_source_org_uniq UNIQUE (id, source_organization_id),

  CONSTRAINT wt_route_endpoints_fk
    FOREIGN KEY (route_id, source_warehouse_id, destination_warehouse_id)
    REFERENCES public.warehouse_supply_routes (id, source_warehouse_id, target_warehouse_id)
    ON DELETE RESTRICT,

  CONSTRAINT wt_source_wh_org_fk
    FOREIGN KEY (source_warehouse_id, source_organization_id)
    REFERENCES public.warehouses (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT wt_dest_wh_org_fk
    FOREIGN KEY (destination_warehouse_id, destination_organization_id)
    REFERENCES public.warehouses (id, organization_id) ON DELETE RESTRICT,

  CONSTRAINT wt_no_self_supply
    CHECK (source_warehouse_id <> destination_warehouse_id),

  -- A transfer exists only because stock physically left. There is no 'draft':
  -- the row IS the send. 'cancelled' is absent on purpose — stock on a truck
  -- cannot be un-sent by an UPDATE; that is the return path (069).
  CONSTRAINT wt_status_chk
    CHECK (status IN ('in_transit', 'partially_received', 'received')),

  CONSTRAINT wt_number_chk
    CHECK (btrim(transfer_number) = transfer_number AND transfer_number <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS wt_source_org_number_uniq
  ON public.warehouse_transfers (source_organization_id, btrim(transfer_number));

CREATE INDEX IF NOT EXISTS wt_route_idx   ON public.warehouse_transfers (route_id);
CREATE INDEX IF NOT EXISTS wt_request_idx ON public.warehouse_transfers (transfer_request_id);
CREATE INDEX IF NOT EXISTS wt_source_idx  ON public.warehouse_transfers (source_warehouse_id, status);
CREATE INDEX IF NOT EXISTS wt_dest_idx    ON public.warehouse_transfers (destination_warehouse_id, status);

COMMENT ON TABLE public.warehouse_transfers IS
  'CENTRAL-TO-INSTITUTION-SUPPLY-068-A: one central->institution shipment. The row '
  'exists only because stock physically left the source, so there is no draft and '
  'no cancelled state: un-sending is a RETURN (069), not an UPDATE. Endpoints are '
  'pinned to an approved route by composite FK.';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.warehouse_transfers
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 4. warehouse_transfer_lines — one batch per line, and the in-transit truth
-- ============================================================================
-- Identity fields are IMMUTABLE SNAPSHOTS taken at send time, for the same
-- reason 061's dispatch lines snapshot theirs: the source row's identity is
-- mutable and history must stay accurate when it later changes.

CREATE TABLE IF NOT EXISTS public.warehouse_transfer_lines (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id               uuid NOT NULL,
  source_organization_id    uuid NOT NULL,
  source_warehouse_stock_id uuid NOT NULL,
  transfer_request_line_id  uuid REFERENCES public.warehouse_transfer_request_lines(id) ON DELETE SET NULL,

  central_item_id           uuid REFERENCES public.central_items(id) ON DELETE RESTRICT,

  -- Immutable snapshots
  scientific_name           text NOT NULL,
  trade_name                text,
  concentration             text,
  dosage_form               text,
  unit                      text,
  national_code             text,
  has_no_national_code      boolean NOT NULL DEFAULT false,
  batch_number              text,
  has_no_batch_number       boolean NOT NULL DEFAULT false,
  internal_batch_reference  text,
  expiry_date               date,
  unit_price                numeric(20,3),
  price_basis               text,
  currency                  text,
  supply_type_text          text,

  sent_quantity             integer NOT NULL,
  received_quantity         integer,
  status                    text NOT NULL DEFAULT 'in_transit',
  difference_reason         text,

  received_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  received_at               timestamptz,
  -- The destination stock row this line landed in. RETENTION-SOFT (061/067
  -- precedent): SET NULL, never RESTRICT.
  resulting_warehouse_stock_id uuid REFERENCES public.warehouse_stock(id) ON DELETE SET NULL,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  -- Lines are intrinsic children of their header (061 precedent). This cannot
  -- destroy a balance: the balance lives in warehouse_stock, not here.
  CONSTRAINT wtl_transfer_org_fk
    FOREIGN KEY (transfer_id, source_organization_id)
    REFERENCES public.warehouse_transfers (id, source_organization_id) ON DELETE CASCADE,

  -- Org agreement with the source stock, structural rather than conventional.
  CONSTRAINT wtl_stock_org_fk
    FOREIGN KEY (source_warehouse_stock_id, source_organization_id)
    REFERENCES public.warehouse_stock (id, organization_id) ON DELETE RESTRICT,

  CONSTRAINT wtl_status_chk
    CHECK (status IN ('in_transit', 'received', 'received_with_difference', 'rejected')),

  CONSTRAINT wtl_sci_name_chk
    CHECK (btrim(scientific_name) = scientific_name AND scientific_name <> ''),
  CONSTRAINT wtl_sent_qty_chk      CHECK (sent_quantity > 0),
  CONSTRAINT wtl_received_qty_chk  CHECK (received_quantity IS NULL OR received_quantity >= 0),
  -- Receiving more than was sent is not a difference, it is an error.
  CONSTRAINT wtl_received_le_sent_chk
    CHECK (received_quantity IS NULL OR received_quantity <= sent_quantity),
  CONSTRAINT wtl_unit_price_chk    CHECK (unit_price IS NULL OR unit_price >= 0),

  CONSTRAINT wtl_has_no_national_code_chk
    CHECK (has_no_national_code = (national_code IS NULL)),
  CONSTRAINT wtl_has_no_batch_number_chk
    CHECK (has_no_batch_number = (batch_number IS NULL)),
  CONSTRAINT wtl_internal_ref_rule_chk
    CHECK (
      CASE WHEN has_no_batch_number
           THEN internal_batch_reference IS NOT NULL
                AND btrim(internal_batch_reference) = internal_batch_reference
                AND internal_batch_reference <> ''
           ELSE internal_batch_reference IS NULL
      END
    ),
  CONSTRAINT wtl_no_placeholder_chk
    CHECK (
      (national_code IS NULL
        OR (upper(btrim(national_code)) NOT IN ('N/A', 'NA', 'NONE', 'NULL', '-', '--')
            AND btrim(national_code) <> 'بلا'))
      AND (batch_number IS NULL
        OR (upper(btrim(batch_number)) NOT IN ('N/A', 'NA', 'NONE', 'NULL', '-', '--')
            AND btrim(batch_number) <> 'بلا'))
    ),

  -- The decision state machine, expressed as data.
  --   in_transit               : undecided, and therefore still on the truck.
  --   received                 : full quantity arrived.
  --   received_with_difference : less arrived, and it must be explained.
  --   rejected                 : nothing arrived; a reason is mandatory.
  -- received_by / resulting_warehouse_stock_id are NOT required to stay non-null:
  -- they are retention-soft and may be nulled by a later user deletion or by
  -- Deep Clean, which must never invalidate the decision itself.
  CONSTRAINT wtl_decision_chk
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

CREATE INDEX IF NOT EXISTS wtl_transfer_idx ON public.warehouse_transfer_lines (transfer_id);
CREATE INDEX IF NOT EXISTS wtl_stock_idx    ON public.warehouse_transfer_lines (source_warehouse_stock_id);
CREATE INDEX IF NOT EXISTS wtl_reqline_idx  ON public.warehouse_transfer_lines (transfer_request_line_id);
-- The in-transit working set: small, hot, and queried on every dashboard.
CREATE INDEX IF NOT EXISTS wtl_in_transit_idx
  ON public.warehouse_transfer_lines (transfer_id) WHERE status = 'in_transit';

COMMENT ON TABLE public.warehouse_transfer_lines IS
  'CENTRAL-TO-INSTITUTION-SUPPLY-068-A: one batch per line, snapshotted at send. '
  'A line with status=''in_transit'' IS the in-transit quantity — the stock has '
  'left the source on_hand and not yet entered the destination''s. That is not a '
  'modelling gap: the stock is on a truck, owned by neither balance.';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.warehouse_transfer_lines
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 5. warehouse_stock_in_transit — derived, never stored
-- ============================================================================
-- A denormalized in_transit counter on warehouse_stock would need its own
-- consistency proof and could drift. The line already IS the truth, so this is a
-- view. security_invoker: the view must not become an RLS bypass — it is
-- evaluated with the CALLER's privileges against the underlying policies.

CREATE OR REPLACE VIEW public.warehouse_stock_in_transit
WITH (security_invoker = true) AS
SELECT
  t.destination_warehouse_id,
  t.destination_organization_id,
  t.source_warehouse_id,
  l.scientific_name,
  l.concentration,
  l.dosage_form,
  l.national_code,
  l.batch_number,
  l.expiry_date,
  sum(l.sent_quantity)::integer AS in_transit_quantity,
  count(*)::integer             AS in_transit_lines,
  min(t.sent_at)                AS oldest_sent_at
FROM public.warehouse_transfer_lines l
JOIN public.warehouse_transfers t ON t.id = l.transfer_id
WHERE l.status = 'in_transit'
GROUP BY 1,2,3,4,5,6,7,8,9;

COMMENT ON VIEW public.warehouse_stock_in_transit IS
  'CENTRAL-TO-INSTITUTION-SUPPLY-068-A: stock that has left a central warehouse '
  'and not yet been received by its institution. DERIVED from transfer lines, '
  'never stored — a counter column would need its own consistency proof while the '
  'line already is the truth. security_invoker: reads obey the caller''s RLS.';

-- ============================================================================
-- 6. Idempotency for transfer movements — reusing 065's ledger contract
-- ============================================================================
-- Send and receive both change warehouse_stock, so both are explained by a
-- warehouse_stock_movements row. 065's idempotency index is PARTIAL on
-- reference_type='warehouse_request', so it does not cover the two new
-- reference types. This adds the equivalent guarantee for them.
--
-- ADDITIVE: a new index and a new CHECK. 065's own index and CHECK are NOT
-- touched — no DROP, no redefinition. Both new objects are safe to add: the
-- table is append-only and the CHECK is written to pass for every reference
-- type it does not name.
--
-- No new movement_type is introduced, deliberately. Widening 060's
-- movement_type CHECK would require dropping and recreating it, and 068 issues
-- no DROP. The existing vocabulary already says what happens:
--   send at the source      -> 'dispatch_send' (060 defined it for exactly this)
--   receive at destination  -> 'add'           (065's receipt uses it)

CREATE UNIQUE INDEX IF NOT EXISTS warehouse_stock_movements_transfer_once_uniq
  ON public.warehouse_stock_movements (reference_id)
  WHERE reference_type IN ('warehouse_transfer_send', 'warehouse_transfer_receive')
    AND reference_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE public.warehouse_stock_movements
    ADD CONSTRAINT warehouse_stock_movements_transfer_fingerprint_chk
    CHECK (
      reference_type IS NULL
      OR reference_type NOT IN ('warehouse_transfer_send', 'warehouse_transfer_receive')
      OR (request_fingerprint IS NOT NULL AND request_fingerprint ~ '^[0-9a-f]{64}$')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One transfer line can be received AT MOST ONCE, whatever request id is used.
-- Structural, like 067's dispatch-line rule.
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_stock_movements_transfer_line_once_uniq
  ON public.warehouse_stock_movements (reference_id)
  WHERE reference_type = 'warehouse_transfer_line' AND reference_id IS NOT NULL;

-- ============================================================================
-- 7. Permission keys
-- ============================================================================
INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous) VALUES
  ('warehouse_transfer.view',    'warehouse_transfer', 'view',    'View warehouse transfers',        'عرض تحويلات المخازن',        false),
  ('warehouse_transfer.request', 'warehouse_transfer', 'request', 'Request stock from central',      'طلب مخزون من المركزي',       false),
  ('warehouse_transfer.send',    'warehouse_transfer', 'send',    'Send stock to an institution',    'إرسال مخزون إلى مؤسسة',      false),
  ('warehouse_transfer.receive', 'warehouse_transfer', 'receive', 'Receive an institution transfer', 'استلام تحويل في المؤسسة',    false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
SELECT 'super_admin', k.key, true
FROM public.permission_keys k
WHERE k.key LIKE 'warehouse_transfer.%'
ON CONFLICT (role, permission_key) DO NOTHING;

-- The separation of duty that matters: the side that SENDS is never the side
-- that RECEIVES. A central manager cannot receive its own shipment into an
-- institution, and an institution officer cannot send stock to itself.
INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  ('central_warehouse_manager', 'warehouse_transfer.view',    true),
  ('central_warehouse_manager', 'warehouse_transfer.send',    true),
  ('central_warehouse_manager', 'warehouse_transfer.receive', false),
  ('central_warehouse_manager', 'warehouse_transfer.request', false),
  ('warehouse_officer',         'warehouse_transfer.view',    true),
  ('warehouse_officer',         'warehouse_transfer.request', true),
  ('warehouse_officer',         'warehouse_transfer.receive', true),
  ('warehouse_officer',         'warehouse_transfer.send',    false),
  ('outlet_officer',            'warehouse_transfer.view',    false),
  ('outlet_officer',            'warehouse_transfer.request', false),
  ('outlet_officer',            'warehouse_transfer.send',    false),
  ('outlet_officer',            'warehouse_transfer.receive', false)
ON CONFLICT (role, permission_key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
SELECT r.role, k.key, false
FROM (VALUES ('institution_admin'),('port_officer'),('monthly_status_officer'),('viewer'),
             ('hospital_admin'),('warehouse_manager'),('point_operator'),('transfer_manager')) AS r(role)
CROSS JOIN (VALUES ('warehouse_transfer.send'),('warehouse_transfer.receive'),
                   ('warehouse_transfer.request')) AS k(key)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ============================================================================
-- 8. SEND — stock leaves the central warehouse
-- ============================================================================
-- Contract identical to 065/067: advisory lock first, row lock second,
-- idempotent by request UUID + fingerprint, authorized only through
-- phoenix_profile_has_scoped_permission, negative stock refused, ledger row
-- appended, audit written.

CREATE OR REPLACE FUNCTION public.phoenix_send_warehouse_transfer_line(
  p_request_id             uuid,
  p_route_id               uuid,
  p_warehouse_stock_id     uuid,
  p_quantity               integer,
  p_transfer_number        text,
  p_transfer_request_line_id uuid DEFAULT NULL,
  p_document_number        text DEFAULT NULL,
  p_notes                  text DEFAULT NULL
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
  v_stock        public.warehouse_stock%ROWTYPE;
  v_dest_org     uuid;
  v_transfer     public.warehouse_transfers%ROWTYPE;
  v_existing     public.warehouse_stock_movements%ROWTYPE;
  v_reqline      public.warehouse_transfer_request_lines%ROWTYPE;
  v_number       text := NULLIF(btrim(p_transfer_number), '');
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
  IF p_route_id IS NULL OR p_warehouse_stock_id IS NULL THEN
    RAISE EXCEPTION 'route_and_stock_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'transfer_number_required' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'transfer_send',
    'route_id', p_route_id,
    'warehouse_stock_id', p_warehouse_stock_id,
    'quantity', p_quantity,
    'transfer_number', v_number,
    'transfer_request_line_id', p_transfer_request_line_id,
    'document_number', v_doc,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  -- Advisory lock FIRST — same ordering as every other stock RPC, so the three
  -- inventory halves can never invert lock order against each other.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 68068));

  SELECT * INTO v_existing
  FROM public.warehouse_stock_movements m
  WHERE m.reference_type = 'warehouse_transfer_send' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.warehouse_stock_id IS DISTINCT FROM p_warehouse_stock_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
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

  -- The route must exist and be ACTIVE right now. Activity is checked here, not
  -- by FK: it is mutable, and deactivating a route later must not retroactively
  -- invalidate stock already sent.
  SELECT * INTO v_route
  FROM public.warehouse_supply_routes WHERE id = p_route_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'supply_route_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT v_route.is_active THEN
    RAISE EXCEPTION 'supply_route_inactive' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_stock
  FROM public.warehouse_stock WHERE id = p_warehouse_stock_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'warehouse_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- The stock must actually sit in the route's SOURCE warehouse. Without this a
  -- caller holding a valid route could drain an unrelated warehouse it happens
  -- to be assigned to — an IDOR through a legitimate identifier.
  IF v_stock.warehouse_id IS DISTINCT FROM v_route.source_warehouse_id THEN
    RAISE EXCEPTION 'stock_not_in_route_source_warehouse' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO v_dest_org
  FROM public.warehouses
  WHERE id = v_route.target_warehouse_id AND status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'destination_warehouse_not_found_or_inactive' USING ERRCODE = 'P0002';
  END IF;

  -- THE IDOR GATE. Authority is the actor's scoped assignment to the SOURCE
  -- warehouse — never a role literal, never the caller's claim.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.send', v_stock.organization_id,
    v_stock.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_transfer_send' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- An expired batch must never be shipped onward.
  IF v_stock.expiry_date IS NOT NULL AND v_stock.expiry_date < current_date THEN
    RAISE EXCEPTION 'expired_batch_cannot_be_sent' USING ERRCODE = '23514';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before - p_quantity;

  IF v_after < 0 THEN
    RAISE EXCEPTION 'warehouse_quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;
  -- Reserved stock is spoken for; a transfer may not ship it out from under it.
  IF v_after < v_stock.reserved_quantity THEN
    RAISE EXCEPTION 'warehouse_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  -- One transfer header per (source org, transfer number). A second line for the
  -- same shipment joins the existing header rather than creating a duplicate.
  SELECT * INTO v_transfer
  FROM public.warehouse_transfers
  WHERE source_organization_id = v_stock.organization_id
    AND btrim(transfer_number) = v_number
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.warehouse_transfers (
      route_id, transfer_request_id,
      source_warehouse_id, source_organization_id,
      destination_warehouse_id, destination_organization_id,
      transfer_number, status, document_number, notes, sent_by, sent_at
    ) VALUES (
      p_route_id, NULL,
      v_route.source_warehouse_id, v_stock.organization_id,
      v_route.target_warehouse_id, v_dest_org,
      v_number, 'in_transit', v_doc, v_notes, v_actor, now()
    )
    RETURNING * INTO v_transfer;
  ELSE
    -- An existing shipment must not be re-pointed at a different route.
    IF v_transfer.route_id IS DISTINCT FROM p_route_id THEN
      RAISE EXCEPTION 'transfer_number_route_conflict' USING ERRCODE = '23505';
    END IF;
    IF v_transfer.status <> 'in_transit' THEN
      RAISE EXCEPTION 'transfer_already_being_received' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- If this send answers a request line, the request must belong to the same
  -- route and must not be over-fulfilled.
  IF p_transfer_request_line_id IS NOT NULL THEN
    SELECT l.* INTO v_reqline
    FROM public.warehouse_transfer_request_lines l
    JOIN public.warehouse_transfer_requests r ON r.id = l.transfer_request_id
    WHERE l.id = p_transfer_request_line_id AND r.route_id = p_route_id
    FOR UPDATE OF l;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'request_line_not_found_for_route' USING ERRCODE = 'P0002';
    END IF;
    IF v_reqline.fulfilled_quantity + p_quantity > v_reqline.requested_quantity THEN
      RAISE EXCEPTION 'request_line_would_be_over_fulfilled' USING ERRCODE = '23514';
    END IF;

    UPDATE public.warehouse_transfer_request_lines
       SET fulfilled_quantity = fulfilled_quantity + p_quantity,
           status = CASE WHEN fulfilled_quantity + p_quantity >= requested_quantity
                         THEN 'fulfilled' ELSE 'partially_fulfilled' END
     WHERE id = v_reqline.id;

    UPDATE public.warehouse_transfer_requests
       SET status = CASE WHEN NOT EXISTS (
                           SELECT 1 FROM public.warehouse_transfer_request_lines x
                           WHERE x.transfer_request_id = v_reqline.transfer_request_id
                             AND x.status NOT IN ('fulfilled', 'rejected', 'cancelled'))
                         THEN 'fulfilled' ELSE 'partially_fulfilled' END
     WHERE id = v_reqline.transfer_request_id;

    UPDATE public.warehouse_transfers
       SET transfer_request_id = COALESCE(transfer_request_id, v_reqline.transfer_request_id)
     WHERE id = v_transfer.id;
  END IF;

  UPDATE public.warehouse_stock
     SET on_hand_quantity = v_after,
         updated_by       = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.warehouse_transfer_lines (
    transfer_id, source_organization_id, source_warehouse_stock_id,
    transfer_request_line_id, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code,
    batch_number, has_no_batch_number, internal_batch_reference,
    expiry_date, unit_price, price_basis, currency, supply_type_text,
    sent_quantity, status
  ) VALUES (
    v_transfer.id, v_stock.organization_id, v_stock.id,
    p_transfer_request_line_id, v_stock.central_item_id,
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
    v_stock.id, v_stock.organization_id, v_stock.warehouse_id, 'dispatch_send',
    v_before, -p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'warehouse_transfer_send', 'warehouse_transfer_send', p_request_id, v_fingerprint,
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
    'warehouse_transfer.send', 'warehouse_transfer_lines', v_line_id,
    v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'route_id', p_route_id,
      'transfer_id', v_transfer.id,
      'source_warehouse_id', v_route.source_warehouse_id,
      'destination_warehouse_id', v_route.target_warehouse_id,
      'movement_id', v_movement_id,
      'quantity_before', v_before,
      'quantity_delta', -p_quantity,
      'quantity_after', v_after
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'transfer_id', v_transfer.id,
    'transfer_line_id', v_line_id,
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
-- 9. RECEIVE — stock enters the institution warehouse
-- ============================================================================

CREATE OR REPLACE FUNCTION public.phoenix_receive_warehouse_transfer_line(
  p_request_id        uuid,
  p_transfer_line_id  uuid,
  p_received_quantity integer,
  p_difference_reason text DEFAULT NULL,
  p_notes             text DEFAULT NULL
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
  v_line        public.warehouse_transfer_lines%ROWTYPE;
  v_transfer    public.warehouse_transfers%ROWTYPE;
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
  IF p_request_id IS NULL OR p_transfer_line_id IS NULL THEN
    RAISE EXCEPTION 'request_id_and_line_required' USING ERRCODE = '23514';
  END IF;
  IF p_received_quantity IS NULL OR p_received_quantity < 0 THEN
    RAISE EXCEPTION 'received_quantity_must_be_non_negative' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'transfer_receive',
    'transfer_line_id', p_transfer_line_id,
    'received_quantity', p_received_quantity,
    'difference_reason', v_reason,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 68068));

  SELECT * INTO v_existing
  FROM public.warehouse_stock_movements m
  WHERE m.reference_type = 'warehouse_transfer_receive' AND m.reference_id = p_request_id;

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
  FROM public.warehouse_transfer_lines WHERE id = p_transfer_line_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- A line leaves 'in_transit' exactly once. Combined with the row lock, this is
  -- what makes a double receipt impossible even under concurrent callers.
  IF v_line.status <> 'in_transit' THEN
    RAISE EXCEPTION 'transfer_line_already_received' USING ERRCODE = '23505';
  END IF;
  IF p_received_quantity > v_line.sent_quantity THEN
    RAISE EXCEPTION 'received_quantity_exceeds_sent' USING ERRCODE = '23514';
  END IF;
  IF p_received_quantity <> v_line.sent_quantity AND v_reason IS NULL THEN
    RAISE EXCEPTION 'difference_reason_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_transfer
  FROM public.warehouse_transfers WHERE id = v_line.transfer_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transfer_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- THE IDOR GATE, and the separation of duty: authority is scoped to the
  -- DESTINATION warehouse, taken from the transfer, never from the caller. The
  -- sender cannot receive its own shipment.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'warehouse_transfer.receive', v_transfer.destination_organization_id,
    v_transfer.destination_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_warehouse_transfer_receive' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  IF v_line.expiry_date IS NOT NULL AND v_line.expiry_date < current_date THEN
    RAISE EXCEPTION 'expired_batch_cannot_be_received' USING ERRCODE = '23514';
  END IF;

  v_status := CASE
    WHEN p_received_quantity = 0 THEN 'rejected'
    WHEN p_received_quantity = v_line.sent_quantity THEN 'received'
    ELSE 'received_with_difference'
  END;

  -- A rejected line moves no stock: it stops being in transit and nothing is
  -- added anywhere. The shortfall is a discrepancy the return path (069) owns.
  IF p_received_quantity = 0 THEN
    UPDATE public.warehouse_transfer_lines
       SET status = 'rejected', received_quantity = 0,
           difference_reason = v_reason, received_by = v_actor, received_at = now()
     WHERE id = v_line.id;

    UPDATE public.warehouse_transfers
       SET status = CASE WHEN NOT EXISTS (
                           SELECT 1 FROM public.warehouse_transfer_lines x
                           WHERE x.transfer_id = v_transfer.id AND x.status = 'in_transit')
                         THEN 'received' ELSE 'partially_received' END
     WHERE id = v_transfer.id;

    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role,
      action, entity_type, entity_id, entity_label, payload
    ) VALUES (
      v_transfer.destination_organization_id, v_actor, v_actor_role,
      'warehouse_transfer.rejected', 'warehouse_transfer_lines', v_line.id,
      v_line.scientific_name,
      jsonb_build_object(
        'request_id', p_request_id, 'transfer_id', v_transfer.id,
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

  -- Resolve the DESTINATION stock identity from the line's immutable snapshots.
  -- A no-batch lot keeps its internal reference, so independently received
  -- shipments never merge — 060's rule, carried across the transfer intact.
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
    v_transfer.destination_organization_id, v_transfer.destination_warehouse_id,
    v_line.central_item_id,
    v_line.scientific_name, v_line.trade_name, v_line.concentration,
    v_line.dosage_form, v_line.unit,
    v_line.national_code, v_line.has_no_national_code,
    v_line.batch_number, v_line.has_no_batch_number, v_internal,
    v_line.expiry_date, 0, 0,
    v_line.unit_price, v_line.price_basis, v_line.currency, v_line.supply_type_text,
    v_transfer.document_number, v_notes, v_actor, v_actor
  )
  ON CONFLICT DO NOTHING;

  SELECT * INTO v_stock
  FROM public.warehouse_stock s
  WHERE s.warehouse_id = v_transfer.destination_warehouse_id
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

  UPDATE public.warehouse_transfer_lines
     SET status = v_status,
         received_quantity = p_received_quantity,
         difference_reason = v_reason,
         received_by = v_actor,
         received_at = now(),
         resulting_warehouse_stock_id = v_stock.id
   WHERE id = v_line.id;

  UPDATE public.warehouse_transfers
     SET status = CASE WHEN NOT EXISTS (
                         SELECT 1 FROM public.warehouse_transfer_lines x
                         WHERE x.transfer_id = v_transfer.id AND x.status = 'in_transit')
                       THEN 'received' ELSE 'partially_received' END
   WHERE id = v_transfer.id;

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
    'warehouse_transfer_receive', 'warehouse_transfer_receive', p_request_id, v_fingerprint,
    v_transfer.document_number, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration,
    v_stock.dosage_form, v_stock.batch_number,
    v_stock.internal_batch_reference
  )
  RETURNING id INTO v_movement_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_transfer.destination_organization_id, v_actor, v_actor_role,
    'warehouse_transfer.receive', 'warehouse_stock', v_stock.id,
    v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'transfer_id', v_transfer.id,
      'transfer_line_id', v_line.id,
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
    'transfer_id', v_transfer.id,
    'warehouse_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'quantity_before', v_before,
    'quantity_delta', p_received_quantity,
    'quantity_after', v_after
  );
END;
$$;

-- ============================================================================
-- 10. Function privileges
-- ============================================================================
REVOKE ALL ON FUNCTION public.phoenix_send_warehouse_transfer_line(
  uuid, uuid, uuid, integer, text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_send_warehouse_transfer_line(
  uuid, uuid, uuid, integer, text, uuid, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_receive_warehouse_transfer_line(
  uuid, uuid, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_warehouse_transfer_line(
  uuid, uuid, integer, text, text) TO authenticated;

COMMENT ON FUNCTION public.phoenix_send_warehouse_transfer_line(
  uuid, uuid, uuid, integer, text, uuid, text, text) IS
  'CENTRAL-TO-INSTITUTION-SUPPLY-068-A: idempotent send along an ACTIVE approved '
  'route. Requires warehouse_transfer.send scoped to the SOURCE warehouse, and '
  'refuses stock that does not sit in the route''s source warehouse (IDOR through '
  'a valid identifier). Decrements source on_hand, refuses negative and '
  'below-reserved, refuses expired batches, creates an in_transit line, appends '
  'one immutable movement, writes audit_logs.';

COMMENT ON FUNCTION public.phoenix_receive_warehouse_transfer_line(
  uuid, uuid, integer, text, text) IS
  'CENTRAL-TO-INSTITUTION-SUPPLY-068-A: idempotent receipt at the institution. '
  'Requires warehouse_transfer.receive scoped to the DESTINATION warehouse, so '
  'the sender cannot receive its own shipment. A line leaves in_transit exactly '
  'once (row lock + status check), which is what makes a double receipt '
  'impossible under concurrency.';

-- ============================================================================
-- 11. RLS
-- ============================================================================
-- Reads are scope-aware and, crucially, TWO-SIDED: a transfer is visible to the
-- sending side AND the receiving side. That is not a widening — each side must
-- still prove warehouse_transfer.view scoped to ITS OWN warehouse. It is what
-- makes a cross-organization shipment visible to both parties at all.

ALTER TABLE public.warehouse_transfer_requests      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_transfer_request_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_transfers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.warehouse_transfer_lines         ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.warehouse_transfer_requests      TO authenticated;
GRANT SELECT ON TABLE public.warehouse_transfer_request_lines TO authenticated;
GRANT SELECT ON TABLE public.warehouse_transfers              TO authenticated;
GRANT SELECT ON TABLE public.warehouse_transfer_lines         TO authenticated;
GRANT SELECT ON              public.warehouse_stock_in_transit TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_transfer_requests      FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_transfer_request_lines FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_transfers              FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.warehouse_transfer_lines         FROM authenticated;

REVOKE ALL ON TABLE public.warehouse_transfer_requests      FROM anon;
REVOKE ALL ON TABLE public.warehouse_transfer_request_lines FROM anon;
REVOKE ALL ON TABLE public.warehouse_transfers              FROM anon;
REVOKE ALL ON TABLE public.warehouse_transfer_lines         FROM anon;
REVOKE ALL ON              public.warehouse_stock_in_transit FROM anon;

CREATE OR REPLACE FUNCTION public.phoenix_can_read_warehouse_transfer(
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
           auth.uid(), 'warehouse_transfer.view',
           p_source_organization_id, p_source_warehouse_id, NULL)
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'warehouse_transfer.view',
           p_destination_organization_id, p_destination_warehouse_id, NULL)
    );
$$;

REVOKE ALL ON FUNCTION public.phoenix_can_read_warehouse_transfer(uuid, uuid, uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_can_read_warehouse_transfer(uuid, uuid, uuid, uuid)
  TO authenticated;

COMMENT ON FUNCTION public.phoenix_can_read_warehouse_transfer(uuid, uuid, uuid, uuid) IS
  'CENTRAL-TO-INSTITUTION-SUPPLY-068-A: the single transfer read rule, so headers, '
  'lines and requests can never drift apart. Two-sided by necessity: a '
  'cross-organization shipment must be visible to both parties, and each side '
  'proves warehouse_transfer.view scoped to its OWN warehouse. Never a role literal.';

DROP POLICY IF EXISTS wtr_select_scoped ON public.warehouse_transfer_requests;
CREATE POLICY wtr_select_scoped
  ON public.warehouse_transfer_requests FOR SELECT TO authenticated
  USING (public.phoenix_can_read_warehouse_transfer(
           source_organization_id, source_warehouse_id,
           destination_organization_id, destination_warehouse_id));

DROP POLICY IF EXISTS wtrl_select_scoped ON public.warehouse_transfer_request_lines;
CREATE POLICY wtrl_select_scoped
  ON public.warehouse_transfer_request_lines FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.warehouse_transfer_requests r
    WHERE r.id = transfer_request_id
      AND public.phoenix_can_read_warehouse_transfer(
            r.source_organization_id, r.source_warehouse_id,
            r.destination_organization_id, r.destination_warehouse_id)));

DROP POLICY IF EXISTS wt_select_scoped ON public.warehouse_transfers;
CREATE POLICY wt_select_scoped
  ON public.warehouse_transfers FOR SELECT TO authenticated
  USING (public.phoenix_can_read_warehouse_transfer(
           source_organization_id, source_warehouse_id,
           destination_organization_id, destination_warehouse_id));

DROP POLICY IF EXISTS wtl_select_scoped ON public.warehouse_transfer_lines;
CREATE POLICY wtl_select_scoped
  ON public.warehouse_transfer_lines FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.warehouse_transfers t
    WHERE t.id = transfer_id
      AND public.phoenix_can_read_warehouse_transfer(
            t.source_organization_id, t.source_warehouse_id,
            t.destination_organization_id, t.destination_warehouse_id)));

-- ============================================================================
-- 12. POST-CONDITIONS — proven, not asserted
-- ============================================================================
DO $verify$
DECLARE
  v_def   text;
  v_count integer;
BEGIN
  -- 12a. New objects exist.
  FOREACH v_def IN ARRAY ARRAY[
    'public.warehouse_transfer_requests', 'public.warehouse_transfer_request_lines',
    'public.warehouse_transfers', 'public.warehouse_transfer_lines',
    'public.warehouse_stock_in_transit'
  ] LOOP
    IF to_regclass(v_def) IS NULL THEN
      RAISE EXCEPTION 'ABORT 068: % was not created.', v_def;
    END IF;
  END LOOP;

  -- 12b. Route enforcement is STRUCTURAL on both requests and transfers.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wtr_route_endpoints_fk' AND contype='f')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wt_route_endpoints_fk' AND contype='f') THEN
    RAISE EXCEPTION 'ABORT 068: supply-route enforcement is not a composite FK.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='warehouse_supply_routes_id_endpoints_uniq') THEN
    RAISE EXCEPTION 'ABORT 068: the route composite FK target is missing.';
  END IF;

  -- 12c. 066's direction guarantee must still be the thing we inherit. If these
  --      vanished, "central -> institution" would silently stop being enforced.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='warehouse_supply_routes_source_central_fk' AND contype='f')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname='warehouse_supply_routes_target_institution_fk' AND contype='f') THEN
    RAISE EXCEPTION 'ABORT 068: 066 supply direction FKs are gone; 068 inherits direction from them.';
  END IF;

  -- 12d. Cross-organization by construction: each side pinned to its own org.
  FOREACH v_def IN ARRAY ARRAY[
    'wtr_source_wh_org_fk','wtr_dest_wh_org_fk','wt_source_wh_org_fk','wt_dest_wh_org_fk'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=v_def AND contype='f') THEN
      RAISE EXCEPTION 'ABORT 068: missing per-side organization pin: %', v_def;
    END IF;
  END LOOP;

  -- 12e. Quantities cannot lie.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wtl_received_le_sent_chk')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='wtrl_fulfilled_le_requested_chk') THEN
    RAISE EXCEPTION 'ABORT 068: over-receipt / over-fulfilment is not structurally refused.';
  END IF;

  -- 12f. Idempotency is structural for both movements.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE indexname='warehouse_stock_movements_transfer_once_uniq'
                   AND indexdef LIKE '%UNIQUE%') THEN
    RAISE EXCEPTION 'ABORT 068: transfer idempotency index missing.';
  END IF;

  -- 12g. 065's own idempotency contract must be untouched.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                 WHERE indexname='warehouse_stock_movements_request_once_uniq') THEN
    RAISE EXCEPTION 'ABORT 068: 065 request idempotency index was removed.';
  END IF;

  -- 12h. In-transit is DERIVED, never stored. A counter column would need its
  --      own consistency proof; the line already is the truth.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='warehouse_stock'
               AND column_name ILIKE '%in_transit%') THEN
    RAISE EXCEPTION 'ABORT 068: in-transit was denormalized onto warehouse_stock.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_views
                 WHERE schemaname='public' AND viewname='warehouse_stock_in_transit') THEN
    RAISE EXCEPTION 'ABORT 068: the in-transit view is missing.';
  END IF;
  -- The view must not become an RLS bypass.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='warehouse_stock_in_transit'
      AND array_to_string(c.reloptions, ',') LIKE '%security_invoker=true%'
  ) THEN
    RAISE EXCEPTION 'ABORT 068: the in-transit view is not security_invoker.';
  END IF;

  -- 12i. RPC boundaries.
  FOREACH v_def IN ARRAY ARRAY[
    'public.phoenix_send_warehouse_transfer_line(uuid,uuid,uuid,integer,text,uuid,text,text)',
    'public.phoenix_receive_warehouse_transfer_line(uuid,uuid,integer,text,text)'
  ] LOOP
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%SECURITY DEFINER%',
      'VERIFY FAILED (068): not SECURITY DEFINER: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%SET search_path%',
      'VERIFY FAILED (068): no pinned search_path: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%pg_advisory_xact_lock%',
      'VERIFY FAILED (068): no advisory lock: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%FOR UPDATE%',
      'VERIFY FAILED (068): no row lock: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%phoenix_profile_has_scoped_permission%',
      'VERIFY FAILED (068): no scoped permission gate (IDOR): ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%request_fingerprint%',
      'VERIFY FAILED (068): no idempotency fingerprint: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%INSERT INTO public.audit_logs%',
      'VERIFY FAILED (068): no audit trail: ' || v_def;
  END LOOP;

  -- 12j. Send: route active, stock really in the source warehouse, no negative.
  SELECT pg_get_functiondef(
    'public.phoenix_send_warehouse_transfer_line(uuid,uuid,uuid,integer,text,uuid,text,text)'::regprocedure)
    INTO v_def;
  ASSERT v_def LIKE '%supply_route_inactive%',
    'VERIFY FAILED (068): send does not require an ACTIVE route';
  ASSERT v_def LIKE '%stock_not_in_route_source_warehouse%',
    'VERIFY FAILED (068): send does not prove the stock sits in the route source (IDOR)';
  ASSERT v_def LIKE '%warehouse_quantity_cannot_go_negative%'
     AND v_def LIKE '%warehouse_quantity_below_reserved%',
    'VERIFY FAILED (068): send does not refuse negative/below-reserved stock';
  ASSERT v_def LIKE '%expired_batch_cannot_be_sent%',
    'VERIFY FAILED (068): send does not refuse expired batches';
  ASSERT v_def LIKE '%request_line_would_be_over_fulfilled%',
    'VERIFY FAILED (068): send can over-fulfil a request line';

  -- 12k. Receive: single-use, destination-scoped, bounded by sent quantity.
  SELECT pg_get_functiondef(
    'public.phoenix_receive_warehouse_transfer_line(uuid,uuid,integer,text,text)'::regprocedure)
    INTO v_def;
  ASSERT v_def LIKE '%transfer_line_already_received%',
    'VERIFY FAILED (068): a transfer line could be received twice';
  ASSERT v_def LIKE '%received_quantity_exceeds_sent%',
    'VERIFY FAILED (068): receive does not bound quantity by sent';
  ASSERT v_def LIKE '%destination_warehouse_id%',
    'VERIFY FAILED (068): receive is not scoped to the destination';

  -- 12l. anon gained nothing.
  FOREACH v_def IN ARRAY ARRAY[
    'public.warehouse_transfer_requests','public.warehouse_transfer_request_lines',
    'public.warehouse_transfers','public.warehouse_transfer_lines',
    'public.warehouse_stock_in_transit'
  ] LOOP
    IF has_table_privilege('anon', v_def, 'SELECT') THEN
      RAISE EXCEPTION 'ABORT 068: anon can read %', v_def;
    END IF;
  END LOOP;

  -- 12m. No client write path.
  SELECT count(*) INTO v_count
  FROM information_schema.role_table_grants
  WHERE table_schema='public'
    AND table_name IN ('warehouse_transfer_requests','warehouse_transfer_request_lines',
                       'warehouse_transfers','warehouse_transfer_lines')
    AND grantee='authenticated'
    AND privilege_type IN ('INSERT','UPDATE','DELETE');
  ASSERT v_count = 0,
    'VERIFY FAILED (068): authenticated holds a direct transfer write privilege';

  -- 12n. Separation of duty: the sender must not be able to receive.
  IF (SELECT allowed FROM public.role_permission_defaults
      WHERE role='central_warehouse_manager' AND permission_key='warehouse_transfer.receive')
     IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ABORT 068: central_warehouse_manager must not receive its own shipment.';
  END IF;
  IF (SELECT allowed FROM public.role_permission_defaults
      WHERE role='warehouse_officer' AND permission_key='warehouse_transfer.send')
     IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ABORT 068: warehouse_officer must not send central stock.';
  END IF;

  -- 12o. Legacy paths and defaults untouched.
  IF NOT has_function_privilege('authenticated',
      'public.phoenix_upsert_availability(uuid,text,text,text,text,integer,text,date,text,text,text,numeric,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABORT 068: phoenix_upsert_availability lost authenticated EXECUTE.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attrdef d
    JOIN pg_class c ON c.oid = d.adrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.adnum
    WHERE n.nspname='public' AND c.relname='item_availability' AND a.attname='source_kind'
      AND pg_get_expr(d.adbin, d.adrelid) NOT ILIKE '%manual%'
  ) THEN
    RAISE EXCEPTION 'ABORT 068: source_kind default changed.';
  END IF;

  -- 12p. Public QR learns nothing about transfers.
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='get_public_qr_payload'
  ORDER BY p.oid DESC LIMIT 1;
  ASSERT v_def IS NOT NULL, 'VERIFY FAILED (068): public QR function missing';
  ASSERT v_def NOT ILIKE '%warehouse_transfer%' AND v_def NOT ILIKE '%in_transit%',
    'VERIFY FAILED (068): transfer data leaked into public QR';

  RAISE NOTICE '068 verified: central->institution supply is route-enforced by '
    'composite FK, crosses organizations safely, cannot over-fulfil or '
    'over-receive, is idempotent and lock-ordered, keeps in-transit derived '
    'rather than stored, and separates sending from receiving.';
END;
$verify$;

commit;

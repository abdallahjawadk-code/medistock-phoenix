-- ============================================================================
-- OUTLET-TO-INSTITUTION-RETURN-071-A
--
-- MANUAL APPLY ONLY. DO NOT use supabase db push or any automated runner.
--
-- VERIFICATION STATUS: authored, not applied, not executed against a
-- disposable PostgreSQL database. Validation used static analysis and the
-- test suite only (matching 044-069's own convention). Apply to a
-- staging/preview database and confirm every post-condition passes BEFORE
-- this is treated as ready for production. This is a FIRST-PASS authoring
-- pass — unlike 069, it has not yet been through a live-apply review round.
--
-- STRATEGY: Expand -> Frontend Migration -> Contract. This is an EXPAND step.
-- Additive by construction.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS COMPLETES
-- ─────────────────────────────────────────────────────────────────────────────
-- 069 built institution -> central returns and explicitly deferred the outlet
-- leg: "the outlet -> institution return (067's dispatch/outlet_stock domain)
-- is a SEPARATE physical model ... tracked as a follow-up migration." 071 is
-- that migration, and it is authored AFTER 070 finally shipped the forward
-- warehouse -> outlet dispatch SEND/RECEIVE path — which changes the provenance
-- model fundamentally (see below):
--
--   outlet       --request--> asks to send stock back (excess/near-expiry/
--                              quality issue), OR
--   institution  --recall---> asks the outlet to send stock back
--                              (recall/mis-dispatch) — EITHER side may open it
--   institution  --review----> accepts in full/in part, or rejects, per line
--   outlet       --send------> stock leaves the outlet
--                --in transit-> owned by neither balance
--   institution  --receive---> stock re-enters the institution's warehouse,
--                              classified restockable OR quarantined
--
-- ─────────────────────────────────────────────────────────────────────────────
-- distribution_points.warehouse_id IS THE STRUCTURAL RELATIONSHIP — NO NEW
-- ROUTE TABLE
-- ─────────────────────────────────────────────────────────────────────────────
-- Unlike 066's warehouse<->warehouse traffic, there is no route table between
-- a warehouse and an outlet (confirmed: no such table exists anywhere in
-- 060-069; a dispatch's only structural constraint is that both endpoints
-- share the same organization_id). distribution_points already carries
-- warehouse_id (001), legacy and nullable, unused by any 060-069 dispatch/
-- return authorization path. 071 makes it load-bearing FOR THIS DOMAIN ONLY:
-- an outlet may return to the SPECIFIC warehouse named by its own
-- distribution_points.warehouse_id — nowhere else, and only once that column
-- is populated. This is additive: no existing row's behaviour changes, no
-- existing RPC reads this column, and a NULL warehouse_id simply means that
-- outlet cannot yet open a return (clear, named error), not a silent bypass.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE PHYSICAL MOVER IS ALWAYS THE OUTLET, REGARDLESS OF WHO ASKED
-- ─────────────────────────────────────────────────────────────────────────────
-- Same rule as 069: an institution-side RECALL does not let the institution
-- move outlet stock directly — it only opens the same request row an
-- outlet-initiated return would, with requested_by_side='sender' instead of
-- 'receiver'. Whoever holds the goods (the outlet) still executes SEND;
-- whoever gets them back (the institution warehouse) still executes REVIEW
-- and RECEIVE.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SINGLE PROVEN PROVENANCE: A RETURN TRACES TO A REAL 070 DISPATCH RECEIPT,
-- NOTHING ELSE. NO 'add'. NO XOR. NO UNPROVEN LEGACY ORIGIN.
-- ─────────────────────────────────────────────────────────────────────────────
-- The first draft of this migration (PR #14, when it was numbered 070) allowed
-- an XOR provenance: EITHER a warehouse_dispatch_line OR a bare
-- outlet_stock_movements row of movement_type IN ('dispatch_receive','add').
-- The 'add' branch existed only because, at that time, NO migration had yet
-- built the forward dispatch SEND path, so outlet stock could only have arrived
-- via a manual/legacy 'add'. That assumption is now DEAD: migration 070 shipped
-- phoenix_send_warehouse_dispatch / phoenix_receive_outlet_dispatch_line, so
-- every legitimately dispatched-and-received outlet batch now carries a REAL
-- warehouse_dispatch_line (status accepted / accepted_with_difference, with
-- resulting_outlet_stock_id set) AND its matching 'dispatch_receive' movement on
-- outlet_stock_movements (the row 070's RECEIVE wrote, carrying dispatch_line_id
-- and outlet_stock_id). A return therefore has EXACTLY ONE legitimate origin,
-- and this migration requires the WHOLE chain, structurally, never RPC-trusted:
--
--   original_dispatch_line_id     -> warehouse_dispatch_lines.id   (NOT NULL)
--   original_inbound_movement_id  -> outlet_stock_movements.id     (NOT NULL,
--                                    movement_type = 'dispatch_receive' ONLY)
--   source_outlet_stock_id        -> outlet_stock.id               (NOT NULL)
--
-- and COMPOSITE FOREIGN KEYS pin the three together so no combination that does
-- not actually belong together can ever be inserted — the database, not the
-- RPC, is the authority:
--   (movement_id, dispatch_line_id) -> outlet_stock_movements(id, dispatch_line_id)
--        the named movement was produced BY the named dispatch line's receive;
--   (movement_id, source_outlet_stock_id) -> outlet_stock_movements(id, outlet_stock_id)
--        that movement credited THIS outlet_stock row;
--   (dispatch_line_id, source_outlet_stock_id)
--        -> warehouse_dispatch_lines(id, resulting_outlet_stock_id)
--        that dispatch line RESULTED IN this same outlet_stock row;
--   (movement_id, 'dispatch_receive') -> outlet_stock_movements(id, movement_type)
--        and it is a receive, never a dispense/correction/add/subtract.
-- The ADD-LINE RPC additionally asserts the material/batch/expiry snapshots on
-- the dispatch line and the outlet_stock row are identical, and caps the return
-- at (received_quantity - already-returned) on that dispatch line: the
-- ACCEPTED-BUT-NOT-YET-RETURNED quantity, never more. There is NO XOR with an
-- unproven legacy source: a batch whose only paper trail is a manual 'add', a
-- dispense, or a correction is NOT eligible provenance at all.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SAME QUARANTINE TABLE 069 CREATED — NO NEW ONE
-- ─────────────────────────────────────────────────────────────────────────────
-- warehouse_quarantine_stock (069) is keyed by warehouse_id, not by which
-- migration created the row. 071 reuses it verbatim for outlet returns
-- credited to an institution warehouse — same fail-closed disposition
-- policy, same non-dispensable/non-public contract, same 071-owns-release
-- boundary. No ALTER on that table in this file.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DELIBERATELY DOES **NOT** DO
-- ─────────────────────────────────────────────────────────────────────────────
--   * No DROP, no RENAME, no REVOKE against any pre-existing object.
--   * No new warehouse<->outlet route table — distribution_points.warehouse_id
--     is the only structural pairing, per the approved design.
--   * No widened CHECK anywhere: reuses 'return_send' (already reserved,
--     unused, in outlet_stock_movements_type_chk since 067) for the outlet
--     debit and 'add' (already in warehouse_stock_movements_type_chk since 060)
--     for the warehouse credit leg, exactly as 069 reused 'dispatch_return'/
--     'add'. NOTE: 'add' here is ONLY the warehouse-side physical credit on
--     RECEIVE — it is NEVER accepted as return PROVENANCE (see the single-proven-
--     provenance section above); the source a return traces back to must be a
--     070 'dispatch_receive' movement, never an 'add'.
--   * No cancellation of an in-transit return shipment.
--   * No final quarantine disposition (071's job, same table 069 created).
--   * No RBAC enforcement change. Enforcement stays OFF; scope enforcement
--     (phoenix_profile_has_scoped_permission) stays ON, as always.
--   * No data backfill, no row rewritten.
--   * No frontend in this PR — DB layer only.
--   * NOT APPLIED by this PR. Authored only.
-- ============================================================================

begin;

-- ============================================================================
-- 0. PRECONDITIONS
-- ============================================================================
DO $guard$
BEGIN
  IF to_regclass('public.distribution_points') IS NULL
     OR to_regclass('public.warehouse_dispatch_lines') IS NULL
     OR to_regclass('public.outlet_stock') IS NULL
     OR to_regclass('public.outlet_stock_movements') IS NULL
     OR to_regclass('public.warehouse_stock') IS NULL
     OR to_regclass('public.warehouse_stock_movements') IS NULL
     OR to_regclass('public.warehouse_quarantine_stock') IS NULL
     OR to_regclass('public.warehouse_quarantine_stock_movements') IS NULL THEN
    RAISE EXCEPTION 'ABORT 071: expected 060/061/067/069 schema is absent. Apply earlier migrations first.';
  END IF;

  IF to_regprocedure('public.phoenix_profile_has_scoped_permission(uuid,text,uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.phoenix_project_outlet_availability(uuid)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 071: 062/067 helper RPCs are absent.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outlet_stock_movements_type_chk') THEN
    RAISE EXCEPTION 'ABORT 071: outlet_stock_movements_type_chk (067) is absent.';
  END IF;

  -- 071's provenance model REQUIRES 070's forward dispatch path: a return may
  -- only trace to a real dispatch line + its 'dispatch_receive' movement. Fail
  -- closed if 070 (the migration that produces those rows) is not applied.
  IF to_regprocedure('public.phoenix_send_warehouse_dispatch(uuid,uuid)') IS NULL
     OR to_regprocedure('public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'ABORT 071: 070 forward-dispatch SEND/RECEIVE RPCs are absent. Apply 070 first.';
  END IF;
  -- The provenance composite FKs below pin to these columns; if 067/070 ever
  -- reshaped them, fail closed rather than create a mis-targeted FK.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='outlet_stock_movements' AND column_name='dispatch_line_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouse_dispatch_lines' AND column_name='resulting_outlet_stock_id'
  ) THEN
    RAISE EXCEPTION 'ABORT 071: expected 067/070 columns (outlet_stock_movements.dispatch_line_id, warehouse_dispatch_lines.resulting_outlet_stock_id) are absent.';
  END IF;

  RAISE NOTICE '071 preconditions OK.';
END;
$guard$;

-- ============================================================================
-- 1. Structural pairing: distribution_points.warehouse_id becomes load-bearing
--    FOR THIS DOMAIN ONLY, via a composite FK target
-- ============================================================================
-- (id, warehouse_id) is trivially unique because id is already a PK — this
-- index exists purely to serve as an FK target, the SAME technique 067 used
-- for distribution_points_id_point_type_uniq. Existing rows are untouched;
-- a NULL warehouse_id simply cannot be the target of the composite FK below
-- (Postgres never matches a FK column against a NULL referenced value), so an
-- outlet with no configured warehouse_id structurally cannot open a return —
-- a clear absence, never a silent bypass.
CREATE UNIQUE INDEX IF NOT EXISTS distribution_points_id_warehouse_uniq
  ON public.distribution_points (id, warehouse_id);

-- ============================================================================
-- 2. warehouse_dispatch_lines gains returned_quantity — additive, mirrors
--    069's returned_quantity on warehouse_transfer_lines exactly
-- ============================================================================
DO $$ BEGIN
  ALTER TABLE public.warehouse_dispatch_lines
    ADD COLUMN returned_quantity integer NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.warehouse_dispatch_lines
    ADD CONSTRAINT wdl_returned_qty_chk
    CHECK (returned_quantity >= 0 AND returned_quantity <= COALESCE(received_quantity, 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.warehouse_dispatch_lines
    ADD COLUMN return_received_quantity integer NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.warehouse_dispatch_lines
    ADD CONSTRAINT wdl_return_received_qty_chk
    CHECK (return_received_quantity >= 0 AND return_received_quantity <= returned_quantity);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.warehouse_dispatch_lines
    ADD COLUMN return_unresolved_quantity integer
    GENERATED ALWAYS AS (returned_quantity - return_received_quantity) STORED;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Composite FK targets needed for the dispatch-line provenance path below.
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_dispatch_lines_id_org_uniq
  ON public.warehouse_dispatch_lines (id, organization_id);
-- Trivially unique (id is PK); exists so a return line can be pinned to
-- EXACTLY the outlet_stock row that dispatch line actually resulted in —
-- never a different batch that merely looks similar.
CREATE UNIQUE INDEX IF NOT EXISTS warehouse_dispatch_lines_id_resulting_stock_uniq
  ON public.warehouse_dispatch_lines (id, resulting_outlet_stock_id);

-- ============================================================================
-- 3. outlet_stock_movements gains returned_quantity — the cap for the
--    movement-provenance return path (mirrors #2 for the dispatch-line path)
-- ============================================================================
DO $$ BEGIN
  ALTER TABLE public.outlet_stock_movements
    ADD COLUMN returned_quantity integer NOT NULL DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Bounded by on_hand_delta: a 'dispatch_receive' movement always has delta > 0,
-- so this cap is meaningful for exactly the rows that can ever be named as
-- provenance. (The dispatch line's own received_quantity is the AUTHORITATIVE
-- cap — see the ADD-LINE RPC — but keeping the movement's own returned_quantity
-- bounded is a cheap structural belt-and-suspenders on the credit row too.)
DO $$ BEGIN
  ALTER TABLE public.outlet_stock_movements
    ADD CONSTRAINT osm_returned_qty_chk
    CHECK (returned_quantity >= 0 AND returned_quantity <= GREATEST(on_hand_delta, 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Composite FK targets for the single-proven-provenance chain. All trivially
-- unique (id is PK) — each pins one extra column so the FKs in sections 5/7 can
-- prove identity, organization, TYPE ELIGIBILITY, the owning outlet_stock row,
-- AND the producing dispatch line structurally, not by RPC discipline.
CREATE UNIQUE INDEX IF NOT EXISTS outlet_stock_movements_id_org_uniq
  ON public.outlet_stock_movements (id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS outlet_stock_movements_id_stock_uniq
  ON public.outlet_stock_movements (id, outlet_stock_id);
CREATE UNIQUE INDEX IF NOT EXISTS outlet_stock_movements_id_type_uniq
  ON public.outlet_stock_movements (id, movement_type);
-- NEW for 071: lets a return line prove its named movement was produced BY a
-- specific dispatch line's receive (movement.dispatch_line_id), not merely that
-- some movement and some dispatch line both exist.
CREATE UNIQUE INDEX IF NOT EXISTS outlet_stock_movements_id_dispatch_line_uniq
  ON public.outlet_stock_movements (id, dispatch_line_id);

-- ============================================================================
-- 4. outlet_return_requests — either side asks
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.outlet_return_requests (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  distribution_point_id         uuid NOT NULL,   -- outlet: physical holder
  source_organization_id        uuid NOT NULL,
  destination_warehouse_id      uuid NOT NULL,   -- institution: receives it back
  destination_organization_id   uuid NOT NULL,

  return_number                 text NOT NULL,
  status                        text NOT NULL DEFAULT 'draft',

  requested_by_side             text NOT NULL,
  notes                         text,

  requested_by                  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_at                  timestamptz,
  reviewed_by                   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at                   timestamptz,
  cancelled_by                  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_at                  timestamptz,
  cancellation_reason           text,

  created_by                    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT orr_id_src_org_uniq UNIQUE (id, source_organization_id),

  -- THE structural pairing: this outlet may only return to the SPECIFIC
  -- warehouse its own distribution_points.warehouse_id names. No route table.
  CONSTRAINT orr_point_warehouse_fk
    FOREIGN KEY (distribution_point_id, destination_warehouse_id)
    REFERENCES public.distribution_points (id, warehouse_id)
    ON DELETE RESTRICT,

  CONSTRAINT orr_point_org_fk
    FOREIGN KEY (distribution_point_id, source_organization_id)
    REFERENCES public.distribution_points (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT orr_dest_wh_org_fk
    FOREIGN KEY (destination_warehouse_id, destination_organization_id)
    REFERENCES public.warehouses (id, organization_id) ON DELETE RESTRICT,

  -- Outlet returns are always WITHIN one institution: the same organization
  -- owns both the outlet and the warehouse it returns to (unlike 069, where
  -- institution and central are deliberately DIFFERENT organizations).
  CONSTRAINT orr_same_org_chk
    CHECK (source_organization_id = destination_organization_id),

  CONSTRAINT orr_requested_by_side_chk
    CHECK (requested_by_side IN ('receiver', 'sender')),

  CONSTRAINT orr_status_chk
    CHECK (status IN (
      'draft', 'submitted', 'approved', 'partially_approved', 'rejected',
      'cancelled', 'partially_fulfilled', 'fulfilled'
    )),

  CONSTRAINT orr_number_chk
    CHECK (btrim(return_number) = return_number AND return_number <> ''),

  CONSTRAINT orr_requested_at_chk
    CHECK (
      CASE WHEN status = 'draft' THEN requested_at IS NULL
           WHEN status = 'cancelled' THEN true
           ELSE requested_at IS NOT NULL
      END
    ),

  CONSTRAINT orr_cancel_chk
    CHECK (
      CASE WHEN status = 'cancelled'
           THEN cancelled_at IS NOT NULL
                AND cancellation_reason IS NOT NULL AND btrim(cancellation_reason) <> ''
           ELSE cancelled_at IS NULL AND cancelled_by IS NULL AND cancellation_reason IS NULL
      END
    ),

  CONSTRAINT orr_reviewed_at_chk
    CHECK (
      CASE WHEN status IN ('approved', 'partially_approved', 'rejected',
                            'partially_fulfilled', 'fulfilled')
           THEN reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL
           ELSE reviewed_at IS NULL AND reviewed_by IS NULL
      END
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS orr_src_org_number_uniq
  ON public.outlet_return_requests (source_organization_id, btrim(return_number));

CREATE INDEX IF NOT EXISTS orr_point_idx ON public.outlet_return_requests (distribution_point_id, status);
CREATE INDEX IF NOT EXISTS orr_dest_idx  ON public.outlet_return_requests (destination_warehouse_id, status);

COMMENT ON TABLE public.outlet_return_requests IS
  'OUTLET-TO-INSTITUTION-RETURN-071-A: either the outlet (requested_by_side='
  '''receiver'') or the institution (=''sender'', a recall) may open this, but '
  'the outlet always physically SENDs and the institution always REVIEWs/'
  'RECEIVEs. No route table: distribution_points.warehouse_id is the '
  'structural pairing. Written only by SECURITY DEFINER RPCs.';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.outlet_return_requests
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 5. outlet_return_request_lines — single proven provenance, fail-closed reasons
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.outlet_return_request_lines (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_request_id           uuid NOT NULL,
  source_organization_id       uuid NOT NULL,

  -- Single proven provenance — see file header. ALL THREE are required and are
  -- pinned to each other by composite FKs below: the return traces to a real
  -- 070 dispatch line, its matching 'dispatch_receive' movement, and the exact
  -- outlet_stock row both refer to. No XOR, no 'add', no unproven legacy origin.
  original_dispatch_line_id    uuid NOT NULL REFERENCES public.warehouse_dispatch_lines(id) ON DELETE RESTRICT,
  original_inbound_movement_id uuid NOT NULL REFERENCES public.outlet_stock_movements(id) ON DELETE RESTRICT,
  -- Pinned to 'dispatch_receive' by orrl_inbound_movement_type_fk below — never
  -- 'add'/'dispense'/'correction'. Snapshot so the FK proves it structurally.
  original_inbound_movement_type text NOT NULL DEFAULT 'dispatch_receive',
  -- The exact outlet_stock row this return leaves from — the single point the
  -- movement and the dispatch line are both proven (by composite FK) to share.
  source_outlet_stock_id       uuid NOT NULL,

  scientific_name              text NOT NULL,
  concentration                 text,
  dosage_form                   text,
  unit                          text,
  national_code                 text,
  batch_number                  text,
  internal_batch_reference      text,
  expiry_date                   date,

  reason_code                   text NOT NULL,
  reason_text                   text,

  requested_quantity            integer NOT NULL,
  approved_quantity             integer,
  fulfilled_quantity            integer NOT NULL DEFAULT 0,
  status                        text NOT NULL DEFAULT 'pending',

  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT orrl_request_org_fk
    FOREIGN KEY (return_request_id, source_organization_id)
    REFERENCES public.outlet_return_requests (id, source_organization_id)
    ON DELETE CASCADE,

  -- Type eligibility, structural: the referenced movement's ACTUAL movement_type
  -- must equal the snapshot, and the snapshot is pinned to the SINGLE credit
  -- type a return may legitimately trace to. 'add'/'dispense'/'correction'/
  -- 'subtract'/'reserve'/'release'/'set_exact' can never satisfy this FK — a
  -- return can only trace to a genuine 070 dispatch receipt.
  CONSTRAINT orrl_inbound_movement_type_chk
    CHECK (original_inbound_movement_type = 'dispatch_receive'),
  CONSTRAINT orrl_inbound_movement_type_fk
    FOREIGN KEY (original_inbound_movement_id, original_inbound_movement_type)
    REFERENCES public.outlet_stock_movements (id, movement_type)
    ON DELETE RESTRICT,

  -- THE PROVEN CHAIN, three composite FKs the RPC cannot bypass:
  -- (1) the movement was produced BY this dispatch line's receive.
  CONSTRAINT orrl_movement_from_dispatch_line_fk
    FOREIGN KEY (original_inbound_movement_id, original_dispatch_line_id)
    REFERENCES public.outlet_stock_movements (id, dispatch_line_id)
    ON DELETE RESTRICT,
  -- (2) the movement credited THIS outlet_stock row.
  CONSTRAINT orrl_movement_stock_fk
    FOREIGN KEY (original_inbound_movement_id, source_outlet_stock_id)
    REFERENCES public.outlet_stock_movements (id, outlet_stock_id)
    ON DELETE RESTRICT,
  -- (3) the dispatch line RESULTED IN this same outlet_stock row.
  CONSTRAINT orrl_dispatch_line_stock_fk
    FOREIGN KEY (original_dispatch_line_id, source_outlet_stock_id)
    REFERENCES public.warehouse_dispatch_lines (id, resulting_outlet_stock_id)
    ON DELETE RESTRICT,
  -- organization isolation on every leg of the chain.
  CONSTRAINT orrl_inbound_movement_org_fk
    FOREIGN KEY (original_inbound_movement_id, source_organization_id)
    REFERENCES public.outlet_stock_movements (id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT orrl_dispatch_line_org_fk
    FOREIGN KEY (original_dispatch_line_id, source_organization_id)
    REFERENCES public.warehouse_dispatch_lines (id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT orrl_source_stock_org_fk
    FOREIGN KEY (source_outlet_stock_id, source_organization_id)
    REFERENCES public.outlet_stock (id, organization_id)
    ON DELETE RESTRICT,

  CONSTRAINT orrl_sci_name_chk
    CHECK (btrim(scientific_name) = scientific_name AND scientific_name <> ''),
  -- Same 9-value vocabulary as 069's warehouse_return_request_lines, so the
  -- disposition rule at RECEIVE (section 9) can be identical, fail-closed,
  -- reason for reason.
  CONSTRAINT orrl_reason_code_chk
    CHECK (reason_code IN (
      'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged',
      'recalled', 'quality_issue', 'temperature_excursion', 'other'
    )),
  CONSTRAINT orrl_requested_qty_chk CHECK (requested_quantity > 0),
  CONSTRAINT orrl_approved_qty_chk
    CHECK (approved_quantity IS NULL
           OR (approved_quantity >= 0 AND approved_quantity <= requested_quantity)),
  CONSTRAINT orrl_fulfilled_qty_chk CHECK (fulfilled_quantity >= 0),
  CONSTRAINT orrl_fulfilled_le_requested_chk
    CHECK (fulfilled_quantity <= requested_quantity),
  CONSTRAINT orrl_fulfilled_requires_approval_chk
    CHECK (approved_quantity IS NOT NULL OR fulfilled_quantity = 0),
  CONSTRAINT orrl_fulfilled_le_approved_chk
    CHECK (approved_quantity IS NULL OR fulfilled_quantity <= approved_quantity),

  CONSTRAINT orrl_status_chk
    CHECK (status IN (
      'pending', 'approved', 'rejected', 'partially_fulfilled', 'fulfilled', 'cancelled'
    )),

  CONSTRAINT orrl_status_qty_consistency_chk
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

-- A given prior dispatch receipt can be named at most once per return request —
-- ambiguity prevention, same reasoning as 069. Both provenance ids are now
-- mandatory, so these indexes are unconditional (no partial WHERE needed).
CREATE UNIQUE INDEX IF NOT EXISTS orrl_request_dispatch_line_uniq
  ON public.outlet_return_request_lines (return_request_id, original_dispatch_line_id);
CREATE UNIQUE INDEX IF NOT EXISTS orrl_request_inbound_movement_uniq
  ON public.outlet_return_request_lines (return_request_id, original_inbound_movement_id);

CREATE INDEX IF NOT EXISTS orrl_request_idx  ON public.outlet_return_request_lines (return_request_id);
CREATE INDEX IF NOT EXISTS orrl_dispatch_idx ON public.outlet_return_request_lines (original_dispatch_line_id);
CREATE INDEX IF NOT EXISTS orrl_movement_idx ON public.outlet_return_request_lines (original_inbound_movement_id);

COMMENT ON TABLE public.outlet_return_request_lines IS
  'OUTLET-TO-INSTITUTION-RETURN-071-A: SINGLE proven provenance — a return line '
  'must name a real 070 warehouse_dispatch_line, its matching ''dispatch_receive'' '
  'outlet_stock_movement, and the exact outlet_stock row both share; three '
  'composite FKs pin them together so no unrelated combination can be inserted. '
  'No XOR, no ''add''/dispense/correction origin. Bounded at the RPC level by the '
  'dispatch line''s (received_quantity - already_returned) — the accepted-but-'
  'not-yet-returned quantity.';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.outlet_return_request_lines
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 6. outlet_return_shipments — the outlet sends it back
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.outlet_return_shipments (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  return_request_id            uuid REFERENCES public.outlet_return_requests(id) ON DELETE RESTRICT,

  distribution_point_id         uuid NOT NULL,   -- outlet
  source_organization_id         uuid NOT NULL,
  destination_warehouse_id        uuid NOT NULL,  -- institution
  destination_organization_id      uuid NOT NULL,

  shipment_number                text NOT NULL,
  status                          text NOT NULL DEFAULT 'in_transit',
  document_number                  text,
  notes                             text,

  sent_by                           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  sent_at                            timestamptz NOT NULL DEFAULT now(),

  created_at                         timestamptz NOT NULL DEFAULT now(),
  updated_at                          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ors_id_source_org_uniq UNIQUE (id, source_organization_id),

  CONSTRAINT ors_point_warehouse_fk
    FOREIGN KEY (distribution_point_id, destination_warehouse_id)
    REFERENCES public.distribution_points (id, warehouse_id)
    ON DELETE RESTRICT,

  CONSTRAINT ors_point_org_fk
    FOREIGN KEY (distribution_point_id, source_organization_id)
    REFERENCES public.distribution_points (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT ors_dest_wh_org_fk
    FOREIGN KEY (destination_warehouse_id, destination_organization_id)
    REFERENCES public.warehouses (id, organization_id) ON DELETE RESTRICT,

  CONSTRAINT ors_same_org_chk
    CHECK (source_organization_id = destination_organization_id),

  -- No 'draft', no 'cancelled' — symmetric with 068/069: stock on a truck
  -- cannot be un-sent by an UPDATE.
  CONSTRAINT ors_status_chk
    CHECK (status IN ('in_transit', 'partially_received', 'received')),

  CONSTRAINT ors_number_chk
    CHECK (btrim(shipment_number) = shipment_number AND shipment_number <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS ors_source_org_number_uniq
  ON public.outlet_return_shipments (source_organization_id, btrim(shipment_number));

CREATE INDEX IF NOT EXISTS ors_request_idx ON public.outlet_return_shipments (return_request_id);
CREATE INDEX IF NOT EXISTS ors_point_idx   ON public.outlet_return_shipments (distribution_point_id, status);
CREATE INDEX IF NOT EXISTS ors_dest_idx    ON public.outlet_return_shipments (destination_warehouse_id, status);

COMMENT ON TABLE public.outlet_return_shipments IS
  'OUTLET-TO-INSTITUTION-RETURN-071-A: one outlet->institution return '
  'shipment. No draft, no cancelled. Endpoints pinned by '
  'distribution_points.warehouse_id, the same structural pairing used '
  'throughout this file — no route table.';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.outlet_return_shipments
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 7. outlet_return_shipment_lines — one returned batch per line
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.outlet_return_shipment_lines (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id                 uuid NOT NULL,
  source_organization_id       uuid NOT NULL,
  source_outlet_stock_id        uuid NOT NULL,
  return_request_line_id         uuid REFERENCES public.outlet_return_request_lines(id) ON DELETE SET NULL,

  -- Carried from the request line at SEND time — same single-proven-provenance
  -- discipline, both mandatory, both pinned to source_outlet_stock_id below.
  original_dispatch_line_id       uuid NOT NULL REFERENCES public.warehouse_dispatch_lines(id) ON DELETE RESTRICT,
  original_inbound_movement_id     uuid NOT NULL REFERENCES public.outlet_stock_movements(id) ON DELETE RESTRICT,

  central_item_id                   uuid REFERENCES public.central_items(id) ON DELETE RESTRICT,

  scientific_name                    text NOT NULL,
  trade_name                          text,
  concentration                        text,
  dosage_form                          text,
  unit                                  text,
  national_code                         text,
  has_no_national_code                  boolean NOT NULL DEFAULT false,
  batch_number                          text,
  has_no_batch_number                    boolean NOT NULL DEFAULT false,
  internal_batch_reference                text,
  expiry_date                             date,
  unit_price                               numeric(20,3),
  price_basis                               text,
  currency                                   text,
  supply_type_text                            text,

  sent_quantity                 integer NOT NULL,
  received_quantity              integer,
  status                          text NOT NULL DEFAULT 'in_transit',
  difference_reason                text,

  disposition                       text,
  custody_state                      text NOT NULL DEFAULT 'in_transit',

  received_by                        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  received_at                         timestamptz,
  resulting_warehouse_stock_id         uuid REFERENCES public.warehouse_stock(id) ON DELETE SET NULL,
  resulting_quarantine_stock_id         uuid REFERENCES public.warehouse_quarantine_stock(id) ON DELETE SET NULL,

  created_at                            timestamptz NOT NULL DEFAULT now(),
  updated_at                             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT orsl_shipment_org_fk
    FOREIGN KEY (shipment_id, source_organization_id)
    REFERENCES public.outlet_return_shipments (id, source_organization_id) ON DELETE CASCADE,

  CONSTRAINT orsl_stock_org_fk
    FOREIGN KEY (source_outlet_stock_id, source_organization_id)
    REFERENCES public.outlet_stock (id, organization_id) ON DELETE RESTRICT,

  -- Same proven chain as the request line (section 5): the shipment line's
  -- provenance is pinned structurally, not merely carried. movement produced by
  -- this dispatch line, movement credited this stock, dispatch line resulted in
  -- this stock — no unrelated combination can be shipped.
  CONSTRAINT orsl_movement_from_dispatch_line_fk
    FOREIGN KEY (original_inbound_movement_id, original_dispatch_line_id)
    REFERENCES public.outlet_stock_movements (id, dispatch_line_id)
    ON DELETE RESTRICT,
  CONSTRAINT orsl_movement_stock_fk
    FOREIGN KEY (original_inbound_movement_id, source_outlet_stock_id)
    REFERENCES public.outlet_stock_movements (id, outlet_stock_id)
    ON DELETE RESTRICT,
  CONSTRAINT orsl_dispatch_line_stock_fk
    FOREIGN KEY (original_dispatch_line_id, source_outlet_stock_id)
    REFERENCES public.warehouse_dispatch_lines (id, resulting_outlet_stock_id)
    ON DELETE RESTRICT,

  CONSTRAINT orsl_status_chk
    CHECK (status IN ('in_transit', 'received', 'received_with_difference', 'rejected')),

  CONSTRAINT orsl_sci_name_chk
    CHECK (btrim(scientific_name) = scientific_name AND scientific_name <> ''),
  CONSTRAINT orsl_sent_qty_chk      CHECK (sent_quantity > 0),
  CONSTRAINT orsl_received_qty_chk  CHECK (received_quantity IS NULL OR received_quantity >= 0),
  CONSTRAINT orsl_received_le_sent_chk
    CHECK (received_quantity IS NULL OR received_quantity <= sent_quantity),
  CONSTRAINT orsl_unit_price_chk    CHECK (unit_price IS NULL OR unit_price >= 0),

  CONSTRAINT orsl_has_no_national_code_chk
    CHECK (has_no_national_code = (national_code IS NULL)),
  CONSTRAINT orsl_has_no_batch_number_chk
    CHECK (has_no_batch_number = (batch_number IS NULL)),

  CONSTRAINT orsl_disposition_chk
    CHECK (disposition IS NULL OR disposition IN ('restockable', 'quarantined')),
  CONSTRAINT orsl_custody_state_chk
    CHECK (custody_state IN (
      'in_transit', 'destination_stock', 'destination_quarantine', 'exception_pending'
    )),

  CONSTRAINT orsl_decision_chk
    CHECK (
      CASE status
        WHEN 'in_transit' THEN
          received_quantity IS NULL AND received_at IS NULL AND difference_reason IS NULL
          AND disposition IS NULL AND custody_state = 'in_transit'
        WHEN 'received' THEN
          received_quantity = sent_quantity AND received_at IS NOT NULL
          AND (
            (disposition = 'restockable'  AND custody_state = 'destination_stock')
            OR
            (disposition = 'quarantined' AND custody_state = 'destination_quarantine')
          )
        WHEN 'received_with_difference' THEN
          received_quantity IS NOT NULL AND received_quantity < sent_quantity
          AND received_at IS NOT NULL
          AND difference_reason IS NOT NULL AND btrim(difference_reason) <> ''
          AND (
            (disposition = 'restockable'  AND custody_state = 'destination_stock')
            OR
            (disposition = 'quarantined' AND custody_state = 'destination_quarantine')
          )
        WHEN 'rejected' THEN
          received_quantity = 0 AND received_at IS NOT NULL
          AND difference_reason IS NOT NULL AND btrim(difference_reason) <> ''
          AND disposition IS NULL AND custody_state = 'exception_pending'
        ELSE false
      END
    ),

  -- Literal conservation equation — same shape as 069's wrsl_conservation_eq_chk.
  CONSTRAINT orsl_conservation_eq_chk
    CHECK (
      status = 'in_transit'
      OR sent_quantity =
           (CASE WHEN status IN ('received', 'received_with_difference')
                      AND disposition = 'restockable'
                 THEN received_quantity ELSE 0 END)
         + (CASE WHEN status IN ('received', 'received_with_difference')
                      AND disposition = 'quarantined'
                 THEN received_quantity ELSE 0 END)
         + (CASE WHEN status = 'rejected' THEN sent_quantity ELSE 0 END)
         + (CASE WHEN status = 'received_with_difference'
                 THEN sent_quantity - received_quantity ELSE 0 END)
    )
);

CREATE INDEX IF NOT EXISTS orsl_shipment_idx ON public.outlet_return_shipment_lines (shipment_id);
CREATE INDEX IF NOT EXISTS orsl_stock_idx    ON public.outlet_return_shipment_lines (source_outlet_stock_id);
CREATE INDEX IF NOT EXISTS orsl_reqline_idx  ON public.outlet_return_shipment_lines (return_request_line_id);
CREATE INDEX IF NOT EXISTS orsl_in_transit_idx
  ON public.outlet_return_shipment_lines (shipment_id) WHERE status = 'in_transit';

COMMENT ON TABLE public.outlet_return_shipment_lines IS
  'OUTLET-TO-INSTITUTION-RETURN-071-A: one returned batch per line, SINGLE proven '
  'provenance (dispatch line + its dispatch_receive movement + shared '
  'outlet_stock, pinned by composite FKs), literal conservation equation, no '
  'expiry-refusal check at send (mirrors 069''s named divergence). RECEIVE '
  'classification is fail-closed, identical policy to 069.';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.outlet_return_shipment_lines
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 8. Idempotency for return movements — reusing 067's/069's ledger contract
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS outlet_stock_movements_return_once_uniq
  ON public.outlet_stock_movements (reference_id)
  WHERE reference_type = 'outlet_return_send' AND reference_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS warehouse_stock_movements_outlet_return_once_uniq
  ON public.warehouse_stock_movements (reference_id)
  WHERE reference_type = 'outlet_return_receive' AND reference_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS wqsm_outlet_return_once_uniq
  ON public.warehouse_quarantine_stock_movements (reference_id)
  WHERE reference_type = 'outlet_return_quarantine_receive' AND reference_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE public.outlet_stock_movements
    ADD CONSTRAINT osm_outlet_return_fingerprint_chk
    CHECK (
      reference_type IS DISTINCT FROM 'outlet_return_send'
      OR (request_fingerprint IS NOT NULL AND request_fingerprint ~ '^[0-9a-f]{64}$')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.warehouse_stock_movements
    ADD CONSTRAINT wsm_outlet_return_fingerprint_chk
    CHECK (
      reference_type IS DISTINCT FROM 'outlet_return_receive'
      OR (request_fingerprint IS NOT NULL AND request_fingerprint ~ '^[0-9a-f]{64}$')
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS outlet_stock_movements_return_line_once_uniq
  ON public.outlet_stock_movements (reference_id)
  WHERE reference_type = 'outlet_return_shipment_line' AND reference_id IS NOT NULL;

-- ============================================================================
-- 9. Permission keys
-- ============================================================================
-- outlet_stock.return already exists (066) and is exactly the outlet-side
-- "physically send a return" key outlet_officer already holds — reused
-- verbatim for SEND, never widened, never duplicated.
INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous) VALUES
  ('outlet_stock.return_request', 'outlet_stock', 'return_request', 'Request a return to the institution', 'طلب إرجاع إلى المؤسسة',   false),
  ('outlet_stock.recall',         'outlet_stock', 'recall',         'Recall stock from an outlet',          'استدعاء مخزون من منفذ',   false),
  ('outlet_stock.review_return',  'outlet_stock', 'review_return',  'Review an outlet return request',      'مراجعة طلب إرجاع منفذ',   false),
  ('outlet_stock.return_receive', 'outlet_stock', 'return_receive', 'Receive an outlet return at the warehouse', 'استلام إرجاع منفذ في المخزن', false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
SELECT 'super_admin', k.key, true
FROM public.permission_keys k
WHERE k.key LIKE 'outlet_stock.%'
ON CONFLICT (role, permission_key) DO NOTHING;

-- Separation of duty: the outlet may ask for and execute a return (never
-- recall/review/receive it); the institution (warehouse_officer) may recall,
-- review and receive (never request or execute the physical send) — mirrors
-- 069's send/receive split exactly.
INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  ('outlet_officer',            'outlet_stock.return_request', true),
  ('outlet_officer',            'outlet_stock.recall',         false),
  ('outlet_officer',            'outlet_stock.review_return',  false),
  ('outlet_officer',            'outlet_stock.return_receive', false),
  ('warehouse_officer',         'outlet_stock.return_request', false),
  ('warehouse_officer',         'outlet_stock.recall',         true),
  ('warehouse_officer',         'outlet_stock.review_return',  true),
  ('warehouse_officer',         'outlet_stock.return_receive', true),
  ('warehouse_officer',         'outlet_stock.return',         false),
  ('central_warehouse_manager', 'outlet_stock.return_request', false),
  ('central_warehouse_manager', 'outlet_stock.recall',         false),
  ('central_warehouse_manager', 'outlet_stock.review_return',  false),
  ('central_warehouse_manager', 'outlet_stock.return_receive', false)
ON CONFLICT (role, permission_key) DO NOTHING;

INSERT INTO public.role_permission_defaults (role, permission_key, allowed)
SELECT r.role, k.key, false
FROM (VALUES ('institution_admin'),('port_officer'),('monthly_status_officer'),('viewer'),
             ('hospital_admin'),('warehouse_manager'),('point_operator'),('transfer_manager')) AS r(role)
CROSS JOIN (VALUES ('outlet_stock.return_request'),('outlet_stock.recall'),
                   ('outlet_stock.review_return'),('outlet_stock.return_receive')) AS k(key)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ============================================================================
-- 10. RETURN REQUEST LIFECYCLE — either side asks, institution always reviews
-- ============================================================================

-- 10a. REQUEST (receiver-initiated) — the outlet asks to send stock back.
CREATE OR REPLACE FUNCTION public.phoenix_request_outlet_return(
  p_distribution_point_id uuid,
  p_return_number         text,
  p_notes                 text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_point       public.distribution_points%ROWTYPE;
  v_number      text := NULLIF(btrim(p_return_number), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_request     public.outlet_return_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_distribution_point_id IS NULL THEN
    RAISE EXCEPTION 'distribution_point_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'return_number_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_distribution_point_id::text, 70070));

  SELECT * INTO v_point
  FROM public.distribution_points WHERE id = p_distribution_point_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'distribution_point_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_point.status <> 'active' THEN
    RAISE EXCEPTION 'distribution_point_inactive' USING ERRCODE = '23514';
  END IF;
  -- No configured warehouse_id: this outlet cannot open a return. A clear,
  -- named absence — never a silent bypass to some other warehouse.
  IF v_point.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'distribution_point_has_no_return_warehouse' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.return_request', v_point.organization_id, NULL, p_distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_return_request' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.outlet_return_requests (
    distribution_point_id, source_organization_id,
    destination_warehouse_id, destination_organization_id,
    return_number, status, requested_by_side, notes, created_by
  ) VALUES (
    p_distribution_point_id, v_point.organization_id,
    v_point.warehouse_id, v_point.organization_id,
    v_number, 'draft', 'receiver', v_notes, v_actor
  )
  RETURNING * INTO v_request;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_point.organization_id, v_actor, v_actor_role,
    'outlet_stock.return_requested', 'outlet_return_requests', v_request.id, v_number,
    jsonb_build_object('distribution_point_id', p_distribution_point_id)
  );

  RETURN jsonb_build_object('ok', true, 'return_request_id', v_request.id, 'status', v_request.status);
END;
$$;

-- 10b. RECALL (sender-initiated) — the institution asks the outlet to send
-- stock back.
CREATE OR REPLACE FUNCTION public.phoenix_recall_outlet_stock(
  p_distribution_point_id uuid,
  p_return_number         text,
  p_notes                 text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor       uuid := auth.uid();
  v_actor_role  text;
  v_point       public.distribution_points%ROWTYPE;
  v_number      text := NULLIF(btrim(p_return_number), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_request     public.outlet_return_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_distribution_point_id IS NULL THEN
    RAISE EXCEPTION 'distribution_point_id_required' USING ERRCODE = '23514';
  END IF;
  IF v_number IS NULL THEN
    RAISE EXCEPTION 'return_number_required' USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_distribution_point_id::text, 70070));

  SELECT * INTO v_point
  FROM public.distribution_points WHERE id = p_distribution_point_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'distribution_point_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_point.status <> 'active' THEN
    RAISE EXCEPTION 'distribution_point_inactive' USING ERRCODE = '23514';
  END IF;
  IF v_point.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'distribution_point_has_no_return_warehouse' USING ERRCODE = '23514';
  END IF;

  -- THE IDOR GATE for recall: scoped to the WAREHOUSE (institution side),
  -- taken from the locked point row, never a caller-supplied warehouse id.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.recall', v_point.organization_id, v_point.warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_recall' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.outlet_return_requests (
    distribution_point_id, source_organization_id,
    destination_warehouse_id, destination_organization_id,
    return_number, status, requested_by_side, notes, created_by
  ) VALUES (
    p_distribution_point_id, v_point.organization_id,
    v_point.warehouse_id, v_point.organization_id,
    v_number, 'draft', 'sender', v_notes, v_actor
  )
  RETURNING * INTO v_request;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_point.organization_id, v_actor, v_actor_role,
    'outlet_stock.recalled', 'outlet_return_requests', v_request.id, v_number,
    jsonb_build_object('distribution_point_id', p_distribution_point_id)
  );

  RETURN jsonb_build_object('ok', true, 'return_request_id', v_request.id, 'status', v_request.status);
END;
$$;

-- 10c. ADD LINE (draft only) — SINGLE proven provenance. The caller names ONLY
-- the original 070 dispatch line; the RPC DERIVES its matching 'dispatch_receive'
-- movement and the shared outlet_stock row, proves the material/batch/expiry
-- match, and caps the return at the accepted-but-not-yet-returned quantity. No
-- 'add', no XOR, no legacy movement path.
CREATE OR REPLACE FUNCTION public.phoenix_add_outlet_return_request_line(
  p_return_request_id           uuid,
  p_original_dispatch_line_id    uuid DEFAULT NULL,
  p_requested_quantity           integer DEFAULT NULL,
  p_reason_code                  text DEFAULT NULL,
  p_reason_text                  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor        uuid := auth.uid();
  v_actor_role   text;
  v_request      public.outlet_return_requests%ROWTYPE;
  v_dispatch     public.warehouse_dispatch_lines%ROWTYPE;
  v_movement     public.outlet_stock_movements%ROWTYPE;
  v_stock        public.outlet_stock%ROWTYPE;
  v_reason_text  text := NULLIF(btrim(p_reason_text), '');
  v_line         public.outlet_return_request_lines%ROWTYPE;
  v_cap          integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_return_request_id IS NULL THEN
    RAISE EXCEPTION 'return_request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_original_dispatch_line_id IS NULL THEN
    RAISE EXCEPTION 'original_dispatch_line_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_requested_quantity IS NULL OR p_requested_quantity <= 0 THEN
    RAISE EXCEPTION 'requested_quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;
  IF p_reason_code IS NULL OR p_reason_code NOT IN (
    'excess', 'shipment_error', 'near_expiry', 'expired', 'damaged',
    'recalled', 'quality_issue', 'temperature_excursion', 'other'
  ) THEN
    RAISE EXCEPTION 'invalid_reason_code' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_request
  FROM public.outlet_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'return_request_not_editable' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.return_request', v_request.source_organization_id,
    NULL, v_request.distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_return_request' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- The dispatch line must be a REAL, accepted 070 receipt at THIS outlet.
  SELECT * INTO v_dispatch
  FROM public.warehouse_dispatch_lines WHERE id = p_original_dispatch_line_id FOR UPDATE;
  IF NOT FOUND OR v_dispatch.organization_id <> v_request.source_organization_id THEN
    RAISE EXCEPTION 'original_dispatch_line_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_dispatch.status NOT IN ('accepted', 'accepted_with_difference')
     OR v_dispatch.resulting_outlet_stock_id IS NULL THEN
    RAISE EXCEPTION 'original_dispatch_line_not_a_completed_receipt' USING ERRCODE = '23514';
  END IF;

  -- The outlet_stock row that dispatch line actually resulted in — and it must
  -- physically sit at THIS request's outlet.
  SELECT * INTO v_stock
  FROM public.outlet_stock WHERE id = v_dispatch.resulting_outlet_stock_id;
  IF NOT FOUND OR v_stock.distribution_point_id <> v_request.distribution_point_id THEN
    RAISE EXCEPTION 'original_dispatch_line_not_at_this_outlet' USING ERRCODE = '23514';
  END IF;

  -- DERIVE the matching 'dispatch_receive' movement 070's RECEIVE wrote for this
  -- exact dispatch line (there is exactly one per accepted line; a rejected line
  -- has none and was already excluded above). Never client-supplied.
  SELECT * INTO v_movement
  FROM public.outlet_stock_movements
  WHERE dispatch_line_id = v_dispatch.id
    AND movement_type = 'dispatch_receive'
    AND outlet_stock_id = v_stock.id
    AND organization_id = v_request.source_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_receive_movement_not_found_for_line' USING ERRCODE = 'P0002';
  END IF;

  -- Material/batch/expiry must be IDENTICAL between the dispatch line's own
  -- snapshots and the resulting outlet_stock row. They always are when produced
  -- by 070's RECEIVE; asserting it makes a future divergence fail loudly rather
  -- than silently return a mismatched batch.
  IF v_dispatch.scientific_name IS DISTINCT FROM v_stock.scientific_name
     OR COALESCE(v_dispatch.concentration,'') IS DISTINCT FROM COALESCE(v_stock.concentration,'')
     OR COALESCE(v_dispatch.dosage_form,'')   IS DISTINCT FROM COALESCE(v_stock.dosage_form,'')
     OR COALESCE(v_dispatch.national_code,'') IS DISTINCT FROM COALESCE(v_stock.national_code,'')
     OR COALESCE(v_dispatch.batch_number,'')  IS DISTINCT FROM COALESCE(v_stock.batch_number,'')
     OR COALESCE(v_dispatch.internal_batch_reference,'') IS DISTINCT FROM COALESCE(v_stock.internal_batch_reference,'')
     OR v_dispatch.expiry_date IS DISTINCT FROM v_stock.expiry_date THEN
    RAISE EXCEPTION 'provenance_material_batch_expiry_mismatch' USING ERRCODE = '23514';
  END IF;

  -- Cap: the accepted-but-not-yet-returned quantity on THIS dispatch line.
  v_cap := COALESCE(v_dispatch.received_quantity, 0) - v_dispatch.returned_quantity;
  IF p_requested_quantity > v_cap THEN
    RAISE EXCEPTION 'requested_quantity_exceeds_returnable_cap' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.outlet_return_request_lines (
    return_request_id, source_organization_id,
    original_dispatch_line_id, original_inbound_movement_id,
    original_inbound_movement_type, source_outlet_stock_id,
    scientific_name, concentration, dosage_form, unit, national_code,
    batch_number, internal_batch_reference, expiry_date,
    reason_code, reason_text, requested_quantity
  ) VALUES (
    p_return_request_id, v_request.source_organization_id,
    v_dispatch.id, v_movement.id,
    'dispatch_receive', v_stock.id,
    v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form, v_stock.unit,
    v_stock.national_code, v_stock.batch_number, v_stock.internal_batch_reference, v_stock.expiry_date,
    p_reason_code, v_reason_text, p_requested_quantity
  )
  RETURNING * INTO v_line;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_request.source_organization_id, v_actor, v_actor_role,
    'outlet_stock.return_line_added', 'outlet_return_request_lines', v_line.id, v_line.scientific_name,
    jsonb_build_object(
      'return_request_id', p_return_request_id,
      'original_dispatch_line_id', v_dispatch.id,
      'original_inbound_movement_id', v_movement.id,
      'source_outlet_stock_id', v_stock.id,
      'reason_code', p_reason_code,
      'requested_quantity', p_requested_quantity
    )
  );

  RETURN jsonb_build_object('ok', true, 'return_request_line_id', v_line.id);
END;
$$;

-- 10d. DELETE LINE (draft only).
CREATE OR REPLACE FUNCTION public.phoenix_delete_outlet_return_request_line(
  p_return_request_line_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor   uuid := auth.uid();
  v_actor_role text;
  v_line    public.outlet_return_request_lines%ROWTYPE;
  v_request public.outlet_return_requests%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_return_request_line_id IS NULL THEN
    RAISE EXCEPTION 'return_request_line_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_line
  FROM public.outlet_return_request_lines WHERE id = p_return_request_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_request
  FROM public.outlet_return_requests WHERE id = v_line.return_request_id FOR UPDATE;
  IF NOT FOUND OR v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'return_request_not_editable' USING ERRCODE = '23514';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.return_request', v_request.source_organization_id,
    NULL, v_request.distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_return_request' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.outlet_return_request_lines WHERE id = v_line.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_request.source_organization_id, v_actor, v_actor_role,
    'outlet_stock.return_line_deleted', 'outlet_return_request_lines', v_line.id, v_line.scientific_name,
    jsonb_build_object('return_request_id', v_request.id)
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- 10e. SUBMIT (draft -> submitted). Either side that opened it may submit.
CREATE OR REPLACE FUNCTION public.phoenix_submit_outlet_return_request(
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
  v_request    public.outlet_return_requests%ROWTYPE;
  v_perm_key   text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_return_request_id IS NULL THEN
    RAISE EXCEPTION 'return_request_id_required' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_request
  FROM public.outlet_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_request.status <> 'draft' THEN
    RAISE EXCEPTION 'return_request_not_submittable' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.outlet_return_request_lines WHERE return_request_id = v_request.id
  ) THEN
    RAISE EXCEPTION 'return_request_has_no_lines' USING ERRCODE = '23514';
  END IF;

  v_perm_key := CASE v_request.requested_by_side
                  WHEN 'receiver' THEN 'outlet_stock.return_request'
                  ELSE 'outlet_stock.recall'
                END;

  IF v_request.requested_by_side = 'receiver' THEN
    IF NOT public.phoenix_profile_has_scoped_permission(
      v_actor, v_perm_key, v_request.source_organization_id, NULL, v_request.distribution_point_id
    ) THEN
      RAISE EXCEPTION 'forbidden_outlet_return_submit' USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT public.phoenix_profile_has_scoped_permission(
      v_actor, v_perm_key, v_request.source_organization_id, v_request.destination_warehouse_id, NULL
    ) THEN
      RAISE EXCEPTION 'forbidden_outlet_return_submit' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.outlet_return_requests
     SET status = 'submitted', requested_by = v_actor, requested_at = now()
   WHERE id = v_request.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_request.source_organization_id, v_actor, v_actor_role,
    'outlet_stock.return_submitted', 'outlet_return_requests', v_request.id, v_request.return_number,
    '{}'::jsonb
  );

  RETURN jsonb_build_object('ok', true, 'status', 'submitted');
END;
$$;

-- 10f. CANCEL — draft/submitted only, exactly 069's rule.
CREATE OR REPLACE FUNCTION public.phoenix_cancel_outlet_return_request(
  p_return_request_id uuid,
  p_cancellation_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_request    public.outlet_return_requests%ROWTYPE;
  v_reason     text := NULLIF(btrim(p_cancellation_reason), '');
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

  SELECT * INTO v_request
  FROM public.outlet_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;
  -- Cancel is allowed only BEFORE review/approval — never after, never once
  -- physical movement may have begun. Same rule as 069.
  IF v_request.status NOT IN ('draft', 'submitted') THEN
    RAISE EXCEPTION 'return_request_not_cancellable' USING ERRCODE = '23514';
  END IF;

  IF NOT (
    public.phoenix_profile_has_scoped_permission(
      v_actor, 'outlet_stock.return_request', v_request.source_organization_id,
      NULL, v_request.distribution_point_id
    )
    OR public.phoenix_profile_has_scoped_permission(
      v_actor, 'outlet_stock.recall', v_request.source_organization_id,
      v_request.destination_warehouse_id, NULL
    )
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_return_cancel' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.outlet_return_requests
     SET status = 'cancelled', cancelled_by = v_actor, cancelled_at = now(),
         cancellation_reason = v_reason
   WHERE id = v_request.id;

  UPDATE public.outlet_return_request_lines
     SET status = 'cancelled'
   WHERE return_request_id = v_request.id AND status IN ('pending', 'approved');

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_request.source_organization_id, v_actor, v_actor_role,
    'outlet_stock.return_cancelled', 'outlet_return_requests', v_request.id, v_request.return_number,
    jsonb_build_object('reason', v_reason)
  );

  RETURN jsonb_build_object('ok', true, 'status', 'cancelled');
END;
$$;

-- 10g. REVIEW — always the institution, atomic across every pending line.
CREATE OR REPLACE FUNCTION public.phoenix_review_outlet_return_request(
  p_return_request_id uuid,
  p_decisions          jsonb   -- [{ "line_id": uuid, "approved_quantity": integer }]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_actor_role text;
  v_request    public.outlet_return_requests%ROWTYPE;
  v_decision   jsonb;
  v_line       public.outlet_return_request_lines%ROWTYPE;
  v_approved   integer;
  v_any_approved boolean := false;
  v_any_rejected boolean := false;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_return_request_id IS NULL THEN
    RAISE EXCEPTION 'return_request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_decisions IS NULL OR jsonb_typeof(p_decisions) <> 'array' THEN
    RAISE EXCEPTION 'decisions_must_be_an_array' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_request
  FROM public.outlet_return_requests WHERE id = p_return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_request.status <> 'submitted' THEN
    RAISE EXCEPTION 'return_request_not_reviewable' USING ERRCODE = '23514';
  END IF;

  -- THE IDOR GATE: always scoped to the institution's WAREHOUSE, never the
  -- outlet, regardless of who originally opened the request.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.review_return', v_request.destination_organization_id,
    v_request.destination_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_review_return' USING ERRCODE = '42501';
  END IF;

  SELECT p.role INTO v_actor_role FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  FOR v_decision IN SELECT * FROM jsonb_array_elements(p_decisions) LOOP
    SELECT * INTO v_line
    FROM public.outlet_return_request_lines
    WHERE id = (v_decision->>'line_id')::uuid
      AND return_request_id = v_request.id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'return_request_line_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_line.status <> 'pending' THEN
      RAISE EXCEPTION 'return_request_line_not_pending' USING ERRCODE = '23514';
    END IF;

    v_approved := (v_decision->>'approved_quantity')::integer;
    IF v_approved IS NULL OR v_approved < 0 OR v_approved > v_line.requested_quantity THEN
      RAISE EXCEPTION 'invalid_approved_quantity' USING ERRCODE = '23514';
    END IF;

    IF v_approved = 0 THEN
      UPDATE public.outlet_return_request_lines
         SET status = 'rejected', approved_quantity = 0 WHERE id = v_line.id;
      v_any_rejected := true;
    ELSE
      UPDATE public.outlet_return_request_lines
         SET status = 'approved', approved_quantity = v_approved WHERE id = v_line.id;
      v_any_approved := true;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM public.outlet_return_request_lines
    WHERE return_request_id = v_request.id AND status = 'pending'
  ) THEN
    UPDATE public.outlet_return_requests
       SET status = CASE
                       WHEN v_any_approved AND v_any_rejected THEN 'partially_approved'
                       WHEN v_any_approved THEN 'approved'
                       ELSE 'rejected'
                     END,
           reviewed_by = v_actor, reviewed_at = now()
     WHERE id = v_request.id;
  END IF;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_request.destination_organization_id, v_actor, v_actor_role,
    'outlet_stock.return_reviewed', 'outlet_return_requests', v_request.id, v_request.return_number,
    jsonb_build_object('decisions', p_decisions)
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ============================================================================
-- 11. STOCK-MOVING RPCs
-- ============================================================================

-- 11a. SEND — the outlet physically sends the return. NO expiry refusal
-- (mirrors 069's named divergence for the same reason: a return is
-- frequently OF an expired/unsound batch, going back to the party equipped
-- to dispose of or credit it).
CREATE OR REPLACE FUNCTION public.phoenix_send_outlet_return_shipment_line(
  p_request_id          uuid,
  p_return_request_line_id uuid,
  p_shipment_id           uuid,
  p_quantity              integer,
  p_shipment_number       text DEFAULT NULL,
  p_document_number       text DEFAULT NULL,
  p_notes                 text DEFAULT NULL
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
  v_line         public.outlet_return_request_lines%ROWTYPE;
  v_request      public.outlet_return_requests%ROWTYPE;
  v_stock        public.outlet_stock%ROWTYPE;
  v_shipment     public.outlet_return_shipments%ROWTYPE;
  v_existing     public.outlet_stock_movements%ROWTYPE;
  v_notes        text := NULLIF(btrim(p_notes), '');
  v_document     text := NULLIF(btrim(p_document_number), '');
  v_number       text := NULLIF(btrim(p_shipment_number), '');
  v_before       integer;
  v_after        integer;
  v_movement_id  uuid;
  v_shipment_line_id uuid;
  v_fingerprint  text;
  v_avail_id     uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL OR p_return_request_line_id IS NULL THEN
    RAISE EXCEPTION 'request_id_and_line_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'outlet_return_send',
    'return_request_line_id', p_return_request_line_id,
    'shipment_id', p_shipment_id,
    'quantity', p_quantity,
    'shipment_number', v_number,
    'document_number', v_document,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 70070));

  SELECT * INTO v_existing
  FROM public.outlet_stock_movements m
  WHERE m.reference_type = 'outlet_return_send' AND m.reference_id = p_request_id;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  -- Lock the ORIGINAL request line — re-validated live, exactly as 069 does
  -- for warehouse_transfer_lines, so a second concurrent send cannot both
  -- pass the same cap.
  SELECT * INTO v_line
  FROM public.outlet_return_request_lines WHERE id = p_return_request_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_line_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_line.status NOT IN ('approved', 'partially_fulfilled') THEN
    RAISE EXCEPTION 'return_request_line_not_approved' USING ERRCODE = '23514';
  END IF;
  IF v_line.fulfilled_quantity + p_quantity > v_line.approved_quantity THEN
    RAISE EXCEPTION 'quantity_exceeds_approved_remainder' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_request
  FROM public.outlet_return_requests WHERE id = v_line.return_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_request_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Resolve the SOURCE outlet_stock row — the SINGLE row the line's proven
  -- provenance already pinned (source_outlet_stock_id). No XOR branch: the
  -- composite FKs guarantee this stock is the one both the dispatch line and its
  -- dispatch_receive movement refer to.
  SELECT s.* INTO v_stock FROM public.outlet_stock s
  WHERE s.id = v_line.source_outlet_stock_id
  FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source_outlet_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- THE IDOR GATE: authority is scoped to the outlet the LOCKED stock row
  -- actually belongs to, never a caller-supplied point id.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.return', v_stock.organization_id, NULL, v_stock.distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_return_send' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  IF v_stock.on_hand_quantity - v_stock.reserved_quantity < p_quantity THEN
    RAISE EXCEPTION 'insufficient_available_quantity' USING ERRCODE = '23514';
  END IF;

  -- Resolve or create the shipment header.
  IF p_shipment_id IS NOT NULL THEN
    SELECT * INTO v_shipment
    FROM public.outlet_return_shipments WHERE id = p_shipment_id FOR UPDATE;
    IF NOT FOUND OR v_shipment.status <> 'in_transit'
       OR v_shipment.distribution_point_id <> v_stock.distribution_point_id THEN
      RAISE EXCEPTION 'outlet_return_shipment_not_open' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF v_number IS NULL THEN
      RAISE EXCEPTION 'shipment_number_required' USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.outlet_return_shipments (
      return_request_id, distribution_point_id, source_organization_id,
      destination_warehouse_id, destination_organization_id,
      shipment_number, document_number, notes, sent_by
    ) VALUES (
      v_request.id, v_stock.distribution_point_id, v_stock.organization_id,
      v_request.destination_warehouse_id, v_request.destination_organization_id,
      v_number, v_document, v_notes, v_actor
    )
    RETURNING * INTO v_shipment;
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before - p_quantity;

  UPDATE public.outlet_stock
     SET on_hand_quantity = v_after, updated_by = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.outlet_stock_movements (
    outlet_stock_id, organization_id, distribution_point_id, movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reference_type, reference_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot, dosage_form_snapshot,
    batch_number_snapshot, internal_batch_reference_snapshot, expiry_date_snapshot
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.distribution_point_id, 'return_send',
    v_before, -p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    'outlet_return', 'outlet_return_send', p_request_id, v_fingerprint,
    v_shipment.document_number, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form,
    v_stock.batch_number, v_stock.internal_batch_reference, v_stock.expiry_date
  )
  RETURNING id INTO v_movement_id;

  -- Keep the public availability projection in sync — the same call every
  -- other outlet-mutating RPC in 067 makes. Skipping this would leave
  -- item_availability showing STALE, too-high stock after a return leaves.
  v_avail_id := public.phoenix_project_outlet_availability(v_stock.id);

  INSERT INTO public.outlet_return_shipment_lines (
    shipment_id, source_organization_id, source_outlet_stock_id,
    return_request_line_id,
    original_dispatch_line_id, original_inbound_movement_id,
    central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code, batch_number, has_no_batch_number,
    internal_batch_reference, expiry_date, unit_price, price_basis, currency, supply_type_text,
    sent_quantity
  ) VALUES (
    v_shipment.id, v_stock.organization_id, v_stock.id,
    v_line.id,
    v_line.original_dispatch_line_id, v_line.original_inbound_movement_id,
    v_stock.central_item_id,
    v_stock.scientific_name, v_stock.trade_name, v_stock.concentration, v_stock.dosage_form, v_stock.unit,
    v_stock.national_code, v_stock.has_no_national_code, v_stock.batch_number, v_stock.has_no_batch_number,
    v_stock.internal_batch_reference, v_stock.expiry_date, v_stock.unit_price, v_stock.price_basis,
    v_stock.currency, v_stock.supply_type_text,
    p_quantity
  )
  RETURNING id INTO v_shipment_line_id;

  -- Consume the return cap on the dispatch line — the single authoritative
  -- source (received_quantity - returned_quantity). Locked FOR UPDATE above so
  -- two concurrent sends cannot both pass the same cap. wdl_returned_qty_chk
  -- (returned_quantity <= received_quantity) is the structural backstop.
  UPDATE public.warehouse_dispatch_lines
     SET returned_quantity = returned_quantity + p_quantity
   WHERE id = v_line.original_dispatch_line_id;

  UPDATE public.outlet_return_request_lines
     SET fulfilled_quantity = fulfilled_quantity + p_quantity,
         status = CASE WHEN fulfilled_quantity + p_quantity = approved_quantity
                        THEN 'fulfilled' ELSE 'partially_fulfilled' END
   WHERE id = v_line.id;

  UPDATE public.outlet_return_shipments
     SET status = 'in_transit'
   WHERE id = v_shipment.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_stock.organization_id, v_actor, v_actor_role,
    'outlet_stock.return_sent', 'outlet_return_shipment_lines', v_shipment_line_id, v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id, 'shipment_id', v_shipment.id,
      'movement_id', v_movement_id, 'quantity_before', v_before,
      'quantity_delta', -p_quantity, 'quantity_after', v_after
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'shipment_id', v_shipment.id, 'shipment_line_id', v_shipment_line_id,
    'movement_id', v_movement_id, 'item_availability_id', v_avail_id,
    'quantity_before', v_before, 'quantity_delta', -p_quantity, 'quantity_after', v_after
  );
END;
$$;

-- 11b. RECEIVE — the institution receives it back. Disposition classification
-- is FAIL-CLOSED, identical policy to 069's phoenix_receive_warehouse_return_
-- shipment_line: expired/damaged/recalled/quality_issue/temperature_excursion/
-- other/NULL reason_code -> ALWAYS quarantined, never client-overridable;
-- near_expiry/excess/shipment_error -> require an explicit
-- p_disposition_decision, no default in either direction.
CREATE OR REPLACE FUNCTION public.phoenix_receive_outlet_return_shipment_line(
  p_request_id           uuid,
  p_shipment_line_id      uuid,
  p_received_quantity     integer,
  p_difference_reason     text DEFAULT NULL,
  p_notes                 text DEFAULT NULL,
  p_disposition_decision  text DEFAULT NULL
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
  v_line         public.outlet_return_shipment_lines%ROWTYPE;
  v_shipment     public.outlet_return_shipments%ROWTYPE;
  v_orig_dispatch public.warehouse_dispatch_lines%ROWTYPE;
  v_stock        public.warehouse_stock%ROWTYPE;
  v_quarantine   public.warehouse_quarantine_stock%ROWTYPE;
  v_existing     public.warehouse_stock_movements%ROWTYPE;
  v_existing_q   public.warehouse_quarantine_stock_movements%ROWTYPE;
  v_reason       text := NULLIF(btrim(p_difference_reason), '');
  v_notes        text := NULLIF(btrim(p_notes), '');
  v_internal     text;
  v_before       integer;
  v_after        integer;
  v_movement_id  uuid;
  v_status       text;
  v_fingerprint  text;
  v_reason_code  text;
  v_objectively_expired boolean;
  v_mandatory_quarantine boolean;
  v_disposition  text;
  v_custody      text;
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
  IF p_disposition_decision IS NOT NULL AND p_disposition_decision NOT IN ('restockable', 'quarantined') THEN
    RAISE EXCEPTION 'invalid_disposition_decision' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'outlet_return_receive',
    'shipment_line_id', p_shipment_line_id,
    'received_quantity', p_received_quantity,
    'difference_reason', v_reason,
    'notes', v_notes,
    'disposition_decision', p_disposition_decision
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 70070));

  SELECT * INTO v_existing
  FROM public.warehouse_stock_movements m
  WHERE m.reference_type = 'outlet_return_receive' AND m.reference_id = p_request_id;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true, 'disposition', 'restockable',
      'warehouse_stock_id', v_existing.warehouse_stock_id, 'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before, 'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  SELECT * INTO v_existing_q
  FROM public.warehouse_quarantine_stock_movements m
  WHERE m.reference_type = 'outlet_return_quarantine_receive' AND m.reference_id = p_request_id;
  IF FOUND THEN
    IF v_existing_q.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true, 'disposition', 'quarantined',
      'quarantine_stock_id', v_existing_q.quarantine_stock_id, 'movement_id', v_existing_q.id,
      'quantity_before', v_existing_q.quantity_before, 'quantity_delta', v_existing_q.quantity_delta,
      'quantity_after', v_existing_q.quantity_after
    );
  END IF;

  SELECT * INTO v_line
  FROM public.outlet_return_shipment_lines WHERE id = p_shipment_line_id FOR UPDATE;
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
  FROM public.outlet_return_shipments WHERE id = v_line.shipment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'return_shipment_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- THE IDOR GATE: authority is scoped to the DESTINATION (institution)
  -- warehouse, taken from the shipment, never the caller.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.return_receive', v_shipment.destination_organization_id,
    v_shipment.destination_warehouse_id, NULL
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_return_receive' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- Lock the provenance dispatch line, mirroring SEND — the single source this
  -- return traces to. (Both original_* columns are NOT NULL and pinned to each
  -- other by composite FK, so there is no movement-only branch to handle.)
  SELECT * INTO v_orig_dispatch
  FROM public.warehouse_dispatch_lines WHERE id = v_line.original_dispatch_line_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'original_dispatch_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_status := CASE
    WHEN p_received_quantity = 0 THEN 'rejected'
    WHEN p_received_quantity = v_line.sent_quantity THEN 'received'
    ELSE 'received_with_difference'
  END;

  -- Looked up before EITHER outcome, so a rejection's audit trail also
  -- records what the return was FOR.
  v_reason_code := (
    SELECT rl.reason_code FROM public.outlet_return_request_lines rl
    WHERE rl.id = v_line.return_request_line_id
  );

  IF p_received_quantity = 0 THEN
    UPDATE public.outlet_return_shipment_lines
       SET status = 'rejected', received_quantity = 0,
           difference_reason = v_reason, received_by = v_actor, received_at = now(),
           disposition = NULL, custody_state = 'exception_pending'
     WHERE id = v_line.id;

    UPDATE public.outlet_return_shipments
       SET status = CASE WHEN NOT EXISTS (
                           SELECT 1 FROM public.outlet_return_shipment_lines x
                           WHERE x.shipment_id = v_shipment.id AND x.status = 'in_transit')
                         THEN 'received' ELSE 'partially_received' END
     WHERE id = v_shipment.id;

    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
    ) VALUES (
      v_shipment.destination_organization_id, v_actor, v_actor_role,
      'outlet_stock.return_rejected', 'outlet_return_shipment_lines', v_line.id, v_line.scientific_name,
      jsonb_build_object(
        'request_id', p_request_id, 'shipment_id', v_shipment.id,
        'reason_code', v_reason_code,
        'sent_quantity', v_line.sent_quantity, 'received_quantity', 0,
        'custody_state', 'exception_pending', 'reason', v_reason
      )
    );

    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', false, 'line_status', 'rejected',
      'disposition', NULL, 'custody_state', 'exception_pending',
      'warehouse_stock_id', NULL, 'quarantine_stock_id', NULL, 'movement_id', NULL,
      'quantity_before', 0, 'quantity_delta', 0, 'quantity_after', 0
    );
  END IF;

  -- DISPOSITION CLASSIFICATION — FAIL-CLOSED. Identical policy to 069.
  v_objectively_expired := v_line.expiry_date IS NOT NULL AND v_line.expiry_date < current_date;
  v_mandatory_quarantine := v_objectively_expired
    OR v_reason_code IS NULL
    OR v_reason_code IN (
         'expired', 'damaged', 'recalled', 'quality_issue', 'temperature_excursion', 'other'
       );

  IF v_mandatory_quarantine THEN
    v_disposition := 'quarantined';
  ELSIF v_reason_code IN ('near_expiry', 'excess', 'shipment_error') THEN
    IF p_disposition_decision IS NULL THEN
      RAISE EXCEPTION 'return_receive_requires_explicit_disposition_decision' USING ERRCODE = '23514';
    END IF;
    v_disposition := p_disposition_decision;
  ELSE
    RAISE EXCEPTION 'return_receive_unclassified_reason_code' USING ERRCODE = '23514';
  END IF;

  v_custody := CASE v_disposition WHEN 'restockable' THEN 'destination_stock' ELSE 'destination_quarantine' END;
  v_internal := v_line.internal_batch_reference;

  IF v_disposition = 'restockable' THEN
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
      NULL, v_notes, v_actor, v_actor
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

    UPDATE public.outlet_return_shipment_lines
       SET status = v_status, received_quantity = p_received_quantity,
           difference_reason = v_reason, received_by = v_actor, received_at = now(),
           disposition = 'restockable', custody_state = 'destination_stock',
           resulting_warehouse_stock_id = v_stock.id
     WHERE id = v_line.id;

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
      'outlet_return', 'outlet_return_receive', p_request_id, v_fingerprint,
      NULL, v_actor, v_actor_role, v_actor_name,
      v_stock.scientific_name, v_stock.concentration,
      v_stock.dosage_form, v_stock.batch_number,
      v_stock.internal_batch_reference
    )
    RETURNING id INTO v_movement_id;
  ELSE
    INSERT INTO public.warehouse_quarantine_stock (
      organization_id, warehouse_id, central_item_id,
      scientific_name, trade_name, concentration, dosage_form, unit,
      national_code, has_no_national_code,
      batch_number, has_no_batch_number, internal_batch_reference,
      expiry_date, quarantine_reason, quantity, created_by, updated_by
    ) VALUES (
      v_shipment.destination_organization_id, v_shipment.destination_warehouse_id,
      v_line.central_item_id,
      v_line.scientific_name, v_line.trade_name, v_line.concentration,
      v_line.dosage_form, v_line.unit,
      v_line.national_code, v_line.has_no_national_code,
      v_line.batch_number, v_line.has_no_batch_number, v_internal,
      v_line.expiry_date,
      CASE WHEN v_objectively_expired AND v_reason_code IS DISTINCT FROM 'expired'
           THEN 'expired' ELSE COALESCE(v_reason_code, 'other') END,
      0, v_actor, v_actor
    )
    ON CONFLICT DO NOTHING;

    SELECT * INTO v_quarantine
    FROM public.warehouse_quarantine_stock q
    WHERE q.warehouse_id = v_shipment.destination_warehouse_id
      AND q.scientific_name = v_line.scientific_name
      AND COALESCE(q.concentration, '') = COALESCE(v_line.concentration, '')
      AND COALESCE(q.dosage_form, '')   = COALESCE(v_line.dosage_form, '')
      AND COALESCE(q.national_code, '') = COALESCE(v_line.national_code, '')
      AND COALESCE(q.batch_number, '')  = COALESCE(v_line.batch_number, '')
      AND COALESCE(q.expiry_date, DATE '0001-01-01')
          = COALESCE(v_line.expiry_date, DATE '0001-01-01')
      AND COALESCE(q.internal_batch_reference, '') = COALESCE(v_internal, '')
      AND q.quarantine_reason = (
            CASE WHEN v_objectively_expired AND v_reason_code IS DISTINCT FROM 'expired'
                 THEN 'expired' ELSE COALESCE(v_reason_code, 'other') END)
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'destination_quarantine_identity_resolution_failed' USING ERRCODE = 'P0002';
    END IF;

    v_before := v_quarantine.quantity;
    v_after  := v_before + p_received_quantity;

    UPDATE public.warehouse_quarantine_stock
       SET quantity = v_after, updated_by = v_actor
     WHERE id = v_quarantine.id;

    UPDATE public.outlet_return_shipment_lines
       SET status = v_status, received_quantity = p_received_quantity,
           difference_reason = v_reason, received_by = v_actor, received_at = now(),
           disposition = 'quarantined', custody_state = 'destination_quarantine',
           resulting_quarantine_stock_id = v_quarantine.id
     WHERE id = v_line.id;

    INSERT INTO public.warehouse_quarantine_stock_movements (
      quarantine_stock_id, organization_id, warehouse_id, movement_type,
      quantity_before, quantity_delta, quantity_after,
      reason, reference_type, reference_id, request_fingerprint,
      source_document_number, actor_id, actor_role, actor_name,
      scientific_name_snapshot, concentration_snapshot,
      dosage_form_snapshot, batch_number_snapshot,
      internal_batch_reference_snapshot
    ) VALUES (
      v_quarantine.id, v_quarantine.organization_id, v_quarantine.warehouse_id, 'quarantine_receive',
      v_before, p_received_quantity, v_after,
      'outlet_return', 'outlet_return_quarantine_receive', p_request_id, v_fingerprint,
      NULL, v_actor, v_actor_role, v_actor_name,
      v_quarantine.scientific_name, v_quarantine.concentration,
      v_quarantine.dosage_form, v_quarantine.batch_number,
      v_quarantine.internal_batch_reference
    )
    RETURNING id INTO v_movement_id;
  END IF;

  UPDATE public.outlet_return_shipments
     SET status = CASE WHEN NOT EXISTS (
                         SELECT 1 FROM public.outlet_return_shipment_lines x
                         WHERE x.shipment_id = v_shipment.id AND x.status = 'in_transit')
                       THEN 'received' ELSE 'partially_received' END
   WHERE id = v_shipment.id;

  -- Single provenance: always tick the dispatch line's destination-side
  -- "received back so far" counter. wdl_return_received_qty_chk
  -- (return_received_quantity <= returned_quantity) is the structural backstop.
  UPDATE public.warehouse_dispatch_lines
     SET return_received_quantity = return_received_quantity + p_received_quantity
   WHERE id = v_line.original_dispatch_line_id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role, action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_shipment.destination_organization_id, v_actor, v_actor_role,
    'outlet_stock.return_receive',
    CASE WHEN v_disposition = 'restockable' THEN 'warehouse_stock' ELSE 'warehouse_quarantine_stock' END,
    COALESCE(v_stock.id, v_quarantine.id),
    v_line.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id, 'shipment_id', v_shipment.id, 'shipment_line_id', v_line.id,
      'movement_id', v_movement_id, 'line_status', v_status,
      'reason_code', v_reason_code, 'disposition', v_disposition,
      'disposition_decision', p_disposition_decision, 'custody_state', v_custody,
      'sent_quantity', v_line.sent_quantity,
      'quantity_before', v_before, 'quantity_delta', p_received_quantity, 'quantity_after', v_after,
      'reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'line_status', v_status, 'disposition', v_disposition, 'custody_state', v_custody,
    'shipment_id', v_shipment.id,
    'warehouse_stock_id', v_stock.id, 'quarantine_stock_id', v_quarantine.id,
    'movement_id', v_movement_id,
    'quantity_before', v_before, 'quantity_delta', p_received_quantity, 'quantity_after', v_after
  );
END;
$$;

-- ============================================================================
-- 12. Grants
-- ============================================================================
REVOKE ALL ON FUNCTION public.phoenix_request_outlet_return(uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_request_outlet_return(uuid, text, text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_recall_outlet_stock(uuid, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_recall_outlet_stock(uuid, text, text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_add_outlet_return_request_line(uuid, uuid, integer, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_add_outlet_return_request_line(uuid, uuid, integer, text, text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_delete_outlet_return_request_line(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_delete_outlet_return_request_line(uuid)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_submit_outlet_return_request(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_submit_outlet_return_request(uuid)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_cancel_outlet_return_request(uuid, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_cancel_outlet_return_request(uuid, text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_review_outlet_return_request(uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_review_outlet_return_request(uuid, jsonb)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_send_outlet_return_shipment_line(uuid, uuid, uuid, integer, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_send_outlet_return_shipment_line(uuid, uuid, uuid, integer, text, text, text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_receive_outlet_return_shipment_line(uuid, uuid, integer, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_outlet_return_shipment_line(uuid, uuid, integer, text, text, text)
  TO authenticated;

COMMENT ON FUNCTION public.phoenix_receive_outlet_return_shipment_line(uuid, uuid, integer, text, text, text) IS
  'OUTLET-TO-INSTITUTION-RETURN-071-A: idempotent receipt at the institution '
  'warehouse. Requires outlet_stock.return_receive scoped to the destination '
  'warehouse. Classifies every accepted quantity as restockable (warehouse_stock) '
  'or quarantined (warehouse_quarantine_stock, 069''s table, reused verbatim) — '
  'expired/damaged/recalled/quality_issue/temperature_excursion/other/NULL '
  'reason_code are mandatory quarantine, never client-overridable; near_expiry/'
  'excess/shipment_error each require an explicit p_disposition_decision, with '
  'no default in either direction. Identical fail-closed policy to 069.';

-- ============================================================================
-- 13. RLS
-- ============================================================================
ALTER TABLE public.outlet_return_requests      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outlet_return_request_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outlet_return_shipments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outlet_return_shipment_lines ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.outlet_return_requests      TO authenticated;
GRANT SELECT ON TABLE public.outlet_return_request_lines TO authenticated;
GRANT SELECT ON TABLE public.outlet_return_shipments     TO authenticated;
GRANT SELECT ON TABLE public.outlet_return_shipment_lines TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.outlet_return_requests       FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.outlet_return_request_lines  FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.outlet_return_shipments      FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.outlet_return_shipment_lines FROM authenticated;

REVOKE ALL ON TABLE public.outlet_return_requests       FROM anon;
REVOKE ALL ON TABLE public.outlet_return_request_lines  FROM anon;
REVOKE ALL ON TABLE public.outlet_return_shipments       FROM anon;
REVOKE ALL ON TABLE public.outlet_return_shipment_lines FROM anon;

CREATE OR REPLACE FUNCTION public.phoenix_can_read_outlet_return(
  p_source_organization_id uuid,
  p_distribution_point_id  uuid,
  p_destination_warehouse_id uuid
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
           auth.uid(), 'outlet_stock.return_request', p_source_organization_id,
           NULL, p_distribution_point_id
         )
      OR public.phoenix_profile_has_scoped_permission(
           auth.uid(), 'outlet_stock.review_return', p_source_organization_id,
           p_destination_warehouse_id, NULL
         )
    );
$$;

REVOKE ALL ON FUNCTION public.phoenix_can_read_outlet_return(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_can_read_outlet_return(uuid, uuid, uuid) TO authenticated;

DROP POLICY IF EXISTS outlet_return_requests_select_scoped ON public.outlet_return_requests;
CREATE POLICY outlet_return_requests_select_scoped
  ON public.outlet_return_requests
  FOR SELECT
  TO authenticated
  USING (public.phoenix_can_read_outlet_return(source_organization_id, distribution_point_id, destination_warehouse_id));

DROP POLICY IF EXISTS outlet_return_request_lines_select_scoped ON public.outlet_return_request_lines;
CREATE POLICY outlet_return_request_lines_select_scoped
  ON public.outlet_return_request_lines
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.outlet_return_requests r
      WHERE r.id = outlet_return_request_lines.return_request_id
        AND public.phoenix_can_read_outlet_return(r.source_organization_id, r.distribution_point_id, r.destination_warehouse_id)
    )
  );

DROP POLICY IF EXISTS outlet_return_shipments_select_scoped ON public.outlet_return_shipments;
CREATE POLICY outlet_return_shipments_select_scoped
  ON public.outlet_return_shipments
  FOR SELECT
  TO authenticated
  USING (public.phoenix_can_read_outlet_return(source_organization_id, distribution_point_id, destination_warehouse_id));

DROP POLICY IF EXISTS outlet_return_shipment_lines_select_scoped ON public.outlet_return_shipment_lines;
CREATE POLICY outlet_return_shipment_lines_select_scoped
  ON public.outlet_return_shipment_lines
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.outlet_return_shipments s
      WHERE s.id = outlet_return_shipment_lines.shipment_id
        AND public.phoenix_can_read_outlet_return(s.source_organization_id, s.distribution_point_id, s.destination_warehouse_id)
    )
  );

-- ============================================================================
-- 14. POST-CONDITIONS
-- ============================================================================
DO $verify$
DECLARE
  v_def  text;
  v_body text;
BEGIN
  -- 14a. No CASCADE out of any new table except the intrinsic header->line
  -- relationship (same rule 067 proved for outlet_stock/outlet_stock_movements).
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname IN ('outlet_return_request_lines', 'outlet_return_shipment_lines')
      AND c.contype = 'f' AND c.confdeltype = 'c'
      AND c.conname NOT IN ('orrl_request_org_fk', 'orsl_shipment_org_fk')
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (071): an unexpected CASCADE exists on a return line table';
  END IF;

  -- 14b. No widened CHECK: outlet_stock_movements_type_chk and
  -- warehouse_stock_movements_type_chk must be untouched (still contain
  -- exactly their pre-071 vocabulary; 'return_send' (outlet debit) and 'add'
  -- (warehouse credit only — never provenance) are REUSED, not new).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outlet_stock_movements_type_chk'
      AND pg_get_constraintdef(oid) LIKE '%''return_send''%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (071): outlet_stock_movements_type_chk missing return_send';
  END IF;

  -- 14c. Structural quantity + single-proven-provenance guards exist.
  FOREACH v_def IN ARRAY ARRAY[
    'orsl_conservation_eq_chk', 'wdl_returned_qty_chk', 'osm_returned_qty_chk',
    'wdl_return_received_qty_chk',
    -- single-provenance type pin (no XOR, no 'add')
    'orrl_inbound_movement_type_chk', 'orrl_inbound_movement_type_fk',
    -- the three composite FKs that pin the chain on the REQUEST line
    'orrl_movement_from_dispatch_line_fk', 'orrl_movement_stock_fk',
    'orrl_dispatch_line_stock_fk',
    -- and the same three on the SHIPMENT line
    'orsl_movement_from_dispatch_line_fk', 'orsl_movement_stock_fk',
    'orsl_dispatch_line_stock_fk'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_def) THEN
      RAISE EXCEPTION 'ABORT 071: missing structural guard: %', v_def;
    END IF;
  END LOOP;

  -- 14c2. The OLD XOR/eligibility guards must be GONE — a return can no longer
  -- trace to an 'add' movement or omit either half of the chain.
  FOREACH v_def IN ARRAY ARRAY[
    'orrl_provenance_xor_chk', 'orsl_provenance_xor_chk', 'orrl_inbound_movement_type_eligible_chk'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_def) THEN
      RAISE EXCEPTION 'ABORT 071: stale XOR/legacy provenance guard still present: %', v_def;
    END IF;
  END LOOP;

  -- 14c3. Both provenance ids and the shared stock id are MANDATORY on both
  -- line tables — the chain can never be half-populated.
  FOREACH v_def IN ARRAY ARRAY['outlet_return_request_lines', 'outlet_return_shipment_lines'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=v_def
        AND column_name IN ('original_dispatch_line_id','original_inbound_movement_id')
        AND is_nullable='YES'
    ) THEN
      RAISE EXCEPTION 'ABORT 071: % still allows a NULL provenance id (XOR not fully removed)', v_def;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='outlet_return_request_lines'
      AND column_name='source_outlet_stock_id' AND is_nullable='YES'
  ) THEN
    RAISE EXCEPTION 'ABORT 071: outlet_return_request_lines.source_outlet_stock_id must be NOT NULL';
  END IF;

  -- 14c4. The eligible provenance movement_type is EXACTLY 'dispatch_receive' —
  -- 'add' (or anything else) can never be named. Proven from the CHECK text.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orrl_inbound_movement_type_chk'
      AND pg_get_constraintdef(oid) LIKE '%''dispatch_receive''%'
      AND pg_get_constraintdef(oid) NOT LIKE '%''add''%'
  ) THEN
    RAISE EXCEPTION 'ABORT 071: return provenance is not pinned to dispatch_receive-only (add must be impossible)';
  END IF;

  -- 14c5. ADD-LINE no longer accepts a movement-provenance parameter — the
  -- caller names ONLY the dispatch line; the movement is derived structurally.
  ASSERT to_regprocedure(
    'public.phoenix_add_outlet_return_request_line(uuid,uuid,integer,text,text)') IS NOT NULL,
    'VERIFY FAILED (071): ADD-LINE must have the single-provenance signature (no p_original_inbound_movement_id)';
  ASSERT pg_get_functiondef(
    'public.phoenix_add_outlet_return_request_line(uuid,uuid,integer,text,text)'::regprocedure)
    LIKE '%provenance_material_batch_expiry_mismatch%',
    'VERIFY FAILED (071): ADD-LINE must assert material/batch/expiry match across dispatch line and outlet_stock';

  -- 14d. Idempotency is structural for every return movement.
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'outlet_stock_movements_return_once_uniq') THEN
    RAISE EXCEPTION 'ABORT 071: outlet return-send idempotency index missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'warehouse_stock_movements_outlet_return_once_uniq') THEN
    RAISE EXCEPTION 'ABORT 071: outlet return-receive idempotency index missing';
  END IF;

  -- 14e. RECEIVE's disposition policy is fail-closed, mirroring 069 exactly.
  v_body := pg_get_functiondef(
    'public.phoenix_receive_outlet_return_shipment_line(uuid,uuid,integer,text,text,text)'::regprocedure);
  FOREACH v_def IN ARRAY ARRAY[
    'expired', 'damaged', 'recalled', 'quality_issue', 'temperature_excursion', 'other'
  ] LOOP
    ASSERT v_body LIKE '%''' || v_def || '''%',
      'VERIFY FAILED (071): return-receive is missing the mandatory-quarantine reason: ' || v_def;
  END LOOP;
  ASSERT v_body LIKE '%v_reason_code IS NULL%',
    'VERIFY FAILED (071): a NULL reason_code is not treated as mandatory quarantine';
  ASSERT v_body LIKE '%return_receive_requires_explicit_disposition_decision%',
    'VERIFY FAILED (071): near_expiry/excess/shipment_error do not require an explicit decision';
  ASSERT v_body NOT LIKE '%v_disposition := ''restockable'';%',
    'VERIFY FAILED (071): restockable must never be a hardcoded default';

  -- 14f. SEND has no expiry-refusal — named divergence, same as 069.
  ASSERT pg_get_functiondef(
    'public.phoenix_send_outlet_return_shipment_line(uuid,uuid,uuid,integer,text,text,text)'::regprocedure)
    NOT LIKE '%expiry_date < current_date%',
    'VERIFY FAILED (071): return-send must not refuse expired batches';

  -- 14g. A rejection never touches either balance and is exception_pending.
  ASSERT pg_get_functiondef(
    'public.phoenix_receive_outlet_return_shipment_line(uuid,uuid,integer,text,text,text)'::regprocedure)
    LIKE '%custody_state = ''exception_pending''%',
    'VERIFY FAILED (071): a rejected return is not tracked as exception_pending';

  -- 14h. Grants: authenticated has zero direct write privilege on any new table.
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('outlet_return_requests', 'outlet_return_request_lines',
                          'outlet_return_shipments', 'outlet_return_shipment_lines')
      AND grantee = 'authenticated'
      AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (071): authenticated holds a direct return write privilege';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public'
      AND table_name IN ('outlet_return_requests', 'outlet_return_request_lines',
                          'outlet_return_shipments', 'outlet_return_shipment_lines')
      AND grantee = 'anon'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAILED (071): anon can read outlet return data';
  END IF;

  -- 14i. Public QR path stays untouched and leaks nothing about outlet returns.
  DECLARE
    v_qr_def text := pg_get_functiondef('public.get_public_qr_payload'::regprocedure);
  BEGIN
    ASSERT v_qr_def NOT ILIKE '%outlet_return%' AND v_qr_def NOT ILIKE '%quarantine%',
      'VERIFY FAILED (071): outlet return or quarantine data leaked into public QR';
  END;

  -- 14j. RLS enabled on every new table.
  FOREACH v_def IN ARRAY ARRAY[
    'outlet_return_requests', 'outlet_return_request_lines',
    'outlet_return_shipments', 'outlet_return_shipment_lines'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = v_def AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'ABORT 071: RLS not enabled on %', v_def;
    END IF;
  END LOOP;

  RAISE NOTICE '071 verified: outlet->institution return reuses distribution_points.'
    'warehouse_id as the structural pairing (no new route table), SINGLE proven '
    'provenance (a real 070 dispatch line + its dispatch_receive movement + the '
    'shared outlet_stock, pinned by composite FKs; no XOR, no ''add'', no legacy '
    'origin), capped at accepted-minus-returned, fail-closed disposition '
    'identical to 069, literal conservation equation, and zero direct client '
    'write path on any new table. NOT APPLIED by this PR.';
END;
$verify$;

commit;

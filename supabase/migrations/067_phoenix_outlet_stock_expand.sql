-- ============================================================================
-- OUTLET-STOCK-EXPAND-067-A
--
-- MANUAL APPLY ONLY. DO NOT use supabase db push or any automated runner.
--
-- STRATEGY: Expand -> Frontend Migration -> Contract. This is an EXPAND step.
-- It is ADDITIVE AND BACKWARD-COMPATIBLE BY CONSTRUCTION.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE ARCHITECTURAL DECISION THIS MIGRATION IMPLEMENTS
-- ─────────────────────────────────────────────────────────────────────────────
-- item_availability STOPS being the outlet's physical stock. Outlets get their
-- own operational balance, while the inventory system stays ONE system:
--
--   warehouse_stock   = operational balance of central + institution warehouses
--   outlet_stock      = operational balance of pharmacies, crash cabinets and
--                       rescue carts                                  ← NEW (067)
--   item_availability = progressively becomes a PROJECTION derived from outlet
--                       stock + availability policy. It is no longer a SOURCE
--                       of quantity.
--
-- Unified, not duplicated: outlet_stock mirrors warehouse_stock's structure,
-- constraint vocabulary, generated-column strategy, ledger shape, idempotency
-- contract, advisory-lock ordering, scoped-permission gate and audit trail.
-- The two tables differ only in WHICH location they describe.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A SECOND TABLE INSTEAD OF A location_kind COLUMN ON warehouse_stock
-- ─────────────────────────────────────────────────────────────────────────────
-- warehouse_stock pins organization AND warehouse structurally, via
--   FOREIGN KEY (warehouse_id, organization_id) -> warehouses (id, organization_id)
-- with warehouse_id NOT NULL. Making it hold outlet rows would require dropping
-- that NOT NULL and weakening the composite FK to MATCH SIMPLE, i.e. deleting
-- the exact guarantee 060 exists to provide, for every existing warehouse row.
-- A separate table keeps both location kinds structurally pinned to their own
-- parent, and keeps 065's RPC/RLS surface untouched. Unification lives in the
-- shared contract, not in a shared nullable column.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DELIBERATELY DOES **NOT** DO
-- ─────────────────────────────────────────────────────────────────────────────
--   * No DROP, no RENAME, no REVOKE on any pre-existing object.
--   * No contract step. phoenix_upsert_availability, clear_port_availability,
--     phoenix_apply_availability_movement and phoenix_clean_availability_data
--     stay callable exactly as today — production screens still depend on them.
--   * No change to item_availability.source_kind's default (stays 'manual').
--   * warehouse_dispatch_lines.resulting_item_availability_id is NOT touched.
--     067 adds resulting_outlet_stock_id ALONGSIDE it, nullable, and keeps
--     populating the old link at acceptance.
--   * No outlet RETURN path. Deferred to 069 by decision: a return is a
--     two-location transaction (outlet_stock down, warehouse_stock up) and it
--     must not be authored before the dispatch SEND path exists (see below).
--   * No RBAC enforcement change. Enforcement stays OFF; 066's Shadow Mode
--     defaults are the only role data touched, and only additively.
--   * No data conversion or backfill. Every existing row keeps its meaning.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- UPSTREAM DEPENDENCY — READ BEFORE EXTENDING
-- ─────────────────────────────────────────────────────────────────────────────
-- As of 066, NO RPC creates or sends a warehouse_dispatch / warehouse_dispatch_
-- line: 061 shipped the dispatch SCHEMA only, and the audit confirms zero rows
-- in both tables. phoenix_receive_outlet_dispatch_line below is therefore
-- authored against the dispatch schema's contract and is INERT until the send
-- path (migration 068) starts producing 'sent' dispatches with 'pending' lines.
-- This is deliberate: receive is the half that touches outlet_stock, so it
-- belongs to the migration that introduces outlet_stock. It is written to be
-- correct on the day 068 lands, and it can produce nothing before then.
--
-- SOURCE OF TRUTH (restated):
--   warehouse_stock / warehouse_stock_movements = warehouse truth + audit
--   outlet_stock    / outlet_stock_movements    = outlet truth + audit   (067)
--   item_availability                           = read projection, per outlet
-- ============================================================================

begin;

-- ============================================================================
-- 0. PRECONDITIONS
-- ============================================================================
DO $guard$
BEGIN
  IF to_regclass('public.warehouse_stock') IS NULL
     OR to_regclass('public.warehouse_stock_movements') IS NULL
     OR to_regclass('public.warehouse_dispatches') IS NULL
     OR to_regclass('public.warehouse_dispatch_lines') IS NULL
     OR to_regclass('public.item_availability') IS NULL
     OR to_regclass('public.distribution_points') IS NULL
     OR to_regclass('public.profile_scope_assignments') IS NULL THEN
    RAISE EXCEPTION 'ABORT 067: expected 060/061/062 schema is absent. Apply earlier migrations first.';
  END IF;

  -- 066 must be applied: 067's permission keys and role defaults extend its
  -- outlet_stock.* module, and its RLS shape assumes 066's outlet roles exist.
  IF to_regclass('public.warehouse_supply_routes') IS NULL THEN
    RAISE EXCEPTION 'ABORT 067: migration 066 is absent. Apply 066 first.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.permission_keys WHERE key = 'outlet_stock.receive'
  ) THEN
    RAISE EXCEPTION 'ABORT 067: 066 permission keys are absent. Apply 066 first.';
  END IF;

  -- Composite FK targets 067 depends on. Without these the FKs below fail with
  -- ERROR 42830 and the whole migration rolls back.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'distribution_points_id_org_uniq'
  ) THEN
    RAISE EXCEPTION 'ABORT 067: distribution_points_id_org_uniq (061) is absent.';
  END IF;

  -- 065's guard is what makes the transitional projection write server-only.
  IF to_regprocedure('public.phoenix_guard_availability_source_kind()') IS NULL THEN
    RAISE EXCEPTION 'ABORT 067: 065 source_kind guard is absent. Apply 065 first.';
  END IF;

  RAISE NOTICE '067 preconditions OK.';
END;
$guard$;

-- ============================================================================
-- 1. outlet_stock — the outlet's operational balance
-- ============================================================================
-- Column types, constraint names and identity strategy mirror warehouse_stock
-- (060) exactly, so the two halves of the unified inventory cannot drift.
--   • quantities  integer       — matches warehouse_stock / item_availability
--   • unit_price  numeric(20,3) — matches warehouse_stock
--   • identity    text / date   — matches warehouse_stock / item_availability

CREATE TABLE IF NOT EXISTS public.outlet_stock (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id           uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,

  -- The outlet. NOT NULL and composite-FK-pinned to its organization, exactly
  -- as warehouse_stock pins warehouse_id.
  distribution_point_id     uuid NOT NULL,

  -- Optional drug-master link, nullable + snapshot-backed for the same reason
  -- warehouse_stock (060) and item_availability (019) made it optional: the
  -- catalog row is not required to describe stock, and identity fields must
  -- survive catalog edits.
  central_item_id           uuid REFERENCES public.central_items(id) ON DELETE RESTRICT,

  scientific_name           text NOT NULL,
  trade_name                text,
  concentration             text,
  dosage_form               text,
  unit                      text,

  -- Identity: national code / batch number, each with an EXPLICIT "none" flag so
  -- "no code" is distinguishable from "not entered yet" without placeholders.
  national_code             text,
  has_no_national_code      boolean NOT NULL DEFAULT false,
  batch_number              text,
  has_no_batch_number       boolean NOT NULL DEFAULT false,

  -- PRIVATE. Never public QR data. Set only for no-batch stock, to keep
  -- independently received shipments from merging into one identity.
  internal_batch_reference  text,

  expiry_date               date,

  on_hand_quantity          integer NOT NULL DEFAULT 0,
  reserved_quantity         integer NOT NULL DEFAULT 0,
  -- Generated, so available_quantity can never drift out of sync with its
  -- inputs. Not writable by any caller, including a SECURITY DEFINER RPC.
  available_quantity        integer GENERATED ALWAYS AS (on_hand_quantity - reserved_quantity) STORED,

  unit_price                numeric(20,3),
  price_basis               text,
  currency                  text,
  supply_type_text          text,
  source_document_number    text,
  notes                     text,

  created_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by                uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  -- Composite FK TARGET for outlet_stock_movements_stock_org_fk. REQUIRED, not
  -- decorative: PostgreSQL demands a UNIQUE/PK on the exact referenced column
  -- set, and PRIMARY KEY (id) alone does NOT satisfy (id, organization_id).
  -- Declared inline so it can never be ordered after the FK that needs it.
  CONSTRAINT outlet_stock_id_org_uniq UNIQUE (id, organization_id),

  -- Structural same-organization guarantee. RESTRICT: an outlet holding stock
  -- cannot be deleted out from under it.
  CONSTRAINT outlet_stock_dp_org_fk
    FOREIGN KEY (distribution_point_id, organization_id)
    REFERENCES public.distribution_points (id, organization_id) ON DELETE RESTRICT,

  CONSTRAINT outlet_stock_sci_name_chk
    CHECK (btrim(scientific_name) = scientific_name AND scientific_name <> ''),

  -- Optional identity text is stored trimmed and non-empty, or NULL. Never ''.
  CONSTRAINT outlet_stock_trade_name_chk
    CHECK (trade_name IS NULL OR (btrim(trade_name) = trade_name AND trade_name <> '')),
  CONSTRAINT outlet_stock_concentration_chk
    CHECK (concentration IS NULL OR (btrim(concentration) = concentration AND concentration <> '')),
  CONSTRAINT outlet_stock_dosage_form_chk
    CHECK (dosage_form IS NULL OR (btrim(dosage_form) = dosage_form AND dosage_form <> '')),
  CONSTRAINT outlet_stock_unit_chk
    CHECK (unit IS NULL OR (btrim(unit) = unit AND unit <> '')),
  CONSTRAINT outlet_stock_national_code_chk
    CHECK (national_code IS NULL OR (btrim(national_code) = national_code AND national_code <> '')),
  CONSTRAINT outlet_stock_batch_number_chk
    CHECK (batch_number IS NULL OR (btrim(batch_number) = batch_number AND batch_number <> '')),
  CONSTRAINT outlet_stock_internal_ref_chk
    CHECK (internal_batch_reference IS NULL
           OR (btrim(internal_batch_reference) = internal_batch_reference
               AND internal_batch_reference <> '')),

  -- Placeholders are DATA CORRUPTION here: absence must be NULL + the has_no_*
  -- flag, never a literal. Enforced, not merely documented. Mirrors 060/061.
  CONSTRAINT outlet_stock_no_placeholder_chk
    CHECK (
      (national_code IS NULL
        OR (upper(btrim(national_code)) NOT IN ('N/A', 'NA', 'NONE', 'NULL', '-', '--')
            AND btrim(national_code) <> 'بلا'))
      AND (batch_number IS NULL
        OR (upper(btrim(batch_number)) NOT IN ('N/A', 'NA', 'NONE', 'NULL', '-', '--')
            AND btrim(batch_number) <> 'بلا'))
      AND (internal_batch_reference IS NULL
        OR (upper(btrim(internal_batch_reference)) NOT IN ('N/A', 'NA', 'NONE', 'NULL', '-', '--')
            AND btrim(internal_batch_reference) <> 'بلا'))
    ),

  -- The has_no_* flag must EXACTLY correspond to its field being NULL.
  CONSTRAINT outlet_stock_has_no_national_code_chk
    CHECK (has_no_national_code = (national_code IS NULL)),
  CONSTRAINT outlet_stock_has_no_batch_number_chk
    CHECK (has_no_batch_number = (batch_number IS NULL)),

  -- Option C: an internal reference exists exactly when there is no real batch
  -- number — never alongside one, never absent from no-batch stock.
  CONSTRAINT outlet_stock_internal_ref_rule_chk
    CHECK (
      CASE WHEN has_no_batch_number
           THEN internal_batch_reference IS NOT NULL
           ELSE internal_batch_reference IS NULL
      END
    ),

  -- Negative quantities and over-reservation are structurally impossible.
  CONSTRAINT outlet_stock_on_hand_nonneg_chk   CHECK (on_hand_quantity  >= 0),
  CONSTRAINT outlet_stock_reserved_nonneg_chk  CHECK (reserved_quantity >= 0),
  CONSTRAINT outlet_stock_reserved_le_on_hand_chk
    CHECK (reserved_quantity <= on_hand_quantity),
  CONSTRAINT outlet_stock_unit_price_chk
    CHECK (unit_price IS NULL OR unit_price >= 0)
);

-- Outlet stock identity. Mirrors warehouse_stock_identity_uniq (060) and
-- migration 051's COALESCE normalization exactly, INCLUDING the immutable date
-- sentinel: expiry_date::text is NOT IMMUTABLE (it depends on DateStyle) and
-- Postgres rejects it in an index (ERROR 42P17). The 8th component
-- (internal_batch_reference) keeps independently received no-batch stock apart.
CREATE UNIQUE INDEX IF NOT EXISTS outlet_stock_identity_uniq
  ON public.outlet_stock (
    distribution_point_id,
    scientific_name,
    COALESCE(concentration, ''),
    COALESCE(dosage_form, ''),
    COALESCE(national_code, ''),
    COALESCE(batch_number, ''),
    COALESCE(expiry_date, DATE '0001-01-01'),
    COALESCE(internal_batch_reference, '')
  );

CREATE INDEX IF NOT EXISTS outlet_stock_org_idx      ON public.outlet_stock (organization_id);
CREATE INDEX IF NOT EXISTS outlet_stock_point_idx    ON public.outlet_stock (distribution_point_id);
CREATE INDEX IF NOT EXISTS outlet_stock_sci_name_idx ON public.outlet_stock (scientific_name);
CREATE INDEX IF NOT EXISTS outlet_stock_expiry_idx   ON public.outlet_stock (expiry_date);

COMMENT ON TABLE public.outlet_stock IS
  'OUTLET-STOCK-EXPAND-067-A: authoritative batch-aware OUTLET quantities '
  '(pharmacy | crash_cabinet | rescue_cart). One row per exact material identity '
  'per outlet (outlet_stock_identity_uniq). The outlet half of the unified '
  'inventory; warehouse_stock is the warehouse half. available_quantity is '
  'generated as on_hand_quantity - reserved_quantity and is never written '
  'directly. Rows are written ONLY by this migration''s SECURITY DEFINER RPCs — '
  'there is no direct client INSERT/UPDATE/DELETE path, by design. Never public: '
  'not readable by anon and never fed to get_public_qr_payload.';

COMMENT ON COLUMN public.outlet_stock.internal_batch_reference IS
  'PRIVATE. Set only when has_no_batch_number = true, to keep independently '
  'received no-batch shipments from merging into one identity. Never exposed '
  'publicly; batch_number itself stays NULL for such stock.';

COMMENT ON COLUMN public.outlet_stock.available_quantity IS
  'GENERATED ALWAYS AS (on_hand_quantity - reserved_quantity) STORED. This is '
  'the outlet''s dispensable quantity and the input to the item_availability '
  'projection. Never writable.';

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.outlet_stock
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 2. outlet_stock_movements — immutable ledger
-- ============================================================================
-- Every on-hand or reservation change is explained by exactly one row. Mirrors
-- warehouse_stock_movements (060/065): identity snapshots (the parent's identity
-- fields are mutable), before/delta/after arithmetic, actor snapshot, request
-- fingerprint, and no client write path.

CREATE TABLE IF NOT EXISTS public.outlet_stock_movements (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_stock_id                   uuid NOT NULL,
  organization_id                   uuid NOT NULL,
  distribution_point_id             uuid NOT NULL,

  movement_type                     text NOT NULL,

  on_hand_before                    integer NOT NULL,
  on_hand_delta                     integer NOT NULL,
  on_hand_after                     integer NOT NULL,
  reserved_before                   integer NOT NULL,
  reserved_delta                    integer NOT NULL,
  reserved_after                    integer NOT NULL,

  reason                            text,

  -- Generic provenance pointer, same vocabulary as warehouse_stock_movements.
  reference_type                    text,
  reference_id                      uuid,
  source_document_number            text,

  -- Typed link to the dispatch line this receipt came from. Nullable: only
  -- dispatch receipts carry it. The partial unique index below is what turns
  -- "one dispatch line is received at most once" from an RPC convention into a
  -- DATABASE guarantee — the same technique 061 used on
  -- item_availability_movements.dispatch_line_id.
  dispatch_line_id                  uuid REFERENCES public.warehouse_dispatch_lines(id) ON DELETE SET NULL,

  -- SHA-256 consistency checksum binding a request UUID to one semantic
  -- request. Not an authentication primitive. Same contract as 065.
  request_fingerprint               text,

  actor_id                          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_role                        text,
  actor_name                        text,

  scientific_name_snapshot          text NOT NULL,
  concentration_snapshot            text,
  dosage_form_snapshot              text,
  batch_number_snapshot             text,
  internal_batch_reference_snapshot text,
  expiry_date_snapshot              date,

  created_at                        timestamptz NOT NULL DEFAULT now(),

  -- Structural org agreement with the parent stock row and the outlet.
  CONSTRAINT outlet_stock_movements_stock_org_fk
    FOREIGN KEY (outlet_stock_id, organization_id)
    REFERENCES public.outlet_stock (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT outlet_stock_movements_dp_org_fk
    FOREIGN KEY (distribution_point_id, organization_id)
    REFERENCES public.distribution_points (id, organization_id) ON DELETE RESTRICT,

  -- Text + CHECK, never a Postgres enum: every status/type column in this schema
  -- is text+CHECK, and an enum cannot be altered inside a transaction.
  -- 'reserve'/'release'/'return_send' are accepted now so the reservation and
  -- return paths (069) need no CHECK change on a table that by then holds rows.
  CONSTRAINT outlet_stock_movements_type_chk
    CHECK (movement_type IN (
      'set_exact', 'add', 'subtract', 'correction',
      'reserve', 'release', 'dispatch_receive', 'dispense', 'return_send'
    )),

  -- Arithmetic must be self-consistent: the ledger can never disagree with itself.
  CONSTRAINT outlet_stock_movements_on_hand_math_chk
    CHECK (on_hand_before + on_hand_delta = on_hand_after),
  CONSTRAINT outlet_stock_movements_reserved_math_chk
    CHECK (reserved_before + reserved_delta = reserved_after),

  CONSTRAINT outlet_stock_movements_on_hand_before_chk  CHECK (on_hand_before  >= 0),
  CONSTRAINT outlet_stock_movements_on_hand_after_chk   CHECK (on_hand_after   >= 0),
  CONSTRAINT outlet_stock_movements_reserved_before_chk CHECK (reserved_before >= 0),
  CONSTRAINT outlet_stock_movements_reserved_after_chk  CHECK (reserved_after  >= 0),
  -- The reservation invariant holds at every point in history, not just now.
  CONSTRAINT outlet_stock_movements_reserved_le_on_hand_chk
    CHECK (reserved_after <= on_hand_after),

  -- A correction or an absolute overwrite must be explained (033/060 precedent).
  CONSTRAINT outlet_stock_movements_correction_reason_chk
    CHECK (movement_type <> 'correction' OR (reason IS NOT NULL AND btrim(reason) <> '')),
  CONSTRAINT outlet_stock_movements_set_exact_reason_chk
    CHECK (movement_type <> 'set_exact' OR (reason IS NOT NULL AND btrim(reason) <> '')),

  -- A dispatch receipt must name the line it came from; nothing else may.
  CONSTRAINT outlet_stock_movements_dispatch_receive_chk
    CHECK (
      CASE WHEN movement_type = 'dispatch_receive'
           THEN dispatch_line_id IS NOT NULL
           ELSE dispatch_line_id IS NULL
      END
    ),

  -- Same fingerprint contract as 065: an outlet_request reference must carry a
  -- well-formed checksum, so a replay can always be compared rather than trusted.
  CONSTRAINT outlet_stock_movements_request_fingerprint_chk
    CHECK (
      reference_type IS DISTINCT FROM 'outlet_request'
      OR (request_fingerprint IS NOT NULL AND request_fingerprint ~ '^[0-9a-f]{64}$')
    ),

  CONSTRAINT outlet_stock_movements_sci_snapshot_chk
    CHECK (btrim(scientific_name_snapshot) = scientific_name_snapshot
           AND scientific_name_snapshot <> '')
);

-- One client request produces AT MOST ONE outlet movement. Structural, not
-- conventional — this is the idempotency guarantee itself, not a helper index.
CREATE UNIQUE INDEX IF NOT EXISTS outlet_stock_movements_request_once_uniq
  ON public.outlet_stock_movements (reference_id)
  WHERE reference_type = 'outlet_request' AND reference_id IS NOT NULL;

-- One dispatch line is received AT MOST ONCE, whatever the request id.
CREATE UNIQUE INDEX IF NOT EXISTS outlet_stock_movements_dispatch_line_uniq
  ON public.outlet_stock_movements (dispatch_line_id)
  WHERE dispatch_line_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS outlet_stock_movements_stock_idx
  ON public.outlet_stock_movements (outlet_stock_id);
CREATE INDEX IF NOT EXISTS outlet_stock_movements_org_idx
  ON public.outlet_stock_movements (organization_id);
CREATE INDEX IF NOT EXISTS outlet_stock_movements_point_idx
  ON public.outlet_stock_movements (distribution_point_id);
CREATE INDEX IF NOT EXISTS outlet_stock_movements_created_idx
  ON public.outlet_stock_movements (created_at);
CREATE INDEX IF NOT EXISTS outlet_stock_movements_reference_idx
  ON public.outlet_stock_movements (reference_type, reference_id);

COMMENT ON TABLE public.outlet_stock_movements IS
  'OUTLET-STOCK-EXPAND-067-A: immutable audit trail for outlet_stock. Exactly one '
  'row explains every on-hand/reservation change. Append-only from the client''s '
  'perspective: authenticated holds no INSERT/UPDATE/DELETE and the rows are '
  'written only by this migration''s SECURITY DEFINER RPCs. Idempotency is '
  'structural via outlet_stock_movements_request_once_uniq (one request UUID = '
  'one movement) and outlet_stock_movements_dispatch_line_uniq (one dispatch '
  'line = one receipt).';

COMMENT ON COLUMN public.outlet_stock_movements.request_fingerprint IS
  'SHA-256 consistency checksum of normalized outlet mutation inputs. It binds an '
  'outlet_request UUID to one semantic request and is not an authentication or '
  'secret-protection mechanism. Required when reference_type=outlet_request.';

-- ============================================================================
-- 3. Dispatch line -> outlet stock link
-- ============================================================================
-- ADDITIVE and NULLABLE. resulting_item_availability_id is NOT touched, not
-- dropped, not renamed: acceptance keeps populating it transitionally (part 5),
-- and this new column records the row that is now the actual truth.
--
-- SET NULL, matching the retention-soft policy 061 chose for its result links:
-- migration 055 (Deep Clean) physically deletes projection rows, and a RESTRICT
-- here would break it outright while CASCADE would destroy dispatch history.

ALTER TABLE public.warehouse_dispatch_lines
  ADD COLUMN IF NOT EXISTS resulting_outlet_stock_id uuid;

DO $$ BEGIN
  ALTER TABLE public.warehouse_dispatch_lines
    ADD CONSTRAINT warehouse_dispatch_lines_resulting_outlet_stock_fk
    FOREIGN KEY (resulting_outlet_stock_id)
    REFERENCES public.outlet_stock(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.warehouse_dispatch_lines.resulting_outlet_stock_id IS
  'OUTLET-STOCK-EXPAND-067-A: the outlet_stock row this line landed in. NULL for '
  'every pre-067 line and every undecided line. resulting_item_availability_id '
  'remains and is still populated transitionally; it points at the PROJECTION, '
  'while this points at the TRUTH.';

-- ============================================================================
-- 4. Availability projection policy
-- ============================================================================
-- The stored item_availability.condition for a projected row is DERIVED, using
-- migration 052's established precedence and thresholds, restated here exactly:
--   1. usable quantity 0                          -> 'missing'
--   2. expiry_date <  current_date                -> 'expired'
--   3. expiry_date <= current_date + 9 months     -> 'near_expiry'
--   4. otherwise                                  -> 'available'
-- Quantity-zero outranks expiry, exactly as 052 decided. 'low_stock'/'surplus'
-- are NOT derived: they need a per-outlet threshold policy that does not exist
-- yet, and inventing one here would be a policy decision smuggled into a
-- schema migration. 'unknown'/'not_stocked' (066) are onboarding states and are
-- never produced by a physical receipt.

CREATE OR REPLACE FUNCTION public.phoenix_derive_outlet_availability_condition(
  p_available_quantity integer,
  p_expiry_date        date
)
RETURNS text
LANGUAGE sql
-- STABLE, not IMMUTABLE: current_date is stable within a transaction but varies
-- across them. Declaring this IMMUTABLE would let the planner fold a stale
-- "today" into a cached plan, so an item would keep reporting near_expiry (or
-- worse, not-yet-expired) after the date it was classified against had passed.
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN COALESCE(p_available_quantity, 0) <= 0 THEN 'missing'
    WHEN p_expiry_date IS NOT NULL AND p_expiry_date < current_date THEN 'expired'
    WHEN p_expiry_date IS NOT NULL
         AND p_expiry_date <= (current_date + interval '9 months')::date
      THEN 'near_expiry'
    ELSE 'available'
  END;
$$;

COMMENT ON FUNCTION public.phoenix_derive_outlet_availability_condition(integer, date) IS
  'OUTLET-STOCK-EXPAND-067-A: availability policy for a projected outlet row. '
  'Restates migration 052''s precedence exactly (quantity-zero outranks expiry) '
  'and its 9-month near-expiry threshold. Pure: no table access, no authority.';

-- ---------------------------------------------------------------------------
-- The projection writer.
-- ---------------------------------------------------------------------------
-- item_availability's identity index (051) has SEVEN components and does NOT
-- include internal_batch_reference, while outlet_stock's identity has EIGHT and
-- does. Two independently received no-batch outlet_stock rows therefore project
-- onto ONE item_availability row. The projection is consequently computed as a
-- SUM over every outlet_stock row sharing the 7-component projection identity —
-- not copied from the single row that happened to change. A projection that
-- copied one row would silently under-report the outlet's real holding.
--
-- SECURITY DEFINER + the 065 GUC handshake: the guard trigger admits a
-- source_kind='warehouse_dispatch' write only when phoenix.dispatch_write='on'
-- AND current_user is the item_availability owner. The flag alone is never
-- authority — direct authenticated DML cannot self-authorize by setting a GUC.
-- The flag is set with is_local=true so it dies with the transaction.
CREATE OR REPLACE FUNCTION public.phoenix_project_outlet_availability(
  p_outlet_stock_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_stock     public.outlet_stock%ROWTYPE;
  v_available integer;
  v_condition text;
  v_id        uuid;
BEGIN
  SELECT * INTO v_stock FROM public.outlet_stock WHERE id = p_outlet_stock_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'outlet_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Sum every outlet_stock row that shares this row's PROJECTION identity.
  SELECT COALESCE(sum(s.available_quantity), 0)
    INTO v_available
  FROM public.outlet_stock s
  WHERE s.distribution_point_id = v_stock.distribution_point_id
    AND s.scientific_name = v_stock.scientific_name
    AND COALESCE(s.concentration, '')  = COALESCE(v_stock.concentration, '')
    AND COALESCE(s.dosage_form, '')    = COALESCE(v_stock.dosage_form, '')
    AND COALESCE(s.national_code, '')  = COALESCE(v_stock.national_code, '')
    AND COALESCE(s.batch_number, '')   = COALESCE(v_stock.batch_number, '')
    AND COALESCE(s.expiry_date, DATE '0001-01-01')
        = COALESCE(v_stock.expiry_date, DATE '0001-01-01');

  v_condition := public.phoenix_derive_outlet_availability_condition(
    v_available, v_stock.expiry_date
  );

  -- Authorize the guarded write for THIS TRANSACTION ONLY.
  PERFORM set_config('phoenix.dispatch_write', 'on', true);

  INSERT INTO public.item_availability (
    distribution_point_id, organization_id,
    scientific_name, trade_name, concentration, dosage_form,
    national_code, batch_number, internal_batch_reference, expiry_date,
    quantity, condition, price, supply_type, source_kind, last_updated_by
  ) VALUES (
    v_stock.distribution_point_id, v_stock.organization_id,
    v_stock.scientific_name, v_stock.trade_name, v_stock.concentration, v_stock.dosage_form,
    v_stock.national_code, v_stock.batch_number, v_stock.internal_batch_reference,
    v_stock.expiry_date,
    v_available, v_condition, v_stock.unit_price, v_stock.supply_type_text,
    'warehouse_dispatch', v_stock.updated_by
  )
  ON CONFLICT (
    distribution_point_id,
    scientific_name,
    COALESCE(concentration, ''),
    COALESCE(dosage_form, ''),
    COALESCE(national_code, ''),
    COALESCE(batch_number, ''),
    COALESCE(expiry_date, DATE '0001-01-01')
  )
  WHERE scientific_name IS NOT NULL
  DO UPDATE SET
    quantity        = EXCLUDED.quantity,
    condition       = EXCLUDED.condition,
    source_kind     = 'warehouse_dispatch',
    -- The conflicting row is referenced by bare table name; a schema-qualified
    -- reference is not accepted in ON CONFLICT DO UPDATE.
    trade_name      = COALESCE(EXCLUDED.trade_name, item_availability.trade_name),
    price           = COALESCE(EXCLUDED.price, item_availability.price),
    supply_type     = COALESCE(EXCLUDED.supply_type, item_availability.supply_type),
    last_updated_by = EXCLUDED.last_updated_by,
    -- A projected row is live again by definition: it has physical stock behind
    -- it, so 053's removal marker must not linger and hide it.
    removed_at      = NULL,
    removed_by      = NULL,
    removal_reason  = NULL
  RETURNING id INTO v_id;

  PERFORM set_config('phoenix.dispatch_write', 'off', true);

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.phoenix_project_outlet_availability(uuid)
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.phoenix_project_outlet_availability(uuid) IS
  'OUTLET-STOCK-EXPAND-067-A: transitional projection writer. Recomputes the '
  'item_availability row for an outlet_stock row''s projection identity by '
  'SUMMING every outlet_stock row that shares it, then derives condition via '
  'phoenix_derive_outlet_availability_condition. Server-only: no role holds '
  'EXECUTE. Callable exclusively from this migration''s RPCs, inside their own '
  'transaction. This is the bridge that lets item_availability become a '
  'projection without a contract migration or a client dual-write.';

-- ============================================================================
-- 5. Transitional RPCs
-- ============================================================================
-- Every RPC below obeys the SAME contract as 065's warehouse RPCs:
--   * SECURITY DEFINER with a pinned search_path.
--   * Advisory lock FIRST, row lock SECOND — identical ordering everywhere, so
--     lock-order inversion between the warehouse and outlet halves is
--     impossible by construction.
--   * Idempotency: reference_type='outlet_request' + reference_id=p_request_id,
--     replay compared against request_fingerprint and failed closed on conflict.
--   * Authorization through phoenix_profile_has_scoped_permission ONLY, never a
--     role literal — this is the IDOR gate, and it is inside the RPC, not the UI.
--   * Negative stock refused. Audit row written. Projection refreshed in the
--     same transaction.

-- ---------------------------------------------------------------------------
-- 5a. Receive a dispatch line into the outlet.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_receive_outlet_dispatch_line(
  p_request_id        uuid,
  p_dispatch_line_id  uuid,
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
  v_line        public.warehouse_dispatch_lines%ROWTYPE;
  v_dispatch    public.warehouse_dispatches%ROWTYPE;
  v_stock       public.outlet_stock%ROWTYPE;
  v_existing    public.outlet_stock_movements%ROWTYPE;
  v_reason      text := NULLIF(btrim(p_difference_reason), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_before      integer;
  v_after       integer;
  v_movement_id uuid;
  v_avail_id    uuid;
  v_line_status text;
  v_fingerprint text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_dispatch_line_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_line_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_received_quantity IS NULL OR p_received_quantity < 0 THEN
    RAISE EXCEPTION 'received_quantity_must_be_non_negative' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'receive_dispatch_line',
    'dispatch_line_id', p_dispatch_line_id,
    'received_quantity', p_received_quantity,
    'difference_reason', v_reason,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  -- Advisory lock first, row locks second: identical ordering to 065.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 67067));

  -- Replay check BEFORE any authorization side effect, so a retry is cheap and
  -- cannot be turned into a probe that behaves differently from the first call.
  SELECT * INTO v_existing
  FROM public.outlet_stock_movements m
  WHERE m.reference_type = 'outlet_request' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.dispatch_line_id IS DISTINCT FROM p_dispatch_line_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'outlet_stock_id', v_existing.outlet_stock_id,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  SELECT * INTO v_line
  FROM public.warehouse_dispatch_lines
  WHERE id = p_dispatch_line_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_line_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_dispatch
  FROM public.warehouse_dispatches
  WHERE id = v_line.dispatch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'dispatch_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Only a physically sent dispatch can be received.
  IF v_dispatch.status NOT IN ('sent', 'partially_accepted') THEN
    RAISE EXCEPTION 'dispatch_not_receivable' USING ERRCODE = '23514';
  END IF;
  IF v_line.status <> 'pending' THEN
    RAISE EXCEPTION 'dispatch_line_already_decided' USING ERRCODE = '23505';
  END IF;
  IF p_received_quantity > v_line.sent_quantity THEN
    RAISE EXCEPTION 'received_quantity_exceeds_sent' USING ERRCODE = '23514';
  END IF;
  -- A quantity that disagrees with the shipment must be explained, or the
  -- discrepancy becomes invisible the moment it matters.
  IF p_received_quantity <> v_line.sent_quantity AND v_reason IS NULL THEN
    RAISE EXCEPTION 'difference_reason_required' USING ERRCODE = '23514';
  END IF;

  -- THE IDOR GATE. Authority is the actor's scoped assignment to the
  -- DESTINATION OUTLET — never a role literal, never the client's word, never
  -- the dispatch's own claim about where it is going.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.receive', v_dispatch.organization_id,
    NULL, v_dispatch.destination_distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_stock_receive' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- An expired batch must never enter an outlet. This is the last point at
  -- which the system can refuse it; after this it is dispensable stock.
  IF v_line.expiry_date IS NOT NULL AND v_line.expiry_date < current_date THEN
    RAISE EXCEPTION 'expired_batch_cannot_be_received' USING ERRCODE = '23514';
  END IF;

  v_line_status := CASE
    WHEN p_received_quantity = 0 THEN 'rejected'
    WHEN p_received_quantity = v_line.sent_quantity THEN 'accepted'
    ELSE 'accepted_with_difference'
  END;

  -- A fully rejected line moves no stock: record the decision and stop. There is
  -- no outlet_stock row to create, so there is no movement and no projection.
  IF p_received_quantity = 0 THEN
    UPDATE public.warehouse_dispatch_lines
       SET status = 'rejected', received_quantity = 0,
           rejection_reason = v_reason, rejected_by = v_actor, rejected_at = now()
     WHERE id = v_line.id;

    INSERT INTO public.audit_logs (
      organization_id, actor_id, actor_role,
      action, entity_type, entity_id, entity_label, payload
    ) VALUES (
      v_dispatch.organization_id, v_actor, v_actor_role,
      'outlet_stock.dispatch_rejected', 'warehouse_dispatch_lines', v_line.id,
      v_line.scientific_name,
      jsonb_build_object(
        'request_id', p_request_id,
        'dispatch_id', v_dispatch.id,
        'distribution_point_id', v_dispatch.destination_distribution_point_id,
        'sent_quantity', v_line.sent_quantity,
        'received_quantity', 0,
        'reason', v_reason
      )
    );

    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', false,
      'line_status', 'rejected', 'outlet_stock_id', NULL, 'movement_id', NULL,
      'quantity_before', 0, 'quantity_delta', 0, 'quantity_after', 0
    );
  END IF;

  -- Resolve (or create) the outlet_stock identity from the line's IMMUTABLE
  -- snapshots — never from a client-supplied identity.
  INSERT INTO public.outlet_stock (
    organization_id, distribution_point_id, central_item_id,
    scientific_name, trade_name, concentration, dosage_form, unit,
    national_code, has_no_national_code,
    batch_number, has_no_batch_number, internal_batch_reference,
    expiry_date, on_hand_quantity, reserved_quantity,
    unit_price, price_basis, currency, supply_type_text,
    source_document_number, notes, created_by, updated_by
  ) VALUES (
    v_dispatch.organization_id, v_dispatch.destination_distribution_point_id,
    v_line.central_item_id,
    v_line.scientific_name, v_line.trade_name, v_line.concentration,
    v_line.dosage_form, v_line.unit,
    v_line.national_code, v_line.has_no_national_code,
    v_line.batch_number, v_line.has_no_batch_number, v_line.internal_batch_reference,
    v_line.expiry_date, 0, 0,
    v_line.unit_price, v_line.price_basis, v_line.currency, v_line.supply_type_text,
    v_dispatch.document_number, v_notes, v_actor, v_actor
  )
  ON CONFLICT DO NOTHING;

  SELECT * INTO v_stock
  FROM public.outlet_stock s
  WHERE s.distribution_point_id = v_dispatch.destination_distribution_point_id
    AND s.scientific_name = v_line.scientific_name
    AND COALESCE(s.concentration, '') = COALESCE(v_line.concentration, '')
    AND COALESCE(s.dosage_form, '')   = COALESCE(v_line.dosage_form, '')
    AND COALESCE(s.national_code, '') = COALESCE(v_line.national_code, '')
    AND COALESCE(s.batch_number, '')  = COALESCE(v_line.batch_number, '')
    AND COALESCE(s.expiry_date, DATE '0001-01-01')
        = COALESCE(v_line.expiry_date, DATE '0001-01-01')
    AND COALESCE(s.internal_batch_reference, '')
        = COALESCE(v_line.internal_batch_reference, '')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'outlet_stock_identity_resolution_failed' USING ERRCODE = 'P0002';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before + p_received_quantity;

  UPDATE public.outlet_stock
     SET on_hand_quantity       = v_after,
         central_item_id        = COALESCE(v_stock.central_item_id, v_line.central_item_id),
         unit_price             = COALESCE(v_line.unit_price, unit_price),
         source_document_number = COALESCE(v_dispatch.document_number, source_document_number),
         notes                  = COALESCE(v_notes, notes),
         updated_by             = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.outlet_stock_movements (
    outlet_stock_id, organization_id, distribution_point_id,
    movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reference_type, reference_id, dispatch_line_id, request_fingerprint,
    source_document_number, actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot, dosage_form_snapshot,
    batch_number_snapshot, internal_batch_reference_snapshot, expiry_date_snapshot
  ) VALUES (
    v_stock.id, v_dispatch.organization_id, v_dispatch.destination_distribution_point_id,
    'dispatch_receive',
    v_before, p_received_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    v_reason, 'outlet_request', p_request_id, v_line.id, v_fingerprint,
    v_dispatch.document_number, v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form,
    v_stock.batch_number, v_stock.internal_batch_reference, v_stock.expiry_date
  )
  RETURNING id INTO v_movement_id;

  -- Transitional projection, in THIS transaction. The client never dual-writes.
  v_avail_id := public.phoenix_project_outlet_availability(v_stock.id);

  UPDATE public.warehouse_dispatch_lines
     SET status                         = v_line_status,
         received_quantity              = p_received_quantity,
         difference_reason              = v_reason,
         accepted_by                    = v_actor,
         accepted_at                    = now(),
         resulting_outlet_stock_id      = v_stock.id,
         -- Kept populated on purpose: 061's link must not break during expand.
         resulting_item_availability_id = v_avail_id
   WHERE id = v_line.id;

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_dispatch.organization_id, v_actor, v_actor_role,
    'outlet_stock.dispatch_receive', 'outlet_stock', v_stock.id,
    v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'dispatch_id', v_dispatch.id,
      'dispatch_line_id', v_line.id,
      'distribution_point_id', v_dispatch.destination_distribution_point_id,
      'movement_id', v_movement_id,
      'line_status', v_line_status,
      'sent_quantity', v_line.sent_quantity,
      'quantity_before', v_before,
      'quantity_delta', p_received_quantity,
      'quantity_after', v_after,
      'reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'line_status', v_line_status,
    'outlet_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'item_availability_id', v_avail_id,
    'quantity_before', v_before,
    'quantity_delta', p_received_quantity,
    'quantity_after', v_after
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 5b. Dispense / consume from the outlet.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.phoenix_dispense_outlet_stock(
  p_request_id     uuid,
  p_outlet_stock_id uuid,
  p_quantity       integer,
  p_reason         text DEFAULT NULL,
  p_notes          text DEFAULT NULL
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
  v_stock       public.outlet_stock%ROWTYPE;
  v_existing    public.outlet_stock_movements%ROWTYPE;
  v_reason      text := NULLIF(btrim(p_reason), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_before      integer;
  v_after       integer;
  v_movement_id uuid;
  v_avail_id    uuid;
  v_fingerprint text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_outlet_stock_id IS NULL THEN
    RAISE EXCEPTION 'outlet_stock_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'quantity_must_be_positive' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'dispense',
    'outlet_stock_id', p_outlet_stock_id,
    'quantity', p_quantity,
    'reason', v_reason,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 67067));

  SELECT * INTO v_existing
  FROM public.outlet_stock_movements m
  WHERE m.reference_type = 'outlet_request' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.outlet_stock_id IS DISTINCT FROM p_outlet_stock_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'outlet_stock_id', v_existing.outlet_stock_id,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  SELECT * INTO v_stock
  FROM public.outlet_stock WHERE id = p_outlet_stock_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'outlet_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- THE IDOR GATE. The outlet is derived from the LOCKED ROW, not from the
  -- caller: a caller who names someone else's stock id fails here.
  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.dispense', v_stock.organization_id,
    NULL, v_stock.distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_stock_dispense' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  -- An expired batch is not dispensable. Removing it is a count/correction
  -- decision (5c), which is separately permissioned and separately audited.
  IF v_stock.expiry_date IS NOT NULL AND v_stock.expiry_date < current_date THEN
    RAISE EXCEPTION 'expired_batch_cannot_be_dispensed' USING ERRCODE = '23514';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_after  := v_before - p_quantity;

  -- Belt and braces: the CHECK constraints would also refuse these. Explicit
  -- errors are named so the caller learns WHICH invariant it violated.
  IF v_after < 0 THEN
    RAISE EXCEPTION 'outlet_quantity_cannot_go_negative' USING ERRCODE = '23514';
  END IF;
  IF v_after < v_stock.reserved_quantity THEN
    RAISE EXCEPTION 'outlet_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  UPDATE public.outlet_stock
     SET on_hand_quantity = v_after,
         notes            = COALESCE(v_notes, notes),
         updated_by       = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.outlet_stock_movements (
    outlet_stock_id, organization_id, distribution_point_id,
    movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reference_type, reference_id, request_fingerprint,
    actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot, dosage_form_snapshot,
    batch_number_snapshot, internal_batch_reference_snapshot, expiry_date_snapshot
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.distribution_point_id,
    'dispense',
    v_before, -p_quantity, v_after,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    v_reason, 'outlet_request', p_request_id, v_fingerprint,
    v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form,
    v_stock.batch_number, v_stock.internal_batch_reference, v_stock.expiry_date
  )
  RETURNING id INTO v_movement_id;

  v_avail_id := public.phoenix_project_outlet_availability(v_stock.id);

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_stock.organization_id, v_actor, v_actor_role,
    'outlet_stock.dispense', 'outlet_stock', v_stock.id, v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'distribution_point_id', v_stock.distribution_point_id,
      'movement_id', v_movement_id,
      'quantity_before', v_before,
      'quantity_delta', -p_quantity,
      'quantity_after', v_after,
      'reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'outlet_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'item_availability_id', v_avail_id,
    'quantity_before', v_before,
    'quantity_delta', -p_quantity,
    'quantity_after', v_after
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 5c. Physical count / correction.
-- ---------------------------------------------------------------------------
-- Deliberately a SEPARATE RPC on a SEPARATE permission key (outlet_stock.count,
-- flagged is_dangerous in 066). It is the only outlet path that can move stock
-- to an arbitrary number with no document behind it, so it must never be
-- reachable with the everyday dispense permission. A reason is mandatory.
CREATE OR REPLACE FUNCTION public.phoenix_count_outlet_stock(
  p_request_id       uuid,
  p_outlet_stock_id  uuid,
  p_counted_quantity integer,
  p_reason           text,
  p_notes            text DEFAULT NULL
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
  v_stock       public.outlet_stock%ROWTYPE;
  v_existing    public.outlet_stock_movements%ROWTYPE;
  v_reason      text := NULLIF(btrim(p_reason), '');
  v_notes       text := NULLIF(btrim(p_notes), '');
  v_before      integer;
  v_delta       integer;
  v_movement_id uuid;
  v_avail_id    uuid;
  v_fingerprint text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'request_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_outlet_stock_id IS NULL THEN
    RAISE EXCEPTION 'outlet_stock_id_required' USING ERRCODE = '23514';
  END IF;
  IF p_counted_quantity IS NULL OR p_counted_quantity < 0 THEN
    RAISE EXCEPTION 'counted_quantity_must_be_non_negative' USING ERRCODE = '23514';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'outlet_count_reason_required' USING ERRCODE = '23514';
  END IF;

  v_fingerprint := encode(sha256(convert_to(jsonb_build_object(
    'operation', 'count',
    'outlet_stock_id', p_outlet_stock_id,
    'counted_quantity', p_counted_quantity,
    'reason', v_reason,
    'notes', v_notes
  )::text, 'UTF8')), 'hex');

  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 67067));

  SELECT * INTO v_existing
  FROM public.outlet_stock_movements m
  WHERE m.reference_type = 'outlet_request' AND m.reference_id = p_request_id;

  IF FOUND THEN
    IF v_existing.outlet_stock_id IS DISTINCT FROM p_outlet_stock_id
       OR v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'request_id_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'ok', true, 'idempotent_replay', true,
      'outlet_stock_id', v_existing.outlet_stock_id,
      'movement_id', v_existing.id,
      'quantity_before', v_existing.on_hand_before,
      'quantity_delta', v_existing.on_hand_delta,
      'quantity_after', v_existing.on_hand_after
    );
  END IF;

  SELECT * INTO v_stock
  FROM public.outlet_stock WHERE id = p_outlet_stock_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'outlet_stock_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.phoenix_profile_has_scoped_permission(
    v_actor, 'outlet_stock.count', v_stock.organization_id,
    NULL, v_stock.distribution_point_id
  ) THEN
    RAISE EXCEPTION 'forbidden_outlet_stock_count' USING ERRCODE = '42501';
  END IF;

  SELECT p.role, p.full_name INTO v_actor_role, v_actor_name
  FROM public.profiles p WHERE p.id = v_actor AND p.status = 'active';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active_profile_required' USING ERRCODE = '42501';
  END IF;

  v_before := v_stock.on_hand_quantity;
  v_delta  := p_counted_quantity - v_before;

  -- A count may not silently strand a reservation.
  IF p_counted_quantity < v_stock.reserved_quantity THEN
    RAISE EXCEPTION 'outlet_quantity_below_reserved' USING ERRCODE = '23514';
  END IF;

  UPDATE public.outlet_stock
     SET on_hand_quantity = p_counted_quantity,
         notes            = COALESCE(v_notes, notes),
         updated_by       = v_actor
   WHERE id = v_stock.id;

  INSERT INTO public.outlet_stock_movements (
    outlet_stock_id, organization_id, distribution_point_id,
    movement_type,
    on_hand_before, on_hand_delta, on_hand_after,
    reserved_before, reserved_delta, reserved_after,
    reason, reference_type, reference_id, request_fingerprint,
    actor_id, actor_role, actor_name,
    scientific_name_snapshot, concentration_snapshot, dosage_form_snapshot,
    batch_number_snapshot, internal_batch_reference_snapshot, expiry_date_snapshot
  ) VALUES (
    v_stock.id, v_stock.organization_id, v_stock.distribution_point_id,
    'correction',
    v_before, v_delta, p_counted_quantity,
    v_stock.reserved_quantity, 0, v_stock.reserved_quantity,
    v_reason, 'outlet_request', p_request_id, v_fingerprint,
    v_actor, v_actor_role, v_actor_name,
    v_stock.scientific_name, v_stock.concentration, v_stock.dosage_form,
    v_stock.batch_number, v_stock.internal_batch_reference, v_stock.expiry_date
  )
  RETURNING id INTO v_movement_id;

  v_avail_id := public.phoenix_project_outlet_availability(v_stock.id);

  INSERT INTO public.audit_logs (
    organization_id, actor_id, actor_role,
    action, entity_type, entity_id, entity_label, payload
  ) VALUES (
    v_stock.organization_id, v_actor, v_actor_role,
    'outlet_stock.count', 'outlet_stock', v_stock.id, v_stock.scientific_name,
    jsonb_build_object(
      'request_id', p_request_id,
      'distribution_point_id', v_stock.distribution_point_id,
      'movement_id', v_movement_id,
      'quantity_before', v_before,
      'quantity_delta', v_delta,
      'quantity_after', p_counted_quantity,
      'reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'ok', true, 'idempotent_replay', false,
    'outlet_stock_id', v_stock.id,
    'movement_id', v_movement_id,
    'item_availability_id', v_avail_id,
    'quantity_before', v_before,
    'quantity_delta', v_delta,
    'quantity_after', p_counted_quantity
  );
END;
$$;

-- ============================================================================
-- 6. Function privileges
-- ============================================================================

REVOKE ALL ON FUNCTION public.phoenix_receive_outlet_dispatch_line(uuid, uuid, integer, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_receive_outlet_dispatch_line(uuid, uuid, integer, text, text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_dispense_outlet_stock(uuid, uuid, integer, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_dispense_outlet_stock(uuid, uuid, integer, text, text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_count_outlet_stock(uuid, uuid, integer, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_count_outlet_stock(uuid, uuid, integer, text, text)
  TO authenticated;

REVOKE ALL ON FUNCTION public.phoenix_derive_outlet_availability_condition(integer, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_derive_outlet_availability_condition(integer, date)
  TO authenticated;

COMMENT ON FUNCTION public.phoenix_receive_outlet_dispatch_line(uuid, uuid, integer, text, text) IS
  'OUTLET-STOCK-EXPAND-067-A: idempotent dispatch receipt at the destination '
  'outlet. The request UUID is the replay key; the dispatch line can be received '
  'at most once (outlet_stock_movements_dispatch_line_uniq). Requires '
  'outlet_stock.receive scoped to the DESTINATION outlet. Refuses an expired '
  'batch, an unsent dispatch, an already-decided line, a quantity above sent, '
  'and an unexplained difference. Refreshes the item_availability projection and '
  'both dispatch-line result links in the same transaction. INERT until the '
  'dispatch send path (068) exists.';

COMMENT ON FUNCTION public.phoenix_dispense_outlet_stock(uuid, uuid, integer, text, text) IS
  'OUTLET-STOCK-EXPAND-067-A: idempotent outlet dispensing/consumption. Locks the '
  'row, derives the outlet from the locked row (never from the caller), requires '
  'outlet_stock.dispense scoped to that outlet, refuses expired batches, negative '
  'stock and reservation breach, appends one immutable movement, writes '
  'audit_logs, and refreshes the projection in the same transaction.';

COMMENT ON FUNCTION public.phoenix_count_outlet_stock(uuid, uuid, integer, text, text) IS
  'OUTLET-STOCK-EXPAND-067-A: idempotent physical count/correction. Separate RPC '
  'on the separate, dangerous outlet_stock.count key by design — it can set an '
  'arbitrary quantity with no document behind it, so it must never be reachable '
  'with the everyday dispense permission. Reason is mandatory and recorded as a '
  '''correction'' movement.';

-- ============================================================================
-- 7. RLS
-- ============================================================================
-- Reads are policy-gated and scope-aware. Writes have NO policy at all: there is
-- no client write path to outlet_stock or its ledger, so a permissive write
-- policy would be a contradiction. RLS is not the write boundary here — the
-- absent GRANT is, and the RPCs are the only door.

ALTER TABLE public.outlet_stock           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outlet_stock_movements ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.outlet_stock           TO authenticated;
GRANT SELECT ON TABLE public.outlet_stock_movements TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.outlet_stock           FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.outlet_stock_movements FROM authenticated;

-- anon gets nothing. Outlet stock is never public; the QR path keeps using
-- get_public_qr_payload's safe projection and is untouched by this migration.
REVOKE ALL ON TABLE public.outlet_stock           FROM anon;
REVOKE ALL ON TABLE public.outlet_stock_movements FROM anon;

-- ---------------------------------------------------------------------------
-- The outlet read rule, stated once and reused by both policies.
-- ---------------------------------------------------------------------------
-- super_admin       : everything (platform role).
-- outlet_officer    : ONLY its actively-assigned outlets.
-- warehouse_officer : its own organization's outlets, and only where the
--                     operational scope actually reaches — proved by
--                     phoenix_profile_has_scoped_permission, which for
--                     warehouse_officer (an operational, non-org-wide role)
--                     demands an active assignment to the named outlet.
-- central warehouse manager: NOT included. It holds outlet_stock.view=false by
--                     066 default, so the permission check denies it unless an
--                     operator deliberately grants the key AND an outlet scope —
--                     an explicit, audited decision, never an accident of role.
CREATE OR REPLACE FUNCTION public.phoenix_can_read_outlet_stock(
  p_organization_id       uuid,
  p_distribution_point_id uuid
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
           auth.uid(), 'outlet_stock.view', p_organization_id,
           NULL, p_distribution_point_id
         )
    );
$$;

REVOKE ALL ON FUNCTION public.phoenix_can_read_outlet_stock(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.phoenix_can_read_outlet_stock(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.phoenix_can_read_outlet_stock(uuid, uuid) IS
  'OUTLET-STOCK-EXPAND-067-A: the single outlet-stock read rule, so the table and '
  'its ledger can never drift apart. Delegates to '
  'phoenix_profile_has_scoped_permission — never a role literal — so outlet '
  'officers see only their assigned outlets and a central-warehouse manager sees '
  'outlet stock only if deliberately granted both the key and the scope.';

DROP POLICY IF EXISTS outlet_stock_select_scoped ON public.outlet_stock;
CREATE POLICY outlet_stock_select_scoped
  ON public.outlet_stock
  FOR SELECT
  TO authenticated
  USING (public.phoenix_can_read_outlet_stock(organization_id, distribution_point_id));

DROP POLICY IF EXISTS outlet_stock_movements_select_scoped ON public.outlet_stock_movements;
CREATE POLICY outlet_stock_movements_select_scoped
  ON public.outlet_stock_movements
  FOR SELECT
  TO authenticated
  USING (public.phoenix_can_read_outlet_stock(organization_id, distribution_point_id));

-- ============================================================================
-- 8. Role defaults for the 066 keys 067 makes real (Shadow Mode data only)
-- ============================================================================
-- RBAC enforcement stays OFF. These rows describe intent so shadow telemetry can
-- compare decisions; they grant nothing by themselves. ADDITIVE: every statement
-- is ON CONFLICT DO NOTHING, so no existing decision is overwritten.

-- A central warehouse manager must not reach outlet stock by role alone.
INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  ('central_warehouse_manager', 'outlet_stock.view',     false),
  ('central_warehouse_manager', 'outlet_stock.receive',  false),
  ('central_warehouse_manager', 'outlet_stock.dispense', false),
  ('central_warehouse_manager', 'outlet_stock.count',    false)
ON CONFLICT (role, permission_key) DO NOTHING;

-- A warehouse officer oversees its institution's outlets but does not operate
-- them: view yes, dispense/count no. (outlet_stock.view=true already comes from
-- 066; restated here only so the boundary is provable in one place.)
INSERT INTO public.role_permission_defaults (role, permission_key, allowed) VALUES
  ('warehouse_officer', 'outlet_stock.dispense', false),
  ('warehouse_officer', 'outlet_stock.count',    false)
ON CONFLICT (role, permission_key) DO NOTHING;

-- ============================================================================
-- 9. POST-CONDITIONS — additive and non-breaking, proven not asserted
-- ============================================================================
DO $verify$
DECLARE
  v_def   text;
  v_count integer;
BEGIN
  -- 9a. The legacy manual path MUST still work. This migration is worthless if
  --     it silently breaks the screens it exists to protect.
  IF NOT has_function_privilege('authenticated',
      'public.phoenix_upsert_availability(uuid,text,text,text,text,integer,text,date,text,text,text,numeric,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABORT 067: phoenix_upsert_availability lost authenticated EXECUTE.';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.clear_port_availability(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABORT 067: clear_port_availability lost authenticated EXECUTE.';
  END IF;
  IF NOT has_function_privilege('authenticated',
      'public.phoenix_apply_availability_movement(uuid,text,integer,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABORT 067: phoenix_apply_availability_movement lost authenticated EXECUTE.';
  END IF;

  -- 9b. source_kind must be untouched: still defaulting to 'manual'.
  IF EXISTS (
    SELECT 1 FROM pg_attrdef d
    JOIN pg_class c ON c.oid = d.adrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.adnum
    WHERE n.nspname='public' AND c.relname='item_availability' AND a.attname='source_kind'
      AND pg_get_expr(d.adbin, d.adrelid) NOT ILIKE '%manual%'
  ) THEN
    RAISE EXCEPTION 'ABORT 067: source_kind default changed. That belongs to the contract step.';
  END IF;

  -- 9c. New objects exist.
  IF to_regclass('public.outlet_stock') IS NULL THEN
    RAISE EXCEPTION 'ABORT 067: outlet_stock was not created.';
  END IF;
  IF to_regclass('public.outlet_stock_movements') IS NULL THEN
    RAISE EXCEPTION 'ABORT 067: outlet_stock_movements was not created.';
  END IF;

  -- 9d. available_quantity is GENERATED STORED — derived, never writable.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='outlet_stock'
      AND column_name='available_quantity' AND is_generated='ALWAYS'
  ) THEN
    RAISE EXCEPTION 'ABORT 067: outlet_stock.available_quantity is not GENERATED.';
  END IF;

  -- 9e. Negative stock and over-reservation are structurally impossible.
  FOREACH v_def IN ARRAY ARRAY[
    'outlet_stock_on_hand_nonneg_chk',
    'outlet_stock_reserved_nonneg_chk',
    'outlet_stock_reserved_le_on_hand_chk'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_def) THEN
      RAISE EXCEPTION 'ABORT 067: missing quantity invariant: %', v_def;
    END IF;
  END LOOP;

  -- 9f. Identity uniqueness is per outlet + material + batch.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='outlet_stock'
      AND indexname='outlet_stock_identity_uniq' AND indexdef LIKE '%UNIQUE%'
      AND indexdef LIKE '%distribution_point_id%'
      AND indexdef LIKE '%batch_number%'
      AND indexdef LIKE '%internal_batch_reference%'
  ) THEN
    RAISE EXCEPTION 'ABORT 067: outlet stock identity index missing or incomplete.';
  END IF;

  -- 9g. Idempotency is structural, not conventional.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='outlet_stock_movements_request_once_uniq'
      AND indexdef LIKE '%UNIQUE%' AND indexdef LIKE '%outlet_request%'
  ) THEN
    RAISE EXCEPTION 'ABORT 067: outlet request idempotency index missing.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='outlet_stock_movements_dispatch_line_uniq'
      AND indexdef LIKE '%UNIQUE%'
  ) THEN
    RAISE EXCEPTION 'ABORT 067: one-receipt-per-dispatch-line index missing.';
  END IF;

  -- 9h. 061's link is intact and the new one is nullable beside it.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouse_dispatch_lines'
      AND column_name='resulting_item_availability_id'
  ) THEN
    RAISE EXCEPTION 'ABORT 067: resulting_item_availability_id was removed. It must survive expand.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='warehouse_dispatch_lines'
      AND column_name='resulting_outlet_stock_id' AND is_nullable='YES'
  ) THEN
    RAISE EXCEPTION 'ABORT 067: resulting_outlet_stock_id missing or not nullable.';
  END IF;

  -- 9i. Every RPC is SECURITY DEFINER, search_path-pinned, and keeps its
  --     lock/scope/idempotency/ledger/audit/projection boundaries.
  FOREACH v_def IN ARRAY ARRAY[
    'public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text)',
    'public.phoenix_dispense_outlet_stock(uuid,uuid,integer,text,text)',
    'public.phoenix_count_outlet_stock(uuid,uuid,integer,text,text)'
  ] LOOP
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%SECURITY DEFINER%',
      'VERIFY FAILED (067): not SECURITY DEFINER: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%SET search_path%',
      'VERIFY FAILED (067): no pinned search_path: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%pg_advisory_xact_lock%',
      'VERIFY FAILED (067): no advisory lock: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%FOR UPDATE%',
      'VERIFY FAILED (067): no row lock: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%phoenix_profile_has_scoped_permission%',
      'VERIFY FAILED (067): no scoped permission gate (IDOR): ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%request_fingerprint%',
      'VERIFY FAILED (067): no idempotency fingerprint: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%INSERT INTO public.audit_logs%',
      'VERIFY FAILED (067): no audit trail: ' || v_def;
    ASSERT pg_get_functiondef(v_def::regprocedure) LIKE '%phoenix_project_outlet_availability%',
      'VERIFY FAILED (067): no transitional projection: ' || v_def;
  END LOOP;

  -- 9j. Expiry is refused on both the way in and the way out.
  ASSERT pg_get_functiondef(
    'public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text)'::regprocedure
  ) LIKE '%expired_batch_cannot_be_received%',
    'VERIFY FAILED (067): receive does not refuse expired batches';
  ASSERT pg_get_functiondef(
    'public.phoenix_dispense_outlet_stock(uuid,uuid,integer,text,text)'::regprocedure
  ) LIKE '%expired_batch_cannot_be_dispensed%',
    'VERIFY FAILED (067): dispense does not refuse expired batches';

  -- 9k. The projection writer is server-only. If any role could execute it, the
  --     065 guard would be bypassable and item_availability forgeable.
  SELECT count(*) INTO v_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
  WHERE n.nspname='public' AND p.proname='phoenix_project_outlet_availability'
    AND acl.privilege_type='EXECUTE'
    AND (acl.grantee = 0
      OR acl.grantee = (SELECT oid FROM pg_roles WHERE rolname='anon')
      OR acl.grantee = (SELECT oid FROM pg_roles WHERE rolname='authenticated'));
  ASSERT v_count = 0,
    'VERIFY FAILED (067): the projection writer is executable by a client role';

  -- 9l. anon gained nothing.
  IF has_table_privilege('anon', 'public.outlet_stock', 'SELECT')
     OR has_table_privilege('anon', 'public.outlet_stock', 'INSERT')
     OR has_table_privilege('anon', 'public.outlet_stock_movements', 'SELECT') THEN
    RAISE EXCEPTION 'ABORT 067: anon gained access to outlet stock.';
  END IF;

  -- 9m. No client write path to either table.
  SELECT count(*) INTO v_count
  FROM information_schema.role_table_grants
  WHERE table_schema='public'
    AND table_name IN ('outlet_stock','outlet_stock_movements')
    AND grantee='authenticated'
    AND privilege_type IN ('INSERT','UPDATE','DELETE');
  ASSERT v_count = 0,
    'VERIFY FAILED (067): authenticated holds a direct outlet write privilege';

  -- 9n. RLS is on and both tables read through the SAME rule.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname='outlet_stock' AND relrowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname='outlet_stock_movements' AND relrowsecurity) THEN
    RAISE EXCEPTION 'ABORT 067: RLS is not enabled on an outlet table.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='outlet_stock'
      AND policyname='outlet_stock_select_scoped'
      AND qual LIKE '%phoenix_can_read_outlet_stock%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='outlet_stock_movements'
      AND policyname='outlet_stock_movements_select_scoped'
      AND qual LIKE '%phoenix_can_read_outlet_stock%'
  ) THEN
    RAISE EXCEPTION 'ABORT 067: an outlet read policy is missing or bypasses the shared rule.';
  END IF;

  -- 9o. No write policy exists on either table: the absent GRANT is the write
  --     boundary, and a permissive write policy would contradict it.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename IN ('outlet_stock','outlet_stock_movements')
      AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION 'ABORT 067: a non-SELECT policy exists on an outlet table.';
  END IF;

  -- 9p. outlet_officer can operate its outlet; central manager cannot reach it.
  IF (SELECT allowed FROM public.role_permission_defaults
      WHERE role='outlet_officer' AND permission_key='outlet_stock.dispense') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ABORT 067: outlet_officer lost outlet_stock.dispense.';
  END IF;
  IF (SELECT allowed FROM public.role_permission_defaults
      WHERE role='central_warehouse_manager' AND permission_key='outlet_stock.view') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ABORT 067: central_warehouse_manager must not hold outlet_stock.view by default.';
  END IF;
  IF (SELECT allowed FROM public.role_permission_defaults
      WHERE role='warehouse_officer' AND permission_key='outlet_stock.view') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'ABORT 067: warehouse_officer must keep outlet_stock.view.';
  END IF;

  -- 9q. Public QR never learns about outlet stock or private provenance.
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='get_public_qr_payload'
  ORDER BY p.oid DESC LIMIT 1;
  ASSERT v_def IS NOT NULL, 'VERIFY FAILED (067): public QR function missing';
  ASSERT v_def NOT ILIKE '%outlet_stock%'
     AND v_def NOT ILIKE '%internal_batch_reference%'
     AND v_def NOT ILIKE '%source_kind%',
    'VERIFY FAILED (067): outlet stock or private provenance leaked into public QR';

  RAISE NOTICE '067 verified: outlet_stock is the outlet''s operational truth; '
    'quantities are generated/constrained; receipts and requests are idempotent '
    'at the database level; every RPC locks, authorizes by scope, audits, and '
    'projects item_availability in-transaction; anon and direct client writes '
    'remain shut out; the legacy manual path is untouched.';
END;
$verify$;

commit;

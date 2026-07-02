-- =============================================================================
-- MediStock Phoenix V2 — Migration 040: Inter-Org Exchange Request Schema
-- =============================================================================
-- MANUAL APPLY ONLY — DO NOT use `npx supabase db push`.
-- Apply via Supabase Dashboard → SQL Editor after a verified backup.
--
-- Prerequisites: 001 (item_availability, organizations, distribution_points,
-- phoenix_set_updated_at), 002 (phoenix_my_role/phoenix_my_org), 010
-- (permission_keys, role_permission_defaults, phoenix_profile_has_permission),
-- 033 (item_availability_movements), 036/037 (live inter-institution alert
-- computation + stable alert_key format), 038 (inter_org_alert_states —
-- alert_key is keyed the same way here).
--
-- Task: INTER-INSTITUTION-EXCHANGE-SCHEMA-B (audited/designed in
-- INTER-INSTITUTION-EXCHANGE-WORKFLOW-AUDIT-A).
--
-- Purpose (schema/permissions/RLS ONLY — this migration deliberately does NOT
-- create any RPC and does NOT touch any UI):
--   The exchange-workflow audit designed a controlled process for turning a
--   live inter-institution alert (surplus/near-expiry at a source institution
--   matched against missing/low-stock at a target institution) into a real,
--   auditable, cross-organization stock exchange. This migration lays the
--   storage foundation for that design:
--     1. inter_org_exchange_requests — one row per requested exchange,
--        snapshotting the alert's identity at request time and tracking the
--        full requested → source_approved/source_rejected → dispatched →
--        received → completed / cancelled status machine.
--     2. inter_org_exchange_events — an immutable, append-only event log
--        recording every status transition, mirroring the
--        inter_org_alert_events (migration 038) / item_availability_movements
--        (migration 033) ledger pattern.
--     3. Ten new permission keys under a new inter_org_exchange.* namespace,
--        seeded into role_permission_defaults per the approved matrix.
--     4. RLS + grants for both tables, following the exact SELECT-only,
--        org-scoped, permission-gated pattern already proven in migrations
--        033/038 — no INSERT/UPDATE/DELETE grant or policy for authenticated
--        on either table; all future writes will go through SECURITY DEFINER
--        RPCs (not created in this migration).
--
-- What this migration does NOT do:
--   - Does NOT modify migrations 001-039 in any way.
--   - Does NOT modify phoenix_get_live_inter_institution_alerts (036/037) or
--     the inter_org_alert_states/inter_org_alert_events lifecycle RPCs (039).
--   - Does NOT create phoenix_create_inter_org_exchange_request,
--     phoenix_update_inter_org_exchange_status,
--     phoenix_get_inter_org_exchange_events,
--     phoenix_get_inter_org_exchange_requests, or any other exchange RPC —
--     that is a future, separately reported phase
--     (INTER-INSTITUTION-EXCHANGE-RPCS-C).
--   - Does NOT wire InterInstitutionAlertsScreen, DashboardScreen, or any
--     other screen to this schema — no frontend changes at all in this
--     migration.
--   - Does NOT touch get_public_qr_payload, qr_tokens, qr_targets, or any
--     other QR-related object.
--   - Does NOT touch phoenix_apply_availability_movement, phoenix_upsert_
--     availability, or item_availability_movements (quantity-movement
--     features untouched) — item_availability_movements.id is only ever
--     referenced here (movement_id_out/movement_id_in), never written to.
--   - Does NOT touch StatusCenterScreen or any src/features/status file.
--   - Does NOT update item_availability.quantity anywhere in this file.
--   - Does NOT grant INSERT, UPDATE, or DELETE on either new table to anon or
--     authenticated.
--   - Does NOT use service_role or any elevated/admin API key.
--   - Does NOT add Excel/XLSX import.
--   - Does NOT expose supply_type anywhere.
--
-- Movement finalization design decision (documented per the audit's section
-- G.5, restated here since it shapes the movement_id_out/movement_id_in
-- columns below): a future phase will fold the stock adjustment into the
-- `dispatched → received` transition of phoenix_update_inter_org_exchange_
-- status, writing two new item_availability_movements rows (a new
-- movement_type value, e.g. transfer_out/transfer_in — NOT reusing
-- set_exact/add/subtract/correction) and stamping their ids back onto this
-- request row. No trigger of any kind is created here to touch stock
-- automatically; that logic belongs entirely to the future RPC.
--
-- movement_id_out/movement_id_in "required at completed" constraint: the task
-- asked whether this can be expressed safely as a CHECK constraint. It can —
-- CHECK constraints may reference multiple columns of the same row — so it is
-- included below (inter_org_exchange_requests_completed_movement_ids_chk).
--
-- Direct-SELECT decision for inter_org_exchange_events (same reasoning as
-- inter_org_alert_events in migration 038):
--   Chosen: NO direct SELECT policy on inter_org_exchange_events in this
--   phase. Reason: event rows carry actor_name_snapshot/actor_email_snapshot
--   (personal identifying info) on every transition, broader than what any
--   current direct-SELECT ledger exposes. Until a future RPC can apply a
--   controlled projection, the safer default is no direct table-level SELECT
--   access at all. authenticated is not granted SELECT on
--   inter_org_exchange_events; a future RPC (e.g.
--   phoenix_get_inter_org_exchange_events(p_exchange_request_id)) will read
--   it via SECURITY DEFINER once created, bypassing this restriction
--   internally. RLS is still enabled — enabling RLS with zero policies denies
--   all rows to every role except a SECURITY DEFINER function.
--
-- Safety:
--   - Idempotent: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS,
--     CREATE UNIQUE INDEX IF NOT EXISTS, INSERT ... ON CONFLICT, DROP POLICY
--     IF EXISTS + CREATE POLICY. Safe to re-run.
--   - RLS enabled on both tables; no write policy exists for any role at the
--     RLS layer, and no INSERT/UPDATE/DELETE grant is made at the table-
--     privilege layer either (defense in depth, same as migrations 033/038).
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. Permission catalog — 10 new keys under a new inter_org_exchange.*
--    namespace
-- =============================================================================

INSERT INTO permission_keys (key, module, action, label_en, label_ar, is_dangerous)
VALUES
  ('inter_org_exchange.view',        'inter_org_exchange', 'view',        'View inter-org exchange requests',            'عرض طلبات التبادل بين المؤسسات',              false),
  ('inter_org_exchange.request',     'inter_org_exchange', 'request',     'Create inter-org exchange request',           'إنشاء طلب تبادل بين المؤسسات',                false),
  ('inter_org_exchange.approve',     'inter_org_exchange', 'approve',     'Approve/reject inter-org exchange request',   'الموافقة على طلب التبادل أو رفضه',            true),
  ('inter_org_exchange.dispatch',    'inter_org_exchange', 'dispatch',    'Dispatch approved inter-org exchange',        'إرسال التبادل المعتمد بين المؤسسات',          false),
  ('inter_org_exchange.receive',     'inter_org_exchange', 'receive',     'Receive dispatched inter-org exchange',       'استلام التبادل المرسل بين المؤسسات',          false),
  ('inter_org_exchange.cancel',      'inter_org_exchange', 'cancel',      'Cancel inter-org exchange request',           'إلغاء طلب التبادل بين المؤسسات',              false),
  ('inter_org_exchange.manage',      'inter_org_exchange', 'manage',      'Administratively override exchange status',  'إدارة/تجاوز حالة التبادل إدارياً',            true),
  ('inter_org_exchange.events.view', 'inter_org_exchange', 'events_view', 'View inter-org exchange event history',       'عرض سجل أحداث التبادل بين المؤسسات',          false),
  ('inter_org_exchange.print',       'inter_org_exchange', 'print',       'Print inter-org exchange requests',           'طباعة طلبات التبادل بين المؤسسات',            false),
  ('inter_org_exchange.export',      'inter_org_exchange', 'export',      'Export inter-org exchange requests',          'تصدير طلبات التبادل بين المؤسسات',            false)
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
-- 2. Seed role_permission_defaults per the approved matrix
-- =============================================================================
-- super_admin/institution_admin: all ten keys. warehouse_officer: everything
-- except approve/manage (the two dangerous keys — approving releases another
-- org's real stock, matching how availability.quantity.correct and
-- inter_institution_alerts.dismiss are the system's only other dangerous
-- keys). port_officer/monthly_status_officer: view-only tier (view,
-- events.view, print — no export, no write actions), mirroring their
-- existing availability.movements.{view=true,export=false,print=false}
-- pattern (migration 033) except print is granted here since exchange
-- requests are lower-volume, human-reviewed records than the movement
-- ledger. viewer: view + events.view only, matching the read-only floor
-- every other role above gets, with no export/print/write access at all —
-- the strictest tier in the whole permission set below.

INSERT INTO role_permission_defaults (role, permission_key, allowed) VALUES
  -- super_admin: all ten
  ('super_admin',            'inter_org_exchange.view',        true),
  ('super_admin',            'inter_org_exchange.request',     true),
  ('super_admin',            'inter_org_exchange.approve',     true),
  ('super_admin',            'inter_org_exchange.dispatch',    true),
  ('super_admin',            'inter_org_exchange.receive',     true),
  ('super_admin',            'inter_org_exchange.cancel',      true),
  ('super_admin',            'inter_org_exchange.manage',      true),
  ('super_admin',            'inter_org_exchange.events.view', true),
  ('super_admin',            'inter_org_exchange.print',       true),
  ('super_admin',            'inter_org_exchange.export',      true),

  -- institution_admin: all ten
  ('institution_admin',      'inter_org_exchange.view',        true),
  ('institution_admin',      'inter_org_exchange.request',     true),
  ('institution_admin',      'inter_org_exchange.approve',     true),
  ('institution_admin',      'inter_org_exchange.dispatch',    true),
  ('institution_admin',      'inter_org_exchange.receive',     true),
  ('institution_admin',      'inter_org_exchange.cancel',      true),
  ('institution_admin',      'inter_org_exchange.manage',      true),
  ('institution_admin',      'inter_org_exchange.events.view', true),
  ('institution_admin',      'inter_org_exchange.print',       true),
  ('institution_admin',      'inter_org_exchange.export',      true),

  -- hospital_admin (legacy): same as institution_admin
  ('hospital_admin',         'inter_org_exchange.view',        true),
  ('hospital_admin',         'inter_org_exchange.request',     true),
  ('hospital_admin',         'inter_org_exchange.approve',     true),
  ('hospital_admin',         'inter_org_exchange.dispatch',    true),
  ('hospital_admin',         'inter_org_exchange.receive',     true),
  ('hospital_admin',         'inter_org_exchange.cancel',      true),
  ('hospital_admin',         'inter_org_exchange.manage',      true),
  ('hospital_admin',         'inter_org_exchange.events.view', true),
  ('hospital_admin',         'inter_org_exchange.print',       true),
  ('hospital_admin',         'inter_org_exchange.export',      true),

  -- warehouse_officer: everything except the two dangerous keys
  ('warehouse_officer',      'inter_org_exchange.view',        true),
  ('warehouse_officer',      'inter_org_exchange.request',     true),
  ('warehouse_officer',      'inter_org_exchange.approve',     false),
  ('warehouse_officer',      'inter_org_exchange.dispatch',    true),
  ('warehouse_officer',      'inter_org_exchange.receive',     true),
  ('warehouse_officer',      'inter_org_exchange.cancel',      true),
  ('warehouse_officer',      'inter_org_exchange.manage',      false),
  ('warehouse_officer',      'inter_org_exchange.events.view', true),
  ('warehouse_officer',      'inter_org_exchange.print',       true),
  ('warehouse_officer',      'inter_org_exchange.export',      true),

  -- warehouse_manager (legacy): same as warehouse_officer
  ('warehouse_manager',      'inter_org_exchange.view',        true),
  ('warehouse_manager',      'inter_org_exchange.request',     true),
  ('warehouse_manager',      'inter_org_exchange.approve',     false),
  ('warehouse_manager',      'inter_org_exchange.dispatch',    true),
  ('warehouse_manager',      'inter_org_exchange.receive',     true),
  ('warehouse_manager',      'inter_org_exchange.cancel',      true),
  ('warehouse_manager',      'inter_org_exchange.manage',      false),
  ('warehouse_manager',      'inter_org_exchange.events.view', true),
  ('warehouse_manager',      'inter_org_exchange.print',       true),
  ('warehouse_manager',      'inter_org_exchange.export',      true),

  -- port_officer: view-only tier (view, events.view, print)
  ('port_officer',           'inter_org_exchange.view',        true),
  ('port_officer',           'inter_org_exchange.request',     false),
  ('port_officer',           'inter_org_exchange.approve',     false),
  ('port_officer',           'inter_org_exchange.dispatch',    false),
  ('port_officer',           'inter_org_exchange.receive',     false),
  ('port_officer',           'inter_org_exchange.cancel',      false),
  ('port_officer',           'inter_org_exchange.manage',      false),
  ('port_officer',           'inter_org_exchange.events.view', true),
  ('port_officer',           'inter_org_exchange.print',       true),
  ('port_officer',           'inter_org_exchange.export',      false),

  -- point_operator (legacy): same as port_officer
  ('point_operator',         'inter_org_exchange.view',        true),
  ('point_operator',         'inter_org_exchange.request',     false),
  ('point_operator',         'inter_org_exchange.approve',     false),
  ('point_operator',         'inter_org_exchange.dispatch',    false),
  ('point_operator',         'inter_org_exchange.receive',     false),
  ('point_operator',         'inter_org_exchange.cancel',      false),
  ('point_operator',         'inter_org_exchange.manage',      false),
  ('point_operator',         'inter_org_exchange.events.view', true),
  ('point_operator',         'inter_org_exchange.print',       true),
  ('point_operator',         'inter_org_exchange.export',      false),

  -- monthly_status_officer: view-only tier (view, events.view, print)
  ('monthly_status_officer', 'inter_org_exchange.view',        true),
  ('monthly_status_officer', 'inter_org_exchange.request',     false),
  ('monthly_status_officer', 'inter_org_exchange.approve',     false),
  ('monthly_status_officer', 'inter_org_exchange.dispatch',    false),
  ('monthly_status_officer', 'inter_org_exchange.receive',     false),
  ('monthly_status_officer', 'inter_org_exchange.cancel',      false),
  ('monthly_status_officer', 'inter_org_exchange.manage',      false),
  ('monthly_status_officer', 'inter_org_exchange.events.view', true),
  ('monthly_status_officer', 'inter_org_exchange.print',       true),
  ('monthly_status_officer', 'inter_org_exchange.export',      false),

  -- transfer_manager (legacy): same as monthly_status_officer
  ('transfer_manager',       'inter_org_exchange.view',        true),
  ('transfer_manager',       'inter_org_exchange.request',     false),
  ('transfer_manager',       'inter_org_exchange.approve',     false),
  ('transfer_manager',       'inter_org_exchange.dispatch',    false),
  ('transfer_manager',       'inter_org_exchange.receive',     false),
  ('transfer_manager',       'inter_org_exchange.cancel',      false),
  ('transfer_manager',       'inter_org_exchange.manage',      false),
  ('transfer_manager',       'inter_org_exchange.events.view', true),
  ('transfer_manager',       'inter_org_exchange.print',       true),
  ('transfer_manager',       'inter_org_exchange.export',      false),

  -- viewer: strictest tier — view + events.view only
  ('viewer',                 'inter_org_exchange.view',        true),
  ('viewer',                 'inter_org_exchange.request',     false),
  ('viewer',                 'inter_org_exchange.approve',     false),
  ('viewer',                 'inter_org_exchange.dispatch',    false),
  ('viewer',                 'inter_org_exchange.receive',     false),
  ('viewer',                 'inter_org_exchange.cancel',      false),
  ('viewer',                 'inter_org_exchange.manage',      false),
  ('viewer',                 'inter_org_exchange.events.view', true),
  ('viewer',                 'inter_org_exchange.print',       false),
  ('viewer',                 'inter_org_exchange.export',      false)
ON CONFLICT (role, permission_key) DO UPDATE SET allowed = excluded.allowed;

-- =============================================================================
-- 3. inter_org_exchange_requests — one row per requested exchange
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.inter_org_exchange_requests (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Link back to the live alert this request was created from. alert_key is
  -- NOT a foreign key (the underlying inter_org_alert_states row can churn as
  -- alerts are recomputed) — a future RPC validates its existence/status at
  -- request-creation time instead. alert_state_id is a best-effort direct
  -- link, nullable because that specific state row could later be superseded.
  alert_key                     text NOT NULL,
  alert_state_id                uuid REFERENCES public.inter_org_alert_states(id) ON DELETE SET NULL,

  source_item_availability_id   uuid NOT NULL REFERENCES public.item_availability(id) ON DELETE RESTRICT,
  target_item_availability_id   uuid NOT NULL REFERENCES public.item_availability(id) ON DELETE RESTRICT,
  source_organization_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  target_organization_id        uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  source_distribution_point_id  uuid REFERENCES public.distribution_points(id) ON DELETE SET NULL,
  target_distribution_point_id  uuid REFERENCES public.distribution_points(id) ON DELETE SET NULL,

  -- Denormalized identity snapshot at request time — item_availability's own
  -- identity fields are mutable, so this row snapshots them the same way
  -- item_availability_movements (033) and inter_org_alert_states (038) do.
  scientific_name               text NOT NULL,
  concentration                 text,
  dosage_form                   text,
  source_trade_name             text,
  target_trade_name             text,

  requested_quantity            integer NOT NULL,
  approved_quantity             integer,
  received_quantity             integer,

  status                        text NOT NULL DEFAULT 'requested'
                                  CHECK (status IN (
                                    'requested', 'source_approved', 'source_rejected',
                                    'dispatched', 'received', 'completed', 'cancelled'
                                  )),
  severity_snapshot              text
                                  CHECK (severity_snapshot IS NULL OR severity_snapshot IN ('high', 'medium', 'low')),

  reason                        text,
  notes                         text,

  requested_by                  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by                   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  dispatched_by                 uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  received_by                   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_by                  uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Populated by a future RPC at the dispatched → received transition, once
  -- it writes the paired transfer_out/transfer_in rows to
  -- item_availability_movements. This migration creates no trigger and no RPC
  -- that writes these columns — they simply exist, nullable, ready for that
  -- future write path.
  movement_id_out                uuid REFERENCES public.item_availability_movements(id) ON DELETE SET NULL,
  movement_id_in                 uuid REFERENCES public.item_availability_movements(id) ON DELETE SET NULL,

  requested_at                  timestamptz,
  approved_at                   timestamptz,
  dispatched_at                 timestamptz,
  received_at                   timestamptz,
  completed_at                  timestamptz,
  cancelled_at                  timestamptz,

  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT inter_org_exchange_requests_orgs_distinct_chk
    CHECK (source_organization_id <> target_organization_id),
  CONSTRAINT inter_org_exchange_requests_availability_distinct_chk
    CHECK (source_item_availability_id <> target_item_availability_id),

  CONSTRAINT inter_org_exchange_requests_requested_qty_chk
    CHECK (requested_quantity > 0),
  CONSTRAINT inter_org_exchange_requests_approved_qty_chk
    CHECK (approved_quantity IS NULL OR approved_quantity > 0),
  CONSTRAINT inter_org_exchange_requests_received_qty_chk
    CHECK (received_quantity IS NULL OR received_quantity > 0),

  -- source_rejected/cancelled must be explained (mirrors the dismiss/resolve
  -- reason-required pattern in inter_org_alert_states, migration 038).
  CONSTRAINT inter_org_exchange_requests_rejected_reason_chk
    CHECK (status <> 'source_rejected' OR (reason IS NOT NULL AND btrim(reason) <> '')),
  CONSTRAINT inter_org_exchange_requests_cancelled_reason_chk
    CHECK (status <> 'cancelled' OR (reason IS NOT NULL AND btrim(reason) <> '')),

  -- approved_quantity must be set once the source has approved (or moved
  -- beyond approval) — a request cannot reach dispatched/received/completed
  -- without ever having recorded how much was approved.
  CONSTRAINT inter_org_exchange_requests_approved_qty_required_chk
    CHECK (status NOT IN ('source_approved', 'dispatched', 'received', 'completed') OR approved_quantity IS NOT NULL),

  -- received_quantity must be set once the target has confirmed receipt.
  CONSTRAINT inter_org_exchange_requests_received_qty_required_chk
    CHECK (status NOT IN ('received', 'completed') OR received_quantity IS NOT NULL),

  -- A completed request must reference both ledger rows the finalizing RPC
  -- wrote (transfer_out at the source, transfer_in at the target) — this can
  -- be safely expressed as a plain multi-column CHECK (no external state
  -- needed), so it is enforced at the schema level rather than deferred to
  -- the RPC phase.
  CONSTRAINT inter_org_exchange_requests_completed_movement_ids_chk
    CHECK (status <> 'completed' OR (movement_id_out IS NOT NULL AND movement_id_in IS NOT NULL))
);

COMMENT ON TABLE public.inter_org_exchange_requests IS
  'One row per requested inter-organization stock exchange, created from a '
  'live inter-institution alert (alert_key). Tracks the full requested -> '
  'source_approved/source_rejected -> dispatched -> received -> completed / '
  'cancelled status machine. Rows are inserted/updated ONLY by a future '
  'SECURITY DEFINER RPC (not yet created as of migration 040) — there is no '
  'direct client INSERT, UPDATE, or DELETE path, by design. This table never '
  'directly stores or modifies item_availability.quantity; movement_id_out/'
  'movement_id_in only reference the item_availability_movements rows a '
  'future RPC will write once, at the dispatched -> received transition.';

COMMENT ON COLUMN public.inter_org_exchange_requests.alert_key IS
  'Same deterministic key format as inter_org_alert_states.alert_key '
  '(source_item_availability_id || '':'' || target_item_availability_id || '
  ''':'' || alert_type). Not a foreign key — a future RPC validates the '
  'referenced alert''s existence/status at request-creation time.';

-- =============================================================================
-- 4. inter_org_exchange_events — immutable, append-only event log
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.inter_org_exchange_events (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_request_id     uuid NOT NULL REFERENCES public.inter_org_exchange_requests(id) ON DELETE RESTRICT,

  event_type               text NOT NULL
                             CHECK (event_type IN (
                               'requested', 'source_approved', 'source_rejected',
                               'dispatched', 'received', 'completed', 'cancelled'
                             )),

  actor_id                 uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Which org the actor was acting for — both orgs touch one request, so this
  -- disambiguates "source approved" vs "target received" beyond what actor_id
  -- alone shows.
  actor_org_id             uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  actor_name_snapshot      text,
  actor_email_snapshot     text,
  actor_role_snapshot      text,

  from_status               text
                             CHECK (from_status IS NULL OR from_status IN (
                               'requested', 'source_approved', 'source_rejected',
                               'dispatched', 'received', 'completed', 'cancelled'
                             )),
  to_status                 text
                             CHECK (to_status IS NULL OR to_status IN (
                               'requested', 'source_approved', 'source_rejected',
                               'dispatched', 'received', 'completed', 'cancelled'
                             )),

  -- e.g. {"requested":50,"approved":40,"received":40} at the moment of this
  -- event — a plain object, never an array/scalar.
  quantity_snapshot         jsonb
                             CHECK (quantity_snapshot IS NULL OR jsonb_typeof(quantity_snapshot) = 'object'),

  reason                   text,
  notes                    text,

  created_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.inter_org_exchange_events IS
  'Immutable event log recording every inter_org_exchange_requests status '
  'transition, mirroring the inter_org_alert_events (038) / '
  'item_availability_movements (033) ledger pattern. Rows are inserted ONLY '
  'by a future SECURITY DEFINER RPC (not yet created as of migration 040) — '
  'there is no direct client INSERT, UPDATE, or DELETE path, and (per the '
  'direct-SELECT decision documented in this migration''s header) no direct '
  'client SELECT path either. Event rows must never be edited or removed '
  'after creation.';

-- =============================================================================
-- 5. Indexes
-- =============================================================================

CREATE INDEX IF NOT EXISTS inter_org_exchange_requests_alert_key_idx
  ON public.inter_org_exchange_requests(alert_key);
CREATE INDEX IF NOT EXISTS inter_org_exchange_requests_status_idx
  ON public.inter_org_exchange_requests(status);
CREATE INDEX IF NOT EXISTS inter_org_exchange_requests_source_org_status_idx
  ON public.inter_org_exchange_requests(source_organization_id, status);
CREATE INDEX IF NOT EXISTS inter_org_exchange_requests_target_org_status_idx
  ON public.inter_org_exchange_requests(target_organization_id, status);
CREATE INDEX IF NOT EXISTS inter_org_exchange_requests_source_avail_idx
  ON public.inter_org_exchange_requests(source_item_availability_id);
CREATE INDEX IF NOT EXISTS inter_org_exchange_requests_target_avail_idx
  ON public.inter_org_exchange_requests(target_item_availability_id);

-- Prevents duplicate active exchange requests for the same alert_key at the
-- schema level (not just application logic) — a race condition cannot slip
-- through. "Active" = not yet in a terminal status.
CREATE UNIQUE INDEX IF NOT EXISTS inter_org_exchange_requests_active_alert_key_uq
  ON public.inter_org_exchange_requests(alert_key)
  WHERE status NOT IN ('source_rejected', 'cancelled', 'completed');

CREATE INDEX IF NOT EXISTS inter_org_exchange_events_request_created_idx
  ON public.inter_org_exchange_events(exchange_request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inter_org_exchange_events_type_idx
  ON public.inter_org_exchange_events(event_type);
CREATE INDEX IF NOT EXISTS inter_org_exchange_events_actor_org_idx
  ON public.inter_org_exchange_events(actor_org_id);
CREATE INDEX IF NOT EXISTS inter_org_exchange_events_created_idx
  ON public.inter_org_exchange_events(created_at DESC);

-- =============================================================================
-- 6. updated_at trigger for inter_org_exchange_requests (reuses the project's
--    standard phoenix_set_updated_at() function, migration 001). This is the
--    ONLY trigger created in this migration — it maintains updated_at and
--    never touches item_availability or any stock quantity.
-- =============================================================================

DO $$ BEGIN
  CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.inter_org_exchange_requests
    FOR EACH ROW EXECUTE FUNCTION phoenix_set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- 7. RLS
-- =============================================================================

ALTER TABLE public.inter_org_exchange_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inter_org_exchange_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inter_org_exchange_requests_select_perm" ON public.inter_org_exchange_requests;

CREATE POLICY "inter_org_exchange_requests_select_perm" ON public.inter_org_exchange_requests
  FOR SELECT TO authenticated
  USING (
    phoenix_my_role() = 'super_admin'
    OR (
      phoenix_profile_has_permission(auth.uid(), 'inter_org_exchange.view')
      AND (
        source_organization_id = phoenix_my_org()
        OR target_organization_id = phoenix_my_org()
      )
    )
  );

-- No INSERT/UPDATE/DELETE policy on inter_org_exchange_requests — intentional.
-- All future writes go through SECURITY DEFINER RPCs (not yet created), which
-- bypass RLS internally, same pattern as phoenix_apply_availability_movement
-- / item_availability_movements and phoenix_update_inter_org_alert_state /
-- inter_org_alert_states.

-- inter_org_exchange_events: RLS enabled, but NO SELECT/INSERT/UPDATE/DELETE
-- policy is created for authenticated in this phase — see the direct-SELECT
-- decision documented in this migration's header. With RLS enabled and zero
-- policies, every role (including authenticated) sees zero rows via direct
-- table access; a future SECURITY DEFINER RPC will read/write it by
-- bypassing RLS internally.

-- =============================================================================
-- 8. Grants
-- =============================================================================

REVOKE ALL ON TABLE public.inter_org_exchange_requests FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.inter_org_exchange_requests TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.inter_org_exchange_requests FROM authenticated;

REVOKE ALL ON TABLE public.inter_org_exchange_events FROM PUBLIC, anon;
-- No SELECT grant to authenticated either — see direct-SELECT decision above.
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.inter_org_exchange_events FROM authenticated;

-- =============================================================================
-- VERIFY
-- =============================================================================

DO $$
DECLARE
  v_requests_exists     boolean;
  v_events_exists       boolean;
  v_requests_rls        boolean;
  v_events_rls          boolean;
  v_key_count           int;
  v_requests_col_count  int;
  v_events_col_count    int;
  v_requests_policy_count int;
  v_events_policy_count   int;
  v_select_qual         text;
  v_unique_idx_exists   boolean;
BEGIN
  -- A. Both tables exist
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'inter_org_exchange_requests'
  ) INTO v_requests_exists;
  ASSERT v_requests_exists, 'VERIFY FAILED: inter_org_exchange_requests table not found';

  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'inter_org_exchange_events'
  ) INTO v_events_exists;
  ASSERT v_events_exists, 'VERIFY FAILED: inter_org_exchange_events table not found';

  -- B. RLS enabled on both
  SELECT relrowsecurity INTO v_requests_rls
  FROM pg_class WHERE relname = 'inter_org_exchange_requests' AND relnamespace = 'public'::regnamespace;
  ASSERT v_requests_rls, 'VERIFY FAILED: RLS not enabled on inter_org_exchange_requests';

  SELECT relrowsecurity INTO v_events_rls
  FROM pg_class WHERE relname = 'inter_org_exchange_events' AND relnamespace = 'public'::regnamespace;
  ASSERT v_events_rls, 'VERIFY FAILED: RLS not enabled on inter_org_exchange_events';

  -- C. Expected columns exist on inter_org_exchange_requests
  SELECT count(*) INTO v_requests_col_count FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'inter_org_exchange_requests'
    AND column_name IN (
      'id','alert_key','alert_state_id',
      'source_item_availability_id','target_item_availability_id',
      'source_organization_id','target_organization_id',
      'source_distribution_point_id','target_distribution_point_id',
      'scientific_name','concentration','dosage_form',
      'source_trade_name','target_trade_name',
      'requested_quantity','approved_quantity','received_quantity',
      'status','severity_snapshot','reason','notes',
      'requested_by','approved_by','dispatched_by','received_by','cancelled_by',
      'movement_id_out','movement_id_in',
      'requested_at','approved_at','dispatched_at','received_at','completed_at','cancelled_at',
      'created_at','updated_at'
    );
  ASSERT v_requests_col_count = 36,
    format('VERIFY FAILED: expected 36 columns on inter_org_exchange_requests, found %s', v_requests_col_count);

  -- D. Expected columns exist on inter_org_exchange_events
  SELECT count(*) INTO v_events_col_count FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'inter_org_exchange_events'
    AND column_name IN (
      'id','exchange_request_id','event_type','actor_id','actor_org_id',
      'actor_name_snapshot','actor_email_snapshot','actor_role_snapshot',
      'from_status','to_status','quantity_snapshot','reason','notes','created_at'
    );
  ASSERT v_events_col_count = 14,
    format('VERIFY FAILED: expected 14 columns on inter_org_exchange_events, found %s', v_events_col_count);

  -- E. status/event_type CHECK constraints exist
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.check_constraints cc
    JOIN information_schema.constraint_column_usage ccu ON cc.constraint_name = ccu.constraint_name
    WHERE ccu.table_name = 'inter_org_exchange_requests' AND ccu.column_name = 'status'
  ), 'VERIFY FAILED: no status CHECK constraint found on inter_org_exchange_requests';

  ASSERT EXISTS (
    SELECT 1 FROM information_schema.check_constraints cc
    JOIN information_schema.constraint_column_usage ccu ON cc.constraint_name = ccu.constraint_name
    WHERE ccu.table_name = 'inter_org_exchange_events' AND ccu.column_name = 'event_type'
  ), 'VERIFY FAILED: no event_type CHECK constraint found on inter_org_exchange_events';

  -- F. 10 new permission keys exist
  SELECT count(*) INTO v_key_count FROM permission_keys
  WHERE key IN (
    'inter_org_exchange.view', 'inter_org_exchange.request', 'inter_org_exchange.approve',
    'inter_org_exchange.dispatch', 'inter_org_exchange.receive', 'inter_org_exchange.cancel',
    'inter_org_exchange.manage', 'inter_org_exchange.events.view',
    'inter_org_exchange.print', 'inter_org_exchange.export'
  );
  ASSERT v_key_count = 10,
    format('VERIFY FAILED: expected 10 new permission keys, found %s', v_key_count);

  -- G. approve/manage are marked dangerous; the rest are not
  ASSERT (SELECT is_dangerous FROM permission_keys WHERE key = 'inter_org_exchange.approve') = true,
    'VERIFY FAILED: inter_org_exchange.approve must be marked dangerous';
  ASSERT (SELECT is_dangerous FROM permission_keys WHERE key = 'inter_org_exchange.manage') = true,
    'VERIFY FAILED: inter_org_exchange.manage must be marked dangerous';
  ASSERT (SELECT count(*) FROM permission_keys WHERE key LIKE 'inter_org_exchange.%' AND is_dangerous = true) = 2,
    'VERIFY FAILED: exactly 2 inter_org_exchange.* keys should be dangerous (approve, manage)';

  -- H. Role defaults spot-check
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'super_admin' AND permission_key = 'inter_org_exchange.approve') = true,
    'VERIFY FAILED: super_admin should have inter_org_exchange.approve = true';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'warehouse_officer' AND permission_key = 'inter_org_exchange.approve') = false,
    'VERIFY FAILED: warehouse_officer should have inter_org_exchange.approve = false';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'warehouse_officer' AND permission_key = 'inter_org_exchange.dispatch') = true,
    'VERIFY FAILED: warehouse_officer should have inter_org_exchange.dispatch = true';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'port_officer' AND permission_key = 'inter_org_exchange.request') = false,
    'VERIFY FAILED: port_officer should have inter_org_exchange.request = false';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'port_officer' AND permission_key = 'inter_org_exchange.view') = true,
    'VERIFY FAILED: port_officer should have inter_org_exchange.view = true';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'monthly_status_officer' AND permission_key = 'inter_org_exchange.export') = false,
    'VERIFY FAILED: monthly_status_officer should have inter_org_exchange.export = false';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'viewer' AND permission_key = 'inter_org_exchange.view') = true,
    'VERIFY FAILED: viewer should have inter_org_exchange.view = true';
  ASSERT (SELECT allowed FROM role_permission_defaults WHERE role = 'viewer' AND permission_key = 'inter_org_exchange.request') = false,
    'VERIFY FAILED: viewer should have inter_org_exchange.request = false';

  -- I. authenticated has no INSERT/UPDATE/DELETE grant on either table
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'inter_org_exchange_requests'
      AND grantee = 'authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE')
  ), 'VERIFY FAILED: authenticated must not have INSERT/UPDATE/DELETE on inter_org_exchange_requests';

  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'inter_org_exchange_events'
      AND grantee = 'authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE')
  ), 'VERIFY FAILED: authenticated must not have INSERT/UPDATE/DELETE on inter_org_exchange_events';

  -- J. authenticated has no SELECT grant on events (per the direct-SELECT decision)
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'inter_org_exchange_events'
      AND grantee = 'authenticated' AND privilege_type = 'SELECT'
  ), 'VERIFY FAILED: authenticated must not have direct SELECT on inter_org_exchange_events in this phase';

  -- K. authenticated DOES have SELECT on requests
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'inter_org_exchange_requests'
      AND grantee = 'authenticated' AND privilege_type = 'SELECT'
  ), 'VERIFY FAILED: authenticated should have SELECT on inter_org_exchange_requests';

  -- L. anon/PUBLIC have zero privileges on both tables
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name IN ('inter_org_exchange_requests','inter_org_exchange_events')
      AND grantee IN ('anon','PUBLIC')
  ), 'VERIFY FAILED: anon or PUBLIC has privileges on the new exchange tables';

  -- M. Exactly one SELECT policy on requests, none on events
  SELECT count(*) INTO v_requests_policy_count FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'inter_org_exchange_requests';
  ASSERT v_requests_policy_count = 1,
    format('VERIFY FAILED: expected exactly 1 policy on inter_org_exchange_requests, found %s', v_requests_policy_count);

  SELECT count(*) INTO v_events_policy_count FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'inter_org_exchange_events';
  ASSERT v_events_policy_count = 0,
    format('VERIFY FAILED: expected 0 policies on inter_org_exchange_events, found %s', v_events_policy_count);

  -- N. SELECT policy on requests checks inter_org_exchange.view + org scope
  SELECT qual INTO v_select_qual FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'inter_org_exchange_requests'
    AND policyname = 'inter_org_exchange_requests_select_perm';
  ASSERT v_select_qual IS NOT NULL, 'VERIFY FAILED: inter_org_exchange_requests_select_perm policy not found';
  ASSERT v_select_qual LIKE '%inter_org_exchange.view%',
    'VERIFY FAILED: inter_org_exchange_requests_select_perm does not check inter_org_exchange.view';
  ASSERT v_select_qual LIKE '%source_organization_id%' AND v_select_qual LIKE '%target_organization_id%',
    'VERIFY FAILED: inter_org_exchange_requests_select_perm does not scope by source/target org';

  -- O. Partial unique index preventing duplicate active exchange requests exists
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'inter_org_exchange_requests'
      AND indexname = 'inter_org_exchange_requests_active_alert_key_uq'
  ) INTO v_unique_idx_exists;
  ASSERT v_unique_idx_exists, 'VERIFY FAILED: inter_org_exchange_requests_active_alert_key_uq index not found';

  -- P. No exchange RPC created in this migration
  ASSERT NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_create_inter_org_exchange_request'),
    'VERIFY FAILED: phoenix_create_inter_org_exchange_request must not exist yet (this migration is schema-only)';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_update_inter_org_exchange_status'),
    'VERIFY FAILED: phoenix_update_inter_org_exchange_status must not exist yet (this migration is schema-only)';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_get_inter_org_exchange_events'),
    'VERIFY FAILED: phoenix_get_inter_org_exchange_events must not exist yet (this migration is schema-only)';
  ASSERT NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_get_inter_org_exchange_requests'),
    'VERIFY FAILED: phoenix_get_inter_org_exchange_requests must not exist yet (this migration is schema-only)';

  -- Q. Untouched: existing RPCs still present
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_get_live_inter_institution_alerts'),
    'VERIFY FAILED: phoenix_get_live_inter_institution_alerts is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_update_inter_org_alert_state'),
    'VERIFY FAILED: phoenix_update_inter_org_alert_state is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_apply_availability_movement'),
    'VERIFY FAILED: phoenix_apply_availability_movement is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'phoenix_upsert_availability'),
    'VERIFY FAILED: phoenix_upsert_availability is missing (must not be touched)';
  ASSERT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'get_public_qr_payload'),
    'VERIFY FAILED: get_public_qr_payload is missing (must not be touched)';

  RAISE NOTICE '040 OK: inter_org_exchange_requests + inter_org_exchange_events created with RLS/grants matching the item_availability_movements/inter_org_alert_states pattern, 10 new inter_org_exchange.* permission keys seeded (approve+manage dangerous), no exchange RPC created, no existing RPC modified.';
END $$;

COMMIT;

-- =============================================================================
-- END OF MIGRATION 040
--
-- Post-apply manual verification (run in Supabase SQL Editor):
--
-- 1. Confirm both tables and their policies:
--    SELECT tablename, policyname, cmd, roles FROM pg_policies
--    WHERE schemaname = 'public' AND tablename IN ('inter_org_exchange_requests','inter_org_exchange_events');
--    -- expect exactly 1 row: inter_org_exchange_requests | inter_org_exchange_requests_select_perm | SELECT | {authenticated}
--    -- expect 0 rows for inter_org_exchange_events
--
-- 2. Confirm the new permission keys and role defaults:
--    SELECT role, permission_key, allowed FROM role_permission_defaults
--    WHERE permission_key LIKE 'inter_org_exchange.%'
--    ORDER BY permission_key, role;
--
-- 3. Confirm the partial unique index:
--    SELECT indexname, indexdef FROM pg_indexes
--    WHERE schemaname = 'public' AND tablename = 'inter_org_exchange_requests'
--      AND indexname = 'inter_org_exchange_requests_active_alert_key_uq';
--
-- 4. Confirm no direct write is possible on either table (expect permission
--    denied, not success) and no direct SELECT is possible on
--    inter_org_exchange_events (a SECURITY DEFINER RPC is required to read
--    it, none exists yet).
--
-- 5. Confirm anon has zero privileges on both tables:
--    SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_schema = 'public'
--      AND table_name IN ('inter_org_exchange_requests','inter_org_exchange_events')
--      AND grantee = 'anon';
--    -- expect: 0 rows
--
-- NEXT PHASE (not part of this migration): INTER-INSTITUTION-EXCHANGE-RPCS-C
-- — create phoenix_create_inter_org_exchange_request,
-- phoenix_update_inter_org_exchange_status,
-- phoenix_get_inter_org_exchange_events,
-- phoenix_get_inter_org_exchange_requests per the audit's design, then a
-- service-wrapper phase and a UI phase.
-- =============================================================================
